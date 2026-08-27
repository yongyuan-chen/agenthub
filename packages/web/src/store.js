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
  state.wsConnected = false;
  state.loaded = false;
  state.teams = [];
  state.activeTeamId = null;
  state.scopeCache = {};
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

export function upsertNode(node) {
  if (!node?.id) return;
  state.nodes.set(node.id, node);
  currentScopeCache().nodes.set(node.id, node);
}

export function addMessage(taskId, msg) {
  if (!state.msgs.has(taskId)) state.msgs.set(taskId, new Map());
  state.msgs.get(taskId).set(msg.seq, msg);
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
