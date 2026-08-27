// Unit tests for accounts.mjs (register/login/logout/session-resolve) and the
// auth.mjs primitives it builds on, using the same node:sqlite D1 shim the
// hub-core integration tests use — no fake WS/DO needed, these are plain
// db-backed functions.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeD1 } from './d1-shim.mjs';
import * as accounts from '../packages/worker/src/accounts.mjs';
import { hashPassword, verifyPassword, newToken, hashToken } from '../packages/worker/src/auth.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = path.join(here, '../packages/worker/schema.sql');

test('auth.mjs: password hash round-trip', async () => {
  const stored = await hashPassword('correct horse battery staple');
  assert.ok(await verifyPassword('correct horse battery staple', stored));
  assert.ok(!(await verifyPassword('wrong password', stored)));
});

test('auth.mjs: newToken/hashToken', async () => {
  const a = newToken();
  const b = newToken();
  assert.equal(a.length, 64);
  assert.notEqual(a, b);
  assert.equal((await hashToken(a)).length, 64);
  assert.notEqual(await hashToken(a), await hashToken(b));
});

test('accounts: register -> login -> resolveSession -> logout', async () => {
  const db = makeD1(SCHEMA);
  const now = Date.now();

  const reg = await accounts.register(db, { username: 'alice', password: 'hunter22222' }, now);
  assert.equal(reg.status, 200);
  assert.ok(reg.body.token);
  assert.equal(reg.body.user.isAdmin, true, 'first user bootstraps as admin');

  const uid = await accounts.resolveSession(db, reg.body.token, now);
  assert.equal(uid, reg.body.user.id);

  const login = await accounts.login(db, { username: 'alice', password: 'hunter22222' }, now);
  assert.equal(login.status, 200);
  assert.equal(login.body.user.id, reg.body.user.id);

  const badLogin = await accounts.login(db, { username: 'alice', password: 'nope' }, now);
  assert.equal(badLogin.status, 401);

  await accounts.logout(db, reg.body.token);
  assert.equal(await accounts.resolveSession(db, reg.body.token, now), null);
});

test('accounts: second user is not admin; duplicate username rejected', async () => {
  const db = makeD1(SCHEMA);
  const now = Date.now();
  const r1 = await accounts.register(db, { username: 'alice', password: 'hunter22222' }, now);
  assert.equal(r1.body.user.isAdmin, true);

  const r2 = await accounts.register(db, { username: 'bob', password: 'hunter22222' }, now);
  assert.equal(r2.status, 200);
  assert.equal(r2.body.user.isAdmin, false);

  const dup = await accounts.register(db, { username: 'bob', password: 'somethingelse' }, now);
  assert.equal(dup.status, 409);
});

test('accounts: registration_open=0 blocks new signups but not the first user', async () => {
  const db = makeD1(SCHEMA);
  const now = Date.now();
  await db.prepare("INSERT INTO app_settings (key, value) VALUES ('registration_open', '0')").bind().run();

  const status = await accounts.registrationStatus(db);
  assert.equal(status.open, false);
  assert.equal(status.hasUsers, false);

  // still empty DB: first registration must succeed regardless of the flag
  const first = await accounts.register(db, { username: 'admin', password: 'hunter22222' }, now);
  assert.equal(first.status, 200);
  assert.equal(first.body.user.isAdmin, true);

  const second = await accounts.register(db, { username: 'eve', password: 'hunter22222' }, now);
  assert.equal(second.status, 403);

  const statusAfter = await accounts.registrationStatus(db);
  assert.equal(statusAfter.hasUsers, true);
});

test('accounts: session expiry is honored', async () => {
  const db = makeD1(SCHEMA);
  const now = Date.now();
  const reg = await accounts.register(db, { username: 'alice', password: 'hunter22222' }, now);
  assert.equal(await accounts.resolveSession(db, reg.body.token, now + 1000), reg.body.user.id);
  // 31 days later: session must have expired (30d TTL)
  assert.equal(await accounts.resolveSession(db, reg.body.token, now + 31 * 24 * 60 * 60 * 1000), null);
});
