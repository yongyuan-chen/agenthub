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

// Project types (team_kinds.kind). 'single' is the default and what every
// project predating the field is; 'multi' runs conversations as an
// orchestrator plus subagents, and is claude-only — Codex has no subagents.
export const PROJECT_KINDS = ['single', 'multi'];
export const DEFAULT_PROJECT_KIND = 'single';

// ---- Executor -> Cloud messages ----
// {t:'hello', nodeId, protocolVersion, backends:['claude','codex'], features:['message-ack'],
//             cliVersions:{claude:'2.1.105', codex:'0.144.6'},
//             tasks:[{taskId, status, lastSeq, sessionId, costUsd, lease}]}
//    cliVersions -> what each installed agent CLI reports for `--version`. Separate from
//    `backends` (which only answers installed-or-not) because a CLI old enough still runs,
//    still looks healthy, and still gets dispatched work it will fail — see cli-upgrade.mjs.
// {t:'hb'}
// {t:'ev', taskId, seq, ev}
//    ev.k = 'msg'     -> {k, role, content, ts}         role: user|assistant|tool_use|tool_result|system|result|perm_request|diff
//                                                       content.clientMessageId is present on a 'user' message that came from
//                                                       a browser send, so the frontend can retire its own pending bubble.
//    ev.k = 'status'  -> {k, status, extra?, ts}        extra: {error?, pendingRequest?, lease?}
//    ev.k = 'session' -> {k, sessionId, ts}
//    ev.k = 'cost'    -> {k, costUsd, ts}               cumulative
// {t:'cli_versions', versions, upgrades}                  CLI inventory changed — sent the moment an
//                                                          upgrade starts/finishes/fails instead of waiting
//                                                          for the next reconnect. versions is hello's
//                                                          cliVersions; upgrades is {backend: {state, error?,
//                                                          from?, to?, at}} with state pending|running|ok|failed.
// {t:'browse_result', requestId, entries}                 reply to a cloud-initiated {t:'browse'}
// {t:'list_project_sessions_result', requestId, sessions} reply to read-only batch history discovery
// {t:'read_project_session_result', requestId, events}    bounded read-only history mapped to AgentHub message events
// ---- Cloud -> Executor messages ----
// {t:'hello_ok', tasks:[{taskId, lastSeq}], provider?, cliLatest?, cliAutoUpgrade?}
//    cliLatest {claude,codex} -> the newest published version of each agent CLI, fetched and
//      cached cloud-side (see packages/worker/src/cli-releases.mjs). The node never talks to a
//      package registry itself: one cached answer serves every node, and nodes on unreliable
//      links to registry.npmjs.org still learn they're behind.
//    cliAutoUpgrade -> whether this node may upgrade its CLIs on its own. Cloud-owned and
//      re-asserted on every hello, like permission_mode and the provider override.
// {t:'ack', taskId, seq}
// {t:'start_task', task:{id,title,spec,images?,repoUrl,baseBranch,permissionMode,sessionId,sourceCwd?,provider?,backend?,agentMode?}}
//    task.provider (optional) -> {baseUrl,apiKey,model} pins this task to a specific model
//    profile chosen at creation time, overriding the node's shared config for its lifetime.
//    task.backend (optional) -> which agent CLI drives it; absent = 'claude'. Comes from the
//    same profile, so choosing a model is also choosing a backend.
//    task.images (optional) -> [{mediaType, data}] attached to the *first* message (spec), same
//    shape as user_message.images. Only sent to a node advertising FEATURE_TASK_IMAGES.
//    task.agentMode (optional) -> 'multi' for a conversation in a multiagent project: the main
//    thread runs as an orchestrator that delegates to subagents. Absent = single-agent. Only
//    sent to a node advertising FEATURE_MULTI_AGENT. While it runs, subagent output carries
//    content.parentToolUseId, and subagent lifecycle arrives as role 'agent_event'
//    {toolUseId, phase: started|progress|finished, status?, description?, subagentType?,
//     background?, lastToolName?, summary?, usage?}.
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
// {t:'cli_policy', latest, autoUpgrade}                    live push of hello_ok's cliLatest/cliAutoUpgrade — sent when
//                                                          the owner flips the toggle, and from the Hub alarm when a new
//                                                          CLI release appears. Without the latter a node that stays
//                                                          connected for days would never hear about a release at all.
// {t:'upgrade_cli', backend?}                              run `<cli> update` now (the UI's 「立即升级」). Queued, not
//                                                          refused, while a turn is generating: replacing a binary out
//                                                          from under a live process is undefined on POSIX and refused
//                                                          on Windows. Absent backend = every installed CLI.
// {t:'set_provider_override', taskId, provider, backend?} pin/unpin a task's model profile mid-conversation; provider
//                                                          {baseUrl,apiKey,model} or null = revert to node default.
//                                                          Spawn-time env — takes effect from the next turn's spawn.
//                                                          backend is refused cloud-side (409) when the task already has
//                                                          a session id: session ids aren't portable across agent CLIs.
// {t:'browse', requestId, path}                            cloud-initiated request/response, answered by browse_result;
//                                                          not tied to a task — used to autocomplete project paths.
// {t:'list_project_sessions', requestId, paths}            scans external Claude histories for task-derived directories.
// {t:'read_project_session', requestId, sessionId, cwd, before?, turns} reads one page of an authorized history without adopting it.
// {t:'list_dir', requestId, path?, taskId?}                cloud-initiated, answered by list_dir_result. Unlike 'browse'
//                                                          (directories only, for path autocomplete) this returns files too,
//                                                          with size/mtime. taskId with no path resolves that task's own
//                                                          working directory — the worktree path is known only to the node.
// {t:'read_file', requestId, path}                         answered by read_file_result: {content, encoding, size, mtime,
//                                                          truncated, binary}. Binary (and images) come back base64.
// {t:'write_file', requestId, path, content, expectedMtime} answered by write_file_result. expectedMtime is an optimistic
//                                                          lock, NOT a security control: the agent is very likely editing
//                                                          these same files, and an unconditional write would silently
//                                                          discard whatever it just did.
// {t:'fork_session', requestId, taskId, sessionId, dropTrailingTurns, newSessionId}
//                                                          answered by fork_session_result: {ok, sessionId, cwd, keptTurns,
//                                                          anchorText, error?}. Copies a prefix of the task's on-disk agent
//                                                          transcript to a brand-new session id, dropping the last
//                                                          dropTrailingTurns user turns — the only way to branch a
//                                                          conversation, since the agent's real context lives in that file
//                                                          and not in the cloud's messages table. cwd is echoed back
//                                                          because only the node knows where the task actually works, and
//                                                          the branch has to resume in that same directory.
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
// FILE_IO: this node can list/read/write arbitrary files on its own machine
// (the file browser). Nothing degrades gracefully here — a node without it
// simply has no such handler and would never answer — so the cloud refuses the
// request with "this node needs upgrading" rather than hanging until timeout.
// SESSION_FORK: this node can fork a task's transcript into a new session id
// (branching a conversation). Same all-or-nothing shape as FILE_IO — an older
// node has no handler and would never answer — and the consequence of not
// gating is worse here than a hung spinner: the branch would be created
// pointing at a session file that does not exist.
// CLI_UPGRADE: this node reports its agent-CLI versions and understands
// 'upgrade_cli'/'cli_policy'. An older node reports no versions and has no
// handler, so the cloud hides the upgrade controls for it rather than
// offering a button that silently does nothing — the same reasoning as
// FILE_IO, minus the hung spinner (there's no request/response here).
// MULTI_AGENT: this node understands start_task.agentMode. An older one would
// silently run a multiagent conversation as a plain single agent — a
// conversation that looks like it works but ignores what the project is for —
// so the cloud refuses to create one there instead.
export const FEATURE_MESSAGE_ACK = 'message-ack';
export const FEATURE_TASK_IMAGES = 'task-images';
export const FEATURE_FILE_IO = 'file-io';
export const FEATURE_SESSION_FORK = 'session-fork';
// -2: the first version moved an edited ordinary task into ~/.claude, which
// swapped AgentHub's relay key for that home's own credentials. Bumped so the
// cloud refuses edits on nodes still running it.
export const FEATURE_MESSAGE_REWIND = 'message-rewind-2';
export const FEATURE_CLI_UPGRADE = 'cli-upgrade';
export const FEATURE_MULTI_AGENT = 'multi-agent';
export const EXECUTOR_FEATURES = [
  FEATURE_MESSAGE_ACK, FEATURE_TASK_IMAGES, FEATURE_FILE_IO, FEATURE_SESSION_FORK, FEATURE_CLI_UPGRADE,
  FEATURE_MULTI_AGENT, FEATURE_MESSAGE_REWIND,
];

