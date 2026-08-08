// Unit tests: state machine, ulid, web push crypto round-trip.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ulid, userCanTransition, sha256Hex } from '../packages/shared/protocol.mjs';
import { sendWebPush } from '../packages/worker/src/push.mjs';

test('ulid: sortable, 26 chars, unique', () => {
  const a = ulid(1000);
  const b = ulid(2000);
  assert.equal(a.length, 26);
  assert.ok(b.slice(0, 10) > a.slice(0, 10));
  assert.notEqual(ulid(), ulid());
});

test('state machine: user transitions', () => {
  assert.ok(userCanTransition('review', 'done'));
  assert.ok(userCanTransition('running', 'cancelled'));
  assert.ok(!userCanTransition('done', 'cancelled'));
  assert.ok(!userCanTransition('queued', 'done'));
});

test('sha256Hex', async () => {
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('web push: aes128gcm payload decrypts on the UA side (RFC 8291)', async () => {
  // Simulate a browser subscription: UA ECDH keypair + auth secret.
  const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const uaPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey));
  const authSecret = crypto.getRandomValues(new Uint8Array(16));
  const b64u = (u8) => Buffer.from(u8).toString('base64url');

  const vapidKeys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const vapid = {
    publicKey: b64u(new Uint8Array(await crypto.subtle.exportKey('raw', vapidKeys.publicKey))),
    privateJwk: await crypto.subtle.exportKey('jwk', vapidKeys.privateKey),
    subject: 'mailto:test@example.com',
  };

  let captured = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    captured = { url, init };
    return new Response(null, { status: 201 });
  };
  try {
    const status = await sendWebPush(
      { endpoint: 'https://push.example.com/send/abc', keys: { p256dh: b64u(uaPubRaw), auth: b64u(authSecret) } },
      { title: 'hi', body: '世界' },
      vapid,
    );
    assert.equal(status, 201);
  } finally {
    globalThis.fetch = origFetch;
  }

  assert.match(captured.init.headers.authorization, /^vapid t=.+, k=.+$/);
  assert.equal(captured.init.headers['content-encoding'], 'aes128gcm');

  // UA-side decrypt
  const body = new Uint8Array(captured.init.body);
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPub = body.slice(21, 21 + idlen);
  const ciphertext = body.slice(21 + idlen);

  const asKey = await crypto.subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, ua.privateKey, 256));
  const te = new TextEncoder();
  const hkdf = async (s, ikm, info, len) => {
    const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: s, info }, k, len * 8));
  };
  const keyInfo = new Uint8Array([...te.encode('WebPush: info\0'), ...uaPubRaw, ...asPub]);
  const ikm = await hkdf(authSecret, shared, keyInfo, 32);
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, aes, ciphertext));
  assert.equal(plain.at(-1), 2);
  const payload = JSON.parse(new TextDecoder().decode(plain.slice(0, -1)));
  assert.deepEqual(payload, { title: 'hi', body: '世界' });
});
