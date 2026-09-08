// Hub coordination logic, decoupled from Durable Object infrastructure so the
// reconciliation/idempotency paths run in plain Node tests.
//
// ctx contract:
//   db          D1-compatible: prepare(sql).bind(...).run()/first()/all()->{results}
//   userId      resolved caller identity for /api/* calls (null for executor uplink)
//   teamId      active team the caller is viewing (X-Team-Id header / WS ?teamId=), null = personal
//   broadcast(msgObj, ownerUserId, teamId) -> void   (frontend sockets viewing that exact team,
//                                                      or the owner's personal channel if teamId is null)
//   sendToNode(nodeId, msgObj)    -> boolean (true if delivered to a live socket)
//   browseNode(nodeId, path)      -> Promise<{entries}|null> (cloud-initiated round trip; null on timeout/offline)
//   listSessions(nodeId, path)    -> Promise<{sessions}|null> (same shape, lists existing claude sessions for a path)
//   push(payload, ownerUserId)    -> void    (web push fan-out, fire and forget)
//   now()                         -> epoch ms
import { userCanTransition, ulid, sha256Hex, MAX_IMAGES_PER_MESSAGE, MAX_ATTACHMENT_TOTAL_RAW_BYTES, ALLOWED_IMAGE_MIME_TYPES, PROTOCOL_VERSION, BACKENDS, DEFAULT_BACKEND, isValidClientMessageId, OUTBOUND_MESSAGE_TTL_MS, FEATURE_MESSAGE_ACK, FEATURE_TASK_IMAGES } from '../../shared/protocol.mjs';
import * as accounts from './accounts.mjs';
import { hashPassword } from './auth.mjs';

const q = (db, sql, ...params) => db.prepare(sql).bind(...params);
const SOURCE_CACHE_TTL_MS = 10 * 60_000;

export async function ackDurableCommand(ctx, nodeId, commandKey) {
  await q(ctx.db, 'DELETE FROM durable_cmds WHERE command_key = ? AND node_id = ?', commandKey, nodeId).run();
}

export async function getTask(ctx, taskId) {
  return await q(ctx.db, 'SELECT * FROM tasks WHERE id = ?', taskId).first();
}

// "Am I allowed to view this team right now?" — a falsy teamId (personal
// mode) always passes; a real one requires actual membership, so a caller
// passing an arbitrary team id they're not in gets rejected rather than
// silently scoped to nothing (or, worse, to everything).
//
// This is deliberately NOT "which users' data can I see" — an earlier
// version resolved a team header into every member's owner_user_id and
// shared anything any of them owned, which meant a user's purely personal
// tasks/nodes leaked into every team they happened to belong to (found
// live: "我现在个人的对话和节点，在每一个团队都能看见"). Sharing now hangs
// off an explicit team_id on the task/node itself (stamped once at creation
// time), never inferred from who's a member of what — see api()'s task/node
// routes below.
async function assertTeamMember(ctx, teamId) {
  if (!teamId) return true;
  const member = await q(ctx.db, 'SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ?', teamId, ctx.userId).first();
  return !!member;
}

// Shared by both the admin-panel add-member route and the self-service one
// below — same upsert-by-username logic either way, just gated differently.
async function addTeamMember(ctx, teamId, username, role) {
  const team = await q(ctx.db, 'SELECT id FROM teams WHERE id = ?', teamId).first();
  if (!team) return err(404, 'team not found');
  const target = await q(ctx.db, 'SELECT id FROM users WHERE username = ?', username).first();
  if (!target) return err(404, 'user not found');
  await q(ctx.db,
    `INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(team_id, user_id) DO UPDATE SET role = excluded.role`,
    teamId, target.id, role, ctx.now()).run();
  return ok({});
}

async function getProviderConfig(db, userId) {
  const u = await q(db, 'SELECT api_base_url, api_key, api_model FROM users WHERE id = ?', userId).first();
  if (!u?.api_base_url || !u?.api_key) return null;
  return { baseUrl: u.api_base_url, apiKey: u.api_key, model: u.api_model || 'gpt-5.6' };
}

// Which agent CLI a model profile drives. Kept in a side table rather than as
// a model_profiles column because schema.sql is entirely
// CREATE TABLE IF NOT EXISTS and deploy/setup-all.sh re-runs the whole file on
// every deploy — a bare ALTER would abort the script the second time round
// (duplicate column) and block every later deploy. Same pattern the repo
// already uses for conversation_claims_v2 / task_teams / node_teams.
// No row = 'claude', which is what every profile predating this is.
async function profileBackend(db, profileId) {
  if (!profileId) return DEFAULT_BACKEND;
  const row = await q(db, 'SELECT backend FROM model_profile_backends WHERE profile_id = ?', profileId).first();
  return row?.backend || DEFAULT_BACKEND;
}

async function setProfileBackend(db, profileId, backend) {
  const value = BACKENDS.includes(backend) ? backend : DEFAULT_BACKEND;
  await q(db,
    `INSERT INTO model_profile_backends (profile_id, backend) VALUES (?, ?)
     ON CONFLICT(profile_id) DO UPDATE SET backend = excluded.backend`,
    profileId, value).run();
}

// What a node last told us it can do. `known` is the important part: handleHello
// writes this row on every connect, so a node with no row has simply never been
// seen by this version of the cloud — which is *not* the same as a node that
// told us it's old. The callers below only refuse on positive evidence, so a
// freshly-registered node whose daemon hasn't started yet can still be given
// work, exactly as before; the authoritative refusal happens in handleHello,
// where the connecting node's real version is in hand.
async function nodeCapabilities(db, nodeId) {
  const row = await q(db, 'SELECT protocol_version, backends FROM node_capabilities WHERE node_id = ?', nodeId).first();
  let backends = [DEFAULT_BACKEND];
  try {
    const p = JSON.parse(row?.backends ?? '[]');
    if (Array.isArray(p)) backends = p.filter(b => BACKENDS.includes(b));
  } catch { /* corrupt -> default */ }
  return { known: !!row, protocolVersion: row?.protocol_version ?? 1, backends };
}

// Client already downscales/validates before ever sending (see
// attachments.js) — this is the independent server-side backstop so a
// modified/bypassed client can't smuggle a bigger or unsupported payload
// through. Same MAX_* constants both sides share, from shared/protocol.mjs,
// sized to stay well under D1's 2,000,000-byte per-value cap once this lands
// in messages.content / pending_cmds.payload. Returns an error string, or null
// when the batch is acceptable. Shared by the two routes that accept images:
// sending into an existing conversation, and creating a new one (whose first
// message is the task's spec).
function imageBatchError(images) {
  if (images.length > MAX_IMAGES_PER_MESSAGE) return `too many images (max ${MAX_IMAGES_PER_MESSAGE})`;
  let totalRawBytes = 0;
  for (const img of images) {
    if (!ALLOWED_IMAGE_MIME_TYPES.includes(img?.mediaType)) return `unsupported image type: ${img?.mediaType}`;
    if (typeof img?.data !== 'string' || !img.data) return 'invalid image data';
    totalRawBytes += Math.floor(img.data.length * 0.75); // base64 -> raw byte estimate
  }
  if (totalRawBytes > MAX_ATTACHMENT_TOTAL_RAW_BYTES) return '图片总大小超出限制,请压缩后重试';
  return null;
}

// Whether a node has told us it supports a given fine-grained feature. No row
// (or a node that predates the feature) answers false — every caller treats
// that as "do the older, safer thing", never as a reason to refuse work.
async function nodeSupports(db, nodeId, feature) {
  const row = await q(db, 'SELECT features FROM node_features WHERE node_id = ?', nodeId).first();
  if (!row) return false;
  try {
    const parsed = JSON.parse(row.features ?? '[]');
    return Array.isArray(parsed) && parsed.includes(feature);
  } catch { return false; }
}

// The backend a task is currently running on. Cloud stores only the profile
// reference (credentials stay executor-side), so this resolves through it; a
// task with no profile is on the default, same as one created before profiles
// carried a backend at all.
async function taskBackend(db, task) {
  return task?.model_profile_id ? await profileBackend(db, task.model_profile_id) : DEFAULT_BACKEND;
}

async function attachTaskBackends(db, tasks) {
  const profileIds = [...new Set(tasks.map(t => t.model_profile_id).filter(Boolean))];
  const byProfile = new Map();
  if (profileIds.length) {
    const rows = await q(db,
      `SELECT profile_id, backend FROM model_profile_backends WHERE profile_id IN (${inClause(profileIds)})`,
      ...profileIds).all();
    for (const row of (rows.results ?? rows)) byProfile.set(row.profile_id, row.backend);
  }
  for (const task of tasks) task.backend = byProfile.get(task.model_profile_id) || DEFAULT_BACKEND;
}

// profileId -> backend for a whole list, in one query (the settings page lists
// every profile; N round-trips would be N D1 calls).
async function profileBackends(db, userId) {
  const rows = await q(db,
    `SELECT b.profile_id, b.backend FROM model_profile_backends b
     JOIN model_profiles p ON p.id = b.profile_id
     WHERE p.owner_user_id = ?`, userId).all();
  return new Map((rows.results ?? rows).map(r => [r.profile_id, r.backend]));
}

async function taskTeamIds(ctx, taskId) {
  const rows = await q(ctx.db, 'SELECT team_id FROM task_teams WHERE task_id = ?', taskId).all();
  return (rows.results ?? rows).map(r => r.team_id);
}

// Batch-attaches `teamIds: string[]` to each task in a list — done in JS
// (one extra query + a grouping pass) rather than SQL json aggregation, so
// this stays portable with the node:sqlite-backed test shim, which may not
// support the same JSON functions D1's real SQLite build does.
async function scopedTasks(ctx, userId) {
  const rows = ctx.teamId
    ? await q(ctx.db,
        `SELECT tasks.*, users.username AS owner_username FROM tasks
         LEFT JOIN users ON users.id = tasks.owner_user_id
         WHERE tasks.id IN (SELECT task_id FROM task_teams WHERE team_id = ?)
         ORDER BY tasks.created_at DESC LIMIT 500`, ctx.teamId).all()
    : await q(ctx.db,
        `SELECT tasks.*, users.username AS owner_username FROM tasks
         LEFT JOIN users ON users.id = tasks.owner_user_id
         WHERE tasks.owner_user_id = ? AND tasks.id NOT IN (SELECT task_id FROM task_teams)
         ORDER BY tasks.created_at DESC LIMIT 500`, userId).all();
  return rows.results ?? rows;
}

async function authorizedConversationRoots(ctx, userId) {
  const rows = ctx.teamId
    ? await q(ctx.db,
        `SELECT DISTINCT tasks.node_id, tasks.repo_url FROM tasks
         JOIN task_teams ON task_teams.task_id = tasks.id AND task_teams.team_id = ?
         JOIN nodes ON nodes.id = tasks.node_id AND nodes.owner_user_id = tasks.owner_user_id
         JOIN node_teams ON node_teams.node_id = nodes.id AND node_teams.team_id = ?
         WHERE tasks.repo_url IS NOT NULL`, ctx.teamId, ctx.teamId).all()
    : await q(ctx.db,
        `SELECT DISTINCT tasks.node_id, tasks.repo_url FROM tasks
         JOIN nodes ON nodes.id = tasks.node_id AND nodes.owner_user_id = tasks.owner_user_id
         WHERE tasks.owner_user_id = ? AND tasks.id NOT IN (SELECT task_id FROM task_teams)
           AND tasks.repo_url IS NOT NULL`, userId).all();
  return (rows.results ?? rows).filter(row => isLocalTaskPath(String(row.repo_url || '')));
}

function rootsByNode(rows) {
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.node_id)) grouped.set(row.node_id, new Set());
    grouped.get(row.node_id).add(row.repo_url);
  }
  return grouped;
}

async function existingTaskInScope(ctx, task, userId) {
  if (!task) return null;
  const teamIds = await taskTeamIds(ctx, task.id);
  const visible = ctx.teamId ? teamIds.includes(ctx.teamId) : task.owner_user_id === userId && teamIds.length === 0;
  if (!visible) return null;
  task.teamIds = teamIds;
  return task;
}

async function attachTeamIds(ctx, tasks) {
  if (!tasks.length) return;
  const ids = tasks.map(t => t.id);
  const rows = await q(ctx.db, `SELECT task_id, team_id FROM task_teams WHERE task_id IN (${inClause(ids)})`, ...ids).all();
  const byTask = new Map();
  for (const r of (rows.results ?? rows)) {
    if (!byTask.has(r.task_id)) byTask.set(r.task_id, []);
    byTask.get(r.task_id).push(r.team_id);
  }
  for (const t of tasks) t.teamIds = byTask.get(t.id) ?? [];
}

// `col IN (?,?,...)` placeholder string for a dynamic-length id list.
const inClause = (ids) => ids.map(() => '?').join(',');
const isLocalTaskPath = (value) => /^\//.test(value) || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);

// Shared by every broadcast that needs to reach "wherever this resource is
// currently shared" — zero associations means personal (owner's own
// channel only), one or more means every one of those, not just the first.
function fanOutToTeamsOrOwner(ctx, msg, ownerUserId, teamIds) {
  if (teamIds.length) {
    for (const teamId of teamIds) ctx.broadcast(msg, ownerUserId, teamId);
  } else {
    ctx.broadcast(msg, ownerUserId, null);
  }
}

async function broadcastTask(ctx, taskId) {
  // Joined (not the plain getTask() used for internal permission checks)
  // so a live update never wipes out owner_username on the client — the
  // frontend's store replaces the whole task object per update (see
  // store.js's upsertTask), it doesn't merge, so a broadcast missing this
  // field would make the "谁创建的" indicator vanish after the first
  // status change.
  // LEFT JOIN, not JOIN — a task must still be returned even if its owner's
  // users row is somehow missing (e.g. test fixtures that only ever insert
  // enough to exercise a specific path never bother with a full users row).
  const task = await q(ctx.db,
    `SELECT tasks.*, users.username AS owner_username FROM tasks
     LEFT JOIN users ON users.id = tasks.owner_user_id WHERE tasks.id = ?`, taskId).first();
  if (task) {
    const teamIds = await taskTeamIds(ctx, taskId);
    task.teamIds = teamIds;
    task.backend = await taskBackend(ctx.db, task);
    fanOutToTeamsOrOwner(ctx, { t: 'task', task }, task.owner_user_id, teamIds);
  }
  return task;
}

async function nodeTeamIds(ctx, nodeId) {
  const rows = await q(ctx.db, 'SELECT team_id FROM node_teams WHERE node_id = ?', nodeId).all();
  return (rows.results ?? rows).map(r => r.team_id);
}

async function attachNodeTeamIds(ctx, nodes) {
  if (!nodes.length) return;
  const ids = nodes.map(n => n.id);
  const rows = await q(ctx.db, `SELECT node_id, team_id FROM node_teams WHERE node_id IN (${inClause(ids)})`, ...ids).all();
  const byNode = new Map();
  for (const r of (rows.results ?? rows)) {
    if (!byNode.has(r.node_id)) byNode.set(r.node_id, []);
    byNode.get(r.node_id).push(r.team_id);
  }
  for (const n of nodes) n.teamIds = byNode.get(n.id) ?? [];
}