// Caps for the file browser, shared so the executor and the cloud agree.
// A file's bytes travel as JSON over the node WebSocket and then over the
// HTTP response, so this is about keeping a single message sane, not about
// what the editor can display.
export const MAX_FILE_READ_BYTES = 1_000_000;
export const MAX_DIR_ENTRIES = 2000;

// How long an accepted-but-undelivered send keeps being retried at the node
// before the cloud gives up and marks it failed. Long enough to cover a node
// that's merely rebooting/offline overnight; bounded so a message aimed at a
// node that will never accept it (local DB wiped, task gone) surfaces as a
// retryable failure instead of silently pending forever.
export const OUTBOUND_MESSAGE_TTL_MS = 24 * 3600_000;

// ---- agent-CLI version comparison ----
//
// Shared because three places have to reach the same verdict about whether a
// node is behind: the executor (decides whether to run an installer), the
// worker, and the UI (renders 最新 vs 可升级). Two implementations of "is this
// version older" would eventually disagree, and the visible symptom would be a
// node showing 可升级 forever while refusing to upgrade.
//
// `claude --version` -> "2.1.105 (Claude Code)"
// `codex --version`  -> "codex-cli 0.144.6"
// Both are covered by "first dotted-numeric run in the string", which is also
// why the prerelease tail is optional — nothing here should choke on a
// 0.158.0-alpha.6 someone installed deliberately.
export const CLI_VERSION_RE = /(\d+)\.(\d+)\.(\d+)(?:[-+.]([0-9A-Za-z][0-9A-Za-z.]*))?/;

