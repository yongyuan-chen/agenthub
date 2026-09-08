// Tiny global store: single version counter + module state, components
// subscribe via useSyncExternalStore. Scale (1 user, hundreds of tasks) makes
// full re-render on change perfectly fine.
let version = 0;
const listeners = new Set();

export const state = {
  tasks: new Map(),      // id -> task row (current personal/project scope only)
  nodes: new Map(),      // id -> node row (current personal/project scope only)
  conversationSources: new Map(), // id -> read-only external Claude session metadata for this scope
  sourceClaims: {},       // scopeKey -> Map(source pane id -> claimed real task id), consumed by AppShell
  sourceEpochs: {},       // scopeKey -> mutation generation, rejects stale source-list responses
  taskEpochs: {},         // scopeKey -> task mutation generation, rejects stale scoped task responses
  sourceStatus: {},       // scopeKey -> {loading,error,unavailableNodeIds}
  sourceRequestSeq: {},   // scopeKey -> newest source-list request generation
  userGeneration: 0,     // monotonic account boundary; in-flight old-user work is discarded
  msgs: new Map(),       // taskId -> Map(seq -> {seq, role, content, ts}) — global, not scoped (a task's own id is already unique)
  // taskId -> Map(clientMessageId -> {clientMessageId, text, images, state, createdAt})
  // Sends the cloud has accepted but no node has echoed back yet. Kept
  // separate from msgs because they have no seq: they're rendered after the
  // real log as still-in-flight bubbles, and removed when the node's own
  // user message arrives with the same id. This is what stops a message from
  // looking like it vanished while it's actually queued for an offline node.
  pendingMsgs: new Map(),
  wsConnected: false,
  loaded: false,
  teams: [],             // [{id, name, role}] — this user's own memberships
  activeTeamId: null,     // null = personal/mine-only (default, unchanged behavior)
  // Last-known tasks/nodes per personal/project view — switching used to
  // wipe state.tasks/nodes to empty and block on a fresh network round trip
  // before showing anything again (~1s, felt like a page reload). Once a
  // scope has been visited at least once, switching back to it now shows
  // this cached snapshot immediately (see main.jsx's switchTeam) while a
  // background refresh corrects anything stale — same stale-while-revalidate
  // feel as flipping a browser tab instead of reloading a page.
  scopeCache: {},         // scopeKey -> { tasks: Map, nodes: Map, conversationSources: Map }
  // Read state for the "这个对话有新动静" dots. Kept out of the task rows on
  // purpose: a task object is replaced wholesale by every WS broadcast, and
  // that broadcast goes to a whole project, so it can't carry one viewer's
  // seen_at. taskSeen is this user's own, from GET /tasks and from marking a
  // pane read; unread is the server's per-scope count, the only way tabs for
  // projects this client isn't currently subscribed to learn they have
  // something waiting.
  taskSeen: new Map(),    // taskId -> seen_at (ms)
  unread: {},             // scopeKey -> count, from GET /api/unread
};

// Must match shell.jsx's own PERSONAL/scopeKey constant and the backend's
// layout route (hub-core.mjs: `ctx.teamId || 'personal'`) — this is a
// cross-module cache-key convention, not just a local sentinel.
export function scopeKeyOf(teamId) {
  return teamId || 'personal';
}

export function cacheForScope(key = scopeKeyOf(state.activeTeamId)) {
  const cache = state.scopeCache[key] || (state.scopeCache[key] = {});
  cache.tasks ||= new Map();
  cache.nodes ||= new Map();
  cache.conversationSources ||= new Map();
  return cache;
}

function currentScopeCache() {
  return cacheForScope();
}

export function bump() {
  version++;
  for (const l of listeners) l();
}

export const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const getVersion = () => version;

