// In-process integration: real executor modules (LocalDb, SessionManager,
// CloudLink) wired to real hub-core over fake WebSockets, D1 simulated with
// node:sqlite. Covers M1 flow, M2 reconciliation/idempotency, node offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeD1 } from './d1-shim.mjs';
import * as core from '../packages/worker/src/hub-core.mjs';
import { LocalDb } from '../packages/executor/src/db.mjs';
import { SessionManager } from '../packages/executor/src/manager.mjs';
import { CloudLink } from '../packages/executor/src/cloudlink.mjs';
import { sha256Hex, MAX_IMAGES_PER_MESSAGE, MAX_ATTACHMENT_TOTAL_RAW_BYTES, PROTOCOL_VERSION, OUTBOUND_MESSAGE_TTL_MS } from '../packages/shared/protocol.mjs';
import * as accounts from '../packages/worker/src/accounts.mjs';
import { nativeSessionFile } from '../packages/executor/src/sessions.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = path.join(here, '../packages/worker/schema.sql');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, timeout = 5000, label = 'condition') {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await fn()) return;
    await sleep(20);
  }
  throw new Error(`timeout waiting for ${label}`);
}

// ---- fake cloud: hub-core + per-node fake socket registry ----
function makeCloud() {
  const db = makeD1(SCHEMA);
  const nodeSockets = new Map();  // nodeId -> fake ws (executor side handle)
  const broadcasts = [];
  const pushes = [];
  let fakeNow = null;
  const ctx = {
    db,
    userId: 'user-test',
    now: () => fakeNow ?? Date.now(),
    broadcast: (m) => broadcasts.push(m),
    sendToNode: (nodeId, msg) => {
      const sock = nodeSockets.get(nodeId);
      if (!sock || sock.readyState !== 1) return false;
      queueMicrotask(() => sock.onmessage?.({ data: JSON.stringify(msg) }));
      return true;
    },
    push: (p) => pushes.push(p),
    listProjectSessions: async () => ({ sessions: [] }),
    readProjectSession: async () => ({ events: [] }),
  };
  // Serialized message pump, like a DO
  let chain = Promise.resolve();
  const fromNode = (nodeId, raw) => {
    chain = chain.then(async () => {
      const msg = JSON.parse(raw);
      if (msg.t === 'hello') await core.handleHello(ctx, nodeId, msg);
      else if (msg.t === 'hb') await core.handleHeartbeat(ctx, nodeId);
      else if (msg.t === 'ev') await core.absorbEvent(ctx, nodeId, msg);
      else if (msg.t === 'durable_cmd_ack') await core.ackDurableCommand(ctx, nodeId, msg.commandKey);
    }).catch(e => { throw e; });
    return chain;
  };
  return {
    ctx, db, broadcasts, pushes,
    setNow: (t) => { fakeNow = t; },
    api: (method, pathName, body) => core.api(ctx, method, pathName, body),
    makeSocketFactory(nodeId) {
      return () => {
        const ws = {
          readyState: 0,
          send: (data) => { fromNode(nodeId, data); },
          close: () => {
            if (ws.readyState === 3) return;
            ws.readyState = 3;
            nodeSockets.delete(nodeId);
            core.markNodeOffline(ctx, nodeId);
            ws.onclose?.();
          },
        };
        setTimeout(() => {
          ws.readyState = 1;
          nodeSockets.set(nodeId, ws);
          ws.onopen?.();
        }, 5);
        return ws;
      };
    },
    dropNode(nodeId) {
      const sock = nodeSockets.get(nodeId);
      if (sock) sock.close();
    },
    flush: () => chain,
  };
}

// ---- fake claude session: scripted per-test ----
// `customize` lets a test reshape the session the way a different backend
// would — codex reports no dollar cost and does know its own context window,
// and compacts over an RPC instead of by sending "/compact" as text.
function makeFakeSessionFactory(script, customize) {
  return (opts) => {
    const session = {
      alive: true, busy: false, sessionId: opts.resumeSessionId ?? null, lastActivity: Date.now(),
      // Mirrors ClaudeSession: reports dollar cost, no self-declared context
      // window (the manager falls back to its own constant).
      caps: { reportsCost: true, contextWindow: null },
      start() {
        if (!session.sessionId) session.sessionId = 'sess-' + Math.random().toString(36).slice(2, 8);
        queueMicrotask(() => opts.onMessage({ type: 'system', subtype: 'init', session_id: session.sessionId }));
      },
      send(text, images) { session.busy = true; script(session, opts, text, images); },
      // Claude has no compaction RPC — the literal text is the mechanism, which
      // is why these tests assert on '/compact' showing up in sentTexts.
      compact() { session.send('/compact'); },
      interrupt() {},
      kill() { session.alive = false; },
      recentStderr() { return ''; },
    };
    customize?.(session, opts);
    return session;
  };
}

function makeExecutor(cloud, nodeId, script, configOverrides = {}, customizeSession = undefined) {
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-test-'));
  fs.mkdirSync(path.join(workRoot, 'scratch'), { recursive: true });
  const config = {
    cloudUrl: 'wss://fake', nodeId, nodeToken: 'tok-' + nodeId,
    provider: { baseUrl: 'x', apiKey: 'y' },
    maxParallel: 3,
    decisionTimeoutMs: 60_000, idleSessionTimeoutMs: 60_000, workRoot,
    ...configOverrides,
  };
  const db = new LocalDb(workRoot);
  const link = new CloudLink(config, db, (cmd) => manager.handleCommand(cmd), cloud.makeSocketFactory(nodeId));
  const manager = new SessionManager(config, db, (t, s, e) => link.notifyEvent(t, s, e), makeFakeSessionFactory(script, customizeSession));
  return { config, db, link, manager, workRoot };
}

test('M1: full task flow (start -> perm -> review -> reply -> done)', async () => {
  const cloud = makeCloud();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac1', await sha256Hex('tok-mac1'), 'user-test', Date.now()).run();

  // Scripted agent: turn 1 asks permission, writes a file, finishes; turn 2 just replies.
  let turn = 0;
  const exec = makeExecutor(cloud, 'mac1', async (session, opts, text) => {
    turn++;
    await sleep(10);
    if (turn === 1) {
      opts.onMessage({ type: 'assistant', message: { content: [{ type: 'text', text: '我来处理:' + text.slice(0, 20) }] } });
      opts.onMessage({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'touch out.txt' } }] } });
      const decision = await opts.onPermission({ requestId: 'req1', toolName: 'Bash', input: { command: 'touch out.txt' } });
      assert.equal(decision.behavior, 'allow');
      const t = exec.db.getTask([...exec.db.allTasks()][0].task_id);
      fs.writeFileSync(path.join(t.dir, 'out.txt'), 'hello\n');
      opts.onMessage({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok', is_error: false }] } });
      opts.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0.05, duration_ms: 1000, num_turns: 2, is_error: false });
    } else {
      opts.onMessage({ type: 'assistant', message: { content: [{ type: 'text', text: '收到,已确认。' }] } });
      opts.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 500, num_turns: 1, is_error: false });
    }
    session.busy = false;
  });
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');

  // create task
  const res = await cloud.api('POST', '/api/tasks', { title: '测试任务', spec: '创建一个文件', nodeId: 'mac1' });
  assert.equal(res.status, 200);
  const taskId = res.body.task.id;

  // waits for permission
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'waiting_human', 5000, 'waiting_human');
  const t1 = await core.getTask(cloud.ctx, taskId);
  const pending = JSON.parse(t1.pending_request);
  assert.equal(pending.toolName, 'Bash');
  assert.ok(cloud.pushes.some(p => p.title.includes('决策')), 'push sent for waiting_human');

  // approve
  const dec = await cloud.api('POST', `/api/tasks/${taskId}/decision`, { requestId: pending.requestId, behavior: 'allow' });
  assert.equal(dec.status, 200);

  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'review', 5000, 'review');
  const t2 = await core.getTask(cloud.ctx, taskId);
  assert.equal(t2.cost_usd, 0.05);
  assert.ok(t2.session_id?.startsWith('sess-'));
  assert.ok(cloud.pushes.some(p => p.title.includes('Review')));

  // messages landed, including diff with the new file
  const msgs = await cloud.api('GET', `/api/tasks/${taskId}/messages`, {});
  const roles = msgs.body.messages.map(m => m.role);
  assert.deepEqual(roles.filter(r => r === 'user').length >= 1, true);
  assert.ok(roles.includes('tool_use') && roles.includes('tool_result') && roles.includes('perm_request') && roles.includes('result'));
  const diffMsg = msgs.body.messages.find(m => m.role === 'diff');
  assert.ok(diffMsg, 'diff message present');
  assert.match(diffMsg.content.patch, /out\.txt/);

  // follow-up
  await cloud.api('POST', `/api/tasks/${taskId}/message`, { text: '再确认一下' });
  await until(async () => {
    const m = await cloud.api('GET', `/api/tasks/${taskId}/messages`, {});
    return m.body.messages.some(x => x.role === 'assistant' && x.content.text === '收到,已确认。');
  }, 5000, 'follow-up reply');
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'review', 5000, 'review again');

  // mark done
  const done = await cloud.api('POST', `/api/tasks/${taskId}/done`, {});
  assert.equal(done.status, 200);
  assert.equal((await core.getTask(cloud.ctx, taskId)).status, 'done');

  exec.manager.shutdown();
  exec.link.stop();
});

const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('user_message with images: delivered end-to-end and stored/round-tripped correctly', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-img', await sha256Hex('tok-mac-img'), 'user-test', now).run();

  let received = null;
  const exec = makeExecutor(cloud, 'mac-img', async (session, opts, text, images) => {
    received = { text, images };
    await sleep(5);
    opts.onMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } });
    opts.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 10, num_turns: 1, is_error: false });
    session.busy = false;
  });
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');

  const res = await cloud.api('POST', '/api/tasks', { title: 't', spec: '开始', nodeId: 'mac-img' });
  const taskId = res.body.task.id;
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'review', 3000, 'review after turn 1');

  const images = [{ mediaType: 'image/png', data: TINY_PNG_BASE64 }];
  const sendRes = await cloud.api('POST', `/api/tasks/${taskId}/message`, { text: '这张图是什么颜色', images });
  assert.equal(sendRes.status, 200);
  await until(() => received !== null, 3000, 'delivered to the fake session');
  assert.equal(received.text, '这张图是什么颜色');
  assert.deepEqual(received.images, images);

  // messages.content round-trips the images shape through D1 (JSON.stringify/parse).
  const msgs = await cloud.api('GET', `/api/tasks/${taskId}/messages`, {});
  const userMsg = msgs.body.messages.find(m => m.role === 'user' && m.content.text === '这张图是什么颜色');
  assert.ok(userMsg, 'user message with images was stored');
  assert.deepEqual(userMsg.content.images, images);

  exec.manager.shutdown();
  exec.link.stop();
});

test('user_message: images-only message with empty text is accepted', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-img-only', await sha256Hex('tok-mac-img-only'), 'user-test', now).run();

  let received = null;
  const exec = makeExecutor(cloud, 'mac-img-only', async (session, opts, text, images) => {
    received = { text, images };
    await sleep(5);
    opts.onMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } });
    opts.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 10, num_turns: 1, is_error: false });
    session.busy = false;
  });
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');

  const res = await cloud.api('POST', '/api/tasks', { title: 't', spec: '开始', nodeId: 'mac-img-only' });
  const taskId = res.body.task.id;
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'review', 3000, 'review after turn 1');

  const images = [{ mediaType: 'image/png', data: TINY_PNG_BASE64 }];
  const sendRes = await cloud.api('POST', `/api/tasks/${taskId}/message`, { images });
  assert.equal(sendRes.status, 200);
  await until(() => received !== null, 3000, 'delivered');
  assert.equal(received.text, '');
  assert.equal(received.images.length, 1);

  exec.manager.shutdown();
  exec.link.stop();
});

// Reported live: "首次对话无法发送图片,只有首次对话有这个问题" — the draft
// composer that creates a conversation had no attachment support at all, and
// POST /api/tasks silently ignored images. The first message is a message.
test('start_task: images attached to the very first message reach the CLI and land in the conversation', async () => {
  const cloud = makeCloud();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-first-img', await sha256Hex('tok-mac-first-img'), 'user-test', Date.now()).run();

  let received = null;
  const exec = makeExecutor(cloud, 'mac-first-img', async (session, opts, text, images) => {
    received = { text, images };
    await sleep(5);
    opts.onMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } });
    opts.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 10, num_turns: 1, is_error: false });
    session.busy = false;
  });
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');

  const images = [{ mediaType: 'image/png', data: TINY_PNG_BASE64 }];
  const res = await cloud.api('POST', '/api/tasks', { title: 't', spec: '这张图是什么颜色', images, nodeId: 'mac-first-img' });
  assert.equal(res.status, 200);
  const taskId = res.body.task.id;

  await until(() => received !== null, 3000, 'first message delivered to the fake session');
  assert.equal(received.text, '这张图是什么颜色');
  assert.deepEqual(received.images, images);

  // The user bubble the node echoes back carries them too, so the picture is
  // visible in the log on every device — not just inside the CLI's context.
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'review', 3000, 'turn done');
  const msgs = await cloud.api('GET', `/api/tasks/${taskId}/messages`, {});
  const userMsg = msgs.body.messages.find(m => m.role === 'user');
  assert.deepEqual(userMsg.content.images, images);

  // tasks.spec stays the plain human-readable ask (it's what the 信息 tab
  // renders) — the encoded {text,images} form only exists node-side.
  assert.equal((await core.getTask(cloud.ctx, taskId)).spec, '这张图是什么颜色');

  exec.manager.shutdown();
  exec.link.stop();
});

test('start_task: a first message of images alone (no text) is accepted, and bad batches are refused', async () => {
  const cloud = makeCloud();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-first-img2', await sha256Hex('tok-mac-first-img2'), 'user-test', Date.now()).run();

  let received = null;
  const exec = makeExecutor(cloud, 'mac-first-img2', async (session, opts, text, images) => {
    received = { text, images };
    await sleep(5);
    opts.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 10, num_turns: 1, is_error: false });
    session.busy = false;
  });
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');

  // Neither text nor images nor a session to resume is still a 400.
  const empty = await cloud.api('POST', '/api/tasks', { title: 't', nodeId: 'mac-first-img2' });
  assert.equal(empty.status, 400);

  // Same server-side backstop as the message route, now shared.
  const tooMany = Array.from({ length: MAX_IMAGES_PER_MESSAGE + 1 }, () => ({ mediaType: 'image/png', data: TINY_PNG_BASE64 }));
  assert.equal((await cloud.api('POST', '/api/tasks', { title: 't', spec: 'x', images: tooMany, nodeId: 'mac-first-img2' })).status, 400);
  assert.equal((await cloud.api('POST', '/api/tasks', { title: 't', spec: 'x', images: [{ mediaType: 'image/gif', data: TINY_PNG_BASE64 }], nodeId: 'mac-first-img2' })).status, 400);
  const oversizedB64 = 'A'.repeat(Math.ceil((MAX_ATTACHMENT_TOTAL_RAW_BYTES + 100_000) / 0.75));
  assert.equal((await cloud.api('POST', '/api/tasks', { title: 't', spec: 'x', images: [{ mediaType: 'image/png', data: oversizedB64 }], nodeId: 'mac-first-img2' })).status, 400);
  assert.equal(received, null, 'no rejected creation ever reached the node');

  const images = [{ mediaType: 'image/png', data: TINY_PNG_BASE64 }];
  const res = await cloud.api('POST', '/api/tasks', { title: '图片对话', images, nodeId: 'mac-first-img2' });
  assert.equal(res.status, 200);
  await until(() => received !== null, 3000, 'images-only first message delivered');
  assert.equal(received.text, '');
  assert.deepEqual(received.images, images);

  exec.manager.shutdown();
  exec.link.stop();
});

test('start_task: images are refused for a node whose executor predates the feature, not silently dropped', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind('mac-old', await sha256Hex('tok-mac-old'), 'user-test', 'online', now).run();
  // An old node: current protocol version (so it isn't rejected outright) but
  // without the task-images feature in its hello.
  await cloud.db.prepare('INSERT INTO node_capabilities (node_id, protocol_version, backends, updated_at) VALUES (?, ?, ?, ?)')
    .bind('mac-old', PROTOCOL_VERSION, JSON.stringify(['claude']), now).run();
  await cloud.db.prepare('INSERT INTO node_features (node_id, features, updated_at) VALUES (?, ?, ?)')
    .bind('mac-old', JSON.stringify(['message-ack']), now).run();

  const withImages = await cloud.api('POST', '/api/tasks', {
    title: 't', spec: 'x', images: [{ mediaType: 'image/png', data: TINY_PNG_BASE64 }], nodeId: 'mac-old',
  });
  assert.equal(withImages.status, 409);
  // Text-only creation on the same node is untouched.
  assert.equal((await cloud.api('POST', '/api/tasks', { title: 't', spec: 'x', nodeId: 'mac-old' })).status, 200);
});

// ---- durable user messages ----
// A chat send is the one command whose loss destroys content the user already
// typed, with nothing left on screen to retry — reported live as a message
// that "直接永久消失". These cover the guarantee that replaced the old
// fire-and-forget dispatch: accepted means persisted, undelivered means
// visibly pending and retried, and redelivery never runs the turn twice.

test('durable message: a send into a dead socket survives, is visible while pending, and is delivered on reconnect', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-durable', await sha256Hex('tok-mac-durable'), 'user-test', now).run();

  const delivered = [];
  const exec = makeExecutor(cloud, 'mac-durable', async (session, opts, text) => {
    delivered.push(text);
    await sleep(5);
    opts.onMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } });
    opts.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 10, num_turns: 1, is_error: false });
    session.busy = false;
  });
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');
  const created = await cloud.api('POST', '/api/tasks', { title: 't', spec: '开始', nodeId: 'mac-durable' });
  const taskId = created.body.task.id;
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'review', 3000, 'first turn settled');

  exec.link.backoff = 30;
  cloud.dropNode('mac-durable');
  await until(() => !exec.link.connected, 2000, 'node offline');

  const sent = await cloud.api('POST', `/api/tasks/${taskId}/message`,
    { text: '离线时发的消息', clientMessageId: 'cm-offline-1' });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.delivery, 'queued', 'an unreachable node yields an honest "queued", not a fake success');

  // Still readable everywhere while in flight — this is what makes it not
  // look like it vanished.
  const whilePending = await cloud.api('GET', `/api/tasks/${taskId}/messages`, {});
  assert.deepEqual(whilePending.body.pending.map(p => [p.clientMessageId, p.text, p.state]),
    [['cm-offline-1', '离线时发的消息', 'pending']]);
  assert.ok(cloud.broadcasts.some(b => b.t === 'pending_msg' && b.pending.clientMessageId === 'cm-offline-1'),
    'other devices are told about the in-flight send immediately');

  await until(() => exec.link.connected, 5000, 'reconnected');
  await until(() => delivered.includes('离线时发的消息'), 5000, 'delivered after reconnect');

  await until(async () => {
    const m = await cloud.api('GET', `/api/tasks/${taskId}/messages`, {});
    return m.body.messages.some(x => x.role === 'user' && x.content.text === '离线时发的消息') && !m.body.pending.length;
  }, 5000, 'pending row retired once the node echoed it back');
  assert.ok(cloud.broadcasts.some(b => b.t === 'pending_settled' && b.clientMessageId === 'cm-offline-1' && b.state === 'delivered'));

  exec.manager.shutdown();
  exec.link.stop();
});

test('durable message: redelivery of the same clientMessageId never runs a second turn', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-dedupe', await sha256Hex('tok-mac-dedupe'), 'user-test', now).run();

  const turns = [];
  const exec = makeExecutor(cloud, 'mac-dedupe', async (session, opts, text) => {
    turns.push(text);
    await sleep(5);
    opts.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 10, num_turns: 1, is_error: false });
    session.busy = false;
  });
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');
  const created = await cloud.api('POST', '/api/tasks', { title: 't', spec: '开始', nodeId: 'mac-dedupe' });
  const taskId = created.body.task.id;
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'review', 3000, 'first turn settled');
  turns.length = 0;

  const first = await cloud.api('POST', `/api/tasks/${taskId}/message`, { text: '只该跑一次', clientMessageId: 'cm-once' });
  assert.equal(first.body.delivery, 'sent');
  await until(() => turns.length === 1, 3000, 'turn ran');

  // Same id again: the API retry a flaky network would produce, and the
  // cloud's own redelivery. Neither may spend another relay turn.
  const second = await cloud.api('POST', `/api/tasks/${taskId}/message`, { text: '只该跑一次', clientMessageId: 'cm-once' });
  assert.equal(second.status, 200);
  exec.manager.handleCommand({ t: 'user_message', taskId, text: '只该跑一次', clientMessageId: 'cm-once' });
  await cloud.flush();
  await sleep(120);
  assert.deepEqual(turns, ['只该跑一次'], 'the duplicate produced no second turn');

  const msgs = await cloud.api('GET', `/api/tasks/${taskId}/messages`, {});
  const copies = msgs.body.messages.filter(m => m.role === 'user' && m.content.text === '只该跑一次');
  assert.equal(copies.length, 1, 'and no second bubble');
  assert.equal(msgs.body.pending.length, 0);

  exec.manager.shutdown();
  exec.link.stop();
});

test('durable message: a send the node never confirms is retried, then fails visibly and can be retried by hand', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-halfopen', await sha256Hex('tok-mac-halfopen'), 'user-test', now).run();
  await cloud.db.prepare(`INSERT INTO tasks (id,title,spec,node_id,owner_user_id,status,created_at,updated_at)
    VALUES ('HALFOPEN','t','x','mac-halfopen','user-test','review',?,?)`).bind(now, now).run();
  // A current-code node: it has told us it can confirm deliveries, which is
  // what entitles this send to be retried until it does.
  await core.handleHello(cloud.ctx, 'mac-halfopen', {
    t: 'hello', nodeId: 'mac-halfopen', protocolVersion: PROTOCOL_VERSION,
    backends: ['claude'], features: ['message-ack'], tasks: [],
  });

  // A half-open socket: send() reports success, nothing ever arrives. This is
  // the case that used to lose messages silently, since "didn't throw" was
  // treated as delivery.
  const swallowed = [];
  const realSend = cloud.ctx.sendToNode;
  cloud.ctx.sendToNode = (nodeId, msg) => {
    if (msg.t === 'user_message') { swallowed.push(msg); return true; }
    return realSend(nodeId, msg);
  };
  try {
    const sent = await cloud.api('POST', '/api/tasks/HALFOPEN/message', { text: '掉进黑洞的消息', clientMessageId: 'cm-void' });
    assert.equal(sent.body.delivery, 'sent', 'the socket claimed it went out');
    assert.equal(swallowed.length, 1);

    // Unconfirmed, so a later flush pushes it again rather than assuming the
    // first attempt worked.
    await core.flushOutboundMessages(cloud.ctx, 'mac-halfopen');
    assert.equal(swallowed.length, 2, 'still pending -> redelivered');

    const stillThere = await cloud.api('GET', '/api/tasks/HALFOPEN/messages', {});
    assert.equal(stillThere.body.pending[0].text, '掉进黑洞的消息', 'the text is never lost');

    // Past the TTL the cloud stops pretending and hands the user a retry.
    cloud.setNow(now + OUTBOUND_MESSAGE_TTL_MS + 1000);
    await core.flushOutboundMessages(cloud.ctx, 'mac-halfopen');
    const failed = await cloud.api('GET', '/api/tasks/HALFOPEN/messages', {});
    assert.equal(failed.body.pending[0].state, 'failed');
    assert.ok(cloud.broadcasts.some(b => b.t === 'pending_settled' && b.clientMessageId === 'cm-void' && b.state === 'failed'));

    const retry = await cloud.api('POST', '/api/tasks/HALFOPEN/retry-message', { clientMessageId: 'cm-void' });
    assert.equal(retry.status, 200);
    const retried = await cloud.api('GET', '/api/tasks/HALFOPEN/messages', {});
    assert.equal(retried.body.pending[0].state, 'pending', 'retry revives the same bubble rather than making a new one');
    assert.equal(retried.body.pending.length, 1);
  } finally {
    cloud.ctx.sendToNode = realSend;
  }
});

test('durable message: a message that arrives during IDE takeover is recorded instead of discarded', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-lease', await sha256Hex('tok-mac-lease'), 'user-test', now).run();
  const exec = makeExecutor(cloud, 'mac-lease', async (session, opts) => {
    await sleep(5); // let _spawn finish its own status write before the turn settles
    opts.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0, duration_ms: 5, num_turns: 1, is_error: false });
    session.busy = false;
  });
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');
  const created = await cloud.api('POST', '/api/tasks', { title: 't', spec: '开始', nodeId: 'mac-lease' });
  const taskId = created.body.task.id;
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'review', 3000, 'first turn settled');

  // The lease flips after the cloud already accepted the send (a race the
  // API's own 409 can't catch). The text must still end up somewhere the
  // user can see it, not be answered with a system note and thrown away.
  exec.manager.setLease(taskId, 'human');
  exec.manager.handleCommand({ t: 'user_message', taskId, text: 'IDE 接管期间发的', clientMessageId: 'cm-lease' });
  await until(async () => {
    const m = await cloud.api('GET', `/api/tasks/${taskId}/messages`, {});
    return m.body.messages.some(x => x.role === 'user' && x.content.text === 'IDE 接管期间发的');
  }, 3000, 'message recorded despite the takeover');

  exec.manager.shutdown();
  exec.link.stop();
});

test('durable message: a node that cannot confirm delivery is never redelivered to (no duplicate turns during an upgrade)', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO nodes (id,token_hash,owner_user_id,created_at) VALUES (?,?,?,?)')
    .bind('old-node', 'h', 'user-test', now).run();
  await cloud.db.prepare(`INSERT INTO tasks (id,title,spec,node_id,owner_user_id,status,created_at,updated_at)
    VALUES ('OLDNODE','t','x','old-node','user-test','review',?,?)`).bind(now, now).run();
  // A pre-upgrade executor: it reports no `features`, and (crucially) its
  // user events carry no clientMessageId, so nothing can ever settle the row.
  await core.handleHello(cloud.ctx, 'old-node', { t: 'hello', nodeId: 'old-node', protocolVersion: PROTOCOL_VERSION, backends: ['claude'], tasks: [] });

  const sends = [];
  const realSend = cloud.ctx.sendToNode;
  cloud.ctx.sendToNode = (nodeId, msg) => {
    if (msg.t === 'user_message') { sends.push(msg); return true; }
    return realSend(nodeId, msg);
  };
  try {
    const sent = await cloud.api('POST', '/api/tasks/OLDNODE/message', { text: '给旧节点的消息', clientMessageId: 'cm-old' });
    assert.equal(sent.status, 200);
    assert.equal(sends.length, 1, 'delivered once');

    // Retrying here would make that node genuinely re-run the turn and spend
    // real relay tokens — the row is settled optimistically instead.
    await core.flushOutboundMessages(cloud.ctx, 'old-node');
    await core.flushOutboundMessages(cloud.ctx, 'old-node');
    assert.equal(sends.length, 1, 'a node that cannot confirm is never re-sent to');

    const after = await cloud.api('GET', '/api/tasks/OLDNODE/messages', {});
    assert.equal(after.body.pending.length, 0, 'and is not left as a bubble that can never resolve');

    // Once that same node upgrades and says so, the real guarantee applies.
    await core.handleHello(cloud.ctx, 'old-node', {
      t: 'hello', nodeId: 'old-node', protocolVersion: PROTOCOL_VERSION,
      backends: ['claude'], features: ['message-ack'], tasks: [],
    });
    await cloud.api('POST', '/api/tasks/OLDNODE/message', { text: '升级后的消息', clientMessageId: 'cm-new' });
    await core.flushOutboundMessages(cloud.ctx, 'old-node');
    assert.equal(sends.filter(s => s.clientMessageId === 'cm-new').length, 2, 'an upgraded node does get redelivery');
  } finally {
    cloud.ctx.sendToNode = realSend;
  }
});

test('POST /message: validates images (too many, unsupported type, oversized payload)', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-img-validate', await sha256Hex('tok-mac-img-validate'), 'user-test', now).run();

  let calls = 0;
  const exec = makeExecutor(cloud, 'mac-img-validate', async (session, opts, text) => {
    calls++;
    await sleep(5);
    opts.onMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } });
    opts.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 10, num_turns: 1, is_error: false });
    session.busy = false;
  });
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');

  const res = await cloud.api('POST', '/api/tasks', { title: 't', spec: '开始', nodeId: 'mac-img-validate' });
  const taskId = res.body.task.id;
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'review', 3000, 'review after turn 1');
  calls = 0; // reset past the creation turn — only care about calls from here on

  // too many images
  const tooMany = Array.from({ length: MAX_IMAGES_PER_MESSAGE + 1 }, () => ({ mediaType: 'image/png', data: TINY_PNG_BASE64 }));
  const r1 = await cloud.api('POST', `/api/tasks/${taskId}/message`, { text: 'x', images: tooMany });
  assert.equal(r1.status, 400);

  // unsupported mime type
  const r2 = await cloud.api('POST', `/api/tasks/${taskId}/message`, { text: 'x', images: [{ mediaType: 'image/gif', data: TINY_PNG_BASE64 }] });
  assert.equal(r2.status, 400);

  // oversized combined payload — a base64 string whose estimated raw size
  // alone exceeds the shared budget (repeat a valid-alphabet char; content
  // doesn't need to decode to a real image for the size check itself).
  const oversizedB64 = 'A'.repeat(Math.ceil((MAX_ATTACHMENT_TOTAL_RAW_BYTES + 100_000) / 0.75));
  const r3 = await cloud.api('POST', `/api/tasks/${taskId}/message`, { text: 'x', images: [{ mediaType: 'image/png', data: oversizedB64 }] });
  assert.equal(r3.status, 400);

  // none of the rejected attempts ever reached the executor
  assert.equal(calls, 0, 'invalid image payloads never dispatch to the node');

  exec.manager.shutdown();
  exec.link.stop();
});

test('SessionManager.hasActiveGeneration: waiting_human does not block self-update, but an in-flight turn does', async () => {
  const cloud = makeCloud();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac1', await sha256Hex('tok-mac1'), 'user-test', Date.now()).run();

  let releaseGeneration;
  const exec = makeExecutor(cloud, 'mac1', async (session, opts, text) => {
    // Blocks before ever reaching the permission ask — stands in for a genuinely in-flight generation.
    await new Promise(resolve => { releaseGeneration = resolve; });
    opts.onMessage({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'echo hi' } }] } });
    const decision = await opts.onPermission({ requestId: 'req1', toolName: 'Bash', input: { command: 'echo hi' } });
    assert.equal(decision.behavior, 'allow');
    opts.onMessage({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok', is_error: false }] } });
    opts.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 10, num_turns: 1, is_error: false });
    session.busy = false;
  });
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');

  const res = await cloud.api('POST', '/api/tasks', { title: 'idle-gate test', spec: 'x', nodeId: 'mac1' });
  const taskId = res.body.task.id;

  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'running', 5000, 'running (turn in flight)');
  assert.equal(exec.manager.hasActiveGeneration(), true, 'a genuinely in-flight turn must block self-update');

  releaseGeneration();

  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'waiting_human', 5000, 'waiting_human');
  // Parked on a human decision: still occupies a parallelism slot (runningCount) —
  // but there's no live generation to interrupt, so self-update must treat this as idle.
  assert.equal(exec.manager.runningCount(), 1);
  assert.equal(exec.manager.hasActiveGeneration(), false);

  const dec = await cloud.api('POST', `/api/tasks/${taskId}/decision`, { requestId: 'req1', behavior: 'allow' });
  assert.equal(dec.status, 200);

  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'review', 5000, 'review');
  assert.equal(exec.manager.hasActiveGeneration(), false);

  exec.manager.shutdown();
  exec.link.stop();
});

