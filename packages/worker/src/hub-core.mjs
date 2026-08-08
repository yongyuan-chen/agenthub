// Hub coordination logic, decoupled from Durable Object infrastructure so the
// reconciliation/idempotency paths run in plain Node tests.
//
// ctx contract:
//   db          D1-compatible: prepare(sql).bind(...).run()/first()/all()->{results}
//   broadcast(msgObj)             -> void        (all frontend sockets)
//   sendToNode(nodeId, msgObj)    -> boolean     (true if delivered to a live socket)
//   push(payload)                 -> void        (web push fan-out, fire and forget)
//   now()                         -> epoch ms
import { userCanTransition, ulid, TERMINAL_STATUSES } from '../../shared/protocol.mjs';

const q = (db, sql, ...params) => db.prepare(sql).bind(...params);

export async function getTask(ctx, taskId) {
  return await q(ctx.db, 'SELECT * FROM tasks WHERE id = ?', taskId).first();
}

async function broadcastTask(ctx, taskId) {
  const task = await getTask(ctx, taskId);
  if (task) ctx.broadcast({ t: 'task', task });
  return task;
}

// ---------- executor uplink ----------

export async function absorbEvent(ctx, nodeId, { taskId, seq, ev }) {
  const task = await getTask(ctx, taskId);
  if (!task || task.node_id !== nodeId) return; // stray event
  const now = ctx.now();
  // Replay can interleave with live events; task-level fields only ever move
  // forward (message inserts are idempotent by (task_id, seq) regardless).
  const fresh = seq > (task.last_seq ?? 0);

  if (ev.k === 'msg') {
    const res = await q(ctx.db,
      'INSERT OR IGNORE INTO messages (id, task_id, seq, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      `${taskId}:${seq}`, taskId, seq, ev.role, JSON.stringify(ev.content ?? {}), ev.ts ?? now,
    ).run();
    const inserted = (res.meta?.changes ?? res.changes ?? 0) > 0;
    if (inserted) ctx.broadcast({ t: 'msg', taskId, seq, role: ev.role, content: ev.content, ts: ev.ts ?? now });
  } else if (ev.k === 'status' && fresh) {
    const extra = ev.extra || {};
    const prev = task.status;
    // pending_request only changes when the executor says so — a lease toggle
    // or cost-fuse status event must not wipe an open approval prompt.
    const pending = extra.pendingRequest ? JSON.stringify(extra.pendingRequest)
      : (extra.clearPending ? null : task.pending_request);
    await q(ctx.db,
      `UPDATE tasks SET status = ?, pending_request = ?, last_error = COALESCE(?, last_error),
         lease = COALESCE(?, lease), updated_at = ? WHERE id = ?`,
      ev.status, pending, extra.error ?? null, extra.lease ?? null, now, taskId,
    ).run();
    await broadcastTask(ctx, taskId);
    if (prev !== ev.status) {
      notifyStatus(ctx, { ...task, status: ev.status, last_error: extra.error }, extra);
    }
  } else if (ev.k === 'session' && fresh) {
    await q(ctx.db, 'UPDATE tasks SET session_id = ?, updated_at = ? WHERE id = ?', ev.sessionId, now, taskId).run();
    await broadcastTask(ctx, taskId);
  } else if (ev.k === 'cost' && fresh) {
    await q(ctx.db, 'UPDATE tasks SET cost_usd = ?, updated_at = ? WHERE id = ?', ev.costUsd, now, taskId).run();
    await broadcastTask(ctx, taskId);
  }

  await q(ctx.db, 'UPDATE tasks SET last_seq = MAX(last_seq, ?) WHERE id = ?', seq, taskId).run();
  ctx.sendToNode(nodeId, { t: 'ack', taskId, seq });
}

function notifyStatus(ctx, task, extra = {}) {
  const title = task.title || task.id;
  if (task.status === 'waiting_human') {
    const tool = extra.pendingRequest?.toolName;
    ctx.push({ title: '⏸ 等你决策', body: tool ? `「${title}」请求使用:${tool}` : `「${title}」${extra.note || '在等你回复'}`, taskId: task.id });
  } else if (task.status === 'review') {
    ctx.push({ title: '✅ 待 Review', body: `「${title}」已完成,等待你审阅`, taskId: task.id });
  } else if (task.status === 'failed') {
    ctx.push({ title: '❌ 任务失败', body: `「${title}」${(task.last_error || '').slice(0, 120)}`, taskId: task.id });
  }
}

