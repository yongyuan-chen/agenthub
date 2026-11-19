import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { makeD1 } from './d1-shim.mjs';
import * as core from '../packages/worker/src/hub-core.mjs';
import { LocalDb } from '../packages/executor/src/db.mjs';
import { SessionManager } from '../packages/executor/src/manager.mjs';
import { forkSession, nativeSessionFile } from '../packages/executor/src/sessions.mjs';
import { truncateAtTurnBoundary } from '../packages/executor/src/fork.mjs';
import { CloudLink } from '../packages/executor/src/cloudlink.mjs';
import { FEATURE_MESSAGE_REWIND } from '../packages/shared/protocol.mjs';

function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-rewind-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const user = text => ({ type: 'user', message: { content: text } });
const assistant = text => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
function native(root, cwd, entries, id = 'source') {
  const dir = path.join(root, cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, entries.map(e => JSON.stringify({ cwd, ...e })).join('\n') + '\n');
  return file;
}

function executor(t, entries = [user('before'), assistant('keep'), user('old'), assistant('delete')], { realConfigDir = true } = {}) {
  const root = temp(t), cwd = path.join(root, 'cwd'), projects = path.join(root, 'projects');
  fs.mkdirSync(cwd);
  let file;
  if (realConfigDir) file = native(projects, cwd, entries);
  else {
    file = nativeSessionFile(root, cwd, 'source');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, entries.map(e => JSON.stringify({ cwd, ...e })).join('\n') + '\n');
  }
  const db = new LocalDb(root);
  db.upsertTask({ taskId: 'T', dir: cwd, repoUrl: cwd, sessionId: 'source', realConfigDir, status: 'running' });
  const sessions = [], events = [];
  const manager = new SessionManager({ workRoot: root, claudeProjectsRoot: projects, provider: { baseUrl: 'x', apiKey: 'y' } }, db,
    (taskId, seq, ev) => events.push({ taskId, seq, ev }), opts => {
      const session = { opts, alive: true, busy: false, caps: {}, sent: [],
        start() {}, send(text, images) { this.sent.push({ text, images }); }, kill() { this.alive = false; } };
      sessions.push(session); return session;
    });
  t.after(() => { manager.shutdown(); db.db.close(); });
  manager._spawn('T', null);
  let target;
  for (const entry of entries) {
    if (entry.type === 'user') target = manager.emit('T', { k: 'msg', role: 'user', content: { text: entry.message.content } });
    else manager.emit('T', { k: 'msg', role: 'assistant', content: { text: entry.message.content[0].text } });
  }
  const cmd = { t: 'edit_message', taskId: 'T', seq: target, sessionId: 'source', expectedText: 'old', text: 'new', images: [], clientMessageId: 'edit-1', senderUserId: 'owner' };
  return { root, cwd, projects, file, db, manager, sessions, events, cmd };
}

test('editing an ordinary task keeps its session in the isolated config dir', async t => {
  const x = executor(t, undefined, { realConfigDir: false });
  const result = await x.manager.editMessage(x.cmd);
  assert.equal(result.ok, true);
  const task = x.db.getTask('T');
  assert.ok(!task.real_config_dir, 'must not switch to ~/.claude and its credentials');
  assert.ok(fs.existsSync(nativeSessionFile(x.root, x.cwd, task.session_id)));
  assert.equal(fs.existsSync(x.projects), false, 'nothing written to ~/.claude');
  assert.equal(x.sessions.at(-1).opts.realConfigDir, false);
});

