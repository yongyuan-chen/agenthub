// Installer half of the "run one command, click Connect" enrollment flow
// (Tailscale-style). Both routes are unauthenticated — the machine running
// install.sh holds no account credential at all:
//
//   POST /api/node-auth/start   the installer registers a pending request
//                               (only the HASH of a node token it generated
//                               locally) and gets back a short code + link
//   GET  /api/node-auth/<code>  the installer polls this until someone
//                               approves; the /connect page reads it too
//
// Approval is the authenticated half and lives in hub-core.mjs (it creates
// the node and has to broadcast it). Nothing returned here is secret: the
// node token never leaves the machine, so knowing a code only lets you see a
// hostname and ask someone logged in to click 连接 — the same trust model as
// a Tailscale login link.
const q = (db, sql, ...params) => db.prepare(sql).bind(...params);

const REQUEST_TTL_MS = 15 * 60 * 1000;
// No 0/O/1/I/L/U — the code may get read off one screen and typed into another.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const chars = [...bytes].map(b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

export function normalizeAuthCode(raw) {
  const s = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}

const clip = (v, n) => String(v ?? '').slice(0, n);
const NODE_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export async function start(db, body, origin, now) {
  const { id, existingId, tokenHash, labels, hostname, user } = body || {};
  if (!NODE_ID_RE.test(String(id || ''))) return err(400, 'id must be a lowercase slug');
  if (!/^[0-9a-f]{64}$/.test(String(tokenHash || ''))) return err(400, 'tokenHash must be a sha256 hex digest');
  const cleanLabels = (Array.isArray(labels) ? labels : []).slice(0, 8).map(l => clip(l, 32));
  // Opportunistic cleanup keeps the table from growing without a cron.
  await q(db, 'DELETE FROM node_auth_requests WHERE expires_at < ?', now - REQUEST_TTL_MS).run();
  const code = newCode();
  await q(db,
    `INSERT INTO node_auth_requests (code, token_hash, suggested_id, existing_id, labels, hostname, os_user, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    code, tokenHash, id, NODE_ID_RE.test(String(existingId || '')) ? existingId : null,
    JSON.stringify(cleanLabels), clip(hostname, 100), clip(user, 100), now, now + REQUEST_TTL_MS).run();
  return ok({ code, url: `${origin}/connect/${code}`, expiresAt: now + REQUEST_TTL_MS });
}

export async function status(db, rawCode, now) {
  const row = await q(db, 'SELECT * FROM node_auth_requests WHERE code = ?', normalizeAuthCode(rawCode)).first();
  if (!row) return err(404, 'connect request not found');
  let labels = [];
  try { labels = JSON.parse(row.labels || '[]'); } catch { /* keep [] */ }
  // approved_at is set the instant someone clicks, node_id a moment later
  // once the node row exists — the installer must wait for node_id.
  const state = row.node_id ? 'approved' : row.approved_at ? 'approving' : row.expires_at <= now ? 'expired' : 'pending';
  return ok({
    code: row.code, status: state, nodeId: row.node_id || null,
    hostname: row.hostname, user: row.os_user, labels,
    suggestedId: row.suggested_id, existingId: row.existing_id, expiresAt: row.expires_at,
  });
}

const ok = (body) => ({ status: 200, body: { ok: true, ...body } });
const err = (status, message) => ({ status, body: { ok: false, error: message } });