export async function handleHello(ctx, nodeId, msg) {
  const now = ctx.now();
  await q(ctx.db, "UPDATE nodes SET status = 'online', last_heartbeat_at = ? WHERE id = ?", now, nodeId).run();
  ctx.broadcast({ t: 'node', node: await q(ctx.db, 'SELECT id, labels, status, last_heartbeat_at FROM nodes WHERE id = ?', nodeId).first() });

  // Reconciliation: the execution site is the truth — its reported state
  // overwrites whatever the cloud thought (including 'unknown').
  const replay = [];
  for (const lt of msg.tasks || []) {
    const cloud = await getTask(ctx, lt.taskId);
    if (!cloud || cloud.node_id !== nodeId) continue;
    if (cloud.status !== lt.status || (cloud.session_id ?? null) !== (lt.sessionId ?? null)
      || cloud.cost_usd !== lt.costUsd || cloud.lease !== lt.lease) {
      await q(ctx.db,
        'UPDATE tasks SET status = ?, session_id = ?, cost_usd = ?, lease = ?, updated_at = ? WHERE id = ?',
        lt.status, lt.sessionId ?? null, lt.costUsd ?? 0, lt.lease ?? 'daemon', now, lt.taskId,
      ).run();
      await broadcastTask(ctx, lt.taskId);
    }
    replay.push({ taskId: lt.taskId, lastSeq: cloud.last_seq ?? 0 });
  }
  ctx.sendToNode(nodeId, { t: 'hello_ok', tasks: replay });

  // Anything that never reached this node (created while it was offline).
  const pend = await q(ctx.db, 'SELECT id, payload FROM pending_cmds WHERE node_id = ? ORDER BY id', nodeId).all();
  for (const row of pend.results ?? pend) {
    if (!ctx.sendToNode(nodeId, JSON.parse(row.payload))) break; // socket died: keep for next hello
    await q(ctx.db, 'DELETE FROM pending_cmds WHERE id = ?', row.id).run();
  }
}

export async function handleHeartbeat(ctx, nodeId) {
  const node = await q(ctx.db, 'SELECT status FROM nodes WHERE id = ?', nodeId).first();
  await q(ctx.db, "UPDATE nodes SET status = 'online', last_heartbeat_at = ? WHERE id = ?", ctx.now(), nodeId).run();
  if (node && node.status === 'offline') {
    // We marked it dead (e.g. its event loop was busy cloning) but the socket
    // survived — ask for a fresh hello so tasks leave 'unknown'.
    ctx.broadcast({ t: 'node', node: await q(ctx.db, 'SELECT id, labels, status, last_heartbeat_at FROM nodes WHERE id = ?', nodeId).first() });
    ctx.sendToNode(nodeId, { t: 'resync' });
  }
}

export async function markNodeOffline(ctx, nodeId) {
  const node = await q(ctx.db, 'SELECT id, labels, status, last_heartbeat_at FROM nodes WHERE id = ?', nodeId).first();
  if (!node || node.status === 'offline') return;
  await q(ctx.db, "UPDATE nodes SET status = 'offline' WHERE id = ?", nodeId).run();
  ctx.broadcast({ t: 'node', node: { ...node, status: 'offline' } });
  const active = await q(ctx.db,
    "SELECT id FROM tasks WHERE node_id = ? AND status IN ('queued','starting','running','waiting_human')", nodeId).all();
  for (const row of active.results ?? active) {
    await q(ctx.db, "UPDATE tasks SET status = 'unknown', updated_at = ? WHERE id = ?", ctx.now(), row.id).run();
    await broadcastTask(ctx, row.id);
  }
  ctx.push({ title: '⚠️ 节点失联', body: `节点「${nodeId}」离线,其任务状态未知`, nodeId });
}

export async function checkHeartbeats(ctx, timeoutMs = 60_000) {
  const rows = await q(ctx.db, "SELECT id, last_heartbeat_at FROM nodes WHERE status = 'online'").all();
  for (const n of rows.results ?? rows) {
    if ((ctx.now() - (n.last_heartbeat_at ?? 0)) > timeoutMs) await markNodeOffline(ctx, n.id);
  }
}

// ---------- commands to nodes ----------

async function dispatch(ctx, nodeId, cmd) {
  if (!ctx.sendToNode(nodeId, cmd)) {
    await q(ctx.db, 'INSERT INTO pending_cmds (node_id, payload, created_at) VALUES (?, ?, ?)',
      nodeId, JSON.stringify(cmd), ctx.now()).run();
  }
}

// ---------- user-facing API (returns {status, body}) ----------