async function cloud() {
  const db = makeD1(new URL('../packages/worker/schema.sql', import.meta.url));
  const events = [], commands = [];
  const ctx = { db, userId: 'owner', now: () => 123, broadcast: m => events.push(m), push() {}, sendToNode: (id, cmd) => { commands.push(cmd); return true; } };
  await db.prepare('INSERT INTO nodes (id,owner_user_id,token_hash,created_at) VALUES (?,?,?,?)').bind('N', 'owner', 'token', 1).run();
  await db.prepare("INSERT INTO tasks (id,title,spec,node_id,owner_user_id,status,lease,session_id,created_at,updated_at) VALUES ('T','title','','N','owner','running','daemon','source',1,1)").bind().run();
  await db.prepare('INSERT INTO node_features VALUES (?,?,?)').bind('N', JSON.stringify([FEATURE_MESSAGE_REWIND]), 1).run();
  await core.absorbEvent(ctx, 'N', { taskId: 'T', seq: 1, ev: { k: 'msg', role: 'user', content: { text: 'before' } } });
  await core.absorbEvent(ctx, 'N', { taskId: 'T', seq: 2, ev: { k: 'msg', role: 'assistant', content: { text: 'keep' } } });
  await core.absorbEvent(ctx, 'N', { taskId: 'T', seq: 3, ev: { k: 'msg', role: 'user', content: { text: 'old' } } });
  await core.absorbEvent(ctx, 'N', { taskId: 'T', seq: 4, ev: { k: 'msg', role: 'assistant', content: { text: 'delete' } } });
  return { ctx, db, events, commands, api: (body, userId = 'owner') => core.api({ ...ctx, userId }, 'POST', '/api/tasks/T/edit-message', body) };
}

test('native rewind truncates at last user, validates text/images and supports first-turn fresh', t => {
  const root = temp(t), cwd = '/test';
  const file = native(root, cwd, [user('before'), assistant('keep'), user('old'), assistant('delete')]);
  const opts = { sourceFile: file, cwd, projectsRoot: root, newSessionId: 'prefix', dropTrailingTurns: 1, allowEmptyPrefix: true, expectedLastUserText: 'old', expectedLastUserImages: [] };
  const fork = forkSession(opts);
  const prefix = fs.readFileSync(fork.file, 'utf8');
  assert.match(prefix, /keep/); assert.doesNotMatch(prefix, /"content":"old"|"text":"delete"/);
  assert.throws(() => forkSession({ ...opts, newSessionId: 'drift', expectedLastUserText: 'other' }), /不一致/);
  assert.throws(() => forkSession({ ...opts, newSessionId: 'images', expectedLastUserImages: [{ data: 'x' }] }), /图片/);
  const first = native(root, cwd, [user('old')], 'first');
  const fresh = forkSession({ ...opts, sourceFile: first, newSessionId: 'fresh' });
  assert.equal(fresh.fresh, true); assert.equal(fresh.sessionId, null); assert.equal(fresh.file, null);
  assert.throws(() => truncateAtTurnBoundary([JSON.stringify(user('old'))], e => e.message?.content, 1), /太靠前/);
});

test('executor edit awaits process close, fences old callbacks, preserves monotonic replay and is idempotent', async t => {
  const e = executor(t), old = e.sessions[0];
  old.child = new EventEmitter(); old.child.exitCode = null; old.child.signalCode = null;
  old.kill = () => { old.alive = false; setTimeout(() => old.child.emit('close'), 25); };
  const before = e.db.lastSeq('T');
  const pending = e.manager.editMessage(e.cmd);
  old.opts.onMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'stale' }] } });
  old.opts.onExit(new Error('stale exit'));
  assert.equal(e.sessions.length, 1, 'replacement waits for close');
  const result = await pending;
  assert.ok(result.resetSeq > before);
  assert.equal(e.sessions.length, 2);
  assert.deepEqual(e.sessions[1].sent, [{ text: 'new', images: [] }]);
  assert.deepEqual(e.db.projectedMessages('T').map(m => m.content.text), ['before', 'keep', 'new']);
  const prefix = fs.readFileSync(fs.readdirSync(e.projects).flatMap(dir => fs.readdirSync(path.join(e.projects,dir)).map(file => path.join(e.projects,dir,file))).find(file => file.endsWith(`${result.sessionId}.jsonl`)), 'utf8');
  assert.doesNotMatch(prefix, /"content":"old"|"text":"delete"/);
  const seq = e.db.lastSeq('T');
  assert.deepEqual(await e.manager.editMessage(e.cmd), result);
  assert.equal(e.db.lastSeq('T'), seq); assert.equal(e.sessions.length, 2);
  await assert.rejects(e.manager.editMessage({ ...e.cmd, text: 'different' }), /另一条编辑/);
});