test('cost remains observable without limiting a successful task', async () => {
  const cloud = makeCloud();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-unlimited-cost', await sha256Hex('tok-mac-unlimited-cost'), 'user-test', Date.now()).run();

  const exec = makeExecutor(cloud, 'mac-unlimited-cost', async (session, opts) => {
    await sleep(10); // yield so _spawn's own post-send setStatus('running') runs first
    opts.onMessage({ type: 'assistant', message: { content: [{ type: 'text', text: '好的' }] } });
    opts.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 999, duration_ms: 1000, num_turns: 1, is_error: false });
    session.busy = false;
  });
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');

  const res = await cloud.api('POST', '/api/tasks', { title: '高成本但不设限', spec: 'x', nodeId: 'mac-unlimited-cost' });
  const taskId = res.body.task.id;

  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'review', 5000, 'review despite high cost');
  const cloudTask = await core.getTask(cloud.ctx, taskId);
  assert.equal(cloudTask.cost_usd, 999, 'cloud keeps the reference cost');
  assert.equal(cloudTask.pending_request, null, 'cost never creates a human-decision gate');
  assert.equal(exec.db.getTask(taskId).cost_usd, 999, 'executor keeps the reference cost');
  const messagesResponse = await cloud.api('GET', `/api/tasks/${taskId}/messages`, { after_seq: 0, limit: 100 });
  const result = messagesResponse.body.messages.find(message => message.role === 'result');
  assert.equal(result.content.turn_cost_usd, 999);
  assert.equal(result.content.total_cost_usd, 999);

  exec.manager.shutdown();
  exec.link.stop();
});

test('decision: "auto-approve" allow switches permission_mode to bypassPermissions — scoped to this task, or account-wide including an already-running task', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-auto', await sha256Hex('tok-mac-auto'), 'user-test', now).run();

  // Task A raises a permission request; task B just sits there running,
  // simulating "a conversation already in flight" that account-wide
  // auto-approve is supposed to reach too, not just future new ones.
  const exec = makeExecutor(cloud, 'mac-auto', async (session, opts, text) => {
    if (text === '开始A') {
      await sleep(10);
      const decision = await opts.onPermission({ requestId: 'reqA', toolName: 'Bash', input: { command: 'echo hi' } });
      if (decision.behavior === 'allow') {
        opts.onMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } });
        opts.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 100, num_turns: 1, is_error: false });
      }
      session.busy = false;
    }
    // task B's spec ('开始B') deliberately never resolves — it just sits
    // "running", standing in for an already-in-flight conversation.
  });
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');

  const resA = await cloud.api('POST', '/api/tasks', { title: 'A', spec: '开始A', nodeId: 'mac-auto', permissionMode: 'default' });
  const taskA = resA.body.task.id;
  const resB = await cloud.api('POST', '/api/tasks', { title: 'B', spec: '开始B', nodeId: 'mac-auto', permissionMode: 'default' });
  const taskB = resB.body.task.id;

  await until(async () => (await core.getTask(cloud.ctx, taskA))?.status === 'waiting_human', 5000, 'A waiting_human');
  const pendingA = JSON.parse((await core.getTask(cloud.ctx, taskA)).pending_request);

  // Scoped to just this task first.
  const dec1 = await cloud.api('POST', `/api/tasks/${taskA}/decision`, { requestId: pendingA.requestId, behavior: 'allow', autoApprove: 'this' });
  assert.equal(dec1.status, 200);
  await until(async () => (await core.getTask(cloud.ctx, taskA))?.permission_mode === 'bypassPermissions', 3000, 'A switched to bypass');
  assert.equal((await core.getTask(cloud.ctx, taskB)).permission_mode, 'default', "'this' must not touch other tasks");
  await until(() => exec.db.getTask(taskA)?.permission_mode === 'bypassPermissions', 3000, 'A switched locally too');

  // Now a second permission request on A (simulating a later turn), this
  // time approved with 'account' — must reach task B as well, cloud *and*
  // the executor's own local record (what actually governs the next spawn).
  // C is created only to prove account-wide reaches *every* other owned
  // task, not just the one other task that happened to exist already.
  const res2 = await cloud.api('POST', '/api/tasks', { title: 'C-unused', spec: 'x', nodeId: 'mac-auto', permissionMode: 'default' });
  const taskC = res2.body.task.id;

  // Re-open a fresh pending decision on A directly via the manager, since A
  // already finished its one scripted turn above.
  exec.manager._onPermission(taskA, { requestId: 'reqA2', toolName: 'Bash', input: { command: 'echo again' } });
  await until(async () => (await core.getTask(cloud.ctx, taskA))?.status === 'waiting_human', 3000, 'A waiting_human again');

  const dec2 = await cloud.api('POST', `/api/tasks/${taskA}/decision`, { requestId: 'reqA2', behavior: 'allow', autoApprove: 'account' });
  assert.equal(dec2.status, 200);
  await until(async () => (await core.getTask(cloud.ctx, taskB))?.permission_mode === 'bypassPermissions', 3000, 'B switched account-wide');
  assert.equal((await core.getTask(cloud.ctx, taskC)).permission_mode, 'bypassPermissions', 'reaches every other owned task, not just one');
  await until(() => exec.db.getTask(taskB)?.permission_mode === 'bypassPermissions', 3000, 'B switched locally too — governs its next spawn');
  assert.equal(exec.db.getTask(taskC)?.permission_mode, 'bypassPermissions');

  exec.manager.shutdown();
  exec.link.stop();
});

test('decision: "force-approve" (forceAll) makes the executor auto-decide future requests itself, without ever surfacing a card — scoped to this task, or account-wide', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-force', await sha256Hex('tok-mac-force'), 'user-test', now).run();

  // Both A and B raise a permission request on their first (and only
  // scripted) turn; whatever happens after "done" is left to the test to
  // drive directly via the manager, since a force-approved task never
  // produces a *new* real pending decision to submit through the HTTP route.
  const exec = makeExecutor(cloud, 'mac-force', async (session, opts, text) => {
    if (text === '开始A' || text === '开始B') {
      await sleep(10);
      const reqId = text === '开始A' ? 'reqA' : 'reqB';
      const decision = await opts.onPermission({ requestId: reqId, toolName: 'Bash', input: { command: 'rm -f x' } });
      if (decision.behavior === 'allow') {
        opts.onMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } });
        opts.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 100, num_turns: 1, is_error: false });
      }
      session.busy = false;
    }
  });
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');

  const resA = await cloud.api('POST', '/api/tasks', { title: 'A', spec: '开始A', nodeId: 'mac-force', permissionMode: 'bypassPermissions' });
  const taskA = resA.body.task.id;
  const resB = await cloud.api('POST', '/api/tasks', { title: 'B', spec: '开始B', nodeId: 'mac-force', permissionMode: 'bypassPermissions' });
  const taskB = resB.body.task.id;
  const resC = await cloud.api('POST', '/api/tasks', { title: 'C-unused', spec: 'x', nodeId: 'mac-force', permissionMode: 'bypassPermissions' });
  const taskC = resC.body.task.id;

  await until(async () => (await core.getTask(cloud.ctx, taskA))?.status === 'waiting_human', 5000, 'A waiting_human');
  const pendingA = JSON.parse((await core.getTask(cloud.ctx, taskA)).pending_request);

  // Scoped to just this task first.
  const dec1 = await cloud.api('POST', `/api/tasks/${taskA}/decision`, { requestId: pendingA.requestId, behavior: 'allow', forceAll: 'this' });
  assert.equal(dec1.status, 200);
  await until(() => exec.db.getTask(taskA)?.auto_decide_all === 1, 3000, 'A force-approve set locally');
  assert.equal((await core.getTask(cloud.ctx, taskA)).auto_decide_all, 1);
  assert.equal((await core.getTask(cloud.ctx, taskB)).auto_decide_all ?? 0, 0, "'this' must not touch other tasks");

  // A brand new request on A must now resolve immediately and silently —
  // never creating a pending_request/waiting_human state, the whole point
  // being it doesn't surface as a card at all — while still leaving a
  // visible log entry of what got auto-approved.
  const decision2 = await exec.manager._onPermission(taskA, { requestId: 'reqA2', toolName: 'Bash', input: { command: 'rm -rf y' } });
  assert.equal(decision2.behavior, 'allow');
  assert.equal((await core.getTask(cloud.ctx, taskA)).pending_request, null, 'no pending decision ever created for a force-approved task');
  await until(async () => {
    const m = await cloud.api('GET', `/api/tasks/${taskA}/messages`, {});
    return m.body.messages.some(x => x.role === 'system' && x.content.text.includes('已自动批准'));
  }, 3000, 'auto-approval logged visibly');

  // Now account-wide, driven from B's own (still real) pending decision —
  // must reach C as well, cloud *and* the executor's own local record.
  await until(async () => (await core.getTask(cloud.ctx, taskB))?.status === 'waiting_human', 5000, 'B waiting_human');
  const pendingB = JSON.parse((await core.getTask(cloud.ctx, taskB)).pending_request);
  const dec2 = await cloud.api('POST', `/api/tasks/${taskB}/decision`, { requestId: pendingB.requestId, behavior: 'allow', forceAll: 'account' });
  assert.equal(dec2.status, 200);
  await until(() => exec.db.getTask(taskC)?.auto_decide_all === 1, 3000, 'C force-approve set locally — governs its own future requests');
  assert.equal((await core.getTask(cloud.ctx, taskB)).auto_decide_all, 1);
  assert.equal((await core.getTask(cloud.ctx, taskC)).auto_decide_all, 1, 'reaches every other owned task, not just one');

  exec.manager.shutdown();
  exec.link.stop();
});

test('hello_ok reconciliation: cloud re-asserts auto_decide_all/permission_mode on every reconnect, self-healing local drift', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-reheal', await sha256Hex('tok-mac-reheal'), 'user-test', now).run();

  const exec = makeExecutor(cloud, 'mac-reheal', async (session, opts) => {
    await sleep(10);
    const decision = await opts.onPermission({ requestId: 'req1', toolName: 'Bash', input: { command: 'rm -f x' } });
    if (decision.behavior === 'allow') {
      opts.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 100, num_turns: 1, is_error: false });
    }
    session.busy = false;
  });
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');

  const res = await cloud.api('POST', '/api/tasks', { title: 't', spec: '开始', nodeId: 'mac-reheal', permissionMode: 'bypassPermissions' });
  const taskId = res.body.task.id;
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'waiting_human', 5000, 'waiting_human');
  const pending = JSON.parse((await core.getTask(cloud.ctx, taskId)).pending_request);

  const dec = await cloud.api('POST', `/api/tasks/${taskId}/decision`, { requestId: pending.requestId, behavior: 'allow', forceAll: 'this' });
  assert.equal(dec.status, 200);
  await until(() => exec.db.getTask(taskId)?.auto_decide_all === 1, 3000, 'set locally via the live dispatch');

  // Simulate the drift found live: cloud stays authoritative (still 1) but
  // the node's own local copy is somehow back to 0 — no code path in this
  // repo is known to do this, but it happened in production more than once
  // with nothing to detect or correct it. Reconnect must self-heal it.
  exec.db.patchTask(taskId, { autoDecideAll: 0 });
  assert.equal(exec.db.getTask(taskId).auto_decide_all, 0, 'drift simulated locally');
  assert.equal((await core.getTask(cloud.ctx, taskId)).auto_decide_all, 1, 'cloud was never touched — still authoritative');

  exec.link.backoff = 30;
  cloud.dropNode('mac-reheal');
  await until(() => !exec.link.connected, 2000, 'disconnected');
  await until(() => exec.link.connected, 5000, 'reconnected');
  await until(() => exec.db.getTask(taskId)?.auto_decide_all === 1, 3000, 'hello_ok re-asserted cloud\'s value, healing the drift');

  exec.manager.shutdown();
  exec.link.stop();
});

test('decision: forceAll (auto_decide_all) does not auto-approve AskUserQuestion — it needs real answers, not a yes/no', async () => {
  const cloud = makeCloud();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-force-askq', await sha256Hex('tok-mac-force-askq'), 'user-test', Date.now()).run();

  const exec = makeExecutor(cloud, 'mac-force-askq', async (session, opts, text) => {
    if (text === '开始') {
      await sleep(10);
      const decision = await opts.onPermission({ requestId: 'reqBash', toolName: 'Bash', input: { command: 'rm -f x' } });
      if (decision.behavior === 'allow') {
        opts.onMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } });
        opts.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 100, num_turns: 1, is_error: false });
      }
      session.busy = false;
    }
  });
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');

  const res = await cloud.api('POST', '/api/tasks', { title: 'askq-force', spec: '开始', nodeId: 'mac-force-askq', permissionMode: 'bypassPermissions' });
  const taskId = res.body.task.id;
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'waiting_human', 5000, 'waiting_human on the Bash ask');
  const pending = JSON.parse((await core.getTask(cloud.ctx, taskId)).pending_request);

  // Turn on forceAll via a real Bash approval — same as any other task.
  const dec = await cloud.api('POST', `/api/tasks/${taskId}/decision`, { requestId: pending.requestId, behavior: 'allow', forceAll: 'this' });
  assert.equal(dec.status, 200);
  await until(() => exec.db.getTask(taskId)?.auto_decide_all === 1, 3000, 'forceAll set locally');

  // A subsequent plain Bash request is still auto-approved (forceAll works normally)...
  const bashDecision = await exec.manager._onPermission(taskId, { requestId: 'reqBash2', toolName: 'Bash', input: { command: 'echo hi' } });
  assert.equal(bashDecision.behavior, 'allow');
  // clearing the *original* reqBash pending_request is itself async (round
  // trips through the executor's own decide()/emit pipeline) — wait for it
  // rather than racing ahead of that propagation.
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.pending_request === null, 3000, 'original pending_request cleared');

  // ...but an AskUserQuestion must NOT be silently auto-answered — it has no
  // meaningful "allow", it needs the human's actual picks. _onPermission's
  // promise deliberately stays unresolved here (mirroring the real card
  // waiting on screen); resolve it via decide() below like a normal answer.
  const askqPromise = exec.manager._onPermission(taskId, {
    requestId: 'reqAskQ', toolName: 'AskUserQuestion',
    input: { questions: [{ question: '继续吗?', options: [{ label: '是' }, { label: '否' }] }] },
  });
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'waiting_human', 3000, 'AskUserQuestion still surfaces as a real card');
  const t = await core.getTask(cloud.ctx, taskId);
  assert.ok(t.pending_request, 'AskUserQuestion creates a genuine pending_request despite forceAll being on');
  assert.equal(JSON.parse(t.pending_request).toolName, 'AskUserQuestion');

  exec.manager.decide(taskId, 'reqAskQ', 'allow', undefined, { answers: { '继续吗?': '是' } });
  const finalDecision = await askqPromise;
  assert.equal(finalDecision.behavior, 'allow');
  assert.deepEqual(finalDecision.updatedInput, { answers: { '继续吗?': '是' } });

  exec.manager.shutdown();
  exec.link.stop();
});

test('assistant thinking blocks are persisted as their own message role, and usage lands as context_tokens', async () => {
  const cloud = makeCloud();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-think', await sha256Hex('tok-mac-think'), 'user-test', Date.now()).run();

  const exec = makeExecutor(cloud, 'mac-think', async (session, opts) => {
    await sleep(10);
    opts.onMessage({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: '先想想怎么做' },
          { type: 'text', text: '好的,开始了' },
        ],
        usage: { input_tokens: 100, cache_read_input_tokens: 4000, cache_creation_input_tokens: 900, output_tokens: 50 },
      },
    });
    opts.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 100, num_turns: 1, is_error: false });
    session.busy = false;
  });
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');

  const res = await cloud.api('POST', '/api/tasks', { title: 't', spec: '开始', nodeId: 'mac-think' });
  const taskId = res.body.task.id;
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'review', 5000, 'review');

  const msgs = await cloud.api('GET', `/api/tasks/${taskId}/messages`, {});
  const thinking = msgs.body.messages.find(m => m.role === 'thinking');
  assert.ok(thinking, 'thinking message present');
  assert.equal(thinking.content.text, '先想想怎么做');
  assert.ok(msgs.body.messages.some(m => m.role === 'assistant' && m.content.text === '好的,开始了'));

  const t = await core.getTask(cloud.ctx, taskId);
  assert.equal(t.context_tokens, 100 + 4000 + 900);

  exec.manager.shutdown();
  exec.link.stop();
});

test('decision: updatedInput (e.g. AskUserQuestion answers) flows from the API through to onPermission\'s resolved decision', async () => {
  const cloud = makeCloud();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-updinput', await sha256Hex('tok-mac-updinput'), 'user-test', Date.now()).run();

  let resolvedDecision = null;
  const exec = makeExecutor(cloud, 'mac-updinput', async (session, opts) => {
    await sleep(10);
    opts.onMessage({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'AskUserQuestion', input: { questions: [{ question: '选哪个?', options: [{ label: 'A' }, { label: 'B' }] }] } }] } });
    resolvedDecision = await opts.onPermission({
      requestId: 'req-askq', toolName: 'AskUserQuestion',
      input: { questions: [{ question: '选哪个?', options: [{ label: 'A' }, { label: 'B' }] }] },
    });
    opts.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0, duration_ms: 10, num_turns: 1, is_error: false });
    session.busy = false;
  });
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');

  const res = await cloud.api('POST', '/api/tasks', { title: 't', spec: '问我一个问题', nodeId: 'mac-updinput' });
  const taskId = res.body.task.id;
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'waiting_human', 5000, 'waiting_human');

  const updatedInput = { questions: [{ question: '选哪个?', options: [{ label: 'A' }, { label: 'B' }] }], answers: { '选哪个?': 'A' } };
  const dec = await cloud.api('POST', `/api/tasks/${taskId}/decision`, { requestId: 'req-askq', behavior: 'allow', updatedInput });
  assert.equal(dec.status, 200);

  await until(() => resolvedDecision !== null, 5000, 'decision resolved');
  assert.equal(resolvedDecision.behavior, 'allow');
  assert.deepEqual(resolvedDecision.updatedInput, updatedInput);

  exec.manager.shutdown();
  exec.link.stop();
});

test('IDE takeover: messages an IDE-driven `claude --resume` appends while leased are synced back on return', async () => {
  const cloud = makeCloud();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-ide', await sha256Hex('tok-mac-ide'), 'user-test', Date.now()).run();

  let capturedSessionId = null;
  const exec = makeExecutor(cloud, 'mac-ide', async (session, opts) => {
    capturedSessionId = session.sessionId;
    await sleep(10);
    opts.onMessage({ type: 'assistant', message: { content: [{ type: 'text', text: '我先做了一些工作' }] } });
    opts.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 100, num_turns: 1, is_error: false });
    session.busy = false;
  });
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');

  const res = await cloud.api('POST', '/api/tasks', { title: 't', spec: '开始工作', nodeId: 'mac-ide' });
  const taskId = res.body.task.id;
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'review', 5000, 'review');
  assert.ok(capturedSessionId, 'session id captured');

  // The fake session factory doesn't write a real transcript file the way
  // the actual CLI would — write the "baseline" state (what AgentHub's own
  // turn produced) directly, matching what a real session file would have
  // at this point.
  const localTask = exec.db.getTask(taskId);
  const file = nativeSessionFile(exec.workRoot, localTask.dir, capturedSessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    { type: 'user', message: { content: '开始工作' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: '我先做了一些工作' }] } },
  ].map(l => JSON.stringify(l)).join('\n') + '\n');

  const lease1 = await cloud.api('POST', `/api/tasks/${taskId}/lease`, { lease: 'human' });
  assert.equal(lease1.status, 200);
  await until(async () => (await core.getTask(cloud.ctx, taskId)).lease === 'human', 5000, 'leased to human');

  // Simulate the IDE's own `claude --resume` appending more conversation
  // directly to the same transcript file — AgentHub's process is dead at
  // this point (killed on takeover), so this is genuinely invisible to it
  // until the resync on return.
  fs.appendFileSync(file, [
    { type: 'user', message: { content: '在 IDE 里继续问了点东西' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: '这是在 IDE 里的回复' }] } },
  ].map(l => JSON.stringify(l)).join('\n') + '\n');

  const lease2 = await cloud.api('POST', `/api/tasks/${taskId}/lease`, { lease: 'daemon' });
  assert.equal(lease2.status, 200);

  await until(async () => {
    const m = await cloud.api('GET', `/api/tasks/${taskId}/messages`, {});
    return m.body.messages.some(x => x.role === 'assistant' && x.content.text === '这是在 IDE 里的回复');
  }, 5000, 'IDE message synced back');

  const msgs = await cloud.api('GET', `/api/tasks/${taskId}/messages`, {});
  const assistantTexts = msgs.body.messages.filter(m => m.role === 'assistant').map(m => m.content.text);
  assert.deepEqual(assistantTexts.filter(t => t === '我先做了一些工作').length, 1, 'AgentHub-driven content not duplicated');
  assert.ok(assistantTexts.includes('这是在 IDE 里的回复'), 'IDE-driven content present');
  assert.ok(msgs.body.messages.some(m => m.role === 'user' && m.content.text === '在 IDE 里继续问了点东西'));

  exec.manager.shutdown();
  exec.link.stop();
});

test('M2: offline events replay exactly once; duplicates are absorbed idempotently', async () => {
  const cloud = makeCloud();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac2', await sha256Hex('tok-mac2'), 'user-test', Date.now()).run();

  const exec = makeExecutor(cloud, 'mac2', async (session, opts) => {
    opts.onMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'online part' }] } });
    session.busy = false;
  });
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');

  const res = await cloud.api('POST', '/api/tasks', { title: '断网任务', spec: 'x', nodeId: 'mac2' });
  const taskId = res.body.task.id;
  await until(async () => {
    const m = await cloud.api('GET', `/api/tasks/${taskId}/messages`, {});
    return m.body.messages.length >= 2; // user + assistant
  }, 5000, 'initial messages');

  // drop the link; emit events while offline
  exec.link.backoff = 30;             // fast reconnect for the test
  cloud.dropNode('mac2');
  await until(() => !exec.link.connected, 2000, 'disconnected');
  exec.manager.emit(taskId, { k: 'msg', role: 'system', content: { text: 'offline-1' } });
  exec.manager.emit(taskId, { k: 'msg', role: 'system', content: { text: 'offline-2' } });
  exec.manager.setStatus(taskId, 'review');

  const before = await cloud.api('GET', `/api/tasks/${taskId}/messages`, {});
  assert.ok(!before.body.messages.some(m => m.content?.text === 'offline-1'), 'offline events not yet at cloud');

  // reconnect -> hello -> replay
  await until(() => exec.link.connected, 5000, 'reconnected');
  await until(async () => {
    const m = await cloud.api('GET', `/api/tasks/${taskId}/messages`, {});
    return m.body.messages.filter(x => ['offline-1', 'offline-2'].includes(x.content?.text)).length === 2;
  }, 5000, 'offline events replayed');
  assert.equal((await core.getTask(cloud.ctx, taskId)).status, 'review');

  // force a second reconnect: replay again must not duplicate anything
  cloud.dropNode('mac2');
  await until(() => !exec.link.connected, 2000, 'disconnected 2');
  await until(() => exec.link.connected, 5000, 'reconnected 2');
  await cloud.flush();
  await sleep(100);
  const after = await cloud.api('GET', `/api/tasks/${taskId}/messages`, {});
  const count1 = after.body.messages.filter(x => x.content?.text === 'offline-1').length;
  assert.equal(count1, 1, 'no duplicates after double replay');
  const seqs = after.body.messages.map(m => m.seq);
  assert.equal(new Set(seqs).size, seqs.length, 'unique seqs');

  exec.manager.shutdown();
  exec.link.stop();
});

test('config push: hello_ok delivers relay credentials; setting a model profile as default live-pushes to a connected node', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare(
    `INSERT INTO users (id, username, password_hash, api_base_url, api_key, api_model, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind('user-test', 'alice', 'x', 'https://relay.example/v1', 'sk-initial', 'gpt-5.6', now).run();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-cfg', await sha256Hex('tok-mac-cfg'), 'user-test', now).run();

  const exec = makeExecutor(cloud, 'mac-cfg', async () => {});
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');

  // hello_ok embeds the owner's current relay credentials
  await until(() => exec.manager.config.provider.baseUrl === 'https://relay.example/v1', 2000, 'hello_ok config applied');
  assert.equal(exec.manager.config.provider.apiKey, 'sk-initial');

  // Creating this account's first-ever profile auto-marks it default and
  // pushes fresh credentials to already-connected nodes immediately.
  const create = await cloud.api('POST', '/api/model-profiles',
    { name: '新配置', baseUrl: 'https://relay2.example/v1', apiKey: 'sk-updated', model: 'gpt-6' });
  assert.equal(create.status, 200);
  assert.equal(create.body.profile.isDefault, true);
  await until(() => exec.manager.config.provider.apiKey === 'sk-updated', 2000, 'live config push applied');
  assert.equal(exec.manager.config.provider.baseUrl, 'https://relay2.example/v1');
  assert.equal(exec.manager.config.provider.model, 'gpt-6');

  // A second profile is NOT auto-default; explicitly setting it as default
  // pushes its credentials live too.
  const create2 = await cloud.api('POST', '/api/model-profiles',
    { name: '第三方', baseUrl: 'https://relay3.example/v1', apiKey: 'sk-third', model: 'gpt-7' });
  assert.equal(create2.body.profile.isDefault, false);
  const setDefault = await cloud.api('POST', `/api/model-profiles/${create2.body.profile.id}/set-default`, {});
  assert.equal(setDefault.status, 200);
  await until(() => exec.manager.config.provider.apiKey === 'sk-third', 2000, 'second live config push applied');
  assert.equal(exec.manager.config.provider.baseUrl, 'https://relay3.example/v1');

  exec.manager.shutdown();
  exec.link.stop();
});

test('executor protocol compatibility: a v2 checkout still accepts v1 cloud relay fields', async () => {
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-v1-wire-'));
  const db = new LocalDb(workRoot);
  db.upsertTask({ taskId: 'existing', title: 'existing', spec: '', status: 'review' });
  const commands = [];
  let socket;
  const link = new CloudLink(
    { cloudUrl: 'wss://fake', nodeId: 'mac-v1-wire', nodeToken: 'tok', provider: { baseUrl: '', apiKey: '' } },
    db,
    cmd => commands.push(cmd),
    () => {
      socket = { send() {}, close() {} };
      setTimeout(() => socket.onopen?.(), 0);
      return socket;
    },
  );
  link.start();
  await until(() => link.connected, 1000, 'legacy-wire test link');

  socket.onmessage({ data: JSON.stringify({
    t: 'hello_ok',
    anthropic: { baseUrl: 'https://legacy-relay/v1', apiKey: 'sk-legacy', model: 'claude-opus-5' },
    tasks: [{ taskId: 'existing', lastSeq: 0, anthropicOverride: { baseUrl: 'https://pinned/v1', apiKey: 'sk-pinned', model: 'pinned' } }],
  }) });
  assert.deepEqual(commands.find(x => x.t === 'config')?.provider,
    { baseUrl: 'https://legacy-relay/v1', apiKey: 'sk-legacy', model: 'claude-opus-5' });
  assert.deepEqual(commands.find(x => x.t === 'set_provider_override')?.provider,
    { baseUrl: 'https://pinned/v1', apiKey: 'sk-pinned', model: 'pinned' });

  const config = { provider: { baseUrl: '', apiKey: '' }, maxParallel: 1, workRoot };
  const manager = new SessionManager(config, db, () => {}, makeFakeSessionFactory(async () => {}));
  manager.handleCommand({ t: 'config', anthropic: { baseUrl: 'https://live-v1/v1', apiKey: 'sk-live' } });
  assert.deepEqual(config.provider, { baseUrl: 'https://live-v1/v1', apiKey: 'sk-live' });
  manager.startTask({ id: 'legacy-start', title: 'legacy', spec: '', anthropic: { baseUrl: 'https://task-v1/v1', apiKey: 'sk-task' } });
  assert.deepEqual(JSON.parse(db.getTask('legacy-start').provider_override),
    { baseUrl: 'https://task-v1/v1', apiKey: 'sk-task' });

  manager.shutdown();
  link.stop();
});

test('switch-model: pins an ongoing task to a profile (next spawn uses it), reverts to default, and self-heals via hello_ok', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare(
    `INSERT INTO users (id, username, password_hash, api_base_url, api_key, api_model, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind('user-test', 'alice', 'x', 'https://relay.example/v1', 'sk-default', 'model-default', now).run();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-swmodel', await sha256Hex('tok-mac-swmodel'), 'user-test', now).run();
  await cloud.db.prepare(
    'INSERT INTO model_profiles (id, owner_user_id, name, base_url, api_key, model, is_default, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)',
  ).bind('prof-1', 'user-test', '备用模型', 'https://relay2.example/v1', 'sk-alt', 'model-alt', now).run();

  const modelsSeen = [];
  const exec = makeExecutor(cloud, 'mac-swmodel', async (session, opts) => {
    await sleep(5);
    opts.onMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } });
    opts.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 10, num_turns: 1, is_error: false });
    session.busy = false;
  });
  // Wrap the session factory to record which provider config each spawn got.
  const origFactory = exec.manager.sessionFactory;
  exec.manager.sessionFactory = (opts) => { modelsSeen.push(opts.config.provider.model); return origFactory(opts); };
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');

  const res = await cloud.api('POST', '/api/tasks', { title: 't', spec: '第一轮', nodeId: 'mac-swmodel' });
  const taskId = res.body.task.id;
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'review', 3000, 'review turn 1');
  assert.deepEqual(modelsSeen, ['model-default'], 'first spawn used the node-shared default');

  // Switch to the profile — cloud records the pin, executor stores the
  // override, and the *next* spawn uses it.
  const sw = await cloud.api('POST', `/api/tasks/${taskId}/switch-model`, { modelProfileId: 'prof-1' });
  assert.equal(sw.status, 200);
  assert.equal((await core.getTask(cloud.ctx, taskId)).model_profile_id, 'prof-1');
  await until(() => JSON.parse(exec.db.getTask(taskId).provider_override || 'null')?.model === 'model-alt', 3000, 'override stored locally');

  await cloud.api('POST', `/api/tasks/${taskId}/message`, { text: '第二轮' });
  await until(() => modelsSeen.length >= 2, 3000, 'second spawn happened');
  assert.equal(modelsSeen[1], 'model-alt', 'next spawn after the switch uses the pinned profile');

  // An unknown profile id is rejected outright.
  const bad = await cloud.api('POST', `/api/tasks/${taskId}/switch-model`, { modelProfileId: 'nonexistent' });
  assert.equal(bad.status, 404);

  // Revert to default — cloud stores '' (explicit default, distinct from
  // legacy NULL), executor override clears, next spawn back on default.
  const rev = await cloud.api('POST', `/api/tasks/${taskId}/switch-model`, {});
  assert.equal(rev.status, 200);
  assert.equal((await core.getTask(cloud.ctx, taskId)).model_profile_id, '');
  await until(() => exec.db.getTask(taskId).provider_override === null, 3000, 'override cleared locally');

  // Self-heal: simulate local drift (override reappears locally while cloud
  // says explicit-default), reconnect, hello_ok re-asserts cloud's stance.
  exec.db.patchTask(taskId, { providerOverride: JSON.stringify({ baseUrl: 'x', apiKey: 'y', model: 'stale' }) });
  exec.link.backoff = 30;
  cloud.dropNode('mac-swmodel');
  await until(() => !exec.link.connected, 2000, 'disconnected');
  await until(() => exec.link.connected, 5000, 'reconnected');
  await until(() => exec.db.getTask(taskId).provider_override === null, 3000, 'hello_ok healed the drift back to explicit default');

  exec.manager.shutdown();
  exec.link.stop();
});

test('config push: task fails cleanly (no crash) when a node has no relay credentials yet', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  // No users row at all for this node's owner -> getAnthropicConfig() returns null.
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-nocfg', await sha256Hex('tok-mac-nocfg'), 'user-test', now).run();

  const exec = makeExecutor(cloud, 'mac-nocfg', async () => {});
  exec.manager.config.provider = { baseUrl: '', apiKey: '' }; // simulate a fresh install with no local fallback either
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');

  const res = await cloud.api('POST', '/api/tasks', { title: '无配置任务', spec: 'x', nodeId: 'mac-nocfg' });
  const taskId = res.body.task.id;
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'failed', 5000, 'failed without credentials');
  const t = await core.getTask(cloud.ctx, taskId);
  assert.match(t.last_error, /设置/);

  exec.manager.shutdown();
  exec.link.stop();
});

