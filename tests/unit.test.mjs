// Unit tests: state machine, ulid, web push crypto round-trip.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ulid, userCanTransition, sha256Hex } from '../packages/shared/protocol.mjs';
import { sendWebPush } from '../packages/worker/src/push.mjs';
import { listDirs } from '../packages/executor/src/cloudlink.mjs';
import { buildClaudeArgs } from '../packages/executor/src/session.mjs';
import { fmtDuration } from '../packages/web/src/format.js';
import { elapsedOf, RUNNING_STATUSES } from '../packages/web/src/elapsed.js';

test('Claude CLI arguments never impose AgentHub turn or cost limits', () => {
  const base = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'bypassPermissions',
    '--permission-prompt-tool', 'stdio',
  ];
  assert.deepEqual(buildClaudeArgs({ permissionMode: 'bypassPermissions' }), base);
  assert.deepEqual(
    buildClaudeArgs({ permissionMode: 'bypassPermissions', resumeSessionId: 'session-123' }),
    [...base, '--resume', 'session-123'],
  );
  for (const args of [buildClaudeArgs(), buildClaudeArgs({ resumeSessionId: 'session-123' })]) {
    assert.ok(!args.includes('--max-turns'));
    assert.ok(!args.includes('--max-budget-usd'));
    assert.ok(!args.includes('100'));
  }
});

test('listDirs: prefix-completes into matching subdirectories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-listdirs-'));
  fs.mkdirSync(path.join(root, 'home'));
  fs.mkdirSync(path.join(root, 'hostgroup'));
  fs.mkdirSync(path.join(root, 'var'));
  fs.mkdirSync(path.join(root, '.hidden'));
  fs.writeFileSync(path.join(root, 'home-file.txt'), ''); // not a directory

  assert.deepEqual(listDirs(path.join(root, 'ho')), [path.join(root, 'home'), path.join(root, 'hostgroup')]);
  assert.deepEqual(listDirs(path.join(root, 'nope-xyz')), []);
  assert.deepEqual(listDirs('/definitely/does/not/exist/anywhere'), []);

  // an exact, already-complete directory lists its own children rather than
  // being treated as a partial prefix of its parent's siblings
  fs.mkdirSync(path.join(root, 'home', 'inner'));
  assert.deepEqual(listDirs(path.join(root, 'home')), [path.join(root, 'home', 'inner')]);
});

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

test('fmtDuration rolls seconds up at 60, then minutes up at 60', () => {
  assert.equal(fmtDuration(0), '0s');
  assert.equal(fmtDuration(1499), '1s');
  assert.equal(fmtDuration(59_000), '59s');
  assert.equal(fmtDuration(59_600), '1m00s', 'rounding to 60s must carry into a minute, not print "60s"');
  assert.equal(fmtDuration(60_000), '1m00s');
  assert.equal(fmtDuration(94_000), '1m34s');
  assert.equal(fmtDuration(743_000), '12m23s');
  assert.equal(fmtDuration(3_599_000), '59m59s');
  assert.equal(fmtDuration(3_600_000), '1h00m');
  assert.equal(fmtDuration(7_530_000), '2h05m', 'minutes stay zero-padded so widths line up');
  assert.equal(fmtDuration(undefined), '0s', 'a result card with no duration must not render NaN');
  assert.equal(fmtDuration(-5_000), '0s');
});

test('elapsedOf only counts a turn that is actually running and has a start stamp', () => {
  const now = 1_000_000;
  assert.equal(elapsedOf({ status: 'running', run_started_at: now - 94_000 }, now), 94_000);
  assert.equal(elapsedOf({ status: 'starting', run_started_at: now - 1_000 }, now), 1_000);
  // Finished: the row goes back to showing how long ago it last changed.
  assert.equal(elapsedOf({ status: 'review', run_started_at: now - 94_000 }, now), null);
  // Running, but started before run_started_at existed — nothing to count
  // from, and falling back to updated_at is exactly the flicker this fixes.
  assert.equal(elapsedOf({ status: 'running', run_started_at: null }, now), null);
  // Clock skew between the node's stamp and this browser must not print a
  // negative duration.
  assert.equal(elapsedOf({ status: 'running', run_started_at: now + 5_000 }, now), 0);
  assert.equal(elapsedOf(null, now), null);
  assert.deepEqual([...RUNNING_STATUSES].sort(), ['running', 'starting']);
});
