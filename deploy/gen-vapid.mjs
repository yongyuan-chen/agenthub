// Generate a VAPID keypair. Prints JSON: { publicKey, privateJwk }.
const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const pubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
const publicKey = Buffer.from(pubRaw).toString('base64url');
console.log(JSON.stringify({ publicKey, privateJwk }));
