// Web Push (RFC 8291 aes128gcm + RFC 8292 VAPID) on WebCrypto — no dependencies.

const te = new TextEncoder();

function b64url(buf) {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

async function vapidJwt(audience, subject, privateJwk) {
  const header = b64url(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64url(te.encode(JSON.stringify({
    aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject,
  })));
  const signingInput = `${header}.${payload}`;
  const key = await crypto.subtle.importKey('jwk', privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(signingInput));
  return `${signingInput}.${b64url(sig)}`;
}

/**
 * @param {{endpoint:string, keys:{p256dh:string, auth:string}}} subscription
 * @param {object} payload  JSON-serializable
 * @param {{publicKey:string, privateJwk:object, subject:string}} vapid
 * @returns {Promise<number>} HTTP status from the push service
 */
export async function sendWebPush(subscription, payload, vapid) {
  const uaPublic = b64urlDecode(subscription.keys.p256dh);   // 65-byte uncompressed point
  const authSecret = b64urlDecode(subscription.keys.auth);   // 16 bytes

  // Ephemeral ECDH keypair (the "application server" key for this message)
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, eph.privateKey, 256));
  const ephPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));

  // RFC 8291 key derivation
  const keyInfo = concat(te.encode('WebPush: info\0'), uaPublic, ephPubRaw);
  const ikm = await hkdf(authSecret, shared, keyInfo, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);

  const plaintext = concat(te.encode(JSON.stringify(payload)), new Uint8Array([2])); // 0x02 = last record pad delimiter
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, plaintext));

  // aes128gcm content-coding header: salt(16) | rs(4) | idlen(1) | keyid(65)
  const header = concat(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([ephPubRaw.length]), ephPubRaw);
  const body = concat(header, ciphertext);

  const endpoint = new URL(subscription.endpoint);
  const jwt = await vapidJwt(endpoint.origin, vapid.subject, vapid.privateJwk);

  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      'ttl': '86400',
      'urgency': 'high',
      'authorization': `vapid t=${jwt}, k=${vapid.publicKey}`,
    },
    body,
  });
  return res.status;
}

export async function pushAll(db, payloadObj, vapid) {
  if (!vapid?.privateJwk) return;
  const rows = await db.prepare('SELECT id, subscription FROM push_subscriptions').bind().all();
  for (const row of rows.results ?? rows) {
    try {
      const sub = JSON.parse(row.subscription);
      const status = await sendWebPush(sub, payloadObj, vapid);
      if (status === 404 || status === 410) {
        await db.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(row.id).run();
      }
    } catch (e) {
      console.warn('push failed:', e.message);
    }
  }
}
