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

// Bumped whenever the wire shape changes in a way an older executor would
// silently mis-handle rather than reject. v2 renamed every `anthropic` field
// to `provider` with no compatibility layer: a v1 node receiving `provider`
// would ignore it and spawn the CLI against the node-wide default relay
// instead of the pinned model profile — a wrong answer that looks like a
// working one. The cloud refuses to dispatch to a node below this, so the
// failure shows up as "this node needs upgrading" instead.
export const PROTOCOL_VERSION = 2;

// Agent CLIs an executor can drive. A node reports the subset it actually has
// installed in `hello`; the cloud won't dispatch a codex task to a node that
// didn't claim 'codex'. See packages/executor/src/backends.mjs.
export const BACKENDS = ['claude', 'codex'];
export const DEFAULT_BACKEND = 'claude';

// ---- Executor -> Cloud messages ----
// {t:'hello', nodeId, protocolVersion, backends:['claude','codex'], features:['message-ack'],
//             tasks:[{taskId, status, lastSeq, sessionId, costUsd, lease}]}
// {t:'hb'}
// {t:'ev', taskId, seq, ev}
//    ev.k = 'msg'     -> {k, role, content, ts}         role: user|assistant|tool_use|tool_result|system|result|perm_request|diff
//                                                       content.clientMessageId is present on a 'user' message that came from
//                                                       a browser send, so the frontend can retire its own pending bubble.
//    ev.k = 'status'  -> {k, status, extra?, ts}        extra: {error?, pendingRequest?, lease?}
//    ev.k = 'session' -> {k, sessionId, ts}
//    ev.k = 'cost'    -> {k, costUsd, ts}               cumulative
// {t:'browse_result', requestId, entries}                 reply to a cloud-initiated {t:'browse'}
// {t:'list_project_sessions_result', requestId, sessions} reply to read-only batch history discovery
// {t:'read_project_session_result', requestId, events}    bounded read-only history mapped to AgentHub message events
// ---- Cloud -> Executor messages ----
// {t:'hello_ok', tasks:[{taskId, lastSeq}], provider?}
// {t:'ack', taskId, seq}
// {t:'start_task', task:{id,title,spec,images?,repoUrl,baseBranch,permissionMode,sessionId,sourceCwd?,provider?,backend?}}
//    task.provider (optional) -> {baseUrl,apiKey,model} pins this task to a specific model
//    profile chosen at creation time, overriding the node's shared config for its lifetime.
//    task.backend (optional) -> which agent CLI drives it; absent = 'claude'. Comes from the
//    same profile, so choosing a model is also choosing a backend.
//    task.images (optional) -> [{mediaType, data}] attached to the *first* message (spec), same
//    shape as user_message.images. Only sent to a node advertising FEATURE_TASK_IMAGES.
// {t:'user_message', taskId, text, images?, clientMessageId?}
//                                                          images: [{mediaType, data}], data is base64.
//                                                          clientMessageId: the browser's own id for this exact send, echoed
//                                                          back on the resulting {k:'msg', role:'user'} event. That echo is
//                                                          what marks the send delivered cloud-side, so an undelivered
//                                                          message is redelivered on reconnect and the executor drops the
//                                                          duplicate by id instead of running the turn twice.
// {t:'decision', taskId, requestId, behavior, message?}   behavior: allow|deny
// {t:'cancel', taskId}
// {t:'lease', taskId, lease}                              lease: daemon|human
// {t:'config', provider}                                  live relay-credential push (see hub-core.mjs pushConfigToUser)
// {t:'set_provider_override', taskId, provider, backend?} pin/unpin a task's model profile mid-conversation; provider
//                                                          {baseUrl,apiKey,model} or null = revert to node default.
//                                                          Spawn-time env — takes effect from the next turn's spawn.
//                                                          backend is refused cloud-side (409) when the task already has
//                                                          a session id: session ids aren't portable across agent CLIs.
// {t:'browse', requestId, path}                            cloud-initiated request/response, answered by browse_result;
//                                                          not tied to a task — used to autocomplete project paths.
// {t:'list_project_sessions', requestId, paths}            scans external Claude histories for task-derived directories.
// {t:'read_project_session', requestId, sessionId, cwd, before?, turns} reads one page of an authorized history without adopting it.
// ---- Cloud -> Frontend messages ----
// {t:'snapshot', tasks, nodes}
// {t:'task', task}
// {t:'msg', taskId, seq, role, content, ts}
// {t:'pending_msg', taskId, pending}                      a user send accepted by the cloud but not yet echoed back by the
//                                                          node — rendered as a "还没送达" bubble so the text is visible on
//                                                          every device the moment it's durable, not only once a node runs it.
// {t:'pending_settled', taskId, clientMessageId, state}   state: 'delivered' (the node's own user event landed) or 'failed'
//                                                          (undeliverable for too long — the bubble becomes retryable).
// {t:'node', node}
// {t:'conversation_source_claimed', sourceId, taskId}

// A browser send is identified end-to-end by its own id, so the same text can
// be retried/replayed at any layer without ever duplicating or vanishing:
// cloud stores it as an outbound row, the node echoes it back on its user
// event, and the frontend retires its pending bubble when it does.
export const MAX_CLIENT_MESSAGE_ID_LENGTH = 64;
const CLIENT_MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidClientMessageId(value) {
  return typeof value === 'string' && CLIENT_MESSAGE_ID_PATTERN.test(value);
}

// Capabilities a node advertises in `hello`, beyond the coarse protocol
// version. PROTOCOL_VERSION is a hard gate (below it, no work is dispatched
// at all); this is for changes an older node handles *safely but partially*,
// where refusing to talk to it would be worse than adapting.
//
// MESSAGE_ACK: this node echoes clientMessageId back on the user event it
// emits, which is what lets the cloud know a send actually landed. A node
// without it still runs the message correctly — it just can't confirm, so
// the cloud must not keep redelivering (a pre-upgrade node would re-run the
// turn every retry, spending real relay tokens). Sends to such a node are
// delivered once and settled optimistically instead.
// TASK_IMAGES: this node understands start_task.images (images attached to the
// very first message of a brand-new conversation). A node without it would
// silently drop them and answer a question about a picture it never received —
// so unlike MESSAGE_ACK there is no safe degraded behaviour, and the cloud
// refuses the creation with a "node is still upgrading" message instead.
export const FEATURE_MESSAGE_ACK = 'message-ack';
export const FEATURE_TASK_IMAGES = 'task-images';
export const EXECUTOR_FEATURES = [FEATURE_MESSAGE_ACK, FEATURE_TASK_IMAGES];

// How long an accepted-but-undelivered send keeps being retried at the node
// before the cloud gives up and marks it failed. Long enough to cover a node
// that's merely rebooting/offline overnight; bounded so a message aimed at a
// node that will never accept it (local DB wiped, task gone) surfaces as a
// retryable failure instead of silently pending forever.
export const OUTBOUND_MESSAGE_TTL_MS = 24 * 3600_000;

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
