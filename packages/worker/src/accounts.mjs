// Register/login/logout/session-resolution, decoupled from Durable Object
// infrastructure so it runs against the same node:sqlite D1 shim the rest of
// the hub-core tests use. Mirrors hub-core.mjs's {status, body} convention.
import { hashPassword, verifyPassword, newToken, hashToken } from './auth.mjs';
import { ulid } from '../../shared/protocol.mjs';

const q = (db, sql, ...params) => db.prepare(sql).bind(...params);

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

async function createSession(db, userId, now) {
  const token = newToken();
  await q(db, 'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    await hashToken(token), userId, now, now + SESSION_TTL_MS).run();
  return token;
}

export async function createUser(db, { username, password, isAdmin }, now) {
  const id = ulid(now);
  await q(db,
    'INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)',
    id, username, await hashPassword(password), isAdmin ? 1 : 0, now).run();
  return { id, username, isAdmin: !!isAdmin };
}

export async function registrationStatus(db) {
  const row = await q(db, "SELECT value FROM app_settings WHERE key = 'registration_open'").first();
  const countRow = await q(db, 'SELECT COUNT(*) AS n FROM users').first();
  return { open: row?.value !== '0', hasUsers: (countRow?.n ?? 0) > 0 };
}

export async function register(db, { username, password }, now) {
  username = String(username || '').trim();
  password = String(password || '');
  if (username.length < 2 || username.length > 64) return err(400, 'username must be 2-64 chars');
  if (password.length < 8) return err(400, 'password must be at least 8 chars');

  const countRow = await q(db, 'SELECT COUNT(*) AS n FROM users').first();
  const hasUsers = (countRow?.n ?? 0) > 0;
  if (hasUsers) {
    const settingRow = await q(db, "SELECT value FROM app_settings WHERE key = 'registration_open'").first();
    if (settingRow?.value === '0') return err(403, 'registration is closed, contact an admin');
  }

  const existing = await q(db, 'SELECT id FROM users WHERE username = ?', username).first();
  if (existing) return err(409, 'username already taken');

  const user = await createUser(db, { username, password, isAdmin: !hasUsers }, now);
  const token = await createSession(db, user.id, now);
  return ok({ token, user });
}

export async function login(db, { username, password }, now) {
  username = String(username || '').trim();
  password = String(password || '');
  const row = await q(db, 'SELECT id, username, password_hash, is_admin, disabled FROM users WHERE username = ?', username).first();
  if (!row || !(await verifyPassword(password, row.password_hash))) {
    return err(401, 'invalid username or password');
  }
  if (row.disabled) return err(403, 'account disabled');
  const token = await createSession(db, row.id, now);
  return ok({ token, user: { id: row.id, username: row.username, isAdmin: !!row.is_admin } });
}

export async function logout(db, token) {
  if (token) await q(db, 'DELETE FROM sessions WHERE token_hash = ?', await hashToken(token)).run();
  return ok({});
}

// Joins users so a disabling an account cuts off its already-issued sessions
// immediately, not just future logins — otherwise "disable" would be a no-op
// for up to SESSION_TTL_MS against anyone already logged in, which defeats
// the point of an admin using it to cut off access right now.
export async function resolveSession(db, token, now = Date.now()) {
  if (!token) return null;
  const row = await q(db,
    `SELECT sessions.user_id, sessions.expires_at, users.disabled FROM sessions
     JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ?`, await hashToken(token)).first();
  if (!row || (row.expires_at ?? 0) < now || row.disabled) return null;
  return row.user_id;
}

export async function getUser(db, userId) {
  const row = await q(db, 'SELECT id, username, is_admin FROM users WHERE id = ?', userId).first();
  return row ? { id: row.id, username: row.username, isAdmin: !!row.is_admin } : null;
}

const ok = (body) => ({ status: 200, body: { ok: true, ...body } });
const err = (status, message) => ({ status, body: { ok: false, error: message } });