export function resetUserState() {
  const nextGeneration = (state.userGeneration || 0) + 1;
  state.tasks = new Map();
  state.nodes = new Map();
  state.conversationSources = new Map();
  state.sourceClaims = {};
  state.sourceEpochs = {};
  state.taskEpochs = {};
  state.sourceStatus = {};
  state.sourceRequestSeq = {};
  state.userGeneration = nextGeneration;
  state.msgs = new Map();
  state.pendingMsgs = new Map();
  state.wsConnected = false;
  state.loaded = false;
  state.teams = [];
  state.activeTeamId = null;
  state.scopeCache = {};
  state.taskSeen = new Map();
  state.unread = {};
  bump();
}

export function upsertTask(task) {
  if (!task?.id) return;
  state.tasks.set(task.id, task);
  currentScopeCache().tasks.set(task.id, task);
}

// A task fetched to resolve a direct link (see shell.jsx) can end up in
// state.tasks even though it doesn't belong to whichever scope is currently
// active — that's the whole point (open it in its own pane regardless of
// scope), but anything rendering "the current scope's task list" (sidebar,
// jump-to-latest) must filter through this rather than trusting the map's
// contents wholesale, or a personal task briefly leaks into a project view
// (and vice versa) until the next full scope reload happens to evict it.
export function taskInScope(task) {
  return state.activeTeamId
    ? (task.teamIds || []).includes(state.activeTeamId)
    : !(task.teamIds || []).length;
}

// A conversation is unread when the agent last stopped needing a human
// (attention_at, stamped server-side on exactly the transitions that also
// send a push) more recently than this user last looked at it.
export function isTaskUnread(task) {
  if (!task?.attention_at) return false;
  return task.attention_at > (state.taskSeen.get(task.id) ?? 0);
}

export function setTaskSeen(taskId, seenAt) {
  const previous = state.taskSeen.get(taskId) ?? 0;
  if (!(seenAt > previous)) return false;
  state.taskSeen.set(taskId, seenAt);
  return true;
}

// Seeds read state from a task list response. Only ever moves forward: a
// list fetch that raced a just-issued mark-seen must not resurrect the dot.
export function seedTaskSeen(tasks) {
  for (const t of tasks) if (t?.seen_at) setTaskSeen(t.id, t.seen_at);
}

// Unread count for a scope tab. The active scope is computed from the live
// task list instead of the polled server counts — it has the WS feed, so its
// dot appears and clears instantly rather than up to a poll interval late.
export function unreadForScope(teamId) {
  if (scopeKeyOf(teamId) === scopeKeyOf(state.activeTeamId)) {
    let n = 0;
    for (const task of state.tasks.values()) {
      if (!task.archived_at && taskInScope(task) && isTaskUnread(task)) n++;
    }
    return n;
  }
  return state.unread[scopeKeyOf(teamId)] || 0;
}

export function upsertNode(node) {
  if (!node?.id) return;
  state.nodes.set(node.id, node);
  currentScopeCache().nodes.set(node.id, node);
}

export function addMessage(taskId, msg) {
  if (!state.msgs.has(taskId)) state.msgs.set(taskId, new Map());
  state.msgs.get(taskId).set(msg.seq, msg);
  // The real message won the race against its own pending bubble (the node
  // echoed it back). Retiring it here as well as on 'pending_settled' means
  // a client that missed that broadcast — offline, backgrounded, mid-reload
  // — still doesn't render the same text twice.
  const clientMessageId = msg.role === 'user' ? msg.content?.clientMessageId : null;
  if (clientMessageId) removePendingMessage(taskId, clientMessageId);
}

export function upsertPendingMessage(taskId, pending) {
  if (!pending?.clientMessageId) return;
  // Already delivered for real: a late/duplicate 'pending_msg' (a reconnect
  // replay, a retry racing the delivery) must not resurrect a bubble for a
  // message that's already in the log.
  const known = state.msgs.get(taskId);
  if (known) {
    for (const message of known.values()) {
      if (message.role === 'user' && message.content?.clientMessageId === pending.clientMessageId) return;
    }
  }
  if (!state.pendingMsgs.has(taskId)) state.pendingMsgs.set(taskId, new Map());
  state.pendingMsgs.get(taskId).set(pending.clientMessageId, pending);
}