export function parseVersion(text) {
  const m = CLI_VERSION_RE.exec(String(text ?? ''));
  return m ? m[0] : null;
}

// Numeric-segment comparison with one prerelease rule: same numbers but one
// side carries a suffix -> the suffixed one is older (0.158.0-alpha.6 <
// 0.158.0). Returns null when either side doesn't parse, which every caller
// treats as "don't act" rather than as a comparison result.
export function compareVersions(a, b) {
  const pa = CLI_VERSION_RE.exec(String(a ?? ''));
  const pb = CLI_VERSION_RE.exec(String(b ?? ''));
  if (!pa || !pb) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  const sa = pa[4] ?? '';
  const sb = pb[4] ?? '';
  if (sa === sb) return 0;
  if (!sa) return 1;   // 1.0.0 > 1.0.0-alpha
  if (!sb) return -1;
  return sa < sb ? -1 : 1;
}

// Deliberately false when either version is unparsable: an upgrade is a real
// mutation of the user's machine, and "I couldn't read one of the numbers" is
// not a reason to run an installer. Also false when the node is *ahead* of the
// published target (someone installed a newer build by hand) — otherwise that
// machine would sit on 可升级 forever, re-running an installer that correctly
// does nothing.
export function isOutdated(current, latest) {
  return compareVersions(current, latest) === -1;
}

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

// Same-task edit (creator only, daemon lease). A request/response RPC, never
// queued for an offline node: {t:'edit_message',requestId,taskId,sessionId,
// seq,expectedText,text,images,clientMessageId,senderUserId} ->
// {t:'edit_message_result',requestId,ok,error?,resetSeq?,sessionId?}.
// Durable outbox event {k:'messages_reset',targetSeq,sessionId,cwd,
// clientMessageId} deletes the projection at seq >= targetSeq. The outbox
// sequence itself NEVER rewinds. Cloud retains a reset high-water mark so old
// replay cannot resurrect the deleted suffix. Browser notification is only
// {t:'messages_reset',taskId}; discard in-flight history pages and reload.
