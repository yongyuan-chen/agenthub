// AgentHub shared protocol: task state machine, event kinds, ulid.
// Zero-dependency ESM, used by executor (Node), worker (Cloudflare), tests.

export const TASK_STATUS = /** @type {const} */ ([
  'queued', 'starting', 'running', 'waiting_human', 'review',
  'done', 'failed', 'cancelled', 'unknown',
]);

export const ACTIVE_STATUSES = ['queued', 'starting', 'running', 'waiting_human', 'review', 'unknown'];
export const TERMINAL_STATUSES = ['done', 'failed', 'cancelled'];

// User-initiated transitions validated cloud-side. Executor-reported status is
// authoritative (local truth wins) and is not gated by this map.
const USER_TRANSITIONS = {
  review: ['done', 'running'],
  waiting_human: ['running'],
  queued: ['cancelled'],
  starting: ['cancelled'],
  running: ['cancelled'],
  unknown: ['cancelled'],
};

export function userCanTransition(from, to) {
  if (to === 'cancelled') return !TERMINAL_STATUSES.includes(from);
  return (USER_TRANSITIONS[from] || []).includes(to);
}

// ---- Executor -> Cloud messages ----
// {t:'hello', nodeId, tasks:[{taskId, status, lastSeq, sessionId, costUsd, lease}]}
// {t:'hb'}
// {t:'ev', taskId, seq, ev}
//    ev.k = 'msg'     -> {k, role, content, ts}         role: user|assistant|tool_use|tool_result|system|result|perm_request|diff
//    ev.k = 'status'  -> {k, status, extra?, ts}        extra: {error?, pendingRequest?, lease?}
//    ev.k = 'session' -> {k, sessionId, ts}
//    ev.k = 'cost'    -> {k, costUsd, ts}               cumulative
// ---- Cloud -> Executor messages ----
// {t:'hello_ok', tasks:[{taskId, lastSeq}]}
// {t:'ack', taskId, seq}
// {t:'start_task', task:{id,title,spec,repoUrl,baseBranch,permissionMode,sessionId}}
// {t:'user_message', taskId, text}
// {t:'decision', taskId, requestId, behavior, message?}   behavior: allow|deny
// {t:'cancel', taskId}
// {t:'lease', taskId, lease}                              lease: daemon|human
// ---- Cloud -> Frontend messages ----
// {t:'snapshot', tasks, nodes}
// {t:'task', task}
// {t:'msg', taskId, seq, role, content, ts}
// {t:'node', node}

const ULID_CHARS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(now = Date.now()) {
  let ts = '';
  let t = now;
  for (let i = 0; i < 10; i++) { ts = ULID_CHARS[t % 32] + ts; t = Math.floor(t / 32); }
  let rnd = '';
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  for (let i = 0; i < 16; i++) rnd += ULID_CHARS[bytes[i] % 32];
  return ts + rnd;
}

export async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function nowMs() { return Date.now(); }