test('M3: heartbeat timeout marks node offline and tasks unknown; hello reconciles (local wins)', async () => {
  const cloud = makeCloud();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac3', await sha256Hex('tok-mac3'), 'user-test', Date.now()).run();

  const exec = makeExecutor(cloud, 'mac3', async (session, opts) => {
    opts.onMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'working...' }] } });
    // never finishes -> stays running
  });
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');

  const res = await cloud.api('POST', '/api/tasks', { title: '心跳任务', spec: 'x', nodeId: 'mac3' });
  const taskId = res.body.task.id;
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'running', 5000, 'running');

  // silently stop heartbeats and advance the clock past the timeout
  exec.link.stop();
  cloud.setNow(Date.now() + 120_000);
  await core.checkHeartbeats(cloud.ctx, 60_000);
  // exec.link.stop() closes the fake socket, whose close handler calls
  // markNodeOffline() independently of (and unawaited relative to) the
  // explicit checkHeartbeats() call right above — mirroring production,
  // where a real socket close and the periodic alarm are two uncoordinated
  // paths that can both race to mark the same node offline. Whichever wins
  // does the real work asynchronously in the background, so poll for
  // convergence here rather than asserting immediately after just one of
  // those two paths' own promise resolves.
  await until(async () => (await cloud.db.prepare('SELECT status FROM nodes WHERE id = ?').bind('mac3').first())?.status === 'offline', 2000, 'node offline');
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'unknown', 2000, 'task unknown');
  await until(() => cloud.pushes.some(p => p.title.includes('节点失联')), 2000, 'push sent');
  cloud.setNow(null);

  // node comes back: executor still believes running -> cloud must adopt it
  exec.link.backoff = 30;
  exec.link.start();
  await until(() => exec.link.connected, 3000, 'reconnected');
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'running', 5000, 'reconciled to running');

  exec.manager.shutdown();
  exec.link.stop();
});

test('settings: defaultRepoUrl round-trips through GET/POST /api/settings', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .bind('user-test', 'alice', 'x', now).run();

  const empty = await cloud.api('GET', '/api/settings', {});
  assert.equal(empty.body.defaultRepoUrl, '');

  const save = await cloud.api('POST', '/api/settings', {
    baseUrl: 'https://relay.example/v1', apiKey: 'sk-x', model: 'gpt-5.6',
    defaultRepoUrl: 'git@github.com:me/repo.git',
  });
  assert.equal(save.status, 200);

  const after = await cloud.api('GET', '/api/settings', {});
  assert.equal(after.body.defaultRepoUrl, 'git@github.com:me/repo.git');
});

test('recent-repos: creating tasks with a repoUrl populates history, newest first, no duplicates', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-recent', await sha256Hex('tok-mac-recent'), 'user-test', now).run();

  const zero = await cloud.api('GET', '/api/recent-repos', {});
  assert.deepEqual(zero.body.repos, []);

  cloud.setNow(now);
  await cloud.api('POST', '/api/tasks', { title: 't1', spec: 'x', nodeId: 'mac-recent', repoUrl: 'repo-a' });

  cloud.setNow(now + 1000);
  await cloud.api('POST', '/api/tasks', { title: 't2', spec: 'x', nodeId: 'mac-recent', repoUrl: 'repo-b' });

  let recents = await cloud.api('GET', '/api/recent-repos', {});
  assert.deepEqual(recents.body.repos, ['repo-b', 'repo-a'], 'newest repo first');

  // re-using repo-a bumps it to the front without duplicating the row
  cloud.setNow(now + 2000);
  await cloud.api('POST', '/api/tasks', { title: 't3', spec: 'x', nodeId: 'mac-recent', repoUrl: 'repo-a' });
  recents = await cloud.api('GET', '/api/recent-repos', {});
  assert.deepEqual(recents.body.repos, ['repo-a', 'repo-b'], 'repo-a bumped to front, still only 2 entries');

  // a task created with no repoUrl must not add a blank entry
  await cloud.api('POST', '/api/tasks', { title: 't4', spec: 'x', nodeId: 'mac-recent' });
  recents = await cloud.api('GET', '/api/recent-repos', {});
  assert.equal(recents.body.repos.length, 2);

  cloud.setNow(null);
});

test('recent-repos: `top` is the most-used path in the current scope, per project', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO teams (id, name, created_at) VALUES (?, ?, ?)')
    .bind('team-repos', '量化', now).run();
  await cloud.db.prepare('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
    .bind('team-repos', 'user-test', 'owner', now).run();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-top', await sha256Hex('tok-mac-top'), 'user-test', now).run();
  await cloud.db.prepare('INSERT INTO node_teams (node_id, team_id) VALUES (?, ?)').bind('mac-top', 'team-repos').run();
  const teamCtx = { ...cloud.ctx, teamId: 'team-repos' };

  // personal: /personal used twice, /solo once
  for (const repoUrl of ['/personal', '/solo', '/personal']) {
    await cloud.api('POST', '/api/tasks', { title: 't', spec: 'x', nodeId: 'mac-top', repoUrl });
  }
  // project: /quant used twice, /scratch once — and /personal not at all,
  // even though it's the account's most recent overall.
  for (const repoUrl of ['/scratch', '/quant', '/quant']) {
    const r = await core.api(teamCtx, 'POST', '/api/tasks', { title: 't', spec: 'x', nodeId: 'mac-top', repoUrl });
    assert.equal(r.status, 200);
  }

  const team = await core.api(teamCtx, 'GET', '/api/recent-repos', {});
  assert.equal(team.body.top, '/quant', '项目视角下默认填该项目里用得最多的路径');
  assert.deepEqual(team.body.repos.slice(0, 2), ['/quant', '/scratch'], '项目内路径排在前面,按使用次数');
  assert.ok(team.body.repos.includes('/personal'), '账号级历史仍然可选');

  const personal = await core.api({ ...cloud.ctx }, 'GET', '/api/recent-repos', {});
  assert.equal(personal.body.top, '/personal', '个人视角不受项目内路径影响');
});

test('model-profiles: CRUD + ownership isolation', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .bind('user-test', 'alice', 'x', now).run();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .bind('user-other', 'bob', 'x', now).run();

  const empty = await cloud.api('GET', '/api/model-profiles', {});
  assert.deepEqual(empty.body.profiles, []);

  const bad = await cloud.api('POST', '/api/model-profiles', { name: 'incomplete' });
  assert.equal(bad.status, 400);

  const create = await cloud.api('POST', '/api/model-profiles',
    { name: 'Claude 官方', baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant-x', model: 'claude-opus-5' });
  assert.equal(create.status, 200);
  const profileId = create.body.profile.id;

  const list = await cloud.api('GET', '/api/model-profiles', {});
  assert.equal(list.body.profiles.length, 1);
  assert.equal(list.body.profiles[0].name, 'Claude 官方');

  const otherCtx = { ...cloud.ctx, userId: 'user-other' };
  const deniedDelete = await core.api(otherCtx, 'DELETE', `/api/model-profiles/${profileId}`, {});
  assert.equal(deniedDelete.status, 404);
  const deniedList = await core.api(otherCtx, 'GET', '/api/model-profiles', {});
  assert.deepEqual(deniedList.body.profiles, [], "another user can't see this user's profiles");

  const del = await cloud.api('DELETE', `/api/model-profiles/${profileId}`, {});
  assert.equal(del.status, 200);
  const after = await cloud.api('GET', '/api/model-profiles', {});
  assert.deepEqual(after.body.profiles, []);
});

test('model-profiles: editing updates in place; editing the default re-mirrors and pushes to nodes', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .bind('user-test', 'alice', 'x', now).run();

  const first = await cloud.api('POST', '/api/model-profiles',
    { name: '默认站', baseUrl: 'https://relay-a.example', apiKey: 'key-a', model: 'model-a' });
  const defaultId = first.body.profile.id;
  assert.equal(first.body.profile.isDefault, true);
  const second = await cloud.api('POST', '/api/model-profiles',
    { name: '备用站', baseUrl: 'https://relay-b.example', apiKey: 'key-b', model: 'model-b' });
  const otherId = second.body.profile.id;

  const badEdit = await cloud.api('PUT', `/api/model-profiles/${otherId}`, { name: 'no-key' });
  assert.equal(badEdit.status, 400);
  const missingEdit = await cloud.api('PUT', '/api/model-profiles/does-not-exist',
    { name: 'x', baseUrl: 'https://x.example', apiKey: 'k' });
  assert.equal(missingEdit.status, 404);
  const otherCtx = { ...cloud.ctx, userId: 'user-other' };
  const deniedEdit = await core.api(otherCtx, 'PUT', `/api/model-profiles/${otherId}`,
    { name: 'hijack', baseUrl: 'https://x.example', apiKey: 'k' });
  assert.equal(deniedEdit.status, 404, "another user can't edit this user's profile");

  // Editing a non-default profile never touches the mirrored node credentials.
  const editOther = await cloud.api('PUT', `/api/model-profiles/${otherId}`,
    { name: '备用站-改', baseUrl: 'https://relay-b2.example', apiKey: 'key-b2', model: 'model-b2' });
  assert.equal(editOther.status, 200);
  let u = await cloud.db.prepare('SELECT api_base_url, api_key, api_model FROM users WHERE id = ?').bind('user-test').first();
  assert.equal(u.api_base_url, 'https://relay-a.example');

  // Editing the default profile updates the row AND the mirrored copy nodes read.
  const editDefault = await cloud.api('PUT', `/api/model-profiles/${defaultId}`,
    { name: '默认站-新', baseUrl: 'https://relay-a2.example', apiKey: 'key-a2', model: 'model-a2' });
  assert.equal(editDefault.status, 200);
  assert.equal(editDefault.body.profile.isDefault, true);
  const list = await cloud.api('GET', '/api/model-profiles', {});
  const updated = list.body.profiles.find(p => p.id === defaultId);
  assert.equal(updated.name, '默认站-新');
  assert.equal(updated.baseUrl, 'https://relay-a2.example');
  assert.equal(updated.isDefault, true);
  u = await cloud.db.prepare('SELECT api_base_url, api_key, api_model FROM users WHERE id = ?').bind('user-test').first();
  assert.equal(u.api_base_url, 'https://relay-a2.example');
  assert.equal(u.api_key, 'key-a2');
  assert.equal(u.api_model, 'model-a2');
});

test('tasks: modelProfileId pins the dispatched start_task to that profile; unknown id 404s', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-profile', await sha256Hex('tok-mac-profile'), 'user-test', now).run();

  const create = await cloud.api('POST', '/api/model-profiles',
    { name: 'Claude', baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant-x', model: 'claude-opus-5' });
  const profileId = create.body.profile.id;

  let dispatched = null;
  const origSendToNode = cloud.ctx.sendToNode;
  cloud.ctx.sendToNode = (nodeId, msg) => { if (msg.t === 'start_task') dispatched = msg; return origSendToNode(nodeId, msg); };
  try {
    const res = await cloud.api('POST', '/api/tasks', { title: 't', spec: 'x', nodeId: 'mac-profile', modelProfileId: profileId });
    assert.equal(res.status, 200);
    assert.ok(dispatched);
    assert.deepEqual(dispatched.task.provider, { baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant-x', model: 'claude-opus-5' });

    dispatched = null;
    const plain = await cloud.api('POST', '/api/tasks', { title: 't2', spec: 'x', nodeId: 'mac-profile' });
    assert.equal(plain.status, 200);
    assert.equal('provider' in dispatched.task, false, 'no modelProfileId -> no provider override, unchanged from before');

    const bad = await cloud.api('POST', '/api/tasks', { title: 't3', spec: 'x', nodeId: 'mac-profile', modelProfileId: 'nope' });
    assert.equal(bad.status, 404);
  } finally {
    cloud.ctx.sendToNode = origSendToNode;
  }
});

test('per-task model override: full round trip spawns fine even when the node has no default config', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-override', await sha256Hex('tok-mac-override'), 'user-test', now).run();

  const profile = await cloud.api('POST', '/api/model-profiles',
    { name: 'Claude', baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant-override', model: 'claude-opus-5' });
  const profileId = profile.body.profile.id;

  let sawConfig = null;
  const exec = makeExecutor(cloud, 'mac-override', async (session, opts) => {
    sawConfig = opts.config.provider;
    await sleep(10); // let _spawn()'s own setStatus('running') land before the result event does
    opts.onMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } });
    opts.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 100, num_turns: 1, is_error: false });
    session.busy = false;
  });
  exec.manager.config.provider = { baseUrl: '', apiKey: '' }; // node has no default config at all
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');

  const res = await cloud.api('POST', '/api/tasks', {
    title: 'override 任务', spec: 'x', nodeId: 'mac-override', modelProfileId: profileId,
  });
  const taskId = res.body.task.id;

  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'review', 5000, 'review despite no node default');
  assert.deepEqual(sawConfig, { baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant-override', model: 'claude-opus-5' });

  exec.manager.shutdown();
  exec.link.stop();
});

test('layout: round-trips an ordered pane list, scoped per personal/project view', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .bind('user-test', 'alice', 'x', now).run();
  await cloud.db.prepare('INSERT INTO teams (id, name, created_at) VALUES (?, ?, ?)').bind('team-1', 'Alpha', now).run();
  await cloud.db.prepare('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
    .bind('team-1', 'user-test', 'owner', now).run();

  const empty = await cloud.api('GET', '/api/layout', {});
  assert.deepEqual(empty.body.layout, {});

  // save a personal layout, then a completely independent project layout —
  // the two must never clobber each other (this is the whole point: a
  // conversation opened in "个人" must survive round-tripping through a
  // project view and back untouched).
  const savePersonal = await cloud.api('POST', '/api/layout', { panes: ['t1', 't2', 't3'] });
  assert.equal(savePersonal.status, 200);
  const saveTeam = await core.api({ ...cloud.ctx, teamId: 'team-1' }, 'POST', '/api/layout', { panes: ['t4'] });
  assert.equal(saveTeam.status, 200);

  const afterPersonal = await cloud.api('GET', '/api/layout', {});
  assert.deepEqual(afterPersonal.body.layout.personal, ['t1', 't2', 't3']);
  assert.deepEqual(afterPersonal.body.layout['team-1'], ['t4'], 'GET returns every scope regardless of which is currently active');

  // re-saving the project scope must not touch the personal one.
  await core.api({ ...cloud.ctx, teamId: 'team-1' }, 'POST', '/api/layout', { panes: ['t4', 't5'] });
  const finalState = await cloud.api('GET', '/api/layout', {});
  assert.deepEqual(finalState.body.layout.personal, ['t1', 't2', 't3']);
  assert.deepEqual(finalState.body.layout['team-1'], ['t4', 't5']);
});

test('layout: atomic scope update preserves a sibling write made after its request starts', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, open_panes, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind('user-test', 'alice', 'x', JSON.stringify({ personal: ['old-personal'], 'team-1': ['old-team'] }), now).run();

  // Simulate a sibling scope update racing immediately before the route's
  // UPDATE executes. The old SELECT + full-object UPDATE implementation read
  // first, then this hook changed personal, then it overwrote the entire JSON
  // with its stale snapshot — losing `new-personal`. Atomic json_set never
  // reads a JS snapshot and therefore preserves the sibling key.
  const originalPrepare = cloud.db.prepare.bind(cloud.db);
  let injected = false;
  cloud.db.prepare = (sql) => {
    if (!injected && /^UPDATE users SET open_panes = json_set/.test(sql)) {
      injected = true;
      return {
        bind(...args) {
          const statement = originalPrepare(sql).bind(...args);
          return {
            async run() {
              await originalPrepare('UPDATE users SET open_panes = ? WHERE id = ?')
                .bind(JSON.stringify({ personal: ['new-personal'], 'team-1': ['old-team'] }), 'user-test').run();
              return statement.run();
            },
          };
        },
      };
    }
    return originalPrepare(sql);
  };

  const saved = await core.api({ ...cloud.ctx, teamId: 'team-1' }, 'POST', '/api/layout', { panes: ['new-team'] });
  assert.equal(saved.status, 200);
  const row = await originalPrepare('SELECT open_panes FROM users WHERE id = ?').bind('user-test').first();
  assert.deepEqual(JSON.parse(row.open_panes), { personal: ['new-personal'], 'team-1': ['new-team'] });
});

// The DO-level promise-correlation in hub.mjs's browseNode() (WebSocketPair,
// Durable Object storage) isn't reachable from plain node --test — same as
// every other piece of hub.mjs, which is deliberately kept as thin
// infrastructure binding around the tested hub-core.mjs logic (see hub.mjs's
// own file header). This covers hub-core.mjs's route: ownership check and
// wiring to ctx.browseNode.
test('nodes browse: ownership-checked route wired to ctx.browseNode', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-browse', await sha256Hex('tok-mac-browse'), 'user-test', now).run();

  let calledWith = null;
  cloud.ctx.browseNode = async (nodeId, path) => { calledWith = { nodeId, path }; return { entries: ['/home'] }; };
  const res = await cloud.api('GET', '/api/nodes/mac-browse/browse', { path: '/ho' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.entries, ['/home']);
  assert.deepEqual(calledWith, { nodeId: 'mac-browse', path: '/ho' });

  const other = await core.api({ ...cloud.ctx, userId: 'someone-else' }, 'GET', '/api/nodes/mac-browse/browse', { path: '/ho' });
  assert.equal(other.status, 404);

  // timeout/offline node -> empty suggestions, not an error
  cloud.ctx.browseNode = async () => null;
  const timedOut = await cloud.api('GET', '/api/nodes/mac-browse/browse', { path: '/x' });
  assert.equal(timedOut.status, 200);
  assert.deepEqual(timedOut.body.entries, []);
});

test('fetch-models: parses OpenAI-style /v1/models response; surfaces relay errors as 502 not 500', async () => {
  const cloud = makeCloud();
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(url, 'https://relay.example/v1/models');
      assert.equal(init.headers.authorization, 'Bearer sk-x');
      return new Response(JSON.stringify({ data: [{ id: 'gpt-5.6' }, { id: 'claude-opus-5' }] }), { status: 200 });
    };
    const res = await cloud.api('POST', '/api/fetch-models', { baseUrl: 'https://relay.example', apiKey: 'sk-x' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.models, ['gpt-5.6', 'claude-opus-5']);

    globalThis.fetch = async () => new Response('', { status: 500 });
    const bad = await cloud.api('POST', '/api/fetch-models', { baseUrl: 'https://relay.example', apiKey: 'sk-x' });
    assert.equal(bad.status, 502);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('nodes sessions: ownership-checked route wired to ctx.listSessions', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-sessions', await sha256Hex('tok-mac-sessions'), 'user-test', now).run();

  let calledWith = null;
  cloud.ctx.listSessions = async (nodeId, path) => {
    calledWith = { nodeId, path };
    return { sessions: [{ sessionId: 'abc', preview: 'hello', mtime: now }] };
  };
  const res = await cloud.api('GET', '/api/nodes/mac-sessions/sessions', { path: '/data2/x' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.sessions, [{ sessionId: 'abc', preview: 'hello', mtime: now }]);
  assert.deepEqual(calledWith, { nodeId: 'mac-sessions', path: '/data2/x' });

  const other = await core.api({ ...cloud.ctx, userId: 'someone-else' }, 'GET', '/api/nodes/mac-sessions/sessions', { path: '/data2/x' });
  assert.equal(other.status, 404);

  cloud.ctx.listSessions = async () => null;
  const timedOut = await cloud.api('GET', '/api/nodes/mac-sessions/sessions', { path: '/x' });
  assert.equal(timedOut.status, 200);
  assert.deepEqual(timedOut.body.sessions, []);
});

test('conversation sources: derives project roots, hides represented sessions, activation is idempotent', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .bind('user-test', 'alice', 'x', now).run();
  await cloud.db.prepare('INSERT INTO teams (id, name, created_at) VALUES (?, ?, ?)').bind('team-1', 'Alpha', now).run();
  await cloud.db.prepare('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
    .bind('team-1', 'user-test', 'owner', now).run();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('node-a', 'hash', 'user-test', now).run();
  await cloud.db.prepare('INSERT INTO node_teams (node_id, team_id) VALUES (?, ?)').bind('node-a', 'team-1').run();
  await cloud.db.prepare(`INSERT INTO tasks (id,title,spec,repo_url,node_id,owner_user_id,team_id,status,session_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,'review',?,?,?)`)
    .bind('existing-a', 'A', 'x', '/data/a', 'node-a', 'user-test', 'team-1', 'already-used', now, now).run();
  await cloud.db.prepare('INSERT INTO task_teams (task_id, team_id) VALUES (?, ?)').bind('existing-a', 'team-1').run();
  await cloud.db.prepare(`INSERT INTO tasks (id,title,spec,repo_url,node_id,owner_user_id,team_id,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,'review',?,?)`)
    .bind('existing-b', 'B', 'x', '/data/b', 'node-a', 'user-test', 'team-1', now, now).run();
  await cloud.db.prepare('INSERT INTO task_teams (task_id, team_id) VALUES (?, ?)').bind('existing-b', 'team-1').run();

  const calls = [];
  cloud.ctx.listProjectSessions = async (nodeId, paths) => {
    calls.push({ nodeId, paths: [...paths].sort() });
    return { sessions: [
      { sessionId: 'already-used', cwd: '/data/a', preview: 'represented', mtime: now + 30 },
      { sessionId: 'fresh-one', cwd: '/data/a', preview: '灰色历史对话', mtime: now + 20 },
      { sessionId: 'fresh-two', cwd: '/data/b', preview: '第二个历史', mtime: now + 10 },
    ] };
  };
  const teamCtx = { ...cloud.ctx, teamId: 'team-1' };
  const list = await core.api(teamCtx, 'GET', '/api/conversation-sources', {});
  assert.equal(list.status, 200);
  assert.deepEqual(calls[0], { nodeId: 'node-a', paths: ['/data/a', '/data/b'] });
  assert.deepEqual(list.body.sources.map(source => source.preview), ['灰色历史对话', '第二个历史']);
  assert.ok(list.body.sources.every(source => !('sessionId' in source)), 'raw Claude session ids stay server-side');

  let dispatchCount = 0;
  const originalSend = teamCtx.sendToNode;
  teamCtx.sendToNode = (nodeId, message) => { if (message.t === 'start_task') dispatchCount++; return originalSend(nodeId, message); };
  const sourceId = list.body.sources[0].id;
  let historyRead = null;
  teamCtx.readProjectSession = async (nodeId, sessionId, cwd, options) => {
    historyRead = { nodeId, sessionId, cwd, options };
    return options?.before == null ? {
      events: [
        { role: 'user', content: { text: '最新提问' } },
        { role: 'assistant', content: { text: '最新回答' } },
      ], hasMore: true, nextBefore: 100, nextBoundaryHash: 'boundary-100', fileSize: 1000, fileMtime: 12345,
    } : {
      events: [
        { role: 'user', content: { text: '更早提问' } },
        { role: 'assistant', content: { text: '更早回答' } },
      ], hasMore: false, nextBefore: null,
    };
  };
  const beforeHistoryTasks = (await cloud.db.prepare('SELECT COUNT(*) AS n FROM tasks').bind().first()).n;
  const history = await core.api(teamCtx, 'GET', `/api/conversation-sources/${sourceId}/history`, {});
  assert.equal(history.status, 200);
  assert.equal(calls.length, 1, 'history uses the 10-minute source cache instead of rescanning project directories');
  assert.deepEqual(historyRead, { nodeId: 'node-a', sessionId: 'fresh-one', cwd: '/data/a', options: { before: null, boundaryHash: null, fileSize: null, fileMtime: null, turns: 1, includeTools: false } });
  assert.deepEqual(history.body.messages.map(message => [message.seq, message.role, message.content.text]), [
    [1, 'user', '最新提问'], [2, 'assistant', '最新回答'],
  ]);
  assert.equal(history.body.hasMore, true);
  assert.match(history.body.nextCursor, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  const details = await core.api(teamCtx, 'GET', `/api/conversation-sources/${sourceId}/history`, { details: '1' });
  assert.equal(details.status, 200);
  assert.equal(historyRead.options.includeTools, true);
  const older = await core.api(teamCtx, 'GET', `/api/conversation-sources/${sourceId}/history`, { cursor: history.body.nextCursor });
  assert.equal(older.status, 200);
  assert.deepEqual(historyRead.options, { before: 100, boundaryHash: 'boundary-100', fileSize: 1000, fileMtime: 12345, turns: 10, includeTools: true });
  assert.deepEqual(older.body.messages.map(message => message.content.text), ['更早提问', '更早回答']);
  assert.equal(older.body.hasMore, false);
  assert.equal(older.body.nextCursor, null);
  const replayed = await core.api(teamCtx, 'GET', `/api/conversation-sources/${sourceId}/history`, { cursor: history.body.nextCursor });
  assert.equal(replayed.status, 400, 'opaque history cursors are single-use');
  assert.equal((await cloud.db.prepare('SELECT COUNT(*) AS n FROM tasks').bind().first()).n, beforeHistoryTasks, 'reading history creates no task');
  assert.equal((await cloud.db.prepare('SELECT COUNT(*) AS n FROM conversation_claims_v2').bind().first()).n, 0, 'reading history creates no claim');

  const first = await core.api(teamCtx, 'POST', `/api/conversation-sources/${sourceId}/activate`, { text: '继续分析' });
  const second = await core.api(teamCtx, 'POST', `/api/conversation-sources/${sourceId}/activate`, { text: '重复发送' });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(first.body.task.id, second.body.task.id);
  const claimedHistory = await core.api(teamCtx, 'GET', `/api/conversation-sources/${sourceId}/history`, {});
  assert.equal(claimedHistory.status, 409, 'claimed source cache cannot keep exposing history outside task authorization');
  assert.equal(first.body.task.session_id, 'fresh-one');
  assert.equal(first.body.task.repo_url, '/data/a');
  assert.deepEqual(first.body.task.teamIds, ['team-1']);
  assert.equal(second.body.reused, true);
  assert.equal(dispatchCount, 1);
  assert.equal((await cloud.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE id = ?').bind(first.body.task.id).first()).n, 1);
  assert.equal((await cloud.db.prepare('SELECT task_id FROM conversation_claims_v2 WHERE node_id = ? AND session_id = ?').bind('node-a', 'fresh-one').first()).task_id, first.body.task.id);
  assert.equal((await cloud.db.prepare('SELECT COUNT(*) AS n FROM durable_cmds WHERE command_key = ?').bind(`start:${first.body.task.id}`).first()).n, 1);
  const forbiddenSwitch = await core.api(teamCtx, 'POST', `/api/tasks/${first.body.task.id}/switch-session`, { sessionId: 'fresh-two' });
  assert.equal(forbiddenSwitch.status, 409);
});

test('durable start command: executor acks only after local task persistence and cloud removes outbox row', async () => {
  const cloud = makeCloud();
  const nodeId = 'durable-node';
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO nodes (id,token_hash,owner_user_id,created_at) VALUES (?,?,?,?)').bind(nodeId, 'h', 'user-test', now).run();
  const exec = makeExecutor(cloud, nodeId, async () => {});
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'durable executor connected');
  const commandKey = 'start:DURABLETASK';
  const payload = { t: 'start_task', task: { id: 'DURABLETASK', title: 'durable', spec: '', repoUrl: null, baseBranch: null, permissionMode: 'bypassPermissions', sessionId: null } };
  await cloud.db.prepare('INSERT INTO durable_cmds (command_key,node_id,payload,created_at) VALUES (?,?,?,?)').bind(commandKey, nodeId, JSON.stringify(payload), now).run();
  cloud.ctx.sendToNode(nodeId, { ...payload, commandKey });
  await until(() => exec.db.getTask('DURABLETASK'), 2000, 'local durable task written');
  await until(async () => !(await cloud.db.prepare('SELECT 1 FROM durable_cmds WHERE command_key = ?').bind(commandKey).first()), 2000, 'durable ack deletes outbox');
  exec.manager.shutdown(); exec.link.stop();
});

test('conversation sources: teammate-created paths cannot authorize scanning a node owner private directory', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  for (const [id, name] of [['alice', 'alice'], ['bob', 'bob']]) {
    await cloud.db.prepare('INSERT INTO users (id,username,password_hash,created_at) VALUES (?,?,?,?)').bind(id, name, 'x', now).run();
  }
  await cloud.db.prepare('INSERT INTO teams (id,name,created_at) VALUES (?,?,?)').bind('team-sec', 'T', now).run();
  for (const id of ['alice', 'bob']) await cloud.db.prepare('INSERT INTO team_members (team_id,user_id,role,joined_at) VALUES (?,?,?,?)').bind('team-sec', id, id === 'alice' ? 'owner' : 'member', now).run();
  await cloud.db.prepare('INSERT INTO nodes (id,token_hash,owner_user_id,created_at) VALUES (?,?,?,?)').bind('alice-node', 'h', 'alice', now).run();
  await cloud.db.prepare('INSERT INTO node_teams (node_id,team_id) VALUES (?,?)').bind('alice-node', 'team-sec').run();
  for (const task of [
    ['owner-root', 'alice', '/shared'], ['attacker-root', 'bob', '/private'],
  ]) {
    await cloud.db.prepare(`INSERT INTO tasks (id,title,spec,repo_url,node_id,owner_user_id,team_id,status,created_at,updated_at)
      VALUES (?,?, 'x',?,'alice-node',?,'team-sec','review',?,?)`).bind(task[0], task[0], task[2], task[1], now, now).run();
    await cloud.db.prepare('INSERT INTO task_teams (task_id,team_id) VALUES (?,?)').bind(task[0], 'team-sec').run();
  }
  let scannedPaths = null;
  const bobCtx = { ...cloud.ctx, userId: 'bob', teamId: 'team-sec', listProjectSessions: async (_nodeId, paths) => {
    scannedPaths = paths;
    return { sessions: [
      { sessionId: 'shared-session', cwd: '/shared', preview: 'shared', mtime: now },
      { sessionId: 'private-session', cwd: '/private', preview: 'PRIVATE', mtime: now },
    ] };
  } };
  const list = await core.api(bobCtx, 'GET', '/api/conversation-sources', {});
  assert.equal(list.status, 200);
  assert.deepEqual(scannedPaths, ['/shared']);
  assert.deepEqual(list.body.sources.map(source => source.preview), ['shared']);
  const revokedCtx = { ...bobCtx, listProjectSessions: async () => {
    await cloud.db.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?').bind('team-sec', 'bob').run();
    return { sessions: [{ sessionId: 'late', cwd: '/shared', preview: 'must not leak', mtime: now }] };
  } };
  const revoked = await core.api(revokedCtx, 'GET', '/api/conversation-sources', {});
  assert.equal(revoked.status, 403, 'membership is rechecked after the node scan round trip');
});

test('tasks: resumeSessionId sets session_id at creation and is dispatched to the node', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-resume', await sha256Hex('tok-mac-resume'), 'user-test', now).run();

  let dispatched = null;
  const origSendToNode = cloud.ctx.sendToNode;
  cloud.ctx.sendToNode = (nodeId, msg) => { if (msg.t === 'start_task') dispatched = msg; return origSendToNode(nodeId, msg); };
  try {
    const res = await cloud.api('POST', '/api/tasks', {
      title: '继续之前的会话', spec: '继续', nodeId: 'mac-resume', resumeSessionId: 'ext-session-42',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.task.session_id, 'ext-session-42');
    assert.equal(dispatched.task.sessionId, 'ext-session-42');
    const duplicate = await cloud.api('POST', '/api/tasks', {
      title: '重复', spec: '不能重复', nodeId: 'mac-resume', resumeSessionId: 'ext-session-42',
    });
    assert.equal(duplicate.status, 409);
  } finally {
    cloud.ctx.sendToNode = origSendToNode;
  }
});

test('tasks: switch-session updates session_id, dispatches switch_session, 404s for a non-owned task', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-switch', await sha256Hex('tok-mac-switch'), 'user-test', now).run();
  const create = await cloud.api('POST', '/api/tasks', { title: 't', spec: 'x', nodeId: 'mac-switch' });
  const taskId = create.body.task.id;

  let dispatched = null;
  const origSendToNode = cloud.ctx.sendToNode;
  cloud.ctx.sendToNode = (nodeId, msg) => { if (msg.t === 'switch_session') dispatched = msg; return origSendToNode(nodeId, msg); };
  try {
    const res = await cloud.api('POST', `/api/tasks/${taskId}/switch-session`, { sessionId: 'ext-session-99' });
    assert.equal(res.status, 200);
    assert.deepEqual(dispatched, { t: 'switch_session', taskId, sessionId: 'ext-session-99' });
    assert.equal((await core.getTask(cloud.ctx, taskId)).session_id, 'ext-session-99');

    const missingId = await cloud.api('POST', `/api/tasks/${taskId}/switch-session`, {});
    assert.equal(missingId.status, 400);

    const other = await core.api({ ...cloud.ctx, userId: 'someone-else' }, 'POST', `/api/tasks/${taskId}/switch-session`, { sessionId: 'x' });
    assert.equal(other.status, 404);
  } finally {
    cloud.ctx.sendToNode = origSendToNode;
  }
});

test('resume flow: a task created with resumeSessionId spawns with that resumeSessionId end-to-end', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-e2e-resume', await sha256Hex('tok-mac-e2e-resume'), 'user-test', now).run();

  let sawResumeSessionId = null;
  const exec = makeExecutor(cloud, 'mac-e2e-resume', async (session, opts) => {
    sawResumeSessionId = opts.resumeSessionId;
    await sleep(10); // let _spawn()'s own setStatus('running') land before the result event does
    opts.onMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'continuing' }] } });
    opts.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 100, num_turns: 1, is_error: false });
    session.busy = false;
  });
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');

  // A resumed session must run in the directory it was actually created in —
  // `claude --resume` looks it up relative to the real runtime cwd (verified
  // against the real CLI), so unlike a normal task this can't be a fresh
  // clone/worktree; it has to be a real, already-existing directory.
  const resumeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-resume-dir-'));
  const res = await cloud.api('POST', '/api/tasks', {
    title: '继续', spec: '继续之前聊的', nodeId: 'mac-e2e-resume', resumeSessionId: 'ext-abc-123', repoUrl: resumeDir,
  });
  const taskId = res.body.task.id;

  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'review', 5000, 'review');
  assert.equal(sawResumeSessionId, 'ext-abc-123');
  // No clone/worktree — it must run directly in the given directory, or
  // --resume can't find the session (this is the whole point of the fix).
  const localTask = exec.db.getTask(taskId);
  assert.equal(localTask.dir, resumeDir);
  assert.equal(localTask.branch_name, null);

  exec.manager.shutdown();
  exec.link.stop();
});

