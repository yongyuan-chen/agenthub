// Tiny global store: single version counter + module state, components
// subscribe via useSyncExternalStore. Scale (1 user, hundreds of tasks) makes
// full re-render on change perfectly fine.
let version = 0;
const listeners = new Set();

export const state = {
  tasks: new Map(),      // id -> task row
  nodes: new Map(),      // id -> node row
  msgs: new Map(),       // taskId -> Map(seq -> {seq, role, content, ts})
  wsConnected: false,
  loaded: false,
};

export function bump() {
  version++;
  for (const l of listeners) l();
}

export const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const getVersion = () => version;

export function upsertTask(task) {
  if (task?.id) { state.tasks.set(task.id, task); }
}

export function upsertNode(node) {
  if (node?.id) state.nodes.set(node.id, node);
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
      state.tasks = new Map(msg.tasks.map(t => [t.id, t]));
      state.nodes = new Map(msg.nodes.map(n => [n.id, n]));
      state.loaded = true;
      break;
    case 'task': upsertTask(msg.task); break;
    case 'node': upsertNode(msg.node); break;
    case 'msg': addMessage(msg.taskId, { seq: msg.seq, role: msg.role, content: msg.content, created_at: msg.ts }); break;
    default: return;
  }
  bump();
}