export function removePendingMessage(taskId, clientMessageId) {
  const map = state.pendingMsgs.get(taskId);
  if (!map) return;
  map.delete(clientMessageId);
  if (!map.size) state.pendingMsgs.delete(taskId);
}

export function markPendingMessageFailed(taskId, clientMessageId) {
  const existing = state.pendingMsgs.get(taskId)?.get(clientMessageId);
  if (existing) state.pendingMsgs.get(taskId).set(clientMessageId, { ...existing, state: 'failed' });
}

// Server-authoritative pending list for one task (from GET /messages).
// Replaces rather than merges: a row the server no longer has was delivered
// or abandoned, and keeping a local copy of it is exactly how a stale bubble
// would outlive the thing it represents.
export function setPendingMessages(taskId, pending) {
  const rows = (pending || []).filter(p => p?.clientMessageId);
  if (!rows.length) { state.pendingMsgs.delete(taskId); return; }
  state.pendingMsgs.set(taskId, new Map(rows.map(p => [p.clientMessageId, p])));
}

export function taskPendingMessages(taskId) {
  const map = state.pendingMsgs.get(taskId);
  if (!map) return [];
  return [...map.values()].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
}

export function taskMessages(taskId) {
  const m = state.msgs.get(taskId);
  if (!m) return [];
  return [...m.values()].sort((a, b) => a.seq - b.seq);
}

export function applyWsMessage(msg) {
  switch (msg.t) {
    case 'snapshot':
      state.taskEpochs[scopeKeyOf(state.activeTeamId)] = (state.taskEpochs[scopeKeyOf(state.activeTeamId)] || 0) + 1;
      state.tasks = new Map(msg.tasks.map(t => [t.id, t]));
      state.nodes = new Map(msg.nodes.map(n => [n.id, n]));
      state.loaded = true;
      // Authoritative full data for whichever scope this connection is
      // currently tagged for (reconnect() always closes+reopens with the
      // new scope before anything can arrive) — replace, not merge, so a
      // task/node removed from this scope while away actually disappears
      // from the cache too, not just fails to get added again.
      state.scopeCache[scopeKeyOf(state.activeTeamId)] = {
        tasks: new Map(state.tasks), nodes: new Map(state.nodes), conversationSources: new Map(state.conversationSources),
      };
      break;
    case 'task':
      state.taskEpochs[scopeKeyOf(state.activeTeamId)] = (state.taskEpochs[scopeKeyOf(state.activeTeamId)] || 0) + 1;
      upsertTask(msg.task);
      break;
    case 'node': upsertNode(msg.node); break;
    case 'msg': addMessage(msg.taskId, { seq: msg.seq, role: msg.role, content: msg.content, created_at: msg.ts }); break;
    case 'pending_msg': upsertPendingMessage(msg.taskId, msg.pending); break;
    case 'pending_settled':
      if (msg.state === 'failed') markPendingMessageFailed(msg.taskId, msg.clientMessageId);
      else removePendingMessage(msg.taskId, msg.clientMessageId);
      break;
    case 'conversation_source_claimed':
      {
        const scopeKey = scopeKeyOf(state.activeTeamId);
        if (state.tasks.has(msg.taskId)) {
          state.sourceClaims[scopeKey] ||= new Map();
          state.sourceClaims[scopeKey].set(`source:${msg.sourceId}`, msg.taskId);
        }
        state.sourceEpochs[scopeKey] = (state.sourceEpochs[scopeKey] || 0) + 1;
      }
      state.conversationSources.delete(msg.sourceId);
      for (const cache of Object.values(state.scopeCache)) cache.conversationSources?.delete(msg.sourceId);
      break;
    default: return;
  }
  bump();
}