test('resume flow: rejected with a clear error when the given directory does not actually exist', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-resume-missing-dir', await sha256Hex('tok-mac-resume-missing-dir'), 'user-test', now).run();

  const exec = makeExecutor(cloud, 'mac-resume-missing-dir', async () => {
    throw new Error('should never spawn a session for a missing directory');
  });
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');

  const res = await cloud.api('POST', '/api/tasks', {
    title: '继续', spec: '继续之前聊的', nodeId: 'mac-resume-missing-dir', resumeSessionId: 'ext-nope',
    repoUrl: '/definitely/does/not/exist/' + Math.random().toString(36).slice(2),
  });
  const taskId = res.body.task.id;

  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'failed', 5000, 'failed');
  const task = await core.getTask(cloud.ctx, taskId);
  assert.match(task.last_error, /恢复会话需要一个真实存在的目录/);

  exec.manager.shutdown();
  exec.link.stop();
});

test('retry: a failed task can recover once the underlying problem is fixed, and last_error clears', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-retry', await sha256Hex('tok-mac-retry'), 'user-test', now).run();

  // Directory doesn't exist yet — first attempt fails, exactly like the test above.
  const resumeDir = path.join(os.tmpdir(), 'ah-retry-dir-' + Math.random().toString(36).slice(2));
  const exec = makeExecutor(cloud, 'mac-retry', async (session, opts) => {
    await sleep(10);
    opts.onMessage({ type: 'assistant', message: { content: [{ type: 'text', text: '重试后成功了' }] } });
    opts.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 100, num_turns: 1, is_error: false });
    session.busy = false;
  });
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');

  const res = await cloud.api('POST', '/api/tasks', {
    title: '继续', nodeId: 'mac-retry', resumeSessionId: 'ext-retry-1', repoUrl: resumeDir,
  });
  const taskId = res.body.task.id;
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'failed', 5000, 'failed');
  assert.match((await core.getTask(cloud.ctx, taskId)).last_error, /恢复会话需要一个真实存在的目录/);
  const seqAfterFirstFail = (await core.getTask(cloud.ctx, taskId)).last_seq;

  // Retrying while still broken is a no-op error, not a silent pass. Wait
  // for last_seq to actually *advance* past the retry's own events (queued
  // -> starting -> failed again), not just "status === failed" — that's
  // already true from the original failure, so checking it alone would
  // pass immediately without the retry's re-failure having landed yet.
  const stillBroken = await cloud.api('POST', `/api/tasks/${taskId}/retry`, {});
  assert.equal(stillBroken.status, 200); // dispatch always accepts; the executor re-fails it
  await until(async () => {
    const t = await core.getTask(cloud.ctx, taskId);
    return t.last_seq > seqAfterFirstFail && t.status === 'failed';
  }, 5000, 're-failed');

  // Now fix it and retry again — should recover and clear the stale error.
  // No spec was ever given (matching the real resume-without-first-message
  // flow), so a successful retry lands at 'idle', not 'review' — nothing
  // gets auto-sent, same as the original attempt would have.
  fs.mkdirSync(resumeDir, { recursive: true });
  const retried = await cloud.api('POST', `/api/tasks/${taskId}/retry`, {});
  assert.equal(retried.status, 200);
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'idle', 5000, 'idle after retry');
  const finalTask = await core.getTask(cloud.ctx, taskId);
  assert.equal(finalTask.last_error, null, 'stale error cleared once the task actually succeeds');

  const other = await core.api({ ...cloud.ctx, userId: 'someone-else' }, 'POST', `/api/tasks/${taskId}/retry`, {});
  assert.equal(other.status, 404);

  exec.manager.shutdown();
  exec.link.stop();
});

test('retry: resends the last input that actually failed (not the stale original creation spec), and silently', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-retry-spec', await sha256Hex('tok-mac-retry-spec'), 'user-test', now).run();

  const ORIGINAL_SPEC = '最初创建时的那句话';
  const FOLLOWUP = '继续';
  let turn = 0;
  const exec = makeExecutor(cloud, 'mac-retry-spec', async (session, opts, text) => {
    turn++;
    await sleep(10);
    if (turn === 1) {
      // The creation spec itself — succeeds normally, same as any first turn.
      assert.equal(text, ORIGINAL_SPEC);
      opts.onMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok1' }] } });
      opts.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 100, num_turns: 1, is_error: false });
    } else if (turn === 2) {
      // A real follow-up, deep into an already-established conversation —
      // fails with a *non*-transient error (won't auto-retry), needing the
      // manual retry button.
      assert.equal(text, FOLLOWUP);
      opts.onMessage({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'invalid_request_error', duration_ms: 50, num_turns: 1 });
    } else if (turn === 3) {
      // The manual retry must resend *this* (the last thing that actually
      // failed), never the long-stale original creation spec.
      assert.equal(text, FOLLOWUP);
      opts.onMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok3' }] } });
      opts.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 100, num_turns: 1, is_error: false });
    }
    session.busy = false;
  });
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');

  const res = await cloud.api('POST', '/api/tasks', { title: 't', spec: ORIGINAL_SPEC, nodeId: 'mac-retry-spec' });
  const taskId = res.body.task.id;
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'review', 5000, 'review after turn 1');

  await cloud.api('POST', `/api/tasks/${taskId}/message`, { text: FOLLOWUP });
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'failed', 5000, 'failed on turn 2');

  const retried = await cloud.api('POST', `/api/tasks/${taskId}/retry`, {});
  assert.equal(retried.status, 200);
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'review', 5000, 'review after retry resent the follow-up');
  assert.equal(turn, 3, 'retry resent the last failed input as a real turn, not just a silent idle resume');

  const msgs = await cloud.api('GET', `/api/tasks/${taskId}/messages`, {});
  const specSends = msgs.body.messages.filter(m => m.role === 'user' && m.content.text === ORIGINAL_SPEC);
  assert.equal(specSends.length, 1, 'the original creation spec must appear exactly once, never resent by a later retry');
  const followupBubbles = msgs.body.messages.filter(m => m.role === 'user' && m.content.text === FOLLOWUP);
  assert.equal(followupBubbles.length, 1, "the retry's resend is silent — no duplicate user bubble for text already shown once");

  exec.manager.shutdown();
  exec.link.stop();
});

test('retry: resends the failed turn\'s images along with its text, not just the text', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-retry-img', await sha256Hex('tok-mac-retry-img'), 'user-test', now).run();

  const FOLLOWUP = '这张图是什么颜色';
  const images = [{ mediaType: 'image/png', data: TINY_PNG_BASE64 }];
  let turn = 0;
  const exec = makeExecutor(cloud, 'mac-retry-img', async (session, opts, text, msgImages) => {
    turn++;
    await sleep(10);
    if (turn === 1) {
      opts.onMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok1' }] } });
      opts.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 100, num_turns: 1, is_error: false });
    } else if (turn === 2) {
      assert.equal(text, FOLLOWUP);
      assert.deepEqual(msgImages, images);
      opts.onMessage({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'invalid_request_error', duration_ms: 50, num_turns: 1 });
    } else if (turn === 3) {
      // The retry must carry the same images, not silently drop them.
      assert.equal(text, FOLLOWUP);
      assert.deepEqual(msgImages, images);
      opts.onMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok3' }] } });
      opts.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 100, num_turns: 1, is_error: false });
    }
    session.busy = false;
  });
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');

  const res = await cloud.api('POST', '/api/tasks', { title: 't', spec: '开始', nodeId: 'mac-retry-img' });
  const taskId = res.body.task.id;
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'review', 5000, 'review after turn 1');

  await cloud.api('POST', `/api/tasks/${taskId}/message`, { text: FOLLOWUP, images });
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'failed', 5000, 'failed on turn 2');

  const retried = await cloud.api('POST', `/api/tasks/${taskId}/retry`, {});
  assert.equal(retried.status, 200);
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'review', 5000, 'review after retry resent the follow-up + images');
  assert.equal(turn, 3, 'retry resent the last failed input, images included');

  exec.manager.shutdown();
  exec.link.stop();
});

test('retry: never resends a stale creation spec left over from a task that already started long ago, even if retry_last_input is empty', async () => {
  const cloud = makeCloud();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-stale-spec', await sha256Hex('tok-mac-stale-spec'), 'user-test', Date.now()).run();

  const calls = [];
  const exec = makeExecutor(cloud, 'mac-stale-spec', async (session, opts, text) => {
    calls.push(text);
    await sleep(5);
    opts.onMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } });
    opts.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 10, num_turns: 1, is_error: false });
    session.busy = false;
  });
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');

  const STALE_SPEC = '很久以前创建时的那句话';
  const res = await cloud.api('POST', '/api/tasks', { title: 't', spec: STALE_SPEC, nodeId: 'mac-stale-spec' });
  const taskId = res.body.task.id;
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'review', 3000, 'review after first turn');
  assert.deepEqual(calls, [STALE_SPEC]);

  // A task that's been running/resuming for a long time (many daemon
  // restarts, real_config_dir sessions, etc.) can go a long time without
  // ever passing back through _maybeStart's own firstMessage/spec-clearing
  // step — found live: spec sat stale in the DB the entire time, and the
  // very next retry (whose own failure predated retry_last_input tracking
  // being deployed, so that's empty too) replayed it verbatim, days later,
  // into an already-deep conversation. Simulate exactly that: dir is
  // already established (this task has genuinely started before), spec
  // still holds the old text, and retry_last_input is empty.
  exec.db.patchTask(taskId, { spec: STALE_SPEC, status: 'failed', retryLastInput: null });
  await cloud.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').bind('failed', taskId).run();

  const retried = await cloud.api('POST', `/api/tasks/${taskId}/retry`, {});
  assert.equal(retried.status, 200);
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'idle', 3000, 'idle — nothing recorded to resend, so nothing gets sent');
  assert.deepEqual(calls, [STALE_SPEC], 'the stale spec must never be resent once the task has already started before, dir or no dir');

  exec.manager.shutdown();
  exec.link.stop();
});

test('auto-retry: a transient upstream error retries automatically (fast, then slow), and resets on success', async () => {
  const cloud = makeCloud();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-autoretry', await sha256Hex('tok-mac-autoretry'), 'user-test', Date.now()).run();

  let turn = 0;
  const exec = makeExecutor(cloud, 'mac-autoretry', async (session, opts) => {
    turn++;
    await sleep(5);
    if (turn < 3) {
      opts.onMessage({
        type: 'result', subtype: 'error_during_execution', is_error: true,
        result: 'API Error: Connection closed mid-response.', duration_ms: 10, num_turns: 1,
      });
    } else {
      opts.onMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'finally ok' }] } });
      opts.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 10, num_turns: 1, is_error: false });
    }
    session.busy = false;
  }, { autoRetryFastDelaysMs: [10, 20, 30], autoRetrySlowDelayMs: 40, autoRetryMaxWindowMs: 5000 });
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');

  const res = await cloud.api('POST', '/api/tasks', { title: 't', spec: '开始', nodeId: 'mac-autoretry' });
  const taskId = res.body.task.id;

  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'review', 3000, 'eventually succeeds via auto-retry, no manual click');
  assert.equal(turn, 3, 'retried automatically until success');
  assert.equal(exec.db.getTask(taskId).retry_attempt, 0, 'retry streak resets once a turn actually succeeds');

  const msgs = await cloud.api('GET', `/api/tasks/${taskId}/messages`, {});
  assert.ok(msgs.body.messages.some(m => m.role === 'system' && m.content.text.includes('自动重试')), 'visible log entry of the auto-retry, not silent');

  exec.manager.shutdown();
  exec.link.stop();
});

test('auto-retry: resends a transiently-failed message\'s images too, not just its text', async () => {
  const cloud = makeCloud();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-autoretry-img', await sha256Hex('tok-mac-autoretry-img'), 'user-test', Date.now()).run();

  const FOLLOWUP = '这张图是什么颜色';
  const images = [{ mediaType: 'image/png', data: TINY_PNG_BASE64 }];
  let turn = 0;
  const exec = makeExecutor(cloud, 'mac-autoretry-img', async (session, opts, text, msgImages) => {
    turn++;
    await sleep(5);
    if (turn === 1) {
      opts.onMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok1' }] } });
      opts.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 10, num_turns: 1, is_error: false });
    } else if (turn === 2) {
      assert.deepEqual(msgImages, images);
      opts.onMessage({
        type: 'result', subtype: 'error_during_execution', is_error: true,
        result: 'API Error: Connection closed mid-response.', duration_ms: 10, num_turns: 1,
      });
    } else {
      // Auto-retried turn — must still carry the same images.
      assert.equal(text, FOLLOWUP);
      assert.deepEqual(msgImages, images);
      opts.onMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'finally ok' }] } });
      opts.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 10, num_turns: 1, is_error: false });
    }
    session.busy = false;
  }, { autoRetryFastDelaysMs: [10, 20, 30], autoRetrySlowDelayMs: 40, autoRetryMaxWindowMs: 5000 });
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');

  const res = await cloud.api('POST', '/api/tasks', { title: 't', spec: '开始', nodeId: 'mac-autoretry-img' });
  const taskId = res.body.task.id;
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'review', 3000, 'review after turn 1');

  await cloud.api('POST', `/api/tasks/${taskId}/message`, { text: FOLLOWUP, images });
  // status==='review' alone can false-positive on the *stale* value already
  // left over from turn 1 before turn 2 even starts — wait for the actual
  // turn count first (same race class fixed elsewhere in this file).
  await until(() => turn >= 3, 3000, 'auto-retried up to the successful turn');
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'review', 3000, 'eventually succeeds via auto-retry, images intact');
  assert.equal(turn, 3, 'retried automatically until success');

  exec.manager.shutdown();
  exec.link.stop();
});

test('auto-retry: a non-transient failure (e.g. bad config/prompt) is never auto-retried — stays failed for a human', async () => {
  const cloud = makeCloud();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-noautoretry', await sha256Hex('tok-mac-noautoretry'), 'user-test', Date.now()).run();

  let turn = 0;
  const exec = makeExecutor(cloud, 'mac-noautoretry', async (session, opts) => {
    turn++;
    await sleep(5);
    opts.onMessage({
      type: 'result', subtype: 'error_during_execution', is_error: true,
      result: 'invalid_request_error: model not found', duration_ms: 10, num_turns: 1,
    });
    session.busy = false;
  }, { autoRetryFastDelaysMs: [10, 20, 30], autoRetrySlowDelayMs: 40, autoRetryMaxWindowMs: 5000 });
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');

  const res = await cloud.api('POST', '/api/tasks', { title: 't', spec: '开始', nodeId: 'mac-noautoretry' });
  const taskId = res.body.task.id;
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'failed', 3000, 'failed');
  await sleep(150); // long enough that a scheduled auto-retry, if any, would already have fired
  assert.equal(turn, 1, 'never auto-retried — this error class needs a human');
  assert.equal(exec.db.getTask(taskId).retry_attempt, 0);

  exec.manager.shutdown();
  exec.link.stop();
});

test('auto-retry: gives up once the configured max window since the first failure has elapsed', async () => {
  const cloud = makeCloud();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-retrycap', await sha256Hex('tok-mac-retrycap'), 'user-test', Date.now()).run();
  const exec = makeExecutor(cloud, 'mac-retrycap', async () => {}, { autoRetryMaxWindowMs: 1000 });
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');

  const res = await cloud.api('POST', '/api/tasks', { title: 't', spec: 'x', nodeId: 'mac-retrycap' });
  const taskId = res.body.task.id;
  await until(() => !!exec.db.getTask(taskId), 2000, 'task exists locally');
  // Simulate a streak that started well outside the (shortened, for this
  // test) max window — same as recover() finding one mid-flight after the
  // daemon was down long enough to blow past it.
  exec.db.patchTask(taskId, { status: 'failed', retryAttempt: 5, retryFirstFailedAt: Date.now() - 2000 });

  exec.manager._scheduleAutoRetry(taskId, 'API Error: Connection closed mid-response.');
  assert.equal(exec.db.getTask(taskId).retry_attempt, 5, 'no further attempt scheduled once past the window');

  await until(async () => {
    const m = await cloud.api('GET', `/api/tasks/${taskId}/messages`, {});
    return m.body.messages.some(x => x.role === 'system' && x.content.text.includes('12 小时'));
  }, 3000, 'gave-up message shown');

  exec.manager.shutdown();
  exec.link.stop();
});

test('retry: explicit recovery options (permissionMode downgrade / allowRootBypass) propagate to the executor', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-rootbypass', await sha256Hex('tok-mac-rootbypass'), 'user-test', now).run();

  // Never fixed in this test — every attempt keeps failing the same way, so
  // each retry below gets its own fresh 'failed' state to act on.
  const resumeDir = path.join(os.tmpdir(), 'ah-rootbypass-dir-' + Math.random().toString(36).slice(2));
  const exec = makeExecutor(cloud, 'mac-rootbypass', async (session, opts) => {
    opts.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 100, num_turns: 1, is_error: false });
    session.busy = false;
  });
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');

  const res = await cloud.api('POST', '/api/tasks', {
    title: 'root bypass 场景', nodeId: 'mac-rootbypass', resumeSessionId: 'ext-rootbypass-1', repoUrl: resumeDir,
  });
  const taskId = res.body.task.id;
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'failed', 5000, 'failed');

  // Downgrading off bypassPermissions must land in both the cloud task row
  // (so the UI reflects it) and the executor's own local db (so the *next*
  // spawn actually picks it up — see manager.mjs's _maybeStart()).
  const downgrade = await cloud.api('POST', `/api/tasks/${taskId}/retry`, { permissionMode: 'default' });
  assert.equal(downgrade.status, 200);
  await until(() => exec.db.getTask(taskId)?.permission_mode === 'default', 3000, 'permission mode downgraded locally');
  assert.equal((await core.getTask(cloud.ctx, taskId)).permission_mode, 'default');

  // Opting into IS_SANDBOX similarly persists locally (not just a one-shot
  // retry param) — it has to survive to every future spawn of this task.
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'failed', 5000, 'failed again');
  const bypass = await cloud.api('POST', `/api/tasks/${taskId}/retry`, { allowRootBypass: true });
  assert.equal(bypass.status, 200);
  await until(() => exec.db.getTask(taskId)?.allow_root_bypass === 1, 3000, 'root bypass flag set locally');

  // An unrecognized permissionMode value is silently ignored, not written —
  // this is a fixed enum on the CLI side, not free-form user input.
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'failed', 5000, 'failed a third time');
  const bogus = await cloud.api('POST', `/api/tasks/${taskId}/retry`, { permissionMode: 'sudo-everything' });
  assert.equal(bogus.status, 200);
  assert.equal((await core.getTask(cloud.ctx, taskId)).permission_mode, 'default', 'unrecognized value ignored, previous mode kept');

  exec.manager.shutdown();
  exec.link.stop();
});

test('userMessage: a message sent while a decision is pending is kept, but not forwarded to the agent', async () => {
  const cloud = makeCloud();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-pending', await sha256Hex('tok-mac-pending'), 'user-test', Date.now()).run();

  // Raise a permission request and never resolve it — a live CLI genuinely
  // blocked mid-turn waiting on control_response, same as the real stuck
  // state found live (mobile UI couldn't show the decision card, user typed
  // "继续" as a plain message instead).
  const forwarded = [];
  const exec = makeExecutor(cloud, 'mac-pending', async (session, opts, text) => {
    forwarded.push(text);
    // The sleep matters: without it, this runs synchronously inside
    // session.send(), racing _spawn()'s own unconditional
    // setStatus('running') right after send() returns — that's a test-
    // harness ordering quirk, not the real bug, so give it a tick first
    // (same pattern the M1 test above uses for its own permission request).
    await sleep(10);
    opts.onPermission({ requestId: 'req-plan', toolName: 'ExitPlanMode', input: { plan: '部署计划' } });
    // session.busy deliberately left true — never resolved, matching a
    // genuinely stuck turn.
  });
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');

  const res = await cloud.api('POST', '/api/tasks', { title: '测试任务', spec: '开始', nodeId: 'mac-pending' });
  const taskId = res.body.task.id;
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'waiting_human', 5000, 'waiting_human');
  const pendingBefore = (await core.getTask(cloud.ctx, taskId)).pending_request;
  forwarded.length = 0;

  const msg = await cloud.api('POST', `/api/tasks/${taskId}/message`, { text: '继续', clientMessageId: 'cm-blocked' });
  assert.equal(msg.status, 200, 'dispatch itself is accepted — the refusal happens executor-side, as a system message');
  await until(async () => {
    const m = await cloud.api('GET', `/api/tasks/${taskId}/messages`, {});
    return m.body.messages.some(x => x.role === 'system' && x.content.text.includes('请先在请求卡片里选择'));
  }, 3000, 'system note explaining why nothing was sent');

  const after = await core.getTask(cloud.ctx, taskId);
  assert.equal(after.status, 'waiting_human', 'status must not silently flip to running');
  assert.equal(after.pending_request, pendingBefore, 'the original pending decision must survive untouched');
  assert.deepEqual(forwarded, [], 'the plain message was never forwarded to the blocked CLI');

  // ...but it is still *kept*. Dropping the text (the original behavior here)
  // is the same "我发的消息不见了" failure as losing it in transit — the user
  // typed something and got a system note where their words should be.
  const msgs = await cloud.api('GET', `/api/tasks/${taskId}/messages`, {});
  const kept = msgs.body.messages.find(m => m.role === 'user' && m.content.text === '继续');
  assert.ok(kept, 'the message the user typed is preserved in the conversation');
  assert.equal(kept.content.clientMessageId, 'cm-blocked');
  assert.equal(msgs.body.pending.length, 0, 'and its pending bubble is retired, since the node did record it');

  // Resolve the still-outstanding decision before tearing down — otherwise
  // its real decisionTimeoutMs timer (60s in this harness's config) keeps
  // the process alive well past the test itself finishing.
  exec.manager.decide(taskId, 'req-plan', 'deny');
  exec.manager.shutdown();
  exec.link.stop();
});

test('message: every conversation stays immediately continuable — sending a message works from failed/done/cancelled without a manual retry first', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-anystate', await sha256Hex('tok-mac-anystate'), 'user-test', now).run();

  let reply = '第一轮';
  const exec = makeExecutor(cloud, 'mac-anystate', async (session, opts) => {
    await sleep(10);
    opts.onMessage({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } });
    opts.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 100, num_turns: 1, is_error: false });
    session.busy = false;
  });
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');

  const res = await cloud.api('POST', '/api/tasks', { title: 't', spec: '开始', nodeId: 'mac-anystate' });
  const taskId = res.body.task.id;
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'review', 5000, 'review');

  // done -> message still works, no manual "un-done" step required.
  await cloud.api('POST', `/api/tasks/${taskId}/done`, {});
  assert.equal((await core.getTask(cloud.ctx, taskId)).status, 'done');
  reply = '完成后还能接着聊';
  const m1 = await cloud.api('POST', `/api/tasks/${taskId}/message`, { text: '还在吗' });
  assert.equal(m1.status, 200);
  await until(async () => {
    const m = await cloud.api('GET', `/api/tasks/${taskId}/messages`, {});
    return m.body.messages.some(x => x.role === 'assistant' && x.content.text === '完成后还能接着聊');
  }, 5000, 'message worked after done');

  // cancelled -> message still works.
  await cloud.api('POST', `/api/tasks/${taskId}/cancel`, {});
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'cancelled', 5000, 'cancelled');
  reply = '取消后还能接着聊';
  const m2 = await cloud.api('POST', `/api/tasks/${taskId}/message`, { text: '还在吗2' });
  assert.equal(m2.status, 200);
  await until(async () => {
    const m = await cloud.api('GET', `/api/tasks/${taskId}/messages`, {});
    return m.body.messages.some(x => x.role === 'assistant' && x.content.text === '取消后还能接着聊');
  }, 5000, 'message worked after cancel');

  exec.manager.shutdown();
  exec.link.stop();
});

test('tasks: archive sets archived_at, unarchive clears it, 404s for a non-owned task', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-archive', await sha256Hex('tok-mac-archive'), 'user-test', now).run();
  const create = await cloud.api('POST', '/api/tasks', { title: 't', spec: 'x', nodeId: 'mac-archive' });
  const taskId = create.body.task.id;
  assert.equal((await core.getTask(cloud.ctx, taskId)).archived_at, null);

  const archived = await cloud.api('POST', `/api/tasks/${taskId}/archive`, {});
  assert.equal(archived.status, 200);
  assert.ok((await core.getTask(cloud.ctx, taskId)).archived_at > 0);

  const unarchived = await cloud.api('POST', `/api/tasks/${taskId}/unarchive`, {});
  assert.equal(unarchived.status, 200);
  assert.equal((await core.getTask(cloud.ctx, taskId)).archived_at, null);

  const other = await core.api({ ...cloud.ctx, userId: 'someone-else' }, 'POST', `/api/tasks/${taskId}/archive`, {});
  assert.equal(other.status, 404);
});

test('auto-compact stands down when the relay streams real usage — the CLI\'s own (mid-turn capable) auto-compact owns it', async () => {
  const cloud = makeCloud();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-compact', await sha256Hex('tok-mac-compact'), 'user-test', Date.now()).run();

  const sentTexts = [];
  const exec = makeExecutor(cloud, 'mac-compact', async (session, opts, text) => {
    sentTexts.push(text);
    await sleep(10);
    // A huge context turn — well past AUTO_COMPACT_THRESHOLD_TOKENS (150_000)
    // — but with REAL streamed usage (non-zero), meaning the CLI's built-in
    // usage-gated auto-compact is functional and AgentHub's turn-end
    // fallback must not double up on it.
    opts.onMessage({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '好的,处理完了' }], usage: { input_tokens: 160_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 50 } },
    });
    opts.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0.05, duration_ms: 100, num_turns: 1, is_error: false });
    session.busy = false;
  });
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');

  const res = await cloud.api('POST', '/api/tasks', { title: 't', spec: '开始工作', nodeId: 'mac-compact' });
  const taskId = res.body.task.id;

  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'review', 8000, 'review settles directly');
  assert.deepEqual(sentTexts, ['开始工作'], 'no /compact was injected — the CLI\'s own auto-compact handles a real-usage relay');
  const t = await core.getTask(cloud.ctx, taskId);
  assert.equal(t.context_tokens, 160_000, 'context size still tracked/displayed from the streamed usage');

  exec.manager.shutdown();
  exec.link.stop();
});

test('auto-compact fallback still fires for a zero-streamed-usage relay (context read from the on-disk transcript)', async () => {
  const cloud = makeCloud();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-compact0', await sha256Hex('tok-mac-compact0'), 'user-test', Date.now()).run();

  const sentTexts = [];
  let turn = 0;
  const exec = makeExecutor(cloud, 'mac-compact0', async (session, opts, text) => {
    sentTexts.push(text);
    turn++;
    await sleep(10);
    if (turn === 1) {
      // Broken-relay shape: the streamed message carries all-zero usage, but
      // the CLI's own on-disk transcript has the real (huge) count — write
      // that file exactly where the manager's turn-end read looks.
      const lt = exec.db.allTasks()[0];
      const file = nativeSessionFile(exec.workRoot, lt.dir, session.sessionId);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({
        type: 'assistant',
        message: { usage: { input_tokens: 160_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      }) + '\n');
      opts.onMessage({
        type: 'assistant',
        message: { content: [{ type: 'text', text: '好的,处理完了' }], usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 } },
      });
      opts.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0.05, duration_ms: 100, num_turns: 1, is_error: false });
    } else {
      // The auto-triggered /compact turn — small, normal completion.
      opts.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0.001, duration_ms: 50, num_turns: 1, is_error: false });
    }
    session.busy = false;
  });
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');

  const res = await cloud.api('POST', '/api/tasks', { title: 't', spec: '开始工作', nodeId: 'mac-compact0' });
  const taskId = res.body.task.id;

  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'review', 8000, 'review after auto-compact settles');
  assert.deepEqual(sentTexts.slice(1), ['/compact'], 'the second thing ever sent to the CLI was the auto-triggered compact');

  const msgs = await cloud.api('GET', `/api/tasks/${taskId}/messages`, {});
  assert.ok(msgs.body.messages.some(m => m.role === 'system' && m.content.text.includes('自动压缩')), 'user is told compaction happened, not left guessing');
  assert.ok(msgs.body.messages.some(m => m.role === 'assistant' && m.content.text === '好的,处理完了'), 'the actual turn content still made it through');

  exec.manager.shutdown();
  exec.link.stop();
});

test('context overflow: a "prompt is too long" failure auto-compacts and resends the interrupted input, no human needed', async () => {
  const cloud = makeCloud();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-ovf', await sha256Hex('tok-mac-ovf'), 'user-test', Date.now()).run();

  const sentTexts = [];
  const exec = makeExecutor(cloud, 'mac-ovf', async (session, opts, text) => {
    sentTexts.push(text);
    await sleep(10);
    if (text === '继续跑' && sentTexts.filter(s => s === '继续跑').length === 1) {
      // The long-running turn dies on the context wall.
      opts.onMessage({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: prompt is too long: 250000 tokens > 200000 maximum', total_cost_usd: 0.2, duration_ms: 100, num_turns: 1 });
    } else {
      // Everything else (creation turn, the /compact turn, the resent turn) succeeds.
      opts.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 50, num_turns: 1, is_error: false });
    }
    session.busy = false;
  });
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');

  const res = await cloud.api('POST', '/api/tasks', { title: 't', spec: '开始工作', nodeId: 'mac-ovf' });
  const taskId = res.body.task.id;
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'review', 5000, 'creation turn settles');

  await cloud.api('POST', `/api/tasks/${taskId}/message`, { text: '继续跑' });
  // Wait on the distinguishing signal (the resent input arriving at the CLI)
  // before checking status — 'review' alone matches the stale pre-message
  // status and races the whole recovery chain.
  await until(() => sentTexts.length === 4, 8000, 'overflow → compact → resend chain completes');
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'review', 8000, 'recovered back to review with no human involved');

  assert.deepEqual(sentTexts, ['开始工作', '继续跑', '/compact', '继续跑'],
    'overflow → automatic /compact → automatic resend of the exact input that failed');
  const t = await core.getTask(cloud.ctx, taskId);
  assert.equal(t.last_error, null, 'clean settle cleared the overflow error');

  const msgs = await cloud.api('GET', `/api/tasks/${taskId}/messages`, {});
  assert.ok(msgs.body.messages.some(m => m.role === 'system' && m.content.text.includes('上下文超出模型上限')), 'user is told why the compact happened');
  assert.ok(msgs.body.messages.some(m => m.role === 'system' && m.content.text.includes('压缩完成')), 'user is told the input was resent');
  assert.equal(msgs.body.messages.filter(m => m.role === 'user' && m.content.text === '继续跑').length, 1,
    'the automatic resend is silent — no duplicate user bubble');

  exec.manager.shutdown();
  exec.link.stop();
});

