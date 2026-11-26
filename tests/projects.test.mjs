import test from 'node:test';
import assert from 'node:assert/strict';
import { makeD1 } from './d1-shim.mjs';
import * as core from '../packages/worker/src/hub-core.mjs';

const SCHEMA = new URL('../packages/worker/schema.sql', import.meta.url);

function ctxFor(db, userId) {
  return { db, userId, teamId: null, now: () => Date.now(), broadcast() {}, sendToNode: () => false, push() {} };
}

// Found live: two "ba" projects 7s apart — the first gave no visible sign of
// having been created, so it was created again.
test('projects: a second project with the same name (any case) is refused, per user', async () => {
  const db = makeD1(SCHEMA);
  for (const [id, name] of [['u1', 'alice'], ['u2', 'bob']]) {
    await db.prepare('INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (?, ?, ?, 0, ?)').bind(id, name, 'x', Date.now()).run();
  }
  const alice = ctxFor(db, 'u1');
  const first = await core.api(alice, 'POST', '/api/teams', { name: 'ba' });
  assert.equal(first.status, 200);
  const again = await core.api(alice, 'POST', '/api/teams', { name: ' BA ' });
  assert.equal(again.status, 409);
  assert.match(again.body.error, /已经有一个叫/);
  // Someone else's project of that name is none of alice's business.
  assert.equal((await core.api(ctxFor(db, 'u2'), 'POST', '/api/teams', { name: 'ba' })).status, 200);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM teams WHERE lower(name) = 'ba'").bind().first()).n, 2);
});
