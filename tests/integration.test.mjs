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
import { sha256Hex } from '../packages/shared/protocol.mjs';

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
    now: () => fakeNow ?? Date.now(),
    broadcast: (m) => broadcasts.push(m),
    sendToNode: (nodeId, msg) => {
      const sock = nodeSockets.get(nodeId);
      if (!sock || sock.readyState !== 1) return false;
      queueMicrotask(() => sock.onmessage?.({ data: JSON.stringify(msg) }));
      return true;
    },
    push: (p) => pushes.push(p),
  };
  // Serialized message pump, like a DO
  let chain = Promise.resolve();
  const fromNode = (nodeId, raw) => {
    chain = chain.then(async () => {
      const msg = JSON.parse(raw);
      if (msg.t === 'hello') await core.handleHello(ctx, nodeId, msg);
      else if (msg.t === 'hb') await core.handleHeartbeat(ctx, nodeId);
      else if (msg.t === 'ev') await core.absorbEvent(ctx, nodeId, msg);
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
function makeFakeSessionFactory(script) {
  return (opts) => {
    const session = {
      alive: true, busy: false, sessionId: opts.resumeSessionId ?? null, lastActivity: Date.now(),
      start() {
        if (!session.sessionId) session.sessionId = 'sess-' + Math.random().toString(36).slice(2, 8);
        queueMicrotask(() => opts.onMessage({ type: 'system', subtype: 'init', session_id: session.sessionId }));
      },
      send(text) { session.busy = true; script(session, opts, text); },
      interrupt() {},
      kill() { session.alive = false; },
    };
    return session;
  };
}

function makeExecutor(cloud, nodeId, script) {
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-test-'));
  fs.mkdirSync(path.join(workRoot, 'scratch'), { recursive: true });
  const config = {
    cloudUrl: 'wss://fake', nodeId, nodeToken: 'tok-' + nodeId,
    anthropic: { baseUrl: 'x', apiKey: 'y' },
    maxParallel: 3, maxTurnsPerRun: 100, maxCostUsd: 10,
    decisionTimeoutMs: 60_000, idleSessionTimeoutMs: 60_000, workRoot,
  };
  const db = new LocalDb(workRoot);
  const link = new CloudLink(config, db, (cmd) => manager.handleCommand(cmd), cloud.makeSocketFactory(nodeId));
  const manager = new SessionManager(config, db, (t, s, e) => link.notifyEvent(t, s, e), makeFakeSessionFactory(script));
  return { config, db, link, manager, workRoot };
}

test('M1: full task flow (start -> perm -> review -> reply -> done)', async () => {
  const cloud = makeCloud();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, created_at) VALUES (?, ?, ?)')
    .bind('mac1', await sha256Hex('tok-mac1'), Date.now()).run();

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

test('M2: offline events replay exactly once; duplicates are absorbed idempotently', async () => {
  const cloud = makeCloud();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, created_at) VALUES (?, ?, ?)')
    .bind('mac2', await sha256Hex('tok-mac2'), Date.now()).run();

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

test('M3: heartbeat timeout marks node offline and tasks unknown; hello reconciles (local wins)', async () => {
  const cloud = makeCloud();
  await cloud.db.prepare('INSERT INTO nodes (id, token_hash, created_at) VALUES (?, ?, ?)')
    .bind('mac3', await sha256Hex('tok-mac3'), Date.now()).run();

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
  assert.equal((await cloud.db.prepare('SELECT status FROM nodes WHERE id = ?').bind('mac3').first()).status, 'offline');
  assert.equal((await core.getTask(cloud.ctx, taskId)).status, 'unknown');
  assert.ok(cloud.pushes.some(p => p.title.includes('节点失联')));
  cloud.setNow(null);

  // node comes back: executor still believes running -> cloud must adopt it
  exec.link.backoff = 30;
  exec.link.start();
  await until(() => exec.link.connected, 3000, 'reconnected');
  await until(async () => (await core.getTask(cloud.ctx, taskId))?.status === 'running', 5000, 'reconciled to running');

  exec.manager.shutdown();
  exec.link.stop();
});