test('turn cap: an error_max_turns result continues the half-finished job instead of failing it', async () => {
  const cloud = makeCloud();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-turncap', await sha256Hex('tok-mac-turncap'), 'user-test', Date.now()).run();

  const sentTexts = [];
  const exec = makeExecutor(cloud, 'mac-turncap', async (session, opts, text) => {
    sentTexts.push(text);
    await sleep(10);
    if (text === '大活' ) {
      // Exactly what a node running a build that still passes --max-turns
      // emits: is_error, no `result` detail at all, session still alive.
      opts.onMessage({ type: 'result', subtype: 'error_max_turns', is_error: true, total_cost_usd: 6.2, duration_ms: 1_367_667, num_turns: 101 });
    } else {
      opts.onMessage({ type: 'assistant', message: { content: [{ type: 'text', text: '接着做完了' }] } });
      opts.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 50, num_turns: 1, is_error: false });
    }
    session.busy = false;
  });
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');

  const res = await cloud.api('POST', '/api/tasks', { title: 't', spec: '开始工作', nodeId: 'mac-turncap' });
  const taskId = res.body.task.id;
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'review', 5000, 'creation turn settles');

  await cloud.api('POST', `/api/tasks/${taskId}/message`, { text: '大活' });
  await until(() => sentTexts.length === 3, 8000, 'turn cap → continuation chain completes');
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'review', 8000, 'recovered with no human involved');

  const t = await core.getTask(cloud.ctx, taskId);
  assert.equal(t.status, 'review', 'never lands on failed — the work was fine, only the turn budget ran out');
  assert.equal(t.last_error, null);
  assert.notEqual(sentTexts[2], '大活', 'the original ask is NOT resent — that would restart a half-finished job');

  const msgs = await cloud.api('GET', `/api/tasks/${taskId}/messages`, {});
  assert.ok(msgs.body.messages.some(m => m.role === 'system' && m.content.text.includes('回合数上限')), 'user is told why, not left with a bare error_max_turns');
  assert.equal(msgs.body.messages.filter(m => m.role === 'user' && m.content.text === '大活').length, 1, 'no duplicate user bubble');

  exec.manager.shutdown();
  exec.link.stop();
});

test('turn cap: gives up visibly after the continuation cap instead of spending forever', async () => {
  const cloud = makeCloud();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-turncap2', await sha256Hex('tok-mac-turncap2'), 'user-test', Date.now()).run();

  const sentTexts = [];
  const exec = makeExecutor(cloud, 'mac-turncap2', async (session, opts, text) => {
    sentTexts.push(text);
    await sleep(10);
    if (text === '开始工作') {
      opts.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 50, num_turns: 1, is_error: false });
    } else {
      // An agent that just keeps spinning: every continuation caps out again.
      opts.onMessage({ type: 'result', subtype: 'error_max_turns', is_error: true, total_cost_usd: 1, duration_ms: 100, num_turns: 101 });
    }
    session.busy = false;
  });
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');

  const res = await cloud.api('POST', '/api/tasks', { title: 't', spec: '开始工作', nodeId: 'mac-turncap2' });
  const taskId = res.body.task.id;
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'review', 5000, 'creation turn settles');

  await cloud.api('POST', `/api/tasks/${taskId}/message`, { text: '死循环' });
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'failed', 8000, 'settles at failed once the cap is hit');

  assert.equal(sentTexts.length, 5, 'the ask plus exactly MAX_TURN_CAP_CONTINUATIONS continuations');
  assert.match((await core.getTask(cloud.ctx, taskId)).last_error, /error_max_turns/, 'the real reason is what the user finally sees');

  exec.manager.shutdown();
  exec.link.stop();
});

test('context overflow: gives up visibly after the compact-attempt cap instead of looping forever', async () => {
  const cloud = makeCloud();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-ovf2', await sha256Hex('tok-mac-ovf2'), 'user-test', Date.now()).run();

  const sentTexts = [];
  const exec = makeExecutor(cloud, 'mac-ovf2', async (session, opts, text) => {
    sentTexts.push(text);
    await sleep(10);
    if (text === '/compact' || text === '开始工作') {
      opts.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 50, num_turns: 1, is_error: false });
    } else {
      // Compaction never reclaims enough: every real turn keeps overflowing.
      opts.onMessage({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: prompt is too long: 250000 tokens > 200000 maximum', total_cost_usd: 0.2, duration_ms: 100, num_turns: 1 });
    }
    session.busy = false;
  });
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');

  const res = await cloud.api('POST', '/api/tasks', { title: 't', spec: '开始工作', nodeId: 'mac-ovf2' });
  const taskId = res.body.task.id;
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'review', 5000, 'creation turn settles');

  await cloud.api('POST', `/api/tasks/${taskId}/message`, { text: '大活' });
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'failed', 8000, 'settles at failed once the cap is hit');

  assert.equal(sentTexts.filter(s => s === '/compact').length, 2, 'exactly MAX_OVERFLOW_COMPACT_ATTEMPTS compact attempts');
  const t = await core.getTask(cloud.ctx, taskId);
  assert.match(t.last_error, /prompt is too long/, 'the real overflow error is what the user sees');

  exec.manager.shutdown();
  exec.link.stop();
});

test('permission timeout: an unanswered approval auto-denies and settles at review, not a still-waiting-looking waiting_human', async () => {
  const cloud = makeCloud();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-permtimeout', await sha256Hex('tok-mac-permtimeout'), 'user-test', Date.now()).run();

  const exec = makeExecutor(cloud, 'mac-permtimeout', async (session, opts) => {
    await sleep(10);
    // Ask for permission and never resolve it ourselves — let the manager's
    // own timeout fire and auto-deny it.
    await opts.onPermission({ requestId: 'req-timeout-1', toolName: 'Bash', input: { command: 'rm -rf /tmp/x' } });
  });
  exec.config.decisionTimeoutMs = 80;
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');

  const res = await cloud.api('POST', '/api/tasks', { title: 't', spec: '开始', nodeId: 'mac-permtimeout' });
  const taskId = res.body.task.id;

  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'waiting_human', 5000, 'waiting_human while live');

  // Once the timeout fires, the decision is already resolved (denied) — the
  // task must not keep showing as if it's still waiting on a live decision.
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'review', 5000, 'settles at review after auto-deny');
  const t = await core.getTask(cloud.ctx, taskId);
  assert.equal(t.pending_request, null, 'no live pending request left behind');

  const msgs = await cloud.api('GET', `/api/tasks/${taskId}/messages`, {});
  assert.ok(msgs.body.messages.some(m => m.role === 'system' && m.content.text.includes('审批超时')));

  exec.manager.shutdown();
  exec.link.stop();
});

test('real_config_dir sweep: growth from outside AgentHub is picked up without waiting for a message, and a stale failed status clears', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-sweep', await sha256Hex('tok-mac-sweep'), 'user-test', now).run();

  const claudeProjectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-fake-claude-projects-sweep-'));
  const resumeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-sweep-resume-dir-'));
  const slug = fs.realpathSync(resumeDir).replace(/[^a-zA-Z0-9]/g, '-');
  const sourceDir = path.join(claudeProjectsRoot, slug);
  fs.mkdirSync(sourceDir, { recursive: true });
  const file = path.join(sourceDir, 'ext-sweep-1.jsonl');
  fs.writeFileSync(file, [
    { type: 'user', message: { content: '第一轮问题' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: '第一轮回答' }] } },
  ].map(l => JSON.stringify(l)).join('\n') + '\n');

  const exec = makeExecutor(cloud, 'mac-sweep', async (session, opts) => {
    await sleep(10);
    opts.onMessage({ type: 'assistant', message: { content: [{ type: 'text', text: '好的' }] } });
    opts.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 100, num_turns: 1, is_error: false });
    session.busy = false;
  });
  exec.config.claudeProjectsRoot = claudeProjectsRoot;
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');

  const res = await cloud.api('POST', '/api/tasks', {
    title: '继续', spec: '继续之前聊的', nodeId: 'mac-sweep', resumeSessionId: 'ext-sweep-1', repoUrl: resumeDir,
  });
  const taskId = res.body.task.id;
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'review', 5000, 'review after turn 1');

  // Simulate the exact situation this fixes: the task is stuck on a stale
  // 'failed' from before (e.g. a hard error unrelated to this mechanism),
  // and meanwhile someone kept using the real session outside AgentHub.
  exec.db.patchTask(taskId, { status: 'failed', lastError: '之前的某次真实失败' });
  fs.appendFileSync(file, [
    { type: 'user', message: { content: '在别处继续问的' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: '在别处的回答' }] } },
  ].map(l => JSON.stringify(l)).join('\n') + '\n');

  // Trigger the same check recover() runs at startup, without waiting a full minute.
  exec.manager._sweepExternalGrowth();

  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'idle', 5000, 'stale failed clears to idle');
  const t = await core.getTask(cloud.ctx, taskId);
  assert.equal(t.last_error, null, 'stale error cleared, not just the status');

  const msgs = await cloud.api('GET', `/api/tasks/${taskId}/messages`, {});
  assert.ok(msgs.body.messages.some(m => m.role === 'system' && m.content.text.includes('别处')), 'user is told this was picked up from outside AgentHub');
  assert.ok(msgs.body.messages.some(m => m.role === 'assistant' && m.content.text === '在别处的回答'), 'the actual new content made it in');

  exec.manager.shutdown();
  exec.link.stop();
});

test('real_config_dir: a normal live turn does not get duplicated by the next external-growth sweep', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-nodupe', await sha256Hex('tok-mac-nodupe'), 'user-test', now).run();

  const claudeProjectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-fake-claude-projects-nodupe-'));
  const resumeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-nodupe-resume-dir-'));
  const slug = fs.realpathSync(resumeDir).replace(/[^a-zA-Z0-9]/g, '-');
  const sourceDir = path.join(claudeProjectsRoot, slug);
  fs.mkdirSync(sourceDir, { recursive: true });
  const file = path.join(sourceDir, 'ext-nodupe-1.jsonl');
  fs.writeFileSync(file, [
    { type: 'user', message: { content: '第一轮问题' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: '第一轮回答' }] } },
  ].map(l => JSON.stringify(l)).join('\n') + '\n');

  // The fake CLI script also appends to the same real transcript file as it
  // emits — a genuine `claude --resume` process writes straight to this
  // exact file (real_config_dir means no isolated copy), which is exactly
  // the condition this fix depends on: synced_lines must catch up to that
  // growth the moment the turn finishes, not wait for the next sweep to
  // "discover" it and re-import (duplicate) what was already shown live.
  const exec = makeExecutor(cloud, 'mac-nodupe', async (session, opts, text) => {
    await sleep(10);
    fs.appendFileSync(file, [
      { type: 'user', message: { content: text } },
      { type: 'assistant', message: { content: [{ type: 'text', text: '继续之后的真实回复' }] } },
    ].map(l => JSON.stringify(l)).join('\n') + '\n');
    opts.onMessage({ type: 'assistant', message: { content: [{ type: 'text', text: '继续之后的真实回复' }] } });
    opts.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 100, num_turns: 1, is_error: false });
    session.busy = false;
  });
  exec.config.claudeProjectsRoot = claudeProjectsRoot;
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');

  const res = await cloud.api('POST', '/api/tasks', {
    title: '继续', spec: '继续之前聊的', nodeId: 'mac-nodupe', resumeSessionId: 'ext-nodupe-1', repoUrl: resumeDir,
  });
  const taskId = res.body.task.id;
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'review', 5000, 'review after turn 1');

  // Same check the periodic idle sweeper runs every ~60s — must be a no-op
  // right after a normal live turn, not rediscover it as "external" growth.
  exec.manager._sweepExternalGrowth();
  await sleep(50);

  const msgs = await cloud.api('GET', `/api/tasks/${taskId}/messages`, {});
  assert.ok(
    !msgs.body.messages.some(m => m.role === 'system' && m.content.text.includes('别处')),
    'the sweep must not treat the turn it just lived through as external growth',
  );
  assert.equal(
    msgs.body.messages.filter(m => m.role === 'assistant' && m.content.text === '继续之后的真实回复').length, 1,
    'the reply appears exactly once, not duplicated',
  );

  exec.manager.shutdown();
  exec.link.stop();
});

test('idle resume: an unprompted error result (CLI chokes resuming before any message is sent) still fails the task', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-idle-spontaneous-error', await sha256Hex('tok-mac-idle-spontaneous-error'), 'user-test', now).run();

  // Unlike makeFakeSessionFactory's script-on-send pattern, this simulates
  // the real, observed case: the CLI itself emits an error result on start(),
  // before ever receiving a turn — task.status is 'idle' at that point, not
  // 'running', which is exactly the gap this test guards against.
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-test-'));
  fs.mkdirSync(path.join(workRoot, 'scratch'), { recursive: true });
  const config = {
    cloudUrl: 'wss://fake', nodeId: 'mac-idle-spontaneous-error', nodeToken: 'tok-mac-idle-spontaneous-error',
    provider: { baseUrl: 'x', apiKey: 'y' },
    maxParallel: 3,
    decisionTimeoutMs: 60_000, idleSessionTimeoutMs: 60_000, workRoot,
  };
  const db = new LocalDb(workRoot);
  const link = new CloudLink(config, db, (cmd) => manager.handleCommand(cmd), cloud.makeSocketFactory('mac-idle-spontaneous-error'));
  const manager = new SessionManager(config, db, (t, s, e) => link.notifyEvent(t, s, e), (opts) => ({
    alive: true, busy: false, sessionId: opts.resumeSessionId, lastActivity: Date.now(),
    start() {
      queueMicrotask(() => opts.onMessage({
        type: 'result', subtype: 'error_during_execution', is_error: true,
        duration_ms: 0, num_turns: 0, total_cost_usd: 0,
      }));
    },
    send() {}, interrupt() {}, kill() {}, recentStderr() { return ''; },
  }));
  link.start();
  await until(() => link.connected, 2000, 'link connect');

  const resumeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-idle-error-dir-'));
  const res = await cloud.api('POST', '/api/tasks', {
    title: '继续', nodeId: 'mac-idle-spontaneous-error', resumeSessionId: 'ext-idle-error-1', repoUrl: resumeDir,
  });
  const taskId = res.body.task.id;

  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'failed', 5000, 'failed');
  assert.match((await core.getTask(cloud.ctx, taskId)).last_error, /error_during_execution/);

  manager.shutdown();
  link.stop();
});

test('resume with no first message: task is created idle (no auto-sent message), then a real message resumes it normally', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-idle-resume', await sha256Hex('tok-mac-idle-resume'), 'user-test', now).run();

  const resumeIds = [];
  const exec = makeExecutor(cloud, 'mac-idle-resume', async (session, opts) => {
    resumeIds.push(opts.resumeSessionId);
    await sleep(10);
    opts.onMessage({ type: 'assistant', message: { content: [{ type: 'text', text: '继续了' }] } });
    opts.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 100, num_turns: 1, is_error: false });
    session.busy = false;
  });
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');

  // No spec at all — allowed only because resumeSessionId is set. Still needs
  // a real directory to resume in (see the resume-flow test above).
  const resumeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-idle-resume-dir-'));
  const res = await cloud.api('POST', '/api/tasks', {
    title: '继续之前的会话', nodeId: 'mac-idle-resume', resumeSessionId: 'ext-idle-1', repoUrl: resumeDir,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const taskId = res.body.task.id;

  // Reaches 'idle' (CLI spawned and resumed, but nothing sent yet) — never 'running'.
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'idle', 5000, 'idle');
  const midMsgs = await cloud.api('GET', `/api/tasks/${taskId}/messages`, {});
  assert.equal(midMsgs.body.messages.length, 0, 'no message was auto-sent');

  // Sending a real message later resumes cleanly via the normal userMessage() path.
  await cloud.api('POST', `/api/tasks/${taskId}/message`, { text: '接着上次说的' });
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'review', 5000, 'review');
  assert.deepEqual(resumeIds, ['ext-idle-1'], 'resumed with the original external session id');
  const finalMsgs = await cloud.api('GET', `/api/tasks/${taskId}/messages`, {});
  assert.ok(finalMsgs.body.messages.some(m => m.role === 'assistant' && m.content.text === '继续了'));

  exec.manager.shutdown();
  exec.link.stop();
});

test('resync: an idle resumed task picks up new content someone appended to the original external transcript', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-resync', await sha256Hex('tok-mac-resync'), 'user-test', now).run();

  // Fake ~/.claude/projects-shaped tree, same as the history-import test —
  // this is the ORIGINAL external file, not AgentHub's isolated copy, since
  // that's what someone running `claude --resume` directly in a terminal
  // (outside AgentHub entirely) would keep appending to.
  const claudeProjectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-fake-claude-projects-resync-'));
  const resumeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-resync-dir-'));
  const slug = fs.realpathSync(resumeDir).replace(/[^a-zA-Z0-9]/g, '-');
  const sourceDir = path.join(claudeProjectsRoot, slug);
  fs.mkdirSync(sourceDir, { recursive: true });
  const file = path.join(sourceDir, 'ext-resync-1.jsonl');
  fs.writeFileSync(file, [
    { type: 'user', message: { content: '第一轮问题' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: '第一轮回答' }] } },
  ].map(l => JSON.stringify(l)).join('\n') + '\n');

  const exec = makeExecutor(cloud, 'mac-resync', async (session, opts) => {
    await sleep(10);
    opts.onMessage({ type: 'assistant', message: { content: [{ type: 'text', text: '恢复后的回复' }] } });
    opts.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 100, num_turns: 1, is_error: false });
    session.busy = false;
  });
  exec.config.claudeProjectsRoot = claudeProjectsRoot;
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');

  const res = await cloud.api('POST', '/api/tasks', {
    title: '继续之前的会话', nodeId: 'mac-resync', resumeSessionId: 'ext-resync-1', repoUrl: resumeDir,
  });
  const taskId = res.body.task.id;
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'idle', 5000, 'idle');

  // Resync with nothing new appended yet: a no-op, not an error.
  const noop = await cloud.api('POST', `/api/tasks/${taskId}/resync`, {});
  assert.equal(noop.status, 200);
  await until(async () => {
    const m = await cloud.api('GET', `/api/tasks/${taskId}/messages`, {});
    return m.body.messages.some(x => x.role === 'system' && x.content.text === '没有发现新的历史记录。');
  }, 5000, 'no-op resync message');

  // Someone kept using `claude --resume ext-resync-1` directly, outside
  // AgentHub entirely — appends straight to the original external file.
  fs.appendFileSync(file, [
    { type: 'user', message: { content: '终端里继续问的问题' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: '终端里的回答' }] } },
  ].map(l => JSON.stringify(l)).join('\n') + '\n');

  const resync = await cloud.api('POST', `/api/tasks/${taskId}/resync`, {});
  assert.equal(resync.status, 200);
  await until(async () => {
    const m = await cloud.api('GET', `/api/tasks/${taskId}/messages`, {});
    return m.body.messages.some(x => x.role === 'assistant' && x.content.text === '终端里的回答');
  }, 5000, 'resync picked up new external content');

  const msgs = await cloud.api('GET', `/api/tasks/${taskId}/messages`, {});
  const userTexts = msgs.body.messages.filter(m => m.role === 'user').map(m => m.content.text);
  assert.ok(userTexts.includes('终端里继续问的问题'));
  // '第一轮问题' was already shown by _importHistory's own preview at task
  // adoption time (baselining synced_lines) — resync must not repeat it.
  assert.equal(userTexts.filter(t => t === '第一轮问题').length, 1, 'already-imported content not duplicated by resync');

  // A second resync with no further growth is a clean no-op again.
  const seqBefore = (await cloud.api('GET', `/api/tasks/${taskId}/messages`, {})).body.messages.length;
  await cloud.api('POST', `/api/tasks/${taskId}/resync`, {});
  await sleep(100);
  const seqAfter = (await cloud.api('GET', `/api/tasks/${taskId}/messages`, {})).body.messages.length;
  assert.equal(seqAfter, seqBefore + 1, 'only the new no-op system message is appended');

  // Resync is rejected once the task is no longer idle.
  await cloud.api('POST', `/api/tasks/${taskId}/message`, { text: '接着说' });
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'review', 5000, 'review');
  const rejected = await cloud.api('POST', `/api/tasks/${taskId}/resync`, {});
  assert.equal(rejected.status, 409);

  exec.manager.shutdown();
  exec.link.stop();
});

test('tasks: creating a task with neither spec nor resumeSessionId is rejected', async () => {
  const cloud = makeCloud();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-no-spec', await sha256Hex('tok-mac-no-spec'), 'user-test', Date.now()).run();
  const res = await cloud.api('POST', '/api/tasks', { title: 't', nodeId: 'mac-no-spec' });
  assert.equal(res.status, 400);
});

test('history import: adopting an external session replays its transcript into the cloud message log', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-import', await sha256Hex('tok-mac-import'), 'user-test', now).run();

  // A fake ~/.claude/projects-shaped tree the executor will import from —
  // never the real home directory (config.claudeProjectsRoot overrides it).
  const claudeProjectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-fake-claude-projects-'));
  const sourceDir = path.join(claudeProjectsRoot, 'some-project-slug');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'ext-history-1.jsonl'), [
    { type: 'mode', mode: 'normal' },
    { type: 'user', message: { content: '之前问过的问题' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: '之前的回答' } ] } },
  ].map(l => JSON.stringify(l)).join('\n') + '\n');

  let capturedOpts = null;
  const exec = makeExecutor(cloud, 'mac-import', async (session, opts) => {
    capturedOpts = opts;
    await sleep(10);
    opts.onMessage({ type: 'assistant', message: { content: [{ type: 'text', text: '新的回复' }] } });
    opts.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 100, num_turns: 1, is_error: false });
    session.busy = false;
  });
  exec.config.claudeProjectsRoot = claudeProjectsRoot;
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');

  const resumeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-import-resume-dir-'));
  const res = await cloud.api('POST', '/api/tasks', {
    title: '继续', spec: '继续之前聊的', nodeId: 'mac-import', resumeSessionId: 'ext-history-1', repoUrl: resumeDir,
  });
  const taskId = res.body.task.id;

  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'review', 5000, 'review');

  const msgs = await cloud.api('GET', `/api/tasks/${taskId}/messages`, {});
  const roles = msgs.body.messages.map(m => `${m.role}:${JSON.stringify(m.content)}`);
  // imported history lands before the live conversation, in order
  const importedUserIdx = roles.findIndex(r => r.includes('之前问过的问题'));
  const importedAssistantIdx = roles.findIndex(r => r.includes('之前的回答'));
  const liveReplyIdx = roles.findIndex(r => r.includes('新的回复'));
  assert.ok(importedUserIdx >= 0 && importedAssistantIdx > importedUserIdx, 'imported history present, in order');
  assert.ok(liveReplyIdx > importedAssistantIdx, 'live conversation comes after the imported history');
  assert.ok(msgs.body.messages.some(m => m.role === 'system' && m.content.text.includes('导入的历史会话')), 'a marker note brackets the import');

  // Adopted sessions resume directly against the real external file (real_config_dir)
  // — no isolated copy gets created anymore, and the session was told to skip
  // CLAUDE_CONFIG_DIR entirely (see session.mjs).
  const resumeSlug = fs.realpathSync(resumeDir).replace(/[^a-zA-Z0-9]/g, '-');
  const resumeCopy = path.join(exec.workRoot, 'claude-config', 'projects', resumeSlug, 'ext-history-1.jsonl');
  assert.ok(!fs.existsSync(resumeCopy), 'no isolated copy created for an adopted session');
  assert.equal(capturedOpts.realConfigDir, true, 'session told to use the real ~/.claude, not the isolated copy');

  exec.manager.shutdown();
  exec.link.stop();
});

test('real_config_dir: an adopted session auto-imports growth from outside AgentHub before every send, and never keeps a session warm between turns', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-realcfg', await sha256Hex('tok-mac-realcfg'), 'user-test', now).run();

  const claudeProjectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-fake-claude-projects-realcfg-'));
  const resumeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-realcfg-resume-dir-'));
  const slug = fs.realpathSync(resumeDir).replace(/[^a-zA-Z0-9]/g, '-');
  const sourceDir = path.join(claudeProjectsRoot, slug);
  fs.mkdirSync(sourceDir, { recursive: true });
  const file = path.join(sourceDir, 'ext-realcfg-1.jsonl');
  fs.writeFileSync(file, [
    { type: 'user', message: { content: '第一轮问题' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: '第一轮回答' }] } },
  ].map(l => JSON.stringify(l)).join('\n') + '\n');

  let spawnCount = 0;
  let reply = 'n/a';
  const exec = makeExecutor(cloud, 'mac-realcfg', async (session, opts) => {
    spawnCount++;
    await sleep(10);
    opts.onMessage({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } });
    opts.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 100, num_turns: 1, is_error: false });
    session.busy = false;
  });
  exec.config.claudeProjectsRoot = claudeProjectsRoot;
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');

  const res = await cloud.api('POST', '/api/tasks', {
    title: '继续', spec: '继续之前聊的', nodeId: 'mac-realcfg', resumeSessionId: 'ext-realcfg-1', repoUrl: resumeDir,
  });
  const taskId = res.body.task.id;
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'review', 5000, 'review after turn 1');
  assert.equal(spawnCount, 1);

  // The session must not linger — a second send should trigger a fresh spawn.
  assert.equal(exec.manager.sessions.has(taskId), false, 'no session kept warm after a turn settles');

  // Someone appended to the real file directly (VS Code/terminal), with no
  // manual "刷新历史" click — this must show up automatically on next send.
  fs.appendFileSync(file, [
    { type: 'user', message: { content: '在 VSCode 里问的' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: '在 VSCode 里的回答' }] } },
  ].map(l => JSON.stringify(l)).join('\n') + '\n');

  reply = '第二轮回答';
  await cloud.api('POST', `/api/tasks/${taskId}/message`, { text: '继续' });
  await until(async () => {
    const m = await cloud.api('GET', `/api/tasks/${taskId}/messages`, {});
    return m.body.messages.some(x => x.role === 'assistant' && x.content.text === '第二轮回答');
  }, 5000, 'second turn landed');
  assert.equal(spawnCount, 2, 'a fresh session was spawned for the second message, not reused');

  const msgs = await cloud.api('GET', `/api/tasks/${taskId}/messages`, {});
  assert.ok(msgs.body.messages.some(m => m.role === 'assistant' && m.content.text === '在 VSCode 里的回答'),
    'content added outside AgentHub was auto-imported with no manual resync click');

  exec.manager.shutdown();
  exec.link.stop();
});

test('switchSession: adopts the externally-found session\'s own cwd, not whatever dir the task already had', async () => {
  // Found live: a task's `dir` stayed pinned to an old worktree from a
  // completely unrelated earlier session; after switching onto an
  // externally-created session, every subsequent turn failed with
  // "No conversation found with session ID: ..." — claude --resume only
  // ever finds a session from the exact cwd it was created in, and
  // switchSession never used to update `dir` at all.
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-switch-cwd', await sha256Hex('tok-mac-switch-cwd'), 'user-test', now).run();

  const claudeProjectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-fake-claude-projects-switchcwd-'));
  const realExternalCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-real-external-cwd-'));
  const sourceDir = path.join(claudeProjectsRoot, 'some-other-project-slug');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'ext-real-cwd-1.jsonl'), [
    { type: 'user', cwd: realExternalCwd, message: { content: '外部会话里的问题' } },
    { type: 'assistant', cwd: realExternalCwd, message: { content: [{ type: 'text', text: '外部会话里的回答' }] } },
  ].map(l => JSON.stringify(l)).join('\n') + '\n');

  const exec = makeExecutor(cloud, 'mac-switch-cwd', async (session, opts) => {
    await sleep(10);
    opts.onMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } });
    opts.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 100, num_turns: 1, is_error: false });
    session.busy = false;
  });
  exec.config.claudeProjectsRoot = claudeProjectsRoot;
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');

  // A plain scratch task — its `dir` is some unrelated local scratch/worktree
  // path, nothing to do with realExternalCwd.
  const res = await cloud.api('POST', '/api/tasks', { title: 't', spec: 'x', nodeId: 'mac-switch-cwd' });
  const taskId = res.body.task.id;
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'review', 5000, 'review');
  const before = exec.manager.db.getTask(taskId);
  assert.notEqual(before.dir, realExternalCwd);

  await cloud.api('POST', `/api/tasks/${taskId}/switch-session`, { sessionId: 'ext-real-cwd-1' });
  await until(() => exec.manager.db.getTask(taskId)?.dir === realExternalCwd, 2000, 'dir adopted from the session\'s own cwd');

  exec.manager.shutdown();
  exec.link.stop();
});

test('switchSession: kills a live session and the next user message resumes with the new id', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-switch-live', await sha256Hex('tok-mac-switch-live'), 'user-test', now).run();

  const resumeIds = [];
  const exec = makeExecutor(cloud, 'mac-switch-live', async (session, opts) => {
    resumeIds.push(opts.resumeSessionId);
    // first turn: never finishes -> stays "running" so we can switch mid-flight
    if (resumeIds.length === 1) return;
    await sleep(10); // let _spawn()'s own setStatus('running') land before the result event does
    opts.onMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } });
    opts.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 100, num_turns: 1, is_error: false });
    session.busy = false;
  });
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');

  const res = await cloud.api('POST', '/api/tasks', { title: 't', spec: 'x', nodeId: 'mac-switch-live' });
  const taskId = res.body.task.id;
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'running', 5000, 'running');
  assert.equal(exec.manager.sessions.get(taskId)?.alive, true);

  await cloud.api('POST', `/api/tasks/${taskId}/switch-session`, { sessionId: 'ext-switched-1' });
  await until(() => !exec.manager.sessions.has(taskId), 2000, 'old session killed');
  assert.equal((await core.getTask(cloud.ctx, taskId)).session_id, 'ext-switched-1');

  await cloud.api('POST', `/api/tasks/${taskId}/message`, { text: '继续' });
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'review', 5000, 'review after switch');
  assert.equal(resumeIds[1], 'ext-switched-1');

  exec.manager.shutdown();
  exec.link.stop();
});

test('teams (admin): non-admin gets 403 on every admin team route', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind('user-test', 'plain-user', 'x', 0, now).run();

  const list = await cloud.api('GET', '/api/admin/teams', {});
  assert.equal(list.status, 403);
  const create = await cloud.api('POST', '/api/admin/teams', { name: 'Alpha' });
  assert.equal(create.status, 403);
});