test('executor stale seq refuses before killing; native drift stops safely without deleting', async t => {
  const e = executor(t);
  await assert.rejects(e.manager.editMessage({ ...e.cmd, seq: 1 }), /最新/);
  assert.equal(e.sessions[0].alive, true);
  fs.appendFileSync(e.file, JSON.stringify(user('terminal drift')) + '\n');
  await assert.rejects(e.manager.editMessage(e.cmd), /不一致/);
  assert.equal(e.db.getTask('T').status, 'cancelled');
  assert.deepEqual(e.db.projectedMessages('T').map(m => m.content.text), ['before', 'keep', 'old', 'delete']);
  assert.equal(e.events.some(e => e.ev.k === 'messages_reset'), false);
});

test('cloud edit validates creator/latest/lease/capability/offline without deletion', async () => {
  const c = await cloud(), body = { seq: 3, text: 'new', images: [], clientMessageId: 'edit-1' };
  assert.equal((await c.api(body, 'other')).status, 404);
  assert.equal((await c.api({ ...body, seq: 1 })).status, 409);
  assert.equal((await c.api(body)).status, 503);
  assert.equal((await c.db.prepare('SELECT COUNT(*) AS n FROM messages').bind().first()).n, 4);
  await c.db.prepare("UPDATE tasks SET lease = 'human'").bind().run();
  assert.equal((await c.api(body)).status, 409);
  await c.db.prepare("UPDATE tasks SET lease = 'daemon'").bind().run();
  await c.db.prepare('DELETE FROM node_features').bind().run();
  assert.equal((await c.api(body)).status, 409);
});

test('cloud reset deletes suffix atomically and late old replay cannot resurrect it', async () => {
  const c = await cloud();
  const reset = { taskId: 'T', seq: 7, ev: { k: 'messages_reset', targetSeq: 3, sessionId: 'prefix', cwd: '/cwd', clientMessageId: 'edit-1', editPayload: { seq: 3, text: 'new', images: [] } } };
  await core.absorbEvent(c.ctx, 'N', reset);
  for (const seq of [3, 4, 5, 6]) await core.absorbEvent(c.ctx, 'N', { taskId: 'T', seq, ev: { k: 'msg', role: 'assistant', content: { text: 'stale replay' } } });
  await core.absorbEvent(c.ctx, 'N', { taskId: 'T', seq: 8, ev: { k: 'msg', role: 'user', content: { text: 'new' } } });
  await core.absorbEvent(c.ctx, 'N', reset);
  const rows = (await c.db.prepare('SELECT seq,content FROM messages ORDER BY seq').bind().all()).results;
  assert.deepEqual(rows.map(r => r.seq), [1, 2, 8]);
  assert.equal(c.events.filter(m => m.t === 'messages_reset').length, 1);
  assert.equal((await c.db.prepare('SELECT session_id FROM tasks').bind().first()).session_id, 'prefix');
  assert.equal((await c.db.prepare('SELECT session_id FROM conversation_claims_v2').bind().first()).session_id, 'prefix');
  assert.equal((await c.api({ seq: 3, text: 'new', images: [], clientMessageId: 'edit-1' })).status, 200);
  assert.equal((await c.api({ seq: 3, text: 'different', images: [], clientMessageId: 'edit-1' })).status, 409);
});