// Same reasoning as broadcastTask's join above — store.js's upsertNode also
// replaces (not merges) per update, so every 'node' broadcast needs
// owner_username (and now teamIds) or it disappears/reverts from the client
// after the first heartbeat.
async function nodePub(ctx, nodeId) {
  const node = await q(ctx.db,
    `SELECT nodes.id, nodes.name, nodes.owner_user_id, users.username AS owner_username, nodes.labels, nodes.status, nodes.last_heartbeat_at
     FROM nodes LEFT JOIN users ON users.id = nodes.owner_user_id WHERE nodes.id = ?`, nodeId).first();
  if (node) node.teamIds = await nodeTeamIds(ctx, nodeId);
  return node;
}

// broadcastNode() is nodePub()'s broadcast counterpart, mirroring
// broadcastTask() — every node status change (hello/heartbeat/offline/team
// add-remove) needs to reach every project it's currently shared with, not
// just its personal channel or a single stale team_id.
async function broadcastNode(ctx, nodeId, ownerUserId) {
  const node = await nodePub(ctx, nodeId);
  if (node) fanOutToTeamsOrOwner(ctx, { t: 'node', node }, ownerUserId, node.teamIds);
  return node;
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
    const teamIds = inserted || ev.role === 'user' ? await taskTeamIds(ctx, taskId) : null;
    if (inserted) {
      fanOutToTeamsOrOwner(ctx, { t: 'msg', taskId, seq, role: ev.role, content: ev.content, ts: ev.ts ?? now },
        task.owner_user_id, teamIds);
    }
    // The node has now told us this exact send is in the conversation, and
    // the INSERT above (or a previous one, on a replayed event) proves it's
    // stored — only now is the pending bubble retired. Ordering matters:
    // settling first would leave a window where the message exists nowhere
    // at all. Deliberately not gated on `inserted`: a replay whose insert was
    // a no-op still has to clear a pending row left behind by a settle that
    // didn't complete last time.
    if (ev.role === 'user' && ev.content?.clientMessageId) {
      await settleOutboundMessage(ctx, task, ev.content.clientMessageId, teamIds);
    }
  } else if (ev.k === 'status' && fresh) {
    const extra = ev.extra || {};
    const prev = task.status;
    // pending_request only changes when the executor says so — a lease toggle
    // or cost-fuse status event must not wipe an open approval prompt. Same
    // idea for last_error: most status events don't mention it and should
    // leave whatever's there alone, but a retry needs to actually clear a
    // stale error rather than just silently keeping it around once the task
    // is running again — same explicit-clear-flag pattern as clearPending.
    const pending = extra.pendingRequest ? JSON.stringify(extra.pendingRequest)
      : (extra.clearPending ? null : task.pending_request);
    const lastError = extra.error !== undefined ? extra.error : (extra.clearError ? null : task.last_error);
    await q(ctx.db,
      `UPDATE tasks SET status = ?, pending_request = ?, last_error = ?,
         lease = COALESCE(?, lease), updated_at = ? WHERE id = ?`,
      ev.status, pending, lastError, extra.lease ?? null, now, taskId,
    ).run();
    await broadcastTask(ctx, taskId);
    if (prev !== ev.status) {
      notifyStatus(ctx, { ...task, status: ev.status, last_error: extra.error }, extra);
    }
    // The turn just ended — hand the agent whatever the human queued while it
    // was busy. Keyed on the transition, not the new status alone, so a
    // repeated 'running' heartbeat can't release anything mid-turn.
    if (BUSY_STATUSES.has(prev) && !BUSY_STATUSES.has(ev.status)) {
      await releaseNextQueuedMessage(ctx, { ...task, status: ev.status });
    }
  } else if (ev.k === 'session' && fresh) {
    await q(ctx.db, 'UPDATE tasks SET session_id = ?, updated_at = ? WHERE id = ?', ev.sessionId, now, taskId).run();
    await broadcastTask(ctx, taskId);
  } else if (ev.k === 'cost' && fresh) {
    await q(ctx.db, 'UPDATE tasks SET cost_usd = ?, updated_at = ? WHERE id = ?', ev.costUsd, now, taskId).run();
    await broadcastTask(ctx, taskId);
  } else if (ev.k === 'usage' && fresh) {
    await q(ctx.db, 'UPDATE tasks SET context_tokens = ?, updated_at = ? WHERE id = ?', ev.contextTokens, now, taskId).run();
    await broadcastTask(ctx, taskId);
  }

  await q(ctx.db, 'UPDATE tasks SET last_seq = MAX(last_seq, ?) WHERE id = ?', seq, taskId).run();
  ctx.sendToNode(nodeId, { t: 'ack', taskId, seq });
}

function notifyStatus(ctx, task, extra = {}) {
  const title = task.title || task.id;
  if (task.status === 'waiting_human') {
    const tool = extra.pendingRequest?.toolName;
    ctx.push({ title: '⏸ 等你决策', body: tool ? `「${title}」请求使用:${tool}` : `「${title}」${extra.note || '在等你回复'}`, taskId: task.id }, task.owner_user_id);
  } else if (task.status === 'review') {
    ctx.push({ title: '✅ 待 Review', body: `「${title}」已完成,等待你审阅`, taskId: task.id }, task.owner_user_id);
  } else if (task.status === 'failed') {
    ctx.push({ title: '❌ 任务失败', body: `「${title}」${(task.last_error || '').slice(0, 120)}`, taskId: task.id }, task.owner_user_id);
  }
}

export async function handleHello(ctx, nodeId, msg) {
  const now = ctx.now();
  const nodeRow = await q(ctx.db, 'SELECT owner_user_id FROM nodes WHERE id = ?', nodeId).first();
  const ownerId = nodeRow?.owner_user_id ?? null;
  await q(ctx.db, "UPDATE nodes SET status = 'online', last_heartbeat_at = ? WHERE id = ?", now, nodeId).run();
  // Recorded before anything is dispatched: task creation reads this back to
  // decide whether this node can run the requested backend at all. A node that
  // predates the version field reports nothing and lands on the v1 default.
  const backends = Array.isArray(msg.backends) ? msg.backends.filter(b => BACKENDS.includes(b)) : [];
  const nodeProtocol = Number(msg.protocolVersion) || 1;
  await q(ctx.db,
    `INSERT INTO node_capabilities (node_id, protocol_version, backends, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(node_id) DO UPDATE SET protocol_version = excluded.protocol_version,
       backends = excluded.backends, updated_at = excluded.updated_at`,
    nodeId, nodeProtocol,
    JSON.stringify(Array.isArray(msg.backends) ? backends : [DEFAULT_BACKEND]), now).run();
  // Recorded on every hello so an upgrade is picked up the moment the daemon
  // reconnects — and, just as importantly, so a *downgrade* (a node rolled
  // back to older code) stops the cloud from relying on a capability that's
  // no longer there.
  const features = Array.isArray(msg.features) ? msg.features.filter(f => typeof f === 'string') : [];
  await q(ctx.db,
    `INSERT INTO node_features (node_id, features, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(node_id) DO UPDATE SET features = excluded.features, updated_at = excluded.updated_at`,
    nodeId, JSON.stringify(features), now).run();
  await broadcastNode(ctx, nodeId, ownerId);

  // Reconciliation: the execution site is the truth — its reported state
  // overwrites whatever the cloud thought (including 'unknown').
  const replay = [];
  for (const lt of msg.tasks || []) {
    const cloud = await getTask(ctx, lt.taskId);
    if (!cloud || cloud.node_id !== nodeId) continue;
    if (cloud.status !== lt.status || (cloud.session_id ?? null) !== (lt.sessionId ?? null)
      || cloud.cost_usd !== lt.costUsd || cloud.lease !== lt.lease
      || (cloud.context_tokens ?? null) !== (lt.contextTokens ?? null)) {
      await q(ctx.db,
        'UPDATE tasks SET status = ?, session_id = ?, cost_usd = ?, lease = ?, context_tokens = ?, updated_at = ? WHERE id = ?',
        lt.status, lt.sessionId ?? null, lt.costUsd ?? 0, lt.lease ?? 'daemon', lt.contextTokens ?? null, now, lt.taskId,
      ).run();
      await broadcastTask(ctx, lt.taskId);
    }
    // Opposite direction from the reconciliation above: permission_mode,
    // auto_decide_all and the model-profile override are cloud-issued
    // settings (set via the decision/switch-model routes, pushed to the
    // node as one-shot 'set_permission_mode'/'set_auto_decide_all'/
    // 'set_provider_override' commands) — the node has no way to
    // independently arrive at a different value the way it does for live
    // execution state, so cloud is authoritative for these, not the node.
    // A one-shot push has no way to self-heal if it's ever missed or the
    // node's local write doesn't stick for any reason — found live: a
    // task's auto_decide_all silently drifted back to 0 locally more than
    // once with nothing to notice or correct it, leaving "自动授权所有请求"
    // quietly not actually in effect. Re-asserting on every reconnect
    // closes that gap.
    const entry = {
      taskId: lt.taskId, lastSeq: cloud.last_seq ?? 0,
      permissionMode: cloud.permission_mode, autoDecideAll: !!cloud.auto_decide_all,
    };
    // NULL = legacy/never-switched — assert nothing (tasks created before
    // this column existed can carry a real executor-side override from
    // their original start_task; blindly asserting null would wipe it).
    // '' = explicitly reverted to 默认配置 via switch-model — assert null.
    // Non-empty = pinned to that profile — resolve and assert it.
    if (cloud.model_profile_id && ownerId) {
      const profile = await q(ctx.db,
        'SELECT base_url, api_key, model FROM model_profiles WHERE id = ? AND owner_user_id = ?', cloud.model_profile_id, ownerId).first();
      // Profile deleted since -> nothing to re-assert; the executor keeps
      // whatever override it already has (same as before this existed).
      if (profile) {
        entry.providerOverride = { baseUrl: profile.base_url, apiKey: profile.api_key, model: profile.model };
        entry.backend = await profileBackend(ctx.db, cloud.model_profile_id);
      }
    } else if (cloud.model_profile_id === '') {
      entry.providerOverride = null;
    }
    replay.push(entry);
  }
  // This is the one place the node's real protocol version is in hand, so it's
  // where an outdated node actually gets stopped. Everything above still ran:
  // the board stays truthful about what that node is doing. What it does not
  // get is *work* — `provider` and `start_task.provider` were called
  // `anthropic` in v1 with no compatibility layer, so a v1 node would drop
  // them and run against the wrong relay while looking perfectly healthy.
  // Queued work simply stays queued until the daemon is upgraded.
  if (nodeProtocol < PROTOCOL_VERSION) {
    ctx.sendToNode(nodeId, { t: 'hello_ok', tasks: replay, provider: null, upgradeRequired: PROTOCOL_VERSION });
    return;
  }

  // The node always leaves with fresh relay credentials — no local config editing ever needed.
  const provider = ownerId ? await getProviderConfig(ctx.db, ownerId) : null;
  ctx.sendToNode(nodeId, { t: 'hello_ok', tasks: replay, provider });

  // Durable commands are persisted before first delivery and removed only
  // after the executor has written them to local SQLite. Reconnect replay is
  // therefore safe even if a socket accepted send() but died before handling.
  const durable = await q(ctx.db, 'SELECT command_key, payload FROM durable_cmds WHERE node_id = ? ORDER BY created_at', nodeId).all();
  for (const row of durable.results ?? durable) {
    if (!ctx.sendToNode(nodeId, { ...JSON.parse(row.payload), commandKey: row.command_key })) break;
  }

  // Legacy pending commands (created while offline before durable outbox).
  const pend = await q(ctx.db, 'SELECT id, payload FROM pending_cmds WHERE node_id = ? ORDER BY id', nodeId).all();
  for (const row of pend.results ?? pend) {
    if (!ctx.sendToNode(nodeId, JSON.parse(row.payload))) break; // socket died: keep for next hello
    await q(ctx.db, 'DELETE FROM pending_cmds WHERE id = ?', row.id).run();
  }

  // Anything the user sent while this node was away (or into a socket that
  // silently swallowed it) goes out again now. Idempotent at the executor by
  // clientMessageId, so redelivering one that actually did land is a no-op
  // rather than a duplicate turn.
  await flushOutboundMessages(ctx, nodeId);
}

export async function handleHeartbeat(ctx, nodeId) {
  const node = await q(ctx.db, 'SELECT status, owner_user_id FROM nodes WHERE id = ?', nodeId).first();
  await q(ctx.db, "UPDATE nodes SET status = 'online', last_heartbeat_at = ? WHERE id = ?", ctx.now(), nodeId).run();
  if (node && node.status === 'offline') {
    // We marked it dead (e.g. its event loop was busy cloning) but the socket
    // survived — ask for a fresh hello so tasks leave 'unknown'.
    await broadcastNode(ctx, nodeId, node.owner_user_id);
    ctx.sendToNode(nodeId, { t: 'resync' });
  }
}