test('teams (admin): create team, add/remove members by username, delete team', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind('user-test', 'admin-user', 'x', 1, now).run();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind('user-bob', 'bob', 'x', 0, now).run();

  const create = await cloud.api('POST', '/api/admin/teams', { name: 'Alpha 小组' });
  assert.equal(create.status, 200);
  const teamId = create.body.team.id;

  // The creating admin is auto-joined as owner — creating a team you then
  // can't see in your own switcher was the actual bug this guards against.
  const listAfterCreate = await cloud.api('GET', '/api/admin/teams', {});
  assert.equal(listAfterCreate.status, 200);
  assert.equal(listAfterCreate.body.teams.length, 1);
  assert.equal(listAfterCreate.body.teams[0].members.length, 1);
  assert.equal(listAfterCreate.body.teams[0].members[0].username, 'admin-user');
  assert.equal(listAfterCreate.body.teams[0].members[0].role, 'owner');
  const creatorTeams = await cloud.api('GET', '/api/teams', {});
  assert.equal(creatorTeams.body.teams.length, 1, 'creator sees their own team via the self-service route');

  // Unknown username is rejected, not silently ignored.
  const badMember = await cloud.api('POST', `/api/admin/teams/${teamId}/members`, { username: 'nobody' });
  assert.equal(badMember.status, 404);

  const addMember = await cloud.api('POST', `/api/admin/teams/${teamId}/members`, { username: 'bob', role: 'member' });
  assert.equal(addMember.status, 200);

  const listWithMember = await cloud.api('GET', '/api/admin/teams', {});
  assert.equal(listWithMember.body.teams[0].members.length, 2, 'creator + bob');
  const bobRow = listWithMember.body.teams[0].members.find(m => m.username === 'bob');
  assert.equal(bobRow.role, 'member');

  // Re-adding the same user updates role instead of erroring or duplicating.
  const promote = await cloud.api('POST', `/api/admin/teams/${teamId}/members`, { username: 'bob', role: 'owner' });
  assert.equal(promote.status, 200);
  const listPromoted = await cloud.api('GET', '/api/admin/teams', {});
  assert.equal(listPromoted.body.teams[0].members.length, 2, 'no duplicate row from re-adding bob');
  assert.equal(listPromoted.body.teams[0].members.find(m => m.username === 'bob').role, 'owner');

  // bob himself can see the team via the self-service (non-admin) route.
  const bobTeams = await core.api({ ...cloud.ctx, userId: 'user-bob' }, 'GET', '/api/teams', {});
  assert.equal(bobTeams.status, 200);
  assert.equal(bobTeams.body.teams.length, 1);
  assert.equal(bobTeams.body.teams[0].name, 'Alpha 小组');
  assert.equal(bobTeams.body.teams[0].role, 'owner');

  // A user with no memberships sees an empty list, not an error.
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind('user-carol', 'carol', 'x', 0, now).run();
  const carolTeams = await core.api({ ...cloud.ctx, userId: 'user-carol' }, 'GET', '/api/teams', {});
  assert.equal(carolTeams.body.teams.length, 0);

  const removeMember = await cloud.api('DELETE', `/api/admin/teams/${teamId}/members/user-bob`, {});
  assert.equal(removeMember.status, 200);
  const listAfterRemove = await cloud.api('GET', '/api/admin/teams', {});
  assert.equal(listAfterRemove.body.teams[0].members.length, 1, 'only the creator remains');

  const deleteTeam = await cloud.api('DELETE', `/api/admin/teams/${teamId}`, {});
  assert.equal(deleteTeam.status, 200);
  const listAfterDelete = await cloud.api('GET', '/api/admin/teams', {});
  assert.equal(listAfterDelete.body.teams.length, 0);
});

test('teams (admin): deleting a project cleans up its task/node membership rows too, not just team_members', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind('user-test', 'admin-user', 'x', 1, now).run();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('alice-node', await sha256Hex('tok-alice-node'), 'user-test', now).run();

  const create = await cloud.api('POST', '/api/admin/teams', { name: '要被删除的项目' });
  const teamId = create.body.team.id;
  await cloud.api('POST', `/api/nodes/alice-node/teams/${teamId}`, {});
  const taskRes = await core.api({ ...cloud.ctx, teamId }, 'POST', '/api/tasks', { title: '项目内的对话', spec: 'x', nodeId: 'alice-node' });
  const taskId = taskRes.body.task.id;

  // Sanity: both are genuinely tied to this team before deleting it.
  assert.deepEqual((await cloud.db.prepare('SELECT team_id FROM node_teams WHERE node_id = ?').bind('alice-node').all()).results.map(r => r.team_id), [teamId]);
  assert.deepEqual((await cloud.db.prepare('SELECT team_id FROM task_teams WHERE task_id = ?').bind(taskId).all()).results.map(r => r.team_id), [teamId]);

  const del = await cloud.api('DELETE', `/api/admin/teams/${teamId}`, {});
  assert.equal(del.status, 200);

  // Found live: without this cleanup, the node/task keep a dangling
  // membership row pointing at a team_id that no longer exists in `teams` —
  // invisible in personal view (still disqualified by that row) *and*
  // invisible in every real team view (the team itself is gone). The fix
  // must leave both back in personal view, not merely stop erroring.
  assert.equal((await cloud.db.prepare('SELECT COUNT(*) AS n FROM node_teams WHERE node_id = ?').bind('alice-node').first()).n, 0);
  assert.equal((await cloud.db.prepare('SELECT COUNT(*) AS n FROM task_teams WHERE task_id = ?').bind(taskId).first()).n, 0);
  const personalNodes = await cloud.api('GET', '/api/nodes', {});
  assert.ok(personalNodes.body.nodes.some(n => n.id === 'alice-node'));
  const personalTasks = await cloud.api('GET', '/api/tasks', {});
  assert.ok(personalTasks.body.tasks.some(t => t.id === taskId));
});

// ---- Phase 2 (redesigned): a task/node is explicitly bound to a team_id
// (or null = personal) at creation time — NOT inferred from who the owner
// happens to share a team with. The original version resolved a team header
// into "every member's data", which meant a user's purely personal
// tasks/nodes leaked into every team they belonged to (found live). ----

test('team sharing: a task explicitly created for a team is visible to teammates; personal tasks never leak into any team view', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .bind('user-test', 'alice', 'x', now).run();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .bind('user-bob', 'bob', 'x', now).run();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .bind('user-eve', 'eve', 'x', now).run(); // exists but not on the team

  await cloud.db.prepare('INSERT INTO teams (id, name, created_at) VALUES (?, ?, ?)').bind('team-1', 'Alpha', now).run();
  await cloud.db.prepare('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
    .bind('team-1', 'user-test', 'owner', now).run();
  await cloud.db.prepare('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
    .bind('team-1', 'user-bob', 'member', now).run();

  // bob's node, bound to the team at enrollment (as registering with
  // X-Team-Id would do) — and a second, kept personal.
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('bob-team-node', await sha256Hex('tok-bob-team-node'), 'user-bob', now).run();
  await cloud.db.prepare('INSERT INTO node_teams (node_id, team_id) VALUES (?, ?)').bind('bob-team-node', 'team-1').run();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('bob-personal-node', await sha256Hex('tok-bob-personal-node'), 'user-bob', now).run();

  // bob creates one task while viewing the team (lands with team_id set)...
  const teamTask = await core.api({ ...cloud.ctx, userId: 'user-bob', teamId: 'team-1' }, 'POST', '/api/tasks',
    { title: '团队任务', spec: 'x', nodeId: 'bob-team-node' });
  assert.equal(teamTask.status, 200);
  assert.equal(teamTask.body.task.team_id, 'team-1');

  // ...and a completely separate personal one, on his own personal node.
  const personalTask = await core.api({ ...cloud.ctx, userId: 'user-bob' }, 'POST', '/api/tasks',
    { title: '鲍勃的私人任务', spec: 'x', nodeId: 'bob-personal-node' });
  assert.equal(personalTask.status, 200);
  assert.equal(personalTask.body.task.team_id, null);

  // Personal view (no X-Team-Id): alice sees only her own tasks — none, and
  // definitely not bob's personal task.
  const personal = await cloud.api('GET', '/api/tasks', {});
  assert.equal(personal.body.tasks.length, 0, 'personal view unaffected by team membership');

  // Team view: alice sees exactly the team-bound task, not bob's personal one.
  const teamView = await core.api({ ...cloud.ctx, teamId: 'team-1' }, 'GET', '/api/tasks', {});
  assert.equal(teamView.status, 200);
  assert.equal(teamView.body.tasks.length, 1);
  assert.equal(teamView.body.tasks[0].title, '团队任务');

  // bob, back in his OWN personal view, sees only his personal task — his
  // team task doesn't bleed into his personal list either (the reported bug:
  // "我现在个人的对话和节点，在每一个团队都能看见").
  const bobPersonal = await core.api({ ...cloud.ctx, userId: 'user-bob' }, 'GET', '/api/tasks', {});
  assert.equal(bobPersonal.body.tasks.length, 1);
  assert.equal(bobPersonal.body.tasks[0].title, '鲍勃的私人任务');

  // eve exists but isn't on the team — passing an arbitrary team id is
  // rejected outright, not silently scoped to nothing.
  const notMember = await core.api({ ...cloud.ctx, userId: 'user-eve', teamId: 'team-1' }, 'GET', '/api/tasks', {});
  assert.equal(notMember.status, 403);
});

test('team sharing: sending a message is open to any teammate, but every other mutating action stays creator-only', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .bind('user-test', 'alice', 'x', now).run();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .bind('user-bob', 'bob', 'x', now).run();
  await cloud.db.prepare('INSERT INTO teams (id, name, created_at) VALUES (?, ?, ?)').bind('team-1', 'Alpha', now).run();
  await cloud.db.prepare('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
    .bind('team-1', 'user-test', 'owner', now).run();
  await cloud.db.prepare('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
    .bind('team-1', 'user-bob', 'member', now).run();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-teamperm', await sha256Hex('tok-mac-teamperm'), 'user-test', now).run();
  await cloud.db.prepare('INSERT INTO node_teams (node_id, team_id) VALUES (?, ?)').bind('mac-teamperm', 'team-1').run();

  const exec = makeExecutor(cloud, 'mac-teamperm', async (session, opts) => {
    await sleep(10);
    opts.onMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } });
    opts.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 100, num_turns: 1, is_error: false });
    session.busy = false;
  });
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');

  const res = await core.api({ ...cloud.ctx, teamId: 'team-1' }, 'POST', '/api/tasks', { title: 'Alice 的任务', spec: '开始', nodeId: 'mac-teamperm' });
  const taskId = res.body.task.id;
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'review', 5000, 'review');

  // bob, viewing the shared team, can read messages...
  const bobRead = await core.api({ ...cloud.ctx, userId: 'user-bob', teamId: 'team-1' }, 'GET', `/api/tasks/${taskId}/messages`, {});
  assert.equal(bobRead.status, 200);
  assert.ok(bobRead.body.messages.length > 0);

  // ...and can send a message — a shared conversation only the creator could
  // talk to wouldn't be much of a shared conversation.
  const bobMessage = await core.api({ ...cloud.ctx, userId: 'user-bob', teamId: 'team-1' }, 'POST', `/api/tasks/${taskId}/message`, { text: 'hi from bob' });
  assert.equal(bobMessage.status, 200);
  // The message respawned a whole second turn — wait for its *own* 'result'
  // (not just status==='review', which was already true before bob's
  // message and could false-positive-match before the new turn even starts)
  // so later task-level assertions don't race a still-running turn.
  await until(async () => {
    const m = await core.api({ ...cloud.ctx, userId: 'user-bob', teamId: 'team-1' }, 'GET', `/api/tasks/${taskId}/messages`, {});
    return m.body.messages.filter(x => x.role === 'result').length >= 2;
  }, 5000, "bob's message triggered and completed its own turn");

  // ...but every other mutating action is still rejected, team view or not.
  const bobDone = await core.api({ ...cloud.ctx, userId: 'user-bob', teamId: 'team-1' }, 'POST', `/api/tasks/${taskId}/done`, {});
  assert.equal(bobDone.status, 403);
  const bobArchive = await core.api({ ...cloud.ctx, userId: 'user-bob', teamId: 'team-1' }, 'POST', `/api/tasks/${taskId}/archive`, {});
  assert.equal(bobArchive.status, 403);

  // bob outside the team (personal view) doesn't even get to see it exists.
  const bobOutside = await core.api({ ...cloud.ctx, userId: 'user-bob' }, 'GET', `/api/tasks/${taskId}/messages`, {});
  assert.equal(bobOutside.status, 404);

  // the actual creator can still do everything, unaffected by any of this —
  // creator status isn't gated on currently viewing the team either.
  const aliceDone = await cloud.api('POST', `/api/tasks/${taskId}/done`, {});
  assert.equal(aliceDone.status, 200);

  exec.manager.shutdown();
  exec.link.stop();
});

test('team sharing: a team member can create a task on a node bound to that team, but not on a teammate\'s personal node', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .bind('user-test', 'alice', 'x', now).run();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .bind('user-bob', 'bob', 'x', now).run();
  await cloud.db.prepare('INSERT INTO teams (id, name, created_at) VALUES (?, ?, ?)').bind('team-1', 'Alpha', now).run();
  await cloud.db.prepare('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
    .bind('team-1', 'user-test', 'owner', now).run();
  await cloud.db.prepare('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
    .bind('team-1', 'user-bob', 'member', now).run();
  // alice's node explicitly bound to the team at enrollment...
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('alice-team-node', await sha256Hex('tok-alice-team-node'), 'user-test', now).run();
  await cloud.db.prepare('INSERT INTO node_teams (node_id, team_id) VALUES (?, ?)').bind('alice-team-node', 'team-1').run();
  // ...and a second node of hers kept personal, same team membership either way.
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('alice-personal-node', await sha256Hex('tok-alice-personal-node'), 'user-test', now).run();

  // bob, viewing the team, can create a task on the team-bound node.
  const allowed = await core.api({ ...cloud.ctx, userId: 'user-bob', teamId: 'team-1' }, 'POST', '/api/tasks',
    { title: 't', spec: 'x', nodeId: 'alice-team-node' });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.task.owner_user_id, 'user-bob', 'task is still owned/created by bob, not alice');
  assert.equal(allowed.body.task.team_id, 'team-1');

  // bob, still viewing the team, is rejected on alice's personal node — being
  // on a shared team no longer grants access to a teammate's personal stuff.
  const rejectedPersonal = await core.api({ ...cloud.ctx, userId: 'user-bob', teamId: 'team-1' }, 'POST', '/api/tasks',
    { title: 't', spec: 'x', nodeId: 'alice-personal-node' });
  assert.equal(rejectedPersonal.status, 400);

  // And without team scope at all, bob can't touch either node.
  const rejectedNoScope = await core.api({ ...cloud.ctx, userId: 'user-bob' }, 'POST', '/api/tasks',
    { title: 't', spec: 'x', nodeId: 'alice-team-node' });
  assert.equal(rejectedNoScope.status, 400);

  // bob's node list, viewed as the team, includes only the team-bound node.
  const nodeList = await core.api({ ...cloud.ctx, userId: 'user-bob', teamId: 'team-1' }, 'GET', '/api/nodes', {});
  assert.equal(nodeList.body.nodes.length, 1);
  assert.equal(nodeList.body.nodes[0].id, 'alice-team-node');
});

test('node registration: X-Team-Id at enroll time binds the node to that project; re-enrolling adds another without removing existing ones', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .bind('user-test', 'alice', 'x', now).run();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .bind('user-bob', 'bob', 'x', now).run(); // not a member of team-1
  await cloud.db.prepare('INSERT INTO teams (id, name, created_at) VALUES (?, ?, ?)').bind('team-1', 'Alpha', now).run();
  await cloud.db.prepare('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
    .bind('team-1', 'user-test', 'owner', now).run();

  // No X-Team-Id -> personal node.
  const personalReg = await cloud.api('POST', '/api/nodes', { id: 'node-a', tokenHash: 'hash-a' });
  assert.equal(personalReg.status, 200);
  let rows = (await cloud.db.prepare('SELECT team_id FROM node_teams WHERE node_id = ?').bind('node-a').all()).results;
  assert.equal(rows.length, 0);

  // X-Team-Id from an actual member -> project-bound node.
  const teamReg = await core.api({ ...cloud.ctx, teamId: 'team-1' }, 'POST', '/api/nodes', { id: 'node-b', tokenHash: 'hash-b' });
  assert.equal(teamReg.status, 200);
  rows = (await cloud.db.prepare('SELECT team_id FROM node_teams WHERE node_id = ?').bind('node-b').all()).results;
  assert.deepEqual(rows.map(r => r.team_id), ['team-1']);

  // X-Team-Id from a non-member is rejected outright.
  const notMemberReg = await core.api({ ...cloud.ctx, userId: 'user-bob', teamId: 'team-1' }, 'POST', '/api/nodes', { id: 'node-c', tokenHash: 'hash-c' });
  assert.equal(notMemberReg.status, 403);

  // The personal list is the complete owned-node inventory used by the Add
  // Node modal, even after nodes are shared into projects. It must not omit a
  // node just because the browser currently has a project selected.
  const personalList = await cloud.api('GET', '/api/nodes', {});
  assert.deepEqual(personalList.body.nodes.map(n => n.id).sort(), ['node-a', 'node-b']);
  const projectNode = personalList.body.nodes.find(n => n.id === 'node-b');
  assert.deepEqual(projectNode.teamIds, ['team-1']);
  assert.equal(projectNode.owner_user_id, 'user-test');
  assert.equal(typeof projectNode.status, 'string');
  assert.equal(typeof projectNode.labels, 'string');

  // Re-enrolling node-a with a team header now adds that project too —
  // additive, not a replace (reinstalling shouldn't clobber existing sharing).
  // This also intentionally rotates the token, which is why AddNodeModal must
  // distinguish a repair/re-enrollment from adding a genuinely new node.
  const rebind = await core.api({ ...cloud.ctx, teamId: 'team-1' }, 'POST', '/api/nodes', { id: 'node-a', tokenHash: 'hash-a2' });
  assert.equal(rebind.status, 200);
  const reboundNode = await cloud.db.prepare('SELECT token_hash FROM nodes WHERE id = ?').bind('node-a').first();
  assert.equal(reboundNode.token_hash, 'hash-a2');
  rows = (await cloud.db.prepare('SELECT team_id FROM node_teams WHERE node_id = ?').bind('node-a').all()).results;
  assert.deepEqual(rows.map(r => r.team_id), ['team-1']);

  // A different account cannot take over either existing logical ID.
  const foreignCollision = await core.api({ ...cloud.ctx, userId: 'user-bob' }, 'POST', '/api/nodes', { id: 'node-a', tokenHash: 'hash-bob' });
  assert.equal(foreignCollision.status, 409);
  assert.equal((await cloud.db.prepare('SELECT token_hash FROM nodes WHERE id = ?').bind('node-a').first()).token_hash, 'hash-a2');
});

// "Add node" no longer asks anyone to invent an id — the installer derives one
// from hostname+username and sends autoName, so two machines that happen to
// derive the same id must not silently steal each other's identity. Without
// this, the second box rotates the first one's token and knocks it offline
// permanently: it can't re-authenticate, and nothing anywhere says why.
test('node enrollment: autoName steps past a collision instead of hijacking the node holding it', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind('user-test', 'tester', 'x', 0, now).run();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind('user-bob', 'bob', 'x', 0, now).run();

  const first = await cloud.api('POST', '/api/nodes', { id: 'ubuntu-root', tokenHash: 'hash-1', autoName: true });
  assert.equal(first.status, 200);
  assert.equal(first.body.id, 'ubuntu-root');

  // Same account, same derived id, a genuinely different machine.
  const second = await cloud.api('POST', '/api/nodes', { id: 'ubuntu-root', tokenHash: 'hash-2', autoName: true });
  assert.equal(second.status, 200);
  assert.equal(second.body.id, 'ubuntu-root-2', 'server must hand back the id it actually registered');
  const third = await cloud.api('POST', '/api/nodes', { id: 'ubuntu-root', tokenHash: 'hash-3', autoName: true });
  assert.equal(third.body.id, 'ubuntu-root-3');

  // The original box keeps its token: it is still online and still itself.
  assert.equal((await cloud.db.prepare('SELECT token_hash FROM nodes WHERE id = ?').bind('ubuntu-root').first()).token_hash, 'hash-1');
  assert.equal((await cloud.db.prepare('SELECT token_hash FROM nodes WHERE id = ?').bind('ubuntu-root-2').first()).token_hash, 'hash-2');

  // Collisions are avoided across accounts too, so autoName never 409s and a
  // stranger's node name can't block someone else's install.
  const otherAccount = await core.api({ ...cloud.ctx, userId: 'user-bob' }, 'POST', '/api/nodes', { id: 'ubuntu-root', tokenHash: 'hash-bob', autoName: true });
  assert.equal(otherAccount.status, 200);
  assert.equal(otherAccount.body.id, 'ubuntu-root-4');
  assert.equal((await cloud.db.prepare('SELECT owner_user_id FROM nodes WHERE id = ?').bind('ubuntu-root').first()).owner_user_id, 'user-test');

  // Repair keeps working: an explicit id (no autoName) still re-enrolls that
  // exact node and rotates its token on purpose.
  const repair = await cloud.api('POST', '/api/nodes', { id: 'ubuntu-root', tokenHash: 'hash-repaired' });
  assert.equal(repair.status, 200);
  assert.equal(repair.body.id, 'ubuntu-root');
  assert.equal((await cloud.db.prepare('SELECT token_hash FROM nodes WHERE id = ?').bind('ubuntu-root').first()).token_hash, 'hash-repaired');
});

// ---- Phase 3: admin user management + global overview ----

test('admin users: non-admin gets 403 on every admin user-management route', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind('user-test', 'plain-user', 'x', 0, now).run();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind('user-bob', 'bob', 'x', 0, now).run();

  assert.equal((await cloud.api('GET', '/api/admin/users', {})).status, 403);
  assert.equal((await cloud.api('POST', '/api/admin/users/user-bob/disable', {})).status, 403);
  assert.equal((await cloud.api('POST', '/api/admin/users/user-bob/enable', {})).status, 403);
  assert.equal((await cloud.api('POST', '/api/admin/users/user-bob/reset-password', { password: 'newpassword' })).status, 403);
  assert.equal((await cloud.api('POST', '/api/admin/users/user-bob/toggle-admin', {})).status, 403);
  assert.equal((await cloud.api('GET', '/api/admin/overview', {})).status, 403);
});

test('admin users: list shows team memberships + task/node counts', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind('user-test', 'admin-user', 'x', 1, now).run();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind('user-bob', 'bob', 'x', 0, now).run();
  await cloud.db.prepare('INSERT INTO teams (id, name, created_at) VALUES (?, ?, ?)').bind('team-1', 'Alpha', now).run();
  await cloud.db.prepare('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
    .bind('team-1', 'user-bob', 'member', now).run();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('bob-node', await sha256Hex('tok-bob-node'), 'user-bob', now).run();
  const bobTask = await core.api({ ...cloud.ctx, userId: 'user-bob' }, 'POST', '/api/tasks',
    { title: 't', spec: 'x', nodeId: 'bob-node' });
  assert.equal(bobTask.status, 200);

  const list = await cloud.api('GET', '/api/admin/users', {});
  assert.equal(list.status, 200);
  assert.equal(list.body.users.length, 2);
  const bobRow = list.body.users.find(u => u.username === 'bob');
  assert.equal(bobRow.isAdmin, false);
  assert.equal(bobRow.disabled, false);
  assert.equal(bobRow.taskCount, 1);
  assert.equal(bobRow.nodeCount, 1);
  assert.equal(bobRow.teams.length, 1);
  assert.equal(bobRow.teams[0].name, 'Alpha');
});

test('admin users: disable blocks login and kills existing sessions; enable restores both', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind('user-test', 'admin-user', 'x', 1, now).run();
  const reg = await accounts.register(cloud.db, { username: 'bob', password: 'bobpassword' }, now);
  assert.equal(reg.status, 200);
  const bobToken = reg.body.token;
  const bobId = reg.body.user.id;

  // A live session works before disabling.
  assert.equal(await accounts.resolveSession(cloud.db, bobToken), bobId);

  const disable = await cloud.api('POST', `/api/admin/users/${bobId}/disable`, {});
  assert.equal(disable.status, 200);

  // Existing session is now dead, not just future logins.
  assert.equal(await accounts.resolveSession(cloud.db, bobToken), null);
  const loginAfterDisable = await accounts.login(cloud.db, { username: 'bob', password: 'bobpassword' }, now);
  assert.equal(loginAfterDisable.status, 403);

  const enable = await cloud.api('POST', `/api/admin/users/${bobId}/enable`, {});
  assert.equal(enable.status, 200);
  const loginAfterEnable = await accounts.login(cloud.db, { username: 'bob', password: 'bobpassword' }, now);
  assert.equal(loginAfterEnable.status, 200);
});

test('admin users: an admin cannot disable their own account', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind('user-test', 'admin-user', 'x', 1, now).run();
  const res = await cloud.api('POST', '/api/admin/users/user-test/disable', {});
  assert.equal(res.status, 400);
});

test('admin users: reset-password lets the target log in with the new password, not the old one', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind('user-test', 'admin-user', 'x', 1, now).run();
  const reg = await accounts.register(cloud.db, { username: 'bob', password: 'oldpassword' }, now);
  const bobId = reg.body.user.id;

  const tooShort = await cloud.api('POST', `/api/admin/users/${bobId}/reset-password`, { password: 'short' });
  assert.equal(tooShort.status, 400);

  const reset = await cloud.api('POST', `/api/admin/users/${bobId}/reset-password`, { password: 'newpassword123' });
  assert.equal(reset.status, 200);

  const oldLogin = await accounts.login(cloud.db, { username: 'bob', password: 'oldpassword' }, now);
  assert.equal(oldLogin.status, 401);
  const newLogin = await accounts.login(cloud.db, { username: 'bob', password: 'newpassword123' }, now);
  assert.equal(newLogin.status, 200);
});

test('admin users: toggle-admin flips the flag, and refuses to demote the last remaining admin', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind('user-test', 'admin-user', 'x', 1, now).run();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind('user-bob', 'bob', 'x', 0, now).run();

  const promote = await cloud.api('POST', '/api/admin/users/user-bob/toggle-admin', {});
  assert.equal(promote.status, 200);
  let list = await cloud.api('GET', '/api/admin/users', {});
  assert.equal(list.body.users.find(u => u.username === 'bob').isAdmin, true);

  const demoteBob = await cloud.api('POST', '/api/admin/users/user-bob/toggle-admin', {});
  assert.equal(demoteBob.status, 200);
  list = await cloud.api('GET', '/api/admin/users', {});
  assert.equal(list.body.users.find(u => u.username === 'bob').isAdmin, false);

  // Now only 'admin-user' is an admin — demoting them would leave zero.
  const demoteSelf = await cloud.api('POST', '/api/admin/users/user-test/toggle-admin', {});
  assert.equal(demoteSelf.status, 400);
});

test('admin overview: aggregate node/task counts per user, no message content', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind('user-test', 'admin-user', 'x', 1, now).run();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind('user-bob', 'bob', 'x', 0, now).run();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind('bob-node', await sha256Hex('tok-bob-node'), 'user-bob', 'online', now).run();
  const bobTask = await core.api({ ...cloud.ctx, userId: 'user-bob' }, 'POST', '/api/tasks',
    { title: 't', spec: 'x', nodeId: 'bob-node' });
  assert.equal(bobTask.status, 200);

  const overview = await cloud.api('GET', '/api/admin/overview', {});
  assert.equal(overview.status, 200);
  const bobRow = overview.body.overview.find(o => o.username === 'bob');
  assert.equal(bobRow.nodeCount, 1);
  assert.equal(bobRow.nodesOnline, 1);
  assert.ok(bobRow.tasksByStatus.running >= 1 || bobRow.tasksByStatus.queued >= 1, 'has at least one task counted by status');
  assert.equal(JSON.stringify(overview.body).includes('spec'), false, 'no task spec/content leaked into the overview');
});

// ---- move-to-team: rebinding an EXISTING node/task after creation ----

test('node teams: owner can add/remove a node to/from a project; non-owner and non-members are rejected', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .bind('user-test', 'alice', 'x', now).run();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .bind('user-bob', 'bob', 'x', now).run();
  await cloud.db.prepare('INSERT INTO teams (id, name, created_at) VALUES (?, ?, ?)').bind('team-1', 'Alpha', now).run();
  await cloud.db.prepare('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
    .bind('team-1', 'user-test', 'owner', now).run();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('alice-node', await sha256Hex('tok-alice-node'), 'user-test', now).run();

  // bob doesn't own it -> 404, not 403 (don't reveal existence/ownership either way).
  const deniedNotOwner = await core.api({ ...cloud.ctx, userId: 'user-bob' }, 'POST', '/api/nodes/alice-node/teams/team-1', {});
  assert.equal(deniedNotOwner.status, 404);

  // alice, but targeting a team she isn't a member of.
  await cloud.db.prepare('INSERT INTO teams (id, name, created_at) VALUES (?, ?, ?)').bind('team-2', 'Beta', now).run();
  const deniedNotMember = await cloud.api('POST', '/api/nodes/alice-node/teams/team-2', {});
  assert.equal(deniedNotMember.status, 403);

  // alice adds her own personal node to team-1 she's actually in.
  const added = await cloud.api('POST', '/api/nodes/alice-node/teams/team-1', {});
  assert.equal(added.status, 200);
  let rows = (await cloud.db.prepare('SELECT team_id FROM node_teams WHERE node_id = ?').bind('alice-node').all()).results;
  assert.deepEqual(rows.map(r => r.team_id), ['team-1']);

  // it now shows up in team view *and* stays visible in personal view — a
  // node is a machine you own, not a conversation that moves house when
  // shared (unlike tasks, see the team-sharing test above). Found live:
  // reported as "我归属节点到别的项目，个人视角就看不见了" — an owner losing
  // sight of their own machine after sharing it was surprising, not wanted.
  const teamView = await core.api({ ...cloud.ctx, teamId: 'team-1' }, 'GET', '/api/nodes', {});
  assert.equal(teamView.body.nodes.length, 1);
  const personalView = await cloud.api('GET', '/api/nodes', {});
  assert.equal(personalView.body.nodes.length, 1);

  // removing it from the project changes nothing about personal visibility —
  // it was never gone from there to begin with.
  const removed = await cloud.api('DELETE', '/api/nodes/alice-node/teams/team-1', {});
  assert.equal(removed.status, 200);
  rows = (await cloud.db.prepare('SELECT team_id FROM node_teams WHERE node_id = ?').bind('alice-node').all()).results;
  assert.equal(rows.length, 0);
  const stillPersonal = await cloud.api('GET', '/api/nodes', {});
  assert.equal(stillPersonal.body.nodes.length, 1);
});