test('stop cancels pending delivery even before running status, but keeps queued messages for after the stop', async () => {
  const c = await cloud();
  await c.db.prepare("UPDATE tasks SET status='review'").bind().run();
  for (const [id, state] of [['send', 'pending'], ['later', 'queued']]) await c.db.prepare('INSERT INTO outbound_messages (task_id,client_message_id,node_id,sender_user_id,payload,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').bind('T', id, 'N', 'owner', JSON.stringify({ text: id, images: [] }), state, 1, 1).run();
  const stopped = await core.api(c.ctx, 'POST', '/api/tasks/T/cancel', {});
  assert.equal(stopped.status, 200);
  assert.deepEqual((await c.db.prepare('SELECT state FROM outbound_messages ORDER BY client_message_id DESC').bind().all()).results.map(r => r.state), ['cancelled', 'queued']);
  await c.db.prepare("UPDATE tasks SET status='running'").bind().run();
  const before = c.commands.length;
  await core.absorbEvent(c.ctx, 'N', { taskId: 'T', seq: 10, ev: { k: 'status', status: 'cancelled' } });
  assert.deepEqual(c.commands.slice(before).filter(c => c.t === 'user_message').map(c => c.text), ['later']);
});

test('CloudLink edit RPC awaits manager and returns correlated result/errors', async t => {
  const root = temp(t), db = new LocalDb(root); t.after(() => db.db.close());
  const sent = [];
  const link = new CloudLink({}, db, async cmd => { assert.equal(cmd.taskId, 'T'); return { ok: true, resetSeq: 42 }; });
  link._send = msg => sent.push(msg);
  await link._onCloudMessage({ t: 'edit_message', taskId: 'T', requestId: 'rpc-1' });
  assert.deepEqual(sent[0], { t: 'edit_message_result', requestId: 'rpc-1', ok: true, resetSeq: 42 });
  link.onCommand = async () => { throw new Error('drift'); };
  await link._onCloudMessage({ t: 'edit_message', taskId: 'T', requestId: 'rpc-2' });
  assert.equal(sent[1].error, 'drift'); assert.equal(sent[1].ok, false);
});