export async function api(ctx, method, pathname, body) {
  const seg = pathname.split('/').filter(Boolean); // ['api', ...]
  const route = seg.slice(1);

  if (method === 'GET' && route[0] === 'tasks' && route.length === 1) {
    const rows = await q(ctx.db, 'SELECT * FROM tasks ORDER BY created_at DESC LIMIT 500').all();
    return ok({ tasks: rows.results ?? rows });
  }

  if (method === 'POST' && route[0] === 'tasks' && route.length === 1) {
    const { title, spec, repoUrl, baseBranch, nodeId, permissionMode } = body || {};
    if (!title || !spec || !nodeId) return err(400, 'title, spec, nodeId required');
    const node = await q(ctx.db, 'SELECT id FROM nodes WHERE id = ?', nodeId).first();
    if (!node) return err(400, `unknown node: ${nodeId}`);
    const id = ulid();
    const now = ctx.now();
    await q(ctx.db,
      `INSERT INTO tasks (id, title, spec, repo_url, base_branch, node_id, status, permission_mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
      id, title, spec, repoUrl ?? null, baseBranch ?? 'main', nodeId, permissionMode ?? 'acceptEdits', now, now,
    ).run();
    await dispatch(ctx, nodeId, {
      t: 'start_task',
      task: { id, title, spec, repoUrl: repoUrl ?? null, baseBranch: baseBranch ?? 'main', permissionMode: permissionMode ?? 'acceptEdits' },
    });
    const task = await broadcastTask(ctx, id);
    return ok({ task });
  }

  if (route[0] === 'tasks' && route.length >= 3) {
    const taskId = route[1];
    const task = await getTask(ctx, taskId);
    if (!task) return err(404, 'task not found');
    const action = route[2];

    if (method === 'GET' && action === 'messages') {
      const after = Number(body?.after_seq ?? 0);
      const limit = Math.min(Number(body?.limit ?? 300), 1000);
      const rows = await q(ctx.db,
        'SELECT seq, role, content, created_at FROM messages WHERE task_id = ? AND seq > ? ORDER BY seq LIMIT ?',
        taskId, after, limit).all();
      return ok({ messages: (rows.results ?? rows).map(r => ({ ...r, content: JSON.parse(r.content) })) });
    }
    if (method === 'POST' && action === 'message') {
      if (!body?.text) return err(400, 'text required');
      if (TERMINAL_STATUSES.includes(task.status)) return err(409, `task is ${task.status}`);
      if (task.lease === 'human') return err(409, 'task is leased to IDE');
      await dispatch(ctx, task.node_id, { t: 'user_message', taskId, text: body.text });
      return ok({});
    }
    if (method === 'POST' && action === 'decision') {
      const { requestId, behavior, message } = body || {};
      if (!requestId || !['allow', 'deny'].includes(behavior)) return err(400, 'requestId + behavior required');
      await dispatch(ctx, task.node_id, { t: 'decision', taskId, requestId, behavior, message });
      return ok({});
    }
    if (method === 'POST' && action === 'cancel') {
      if (!userCanTransition(task.status, 'cancelled')) return err(409, `cannot cancel from ${task.status}`);
      await dispatch(ctx, task.node_id, { t: 'cancel', taskId });
      return ok({});
    }
    if (method === 'POST' && action === 'done') {
      if (!userCanTransition(task.status, 'done')) return err(409, `cannot mark done from ${task.status}`);
      await q(ctx.db, "UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?", ctx.now(), taskId).run();
      await broadcastTask(ctx, taskId);
      return ok({});
    }
    if (method === 'POST' && action === 'lease') {
      const lease = body?.lease === 'human' ? 'human' : 'daemon';
      await q(ctx.db, 'UPDATE tasks SET lease = ?, updated_at = ? WHERE id = ?', lease, ctx.now(), taskId).run();
      await dispatch(ctx, task.node_id, { t: 'lease', taskId, lease });
      await broadcastTask(ctx, taskId);
      return ok({ lease, sessionId: task.session_id, nodeId: task.node_id });
    }
  }

  if (method === 'GET' && route[0] === 'nodes') {
    const rows = await q(ctx.db, 'SELECT id, labels, status, last_heartbeat_at, created_at FROM nodes').all();
    return ok({ nodes: rows.results ?? rows });
  }
  if (method === 'POST' && route[0] === 'nodes' && route.length === 1) {
    const { id, tokenHash, labels } = body || {};
    if (!id || !tokenHash) return err(400, 'id + tokenHash required');
    await q(ctx.db,
      `INSERT INTO nodes (id, token_hash, labels, status, created_at) VALUES (?, ?, ?, 'offline', ?)
       ON CONFLICT(id) DO UPDATE SET token_hash = excluded.token_hash, labels = excluded.labels`,
      id, tokenHash, JSON.stringify(labels ?? []), ctx.now()).run();
    return ok({ id });
  }

  if (method === 'POST' && route[0] === 'push' && route[1] === 'subscribe') {
    if (!body?.subscription?.endpoint) return err(400, 'subscription required');
    await q(ctx.db,
      'INSERT OR REPLACE INTO push_subscriptions (id, subscription, created_at) VALUES (?, ?, ?)',
      body.subscription.endpoint, JSON.stringify(body.subscription), ctx.now()).run();
    return ok({});
  }

  return err(404, 'not found');
}

export async function snapshot(ctx) {
  const tasks = await q(ctx.db, 'SELECT * FROM tasks ORDER BY created_at DESC LIMIT 500').all();
  const nodes = await q(ctx.db, 'SELECT id, labels, status, last_heartbeat_at FROM nodes').all();
  return { t: 'snapshot', tasks: tasks.results ?? tasks, nodes: nodes.results ?? nodes };
}

const ok = (body) => ({ status: 200, body: { ok: true, ...body } });
const err = (status, message) => ({ status, body: { ok: false, error: message } });