test('node teams: a node can belong to several projects at once, and removal from one leaves the other intact', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .bind('user-test', 'alice', 'x', now).run();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .bind('user-bob', 'bob', 'x', now).run();
  await cloud.db.prepare('INSERT INTO teams (id, name, created_at) VALUES (?, ?, ?)').bind('team-1', 'Alpha', now).run();
  await cloud.db.prepare('INSERT INTO teams (id, name, created_at) VALUES (?, ?, ?)').bind('team-2', 'Beta', now).run();
  await cloud.db.prepare('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
    .bind('team-1', 'user-test', 'owner', now).run();
  await cloud.db.prepare('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
    .bind('team-2', 'user-test', 'owner', now).run();
  await cloud.db.prepare('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
    .bind('team-1', 'user-bob', 'member', now).run();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('alice-node', await sha256Hex('tok-alice-node'), 'user-test', now).run();

  await cloud.api('POST', '/api/nodes/alice-node/teams/team-1', {});
  await cloud.api('POST', '/api/nodes/alice-node/teams/team-2', {});

  const bobView = await core.api({ ...cloud.ctx, userId: 'user-bob', teamId: 'team-1' }, 'GET', '/api/nodes', {});
  assert.equal(bobView.body.nodes.length, 1);
  assert.deepEqual(bobView.body.nodes[0].teamIds.sort(), ['team-1', 'team-2']);

  await cloud.api('DELETE', '/api/nodes/alice-node/teams/team-1', {});
  const bobViewAfter = await core.api({ ...cloud.ctx, userId: 'user-bob', teamId: 'team-1' }, 'GET', '/api/nodes', {});
  assert.equal(bobViewAfter.body.nodes.length, 0);
  const team2View = await core.api({ ...cloud.ctx, teamId: 'team-2' }, 'GET', '/api/nodes', {});
  assert.equal(team2View.body.nodes.length, 1);
});

test('task rename: creator can rename; non-creator cannot; empty title rejected', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .bind('user-test', 'alice', 'x', now).run();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .bind('user-bob', 'bob', 'x', now).run();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('alice-node', await sha256Hex('tok-alice-node'), 'user-test', now).run();
  const create = await cloud.api('POST', '/api/tasks', { title: '原始名字', spec: 'x', nodeId: 'alice-node' });
  const taskId = create.body.task.id;

  const bad = await cloud.api('POST', `/api/tasks/${taskId}/rename`, { title: '  ' });
  assert.equal(bad.status, 400);

  const deniedNotCreator = await core.api({ ...cloud.ctx, userId: 'user-bob' }, 'POST', `/api/tasks/${taskId}/rename`, { title: '想改名' });
  assert.equal(deniedNotCreator.status, 404, 'bob cannot even see a personal task he does not own');

  const renamed = await cloud.api('POST', `/api/tasks/${taskId}/rename`, { title: '真实的名字' });
  assert.equal(renamed.status, 200);
  const row = await cloud.db.prepare('SELECT title FROM tasks WHERE id = ?').bind(taskId).first();
  assert.equal(row.title, '真实的名字');
});

test('GET /api/tasks/:id resolves a task outside the caller\'s currently active scope (deep-link support)', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .bind('user-test', 'alice', 'x', now).run();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .bind('user-bob', 'bob', 'x', now).run();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .bind('user-carol', 'carol', 'x', now).run();
  await cloud.db.prepare('INSERT INTO teams (id, name, created_at) VALUES (?, ?, ?)').bind('team-1', 'Alpha', now).run();
  await cloud.db.prepare('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
    .bind('team-1', 'user-test', 'owner', now).run();
  await cloud.db.prepare('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
    .bind('team-1', 'user-bob', 'member', now).run();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('alice-node', await sha256Hex('tok-alice-node'), 'user-test', now).run();
  await cloud.db.prepare('INSERT INTO node_teams (node_id, team_id) VALUES (?, ?)').bind('alice-node', 'team-1').run();

  // alice creates a task while viewing project team-1, so it's project-only
  // (not part of her personal list) — the exact shape that broke deep links.
  const create = await core.api({ ...cloud.ctx, teamId: 'team-1' }, 'POST', '/api/tasks',
    { title: '项目对话', spec: 'x', nodeId: 'alice-node' });
  assert.equal(create.status, 200);
  const taskId = create.body.task.id;

  // alice, viewing "个人" (ctx.teamId=null) — the list endpoint correctly
  // excludes it, but the direct-fetch route must still resolve it for her.
  const personalListMiss = await cloud.api('GET', '/api/tasks', {});
  assert.ok(!personalListMiss.body.tasks.some(t => t.id === taskId));
  const aliceDirect = await cloud.api('GET', `/api/tasks/${taskId}`, {});
  assert.equal(aliceDirect.status, 200);
  assert.equal(aliceDirect.body.task.id, taskId);
  assert.deepEqual(aliceDirect.body.task.teamIds, ['team-1']);

  // bob is a team-1 member but not the creator, also viewing personal —
  // still resolvable since he's a member of one of its projects.
  const bobDirect = await core.api({ ...cloud.ctx, userId: 'user-bob' }, 'GET', `/api/tasks/${taskId}`, {});
  assert.equal(bobDirect.status, 200);

  // carol isn't in team-1 at all — must not be able to fetch it by guessing the id.
  const carolDirect = await core.api({ ...cloud.ctx, userId: 'user-carol' }, 'GET', `/api/tasks/${taskId}`, {});
  assert.equal(carolDirect.status, 404);

  const missing = await cloud.api('GET', '/api/tasks/does-not-exist', {});
  assert.equal(missing.status, 404);
});

test('node rename: owner can rename; non-owner cannot; empty name rejected; shows up in listings', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .bind('user-test', 'alice', 'x', now).run();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .bind('user-bob', 'bob', 'x', now).run();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('alice-node', await sha256Hex('tok-alice-node'), 'user-test', now).run();

  const bad = await cloud.api('POST', '/api/nodes/alice-node/rename', { name: '   ' });
  assert.equal(bad.status, 400);

  const deniedNotOwner = await core.api({ ...cloud.ctx, userId: 'user-bob' }, 'POST', '/api/nodes/alice-node/rename', { name: '想改名' });
  assert.equal(deniedNotOwner.status, 404, "bob cannot even see alice's personal node");

  const renamed = await cloud.api('POST', '/api/nodes/alice-node/rename', { name: '训练服务器 A' });
  assert.equal(renamed.status, 200);
  const row = await cloud.db.prepare('SELECT name FROM nodes WHERE id = ?').bind('alice-node').first();
  assert.equal(row.name, '训练服务器 A');

  const listed = await cloud.api('GET', '/api/nodes', {});
  assert.equal(listed.body.nodes[0].name, '训练服务器 A');
});

test('task teams: only the creator can add/remove a conversation to/from a project; target membership is validated', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .bind('user-test', 'alice', 'x', now).run();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .bind('user-bob', 'bob', 'x', now).run();
  await cloud.db.prepare('INSERT INTO teams (id, name, created_at) VALUES (?, ?, ?)').bind('team-1', 'Alpha', now).run();
  await cloud.db.prepare('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
    .bind('team-1', 'user-test', 'owner', now).run();
  await cloud.db.prepare('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
    .bind('team-1', 'user-bob', 'member', now).run();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('alice-node', await sha256Hex('tok-alice-node'), 'user-test', now).run();

  const aliceTask = await cloud.api('POST', '/api/tasks', { title: '私人任务', spec: 'x', nodeId: 'alice-node' });
  assert.equal(aliceTask.status, 200);
  const taskId = aliceTask.body.task.id;

  // bob, a teammate but not the creator, can't add it.
  const deniedNotCreator = await core.api({ ...cloud.ctx, userId: 'user-bob' }, 'POST', `/api/tasks/${taskId}/teams/team-1`, {});
  assert.equal(deniedNotCreator.status, 404, 'bob cannot even see a personal task he does not own');

  // alice, targeting a team she isn't a member of.
  await cloud.db.prepare('INSERT INTO teams (id, name, created_at) VALUES (?, ?, ?)').bind('team-2', 'Beta', now).run();
  const deniedNotMember = await cloud.api('POST', `/api/tasks/${taskId}/teams/team-2`, {});
  assert.equal(deniedNotMember.status, 403);

  // alice adds her own personal task to team-1.
  const added = await core.api({ ...cloud.ctx, teamId: 'team-1' }, 'POST', `/api/tasks/${taskId}/teams/team-1`, {});
  assert.equal(added.status, 200);
  let rows = (await cloud.db.prepare('SELECT team_id FROM task_teams WHERE task_id = ?').bind(taskId).all()).results;
  assert.deepEqual(rows.map(r => r.team_id), ['team-1']);
  assert.equal((await cloud.db.prepare('SELECT node_id FROM tasks WHERE id = ?').bind(taskId).first()).node_id, 'alice-node', 'adding to a project does NOT move the task\'s node');

  // now visible to bob in team view, invisible in alice's personal view.
  const teamView = await core.api({ ...cloud.ctx, userId: 'user-bob', teamId: 'team-1' }, 'GET', '/api/tasks', {});
  assert.equal(teamView.body.tasks.length, 1);
  const personalView = await cloud.api('GET', '/api/tasks', {});
  assert.equal(personalView.body.tasks.length, 0);

  // bob, still not the creator, can read it in team view but still can't remove it.
  const bobStillCant = await core.api({ ...cloud.ctx, userId: 'user-bob', teamId: 'team-1' }, 'DELETE', `/api/tasks/${taskId}/teams/team-1`, {});
  assert.equal(bobStillCant.status, 403);

  // alice removes it, back to personal.
  const removed = await cloud.api('DELETE', `/api/tasks/${taskId}/teams/team-1`, {});
  assert.equal(removed.status, 200);
  rows = (await cloud.db.prepare('SELECT team_id FROM task_teams WHERE task_id = ?').bind(taskId).all()).results;
  assert.equal(rows.length, 0);
  const backToPersonal = await cloud.api('GET', '/api/tasks', {});
  assert.equal(backToPersonal.body.tasks.length, 1, 'removing the last project association returns it to personal view');
});

test('task teams: a conversation can belong to several projects at once, and removal from one leaves the other intact', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .bind('user-test', 'alice', 'x', now).run();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .bind('user-bob', 'bob', 'x', now).run();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .bind('user-carol', 'carol', 'x', now).run();
  await cloud.db.prepare('INSERT INTO teams (id, name, created_at) VALUES (?, ?, ?)').bind('team-1', 'Alpha', now).run();
  await cloud.db.prepare('INSERT INTO teams (id, name, created_at) VALUES (?, ?, ?)').bind('team-2', 'Beta', now).run();
  await cloud.db.prepare('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
    .bind('team-1', 'user-test', 'owner', now).run();
  await cloud.db.prepare('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
    .bind('team-2', 'user-test', 'owner', now).run();
  await cloud.db.prepare('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
    .bind('team-1', 'user-bob', 'member', now).run();
  await cloud.db.prepare('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
    .bind('team-2', 'user-carol', 'member', now).run();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('alice-node', await sha256Hex('tok-alice-node'), 'user-test', now).run();

  const task = await cloud.api('POST', '/api/tasks', { title: '跨项目任务', spec: 'x', nodeId: 'alice-node' });
  const taskId = task.body.task.id;

  await core.api({ ...cloud.ctx, teamId: 'team-1' }, 'POST', `/api/tasks/${taskId}/teams/team-1`, {});
  await core.api({ ...cloud.ctx, teamId: 'team-2' }, 'POST', `/api/tasks/${taskId}/teams/team-2`, {});

  // both bob (team-1) and carol (team-2) can see it; each in their own project view.
  const bobView = await core.api({ ...cloud.ctx, userId: 'user-bob', teamId: 'team-1' }, 'GET', '/api/tasks', {});
  assert.equal(bobView.body.tasks.length, 1);
  assert.deepEqual(bobView.body.tasks[0].teamIds.sort(), ['team-1', 'team-2']);
  const carolView = await core.api({ ...cloud.ctx, userId: 'user-carol', teamId: 'team-2' }, 'GET', '/api/tasks', {});
  assert.equal(carolView.body.tasks.length, 1);

  // removing it from team-1 leaves it visible in team-2, invisible to bob, still not personal.
  await cloud.api('DELETE', `/api/tasks/${taskId}/teams/team-1`, {});
  const bobViewAfter = await core.api({ ...cloud.ctx, userId: 'user-bob', teamId: 'team-1' }, 'GET', '/api/tasks', {});
  assert.equal(bobViewAfter.body.tasks.length, 0);
  const carolViewAfter = await core.api({ ...cloud.ctx, userId: 'user-carol', teamId: 'team-2' }, 'GET', '/api/tasks', {});
  assert.equal(carolViewAfter.body.tasks.length, 1);
  const personalAfter = await cloud.api('GET', '/api/tasks', {});
  assert.equal(personalAfter.body.tasks.length, 0, 'still shared with team-2, so not back in personal view yet');
});

test('project membership: only an owner-role member can add/remove others; anyone can remove themselves; admin routes still work', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind('user-test', 'alice', 'x', 1, now).run(); // site admin too, for the admin-route check at the end
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .bind('user-bob', 'bob', 'x', now).run();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .bind('user-carol', 'carol', 'x', now).run();
  await cloud.db.prepare('INSERT INTO teams (id, name, created_at) VALUES (?, ?, ?)').bind('team-1', 'Alpha', now).run();
  await cloud.db.prepare('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
    .bind('team-1', 'user-test', 'owner', now).run();
  await cloud.db.prepare('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
    .bind('team-1', 'user-bob', 'member', now).run();

  // bob (plain member) can't add carol.
  const deniedAdd = await core.api({ ...cloud.ctx, userId: 'user-bob' }, 'POST', '/api/teams/team-1/members', { username: 'carol' });
  assert.equal(deniedAdd.status, 403);

  // alice (owner) can add carol.
  const added = await cloud.api('POST', '/api/teams/team-1/members', { username: 'carol' });
  assert.equal(added.status, 200);
  let members = (await cloud.db.prepare('SELECT user_id, role FROM team_members WHERE team_id = ?').bind('team-1').all()).results;
  const carolRow = members.find(m => m.user_id === 'user-carol');
  assert.equal(carolRow.role, 'member', 'self-service add always joins as plain member, never owner');

  // bob (plain member) can't remove carol either.
  const deniedRemove = await core.api({ ...cloud.ctx, userId: 'user-bob' }, 'DELETE', '/api/teams/team-1/members/user-carol', {});
  assert.equal(deniedRemove.status, 403);

  // but bob CAN remove himself (leave), regardless of role.
  const selfLeave = await core.api({ ...cloud.ctx, userId: 'user-bob' }, 'DELETE', '/api/teams/team-1/members/user-bob', {});
  assert.equal(selfLeave.status, 200);
  members = (await cloud.db.prepare('SELECT user_id FROM team_members WHERE team_id = ?').bind('team-1').all()).results;
  assert.ok(!members.some(m => m.user_id === 'user-bob'));

  // alice (owner) removes carol.
  const removed = await cloud.api('DELETE', '/api/teams/team-1/members/user-carol', {});
  assert.equal(removed.status, 200);

  // site admin routes (a superset capability, unaffected by any of this) still work regardless of team role.
  const adminAdd = await cloud.api('POST', '/api/admin/teams/team-1/members', { username: 'carol', role: 'owner' });
  assert.equal(adminAdd.status, 200);
  members = (await cloud.db.prepare('SELECT user_id, role FROM team_members WHERE team_id = ?').bind('team-1').all()).results;
  assert.equal(members.find(m => m.user_id === 'user-carol').role, 'owner', 'admin route can grant owner, unlike self-service add');
});

test('project creation: any user can self-service create a project and becomes its owner; empty name rejected', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .bind('user-test', 'alice', 'x', now).run();

  const bad = await cloud.api('POST', '/api/teams', { name: '   ' });
  assert.equal(bad.status, 400);

  const created = await cloud.api('POST', '/api/teams', { name: '量化训练' });
  assert.equal(created.status, 200);
  const teamId = created.body.team.id;

  const row = await cloud.db.prepare('SELECT name FROM teams WHERE id = ?').bind(teamId).first();
  assert.equal(row.name, '量化训练');
  const membership = await cloud.db.prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?')
    .bind(teamId, 'user-test').first();
  assert.equal(membership.role, 'owner', 'creator is auto-joined as owner, so it shows up in their own switcher immediately');

  const listed = await cloud.api('GET', '/api/teams', {});
  assert.ok(listed.body.teams.some(t => t.id === teamId && t.role === 'owner'));
});

test('sticky model default: creating a task with a profile makes it the new default for the next draft', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .bind('user-test', 'alice', 'x', now).run();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-sticky', await sha256Hex('tok-mac-sticky'), 'user-test', now).run();
  const create = await cloud.api('POST', '/api/model-profiles',
    { name: 'Claude', baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant-x', model: 'claude-opus-5' });
  const profileId = create.body.profile.id;

  // Before any task, no last-used profile yet.
  const before = await cloud.api('GET', '/api/model-profiles', {});
  assert.equal(before.body.lastModelProfileId, null);

  await cloud.api('POST', '/api/tasks', { title: 't', spec: 'x', nodeId: 'mac-sticky', modelProfileId: profileId });
  const after = await cloud.api('GET', '/api/model-profiles', {});
  assert.equal(after.body.lastModelProfileId, profileId);

  // Creating a plain task (no modelProfileId) resets the sticky default back to null.
  await cloud.api('POST', '/api/tasks', { title: 't2', spec: 'x', nodeId: 'mac-sticky' });
  const afterPlain = await cloud.api('GET', '/api/model-profiles', {});
  assert.equal(afterPlain.body.lastModelProfileId, null);
});

// ---- scheduled tasks (.claude/scheduled_tasks.json fired by the executor) ----
// The CLI's -p stream-json mode never fires CronCreate jobs itself (verified
// against the real CLI: an every-minute durable job on disk fired nothing
// while the process sat idle across minute boundaries) — the executor's
// sweeper is what makes agent-created cron jobs actually work in AgentHub.

async function makeCronTaskFixture(nodeId, script) {
  const cloud = makeCloud();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind(nodeId, await sha256Hex('tok-' + nodeId), 'user-test', Date.now()).run();
  const exec = makeExecutor(cloud, nodeId, script);
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');
  const res = await cloud.api('POST', '/api/tasks', { title: 't', spec: '开始', nodeId });
  const taskId = res.body.task.id;
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'review', 5000, 'creation turn settles');
  const dir = exec.db.getTask(taskId).dir;
  const file = path.join(dir, '.claude', 'scheduled_tasks.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return { cloud, exec, taskId, file };
}

test('scheduled tasks: a due recurring cron job fires as a user turn while the task is idle, and stays scheduled', async () => {
  const sentTexts = [];
  const { cloud, exec, taskId, file } = await makeCronTaskFixture('mac-cron1', async (session, opts, text) => {
    sentTexts.push(text);
    await sleep(10);
    opts.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 50, num_turns: 1, is_error: false });
    session.busy = false;
  });
  fs.writeFileSync(file, JSON.stringify({ tasks: [{
    id: 'job1', cron: '* * * * *', prompt: '汇报当前进度', createdAt: Date.now() - 120_000, recurring: true,
    createdBySessionId: 'x', createdByPid: 999999,
  }] }));

  // Busy tasks must NOT fire (mirrors the REPL's fire-while-idle rule)…
  exec.db.patchTask(taskId, { status: 'running' });
  exec.manager._sweepScheduledTasks();
  assert.equal(sentTexts.length, 1, 'nothing fired while the task was mid-generation');

  // …and the missed minute fires on the first sweep after it settles.
  exec.db.patchTask(taskId, { status: 'review' });
  exec.manager._sweepScheduledTasks();
  // Cloud-side status stayed 'review' throughout (the local busy flip never
  // synced), so wait on the fired turn's own events landing in the cloud
  // message log rather than on status — status alone races the sync.
  await until(async () => {
    const ms = await cloud.api('GET', `/api/tasks/${taskId}/messages`, {});
    return ms.body.messages.filter(m => m.role === 'result').length === 2;
  }, 5000, 'cron turn ran and its events synced');
  assert.equal(sentTexts[1], '汇报当前进度', 'the job prompt was injected as the next user turn');

  const msgs = await cloud.api('GET', `/api/tasks/${taskId}/messages`, {});
  assert.ok(msgs.body.messages.some(m => m.role === 'system' && m.content.text.includes('定时任务触发')), 'firing is visibly announced');
  assert.ok(msgs.body.messages.some(m => m.role === 'user' && m.content.text === '汇报当前进度'), 'the prompt shows as a normal user message');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).tasks.length, 1, 'recurring job stays scheduled after firing');

  exec.manager.shutdown();
  exec.link.stop();
});

test('scheduled tasks: a missed one-shot fires once as catch-up and is removed from the file', async () => {
  const sentTexts = [];
  const { cloud, exec, taskId, file } = await makeCronTaskFixture('mac-cron2', async (session, opts, text) => {
    sentTexts.push(text);
    await sleep(10);
    opts.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 50, num_turns: 1, is_error: false });
    session.busy = false;
  });
  // Pinned to a moment ~3h ago (outside the normal lookback window): the
  // one-shot catch-up path is the only way this can fire.
  const past = new Date(Date.now() - 3 * 3600_000);
  const cron = `${past.getMinutes()} ${past.getHours()} ${past.getDate()} ${past.getMonth() + 1} *`;
  fs.writeFileSync(file, JSON.stringify({ tasks: [{
    id: 'once1', cron, prompt: '提醒:检查部署', createdAt: Date.now() - 4 * 3600_000,
    createdBySessionId: 'x', createdByPid: 999999,
  }] }));

  exec.manager._sweepScheduledTasks();
  await until(async () => sentTexts.length === 2 && (await core.getTask(cloud.ctx, taskId))?.status === 'review', 5000, 'catch-up fire settles');
  assert.equal(sentTexts[1], '提醒:检查部署');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).tasks.length, 0, 'one-shot removed after firing');

  // A later sweep must not fire it again.
  exec.manager._sweepScheduledTasks();
  await sleep(50);
  assert.equal(sentTexts.length, 2, 'no double fire');

  exec.manager.shutdown();
  exec.link.stop();
});

test('scheduled tasks: a recurring job older than 7 days is deleted, visibly, without firing', async () => {
  const sentTexts = [];
  const { cloud, exec, taskId, file } = await makeCronTaskFixture('mac-cron3', async (session, opts, text) => {
    sentTexts.push(text);
    await sleep(10);
    opts.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 50, num_turns: 1, is_error: false });
    session.busy = false;
  });
  fs.writeFileSync(file, JSON.stringify({ tasks: [{
    id: 'old1', cron: '* * * * *', prompt: '早就该过期了', createdAt: Date.now() - 8 * 24 * 3600_000, recurring: true,
    createdBySessionId: 'x', createdByPid: 999999,
  }] }));

  exec.manager._sweepScheduledTasks();
  await until(async () => {
    const ms = await cloud.api('GET', `/api/tasks/${taskId}/messages`, {});
    return ms.body.messages.some(m => m.role === 'system' && m.content.text.includes('7 天上限'));
  }, 5000, 'expiry announcement synced');
  assert.equal(sentTexts.length, 1, 'expired job never fires');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).tasks.length, 0, 'expired job removed from the file');

  exec.manager.shutdown();
  exec.link.stop();
});

test('retry after a pre-send failure (no relay config) still sends the original spec instead of resuming silently idle', async () => {
  const cloud = makeCloud();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mac-noconf', await sha256Hex('tok-mac-noconf'), 'user-test', Date.now()).run();

  const sentTexts = [];
  const exec = makeExecutor(cloud, 'mac-noconf', async (session, opts, text) => {
    sentTexts.push(text);
    await sleep(10);
    opts.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 50, num_turns: 1, is_error: false });
    session.busy = false;
  }, { provider: { baseUrl: '', apiKey: '' } }); // node not configured yet
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');

  const res = await cloud.api('POST', '/api/tasks', { title: 't', spec: '做正事', nodeId: 'mac-noconf' });
  const taskId = res.body.task.id;
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'failed', 5000, 'fails on missing relay config');
  assert.equal(sentTexts.length, 0, 'nothing was ever sent');
  assert.ok(exec.db.getTask(taskId).dir, 'dir was already set before the failure — the exact trap');

  // Config arrives (as the cloud would push it), user hits retry.
  exec.manager.updateProviderConfig({ baseUrl: 'x', apiKey: 'y', model: '' });
  await cloud.api('POST', `/api/tasks/${taskId}/retry`, {});
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'review', 5000, 'retry actually runs the task');
  assert.deepEqual(sentTexts, ['做正事'], 'the original spec finally got sent, exactly once');

  exec.manager.shutdown();
  exec.link.stop();
});

// ---- cloudlink reconnect-loop resilience ----
// gpu31 went dark for 5+ hours with a healthy process: the WS implementation
// dropped a failed attempt without firing open/close/error, and the loop's
// liveness depended entirely on those events. Three independent nets now
// cover it; each test below corresponds to one.

function linkFixture(cfg, makeSocket) {
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-link-'));
  const db = new LocalDb(workRoot);
  return new CloudLink({ cloudUrl: 'wss://x', nodeId: 'n1', nodeToken: 'tok', ...cfg }, db, () => {}, makeSocket);
}

test('cloudlink: an attempt that never fires any event is abandoned by the handshake watchdog and retried', async () => {
  let attempts = 0;
  const link = linkFixture({ wsHandshakeTimeoutMs: 40, wsSupervisorIntervalMs: 3600_000 },
    () => { attempts++; return { send() {}, close() {} }; });
  link.start();
  assert.equal(attempts, 1);
  await until(() => attempts >= 2, 4000, 'second attempt after handshake timeout + backoff');
  link.stop();
});

test('cloudlink: an error event with no close event still triggers reconnect', async () => {
  let attempts = 0;
  const link = linkFixture({ wsHandshakeTimeoutMs: 3600_000, wsSupervisorIntervalMs: 3600_000 },
    () => {
      attempts++;
      const s = { send() {}, close() {} };
      setTimeout(() => s.onerror?.(), 10); // error fires, close never does — the undici path that stalled gpu31
      return s;
    });
  link.start();
  await until(() => attempts >= 2, 4000, 'reconnect despite missing close event');
  link.stop();
});

test('cloudlink: the supervisor revives a fully stalled loop (no socket, no timers, not connected)', async () => {
  let attempts = 0;
  const link = linkFixture({ wsHandshakeTimeoutMs: 3600_000, wsSupervisorIntervalMs: 60 },
    () => { attempts++; return { send() {}, close() {} }; });
  link.start();
  assert.equal(attempts, 1);
  // Reproduce the observed stall state exactly: attempt lost with no events,
  // nothing pending, disconnected.
  clearTimeout(link.handshakeTimer); link.handshakeTimer = null;
  link.ws = null; link.connected = false;
  await until(() => attempts >= 2, 2000, 'supervisor forces a fresh attempt');
  link.stop();
});

// ---- backends: a model profile now pins the agent CLI, not just the relay ----
// The gates below all exist because a session id belongs to exactly one CLI's
// on-disk store, and because the account-default profile is what tasks with no
// profile (always claude) run against. Each one refuses *before* dispatch, so
// the failure names the real cause instead of surfacing as a mystery spawn
// error on the node.

// Overwrite what the node reported at hello. availableBackends() probes the
// real `claude`/`codex` binaries and caches per process, so leaving it to the
// handshake would make these assertions depend on what's installed on the
// machine running the suite.
async function claimBackends(cloud, nodeId, backends, protocolVersion = PROTOCOL_VERSION) {
  await cloud.db.prepare(
    `INSERT INTO node_capabilities (node_id, protocol_version, backends, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(node_id) DO UPDATE SET protocol_version = excluded.protocol_version,
       backends = excluded.backends, updated_at = excluded.updated_at`)
    .bind(nodeId, protocolVersion, JSON.stringify(backends), Date.now()).run();
}

async function makeBackendCloud(nodeId = 'mac-be') {
  const cloud = makeCloud();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind(nodeId, await sha256Hex('tok-' + nodeId), 'user-test', Date.now()).run();
  return cloud;
}

test('model-profiles: backend round-trips through the side table and is cleaned up on delete', async () => {
  const cloud = await makeBackendCloud();

  const codex = await cloud.api('POST', '/api/model-profiles',
    { name: 'Codex 中转', baseUrl: 'https://cx/v1', apiKey: 'sk-cx', model: 'gpt-5.6-sol', backend: 'codex' });
  assert.equal(codex.status, 200);
  assert.equal(codex.body.profile.backend, 'codex');
  const codexId = codex.body.profile.id;

  const plain = await cloud.api('POST', '/api/model-profiles',
    { name: 'Claude', baseUrl: 'https://a/v1', apiKey: 'sk-a', model: 'claude-opus-5' });
  assert.equal(plain.body.profile.backend, 'claude', 'omitted backend means claude, as every pre-existing profile is');

  const bad = await cloud.api('POST', '/api/model-profiles',
    { name: 'x', baseUrl: 'u', apiKey: 'k', backend: 'gemini' });
  assert.equal(bad.status, 400);

  const list = await cloud.api('GET', '/api/model-profiles', {});
  assert.deepEqual(Object.fromEntries(list.body.profiles.map(p => [p.name, p.backend])),
    { 'Codex 中转': 'codex', Claude: 'claude' });

  // Editing can move a non-default profile between backends.
  const edit = await cloud.api('PUT', `/api/model-profiles/${codexId}`,
    { name: 'Codex 中转', baseUrl: 'https://cx/v1', apiKey: 'sk-cx', model: 'gpt-5.6-sol', backend: 'claude' });
  assert.equal(edit.body.profile.backend, 'claude');

  // The side table has no foreign key, so a leftover row would silently hand
  // its backend to whichever future profile reused the id.
  await cloud.api('DELETE', `/api/model-profiles/${codexId}`, {});
  const orphan = await cloud.db.prepare('SELECT backend FROM model_profile_backends WHERE profile_id = ?').bind(codexId).first();
  assert.equal(orphan, null);
});

test('model-profiles: deleting a profile used by a task preserves its backend identity', async () => {
  const cloud = await makeBackendCloud('mac-profile-delete');
  await claimBackends(cloud, 'mac-profile-delete', ['claude', 'codex']);
  const profile = await cloud.api('POST', '/api/model-profiles',
    { name: 'Codex', baseUrl: 'https://cx/v1', apiKey: 'sk-cx', backend: 'codex' });
  const task = await cloud.api('POST', '/api/tasks', {
    title: 't', spec: 'x', nodeId: 'mac-profile-delete', modelProfileId: profile.body.profile.id,
  });

  const removed = await cloud.api('DELETE', `/api/model-profiles/${profile.body.profile.id}`, {});
  assert.equal(removed.status, 409);
  assert.equal((await cloud.api('GET', `/api/tasks/${task.body.task.id}`)).body.task.backend, 'codex');
});

test('model-profiles: a Codex profile can never become the account default', async () => {
  const cloud = await makeBackendCloud();

  // The default is mirrored into users.* and pushed to nodes as the relay for
  // any task that picked no profile — and such a task always runs claude, so a
  // /v1/responses-only relay there would break every unpinned task at once.
  const first = await cloud.api('POST', '/api/model-profiles',
    { name: 'Codex', baseUrl: 'https://cx/v1', apiKey: 'sk-cx', backend: 'codex' });
  assert.equal(first.body.profile.isDefault, false, 'not even as the very first profile');

  const setDefault = await cloud.api('POST', `/api/model-profiles/${first.body.profile.id}/set-default`, {});
  assert.equal(setDefault.status, 409);

  const claude = await cloud.api('POST', '/api/model-profiles',
    { name: 'Claude', baseUrl: 'https://a/v1', apiKey: 'sk-a' });
  assert.equal(claude.body.profile.isDefault, true, 'the first claude profile still becomes the default');
  const flip = await cloud.api('PUT', `/api/model-profiles/${claude.body.profile.id}`,
    { name: 'Claude', baseUrl: 'https://a/v1', apiKey: 'sk-a', backend: 'codex' });
  assert.equal(flip.status, 409, 'and it cannot be converted while it holds that role');
});

test('tasks: a Codex profile dispatches backend on start_task, and is refused by a claude-only node', async () => {
  const cloud = await makeBackendCloud('mac-codex');
  const profile = await cloud.api('POST', '/api/model-profiles',
    { name: 'Codex', baseUrl: 'https://cx/v1', apiKey: 'sk-cx', model: 'gpt-5.6-sol', backend: 'codex' });
  const profileId = profile.body.profile.id;

  let dispatched = null;
  const origSendToNode = cloud.ctx.sendToNode;
  cloud.ctx.sendToNode = (nodeId, msg) => { if (msg.t === 'start_task') dispatched = msg; return origSendToNode(nodeId, msg); };
  try {
    // A node that has never connected to this cloud version stays dispatchable:
    // refusing on absence of evidence would have broken "register the node,
    // create the card, start the daemon later", which worked before backends.
    const unknownNode = await cloud.api('POST', '/api/tasks', { title: 't', spec: 'x', nodeId: 'mac-codex', modelProfileId: profileId });
    assert.equal(unknownNode.status, 200);
    assert.equal(dispatched.task.backend, 'codex');

    await claimBackends(cloud, 'mac-codex', ['claude']);
    const refused = await cloud.api('POST', '/api/tasks', { title: 't2', spec: 'x', nodeId: 'mac-codex', modelProfileId: profileId });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /codex/);

    await claimBackends(cloud, 'mac-codex', ['claude', 'codex']);
    dispatched = null;
    const okRes = await cloud.api('POST', '/api/tasks', { title: 't3', spec: 'x', nodeId: 'mac-codex', modelProfileId: profileId });
    assert.equal(okRes.status, 200);
    assert.equal(dispatched.task.backend, 'codex');

    // Adoption only discovers claude histories, so a resumeSessionId is always
    // a claude session id — which means nothing to codex.
    const adopt = await cloud.api('POST', '/api/tasks', {
      title: 't4', spec: 'x', nodeId: 'mac-codex', modelProfileId: profileId, resumeSessionId: 'sess-from-claude',
    });
    assert.equal(adopt.status, 409);

    // A claude task still dispatches with no backend field at all — the wire
    // stays byte-identical to what a pre-backends cloud sent.
    dispatched = null;
    await cloud.api('POST', '/api/tasks', { title: 't5', spec: 'x', nodeId: 'mac-codex' });
    assert.equal('backend' in dispatched.task, false);
  } finally {
    cloud.ctx.sendToNode = origSendToNode;
  }
});