test('same-task API -> executor native rewind -> ordered cloud reset and replacement integration', async t => {
  const c = await cloud(), e = executor(t);
  let pump = Promise.resolve();
  e.manager.onEvent = (taskId, seq, ev) => {
    pump = pump.then(() => core.absorbEvent(c.ctx, 'N', { taskId, seq, ev }));
  };
  // Cloud reset sequence must follow the node's real outbox sequence.
  c.ctx.editMessage = async (_nodeId, cmd) => {
    const result = await e.manager.handleCommand({ t: 'edit_message', ...cmd });
    await pump;
    return result;
  };
  const result = await core.api(c.ctx, 'POST', '/api/tasks/T/edit-message', {
    seq: 3, text: 'replacement', images: [], clientMessageId: 'edit-integrated',
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const history = await core.api(c.ctx, 'GET', '/api/tasks/T/messages', { before_seq: 0 });
  assert.deepEqual(history.body.messages.map(m => m.content.text), ['before', 'keep', 'replacement']);
  assert.equal(history.body.resetSeq, result.body.resetSeq);
  assert.equal(e.sessions[1].sent[0].text, 'replacement');
  assert.notEqual((await core.getTask(c.ctx, 'T')).session_id, 'source');
  const retry = await core.api(c.ctx, 'POST', '/api/tasks/T/edit-message', {
    seq: 3, text: 'replacement', images: [], clientMessageId: 'edit-integrated',
  });
  assert.equal(retry.status, 200); assert.equal(e.sessions.length, 2);
});

test('first-turn executor edit uses fresh context and cloud later claims actual native ID', async t => {
  const e = executor(t, [user('old'), assistant('delete')]);
  const result = await e.manager.editMessage(e.cmd);
  assert.equal(result.sessionId, null);
  assert.equal(e.sessions[1].opts.resumeSessionId, null);
  assert.deepEqual(e.db.projectedMessages('T').map(m => m.content.text), ['new']);
  const c = await cloud();
  await core.absorbEvent(c.ctx, 'N', { taskId: 'T', seq: 7, ev: { k: 'messages_reset', targetSeq: 1, sessionId: null, cwd: '/cwd', clientMessageId: 'first', editPayload: {} } });
  assert.equal((await c.db.prepare('SELECT COUNT(*) AS n FROM conversation_claims_v2').bind().first()).n, 0);
  await core.absorbEvent(c.ctx, 'N', { taskId: 'T', seq: 8, ev: { k: 'session', sessionId: 'fresh-native-id' } });
  assert.equal((await c.db.prepare('SELECT session_id FROM conversation_claims_v2').bind().first()).session_id, 'fresh-native-id');
});

// A send stopped before the CLI persisted it exists on the board but not in
// the transcript (found live: stop ~2s after send, every edit then refused).
const at = (entry, ts) => ({ ...entry, timestamp: new Date(ts).toISOString() });

test('native rewind aligns a board message the transcript never received', t => {
  const root = temp(t), cwd = '/test', sent = Date.parse('2026-11-07T03:34:09Z');
  const file = native(root, cwd, [at(user('before'), sent - 9e5), assistant('keep'), at(user('old'), sent - 6e5), assistant('reply')]);
  const opts = { sourceFile: file, cwd, projectsRoot: root, dropTrailingTurns: 1, allowEmptyPrefix: true,
    expectedLastUserText: 'unsent', expectedLastUserImages: [], expectedLastUserTs: sent, previousUserText: 'old', previousUserImages: [] };
  const fork = forkSession({ ...opts, newSessionId: 'unsent' });
  assert.equal(fork.keptTurns, 2, 'nothing native dropped for the unsent message');
  assert.match(fs.readFileSync(fork.file, 'utf8'), /"text":"reply"/);
  assert.throws(() => forkSession({ ...opts, newSessionId: 'prev-drift', previousUserText: 'something else' }), /不一致/);
  assert.throws(() => forkSession({ ...opts, newSessionId: 'no-prev', previousUserText: undefined }), /不一致/);
  assert.throws(() => forkSession({ ...opts, newSessionId: 'prev-images', previousUserImages: [{ data: 'x' }] }), /图片/);
  // Same text sent twice, second one unsent: text alone would have dropped
  // the real earlier turn; the timestamp keeps it.
  const twice = forkSession({ ...opts, newSessionId: 'twice', expectedLastUserText: 'old' });
  assert.equal(twice.keptTurns, 2);
  // Persisted normally (native turn written after the send): unchanged.
  const persisted = native(root, cwd, [at(user('before'), sent - 9e5), assistant('keep'), at(user('unsent'), sent + 50), assistant('delete')], 'persisted');
  const normal = forkSession({ ...opts, sourceFile: persisted, newSessionId: 'normal' });
  assert.equal(normal.keptTurns, 1);
  assert.doesNotMatch(fs.readFileSync(normal.file, 'utf8'), /"text":"delete"/);
});

test('executor edit of a message stopped before it reached the transcript replaces it', async t => {
  const past = Date.now() - 60_000;
  const e = executor(t, [at(user('before'), past), assistant('keep'), at(user('old'), past + 1000), assistant('reply')]);
  const seq = e.manager.emit('T', { k: 'msg', role: 'user', content: { text: 'unsent' } });
  e.manager.setStatus('T', 'cancelled', { clearPending: true });
  const result = await e.manager.editMessage({ ...e.cmd, seq, expectedText: 'unsent' });
  assert.equal(result.ok, true);
  assert.deepEqual(e.db.projectedMessages('T').map(m => m.content.text), ['before', 'keep', 'old', 'reply', 'new']);
  assert.deepEqual(e.sessions.at(-1).sent, [{ text: 'new', images: [] }]);
  assert.equal(e.sessions.at(-1).opts.resumeSessionId, result.sessionId);
});
