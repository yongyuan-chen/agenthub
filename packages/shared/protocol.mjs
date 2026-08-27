// AgentHub shared protocol: task state machine, event kinds, ulid.
// Zero-dependency ESM, used by executor (Node), worker (Cloudflare), tests.

export const TASK_STATUS = /** @type {const} */ ([
  'queued', 'starting', 'running', 'waiting_human', 'review',
  'done', 'failed', 'cancelled', 'unknown',
]);

export const ACTIVE_STATUSES = ['queued', 'starting', 'running', 'waiting_human', 'review', 'unknown'];
export const TERMINAL_STATUSES = ['done', 'failed', 'cancelled'];

// Image-attachment limits for the chat composer, shared by client (encode/
// downscale before ever sending) and server (independent backstop — a
// modified client can't smuggle a bigger payload through). Sized to stay
// well under D1's 2,000,000-byte hard cap per column value once base64
// inflation (~33%) and JSON overhead are accounted for.
export const MAX_IMAGES_PER_MESSAGE = 4;
export const MAX_ATTACHMENT_TOTAL_RAW_BYTES = 1_200_000;
export const ALLOWED_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

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
// {t:'browse_result', requestId, entries}                 reply to a cloud-initiated {t:'browse'}
// {t:'list_project_sessions_result', requestId, sessions} reply to read-only batch history discovery
// {t:'read_project_session_result', requestId, events}    bounded read-only history mapped to AgentHub message events
// ---- Cloud -> Executor messages ----
// {t:'hello_ok', tasks:[{taskId, lastSeq}], anthropic?}
// {t:'ack', taskId, seq}
// {t:'start_task', task:{id,title,spec,repoUrl,baseBranch,permissionMode,sessionId,sourceCwd?,anthropic?}}
//    task.anthropic (optional) -> {baseUrl,apiKey,model} pins this task to a specific model
//    profile chosen at creation time, overriding the node's shared config for its lifetime.
// {t:'user_message', taskId, text, images?}                images: [{mediaType, data}], data is base64
// {t:'decision', taskId, requestId, behavior, message?}   behavior: allow|deny
// {t:'cancel', taskId}
// {t:'lease', taskId, lease}                              lease: daemon|human
// {t:'config', anthropic}                                 live relay-credential push (see hub-core.mjs pushConfigToUser)
// {t:'set_anthropic_override', taskId, anthropic}         pin/unpin a task's model profile mid-conversation; anthropic
//                                                          {baseUrl,apiKey,model} or null = revert to node default.
//                                                          Spawn-time env — takes effect from the next turn's spawn.
// {t:'browse', requestId, path}                            cloud-initiated request/response, answered by browse_result;
//                                                          not tied to a task — used to autocomplete project paths.
// {t:'list_project_sessions', requestId, paths}            scans external Claude histories for task-derived directories.
// {t:'read_project_session', requestId, sessionId, cwd, before?, turns} reads one page of an authorized history without adopting it.
// ---- Cloud -> Frontend messages ----
// {t:'snapshot', tasks, nodes}
// {t:'task', task}
// {t:'msg', taskId, seq, role, content, ts}
// {t:'node', node}
// {t:'conversation_source_claimed', sourceId, taskId}

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