test('tasks: an outdated node is refused work up front, and told why on its next hello', async () => {
  const cloud = await makeBackendCloud('mac-old');
  await claimBackends(cloud, 'mac-old', ['claude'], PROTOCOL_VERSION - 1);

  // `provider` was called `anthropic` in v1 and there is no compatibility
  // layer, so a v1 node would silently drop it and run against the wrong
  // relay while looking perfectly healthy. Queue the work instead.
  const res = await cloud.api('POST', '/api/tasks', { title: 't', spec: 'x', nodeId: 'mac-old' });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /升级/);

  const sent = [];
  cloud.ctx.sendToNode = (nodeId, msg) => { sent.push(msg); return true; };
  await core.handleHello(cloud.ctx, 'mac-old', { t: 'hello', protocolVersion: PROTOCOL_VERSION - 1, backends: ['claude'], tasks: [] });
  const helloOk = sent.find(m => m.t === 'hello_ok');
  assert.equal(helloOk.upgradeRequired, PROTOCOL_VERSION);

  // An upgraded daemon is dispatchable again with no other intervention.
  await core.handleHello(cloud.ctx, 'mac-old', { t: 'hello', protocolVersion: PROTOCOL_VERSION, backends: ['claude'], tasks: [] });
  const after = await cloud.api('POST', '/api/tasks', { title: 't2', spec: 'x', nodeId: 'mac-old' });
  assert.equal(after.status, 200);
});

test('switch-model: refuses to move a conversation that already has a session to another backend', async () => {
  const cloud = await makeBackendCloud('mac-switch');
  await claimBackends(cloud, 'mac-switch', ['claude', 'codex']);
  const codex = await cloud.api('POST', '/api/model-profiles',
    { name: 'Codex', baseUrl: 'https://cx/v1', apiKey: 'sk-cx', backend: 'codex' });

  const created = await cloud.api('POST', '/api/tasks', { title: 't', spec: 'x', nodeId: 'mac-switch' });
  const taskId = created.body.task.id;

  // No session yet: nothing has spawned, so the card is still free to move.
  const early = await cloud.api('POST', `/api/tasks/${taskId}/switch-model`, { modelProfileId: codex.body.profile.id });
  assert.equal(early.status, 200);

  // Back to claude, then give it a session and try again.
  await cloud.api('POST', `/api/tasks/${taskId}/switch-model`, { modelProfileId: null });
  await cloud.db.prepare('UPDATE tasks SET session_id = ? WHERE id = ?').bind('sess-claude-1', taskId).run();
  const late = await cloud.api('POST', `/api/tasks/${taskId}/switch-model`, { modelProfileId: codex.body.profile.id });
  assert.equal(late.status, 409);
  assert.match(late.body.error, /会话 ID 不通用/);

  // Switching relay *within* the same backend is still fine.
  const sameBackend = await cloud.api('POST', '/api/model-profiles',
    { name: 'Claude 备用', baseUrl: 'https://b/v1', apiKey: 'sk-b' });
  const ok2 = await cloud.api('POST', `/api/tasks/${taskId}/switch-model`, { modelProfileId: sameBackend.body.profile.id });
  assert.equal(ok2.status, 200);
});

test('switch-session: rejects Claude history for a Codex task and exposes task backend', async () => {
  const cloud = await makeBackendCloud('mac-codex-switch');
  await claimBackends(cloud, 'mac-codex-switch', ['claude', 'codex']);
  const profile = await cloud.api('POST', '/api/model-profiles',
    { name: 'Codex', baseUrl: 'https://cx/v1', apiKey: 'sk-cx', backend: 'codex' });
  const created = await cloud.api('POST', '/api/tasks', {
    title: 't', spec: 'x', nodeId: 'mac-codex-switch', modelProfileId: profile.body.profile.id,
  });

  assert.equal(created.body.task.backend, 'codex');
  const listed = await cloud.api('GET', '/api/tasks');
  assert.equal(listed.body.tasks.find(t => t.id === created.body.task.id).backend, 'codex');
  const switched = await cloud.api('POST', `/api/tasks/${created.body.task.id}/switch-session`, { sessionId: 'claude-session' });
  assert.equal(switched.status, 409);
  assert.match(switched.body.error, /Codex/);
  assert.equal((await core.getTask(cloud.ctx, created.body.task.id)).session_id, null);
});

test('backend caps: a session that reports no dollar cost never produces a fabricated $0.00', async () => {
  const cloud = await makeBackendCloud('mac-cost');
  await claimBackends(cloud, 'mac-cost', ['claude', 'codex']);
  const profile = await cloud.api('POST', '/api/model-profiles',
    { name: 'Codex', baseUrl: 'https://cx/v1', apiKey: 'sk-cx', backend: 'codex' });

  const exec = makeExecutor(cloud, 'mac-cost', async (session, opts) => {
    await sleep(10);
    // Deliberately *does* carry total_cost_usd: the guard has to be caps, not
    // "codex happens never to send the field".
    opts.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0.42, duration_ms: 50, num_turns: 1, is_error: false });
    session.busy = false;
  }, {}, (session) => { session.caps = { reportsCost: false, contextWindow: 258400 }; });
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');
  // The real machine running tests may have neither CLI; override the hello
  // probe after connect so this remains a backend-behaviour test.
  await claimBackends(cloud, 'mac-cost', ['claude', 'codex']);

  const res = await cloud.api('POST', '/api/tasks', { title: 't', spec: 'x', nodeId: 'mac-cost', modelProfileId: profile.body.profile.id });
  const taskId = res.body.task.id;
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'review', 5000, 'review');

  assert.equal(exec.db.getTask(taskId).backend, 'codex', 'the backend rode along on start_task');
  assert.equal((await core.getTask(cloud.ctx, taskId)).cost_usd, 0, 'nothing was accumulated');
  const msgs = await cloud.api('GET', `/api/tasks/${taskId}/messages`, {});
  const result = msgs.body.messages.find(m => m.role === 'result');
  assert.equal('total_cost_usd' in result.content, false, 'the Info tab has no cost field to render at all');
  assert.equal('turn_cost_usd' in result.content, false);

  exec.manager.shutdown();
  exec.link.stop();
});

test('backend caps: a self-reported context window sets the compaction threshold, and compaction is an RPC', async () => {
  const cloud = await makeBackendCloud('mac-compact');
  await claimBackends(cloud, 'mac-compact', ['claude', 'codex']);
  const profile = await cloud.api('POST', '/api/model-profiles',
    { name: 'Codex', baseUrl: 'https://cx/v1', apiKey: 'sk-cx', backend: 'codex' });

  const sentTexts = [];
  let compactCalls = 0;
  const exec = makeExecutor(cloud, 'mac-compact', async (session, opts, text) => {
    sentTexts.push(text);
    await sleep(10);
    opts.onMessage({ type: 'result', subtype: 'success', duration_ms: 50, num_turns: 1, is_error: false });
    session.busy = false;
  }, {}, (session) => {
    session.caps = { reportsCost: false, contextWindow: 258400 };
    session.compact = () => { compactCalls++; };
  });
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');
  await claimBackends(cloud, 'mac-compact', ['claude', 'codex']);

  const res = await cloud.api('POST', '/api/tasks', { title: 't', spec: 'x', nodeId: 'mac-compact', modelProfileId: profile.body.profile.id });
  const taskId = res.body.task.id;
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'review', 5000, 'review');
  const session = exec.manager.sessions.get(taskId);

  // 60% of 258400 is 155,040 — above claude's hardcoded 150,000 constant. A
  // task sitting between the two must not compact, which is only true if the
  // reported window is what's being used.
  exec.db.patchTask(taskId, { contextTokens: 152_000 });
  assert.equal(exec.manager._maybeAutoCompact(taskId, session), false);
  assert.equal(compactCalls, 0);

  // Streamed usage is claude's reason to defer to the CLI's own auto-compact.
  // A backend that reports its own window has no such built-in to defer to.
  session.streamedUsageSeen = true;
  exec.db.patchTask(taskId, { contextTokens: 160_000 });
  assert.equal(exec.manager._maybeAutoCompact(taskId, session), true);
  assert.equal(compactCalls, 1);
  assert.equal(sentTexts.includes('/compact'), false, 'the literal never went to the model as a prompt');

  await until(async () => {
    const ms = await cloud.api('GET', `/api/tasks/${taskId}/messages`, {});
    return ms.body.messages.some(m => m.role === 'system' && m.content.text.includes('自动压缩'));
  }, 5000, 'compaction announced');

  exec.manager.shutdown();
  exec.link.stop();
});

test('scheduled tasks: each backend reads only its own schedule store', async () => {
  // The two stores live in different places and are written by different
  // parties, so a codex task running in a directory a claude task used before
  // must not inherit cron prompts that were never written for it, and vice
  // versa.
  const cloud = await makeBackendCloud('mac-cronmix');
  await claimBackends(cloud, 'mac-cronmix', ['claude', 'codex']);
  const profile = await cloud.api('POST', '/api/model-profiles',
    { name: 'Codex', baseUrl: 'https://cx/v1', apiKey: 'sk-cx', backend: 'codex' });

  const sent = [];  // [taskId, text]
  const exec = makeExecutor(cloud, 'mac-cronmix', async (session, opts, text) => {
    sent.push([opts.taskId, text]);
    await sleep(10);
    opts.onMessage({ type: 'result', subtype: 'success', duration_ms: 50, num_turns: 1, is_error: false });
    session.busy = false;
  }, {}, (session) => { session.caps = { reportsCost: false, contextWindow: 258400 }; });
  exec.link.start();
  await until(() => exec.link.connected, 2000, 'link connect');
  await claimBackends(cloud, 'mac-cronmix', ['claude', 'codex']);

  const codexRes = await cloud.api('POST', '/api/tasks', { title: 'codex', spec: '开始', nodeId: 'mac-cronmix', modelProfileId: profile.body.profile.id });
  const claudeRes = await cloud.api('POST', '/api/tasks', { title: 'claude', spec: '开始', nodeId: 'mac-cronmix' });
  const codexId = codexRes.body.task.id;
  const claudeId = claudeRes.body.task.id;
  await until(async () => (await core.getTask(cloud.ctx, codexId))?.status === 'review'
    && (await core.getTask(cloud.ctx, claudeId))?.status === 'review', 5000, 'both creation turns settle');

  // A claude-shaped cron file sitting in the codex task's directory.
  const codexTask = exec.db.getTask(codexId);
  const strayCron = path.join(codexTask.dir, '.claude', 'scheduled_tasks.json');
  fs.mkdirSync(path.dirname(strayCron), { recursive: true });
  fs.writeFileSync(strayCron, JSON.stringify({ tasks: [{
    id: 'stray', cron: '* * * * *', prompt: '这是 claude 的定时任务', createdAt: Date.now() - 120_000, recurring: true,
  }] }));

  exec.manager._sweepScheduledTasks();
  await sleep(50);
  assert.equal(sent.some(([, text]) => text === '这是 claude 的定时任务'), false,
    'a codex task never reads .claude/scheduled_tasks.json');

  // A codex automation bound to the *claude* task's session must not fire
  // either — ownership is by thread id, but only codex tasks consult the store.
  const home = path.join(exec.workRoot, 'codex-home');
  const writeAutomation = (slug, threadId, prompt) => {
    const dir = path.join(home, 'automations', slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'automation.toml'), [
      'id = "' + slug + '"', 'kind = "heartbeat"', 'name = "' + slug + '"',
      'prompt = "' + prompt + '"', 'status = "ACTIVE"', 'rrule = "FREQ=MINUTELY"',
      'target_thread_id = "' + threadId + '"', 'created_at = ' + (Date.now() - 120_000),
    ].join('\n'));
  };
  writeAutomation('for-claude', exec.db.getTask(claudeId).session_id, '不该给 claude 的自动化');
  exec.manager._sweepScheduledTasks();
  await sleep(50);
  assert.equal(sent.some(([, text]) => text === '不该给 claude 的自动化'), false,
    'a claude task never reads CODEX_HOME/automations');

  // And the codex task does fire its own, matched by target_thread_id.
  writeAutomation('for-codex', codexTask.session_id, '每日记账');
  exec.manager._sweepScheduledTasks();
  await until(() => sent.some(([id, text]) => id === codexId && text === '每日记账'), 5000, 'codex automation fires');

  const msgs = await cloud.api('GET', `/api/tasks/${codexId}/messages`, {});
  assert.ok(msgs.body.messages.some(m => m.role === 'system' && m.content.text.includes('Codex 自动化')),
    'firing is visibly announced, naming which automation it was');

  exec.manager.shutdown();
  exec.link.stop();
});

// Sending into a turn that is already running used to hand the text straight
// to the CLI, where the human immediately lost all control of it — nothing to
// edit, nothing to take back, and no indication it was even waiting. These
// cover the queue that replaces that: held while busy, released one at a time
// when the turn ends, and editable/cancellable only for as long as it is
// genuinely still held.
test('queued messages: a send during a running turn is held, not dispatched', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind('user-test', 'tester', 'x', 0, now).run();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind('n1', 'h', 'user-test', 'online', now).run();
  await cloud.db.prepare(`INSERT INTO tasks (id, title, spec, node_id, owner_user_id, status, lease, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind('t1', 'busy task', 'spec', 'n1', 'user-test', 'running', 'daemon', now, now).run();

  // The socket also carries acks and other traffic; only user_message
  // payloads are "the queue actually released something".
  const sent = [];
  cloud.ctx.sendToNode = (nodeId, payload) => { if (payload.t === 'user_message') sent.push(payload); return true; };

  const res = await cloud.api('POST', '/api/tasks/t1/message', { text: '继续', clientMessageId: 'm-1' });
  assert.equal(res.status, 200);
  assert.equal(res.body.delivery, 'held', 'server reports it is holding the message');
  assert.equal(sent.length, 0, 'nothing goes to the node while the turn is running');
  let row = await cloud.db.prepare('SELECT state FROM outbound_messages WHERE client_message_id = ?').bind('m-1').first();
  assert.equal(row.state, 'queued');

  // A second one queues behind it rather than replacing it.
  await cloud.api('POST', '/api/tasks/t1/message', { text: '然后跑测试', clientMessageId: 'm-2' });
  assert.equal(sent.length, 0);

  // Editing rewrites the held text; cancelling drops one entirely.
  const edit = await cloud.api('POST', '/api/tasks/t1/queued-message', { clientMessageId: 'm-1', text: '先别继续,改成 A' });
  assert.equal(edit.status, 200);
  row = await cloud.db.prepare('SELECT payload FROM outbound_messages WHERE client_message_id = ?').bind('m-1').first();
  assert.equal(JSON.parse(row.payload).text, '先别继续,改成 A');
  // Path, not body: the worker only parses a JSON body for POST/PUT.
  const del = await cloud.api('DELETE', '/api/tasks/t1/queued-message/m-2');
  assert.equal(del.status, 200);
  assert.equal((await cloud.db.prepare('SELECT COUNT(*) AS c FROM outbound_messages WHERE task_id = ?').bind('t1').first()).c, 1);

  // The turn ends -> exactly the held message goes out, now as a real send.
  await core.absorbEvent(cloud.ctx, 'n1', { taskId: 't1', seq: 1, ev: { k: 'status', status: 'review' } });
  assert.equal(sent.length, 1, 'the queue releases when the turn ends');
  assert.equal(sent[0].text, '先别继续,改成 A', 'the edited text is what actually gets sent');
  row = await cloud.db.prepare('SELECT state FROM outbound_messages WHERE client_message_id = ?').bind('m-1').first();
  assert.equal(row.state, 'pending');

  // Once released it is on its way to the agent — rewriting it then would
  // change a message that has arguably already been read.
  const lateEdit = await cloud.api('POST', '/api/tasks/t1/queued-message', { clientMessageId: 'm-1', text: '太晚了' });
  assert.equal(lateEdit.status, 404);
});

test('queued messages: releases one per turn, and queue=false bypasses holding entirely', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind('user-test', 'tester', 'x', 0, now).run();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind('n1', 'h', 'user-test', 'online', now).run();
  await cloud.db.prepare(`INSERT INTO tasks (id, title, spec, node_id, owner_user_id, status, lease, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind('t1', 'busy task', 'spec', 'n1', 'user-test', 'running', 'daemon', now, now).run();
  const sent = [];
  cloud.ctx.sendToNode = (nodeId, payload) => { if (payload.t === 'user_message') sent.push(payload); return true; };

  await cloud.api('POST', '/api/tasks/t1/message', { text: 'A', clientMessageId: 'm-a' });
  await cloud.api('POST', '/api/tasks/t1/message', { text: 'B', clientMessageId: 'm-b' });
  await cloud.api('POST', '/api/tasks/t1/message', { text: 'C', clientMessageId: 'm-c' });

  // Draining all three at once would dump them into a single turn, which is
  // the opposite of what holding them was for.
  await core.absorbEvent(cloud.ctx, 'n1', { taskId: 't1', seq: 1, ev: { k: 'status', status: 'review' } });
  assert.deepEqual(sent.map(s => s.text), ['A'], 'only the oldest is released');

  // Next turn starts and ends -> the next one goes.
  await core.absorbEvent(cloud.ctx, 'n1', { taskId: 't1', seq: 2, ev: { k: 'status', status: 'running' } });
  assert.deepEqual(sent.map(s => s.text), ['A'], 'a turn starting releases nothing');
  await core.absorbEvent(cloud.ctx, 'n1', { taskId: 't1', seq: 3, ev: { k: 'status', status: 'review' } });
  assert.deepEqual(sent.map(s => s.text), ['A', 'B']);

  // 直接发送: release one specific held message mid-turn, leaving the rest
  // queued — a per-message escape hatch, not a mode change.
  await core.absorbEvent(cloud.ctx, 'n1', { taskId: 't1', seq: 5, ev: { k: 'status', status: 'running' } });
  const now2 = await cloud.api('POST', '/api/tasks/t1/queued-message', { clientMessageId: 'm-c', sendNow: true });
  assert.equal(now2.status, 200);
  assert.deepEqual(sent.map(s => s.text), ['A', 'B', 'C'], 'the chosen message goes out despite the running turn');
  assert.equal(
    (await cloud.db.prepare("SELECT COUNT(*) AS c FROM outbound_messages WHERE task_id = ? AND state = 'queued'").bind('t1').first()).c,
    0, 'nothing else was released with it',
  );

  // 关闭排队: an explicit queue:false interrupts the running turn as before.
  await core.absorbEvent(cloud.ctx, 'n1', { taskId: 't1', seq: 4, ev: { k: 'status', status: 'running' } });
  const direct = await cloud.api('POST', '/api/tasks/t1/message', { text: 'NOW', clientMessageId: 'm-now', queue: false });
  assert.equal(direct.body.delivery, 'sent');
  assert.equal(sent[sent.length - 1].text, 'NOW', 'it goes straight through despite the running turn');
});

test('run timer: a turn starting stamps run_started_at, and it survives cost/usage churn mid-turn', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .bind('user-test', 'tester', 'x', now).run();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind('n1', 'h', 'user-test', 'online', now).run();
  await cloud.db.prepare(`INSERT INTO tasks (id, title, spec, node_id, owner_user_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind('t1', '计时', 'spec', 'n1', 'user-test', 'queued', now, now).run();

  cloud.setNow(now);
  await core.absorbEvent(cloud.ctx, 'n1', { taskId: 't1', seq: 1, ev: { k: 'status', status: 'running' } });

  // Cost/usage events land constantly during a turn and each bumps
  // tasks.updated_at — the timer must not be anchored to that.
  cloud.setNow(now + 30_000);
  await core.absorbEvent(cloud.ctx, 'n1', { taskId: 't1', seq: 2, ev: { k: 'cost', costUsd: 0.4 } });
  await core.absorbEvent(cloud.ctx, 'n1', { taskId: 't1', seq: 3, ev: { k: 'usage', contextTokens: 1000 } });

  let list = await cloud.api('GET', '/api/tasks', {});
  assert.equal(list.body.tasks[0].run_started_at, now, '仍然是这一轮真正开始的时刻');
  assert.equal(list.body.tasks[0].attention_at, null, '还在跑,没有需要人看的东西');

  // Turn ends, next turn starts -> the timer restarts from the new turn.
  cloud.setNow(now + 60_000);
  await core.absorbEvent(cloud.ctx, 'n1', { taskId: 't1', seq: 4, ev: { k: 'status', status: 'review' } });
  cloud.setNow(now + 90_000);
  await core.absorbEvent(cloud.ctx, 'n1', { taskId: 't1', seq: 5, ev: { k: 'status', status: 'running' } });
  list = await cloud.api('GET', '/api/tasks', {});
  assert.equal(list.body.tasks[0].run_started_at, now + 90_000);
  assert.equal(list.body.tasks[0].attention_at, now + 60_000, '上一轮结束的时刻仍然记着');

  cloud.setNow(null);
});

test('unread: finishing marks the conversation and its project; looking at it clears only that user', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  for (const [id, name] of [['user-test', 'alice'], ['user-bob', 'bob']]) {
    await cloud.db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
      .bind(id, name, 'x', now).run();
  }
  await cloud.db.prepare('INSERT INTO teams (id, name, created_at) VALUES (?, ?, ?)').bind('team-u', '项目', now).run();
  for (const uid of ['user-test', 'user-bob']) {
    await cloud.db.prepare('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
      .bind('team-u', uid, uid === 'user-test' ? 'owner' : 'member', now).run();
  }
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind('n1', 'h', 'user-test', 'online', now).run();
  await cloud.db.prepare('INSERT INTO node_teams (node_id, team_id) VALUES (?, ?)').bind('n1', 'team-u').run();
  // one personal conversation, one shared with the project
  for (const [id, title] of [['t-personal', '私人对话'], ['t-team', '项目对话']]) {
    await cloud.db.prepare(`INSERT INTO tasks (id, title, spec, node_id, owner_user_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, title, 'spec', 'n1', 'user-test', 'running', now, now).run();
  }
  await cloud.db.prepare('INSERT INTO task_teams (task_id, team_id) VALUES (?, ?)').bind('t-team', 'team-u').run();
  const teamCtx = { ...cloud.ctx, teamId: 'team-u' };
  const bobCtx = { ...cloud.ctx, userId: 'user-bob', teamId: 'team-u' };

  let unread = await cloud.api('GET', '/api/unread', {});
  assert.equal(unread.body.unread.personal, 0, '什么都没发生前不该有红点');

  cloud.setNow(now + 1000);
  await core.absorbEvent(cloud.ctx, 'n1', { taskId: 't-personal', seq: 1, ev: { k: 'status', status: 'review' } });
  await core.absorbEvent(cloud.ctx, 'n1', { taskId: 't-team', seq: 1, ev: { k: 'status', status: 'review' } });

  unread = await cloud.api('GET', '/api/unread', {});
  assert.equal(unread.body.unread.personal, 1);
  assert.equal(unread.body.unread['team-u'], 1, '项目 tab 也要标红点');
  const bobUnread = await core.api(bobCtx, 'GET', '/api/unread', {});
  assert.equal(bobUnread.body.unread['team-u'], 1, '队友看到的是自己的未读,不是创建者的');
  assert.equal(bobUnread.body.unread.personal, 0, '别人的个人对话不算队友的未读');

  // Alice looks at the project conversation.
  cloud.setNow(now + 2000);
  const seen = await core.api(teamCtx, 'POST', '/api/tasks/t-team/seen', {});
  assert.equal(seen.status, 200);
  assert.equal(seen.body.seenAt, now + 2000);

  unread = await cloud.api('GET', '/api/unread', {});
  assert.equal(unread.body.unread['team-u'] ?? 0, 0, '看过之后红点消失(计数为 0 的项目直接不出现在响应里)');
  assert.equal(unread.body.unread.personal, 1, '没看的那个还在');
  assert.equal((await core.api(bobCtx, 'GET', '/api/unread', {})).body.unread['team-u'], 1,
    'alice 看过不代表 bob 看过');

  // A non-creator can clear their own dot — it writes only their read row.
  const bobSeen = await core.api(bobCtx, 'POST', '/api/tasks/t-team/seen', {});
  assert.equal(bobSeen.status, 200, '队友也要能把自己的红点点掉');
  assert.equal((await core.api(bobCtx, 'GET', '/api/unread', {})).body.unread['team-u'] ?? 0, 0);
  // ...but that's the only extra power it grants.
  assert.equal((await core.api(bobCtx, 'POST', '/api/tasks/t-team/archive', {})).status, 403);

  // The list response carries this user's own seen_at, so a reload doesn't
  // re-light dots the user already cleared.
  const list = await core.api(teamCtx, 'GET', '/api/tasks', {});
  assert.equal(list.body.tasks[0].seen_at, now + 2000);

  // The WS snapshot replaces the client's whole task map on every connect —
  // if it dropped these fields, the dot/timer would appear from the REST load
  // and then vanish the moment the socket opened (exactly what happened live).
  const snap = await core.snapshot(teamCtx);
  const snapTask = snap.tasks.find(t => t.id === 't-team');
  assert.equal(snapTask.attention_at, now + 1000);
  assert.equal(snapTask.seen_at, now + 2000);
  assert.ok(snapTask.run_started_at === null || typeof snapTask.run_started_at === 'number');

  // A new turn finishing after that makes it unread again.
  cloud.setNow(now + 3000);
  await core.absorbEvent(cloud.ctx, 'n1', { taskId: 't-team', seq: 2, ev: { k: 'status', status: 'running' } });
  cloud.setNow(now + 4000);
  await core.absorbEvent(cloud.ctx, 'n1', { taskId: 't-team', seq: 3, ev: { k: 'status', status: 'waiting_human' } });
  assert.equal((await core.api(teamCtx, 'GET', '/api/unread', {})).body.unread['team-u'], 1);

  // Archived conversations don't keep a project's dot lit forever.
  await core.api(teamCtx, 'POST', '/api/tasks/t-team/archive', {});
  assert.equal((await core.api(teamCtx, 'GET', '/api/unread', {})).body.unread['team-u'] ?? 0, 0);

  cloud.setNow(null);
});

// The file browser reaches into a real machine's filesystem through the cloud,
// so the gates matter more than the happy path: only the machine's owner, and
// only nodes that actually have the handlers (an older one would never answer
// and the user would watch a spinner until the askNode timeout).
test('node files: owner-only, and refused for a node without the file-io feature', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind('user-test', 'tester', 'x', 0, now).run();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind('user-bob', 'bob', 'x', 0, now).run();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind('n1', 'h', 'user-test', 'online', now).run();

  cloud.ctx.listDir = async () => ({ path: '/home/me', parent: '/home', entries: [{ name: 'a.js', type: 'file', size: 3 }] });
  cloud.ctx.readFile = async () => ({ path: '/home/me/a.js', content: 'hi\n', encoding: 'utf8', size: 3, mtime: 111 });
  cloud.ctx.writeFile = async () => ({ ok: true, mtime: 222, size: 5 });

  // No node_features row yet = a node that hasn't reconnected on a build with
  // the handlers. Refused with an explanation rather than left to time out.
  // The harness hands pathName straight to core.api without parsing a query
  // string (hub.mjs does that in the real request path), so GET params go in
  // the body argument — same as the existing /browse tests above.
  const tooOld = await cloud.api('GET', '/api/nodes/n1/files', { path: '/home/me' });
  assert.equal(tooOld.status, 409);

  await cloud.db.prepare('INSERT INTO node_features (node_id, features, updated_at) VALUES (?, ?, ?)')
    .bind('n1', JSON.stringify(['file-io']), now).run();

  const list = await cloud.api('GET', '/api/nodes/n1/files', { path: '/home/me' });
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.entries.map(e => e.name), ['a.js']);
  assert.equal(list.body.parent, '/home', 'the parent comes through so the UI can navigate up');

  const read = await cloud.api('GET', '/api/nodes/n1/file', { path: '/home/me/a.js' });
  assert.equal(read.status, 200);
  assert.equal(read.body.content, 'hi\n');
  assert.equal(read.body.mtime, 111, 'mtime round-trips — it is the save-time conflict check');

  const write = await cloud.api('POST', '/api/nodes/n1/file', { path: '/home/me/a.js', content: 'bye\n', expectedMtime: 111 });
  assert.equal(write.status, 200);
  assert.equal(write.body.mtime, 222);

  // Someone else's machine, even a real logged-in account.
  for (const call of [
    ['GET', '/api/nodes/n1/files'],
    ['GET', '/api/nodes/n1/file'],
    ['POST', '/api/nodes/n1/file'],
  ]) {
    const res = await core.api({ ...cloud.ctx, userId: 'user-bob' }, call[0], call[1], { path: '/x', content: 'x' });
    assert.equal(res.status, 404, `${call[0]} ${call[1]} must not expose another owner's node`);
  }
});

test('node files: a save that lost a race with the agent comes back as a conflict, not a failure', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind('user-test', 'tester', 'x', 0, now).run();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind('n1', 'h', 'user-test', 'online', now).run();
  await cloud.db.prepare('INSERT INTO node_features (node_id, features, updated_at) VALUES (?, ?, ?)')
    .bind('n1', JSON.stringify(['file-io']), now).run();

  cloud.ctx.writeFile = async () => ({ ok: false, conflict: true, mtime: 999 });
  const res = await cloud.api('POST', '/api/nodes/n1/file', { path: '/x', content: 'mine', expectedMtime: 1 });
  assert.equal(res.status, 409);
  // The frontend needs the flag to offer reload-or-overwrite rather than just
  // printing "save failed".
  assert.equal(JSON.parse(res.body.error).conflict, true);

  // A node that never answers must not look like a successful save.
  cloud.ctx.writeFile = async () => null;
  const dead = await cloud.api('POST', '/api/nodes/n1/file', { path: '/x', content: 'mine' });
  assert.equal(dead.status, 504);
});

test('setup-status: answers for the whole account, not the project being viewed', async () => {
  const cloud = makeCloud();
  const now = Date.now();
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .bind('user-test', 'alice', 'x', now).run();
  await cloud.db.prepare('INSERT INTO teams (id, name, created_at) VALUES (?, ?, ?)').bind('team-s', '空项目', now).run();
  await cloud.db.prepare('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
    .bind('team-s', 'user-test', 'owner', now).run();
  const teamCtx = { ...cloud.ctx, teamId: 'team-s' };

  let status = await cloud.api('GET', '/api/setup-status', {});
  assert.deepEqual(status.body.hasModel, false);
  assert.equal(status.body.nodeCount, 0);

  // Legacy relay credentials (pre-profiles) still count as configured — the
  // profile list route lazily migrates them, so claiming "no model" here
  // would pop the wizard at an account that works fine.
  await cloud.db.prepare('UPDATE users SET api_base_url = ?, api_key = ? WHERE id = ?')
    .bind('https://relay.example/v1', 'sk-x', 'user-test').run();
  assert.equal((await cloud.api('GET', '/api/setup-status', {})).body.hasModel, true);

  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('mine', await sha256Hex('t'), 'user-test', now).run();

  // A project with no machine bound to it is not "this account has no
  // machine" — this is what used to pop the wizard on every scope switch.
  status = await core.api(teamCtx, 'GET', '/api/setup-status', {});
  assert.equal(status.body.nodeCount, 1, '项目视角下也要看到账号名下的机器');
  assert.deepEqual((await core.api(teamCtx, 'GET', '/api/nodes', {})).body.nodes, [], '而节点列表本身仍然是按视角过滤的');

  // A teammate's machine shared into a project I'm in counts too: I can
  // create conversations on it, so the wizard has nothing left to ask me.
  await cloud.db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .bind('user-bob', 'bob', 'x', now).run();
  await cloud.db.prepare('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
    .bind('team-s', 'user-bob', 'member', now).run();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind('bobs', await sha256Hex('t2'), 'user-bob', now).run();
  await cloud.db.prepare('INSERT INTO node_teams (node_id, team_id) VALUES (?, ?)').bind('bobs', 'team-s').run();
  assert.equal((await cloud.api('GET', '/api/setup-status', {})).body.nodeCount, 2);
  assert.equal((await core.api({ ...cloud.ctx, userId: 'user-bob' }, 'GET', '/api/setup-status', {})).body.nodeCount, 1,
    'bob 只看得到自己的和项目里的那一台(同一台),不会数上别人的私人机器');
});