export async function markNodeOffline(ctx, nodeId) {
  const node = await q(ctx.db, 'SELECT owner_user_id, status FROM nodes WHERE id = ?', nodeId).first();
  if (!node || node.status === 'offline') return;
  await q(ctx.db, "UPDATE nodes SET status = 'offline' WHERE id = ?", nodeId).run();
  await broadcastNode(ctx, nodeId, node.owner_user_id);
  const active = await q(ctx.db,
    "SELECT id FROM tasks WHERE node_id = ? AND status IN ('queued','starting','running','waiting_human','idle')", nodeId).all();
  for (const row of active.results ?? active) {
    await q(ctx.db, "UPDATE tasks SET status = 'unknown', updated_at = ? WHERE id = ?", ctx.now(), row.id).run();
    await broadcastTask(ctx, row.id);
  }
  ctx.push({ title: '⚠️ 节点失联', body: `节点「${nodeId}」离线,其任务状态未知`, nodeId }, node.owner_user_id);
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

// ---------- outbound user messages ----------
// A chat send is the one command whose loss is silent *and* destroys user
// content: every other command can be re-issued by clicking the button again,
// but a message the user already typed is gone with nothing left on screen to
// retry (reported live: "发了一个消息后，直接永久消失"). So a send is not
// fire-and-forget — it is persisted here first, dispatched as a durable
// command, redelivered on every reconnect, and only retired once the node
// echoes it back as its own {k:'msg', role:'user'} event.

const pendingRowToWire = (row) => {
  const payload = JSON.parse(row.payload);
  return {
    clientMessageId: row.client_message_id,
    text: payload.text ?? '',
    images: payload.images ?? [],
    state: row.state,
    attempts: row.attempts,
    createdAt: row.created_at,
    senderUserId: row.sender_user_id ?? null,
  };
};

export async function pendingMessagesFor(ctx, taskId) {
  const rows = await q(ctx.db,
    'SELECT * FROM outbound_messages WHERE task_id = ? ORDER BY created_at', taskId).all();
  return (rows.results ?? rows).map(pendingRowToWire);
}

// Whether any send is still waiting to be delivered anywhere — the Hub uses
// this to keep its alarm alive while nothing else needs it, so a message
// queued for an offline node still gets retried (and eventually times out)
// instead of freezing until some unrelated node reconnects.
export async function hasPendingOutboundMessages(ctx) {
  const row = await q(ctx.db, "SELECT 1 FROM outbound_messages WHERE state = 'pending' LIMIT 1").first();
  return !!row;
}

function userMessagePayload(row) {
  const payload = JSON.parse(row.payload);
  return {
    t: 'user_message', taskId: row.task_id, text: payload.text ?? '',
    images: payload.images ?? [], clientMessageId: row.client_message_id,
  };
}

// Accept-then-deliver: the row is written *before* anything goes on the wire,
// so a send that returns 200 is already recoverable even if the DO dies on
// the very next line. outbound_messages is the only queue for a send —
// deliberately not also durable_cmds, whose ack means "the node wrote it
// down", a weaker signal than the one used here ("the node put it in the
// conversation") and one that would double-send on every reconnect.
// A turn is in flight. Sending into one isn't an error — the CLI accepts the
// write — but the human loses all control of it: it's already gone by the time
// they realise the agent was about to do the thing they were trying to
// redirect, and there's nothing left to edit or take back. Holding it here
// instead keeps it editable and cancellable until the turn actually ends.
const BUSY_STATUSES = new Set(['running', 'starting']);
const isTaskBusy = (task) => BUSY_STATUSES.has(task?.status);

// Exactly one, deliberately: delivering it puts the task straight back into
// 'running', so anything else still queued has to wait for *that* turn to end
// too. Draining the whole queue at once would dump every held message into a
// single turn, which is the opposite of what queueing them was for.
async function releaseNextQueuedMessage(ctx, task) {
  const row = await q(ctx.db,
    "SELECT * FROM outbound_messages WHERE task_id = ? AND state = 'queued' ORDER BY created_at LIMIT 1",
    task.id).first();
  if (!row) return false;
  const now = ctx.now();
  await q(ctx.db,
    "UPDATE outbound_messages SET state = 'pending', updated_at = ? WHERE task_id = ? AND client_message_id = ?",
    now, task.id, row.client_message_id).run();
  const released = { ...row, state: 'pending', updated_at: now };
  const teamIds = await taskTeamIds(ctx, task.id);
  fanOutToTeamsOrOwner(ctx, { t: 'pending_msg', taskId: task.id, pending: pendingRowToWire(released) },
    task.owner_user_id, teamIds);
  await deliverPendingMessage(ctx, released);
  return true;
}

async function acceptUserMessage(ctx, task, clientMessageId, text, images, senderUserId, { queue = false } = {}) {
  const now = ctx.now();
  const existing = await q(ctx.db,
    'SELECT * FROM outbound_messages WHERE task_id = ? AND client_message_id = ?',
    task.id, clientMessageId).first();
  // Same id arriving twice is a retry of one send (a re-sent fetch, an
  // impatient second click), not two messages — keep the original row so the
  // text can never be queued, and therefore answered, twice.
  const hold = queue && isTaskBusy(task);
  if (!existing) {
    await q(ctx.db,
      `INSERT INTO outbound_messages (task_id, client_message_id, node_id, sender_user_id, payload, state, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      task.id, clientMessageId, task.node_id, senderUserId ?? null,
      JSON.stringify({ text, images }), hold ? 'queued' : 'pending', now, now).run();
  }
  const row = existing ?? await q(ctx.db,
    'SELECT * FROM outbound_messages WHERE task_id = ? AND client_message_id = ?',
    task.id, clientMessageId).first();
  const teamIds = await taskTeamIds(ctx, task.id);
  // Visible everywhere immediately — not just in the tab that sent it. A
  // second device (or the same one after a refresh) reads the same row back
  // via GET /messages, so an in-flight message is never invisible content.
  fanOutToTeamsOrOwner(ctx, { t: 'pending_msg', taskId: task.id, pending: pendingRowToWire(row) },
    task.owner_user_id, teamIds);
  // Held for the current turn — nothing goes on the wire, and the row stays
  // editable until releaseNextQueuedMessage picks it up.
  if (row.state === 'queued') return { queued: true, held: true };
  const delivered = await deliverPendingMessage(ctx, row);
  // A node that can't echo the id back can never settle this row, and
  // retrying it would make that node re-run the turn for real — burning relay
  // tokens on a duplicate. So for such a node, delivery is best-effort
  // exactly as it was before this mechanism existed: hand it over once, then
  // settle optimistically. Only matters during an upgrade window; every node
  // that reconnects on current code gets the real guarantee.
  if (delivered && !(await nodeSupports(ctx.db, task.node_id, FEATURE_MESSAGE_ACK))) {
    await settleOutboundMessage(ctx, task, clientMessageId, teamIds);
    return { queued: false };
  }
  return { queued: !delivered };
}

// Best-effort push of one pending row. Returns whether the socket accepted it
// — which is explicitly NOT "delivered": only the node's own echoed event
// settles the row (see settleOutboundMessage), because a half-open socket
// accepts writes that never arrive.
async function deliverPendingMessage(ctx, row) {
  const sent = ctx.sendToNode(row.node_id, userMessagePayload(row));
  await q(ctx.db,
    'UPDATE outbound_messages SET attempts = attempts + 1, updated_at = ? WHERE task_id = ? AND client_message_id = ?',
    ctx.now(), row.task_id, row.client_message_id).run();
  return sent;
}

// The node reported the user message as its own event: the send has landed in
// the conversation for real, so the pending bubble (and its durable command)
// can go. Called from absorbEvent, i.e. only after the message row itself is
// safely in D1.
async function settleOutboundMessage(ctx, task, clientMessageId, teamIds) {
  const row = await q(ctx.db,
    'SELECT 1 FROM outbound_messages WHERE task_id = ? AND client_message_id = ?',
    task.id, clientMessageId).first();
  if (!row) return;
  await q(ctx.db, 'DELETE FROM outbound_messages WHERE task_id = ? AND client_message_id = ?',
    task.id, clientMessageId).run();
  fanOutToTeamsOrOwner(ctx, { t: 'pending_settled', taskId: task.id, clientMessageId, state: 'delivered' },
    task.owner_user_id, teamIds ?? await taskTeamIds(ctx, task.id));
}

// Redelivery pass, run on every hello and from the Hub's alarm: anything
// still pending gets pushed again, and anything that has been pending past
// the TTL is marked failed so the sender sees a retryable bubble instead of
// a message quietly stuck forever. minAgeMs keeps the timer pass from
// re-sending something that was handed to a healthy socket seconds ago —
// a redelivery is harmless (the executor dedupes by id) but pointless.
export async function flushOutboundMessages(ctx, nodeId = null, { minAgeMs = 0 } = {}) {
  const rows = nodeId
    ? await q(ctx.db, "SELECT * FROM outbound_messages WHERE state = 'pending' AND node_id = ? ORDER BY created_at", nodeId).all()
    : await q(ctx.db, "SELECT * FROM outbound_messages WHERE state = 'pending' ORDER BY created_at").all();
  const now = ctx.now();
  for (const row of (rows.results ?? rows)) {
    if (now - row.created_at > OUTBOUND_MESSAGE_TTL_MS) {
      await q(ctx.db,
        "UPDATE outbound_messages SET state = 'failed', updated_at = ? WHERE task_id = ? AND client_message_id = ?",
        now, row.task_id, row.client_message_id).run();
      const task = await getTask(ctx, row.task_id);
      if (task) {
        fanOutToTeamsOrOwner(ctx,
          { t: 'pending_settled', taskId: row.task_id, clientMessageId: row.client_message_id, state: 'failed' },
          task.owner_user_id, await taskTeamIds(ctx, row.task_id));
      }
      continue;
    }
    if (now - (row.updated_at ?? row.created_at) < minAgeMs) continue;
    const sent = await deliverPendingMessage(ctx, row);
    // Same reasoning as acceptUserMessage: a node that can't confirm must be
    // handed a message once, not repeatedly — each redelivery would be a real
    // duplicate turn there. Settle optimistically so it stops being retried.
    if (sent && !(await nodeSupports(ctx.db, row.node_id, FEATURE_MESSAGE_ACK))) {
      const task = await getTask(ctx, row.task_id);
      if (task) await settleOutboundMessage(ctx, task, row.client_message_id);
    }
  }
}

// Explicit user-driven retry of a message the cloud gave up on. Resets the
// clock rather than creating a new row, so the conversation still shows one
// bubble for one thing the user typed.
async function retryOutboundMessage(ctx, task, clientMessageId) {
  const row = await q(ctx.db,
    'SELECT * FROM outbound_messages WHERE task_id = ? AND client_message_id = ?',
    task.id, clientMessageId).first();
  if (!row) return false;
  const now = ctx.now();
  await q(ctx.db,
    "UPDATE outbound_messages SET state = 'pending', node_id = ?, created_at = ?, updated_at = ? WHERE task_id = ? AND client_message_id = ?",
    task.node_id, now, now, task.id, clientMessageId).run();
  const fresh = await q(ctx.db,
    'SELECT * FROM outbound_messages WHERE task_id = ? AND client_message_id = ?',
    task.id, clientMessageId).first();
  fanOutToTeamsOrOwner(ctx, { t: 'pending_msg', taskId: task.id, pending: pendingRowToWire(fresh) },
    task.owner_user_id, await taskTeamIds(ctx, task.id));
  await deliverPendingMessage(ctx, fresh);
  return true;
}

// Push fresh relay credentials to every currently-connected node of a user —
// called right after they save new API settings, so already-running nodes
// pick it up without a restart (offline nodes get it for free via hello_ok).
export async function pushConfigToUser(ctx, userId) {
  const provider = await getProviderConfig(ctx.db, userId);
  if (!provider) return;
  const rows = await q(ctx.db, "SELECT id FROM nodes WHERE owner_user_id = ? AND status = 'online'", userId).all();
  for (const n of rows.results ?? rows) ctx.sendToNode(n.id, { t: 'config', provider });
}

async function rowsForNodeChunks(ctx, sqlTemplate, nodeIds) {
  const rows = [];
  for (let offset = 0; offset < nodeIds.length; offset += 90) {
    const chunk = nodeIds.slice(offset, offset + 90);
    const result = await q(ctx.db, sqlTemplate.replace('NODE_IDS', inClause(chunk)), ...chunk).all();
    rows.push(...(result.results ?? result));
  }
  return rows;
}

async function discoverConversationSources(ctx, userId) {
  if (!(await assertTeamMember(ctx, ctx.teamId))) return { denied: true, sources: [], unavailableNodeIds: [] };
  await ctx.db.batch([
    q(ctx.db, 'DELETE FROM conversation_source_cache WHERE expires_at <= ?', ctx.now()),
    q(ctx.db, 'DELETE FROM conversation_history_cursors_v3 WHERE expires_at <= ?', ctx.now()),
    q(ctx.db, 'DELETE FROM conversation_history_cursors_v2 WHERE expires_at <= ?', ctx.now()),
    q(ctx.db, 'DELETE FROM conversation_history_cursors WHERE expires_at <= ?', ctx.now()),
  ]);
  const roots = await authorizedConversationRoots(ctx, userId);
  const grouped = rootsByNode(roots);
  if (!grouped.size) return { denied: false, sources: [], unavailableNodeIds: [] };
  const groupedEntries = [...grouped];
  const scannedGroups = new Map(groupedEntries.slice(0, 90));
  const nodeIds = [...scannedGroups.keys()];
  const [legacyRows, oldClaimRows, claimRows] = await Promise.all([
    rowsForNodeChunks(ctx, 'SELECT node_id,session_id,repo_url AS source_cwd FROM tasks WHERE session_id IS NOT NULL AND node_id IN (NODE_IDS)', nodeIds),
    rowsForNodeChunks(ctx, 'SELECT node_id,session_id,source_cwd FROM conversation_claims WHERE node_id IN (NODE_IDS)', nodeIds),
    rowsForNodeChunks(ctx, 'SELECT node_id,session_id,source_cwd FROM conversation_claims_v2 WHERE node_id IN (NODE_IDS)', nodeIds),
  ]);
  const represented = new Set([...legacyRows, ...oldClaimRows, ...claimRows]
    .map(row => `${row.node_id}\0${row.session_id}\0${row.source_cwd || ''}`));
  const sources = [];
  const unavailableNodeIds = groupedEntries.slice(90).map(([nodeId]) => nodeId);
  await Promise.all([...scannedGroups].map(async ([nodeId, pathSet]) => {
    const result = await ctx.listProjectSessions?.(nodeId, [...pathSet]);
    if (!result) { unavailableNodeIds.push(nodeId); return; }
    for (const session of result.sessions || []) {
      if (!session?.sessionId || !session?.cwd || represented.has(`${nodeId}\0${session.sessionId}\0${session.cwd}`)) continue;
      const id = (await sha256Hex(`${nodeId}\0${session.sessionId}\0${session.cwd}`)).slice(0, 32);
      sources.push({ id, nodeId, sessionId: session.sessionId, cwd: session.cwd, path: session.path || session.cwd, preview: session.preview || '(空会话)', mtime: session.mtime || 0 });
    }
  }));
  sources.sort((a, b) => b.mtime - a.mtime);
  if (sources.length > 500) sources.length = 500;
  if (sources.length) {
    const expiresAt = ctx.now() + SOURCE_CACHE_TTL_MS;
    const statements = [];
    for (let offset = 0; offset < sources.length; offset += 14) {
      const chunk = sources.slice(offset, offset + 14);
      const values = chunk.map(() => '(?,?,?,?,?,?,?)').join(',');
      const params = chunk.flatMap(source => [source.id, source.nodeId, source.sessionId, source.cwd, source.preview, source.mtime, expiresAt]);
      statements.push(q(ctx.db,
        `INSERT INTO conversation_source_cache (source_id,node_id,session_id,source_cwd,preview,mtime,expires_at)
         VALUES ${values} ON CONFLICT(source_id) DO UPDATE SET node_id=excluded.node_id,session_id=excluded.session_id,
         source_cwd=excluded.source_cwd,preview=excluded.preview,mtime=excluded.mtime,expires_at=excluded.expires_at`, ...params));
    }
    await ctx.db.batch(statements);
  }
  return { denied: false, sources, unavailableNodeIds };
}

async function invalidateConversationSource(ctx, nodeId, sessionId, sourceId, taskId, ownerUserId) {
  await ctx.db.batch([
    q(ctx.db, 'DELETE FROM conversation_source_cache WHERE source_id = ?', sourceId),
    q(ctx.db, 'DELETE FROM conversation_history_cursors_v3 WHERE source_id = ?', sourceId),
    q(ctx.db, 'DELETE FROM conversation_history_cursors_v2 WHERE source_id = ?', sourceId),
  ]);
  const roots = await q(ctx.db,
    `SELECT DISTINCT task_teams.team_id FROM tasks
     JOIN task_teams ON task_teams.task_id = tasks.id
     JOIN nodes ON nodes.id = tasks.node_id AND nodes.owner_user_id = tasks.owner_user_id
     JOIN node_teams ON node_teams.node_id = nodes.id AND node_teams.team_id = task_teams.team_id
     WHERE tasks.node_id = ? AND tasks.repo_url IS NOT NULL`, nodeId).all();
  for (const row of roots.results ?? roots) ctx.broadcast({ t: 'conversation_source_claimed', sourceId, taskId }, ownerUserId, row.team_id);
  const node = await q(ctx.db, 'SELECT owner_user_id FROM nodes WHERE id = ?', nodeId).first();
  const personalRoot = node && await q(ctx.db,
    `SELECT 1 FROM tasks WHERE node_id = ? AND owner_user_id = ?
     AND id NOT IN (SELECT task_id FROM task_teams) AND repo_url IS NOT NULL LIMIT 1`, nodeId, node.owner_user_id).first();
  if (personalRoot) ctx.broadcast({ t: 'conversation_source_claimed', sourceId, taskId }, node.owner_user_id, null);
}

// ---------- user-facing API (returns {status, body}) ----------
// ctx.userId must be set by the caller for every route below.

export async function api(ctx, method, pathname, body) {
  const seg = pathname.split('/').filter(Boolean); // ['api', ...]
  const route = seg.slice(1);
  const userId = ctx.userId;
  if (!userId) return err(401, 'unauthorized');

  if (method === 'GET' && route[0] === 'tasks' && route.length === 1) {
    // assertTeamMember and the main list query don't depend on each other
    // (the WHERE clause below already scopes correctly on its own) — running
    // them concurrently instead of sequentially awaiting one after the other
    // saves a full D1 round trip on every load, which matters most exactly
    // when it's felt: switching between personal/project views (reported
    // live as noticeably sluggish).
    // owner_username only actually differs from "me" in team view, but it's
    // cheap to always include — lets the UI show "谁创建的" without a
    // separate round trip once more than one person's tasks are in the list.
    const [isMember, tasks] = await Promise.all([
      assertTeamMember(ctx, ctx.teamId), scopedTasks(ctx, userId),
    ]);
    if (!isMember) return err(403, 'not a member of that team');
    await Promise.all([attachTeamIds(ctx, tasks), attachTaskBackends(ctx.db, tasks)]);
    return ok({ tasks });
  }

  if (method === 'GET' && route[0] === 'conversation-sources' && route.length === 1) {
    const discovered = await discoverConversationSources(ctx, userId);
    if (discovered.denied) return err(403, 'not a member of that team');
    // Revalidate after the node round trip so a removed membership/node/root
    // cannot leak a preview from stale authority.
    if (!(await assertTeamMember(ctx, ctx.teamId))) return err(403, 'not a member of that team');
    const stillAuthorized = rootsByNode(await authorizedConversationRoots(ctx, userId));
    discovered.sources = discovered.sources.filter(source => stillAuthorized.get(source.nodeId)?.has(source.cwd));
    return ok({
      sources: discovered.sources.map(({ sessionId, ...source }) => source),
      unavailableNodeIds: discovered.unavailableNodeIds,
    });
  }

  if (method === 'GET' && route[0] === 'conversation-sources' && route.length === 3 && route[2] === 'history') {
    const sourceId = route[1];
    const now = ctx.now();
    let source = await q(ctx.db,
      'SELECT node_id AS nodeId,session_id AS sessionId,source_cwd AS cwd,preview,mtime FROM conversation_source_cache WHERE source_id = ? AND expires_at > ?',
      sourceId, now).first();
    if (!source) {
      const discovered = await discoverConversationSources(ctx, userId);
      if (discovered.denied) return err(403, 'not a member of that team');
      source = discovered.sources.find(item => item.id === sourceId);
    }
    if (!source) {
      if (await q(ctx.db, 'SELECT 1 FROM conversation_claims_v2 WHERE source_id = ?', sourceId).first()) {
        return err(409, 'conversation source has already been activated; refresh the conversation list');
      }
      return err(404, 'conversation source not found or node unavailable');
    }
    const cursorId = String(body?.cursor || '');
    const [claimedBefore, rootRowsBefore, memberBefore, cursor] = await Promise.all([
      q(ctx.db, 'SELECT 1 FROM conversation_claims_v2 WHERE node_id = ? AND session_id = ? AND source_cwd = ?', source.nodeId, source.sessionId, source.cwd).first(),
      authorizedConversationRoots(ctx, userId),
      assertTeamMember(ctx, ctx.teamId),
      cursorId ? q(ctx.db,
        `DELETE FROM conversation_history_cursors_v3 WHERE id = ? AND source_id = ? AND expires_at > ?
         RETURNING before_offset,boundary_hash,file_size,file_mtime`, cursorId, sourceId, now).first() : Promise.resolve(null),
    ]);
    if (claimedBefore) return err(409, 'conversation source has already been activated; refresh the conversation list');
    if (!memberBefore || !rootsByNode(rootRowsBefore).get(source.nodeId)?.has(source.cwd)) {
      return err(403, 'conversation source is no longer available in this scope');
    }
    if (cursorId && !cursor) return err(400, 'history cursor expired or already used; reopen the conversation');
    const before = cursor?.before_offset ?? null;
    const cursorBoundaryHash = cursor?.boundary_hash ?? null;
    const cursorFileSize = cursor?.file_size ?? null;
    const cursorFileMtime = cursor?.file_mtime ?? null;
    const details = body?.details === '1' || body?.details === 1 || body?.details === true;
    const result = await ctx.readProjectSession?.(source.nodeId, source.sessionId, source.cwd, {
      before, boundaryHash: cursorBoundaryHash, fileSize: cursorFileSize,
      fileMtime: cursorFileMtime, turns: cursorId ? 10 : 1, includeTools: !!cursorId || details,
    });
    if (!result) return err(503, 'node unavailable while reading conversation history');
    if (result.stale) return err(409, 'conversation history changed; reopen it to load the latest turn');
    const [claimedAfter, rootRowsAfter, memberAfter] = await Promise.all([
      q(ctx.db, 'SELECT 1 FROM conversation_claims_v2 WHERE node_id = ? AND session_id = ? AND source_cwd = ?', source.nodeId, source.sessionId, source.cwd).first(),
      authorizedConversationRoots(ctx, userId), assertTeamMember(ctx, ctx.teamId),
    ]);
    if (claimedAfter) return err(409, 'conversation source was activated while loading; open the normal conversation');
    const finalRoots = rootsByNode(rootRowsAfter);
    if (!memberAfter || !finalRoots.get(source.nodeId)?.has(source.cwd)) {
      return err(403, 'conversation source is no longer available in this scope');
    }
    let nextCursor = null;
    const canPage = result.hasMore && result.nextBefore != null && result.nextBoundaryHash
      && Number.isFinite(Number(result.fileSize)) && Number.isFinite(Number(result.fileMtime));
    if (canPage) {
      const proposedCursor = ulid();
      const cursor = await q(ctx.db,
        `INSERT INTO conversation_history_cursors_v3 (id,source_id,before_offset,boundary_hash,file_size,file_mtime,expires_at) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(source_id,before_offset) DO UPDATE SET boundary_hash=excluded.boundary_hash,file_size=excluded.file_size,
         file_mtime=excluded.file_mtime,expires_at=excluded.expires_at RETURNING id`,
        proposedCursor, sourceId, result.nextBefore, result.nextBoundaryHash, result.fileSize, result.fileMtime, now + SOURCE_CACHE_TTL_MS).first();
      nextCursor = cursor.id;
    }
    const pageKey = cursorId || 'latest';
    const messages = (result.events || []).map((event, index) => ({
      seq: index + 1, historyKey: `${pageKey}:${index}`, role: event.role, content: event.content, created_at: source.mtime,
    }));
    return ok({ messages, hiddenDetailCount: result.hiddenDetailCount || 0, hasMore: !!nextCursor, nextCursor });
  }

  if (method === 'POST' && route[0] === 'conversation-sources' && route.length === 3 && route[2] === 'activate') {
    const sourceId = route[1];
    const text = String(body?.text || '').trim();
    if (!text) return err(400, 'text required');
    const discovered = await discoverConversationSources(ctx, userId);
    if (discovered.denied) return err(403, 'not a member of that team');
    const source = discovered.sources.find(item => item.id === sourceId);
    if (!source) {
      const claim = await q(ctx.db, 'SELECT node_id,session_id,task_id FROM conversation_claims_v2 WHERE source_id = ?', sourceId).first();
      const existing = claim && await existingTaskInScope(ctx, await getTask(ctx, claim.task_id), userId);
      if (!existing) return err(404, 'conversation source not found or node unavailable');
      await dispatch(ctx, existing.node_id, { t: 'user_message', taskId: existing.id, text });
      await invalidateConversationSource(ctx, claim.node_id, claim.session_id, sourceId, existing.id, existing.owner_user_id);
      return ok({ task: existing, reused: true, messageForwarded: true });
    }
    const postRoots = rootsByNode(await authorizedConversationRoots(ctx, userId));
    if (!(await assertTeamMember(ctx, ctx.teamId)) || !postRoots.get(source.nodeId)?.has(source.cwd)) {
      return err(403, 'conversation source is no longer available in this scope');
    }

    const existingClaim = await q(ctx.db, 'SELECT task_id FROM conversation_claims_v2 WHERE node_id = ? AND session_id = ? AND source_cwd = ?', source.nodeId, source.sessionId, source.cwd).first();
    if (existingClaim) {
      const existing = await existingTaskInScope(ctx, await getTask(ctx, existingClaim.task_id), userId);
      if (!existing) return err(409, 'conversation was already activated in another scope');
      if (existing.status === 'queued') {
        const commandKey = `start:${existing.id}`;
        const payload = { t: 'start_task', task: { id: existing.id, title: existing.title, spec: existing.spec, repoUrl: existing.repo_url, baseBranch: null, permissionMode: existing.permission_mode, sessionId: existing.session_id, sourceCwd: source.cwd } };
        await q(ctx.db, 'INSERT OR IGNORE INTO durable_cmds (command_key,node_id,payload,created_at) VALUES (?,?,?,?)', commandKey, existing.node_id, JSON.stringify(payload), ctx.now()).run();
        ctx.sendToNode(existing.node_id, { ...payload, commandKey });
      }
      await dispatch(ctx, existing.node_id, { t: 'user_message', taskId: existing.id, text });
      await invalidateConversationSource(ctx, source.nodeId, source.sessionId, sourceId, existing.id, existing.owner_user_id);
      return ok({ task: existing, reused: true, messageForwarded: true });
    }

    const taskId = `S${sourceId.slice(0, 25)}`;
    const now = ctx.now();
    const titleLine = (source.preview || text).split('\n')[0].trim();
    const title = titleLine.length > 40 ? titleLine.slice(0, 40) + '…' : (titleLine || '历史对话');
    const commandKey = `start:${taskId}`;
    const payload = { t: 'start_task', task: { id: taskId, title, spec: text, repoUrl: source.cwd, baseBranch: null, permissionMode: 'bypassPermissions', sessionId: source.sessionId, sourceCwd: source.cwd } };
    const statements = [
      q(ctx.db, 'INSERT INTO conversation_claims_v2 (node_id,session_id,source_id,task_id,source_cwd,immutable,claimed_at) VALUES (?,?,?,?,?,1,?)', source.nodeId, source.sessionId, sourceId, taskId, source.cwd, now),
      q(ctx.db, `INSERT INTO tasks (id,title,spec,repo_url,node_id,owner_user_id,team_id,status,permission_mode,session_id,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,'queued','bypassPermissions',?,?,?)`, taskId, title, text, source.cwd, source.nodeId, userId, ctx.teamId || null, source.sessionId, now, now),
      ...(ctx.teamId ? [q(ctx.db, 'INSERT INTO task_teams (task_id,team_id) VALUES (?,?)', taskId, ctx.teamId)] : []),
      q(ctx.db, 'INSERT INTO durable_cmds (command_key,node_id,payload,created_at) VALUES (?,?,?,?)', commandKey, source.nodeId, JSON.stringify(payload), now),
    ];
    try { await ctx.db.batch(statements); }
    catch {
      const winner = await q(ctx.db, 'SELECT task_id FROM conversation_claims_v2 WHERE node_id = ? AND session_id = ? AND source_cwd = ?', source.nodeId, source.sessionId, source.cwd).first();
      const task = winner && await existingTaskInScope(ctx, await getTask(ctx, winner.task_id), userId);
      if (!task) return err(409, 'conversation was already activated in another scope');
      await dispatch(ctx, task.node_id, { t: 'user_message', taskId: task.id, text });
      return ok({ task, reused: true, messageForwarded: true });
    }
    ctx.sendToNode(source.nodeId, { ...payload, commandKey });
    const task = await broadcastTask(ctx, taskId);
    await invalidateConversationSource(ctx, source.nodeId, source.sessionId, sourceId, taskId, userId);
    return ok({ task, reused: false, messageForwarded: true });
  }

  if (method === 'POST' && route[0] === 'tasks' && route.length === 1) {
    const { title, spec, repoUrl, baseBranch, nodeId, permissionMode, modelProfileId, resumeSessionId } = body || {};
    // The first message of a new conversation can carry attachments exactly
    // like any later one (draftpane.jsx's composer is the same composer) —
    // they ride along with spec rather than as a separate follow-up send, so
    // the agent sees text and image in one turn.
    const images = Array.isArray(body?.images) ? body.images : [];
    // spec (the first message) is normally required, but images alone are a
    // complete message too ("what's wrong with this screenshot?"), and
    // resuming an existing external session already has content to pick up
    // from — the task can be created and its history imported immediately,
    // with the CLI left idle until the user actually sends something.
    if (!title || (!spec && !images.length && !resumeSessionId) || !nodeId) return err(400, 'title, nodeId required (spec or images required unless resumeSessionId is set)');
    const imageError = imageBatchError(images);
    if (imageError) return err(400, imageError);
    if (!(await assertTeamMember(ctx, ctx.teamId))) return err(403, 'not a member of that team');
    // The node must be usable from the scope the task is being created in —
    // a node shared with this project for a project task, or a node you
    // personally own for a personal task (yours stays usable from personal
    // scope even once you've also shared it with a project — see the node
    // list route's comment; ownership isn't exclusive the way task sharing
    // is). No more "any teammate's node is fair game because we're both on
    // some team together," though — team scope still requires the explicit
    // node_teams binding.
    const node = ctx.teamId
      ? await q(ctx.db, `SELECT id FROM nodes WHERE id = ? AND id IN (SELECT node_id FROM node_teams WHERE team_id = ?)`, nodeId, ctx.teamId).first()
      : await q(ctx.db, `SELECT id FROM nodes WHERE id = ? AND owner_user_id = ?`, nodeId, userId).first();
    if (!node) return err(400, `unknown node: ${nodeId}`);
    if (resumeSessionId) {
      const occupiedTask = await q(ctx.db, 'SELECT id FROM tasks WHERE node_id = ? AND session_id = ? AND COALESCE(repo_url,\'\') = ? LIMIT 1', nodeId, resumeSessionId, repoUrl || '').first();
      const occupiedClaim = await q(ctx.db, 'SELECT task_id FROM conversation_claims_v2 WHERE node_id = ? AND session_id = ? AND source_cwd = ?', nodeId, resumeSessionId, repoUrl || '').first();
      if (occupiedTask || occupiedClaim) return err(409, 'this Claude session is already connected to an AgentHub conversation');
    }
    let provider;
    let backend = DEFAULT_BACKEND;
    if (modelProfileId) {
      const profile = await q(ctx.db,
        'SELECT base_url, api_key, model FROM model_profiles WHERE id = ? AND owner_user_id = ?', modelProfileId, userId).first();
      if (!profile) return err(404, `unknown model profile: ${modelProfileId}`);
      provider = { baseUrl: profile.base_url, apiKey: profile.api_key, model: profile.model };
      backend = await profileBackend(ctx.db, modelProfileId);
    }
    // Refuse up-front rather than dispatching work the node can't do — the
    // spawn would go wrong in some backend-specific way and the resulting
    // error would say nothing about the actual cause. Only on evidence the
    // node itself supplied (cap.known): a node that has never connected to
    // this cloud version stays dispatchable, and its task simply queues, which
    // is what happened before backends existed.
    const cap = await nodeCapabilities(ctx.db, nodeId);
    if (cap.known && cap.protocolVersion < PROTOCOL_VERSION) {
      return err(409, `节点 ${nodeId} 运行的是旧版 executor(协议 v${cap.protocolVersion},当前 v${PROTOCOL_VERSION}),请先升级该节点再派单`);
    }
    if (cap.known && !cap.backends.includes(backend)) {
      return err(409, `节点 ${nodeId} 上没有安装 ${backend} CLI,无法运行这个模型档案`);
    }
    // A node that predates start_task.images would drop them and answer about
    // a picture it never got — a wrong answer that looks like a working one.
    // Refuse instead; nodes self-update within a couple of minutes, so this
    // only ever shows up in the window right after a cloud deploy.
    if (images.length && !(await nodeSupports(ctx.db, nodeId, FEATURE_TASK_IMAGES))) {
      return err(409, `节点 ${nodeId} 的 executor 还不支持在新对话的第一条消息里带图片,请等它自动升级(约 2-3 分钟)后重试`);
    }
    // Session adoption only discovers claude histories today (see
    // list_project_sessions), so a resumeSessionId is always a claude session
    // id — and a session id belongs to exactly one agent CLI's on-disk store.
    // The frontend filters the choices; reaching here means a stale page or a
    // direct API call.
    if (resumeSessionId && backend !== 'claude') {
      return err(409, `无法用 ${backend} 档案接管一个 claude 会话:会话 ID 不通用`);
    }
    const id = ulid();
    const now = ctx.now();
    // No hardcoded 'main' fallback here — many repos default to 'master' or
    // something else. Leaving base_branch unset when the caller didn't pick
    // one lets the executor detect the clone's actual default branch.
    const createStatements = [q(ctx.db,
      `INSERT INTO tasks (id, title, spec, repo_url, base_branch, node_id, owner_user_id, team_id, status, permission_mode, session_id, model_profile_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
      id, title, spec || '', repoUrl ?? null, baseBranch || null, nodeId, userId, ctx.teamId || null, permissionMode ?? 'bypassPermissions', resumeSessionId || null, modelProfileId || null, now, now,
    )];
    if (resumeSessionId) {
      const sourceId = (await sha256Hex(`${nodeId}\0${resumeSessionId}\0${repoUrl || ''}`)).slice(0, 32);
      createStatements.push(q(ctx.db,
        'INSERT INTO conversation_claims_v2 (node_id,session_id,source_id,task_id,source_cwd,immutable,claimed_at) VALUES (?,?,?,?,?,0,?)',
        nodeId, resumeSessionId, sourceId, id, repoUrl || '', now,
      ));
    }
    if (ctx.teamId) createStatements.push(q(ctx.db, 'INSERT INTO task_teams (task_id, team_id) VALUES (?, ?)', id, ctx.teamId));
    try { await ctx.db.batch(createStatements); }
    catch { return err(409, 'this Claude session was connected concurrently; refresh and open the existing conversation'); }
    // Creating a task while viewing a project starts it shared with that
    // project (same UX as before) — more can be added/removed afterward via
    // POST/DELETE /api/tasks/:id/teams/:teamId. tasks.team_id above is now
    // unused legacy; task_teams is the actual source of truth.
    await dispatch(ctx, nodeId, {
      t: 'start_task',
      task: {
        id, title, spec: spec || '', repoUrl: repoUrl ?? null, baseBranch: baseBranch || null,
        permissionMode: permissionMode ?? 'bypassPermissions', sessionId: resumeSessionId || null,
        // Deliberately not persisted in tasks.spec: that column is the
        // human-readable original ask shown in the 信息 tab, and the images
        // are already durable either on the socket or in pending_cmds (see
        // dispatch), then in messages.content once the node echoes the turn.
        ...(images.length ? { images } : {}),
        ...(provider ? { provider } : {}),
        ...(backend !== DEFAULT_BACKEND ? { backend } : {}),
      },
    });
    if (repoUrl) {
      await q(ctx.db,
        `INSERT INTO recent_repos (owner_user_id, repo_url, last_used_at) VALUES (?, ?, ?)
         ON CONFLICT(owner_user_id, repo_url) DO UPDATE SET last_used_at = excluded.last_used_at`,
        userId, repoUrl, now).run();
    }
    // Whatever model was picked for this task becomes the sticky default for
    // the next new-task draft (draftpane.jsx reads this back via GET
    // /api/model-profiles) — "changed once, defaults to that from now on."
    await q(ctx.db, 'UPDATE users SET last_model_profile_id = ? WHERE id = ?', modelProfileId || null, userId).run();
    const task = await broadcastTask(ctx, id);
    return ok({ task });
  }

  // Deep-link support: a task URL (#/task/<id>) can reference a task that
  // isn't part of whichever scope (personal/project) happens to be active
  // in the sidebar right now — most commonly a project task opened from a
  // notification or shared link while still viewing "个人". The scoped list
  // endpoint above deliberately excludes it (that's correct for the list),
  // but the creator or any member of one of its projects should still be
  // able to open it directly — this is the one route that resolves a task
  // by id independent of ctx.teamId, so the frontend can fetch-and-render
  // it even when it's outside the currently active scope.
  if (method === 'GET' && route[0] === 'tasks' && route.length === 2) {
    const taskId = route[1];
    const task = await q(ctx.db,
      `SELECT tasks.*, users.username AS owner_username FROM tasks
       LEFT JOIN users ON users.id = tasks.owner_user_id WHERE tasks.id = ?`, taskId).first();
    if (!task) return err(404, 'task not found');
    const teamIds = await taskTeamIds(ctx, taskId);
    if (task.owner_user_id !== userId) {
      const rows = await q(ctx.db, 'SELECT team_id FROM team_members WHERE user_id = ?', userId).all();
      const myTeamIds = new Set((rows.results ?? rows).map(r => r.team_id));
      if (!teamIds.some(t => myTeamIds.has(t))) return err(404, 'task not found');
    }
    task.teamIds = teamIds;
    task.backend = await taskBackend(ctx.db, task);
    return ok({ task });
  }

  if (route[0] === 'tasks' && route.length >= 3) {
    const taskId = route[1];
    const task = await getTask(ctx, taskId);
    if (!task) return err(404, 'task not found');
    const action = route[2];
    const isCreator = task.owner_user_id === userId;
    if (!isCreator) {
      // Any other team route (GET messages, below) only needs *visibility* —
      // team sharing widens who can see a task, but almost every mutating
      // action stays creator-only regardless of team, on purpose (see the
      // team-sharing plan's "design decisions" note). Visible to a non-creator
      // only when they're currently viewing one of the (possibly several)
      // projects this task is actually shared with.
      const shared = ctx.teamId && await q(ctx.db, 'SELECT 1 FROM task_teams WHERE task_id = ? AND team_id = ?', taskId, ctx.teamId).first();
      if (!shared || !(await assertTeamMember(ctx, ctx.teamId))) return err(404, 'task not found');
      // Sending a message is the one exception, opened up to every member of
      // a shared project — a shared conversation is pointless if only
      // whoever happened to create it can actually talk to it. Everything
      // else that touches the task's lifecycle (deciding a permission
      // request, cancel/retry/rename/archive, switching lease) stays
      // creator-only — those can redirect or disrupt a conversation the
      // creator is actively driving in ways a plain message can't.
      // Retrying an undelivered send of your own is part of sending, not a
      // separate power: refusing it would strand a member's message with no
      // way to get it through.
      const messageAllowed = method === 'POST' && ['message', 'retry-message'].includes(action);
      if (method !== 'GET' && !messageAllowed) return err(403, 'only the task creator can do this');
    }

    if (method === 'GET' && action === 'messages') {
      const after = Number(body?.after_seq ?? 0);
      const limit = Math.min(Number(body?.limit ?? 300), 1000);
      const rows = await q(ctx.db,
        'SELECT seq, role, content, created_at FROM messages WHERE task_id = ? AND seq > ? ORDER BY seq LIMIT ?',
        taskId, after, limit).all();
      // Pending sends ride along on every page so a reload/second device
      // shows in-flight text too — the whole point of persisting them. They
      // are not messages yet (no seq), so they're a separate field the client
      // renders after the real log rather than something that could collide
      // with a real seq.
      return ok({
        messages: (rows.results ?? rows).map(r => ({ ...r, content: JSON.parse(r.content) })),
        pending: await pendingMessagesFor(ctx, taskId),
      });
    }
    if (method === 'POST' && action === 'message') {
      const images = Array.isArray(body?.images) ? body.images : [];
      if (!body?.text && !images.length) return err(400, 'text or images required');
      const imageError = imageBatchError(images);
      if (imageError) return err(400, imageError);
      // No status gate here on purpose: the executor's userMessage() already
      // (re)spawns a session on demand regardless of prior status (failed,
      // done, cancelled, unknown, ...) — every conversation should stay
      // immediately continuable without an extra manual "retry" step first.
      // The only real block is an active IDE takeover, which owns the CLI's
      // stdin directly.
      if (task.lease === 'human') return err(409, 'task is leased to IDE');
      // clientMessageId is what makes a send durable and idempotent (see
      // acceptUserMessage). It's optional only so an older cached frontend
      // keeps working — such a client falls back to the original
      // fire-and-forget dispatch, which is exactly the path that could lose a
      // message, so the browser always sends one.
      const clientMessageId = body?.clientMessageId;
      if (clientMessageId !== undefined && !isValidClientMessageId(clientMessageId)) {
        return err(400, 'invalid clientMessageId');
      }
      if (!clientMessageId) {
        await dispatch(ctx, task.node_id, { t: 'user_message', taskId, text: body.text || '', images });
        return ok({ delivery: 'dispatched' });
      }
      // queue=true asks for the message to be held if a turn is already in
      // flight (the default the composer sends). An explicit false is "send it
      // into the running turn anyway", which is the old behaviour and what
      // 关闭排队 falls back to.
      const { queued, held } = await acceptUserMessage(
        ctx, task, clientMessageId, body.text || '', images, userId,
        { queue: body?.queue !== false },
      );
      // 'queued' is an honest answer, not a failure: the message is durable
      // and will be delivered when the node comes back. The frontend shows it
      // as a still-in-flight bubble rather than pretending it's been answered.
      // 'held' distinguishes "waiting for this turn to finish" from "waiting
      // for the node to come back" — same row, very different explanation.
      return ok({ delivery: held ? 'held' : queued ? 'queued' : 'sent', clientMessageId });
    }
    if (method === 'POST' && action === 'retry-message') {
      // Same creator/member gate as sending (see messageAllowed above) — a
      // retry is just the same send again.
      if (task.lease === 'human') return err(409, 'task is leased to IDE');
      const clientMessageId = body?.clientMessageId;
      if (!isValidClientMessageId(clientMessageId)) return err(400, 'invalid clientMessageId');
      const retried = await retryOutboundMessage(ctx, task, clientMessageId);
      if (!retried) return err(404, 'no pending message with that id');
      return ok({});
    }
    // Editing and cancelling only ever apply to a message still held for the
    // current turn. The state check is the whole guarantee: once a row has
    // been released it is on its way to the node (or already answered), and
    // rewriting it then would change a message the agent has arguably already
    // read. Racing the release simply loses — the row is no longer 'queued',
    // so both routes 404 rather than silently doing nothing.
    if ((method === 'POST' || method === 'DELETE') && action === 'queued-message') {
      if (!isCreator) return err(403, 'only the creator can change queued messages');
      const clientMessageId = body?.clientMessageId ?? route[3];
      if (!isValidClientMessageId(clientMessageId)) return err(400, 'invalid clientMessageId');
      const row = await q(ctx.db,
        "SELECT * FROM outbound_messages WHERE task_id = ? AND client_message_id = ? AND state = 'queued'",
        taskId, clientMessageId).first();
      if (!row) return err(404, 'no queued message with that id');
      const teamIds = await taskTeamIds(ctx, taskId);
      if (method === 'DELETE') {
        await q(ctx.db, 'DELETE FROM outbound_messages WHERE task_id = ? AND client_message_id = ?',
          taskId, clientMessageId).run();
        // Same removal channel the delivery path uses, so every viewer drops
        // the bubble the same way; 'cancelled' only distinguishes why.
        fanOutToTeamsOrOwner(ctx, { t: 'pending_settled', taskId, clientMessageId, state: 'cancelled' },
          task.owner_user_id, teamIds);
        return ok({});
      }
      const text = typeof body?.text === 'string' ? body.text : null;
      if (text === null || !text.trim()) return err(400, 'text required');
      const payload = { ...JSON.parse(row.payload), text };
      await q(ctx.db, 'UPDATE outbound_messages SET payload = ?, updated_at = ? WHERE task_id = ? AND client_message_id = ?',
        JSON.stringify(payload), ctx.now(), taskId, clientMessageId).run();
      fanOutToTeamsOrOwner(ctx,
        { t: 'pending_msg', taskId, pending: pendingRowToWire({ ...row, payload: JSON.stringify(payload) }) },
        task.owner_user_id, teamIds);
      return ok({});
    }
    if (method === 'POST' && action === 'decision') {
      // updatedInput lets an 'allow' carry a modified version of the tool's
      // input back to the CLI (e.g. AskUserQuestion needs the user's actual
      // picks, not just a bare approval — see session.mjs's `updatedInput:
      // decision.updatedInput ?? req.input`, already wired to accept this).
      const { requestId, behavior, message, updatedInput, autoApprove, forceAll } = body || {};
      if (!requestId || !['allow', 'deny'].includes(behavior)) return err(400, 'requestId + behavior required');
      await dispatch(ctx, task.node_id, { t: 'decision', taskId, requestId, behavior, message, updatedInput });
      // "Auto-approve from here on" — switches permission_mode to
      // bypassPermissions so future requests on this task (or, for
      // 'account', every task this user owns — including ones already
      // running right now) never reach this prompt again. Only takes effect
      // from the *next* spawn onward (permission mode is a CLI startup
      // flag, not something a live process can be told to change
      // mid-session) — same one-way switch as the existing retry-recovery
      // "downgrade" option, just triggered from the decision itself instead
      // of a failed-task banner. Deliberately only on 'allow': auto-approving
      // future requests makes no sense as a side effect of denying this one.
      if (behavior === 'allow' && (autoApprove === 'this' || autoApprove === 'account')) {
        if (task.permission_mode !== 'bypassPermissions') {
          await q(ctx.db, 'UPDATE tasks SET permission_mode = ? WHERE id = ?', 'bypassPermissions', taskId).run();
          await dispatch(ctx, task.node_id, { t: 'set_permission_mode', taskId, permissionMode: 'bypassPermissions' });
          await broadcastTask(ctx, taskId);
        }
        if (autoApprove === 'account') {
          const rows = await q(ctx.db,
            `SELECT id, node_id FROM tasks WHERE owner_user_id = ? AND id != ? AND permission_mode != 'bypassPermissions'`,
            userId, taskId).all();
          const others = rows.results ?? rows;
          if (others.length) {
            await q(ctx.db, `UPDATE tasks SET permission_mode = 'bypassPermissions' WHERE owner_user_id = ? AND id != ?`, userId, taskId).run();
            for (const t of others) {
              await dispatch(ctx, t.node_id, { t: 'set_permission_mode', taskId: t.id, permissionMode: 'bypassPermissions' });
              await broadcastTask(ctx, t.id);
            }
          }
        }
      }
      // "Auto-approve even claude's own hard-coded confirmations" (e.g. the
      // rm-pattern circuit breaker) — qualitatively different from the
      // bypassPermissions switch above: that one only reaches parity with
      // Anthropic's own most-permissive mode, this one goes further and
      // turns off the one guardrail that mode deliberately can't skip. The
      // executor auto-decides 'allow' for every future request on the task
      // the moment it arrives, never surfacing it as a card at all —
      // explicit, separately-confirmed opt-in (see task.jsx's confirm()
      // dialog), not a side effect of the bypassPermissions switch.
      if (behavior === 'allow' && (forceAll === 'this' || forceAll === 'account')) {
        if (!task.auto_decide_all) {
          await q(ctx.db, 'UPDATE tasks SET auto_decide_all = 1 WHERE id = ?', taskId).run();
          await dispatch(ctx, task.node_id, { t: 'set_auto_decide_all', taskId, autoDecideAll: true });
          await broadcastTask(ctx, taskId);
        }
        if (forceAll === 'account') {
          const rows = await q(ctx.db,
            `SELECT id, node_id FROM tasks WHERE owner_user_id = ? AND id != ? AND (auto_decide_all IS NULL OR auto_decide_all = 0)`,
            userId, taskId).all();
          const others = rows.results ?? rows;
          if (others.length) {
            await q(ctx.db, `UPDATE tasks SET auto_decide_all = 1 WHERE owner_user_id = ? AND id != ?`, userId, taskId).run();
            for (const t of others) {
              await dispatch(ctx, t.node_id, { t: 'set_auto_decide_all', taskId: t.id, autoDecideAll: true });
              await broadcastTask(ctx, t.id);
            }
          }
        }
      }
      return ok({});
    }
    if (method === 'POST' && action === 'cancel') {
      if (!userCanTransition(task.status, 'cancelled')) return err(409, `cannot cancel from ${task.status}`);
      await dispatch(ctx, task.node_id, { t: 'cancel', taskId });
      return ok({});
    }
    // Sending a message already respawns a failed task's session on its own
    // (see the 'message' route above) — this manual retry is for when there's
    // nothing new to say yet, just a stuck session to clear (e.g. a task that
    // failed under an old bug can recover once the fix lands, without losing
    // the pane/its prior messages, before the user has anything to type).
    if (method === 'POST' && action === 'retry') {
      if (task.status !== 'failed') return err(409, `cannot retry from ${task.status}`);
      // Two optional, explicit recovery choices surfaced by the UI when a
      // task fails specifically because claude CLI refuses bypassPermissions
      // as root — see task.jsx's review-bar. permissionMode downgrades the
      // task off bypassPermissions (so the CLI no longer needs the refused
      // flag at all); allowRootBypass instead sets IS_SANDBOX for this
      // node's future spawns of this task, an undocumented but
      // Anthropic-tooling-sanctioned escape hatch that skips the root check
      // — only ever applied when the user has explicitly opted in here,
      // never silently.
      const opts = {};
      if (['default', 'acceptEdits', 'bypassPermissions'].includes(body?.permissionMode)) {
        opts.permissionMode = body.permissionMode;
        await q(ctx.db, 'UPDATE tasks SET permission_mode = ? WHERE id = ?', body.permissionMode, taskId).run();
      }
      if (body?.allowRootBypass === true) opts.allowRootBypass = true;
      await dispatch(ctx, task.node_id, { t: 'retry_task', taskId, opts });
      if (opts.permissionMode) await broadcastTask(ctx, taskId);
      return ok({});
    }
    // Manual "pull in anything that happened outside AgentHub" for an idle
    // resumed session (e.g. the user kept talking to the same claude --resume
    // session directly in a terminal). Distinct from the IDE-takeover auto
    // resync — this reads the ORIGINAL external transcript file, not the
    // isolated claude-config copy, since there was never a lease to return from.
    if (method === 'POST' && action === 'resync') {
      if (task.status !== 'idle') return err(409, `cannot resync from ${task.status}`);
      await dispatch(ctx, task.node_id, { t: 'resync_session', taskId });
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
    if (method === 'POST' && action === 'switch-session') {
      if ((await taskBackend(ctx.db, task)) !== 'claude') {
        return err(409, 'Codex 对话暂不支持从 Claude Code 历史中切换会话');
      }
      const sessionId = body?.sessionId;
      if (!sessionId) return err(400, 'sessionId required');
      const currentClaim = await q(ctx.db, 'SELECT immutable FROM conversation_claims_v2 WHERE task_id = ?', taskId).first();
      if (currentClaim?.immutable) return err(409, 'discovered-history conversations cannot switch their underlying Claude session');
      const occupied = await q(ctx.db, 'SELECT id FROM tasks WHERE node_id = ? AND session_id = ? AND id <> ? LIMIT 1', task.node_id, sessionId, taskId).first();
      const claimed = await q(ctx.db, 'SELECT task_id FROM conversation_claims_v2 WHERE node_id = ? AND session_id = ? AND source_cwd = ? AND task_id <> ?', task.node_id, sessionId, task.repo_url || '', taskId).first();
      if (occupied || claimed) return err(409, 'this Claude session is already connected to another AgentHub conversation');
      const now = ctx.now();
      const sourceId = (await sha256Hex(`${task.node_id}\0${sessionId}\0${task.repo_url || ''}`)).slice(0, 32);
      const statements = [
        ...(currentClaim ? [q(ctx.db, 'DELETE FROM conversation_claims_v2 WHERE task_id = ?', taskId)] : []),
        q(ctx.db, 'INSERT INTO conversation_claims_v2 (node_id,session_id,source_id,task_id,source_cwd,immutable,claimed_at) VALUES (?,?,?,?,?,0,?)', task.node_id, sessionId, sourceId, taskId, task.repo_url || '', now),
        q(ctx.db, 'UPDATE tasks SET session_id = ?, updated_at = ? WHERE id = ?', sessionId, now, taskId),
      ];
      try { await ctx.db.batch(statements); }
      catch { return err(409, 'this Claude session was connected concurrently'); }
      await dispatch(ctx, task.node_id, { t: 'switch_session', taskId, sessionId });
      await broadcastTask(ctx, taskId);
      return ok({});
    }
    if (method === 'POST' && action === 'rename') {
      const title = String(body?.title || '').trim();
      if (!title) return err(400, 'title required');
      await q(ctx.db, 'UPDATE tasks SET title = ? WHERE id = ?', title, taskId).run();
      await broadcastTask(ctx, taskId);
      return ok({});
    }
    // Switch which model profile an ongoing conversation uses. Like
    // permission_mode, the model is a spawn-time env var on the CLI child —
    // the switch takes effect from the next turn's (re)spawn, never
    // mid-generation. modelProfileId null/'' = revert to the node-shared
    // default config from the owner's Settings.
    if (method === 'POST' && action === 'switch-model') {
      const profileId = body?.modelProfileId || null;
      let provider = null;
      let backend = DEFAULT_BACKEND;
      if (profileId) {
        const profile = await q(ctx.db,
          'SELECT base_url, api_key, model FROM model_profiles WHERE id = ? AND owner_user_id = ?', profileId, userId).first();
        if (!profile) return err(404, `unknown model profile: ${profileId}`);
        provider = { baseUrl: profile.base_url, apiKey: profile.api_key, model: profile.model };
        backend = await profileBackend(ctx.db, profileId);
      }
      // Switching model profile now also switches agent CLI, and a session id
      // is not portable between them — `codex resume <claude-uuid>` can only
      // fail, and the task would be left pointing at a session its new backend
      // has never heard of. Refuse instead: this is a new conversation, not a
      // model change. (A task with no session yet hasn't spawned anything, so
      // it can still move freely.)
      const currentBackend = await taskBackend(ctx.db, task);
      if (task.session_id && backend !== currentBackend) {
        return err(409, `这个对话已经在 ${currentBackend} 上有会话记录,不能改用 ${backend} 档案(会话 ID 不通用)。请新建一张卡。`);
      }
      if (backend !== currentBackend) {
        const cap = await nodeCapabilities(ctx.db, task.node_id);
        if (cap.known && !cap.backends.includes(backend)) return err(409, `节点 ${task.node_id} 上没有安装 ${backend} CLI`);
      }
      // '' (not NULL) for an explicit revert-to-default — NULL is reserved
      // for legacy/never-switched tasks, which hello_ok's re-assertion must
      // leave alone (see handleHello's comment).
      await q(ctx.db, 'UPDATE tasks SET model_profile_id = ?, updated_at = ? WHERE id = ?', profileId ?? '', ctx.now(), taskId).run();
      await dispatch(ctx, task.node_id, { t: 'set_provider_override', taskId, provider, backend });
      await broadcastTask(ctx, taskId);
      return ok({});
    }
    // Archiving is pure cloud-side bookkeeping (hide from the sidebar) —
    // orthogonal to status, never touches the executor/running session.
    if (method === 'POST' && action === 'archive') {
      await q(ctx.db, 'UPDATE tasks SET archived_at = ? WHERE id = ?', ctx.now(), taskId).run();
      await broadcastTask(ctx, taskId);
      return ok({});
    }
    if (method === 'POST' && action === 'unarchive') {
      await q(ctx.db, 'UPDATE tasks SET archived_at = NULL WHERE id = ?', taskId).run();
      await broadcastTask(ctx, taskId);
      return ok({});
    }
    // Add/remove this conversation to/from a project — reaches here only if
    // isCreator (the guard above 403s any non-GET action for anyone else).
    // A task can be shared with several projects at once, so this is
    // additive/subtractive rather than a single-slot "move." Never touches
    // task.node_id — the node keeps executing it regardless of which
    // project(s) the conversation is visible under.
    if (action === 'teams' && route.length === 4) {
      const targetTeamId = route[3];
      if (!(await assertTeamMember(ctx, targetTeamId))) return err(403, 'not a member of that team');
      if (method === 'POST') {
        await q(ctx.db, 'INSERT OR IGNORE INTO task_teams (task_id, team_id) VALUES (?, ?)', taskId, targetTeamId).run();
        await broadcastTask(ctx, taskId);
        return ok({});
      }
      if (method === 'DELETE') {
        await q(ctx.db, 'DELETE FROM task_teams WHERE task_id = ? AND team_id = ?', taskId, targetTeamId).run();
        await broadcastTask(ctx, taskId);
        return ok({});
      }
    }
  }

  if (method === 'GET' && route[0] === 'nodes' && route.length === 1) {
    // Same reasoning as GET /api/tasks above: assertTeamMember doesn't
    // depend on the list query's result, so run them concurrently instead
    // of paying two sequential D1 round trips on every scope switch.
    // owner_username lets the frontend show whose node it's looking at in
    // team view, and gate the "manage projects" control to nodes you own.
    const [isMember, rows] = await Promise.all([
      assertTeamMember(ctx, ctx.teamId),
      ctx.teamId
        ? q(ctx.db,
            `SELECT nodes.id, nodes.name, nodes.owner_user_id, users.username AS owner_username, nodes.labels, nodes.status, nodes.last_heartbeat_at, nodes.created_at
             FROM nodes LEFT JOIN users ON users.id = nodes.owner_user_id
             WHERE nodes.id IN (SELECT node_id FROM node_teams WHERE team_id = ?)`, ctx.teamId).all()
        // Unlike tasks (a conversation is exclusively personal or shared —
        // moving it to a project removes it from personal view on purpose,
        // see the team-sharing plan), a node is a machine you personally
        // administer — assigning it to a project doesn't stop being true
        // just because other people can now also run tasks on it. Personal
        // view is every node you own, full stop; project bindings are
        // additive labels on top, not an exclusive move. Found live:
        // reported as "我归属节点到别的项目，个人视角就看不见了" — an owner
        // losing sight of their own machine after sharing it was surprising,
        // not desired.
        : q(ctx.db,
            `SELECT nodes.id, nodes.name, nodes.owner_user_id, users.username AS owner_username, nodes.labels, nodes.status, nodes.last_heartbeat_at, nodes.created_at
             FROM nodes LEFT JOIN users ON users.id = nodes.owner_user_id
             WHERE nodes.owner_user_id = ?`, userId).all(),
    ]);
    if (!isMember) return err(403, 'not a member of that team');
    const nodes = rows.results ?? rows;
    await attachNodeTeamIds(ctx, nodes);
    return ok({ nodes });
  }
  if (method === 'POST' && route[0] === 'nodes' && route.length === 1) {
    const { id, tokenHash, labels, autoName } = body || {};
    if (!id || !tokenHash) return err(400, 'id + tokenHash required');
    if (!(await assertTeamMember(ctx, ctx.teamId))) return err(403, 'not a member of that team');

    // Two enrollment intents share this route, and they want opposite things
    // when the id is already in use:
    //
    //   autoName=true  — "add a machine". The installer derived the id from
    //     hostname+username without anyone choosing it, so a collision is an
    //     accident, and the ON CONFLICT below would silently rotate the token
    //     of whatever machine already holds that id, knocking it offline for
    //     good (it can't re-auth, and nothing tells its owner why). Step to
    //     the next free suffix instead and hand the real id back so the
    //     installer writes *that* into its config.
    //   autoName=false — "repair / re-enroll this exact node" (the offline
    //     repair one-liner, which passes the existing id deliberately).
    //     Rotating the token is the entire point there, so it is left alone.
    let assignedId = id;
    if (autoName) {
      for (let suffix = 2; await q(ctx.db, 'SELECT 1 FROM nodes WHERE id = ?', assignedId).first(); suffix++) {
        assignedId = `${id}-${suffix}`;
      }
    } else {
      const existing = await q(ctx.db, 'SELECT owner_user_id FROM nodes WHERE id = ?', id).first();
      if (existing && existing.owner_user_id !== userId) return err(409, 'node id already taken');
    }
    const registeredId = assignedId;
    await q(ctx.db,
      `INSERT INTO nodes (id, token_hash, owner_user_id, labels, status, created_at) VALUES (?, ?, ?, ?, 'offline', ?)
       ON CONFLICT(id) DO UPDATE SET token_hash = excluded.token_hash, labels = excluded.labels`,
      registeredId, tokenHash, userId, JSON.stringify(labels ?? []), ctx.now()).run();
    // The team active in the browser when "添加节点" generated this install
    // command (see board.jsx) becomes this node's initial project — same
    // starting-point UX as before, but now additive rather than exclusive:
    // re-running install against an existing node id doesn't remove any
    // project associations it already picked up since then.
    if (ctx.teamId) {
      await q(ctx.db, 'INSERT OR IGNORE INTO node_teams (node_id, team_id) VALUES (?, ?)', registeredId, ctx.teamId).run();
    }
    // Tell any open browser about it right away. Enrollment used to be silent,
    // so a freshly installed machine only showed up once its daemon connected
    // and markNodeOnline() broadcast — leaving the first-run wizard, which
    // promises the machine "will appear here automatically", staring at an
    // empty list for however long the daemon took to start.
    await broadcastNode(ctx, registeredId, userId);
    // The installer must use the id we actually registered, not the one it
    // asked for — under autoName they differ whenever there was a collision.
    return ok({ id: registeredId });
  }
  // Add/remove an EXISTING node to/from a project after the fact — a node
  // can be shared with several projects at once, same as tasks. Owner-only;
  // teamId in the route is explicit, independent of ctx.teamId/X-Team-Id, so
  // this doesn't require first switching your own view to match.
  if (route[0] === 'nodes' && route.length === 4 && route[2] === 'teams') {
    const nodeId = route[1];
    const targetTeamId = route[3];
    const node = await q(ctx.db, 'SELECT owner_user_id FROM nodes WHERE id = ?', nodeId).first();
    if (!node || node.owner_user_id !== userId) return err(404, 'node not found');
    if (!(await assertTeamMember(ctx, targetTeamId))) return err(403, 'not a member of that team');
    if (method === 'POST') {
      await q(ctx.db, 'INSERT OR IGNORE INTO node_teams (node_id, team_id) VALUES (?, ?)', nodeId, targetTeamId).run();
      await broadcastNode(ctx, nodeId, userId);
      return ok({});
    }
    if (method === 'DELETE') {
      await q(ctx.db, 'DELETE FROM node_teams WHERE node_id = ? AND team_id = ?', nodeId, targetTeamId).run();
      await broadcastNode(ctx, nodeId, userId);
      return ok({});
    }
  }
  // A node's id defaults to its hostname slug at enrollment (see
  // setup-node.sh), which is often ugly or ambiguous (several VMs named
  // "vm-xxxx") — name is a purely cosmetic owner-only override, id itself
  // never changes (it's the WS/token identity).
  if (method === 'POST' && route[0] === 'nodes' && route.length === 3 && route[2] === 'rename') {
    const nodeId = route[1];
    const name = (body?.name || '').trim().slice(0, 200);
    if (!name) return err(400, 'name required');
    const node = await q(ctx.db, 'SELECT owner_user_id FROM nodes WHERE id = ?', nodeId).first();
    if (!node || node.owner_user_id !== userId) return err(404, 'node not found');
    await q(ctx.db, 'UPDATE nodes SET name = ? WHERE id = ?', name, nodeId).run();
    await broadcastNode(ctx, nodeId, userId);
    return ok({});
  }

  if (method === 'GET' && route[0] === 'me' && route.length === 1) {
    const user = await accounts.getUser(ctx.db, userId);
    if (!user) return err(404, 'user not found');
    return ok({ user });
  }

  if (route[0] === 'settings' && route.length === 1) {
    if (method === 'GET') {
      const u = await q(ctx.db, 'SELECT api_base_url, api_key, api_model, default_repo_url FROM users WHERE id = ?', userId).first();
      return ok({
        baseUrl: u?.api_base_url || '', apiKey: u?.api_key || '', model: u?.api_model || 'gpt-5.6',
        defaultRepoUrl: u?.default_repo_url || '',
      });
    }
    if (method === 'POST') {
      // Relay credentials (api_base_url/api_key/api_model) are exclusively
      // managed through model-profiles' set-default route now — this route
      // only ever touches default_repo_url, so saving it never clobbers
      // whichever profile is currently mirrored into those columns.
      const { defaultRepoUrl } = body || {};
      await q(ctx.db, 'UPDATE users SET default_repo_url = ? WHERE id = ?', defaultRepoUrl || null, userId).run();
      return ok({});
    }
  }

  if (method === 'GET' && route[0] === 'recent-repos' && route.length === 1) {
    const rows = await q(ctx.db,
      'SELECT repo_url FROM recent_repos WHERE owner_user_id = ? ORDER BY last_used_at DESC LIMIT 8', userId).all();
    return ok({ repos: (rows.results ?? rows).map(r => r.repo_url) });
  }

  // Which conversation panes are open, synced across devices — stored per
  // scope (personal vs. each project) so switching scope on one device, or
  // opening this account on a second device, restores exactly what was left
  // open in whichever scope is active rather than one flat list shared
  // (and clobbered) across all of them. GET always returns every scope this
  // account has ever saved a layout for; POST writes only the scope the
  // caller is currently viewing (ctx.teamId), read-modify-write so it never
  // touches sibling scopes' saved lists.
  if (route[0] === 'layout' && route.length === 1) {
    const scopeKey = ctx.teamId || 'personal';
    if (method === 'GET') {
      const u = await q(ctx.db, 'SELECT open_panes FROM users WHERE id = ?', userId).first();
      let layout = {};
      try { layout = JSON.parse(u?.open_panes || '{}'); } catch { layout = {}; }
      // Legacy shape (a flat array, from before per-scope layouts existed).
      if (Array.isArray(layout)) layout = { personal: layout };
      return ok({ layout });
    }
    if (method === 'POST') {
      const panes = Array.isArray(body?.panes) ? body.panes.filter(x => typeof x === 'string').slice(0, 20) : [];
      // One atomic statement, rather than SELECT + mutate + UPDATE of the
      // entire JSON object. The read-modify-write version lost sibling scope
      // updates when two devices/projects saved concurrently: both read the
      // same snapshot and whichever full-object UPDATE landed last erased the
      // other scope. Preserve the legacy flat-array shape as `personal` while
      // atomically changing only this scope's JSON path.
      const path = `$.${JSON.stringify(scopeKey)}`;
      await q(ctx.db, `UPDATE users SET open_panes = json_set(
        CASE
          WHEN json_valid(open_panes) AND json_type(open_panes) = 'object' THEN open_panes
          WHEN json_valid(open_panes) AND json_type(open_panes) = 'array' THEN json_object('personal', json(open_panes))
          ELSE '{}'
        END,
        ?, json(?)
      ) WHERE id = ?`, path, JSON.stringify(panes), userId).run();
      return ok({});
    }
  }

  if (route[0] === 'model-profiles' && route.length === 1) {
    if (method === 'GET') {
      // Lazy migration: an account that configured relay credentials before
      // profiles existed (the old single "account default" fields) has zero
      // profile rows — synthesize one from those fields so it shows up here
      // instead of silently vanishing from the new unified UI.
      const existingCount = await q(ctx.db, 'SELECT COUNT(*) AS n FROM model_profiles WHERE owner_user_id = ?', userId).first();
      if ((existingCount?.n ?? 0) === 0) {
        const u = await q(ctx.db, 'SELECT api_base_url, api_key, api_model FROM users WHERE id = ?', userId).first();
        if (u?.api_base_url && u?.api_key) {
          await q(ctx.db,
            'INSERT INTO model_profiles (id, owner_user_id, name, base_url, api_key, model, is_default, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
            ulid(), userId, '默认配置', u.api_base_url, u.api_key, u.api_model || null, ctx.now()).run();
        }
      }
      const rows = await q(ctx.db,
        'SELECT id, name, base_url, api_key, model, is_default FROM model_profiles WHERE owner_user_id = ? ORDER BY created_at', userId).all();
      const u = await q(ctx.db, 'SELECT last_model_profile_id FROM users WHERE id = ?', userId).first();
      const backends = await profileBackends(ctx.db, userId);
      return ok({
        profiles: (rows.results ?? rows).map(r => ({
          id: r.id, name: r.name, baseUrl: r.base_url, apiKey: r.api_key, model: r.model,
          isDefault: !!r.is_default, backend: backends.get(r.id) || DEFAULT_BACKEND,
        })),
        lastModelProfileId: u?.last_model_profile_id || null,
      });
    }
    if (method === 'POST') {
      const { name, baseUrl, apiKey, model, backend } = body || {};
      if (!name || !baseUrl || !apiKey) return err(400, 'name, baseUrl, apiKey required');
      if (backend && !BACKENDS.includes(backend)) return err(400, `unknown backend: ${backend}`);
      const id = ulid();
      // A fresh account's very first profile becomes the default automatically
      // — otherwise every new user would sit in a "nothing pushed to nodes
      // yet" state until they remember to come back and flip a switch. Not for
      // a Codex profile though: the default is what unpinned (claude) tasks
      // run against, so a Codex relay there breaks them all — see set-default.
      // Which is why "first" counts claude profiles only: a user who starts
      // with Codex would otherwise never get a default at all, since their
      // later claude profile is no longer the account's first.
      const isFirst = (backend || DEFAULT_BACKEND) === DEFAULT_BACKEND
        && (await q(ctx.db,
          `SELECT COUNT(*) AS n FROM model_profiles p
           LEFT JOIN model_profile_backends b ON b.profile_id = p.id
           WHERE p.owner_user_id = ? AND COALESCE(b.backend, ?) = ?`, userId, DEFAULT_BACKEND, DEFAULT_BACKEND).first())?.n === 0;
      await q(ctx.db,
        'INSERT INTO model_profiles (id, owner_user_id, name, base_url, api_key, model, is_default, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        id, userId, name, baseUrl, apiKey, model || null, isFirst ? 1 : 0, ctx.now()).run();
      if (backend && backend !== DEFAULT_BACKEND) await setProfileBackend(ctx.db, id, backend);
      if (isFirst) {
        await q(ctx.db, 'UPDATE users SET api_base_url = ?, api_key = ?, api_model = ? WHERE id = ?', baseUrl, apiKey, model || 'gpt-5.6', userId).run();
        await pushConfigToUser(ctx, userId);
      }
      return ok({ profile: { id, name, baseUrl, apiKey, model: model || null, isDefault: isFirst, backend: backend || DEFAULT_BACKEND } });
    }
  }
  if (method === 'PUT' && route[0] === 'model-profiles' && route.length === 2) {
    const { name, baseUrl, apiKey, model, backend } = body || {};
    if (!name || !baseUrl || !apiKey) return err(400, 'name, baseUrl, apiKey required');
    if (backend && !BACKENDS.includes(backend)) return err(400, `unknown backend: ${backend}`);
    const profile = await q(ctx.db, 'SELECT id, is_default FROM model_profiles WHERE id = ? AND owner_user_id = ?', route[1], userId).first();
    if (!profile) return err(404, 'profile not found');
    // Editing a profile that live tasks are pinned to would silently change
    // which agent CLI they resume under, and their session ids don't survive
    // that. Refuse; the user can make a second profile instead.
    if (backend) {
      const current = await profileBackend(ctx.db, route[1]);
      if (backend !== current) {
        const inUse = await q(ctx.db,
          'SELECT id FROM tasks WHERE model_profile_id = ? AND session_id IS NOT NULL LIMIT 1', route[1]).first();
        if (inUse) return err(409, '这个档案已经有对话在用了,不能改它的 agent 类型(会话 ID 不通用)。请新建一个档案。');
        // Same reason set-default refuses a Codex profile: the default is the
        // relay every unpinned (therefore claude) task uses.
        if (profile.is_default && backend !== DEFAULT_BACKEND) {
          return err(409, '这是账户默认档案,不能改成 Codex:默认配置是给「没有选档案」的对话用的,而那些对话跑的是 Claude Code。请先把默认换成别的档案。');
        }
      }
      await setProfileBackend(ctx.db, route[1], backend);
    }
    await q(ctx.db, 'UPDATE model_profiles SET name = ?, base_url = ?, api_key = ?, model = ? WHERE id = ?',
      name, baseUrl, apiKey, model || null, route[1]).run();
    if (profile.is_default) {
      // Same mirror + live push as set-default: the default profile's values
      // are what getProviderConfig/hello_ok actually read, so editing it
      // must reach nodes immediately, not on the next manual set-default.
      await q(ctx.db, 'UPDATE users SET api_base_url = ?, api_key = ?, api_model = ? WHERE id = ?',
        baseUrl, apiKey, model || 'gpt-5.6', userId).run();
      await pushConfigToUser(ctx, userId);
    }
    return ok({ profile: { id: route[1], name, baseUrl, apiKey, model: model || null, isDefault: !!profile.is_default, backend: backend || await profileBackend(ctx.db, route[1]) } });
  }
  if (method === 'POST' && route[0] === 'model-profiles' && route.length === 3 && route[2] === 'set-default') {
    const profile = await q(ctx.db, 'SELECT base_url, api_key, model FROM model_profiles WHERE id = ? AND owner_user_id = ?', route[1], userId).first();
    if (!profile) return err(404, 'profile not found');
    // The default profile is only credentials: it's mirrored into users.* and
    // pushed to nodes, where it becomes the relay for any task that picked no
    // profile — and such a task always runs claude (start_task carries no
    // backend). Making a Codex profile the default would therefore point the
    // claude CLI at a /v1/responses-only relay: every unpinned task on every
    // node breaks at once, with an error that looks like a broken relay.
    if (await profileBackend(ctx.db, route[1]) !== DEFAULT_BACKEND) {
      return err(409, 'Codex 档案不能设为账户默认:默认配置是给「没有选档案」的对话用的,而那些对话跑的是 Claude Code。请在建卡时直接选这个档案。');
    }
    await q(ctx.db, 'UPDATE model_profiles SET is_default = 0 WHERE owner_user_id = ?', userId).run();
    await q(ctx.db, 'UPDATE model_profiles SET is_default = 1 WHERE id = ?', route[1]).run();
    // Mirrored into users.* — this is the copy getProviderConfig/hello_ok
    // actually read, so "set default" takes effect for nodes immediately via
    // the same pushConfigToUser the manual settings form always used.
    await q(ctx.db, 'UPDATE users SET api_base_url = ?, api_key = ?, api_model = ? WHERE id = ?',
      profile.base_url, profile.api_key, profile.model || 'gpt-5.6', userId).run();
    await pushConfigToUser(ctx, userId);
    return ok({});
  }
  if (method === 'DELETE' && route[0] === 'model-profiles' && route.length === 2) {
    const profile = await q(ctx.db, 'SELECT id, is_default FROM model_profiles WHERE id = ? AND owner_user_id = ?', route[1], userId).first();
    if (!profile) return err(404, 'profile not found');
    // Tasks resolve both credentials and agent backend through this profile.
    // Deleting it would silently turn a pinned Codex task into Claude and make
    // its session id unusable, so keep profile identity immutable while used.
    const inUse = await q(ctx.db, 'SELECT id FROM tasks WHERE model_profile_id = ? LIMIT 1', route[1]).first();
    if (inUse) return err(409, '这个档案已经有对话在用了,不能删除。请先把未启动的对话切换到其他档案。');
    await q(ctx.db, 'DELETE FROM model_profiles WHERE id = ?', route[1]).run();
    // The side table has no foreign key (D1 schema here declares none), so the
    // backend row has to go explicitly — left behind, a future profile that
    // happened to reuse this id would silently inherit someone else's backend.
    await q(ctx.db, 'DELETE FROM model_profile_backends WHERE profile_id = ?', route[1]).run();
    if (profile.is_default) {
      // Clear the mirrored copy too — otherwise the lazy migration at the
      // top of GET would see api_base_url/api_key still set with 0 profile
      // rows and "helpfully" resurrect the profile that was just deleted.
      await q(ctx.db, 'UPDATE users SET api_base_url = NULL, api_key = NULL WHERE id = ?', userId).run();
    }
    return ok({});
  }

  if (method === 'POST' && route[0] === 'fetch-models' && route.length === 1) {
    const { baseUrl, apiKey } = body || {};
    if (!baseUrl || !apiKey) return err(400, 'baseUrl, apiKey required');
    try {
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) return err(502, `relay returned HTTP ${res.status}`);
      const data = await res.json();
      const models = Array.isArray(data?.data) ? data.data.map(m => m.id).filter(Boolean) : [];
      return ok({ models });
    } catch (e) {
      return err(502, `could not reach relay: ${e.message}`);
    }
  }

  // browse/sessions deliberately stay owner-only, NOT widened to team scope
  // like task/node visibility above — this is raw filesystem access on the
  // machine (picking a path for a brand-new task), a materially bigger grant
  // than "can see/create tasks on a teammate's node." Revisit if that
  // trade-off turns out to be wrong in practice.
  if (method === 'GET' && route[0] === 'nodes' && route.length === 3 && route[2] === 'browse') {
    const nodeId = route[1];
    const node = await q(ctx.db, 'SELECT id FROM nodes WHERE id = ? AND owner_user_id = ?', nodeId, userId).first();
    if (!node) return err(404, 'node not found');
    const path = body?.path || '';
    const result = await ctx.browseNode(nodeId, path);
    if (!result) return ok({ entries: [] });
    return ok({ entries: result.entries || [] });
  }

  if (method === 'GET' && route[0] === 'nodes' && route.length === 3 && route[2] === 'sessions') {
    const nodeId = route[1];
    const node = await q(ctx.db, 'SELECT id FROM nodes WHERE id = ? AND owner_user_id = ?', nodeId, userId).first();
    if (!node) return err(404, 'node not found');
    const path = body?.path || '';
    const result = await ctx.listSessions(nodeId, path);
    if (!result) return ok({ sessions: [] });
    return ok({ sessions: result.sessions || [] });
  }

  if (route[0] === 'admin') {
    const me = await q(ctx.db, 'SELECT is_admin FROM users WHERE id = ?', userId).first();
    if (!me?.is_admin) return err(403, 'admin only');

    if (method === 'POST' && route[1] === 'users' && route.length === 2) {
      const { username, password } = body || {};
      if (!username || !password) return err(400, 'username + password required');
      const existing = await q(ctx.db, 'SELECT id FROM users WHERE username = ?', username).first();
      if (existing) return err(409, 'username already taken');
      const user = await accounts.createUser(ctx.db, { username, password, isAdmin: false }, ctx.now());
      return ok({ user });
    }

    // List/disable/enable/reset-password/toggle-admin — see the team-sharing
    // plan's Phase 3: disabling soft-locks the account (blocks login AND
    // kills already-issued sessions, see accounts.resolveSession) rather than
    // deleting it, so existing tasks/nodes stay attributed instead of
    // orphaning.
    if (route[1] === 'users' && route.length >= 3) {
      const targetId = route[2];
      if (method === 'POST' && route.length === 4 && route[3] === 'disable') {
        // Disabling yourself kills your own session on the next request (see
        // accounts.resolveSession) with no other admin route back in for
        // this account — block it the same way the last-admin check below
        // blocks self-demotion into a lockout.
        if (targetId === userId) return err(400, 'cannot disable your own account');
        await q(ctx.db, 'UPDATE users SET disabled = 1 WHERE id = ?', targetId).run();
        return ok({});
      }
      if (method === 'POST' && route.length === 4 && route[3] === 'enable') {
        await q(ctx.db, 'UPDATE users SET disabled = 0 WHERE id = ?', targetId).run();
        return ok({});
      }
      if (method === 'POST' && route.length === 4 && route[3] === 'reset-password') {
        const password = String(body?.password || '');
        if (password.length < 8) return err(400, 'password must be at least 8 chars');
        await q(ctx.db, 'UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(password), targetId).run();
        return ok({});
      }
      if (method === 'POST' && route.length === 4 && route[3] === 'toggle-admin') {
        const target = await q(ctx.db, 'SELECT is_admin FROM users WHERE id = ?', targetId).first();
        if (!target) return err(404, 'user not found');
        // Refuse to let the last admin demote themselves into a system with
        // no admin left — there's no other route back in once that happens.
        if (target.is_admin) {
          const otherAdmins = await q(ctx.db, 'SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND id != ?', targetId).first();
          if ((otherAdmins?.n ?? 0) === 0) return err(400, 'cannot remove the last admin');
        }
        await q(ctx.db, 'UPDATE users SET is_admin = ? WHERE id = ?', target.is_admin ? 0 : 1, targetId).run();
        return ok({});
      }
    }

    if (method === 'GET' && route[1] === 'users' && route.length === 2) {
      const users = await q(ctx.db, 'SELECT id, username, is_admin, disabled, created_at FROM users ORDER BY created_at').all();
      const rows = users.results ?? users;
      for (const u of rows) {
        const teams = await q(ctx.db,
          `SELECT teams.id, teams.name, team_members.role FROM team_members
           JOIN teams ON teams.id = team_members.team_id WHERE team_members.user_id = ? ORDER BY teams.name`, u.id).all();
        u.teams = teams.results ?? teams;
        const taskCount = await q(ctx.db, 'SELECT COUNT(*) AS n FROM tasks WHERE owner_user_id = ?', u.id).first();
        const nodeCount = await q(ctx.db, 'SELECT COUNT(*) AS n FROM nodes WHERE owner_user_id = ?', u.id).first();
        u.taskCount = taskCount?.n ?? 0;
        u.nodeCount = nodeCount?.n ?? 0;
        u.isAdmin = !!u.is_admin;
        u.disabled = !!u.disabled;
        delete u.is_admin;
      }
      return ok({ users: rows });
    }

    if (method === 'GET' && route[1] === 'overview' && route.length === 2) {
      // Aggregate counts only, no message content — admin gets an
      // operational view (who's online, how much is in flight), not a
      // backdoor into anyone's conversations.
      const users = await q(ctx.db, 'SELECT id, username FROM users ORDER BY username').all();
      const rows = users.results ?? users;
      const overview = [];
      for (const u of rows) {
        const nodes = await q(ctx.db, `SELECT status FROM nodes WHERE owner_user_id = ?`, u.id).all();
        const nodeRows = nodes.results ?? nodes;
        const tasks = await q(ctx.db, `SELECT status, COUNT(*) AS n FROM tasks WHERE owner_user_id = ? GROUP BY status`, u.id).all();
        const taskRows = tasks.results ?? tasks;
        const tasksByStatus = {};
        for (const t of taskRows) tasksByStatus[t.status] = t.n;
        overview.push({
          userId: u.id,
          username: u.username,
          nodeCount: nodeRows.length,
          nodesOnline: nodeRows.filter(n => n.status === 'online').length,
          tasksByStatus,
        });
      }
      return ok({ overview });
    }

    if (method === 'POST' && route[1] === 'registration' && route.length === 2) {
      const open = body?.open ? '1' : '0';
      await q(ctx.db,
        `INSERT INTO app_settings (key, value) VALUES ('registration_open', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`, open).run();
      return ok({ open: open === '1' });
    }

    // ---- team CRUD (admin-managed — see the team-sharing plan's "design
    // decisions" note for why this is top-down rather than self-service) ----
    if (route[1] === 'teams') {
      if (method === 'GET' && route.length === 2) {
        const teams = await q(ctx.db, 'SELECT id, name, created_at FROM teams ORDER BY created_at').all();
        const rows = teams.results ?? teams;
        for (const t of rows) {
          const members = await q(ctx.db,
            `SELECT team_members.user_id, users.username, team_members.role FROM team_members
             JOIN users ON users.id = team_members.user_id WHERE team_id = ? ORDER BY joined_at`, t.id).all();
          t.members = members.results ?? members;
        }
        return ok({ teams: rows });
      }
      if (method === 'POST' && route.length === 2) {
        const name = String(body?.name || '').trim();
        if (!name) return err(400, 'name required');
        const id = ulid(ctx.now());
        await q(ctx.db, 'INSERT INTO teams (id, name, created_at) VALUES (?, ?, ?)', id, name, ctx.now()).run();
        // The admin who creates a team is who it's "theirs" from the UI's
        // perspective — not auto-joining them was the actual bug behind "I
        // made a team but my own switcher doesn't show it." They can still
        // remove themselves afterward via the same members UI if a team is
        // meant to be admin-managed-but-not-admin-member.
        await q(ctx.db, 'INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
          id, userId, 'owner', ctx.now()).run();
        return ok({ team: { id, name } });
      }
      const teamId = route[2];
      if (method === 'DELETE' && route.length === 3) {
        // Deleting a project must also drop every task/node's membership row
        // for it — found live: this used to leave task_teams/node_teams rows
        // pointing at a team_id that no longer exists in `teams`, which
        // orphans the task/node from *every* view (not in personal — it
        // still has a team_teams row disqualifying it — and not in any real
        // team either, since the team itself is gone). The task/node itself
        // was never touched, only its visibility broke.
        await q(ctx.db, 'DELETE FROM task_teams WHERE team_id = ?', teamId).run();
        await q(ctx.db, 'DELETE FROM node_teams WHERE team_id = ?', teamId).run();
        await q(ctx.db, 'DELETE FROM team_members WHERE team_id = ?', teamId).run();
        await q(ctx.db, 'DELETE FROM teams WHERE id = ?', teamId).run();
        return ok({});
      }
      if (method === 'POST' && route[3] === 'members' && route.length === 4) {
        const username = String(body?.username || '').trim();
        const role = body?.role === 'owner' ? 'owner' : 'member';
        if (!username) return err(400, 'username required');
        return await addTeamMember(ctx, teamId, username, role);
      }
      if (method === 'DELETE' && route[3] === 'members' && route.length === 5) {
        await q(ctx.db, 'DELETE FROM team_members WHERE team_id = ? AND user_id = ?', teamId, route[4]).run();
        return ok({});
      }
    }
    return err(404, 'not found');
  }

  if (method === 'GET' && route[0] === 'teams' && route.length === 1) {
    const rows = await q(ctx.db,
      `SELECT teams.id, teams.name, team_members.role FROM team_members
       JOIN teams ON teams.id = team_members.team_id WHERE team_members.user_id = ? ORDER BY teams.name`,
      userId).all();
    return ok({ teams: rows.results ?? rows });
  }

  // Self-service project creation — any user can spin up their own project,
  // same as the admin-panel's team creation (same insert, same "creator
  // becomes owner" step so it immediately shows up in their own switcher
  // instead of needing a separate self-add), just without the is_admin gate.
  if (method === 'POST' && route[0] === 'teams' && route.length === 1) {
    const name = String(body?.name || '').trim();
    if (!name) return err(400, 'name required');
    const id = ulid(ctx.now());
    await q(ctx.db, 'INSERT INTO teams (id, name, created_at) VALUES (?, ?, ?)', id, name, ctx.now()).run();
    await q(ctx.db, 'INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
      id, userId, 'owner', ctx.now()).run();
    return ok({ team: { id, name, role: 'owner' } });
  }

  // Self-service membership — a project owner can pull people in/kick them
  // out without needing a site admin (per the user's explicit choice: owner
  // only, not any member). Anyone can always remove *themselves* regardless
  // of role ("leave project"). New members always join as plain 'member' —
  // promoting someone to owner stays an admin-panel action, so ownership
  // can't be self-propagated without an admin ever being involved.
  if (route[0] === 'teams' && route.length >= 3 && route[2] === 'members') {
    const teamId = route[1];
    if (method === 'GET' && route.length === 3) {
      // Any member can see who else is in the project (needed to render the
      // add/remove UI at all); only the mutation routes below are owner-gated.
      if (!(await assertTeamMember(ctx, teamId))) return err(403, 'not a member of that team');
      const rows = await q(ctx.db,
        `SELECT team_members.user_id, users.username, team_members.role FROM team_members
         JOIN users ON users.id = team_members.user_id WHERE team_id = ? ORDER BY joined_at`, teamId).all();
      return ok({ members: rows.results ?? rows });
    }
    if (method === 'POST' && route.length === 3) {
      const myRole = await q(ctx.db, 'SELECT role FROM team_members WHERE team_id = ? AND user_id = ?', teamId, userId).first();
      if (myRole?.role !== 'owner') return err(403, 'only a project owner can add members');
      const username = String(body?.username || '').trim();
      if (!username) return err(400, 'username required');
      return await addTeamMember(ctx, teamId, username, 'member');
    }
    if (method === 'DELETE' && route.length === 4) {
      const targetUserId = route[3];
      if (targetUserId !== userId) {
        const myRole = await q(ctx.db, 'SELECT role FROM team_members WHERE team_id = ? AND user_id = ?', teamId, userId).first();
        if (myRole?.role !== 'owner') return err(403, 'only a project owner can remove other members');
      }
      await q(ctx.db, 'DELETE FROM team_members WHERE team_id = ? AND user_id = ?', teamId, targetUserId).run();
      return ok({});
    }
  }

  if (method === 'POST' && route[0] === 'push' && route[1] === 'subscribe') {
    if (!body?.subscription?.endpoint) return err(400, 'subscription required');
    await q(ctx.db,
      'INSERT OR REPLACE INTO push_subscriptions (id, owner_user_id, subscription, created_at) VALUES (?, ?, ?, ?)',
      body.subscription.endpoint, userId, JSON.stringify(body.subscription), ctx.now()).run();
    return ok({});
  }

  return err(404, 'not found');
}

export async function snapshot(ctx) {
  // hub.mjs already rejects the WS upgrade if ctx.teamId names a team the
  // caller isn't in, so a failed membership check here would mean that
  // guard was bypassed somehow — fall back to personal scope rather than 500.
  const teamId = (await assertTeamMember(ctx, ctx.teamId)) ? ctx.teamId : null;
  const taskRows = teamId
    ? await q(ctx.db,
        `SELECT tasks.*, users.username AS owner_username FROM tasks
         LEFT JOIN users ON users.id = tasks.owner_user_id
         WHERE tasks.id IN (SELECT task_id FROM task_teams WHERE team_id = ?)
         ORDER BY tasks.created_at DESC LIMIT 500`, teamId).all()
    : await q(ctx.db,
        `SELECT tasks.*, users.username AS owner_username FROM tasks
         LEFT JOIN users ON users.id = tasks.owner_user_id
         WHERE tasks.owner_user_id = ? AND tasks.id NOT IN (SELECT task_id FROM task_teams)
         ORDER BY tasks.created_at DESC LIMIT 500`, ctx.userId).all();
  const tasks = taskRows.results ?? taskRows;
  await attachTeamIds(ctx, tasks);
  const nodeRows = teamId
    ? await q(ctx.db,
        `SELECT nodes.id, nodes.name, nodes.owner_user_id, users.username AS owner_username, nodes.labels, nodes.status, nodes.last_heartbeat_at
         FROM nodes LEFT JOIN users ON users.id = nodes.owner_user_id
         WHERE nodes.id IN (SELECT node_id FROM node_teams WHERE team_id = ?)`, teamId).all()
    // Inclusive, not exclusive — see the matching REST route's comment above.
    : await q(ctx.db,
        `SELECT nodes.id, nodes.name, nodes.owner_user_id, users.username AS owner_username, nodes.labels, nodes.status, nodes.last_heartbeat_at
         FROM nodes LEFT JOIN users ON users.id = nodes.owner_user_id
         WHERE nodes.owner_user_id = ?`, ctx.userId).all();
  const nodes = nodeRows.results ?? nodeRows;
  await attachNodeTeamIds(ctx, nodes);
  return { t: 'snapshot', tasks, nodes };
}

const ok = (body) => ({ status: 200, body: { ok: true, ...body } });
const err = (status, message) => ({ status, body: { ok: false, error: message } });
