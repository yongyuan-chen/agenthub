// SessionManager: owns task lifecycle on this node. Local SQLite is the truth;
// every externally visible change is emitted as an outbox event (via emit()).
import { prepareWorkspace, collectDiff } from './worktree.mjs';
import { MAX_IMPORT_EVENTS } from './sessions.mjs';
import { backendFor, backendByName, DEFAULT_BACKEND } from './backends.mjs';
import { TRANSIENT_ERROR_CODES, codexHomeFor } from './codex-session.mjs';
import { readAutomations, firstRruleMatchIn } from './codex-automations.mjs';
import fs from 'node:fs';
import path from 'node:path';

// Below the ~200k window most Sonnet/Opus-family models share, leaving
// headroom before the hard "prompt too long" wall — see _maybeAutoCompact.
const AUTO_COMPACT_THRESHOLD_TOKENS = 150_000;

// Auto-retry only kicks in for turns that fail this way — a transport/
// upstream-level hiccup, not a real problem with the task itself (missing
// credentials, a bad prompt, a rejected tool call, ...). Those need a human
// to actually look, so they still just land on 'failed' and wait for a
// manual retry. Explicit ask: "以后遇到这种情况,首先重试3次,如若不行,每隔
// 1min重试一次,直到成功,最多重试12小时". Timing itself lives in config.mjs
// (autoRetry*) so tests don't have to wait out real minutes/hours.
const TRANSIENT_ERROR_PATTERN = /connection closed|unexpected eof|upstream stream disconnected|econnreset|epipe|socket hang up|network error|fetch failed|etimedout|eai_again|timed? ?out/i;

// A turn that died because the conversation outgrew the model's context
// window. Retrying as-is can never succeed (same context, same wall), but
// unlike other non-transient failures it has a fully mechanical fix:
// /compact the history, then resend the exact input that failed — see
// _maybeOverflowRecover. Covers Anthropic's canonical strings ("prompt is
// too long: N tokens > M maximum", "input length and `max_tokens` exceed
// context limit") plus common relay rewordings.
const CONTEXT_OVERFLOW_PATTERN = /prompt is too long|input length and .?max_tokens.? exceed|exceeds? (?:the )?(?:model'?s? )?context (?:window|limit|length)|context (?:window|length) (?:limit )?exceeded|maximum context length/i;
// Two shots per failure episode: overflow → compact → resend → overflow
// again means one more compact could still help (the resent turn itself
// grew a lot), but a third identical failure means compaction isn't
// actually reclaiming enough space and a human needs to look. The counter
// resets whenever a turn settles cleanly (see the 'review' branch).
const MAX_OVERFLOW_COMPACT_ATTEMPTS = 2;

// A turn that ended at a *turn cap* rather than at a problem: the CLI reports
// subtype 'error_max_turns' after N agentic round-trips, with the session and
// everything the turn already did still perfectly intact. AgentHub passes no
// --max-turns (see session.mjs's buildClaudeArgs), but a cap can still arrive
// from outside it — a node running older code that did pass one, an agent
// definition's `maxTurns`, a future CLI default. Found live: a task died this
// way 101 turns and $6 into a refactor, and the only offer was a manual retry
// that would have *resent the original prompt* into a half-finished job.
// Recovery is mechanical and cheap: tell it to carry on. Bounded, with the
// counter reset on any clean settle, so an agent that's genuinely spinning
// can't turn this into unbounded spend.
const MAX_TURN_CAP_CONTINUATIONS = 3;
const TURN_CAP_CONTINUE_PROMPT = '（上一轮是被回合数上限截断的,不是出错)请从刚才停下的地方继续,把任务做完。';

// ---- scheduled tasks (.claude/scheduled_tasks.json) ----
// The claude CLI's CronCreate tool persists durable jobs to
// <cwd>/.claude/scheduled_tasks.json, but the CLI only *fires* them from the
// interactive REPL's idle loop — verified directly: a `-p --input-format
// stream-json` process (exactly how AgentHub drives it) sat alive and idle
// across multiple minute boundaries with an every-minute durable job on disk
// and fired nothing. So an agent that says "我设了每小时的汇报 cron" inside
// an AgentHub task is writing a file nothing will ever read. AgentHub's own
// 60s sweeper picks up that exact file instead: when a job comes due and the
// task is idle, the prompt is injected as a normal user turn (same visible
// semantics as the REPL enqueueing it). Entry shape (verified against what
// CronCreate actually writes): {id, cron, prompt, createdAt, recurring?} —
// `recurring: true` present for recurring jobs, absent for one-shots.
const CRON_RECURRING_EXPIRY_MS = 7 * 24 * 3600_000; // mirror the CLI's own 7-day rule
const CRON_MAX_LOOKBACK_MS = 65 * 60_000; // a long-busy task still fires (once) for a missed minute
const CRON_ONESHOT_CATCHUP_MS = 60 * 24 * 3600_000; // how far back a missed one-shot is still worth firing

// One 5-field cron component ("*", "23", "*/5", "8-18/2", "1,15,30").
function cronFieldMatches(field, value, min, max) {
  for (const part of String(field).split(',')) {
    const [range, stepStr] = part.split('/');
    const step = stepStr !== undefined ? parseInt(stepStr, 10) : 1;
    if (!Number.isInteger(step) || step < 1) continue;
    let lo, hi;
    if (range === '*' || range === '') { lo = min; hi = max; }
    else if (range.includes('-')) {
      const [a, b] = range.split('-').map(n => parseInt(n, 10));
      lo = a; hi = b;
    } else {
      lo = parseInt(range, 10);
      hi = stepStr !== undefined ? max : lo; // "5/10" = every 10 starting at 5
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) continue;
    if (value >= lo && value <= hi && (value - lo) % step === 0) return true;
  }
  return false;
}

// Standard cron semantics in this node's local time, including the classic
// quirk: when BOTH day-of-month and day-of-week are restricted, either match
// counts. dow accepts 0 or 7 for Sunday.
export function cronMatchesDate(expr, d) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [m, h, dom, mon, dow] = parts;
  if (!cronFieldMatches(m, d.getMinutes(), 0, 59)) return false;
  if (!cronFieldMatches(h, d.getHours(), 0, 23)) return false;
  if (!cronFieldMatches(mon, d.getMonth() + 1, 1, 12)) return false;
  const domOk = cronFieldMatches(dom, d.getDate(), 1, 31);
  const dowOk = cronFieldMatches(dow, d.getDay(), 0, 7) || (d.getDay() === 0 && cronFieldMatches(dow, 7, 0, 7));
  if (dom === '*') return dowOk;
  if (dow === '*') return domOk;
  return domOk || dowOk;
}

// First minute boundary in (fromMs, toMs] the expression matches, or null.
function firstCronMatchIn(expr, fromMs, toMs) {
  let t = (Math.floor(fromMs / 60_000) + 1) * 60_000;
  for (let i = 0; t <= toMs && i < 120_000; t += 60_000, i++) {
    if (cronMatchesDate(expr, new Date(t))) return t;
  }
  return null;
}

// retry_last_input (and spec) store a plain string for the common
// text-only case, byte-identical to before image attachments existed — only
// JSON-encoded when images are actually attached, so every existing
// plain-text code path is unaffected. decodeInput never throws: a legacy/plain
// value that isn't JSON just comes back as {text: raw, images: []}. spec goes
// through the same encoding when the first message of a new conversation
// carried attachments (start_task.images) — _spawn decodes whichever of
// retry_last_input/spec it ends up sending, so both get images for free.
function encodeInput(text, images) {
  return images?.length ? JSON.stringify({ text, images }) : text;
}
function decodeInput(raw) {
  if (!raw) return { text: raw ?? '', images: [] };
  if (raw[0] === '{') {
    try {
      const parsed = JSON.parse(raw);
      return { text: parsed.text ?? '', images: parsed.images ?? [] };
    } catch { /* not actually JSON — fall through to plain text */ }
  }
  return { text: raw, images: [] };
}

export class SessionManager {
  /**
   * @param {object} config
   * @param {import('./db.mjs').LocalDb} db
   * @param {(taskId:string, seq:number, ev:object) => void} onEvent  notify link that outbox has news
   * @param {(opts:object) => object=} sessionFactory  injectable for tests
   */
  constructor(config, db, onEvent, sessionFactory) {
    this.config = config;
    this.db = db;
    this.onEvent = onEvent;
    // opts.backend names the adapter (see backends.mjs) — resolving the class
    // here rather than at the call site keeps _spawn identical for both.
    this.sessionFactory = sessionFactory ?? ((opts) => new (backendByName(opts.backend).Session)(opts));
    this.sessions = new Map();       // taskId -> live session
    this.pendingDecisions = new Map(); // requestId -> {resolve, timer, taskId}
    this.startQueue = [];            // fresh taskIds waiting for a slot
    this.resumeQueue = [];           // taskIds to resume (daemon restart) waiting for a slot
    this._preparing = 0;             // workspaces being cloned right now
    this._autoRetryTimers = new Map(); // taskId -> setTimeout handle
    this._compactRecoveries = new Map(); // taskId -> overflow-recovery attempts this failure episode
    this._turnCapContinuations = new Map(); // taskId -> turn-cap continuations this episode (see _maybeContinueAfterTurnCap)
    this._cronChecked = new Map();       // `${taskId}:${jobId}` -> last evaluated ms (see _sweepScheduledTasks)
    this._warned = new Set();            // dedupe for once-per-process warnings (see _warnOnce)
    this._idleSweeper = setInterval(() => this._sweepIdle(), 60_000);
    if (this._idleSweeper.unref) this._idleSweeper.unref();
  }

  emit(taskId, ev) {
    ev.ts = ev.ts ?? Date.now();
    const seq = this.db.pushEvent(taskId, ev);
    this.onEvent(taskId, seq, ev);
    return seq;
  }

  setStatus(taskId, status, extra = {}) {
    const lastError = extra.error !== undefined ? extra.error : (extra.clearError ? null : undefined);
    this.db.patchTask(taskId, { status, ...(lastError !== undefined ? { lastError } : {}) });
    this.emit(taskId, { k: 'status', status, extra });
  }

  // Occupied slots = workspaces being prepared + live CLI processes on
  // actively-driven tasks (review sessions idle out via the sweeper and don't
  // hold a slot).
  runningCount() {
    let n = this._preparing;
    for (const [taskId, s] of this.sessions) {
      if (!s.alive) continue;
      const t = this.db.getTask(taskId);
      if (t && ['starting', 'running', 'waiting_human', 'idle'].includes(t.status)) n++;
    }
    return n;
  }

  // Narrower than runningCount(): only true while a turn is actually being
  // generated (or a workspace is being cloned). A task merely parked in
  // waiting_human has its CLI subprocess blocked on stdin with nothing in
  // flight — shutdown() kills it cleanly either way (see below), and
  // recover() resumes it via session_id on next boot, so there's nothing to
  // lose by restarting through it. Used only to gate self-update: found live
  // that a task can sit in waiting_human for hours (a human slow to decide,
  // or simply away), which — back when this shared runningCount() — starved
  // the node of every update for as long as that lasted, since running
  // parallelism accounting (which correctly *does* still count
  // waiting_human/idle as occupying a slot) and update-safety accounting are
  // different questions.
  hasActiveGeneration() {
    if (this._preparing > 0) return true;
    for (const [taskId, s] of this.sessions) {
      if (!s.alive) continue;
      const t = this.db.getTask(taskId);
      if (t && ['starting', 'running'].includes(t.status)) return true;
    }
    return false;
  }

  // ---- commands from cloud ----

  handleCommand(cmd) {
    switch (cmd.t) {
      case 'start_task': return this.startTask(cmd.task);
      case 'user_message': return this.userMessage(cmd.taskId, cmd.text, cmd.images, cmd.clientMessageId);
      case 'decision': return this.decide(cmd.taskId, cmd.requestId, cmd.behavior, cmd.message, cmd.updatedInput);
      case 'cancel': return this.cancel(cmd.taskId);
      case 'lease': return this.setLease(cmd.taskId, cmd.lease);
      case 'config': return this.updateProviderConfig(cmd.provider ?? cmd.anthropic);
      case 'switch_session': return this.switchSession(cmd.taskId, cmd.sessionId);
      case 'retry_task': return this.retryTask(cmd.taskId, cmd.opts || {});
      case 'resync_session': return this.resyncSession(cmd.taskId);
      case 'set_permission_mode': return this.setPermissionMode(cmd.taskId, cmd.permissionMode);
      case 'set_auto_decide_all': return this.setAutoDecideAll(cmd.taskId, cmd.autoDecideAll);
      case 'set_provider_override': return this.setProviderOverride(cmd.taskId, cmd.provider, cmd.backend);
      // Legacy wire name for the same thing, from before model overrides grew
      // a backend to pin (payload under `anthropic`, no backend field). A
      // node updates independently of the cloud, so a new executor talking to
      // a not-yet-redeployed worker must still honour a model switch instead
      // of dropping it — found live as a stream of "[manager] unknown command
      // set_anthropic_override" the moment this node restarted onto new code.
      case 'set_anthropic_override': return this.setProviderOverride(cmd.taskId, cmd.anthropic, cmd.backend);
      default: console.warn('[manager] unknown command', cmd.t);
    }
  }

  // Cloud is authoritative for relay credentials: pushed on every hello_ok
  // and again live whenever the owning user saves Settings. Memory-only —
  // never written back to the local config file — so a restart simply waits
  // for the next hello_ok to repopulate it. Already-running CLI child
  // processes keep their old env until they next respawn.
  updateProviderConfig(provider) {
    if (!provider) return;
    this.config.provider = { ...this.config.provider, ...provider };
    console.log('[manager] model relay config updated from cloud');
  }

  // Attach this task to a different (typically externally-created) session
  // going forward. Stops any live process first — the next message resumes
  // fresh with the new session id via the normal userMessage() path.
  switchSession(taskId, sessionId) {
    const session = this.sessions.get(taskId);
    if (session) { session.kill(); this.sessions.delete(taskId); }
    // `claude --resume` only finds a session from the exact cwd it was
    // created in (verified directly — a cwd mismatch fails with "No
    // conversation found" even though the .jsonl file itself is perfectly
    // readable). Reusing whatever `dir` this task already had — e.g. an
    // isolated worktree from a completely unrelated earlier session — is
    // wrong for a session found externally; that session's own transcript
    // already records its real cwd, so use that instead (found live: a task
    // switched onto an externally-created session kept the old worktree
    // dir, and every turn after the switch failed this exact way).
    const sessionCwd = backendFor(this.db.getTask(taskId)).sessionCwd(this.config, sessionId);
    const patch = { sessionId, realConfigDir: 1 };
    if (sessionCwd && fs.existsSync(sessionCwd)) patch.dir = sessionCwd;
    this.db.patchTask(taskId, patch);
    this.emit(taskId, { k: 'session', sessionId });
    this.emit(taskId, { k: 'msg', role: 'system', content: { text: `已切换到会话 ${sessionId}` } });
    this._importHistory(taskId, sessionId);
  }

  // Best-effort transcript import: replays an external session's history
  // into this task's own message log using the exact same {k:'msg', role,
  // content} shape live conversation events already use, so the existing
  // chat UI renders it with zero new frontend code. Only ever called once
  // per adopted session (new task with a pre-set sessionId, or an explicit
  // switch) — never on a plain resume/reconnect of an already-tracked task.
  // Reads directly from the *original* external file (not AgentHub's own
  // one-time copy — see importExternalSession) since that's the file that
  // keeps growing if the user just keeps using `claude --resume <id>`
  // themselves; also baselines synced_lines here so a later manual resync
  // (see resyncSession below) only picks up what's genuinely new, instead of
  // re-importing everything already shown here.
  _importHistory(taskId, sessionId) {
    const task = this.db.getTask(taskId);
    const tx = backendFor(task);
    const file = tx.externalTranscriptFile(this.config, task, sessionId);
    if (!file) return;
    this.db.patchTask(taskId, { syncedLines: tx.countLines(file) });
    const events = tx.toEvents(file);
    if (!events.length) return;
    this.emit(taskId, { k: 'msg', role: 'system', content: { text: `以下是导入的历史会话(最近 ${events.length} 条)` } });
    for (const ev of events) this.emit(taskId, { k: 'msg', role: ev.role, content: ev.content });
    this.emit(taskId, { k: 'msg', role: 'system', content: { text: '以上是历史记录,以下是新对话' } });
  }

  startTask(task) {
    const existing = this.db.getTask(task.id);
    if (existing) {
      if (existing.status === 'queued') this._maybeStart(task.id);
      else console.warn(`[manager] start_task ignored, task ${task.id} already ${existing.status}`);
      return;
    }
    // A brand-new task created with a pre-set session (resuming an existing
    // external session from the start, not a daemon-restart resume of a
    // task AgentHub already knows about) — import its history exactly once.
    const isNewAdoption = !existing && !!task.sessionId;
    this.db.upsertTask({
      // No hardcoded 'main' fallback — prepareWorkspace() detects the
      // clone's actual default branch when this is left unset.
      // Images attached to the first message ride inside spec via the same
      // encoding retry_last_input uses, so the whole first-send path (and any
      // later retry of it) needs no separate images column — see encodeInput.
      taskId: task.id, title: task.title, spec: encodeInput(task.spec, task.images), status: 'queued',
      repoUrl: task.repoUrl ?? null, baseBranch: task.baseBranch || null,
      permissionMode: task.permissionMode ?? 'acceptEdits', sessionId: task.sessionId ?? null,
      // v1 Worker payloads call this `anthropic`; a checkout node can restart
      // into v2 executor code before that Worker is deployed, so carry either
      // spelling into the unified provider_override column.
      providerOverride: task.provider ?? task.anthropic ?? null, backend: task.backend ?? null,
      // Adopted from an existing external session -> resume it directly
      // against the real ~/.claude location going forward, not an isolated
      // copy — see the real_config_dir column comment in db.mjs.
      realConfigDir: isNewAdoption, sourceCwd: task.sourceCwd ?? null,
    });
    if (isNewAdoption) this._importHistory(task.id, task.sessionId);
    this._maybeStart(task.id);
  }

  async _maybeStart(taskId) {
    if (this.runningCount() >= this.config.maxParallel) {
      if (!this.startQueue.includes(taskId)) this.startQueue.push(taskId);
      return;
    }
    const t = this.db.getTask(taskId);
    if (!t || t.status !== 'queued') return;
    // Captured *before* prepareWorkspace/patchTask below sets t.dir for this
    // call — the one reliable signal that this task has already been spawned
    // at least once before, regardless of whether spec was ever actually
    // cleared. Relying only on "spec gets cleared once sent" (see _spawn)
    // turned out fragile: a task resumed continuously across many daemon
    // restarts without ever going through a fresh _maybeStart/_spawn cycle
    // keeps its original spec sitting in the DB indefinitely — untouched by
    // that clearing logic — so the *first* retry/resume that ever does run
    // it again falls back to spec and resends the long-stale original
    // creation prompt. Found live, again: a task active for days had never
    // re-triggered the clearing path, and a retry replayed its very first
    // message from way back. dir is a strictly more robust "already started"
    // signal since it's set unconditionally on every successful spawn.
    const alreadyStartedBefore = !!t.dir;
    this.setStatus(taskId, 'starting');
    this._preparing++;
    try {
      let dir, branchName;
      if (t.session_id) {
        // Resuming any session (whether adopted at creation time, switched
        // onto mid-lifecycle, or just this task's own first turn having
        // already run once): `claude --resume` requires its actual runtime
        // cwd to match the directory the session was originally created in
        // (verified directly against the real CLI — running --resume from a
        // different directory fails with "No conversation found", even
        // though the .jsonl file itself is reachable). A fresh clone/
        // worktree elsewhere breaks that, so operate directly in the given
        // path instead of the usual isolated-worktree flow — this is the
        // whole point of "resume", not a new task.
        // t.dir (set once prepareWorkspace/switchSession has actually run)
        // is preferred — t.repo_url is only ever populated at creation for
        // the explicit adopt-an-existing-session flow, and stays null
        // forever for an ordinary task. Found live: retrying *any* ordinary
        // task that had already gotten past its first turn (so session_id
        // was already set, same as adoption) always failed immediately with
        // "恢复会话需要一个真实存在的目录:(未提供路径)" — repo_url was never
        // going to be there for a task that was never adopted in the first
        // place; t.dir is what actually holds its real working directory.
        const resumeDir = t.dir || t.repo_url;
        if (!resumeDir || !fs.existsSync(resumeDir)) {
          this.setStatus(taskId, 'failed', { error: `恢复会话需要一个真实存在的目录:${resumeDir || '(未提供路径)'}` });
          return;
        }
        dir = resumeDir;
        branchName = null;
      } else {
        ({ dir, branchName } = await prepareWorkspace(this.config, {
          taskId, repoUrl: t.repo_url, baseBranch: t.base_branch,
        }));
      }
      const cur = this.db.getTask(taskId);
      if (!cur || cur.status !== 'starting') return; // cancelled while cloning
      this.db.patchTask(taskId, { dir, branchName });
      // A task can arrive with a session_id already set (resuming an
      // existing/external session picked at creation time) — only treat it
      // as a brand-new conversation when nothing was pre-set.
      // retry_last_input (whatever hasn't gotten a successful response yet)
      // takes priority over spec (the original creation prompt) — and spec
      // is only ever eligible at all on this task's genuinely first-ever
      // start (see alreadyStartedBefore above). This is what makes both
      // manual and auto-retry actually resend the thing that failed,
      // instead of either silently resuming idle (nothing recorded to
      // resend) or replaying a long-stale original prompt into an
      // established conversation.
      // The (t.spec && !t.session_id) clause: dir alone can lie — a task
      // that failed inside _spawn before ever sending anything (e.g. relay
      // config not pushed yet) already has dir set, so on retry
      // alreadyStartedBefore is true and the original ask was silently never
      // sent (found live: such a task resumed straight to 'idle' and just
      // sat there). spec still being set with no session ever established is
      // proof the first send never actually happened; legacy tasks with a
      // stale uncleared spec all have a session_id, so they stay protected.
      const firstMessage = t.retry_last_input
        || ((!alreadyStartedBefore || (t.spec && !t.session_id)) ? t.spec : null)
        || null;
      this._spawn(taskId, firstMessage, { fresh: !t.session_id, silent: !!t.retry_last_input });
      // Resuming with no first message yet: the CLI is up and idle, just
      // waiting for the user's next message via the normal userMessage()
      // path (which already knows how to (re)spawn on demand). Only flip to
      // 'idle' if _spawn didn't already fail the task out from under us.
      if (!firstMessage) {
        const after = this.db.getTask(taskId);
        if (after && after.status === 'starting') this.setStatus(taskId, 'idle');
      }
    } catch (e) {
      this.setStatus(taskId, 'failed', { error: `workspace: ${e.message}` });
    } finally {
      this._preparing--;
      this._drainQueue();
    }
  }

  _spawn(taskId, firstMessage, { fresh = false, silent = false } = {}) {
    const t = this.db.getTask(taskId);
    // A task pinned to a specific model profile at creation time keeps using
    // it even if the account-wide default changes later; otherwise falls
    // back to the node's shared config exactly as before.
    const override = t.provider_override ? JSON.parse(t.provider_override) : null;
    const effectiveConfig = override ? { ...this.config, provider: override } : this.config;
    if (!effectiveConfig.provider?.baseUrl || !effectiveConfig.provider?.apiKey) {
      this.setStatus(taskId, 'failed', {
        error: '节点尚未收到模型中转站配置 — 请在网页端「设置」里保存 Base URL / API Key 后重试',
      });
      return;
    }
    const resumeSessionId = fresh ? null : (t.session_id || null);
    // Best-effort, idempotent: copies a session that came from outside
    // AgentHub into this node's isolated config home, so the CLI can find it
    // to resume. A no-op for sessions AgentHub created itself, and skipped
    // entirely for real_config_dir tasks — those resume against the real
    // location, and copying would recreate the stale-fork problem that flag
    // exists to avoid. (What "find it" means differs per backend, which is
    // why this lives in the adapter — see backends.mjs.)
    if (resumeSessionId) backendFor(t).prepareResume(this.config, t, resumeSessionId);
    const session = this.sessionFactory({
      backend: backendFor(t).name,
      config: effectiveConfig,
      cwd: t.dir,
      taskId,
      resumeSessionId,
      realConfigDir: !!t.real_config_dir,
      permissionMode: t.permission_mode || 'acceptEdits',
      allowRootBypass: !!t.allow_root_bypass,
      onMessage: (msg) => this._onSdkMessage(taskId, msg),
      onPermission: (req) => this._onPermission(taskId, req),
      onWithdrawPermission: (requestId) => this._withdrawPermission(taskId, requestId),
      onExit: (err) => this._onSessionExit(taskId, err),
    });
    this.sessions.set(taskId, session);
    session.start();
    if (firstMessage) {
      // firstMessage is the raw stored value (plain string, or JSON-encoded
      // {text, images} when the failed/original send carried attachments —
      // see encodeInput/decodeInput) — decode right before use so a retry
      // resends any images too, not just the text.
      const { text: sendText, images: sendImages } = decodeInput(firstMessage);
      // silent (retry/auto-retry resending the same text that just failed)
      // skips the extra 'user' bubble — the original one is already in the
      // log from whenever this was first actually typed; showing another
      // copy would look like the human said it twice. The "正在重试…" /
      // "检测到...自动重试" system messages already say what's happening.
      if (!silent) this.emit(taskId, { k: 'msg', role: 'user', content: { text: sendText, ...(sendImages.length ? { images: sendImages } : {}) } });
      session.send(sendText, sendImages);
      this.setStatus(taskId, 'running');
      // Once sent, spec has done its one job — clearing it here (not just
      // wherever it's read) is what makes retryTask() safe regardless of
      // which of its callers reach _spawn. Found live: retrying a task that
      // had failed deep into an ongoing conversation resent the *original*
      // creation prompt into the resumed session — _maybeStart() always
      // passed t.spec as firstMessage on every 'queued'->'starting'
      // transition, including a retry, with nothing distinguishing "never
      // started yet" from "started long ago, just failed mid-conversation."
      // A task that fails *before* ever reaching this point (e.g. no relay
      // config yet) never clears spec, so retrying it still sends the
      // original ask exactly as before — only a task that actually already
      // consumed its first message stops resending it.
      // retry_last_input tracks this exact text until it either succeeds
      // (cleared) or needs resending again on the next retry — see
      // _maybeStart's firstMessage selection and _scheduleAutoRetry.
      this.db.patchTask(taskId, { spec: '', retryLastInput: firstMessage });
    }
  }

  _onSdkMessage(taskId, msg) {
    const t = this.db.getTask(taskId);
    if (!t) return;
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          if (msg.session_id && msg.session_id !== t.session_id) {
            this.db.patchTask(taskId, { sessionId: msg.session_id });
            this.emit(taskId, { k: 'session', sessionId: msg.session_id });
          }
        } else if (msg.subtype === 'compacted') {
          // History was just summarized away, so the stored context estimate
          // is now far too high. Left stale it would re-trigger auto-compact
          // on the very next turn, before any fresh usage reading lands.
          this.db.patchTask(taskId, { contextTokens: null });
          this.emit(taskId, { k: 'msg', role: 'system', content: { text: '历史已压缩。' } });
        }
        break;
      case 'assistant': {
        for (const block of msg.message?.content ?? []) {
          if (block.type === 'text') {
            this.emit(taskId, { k: 'msg', role: 'assistant', content: { text: block.text } });
          } else if (block.type === 'tool_use') {
            this.emit(taskId, { k: 'msg', role: 'tool_use', content: { id: block.id, name: block.name, input: block.input } });
          } else if (block.type === 'thinking' && block.thinking) {
            this.emit(taskId, { k: 'msg', role: 'thinking', content: { text: block.thinking } });
          }
        }
        // Best-effort live signal — works when talking directly to the
        // Anthropic API, but some ANTHROPIC_BASE_URL relays report all-zero
        // usage on every streamed message (verified directly). The 'result'
        // handler below re-reads the authoritative number from disk at
        // turn-end regardless, so this is just a same-turn head start.
        const usage = msg.message?.usage;
        if (usage) {
          const contextTokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
          if (contextTokens > 0) {
            // Real streamed usage means the CLI's own (usage-gated, mid-turn
            // capable) auto-compact is functional for this process — record
            // that so _maybeAutoCompact can stand down; see its comment.
            const session = this.sessions.get(taskId);
            if (session) session.streamedUsageSeen = true;
            this.db.patchTask(taskId, { contextTokens });
            this.emit(taskId, { k: 'usage', contextTokens });
          }
        }
        break;
      }
      case 'user': {
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result') {
              this.emit(taskId, {
                k: 'msg', role: 'tool_result',
                content: { tool_use_id: block.tool_use_id, is_error: block.is_error ?? false, content: block.content },
              });
            }
          }
        }
        break;
      }
      case 'result': {
        // total_cost_usd is cumulative per CLI process; add only the delta.
        // A negative delta means a fresh process (counter reset) — take it whole.
        const session = this.sessions.get(taskId);
        // Whatever turn just finished (including a compact one we kicked off
        // ourselves) is done — clear the in-flight guard so a future result
        // can trigger auto-compact again if it's still needed.
        if (session) session.autoCompacting = false;
        // Codex reports token usage but never a dollar amount, so a running
        // "$0.00" on the Info tab would be an outright lie — skip cost
        // accounting for backends that don't report it (caps.reportsCost).
        const reportsCost = session?.caps?.reportsCost !== false;
        let delta = 0, cost = t.cost_usd ?? 0;
        if (reportsCost) {
          const reported = msg.total_cost_usd ?? 0;
          const prevReported = session?.lastReportedCost ?? 0;
          delta = reported >= prevReported ? reported - prevReported : reported;
          if (session) session.lastReportedCost = reported;
          cost += delta;
          this.db.patchTask(taskId, { costUsd: cost });
        }
        // Re-read from disk as the authoritative source (see lastAssistantUsage's
        // comment) — the live per-message value above can't be trusted alone.
        // real_config_dir tasks resume against the real file directly, not
        // the isolated copy — read usage from wherever they actually live.
        const tx = backendFor(t);
        const usageFile = tx.transcriptFile(this.config, t);
        if (usageFile) {
          const usage = tx.usageOf(usageFile);
          if (usage?.contextTokens) {
            this.db.patchTask(taskId, { contextTokens: usage.contextTokens });
            this.emit(taskId, { k: 'usage', contextTokens: usage.contextTokens });
          }
          // The rollout records the model's real window; keeping it on the
          // session is what lets _maybeAutoCompact use the actual limit
          // instead of a hardcoded constant.
          if (usage?.contextWindow && session?.caps) session.caps.contextWindow = usage.contextWindow;
        }
        this.emit(taskId, {
          k: 'msg', role: 'result',
          content: {
            subtype: msg.subtype, duration_ms: msg.duration_ms, num_turns: msg.num_turns,
            ...(reportsCost ? { turn_cost_usd: delta, total_cost_usd: cost } : {}),
            is_error: msg.is_error ?? false,
          },
        });
        if (reportsCost) this.emit(taskId, { k: 'cost', costUsd: cost });
        const cur = this.db.getTask(taskId);
        // Normally only 'running' (a message was actually sent and we're
        // waiting on that turn) — but a resumed session left 'idle' with
        // nothing sent yet can *still* emit an unprompted error result if
        // the CLI itself chokes resuming (observed directly: --resume can
        // fail internally before ever receiving a turn). Without idle/
        // starting included here, that failure had nowhere to go — the task
        // just sat at 'idle' looking fine while actually being dead.
        // "This turn isn't over yet" — a recovery (compact, resend, or a
        // turn-cap continuation) took the wheel, so the task must not settle
        // at 'review' and its session must stay alive below.
        let continuing = false;
        if (['running', 'idle', 'starting'].includes(cur.status)) {
          if (msg.is_error || msg.subtype !== 'success') {
            // msg.result is often empty for internal failures (e.g. subtype
            // "error_during_execution" with no detail) — the CLI's own
            // stderr is the only place with anything more specific in that
            // case, so fall back to it instead of showing just the bare
            // subtype with no way to tell what actually went wrong.
            const detail = msg.result || session?.recentStderr() || '';
            const label = msg.subtype || 'agent error';
            const errorText = detail ? `${label}: ${detail}`.slice(0, 800) : label;
            // Context-overflow deaths get their own mechanical recovery
            // (compact then resend — retrying as-is can never succeed);
            // everything else keeps the failed + transient-auto-retry path.
            if (this._maybeOverflowRecover(taskId, errorText, msg.error_code)) {
              continuing = true;
            } else if (msg.subtype === 'error_max_turns' && this._maybeContinueAfterTurnCap(taskId)) {
              continuing = true;
            } else {
              this.setStatus(taskId, 'failed', { error: errorText });
              this._scheduleAutoRetry(taskId, errorText, msg.error_code);
            }
          } else if (session?.pendingResendAfterCompact) {
            // The turn that just succeeded was an overflow-recovery /compact
            // (see _maybeOverflowRecover) — now resend the exact input whose
            // turn died on the context wall. Silent on purpose: its user
            // bubble is already in the log from the original send. Not
            // cleared from retry_last_input here — that only clears on this
            // resent turn's own clean settle, same as any retry.
            const raw = session.pendingResendAfterCompact;
            session.pendingResendAfterCompact = null;
            const { text: rText, images: rImages } = decodeInput(raw);
            this.emit(taskId, { k: 'msg', role: 'system', content: { text: '压缩完成,自动重发被中断的输入继续任务…' } });
            session.send(rText, rImages);
            this.setStatus(taskId, 'running');
            continuing = true; // keep the session alive (real_config_dir would otherwise kill it below)
          } else if (this._maybeAutoCompact(taskId, session)) {
            // Compaction turn kicked off instead of settling at 'review' —
            // its own 'result' will re-enter this handler and finish normally.
            continuing = true;
          } else {
            this._publishDiff(taskId);
            // A turn that completes cleanly resolves any prior failure —
            // otherwise the Info tab keeps showing a stale "最近错误" forever
            // even after the task has been retried/resumed successfully.
            this.setStatus(taskId, 'review', { clearError: true });
            this._cancelAutoRetry(taskId);
            this._compactRecoveries.delete(taskId);
            this._turnCapContinuations.delete(taskId);
          }
        }
        // The turn that just finished already wrote everything emitted above
        // into this same real transcript file (real_config_dir tasks resume
        // directly against ~/.claude, not an isolated copy — see usageFile
        // above). Bump synced_lines to match right now, or the next
        // _sweepExternalGrowth() pass (runs every ~60s) / userMessage()'s
        // pre-send check sees that growth as "new" content from outside
        // AgentHub and re-imports (and re-displays) the very messages just
        // streamed live. Found live: every real_config_dir turn was getting
        // duplicated within a minute — reported as "发了一次继续,看到了两个继续".
        if (t.real_config_dir && usageFile) {
          this.db.patchTask(taskId, { syncedLines: tx.countLines(usageFile) });
        }
        // real_config_dir tasks never keep a session warm between turns —
        // unlike the isolated-copy model, the real ~/.claude file can also
        // be opened by VS Code/terminal at any moment, and a lingering child
        // process here is exactly the concurrent-writer risk this whole
        // mechanism exists to avoid. Costs a fresh --resume startup on the
        // next message; buys correctness. (Not a full guarantee — it can't
        // stop the user from having a live VS Code window open at the same
        // literal instant, which is an inherent `claude --resume` limitation
        // with or without AgentHub.)
        if (t.real_config_dir && !continuing && session) {
          session.kill();
          this.sessions.delete(taskId);
        }
        this._drainQueue();
        break;
      }
      default: break;
    }
  }

  // Compact the conversation before it hits the model's hard context wall.
  // This exists because some relays report all-zero usage on every streamed
  // message (see lastAssistantUsage's comment) — the claude CLI's own
  // built-in auto-compact is gated on that same (broken, for such a relay)
  // signal, so it never fires and a long-running session eventually dies on
  // a "prompt too long" API error with no warning. AgentHub compensates by
  // tracking context size itself from the on-disk transcript and compacting
  // once it gets large, so a relayed session behaves like a direct-API one
  // instead of requiring the user to start a fresh conversation.
  // How the compaction is actually performed is the session's business (see
  // ClaudeSession.compact / CodexSession.compact) — one sends the CLI's
  // literal /compact command, the other calls a real RPC.
  _maybeAutoCompact(taskId, session) {
    if (!session?.alive || session.autoCompacting) return false;
    // The streamed-usage escape hatch only applies to the claude path: if
    // that CLI process has reported real streamed usage even once (verified
    // live 2026-08 against the current relay: real token counts now come
    // through), its built-in auto-compact — which unlike this turn-end
    // fallback also fires mid-turn — is functional, and doubling up would
    // just burn an extra summarization turn. A backend that reports its own
    // context window has no such built-in fallback to defer to, so this
    // check is deliberately skipped there rather than relying on the
    // ordering accident of whether a usage message happened to arrive first.
    // Per-process on purpose: the flag can't go stale across a model/profile
    // switch, since that always spawns a fresh CLI process.
    const window = session.caps?.contextWindow ?? null;
    if (!window && session.streamedUsageSeen) return false;
    if (session.lastAutoCompactAt && Date.now() - session.lastAutoCompactAt < 60_000) return false;
    // A known window gives a real threshold; without one, fall back to the
    // constant sized for the ~200k window most Sonnet/Opus models share.
    const threshold = window ? Math.floor(window * 0.6) : AUTO_COMPACT_THRESHOLD_TOKENS;
    const t = this.db.getTask(taskId);
    if (!t?.context_tokens || t.context_tokens < threshold) return false;
    session.autoCompacting = true;
    session.lastAutoCompactAt = Date.now();
    this.emit(taskId, {
      k: 'msg', role: 'system',
      content: { text: `上下文已达约 ${t.context_tokens.toLocaleString()} tokens,自动压缩历史以避免中断…` },
    });
    session.compact();
    this.setStatus(taskId, 'running');
    return true;
  }

  // A turn just died on the context wall ("prompt is too long" & friends).
  // Unlike transient failures this can never be retried as-is, but the fix
  // is fully mechanical: /compact the history, and when that compact turn
  // settles (see the pendingResendAfterCompact branch in the 'result'
  // handler) resend the exact input that failed. Returns true when it took
  // over the failure; false means fall through to the normal failed path.
  // errorCode, when present, is the backend's own structured failure reason
  // (codex's CodexErrorInfo enum) — strictly better than guessing from the
  // message text, so it wins outright when the backend supplies one.
  _maybeOverflowRecover(taskId, errorText, errorCode = null) {
    const overflow = errorCode
      ? errorCode === 'contextWindowExceeded'
      : CONTEXT_OVERFLOW_PATTERN.test(errorText);
    if (!overflow) return false;
    const t = this.db.getTask(taskId);
    // Nothing recorded to resend (e.g. the overflow happened on an
    // unprompted resume) — compacting alone would leave the task looking
    // "running" with no turn to continue, so let it fail visibly instead.
    if (!t?.retry_last_input) return false;
    const attempts = this._compactRecoveries.get(taskId) ?? 0;
    if (attempts >= MAX_OVERFLOW_COMPACT_ATTEMPTS) {
      // Compaction isn't reclaiming enough space — give up so the failure
      // is visible, and drop the stale pending resend so a later manual
      // turn's success can't surprise-fire it.
      const s = this.sessions.get(taskId);
      if (s) s.pendingResendAfterCompact = null;
      return false;
    }
    this._compactRecoveries.set(taskId, attempts + 1);
    this.emit(taskId, {
      k: 'msg', role: 'system',
      content: { text: `上下文超出模型上限,自动压缩历史后重发被中断的输入续跑(第 ${attempts + 1}/${MAX_OVERFLOW_COMPACT_ATTEMPTS} 次)…` },
    });
    let session = this.sessions.get(taskId);
    if (!session?.alive) {
      // The CLI process died with the error — bring the session back first
      // (resumed, no first message: retry_last_input must keep pointing at
      // the real input, not at '/compact').
      this._spawn(taskId, null, { fresh: !t.session_id });
      session = this.sessions.get(taskId);
      if (!session) return true; // _spawn already failed the task with its own, more specific error
    }
    session.autoCompacting = true; // reuse the in-flight guard; cleared on its result
    session.lastAutoCompactAt = Date.now();
    session.pendingResendAfterCompact = t.retry_last_input;
    session.compact();
    this.setStatus(taskId, 'running');
    return true;
  }

  // The turn didn't fail — it was cut off at a turn cap, with the session and
  // all the work it already did still intact (see MAX_TURN_CAP_CONTINUATIONS).
  // So: don't fail the task and don't resend the original input (that would
  // restart a half-finished job); just tell it to carry on. Returns true when
  // it took over, false to fall through to the normal failed path.
  _maybeContinueAfterTurnCap(taskId) {
    const attempts = this._turnCapContinuations.get(taskId) ?? 0;
    if (attempts >= MAX_TURN_CAP_CONTINUATIONS) return false;
    let session = this.sessions.get(taskId);
    if (!session?.alive) {
      // Resumed with no first message: retry_last_input must keep pointing at
      // the real input, not at the continuation nudge.
      const t = this.db.getTask(taskId);
      this._spawn(taskId, null, { fresh: !t?.session_id });
      session = this.sessions.get(taskId);
      if (!session) return true; // _spawn already failed the task with its own, more specific error
    }
    this._turnCapContinuations.set(taskId, attempts + 1);
    this.emit(taskId, {
      k: 'msg', role: 'system',
      content: { text: `本轮被 CLI 的回合数上限截断(不是出错),自动让它接着做完(第 ${attempts + 1}/${MAX_TURN_CAP_CONTINUATIONS} 次)…` },
    });
    session.send(TURN_CAP_CONTINUE_PROMPT);
    this.setStatus(taskId, 'running');
    return true;
  }

  _publishDiff(taskId) {
    const t = this.db.getTask(taskId);
    try {
      const { stat, patch } = collectDiff(t);
      if (stat || patch) this.emit(taskId, { k: 'msg', role: 'diff', content: { stat, patch } });
    } catch (e) {
      console.warn('[manager] diff failed:', e.message);
    }
  }

  async _onPermission(taskId, req) {
    const t = this.db.getTask(taskId);
    if (!t) return { behavior: 'deny', message: 'task not found' };
    // Explicit, separately-confirmed opt-in (see setAutoDecideAll above) —
    // skip the human entirely, including for requests claude CLI itself
    // forces regardless of permission_mode (e.g. rm-pattern commands). Never
    // creates a pendingRequest/waiting_human state at all — the whole point
    // is this shouldn't surface as a card to approve, just a visible log
    // entry of what got auto-approved and why.
    // AskUserQuestion is deliberately excluded: it isn't a yes/no permission
    // gate at all, it's Claude asking for actual substantive input (which
    // option, what value) — auto-"allow"ing it with no real answers doesn't
    // approve anything, it just fabricates an empty choice on the user's
    // behalf. Found live: a user who'd turned this on for Bash/Edit-style
    // requests was surprised to see an AskUserQuestion silently
    // auto-approved too — "自动授权所有请求" meant permission requests, not
    // this. Falls through to the normal waiting_human card below instead.
    if (t.auto_decide_all && req.toolName !== 'AskUserQuestion') {
      this.emit(taskId, {
        k: 'msg', role: 'system',
        content: { text: `已自动批准(该对话已开启"自动授权所有请求"):${req.toolName}` },
      });
      return { behavior: 'allow' };
    }
    const pending = { requestId: req.requestId, toolName: req.toolName, input: req.input, description: req.description };
    this.db.patchTask(taskId, { pendingRequest: JSON.stringify(pending) });
    this.emit(taskId, { k: 'msg', role: 'perm_request', content: pending });
    this.setStatus(taskId, 'waiting_human', { pendingRequest: pending });

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingDecisions.delete(req.requestId);
        resolve({ behavior: 'deny', message: 'approval timed out' });
        // The decision is already made (denied) — staying in 'waiting_human'
        // here previously left the UI showing "still waiting on you" for a
        // request that's actually already resolved, with no live action
        // left to take. 'review' matches how a restart-cleared pending
        // request is already handled elsewhere (see recover()) and is
        // accurate: nothing is pending, but the turn's outcome is worth a look.
        this.db.patchTask(taskId, { pendingRequest: null });
        this.emit(taskId, { k: 'msg', role: 'system', content: { text: `审批超时,已自动拒绝:${req.toolName}` } });
        this.setStatus(taskId, 'review', { clearPending: true });
      }, this.config.decisionTimeoutMs);
      this.pendingDecisions.set(req.requestId, {
        taskId, timer,
        resolve: (decision) => {
          clearTimeout(timer);
          this.pendingDecisions.delete(req.requestId);
          this.db.patchTask(taskId, { pendingRequest: null });
          this.setStatus(taskId, 'running', { clearPending: true });
          resolve(decision);
        },
      });
    });
  }

  // updatedInput flows straight through to session.mjs's `onPermission`
  // resolution — session.mjs already does `updatedInput: decision.updatedInput
  // ?? req.input`, so this is the only wiring needed for callers (e.g.
  // AskUserQuestion's answer-carrying 'allow') to actually reach the CLI.
  decide(taskId, requestId, behavior, message, updatedInput) {
    const pending = this.pendingDecisions.get(requestId);
    if (!pending) {
      this.emit(taskId, { k: 'msg', role: 'system', content: { text: `该审批请求已失效(超时或任务已重启),操作未生效。` } });
      return;
    }
    this.emit(taskId, { k: 'msg', role: 'system', content: { text: behavior === 'allow' ? '✅ 已批准' : '⛔ 已拒绝' } });
    pending.resolve({ behavior, message, updatedInput });
  }

  // The *backend* withdrew an approval it had asked for (codex sends
  // serverRequest/resolved after e.g. turn/interrupt). Nobody is listening for
  // an answer anymore, so resolve it locally and take the card down — left
  // alone the task would sit in 'waiting_human' showing a button that does
  // nothing until decisionTimeoutMs (4h by default) finally expires it.
  // The claude path has no equivalent signal and never calls this.
  _withdrawPermission(taskId, requestId) {
    const pending = this.pendingDecisions.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    // Dropped rather than resolved: the session already raced this promise
    // away on its own side (see codex-session's _openApprovals), so nothing
    // awaits it, and pending.resolve would flip the task back to 'running' —
    // exactly the wrong status for a turn that just got interrupted.
    this.pendingDecisions.delete(requestId);
    this.db.patchTask(taskId, { pendingRequest: null });
    this.emit(taskId, { k: 'msg', role: 'system', content: { text: '该审批请求已被 agent 撤回(通常是这一轮被中断了)。' } });
    this.setStatus(taskId, 'review', { clearPending: true });
  }

  userMessage(taskId, text, images = [], clientMessageId = null) {
    const t = this.db.getTask(taskId);
    if (!t) return console.warn('[manager] user_message for unknown task', taskId);
    // The cloud keeps redelivering a send until this node echoes it back as a
    // user event (see hub-core's outbound_messages), so the same message
    // legitimately arrives more than once whenever an ack was lost, a socket
    // was half-open, or the daemon restarted mid-flight. Running it twice
    // would spend real relay tokens on a duplicate turn, so the id is the
    // dedupe key: already recorded here -> re-assert the original event the
    // cloud is still waiting on instead of starting a second turn.
    const known = clientMessageId ? this.db.findClientMessage(taskId, clientMessageId) : null;
    if (known) {
      this.onEvent(taskId, known.seq, JSON.parse(known.payload));
      return;
    }
    // Recording what the human typed is unconditional, and happens before any
    // reason we might not act on it. Every early return below used to drop
    // the text on the floor with only a system note left behind — the same
    // "我发的消息不见了" failure as a lost delivery, just from a different
    // direction. The bubble also carries the id, which is what tells the
    // cloud this exact send has landed.
    const record = () => this.emit(taskId, {
      k: 'msg', role: 'user',
      content: { text, ...(images.length ? { images } : {}), ...(clientMessageId ? { clientMessageId } : {}) },
    });
    if (t.lease !== 'daemon') {
      record();
      this.emit(taskId, { k: 'msg', role: 'system', content: { text: '任务当前由 IDE 接管,这条消息已记录但没有发给 agent。归还给看板后可以重发。' } });
      return;
    }
    // A live permission/plan decision is a *separate* channel from plain
    // messages (control_request/can_use_tool vs. a stream-json user turn) —
    // sending a plain message here doesn't cancel or answer it, it just gets
    // queued behind the CLI's still-blocked turn while AgentHub's own status
    // flips to 'running' as if the message had been handled normally. Found
    // live: a user on mobile couldn't see the decision card (a separate,
    // now-fixed rendering bug), typed "继续" as a plain message instead, and
    // the task silently got stuck — status said 'running' but nothing ever
    // happened again, with no UI path left to actually decide. Refuse
    // instead, with an explicit pointer back to the real decision.
    if (t.status === 'waiting_human' && t.pending_request) {
      record();
      this.emit(taskId, {
        k: 'msg', role: 'system',
        content: { text: '有一个权限请求正在等待你决策,上面这条消息已记录但还没发给 agent — 请先在请求卡片里选择允许/拒绝,再重发。' },
      });
      return;
    }
    let session = this.sessions.get(taskId);
    if (!session || !session.alive) {
      // Pull in anything the user typed directly in VS Code/terminal since
      // AgentHub last looked, *before* resuming — otherwise this message
      // would land after content AgentHub doesn't know about yet, out of
      // order. Silent when there's nothing new (the common case) so a
      // routine message send doesn't spam a "no new history" note.
      if (t.real_config_dir && t.session_id) this._importExternalDelta(taskId, t, { silent: true });
      this._spawn(taskId, null, { fresh: false });
      session = this.sessions.get(taskId);
      if (!session) {
        // _spawn declined (e.g. no relay credentials yet) and already set the
        // status + a specific error. The text itself must still survive:
        // fixing the config and hitting retry has to find something to resend.
        record();
        this.db.patchTask(taskId, { retryLastInput: encodeInput(text, images) });
        return;
      }
    }
    // The human typing a fresh message supersedes any overflow-recovery
    // resend still pending on this session — without this, that stale input
    // would surprise-fire right after this turn's compact settles.
    session.pendingResendAfterCompact = null;
    this._compactRecoveries.delete(taskId);
    this._turnCapContinuations.delete(taskId);
    record();
    session.send(text, images);
    this.setStatus(taskId, 'running');
    // Same bookkeeping as _spawn's firstMessage send — if *this* turn fails
    // transiently, retry/auto-retry needs to know what to resend (images
    // included, via encodeInput — see its comment above).
    this.db.patchTask(taskId, { retryLastInput: encodeInput(text, images) });
  }

  // "Auto-approve from here on" (see hub-core.mjs's decision route) —
  // deliberately doesn't touch a currently-live session: permission mode is
  // a CLI startup flag baked into the child process at spawn time, not
  // something a running process can be told to change mid-turn. Just
  // updates the local record so the *next* spawn (next message, or the next
  // natural real_config_dir respawn) picks it up — same one-way mechanism
  // retryTask()'s permissionMode option already uses.
  setPermissionMode(taskId, permissionMode) {
    if (!permissionMode) return;
    const t = this.db.getTask(taskId);
    if (!t || t.permission_mode === permissionMode) return;
    this.db.patchTask(taskId, { permissionMode });
  }

  // See hub-core.mjs's decision route + task.jsx's confirm() dialog — a
  // deliberately separate, more consequential opt-in than bypassPermissions:
  // this makes _onPermission() below auto-decide 'allow' for *every* future
  // request on the task, including the ones claude CLI forces regardless of
  // permission_mode. Takes effect immediately, not just on the next
  // spawn — unlike permission_mode this isn't a CLI startup flag, it's
  // checked live on each incoming request.
  setAutoDecideAll(taskId, autoDecideAll) {
    const t = this.db.getTask(taskId);
    if (!t || !!t.auto_decide_all === !!autoDecideAll) return;
    this.db.patchTask(taskId, { autoDecideAll: autoDecideAll ? 1 : 0 });
  }

  // Switch which relay config (model profile) this task's future spawns use
  // — provider is {baseUrl, apiKey, model} or null (revert to the node-
  // shared default). Like permission_mode, this is a spawn-time env on the
  // CLI child: a live in-flight turn keeps its old model; the change takes
  // effect from the next (re)spawn. Also re-asserted from cloud on every
  // reconnect (see cloudlink's hello_ok) — no-op if unchanged, so that
  // self-healing pass stays silent in the steady state.
  //
  // `backend` rides along because a profile now pins the agent CLI too. The
  // cloud refuses cross-backend switches on a task that already has a session
  // (a claude session id means nothing to `codex resume`); this assert is the
  // local backstop for that, not an alternative to it.
  setProviderOverride(taskId, provider, backend = null) {
    const t = this.db.getTask(taskId);
    if (!t) return;
    const nextBackend = backend ?? t.backend ?? null;
    if (t.session_id && (nextBackend ?? DEFAULT_BACKEND) !== (t.backend ?? DEFAULT_BACKEND)) {
      this.emit(taskId, {
        k: 'msg', role: 'system',
        content: { text: `无法把已有会话切换到另一种 agent(${t.backend ?? DEFAULT_BACKEND} → ${nextBackend}):会话 ID 不通用。请新建一张卡。` },
      });
      return;
    }
    const next = provider ? JSON.stringify(provider) : null;
    if ((t.provider_override ?? null) === next && (t.backend ?? null) === nextBackend) return;
    this.db.patchTask(taskId, { providerOverride: next, backend: nextBackend });
    // real_config_dir tasks kill their session after every turn anyway; for
    // the isolated-copy model a warm idle session would otherwise keep the
    // old env alive indefinitely — kill it now (between turns only; an
    // actively-generating session is left to finish its turn on the old
    // model) so the next message actually picks the new config up.
    const session = this.sessions.get(taskId);
    if (session?.alive && !session.busy) {
      session.kill();
      this.sessions.delete(taskId);
    }
    this.emit(taskId, {
      k: 'msg', role: 'system',
      content: { text: provider ? `已切换模型:${provider.model || provider.baseUrl}(下一轮生效)` : '已切换回默认模型配置(下一轮生效)' },
    });
  }

  cancel(taskId) {
    const session = this.sessions.get(taskId);
    if (session) { session.kill(); this.sessions.delete(taskId); }
    for (const [rid, p] of this.pendingDecisions) {
      if (p.taskId === taskId) { clearTimeout(p.timer); this.pendingDecisions.delete(rid); }
    }
    this.db.patchTask(taskId, { pendingRequest: null });
    this.setStatus(taskId, 'cancelled', { clearPending: true });
    this._drainQueue();
  }

  // Manual alternative to just sending a message (which already respawns a
  // failed session on its own — see userMessage()): useful when there's
  // nothing new to say yet, just a stuck session to clear. Reset to 'queued'
  // and re-run the normal start path: for a task with a spec that never got
  // anywhere, this genuinely tries again from scratch; for a resumed
  // session created with no first message (spec == ''), nothing gets
  // resent — it just re-attempts the resume (picking up any fix that's
  // landed since, e.g. the resume-directory correction) and lands back in
  // 'idle', ready for the next message.
  retryTask(taskId, opts = {}) {
    const t = this.db.getTask(taskId);
    if (!t || t.status !== 'failed') return;
    // A failed task can still have a live (if broken/unresponsive) session
    // lingering in memory from the attempt that failed — _spawn() below is
    // about to overwrite this.sessions' entry for taskId regardless, which
    // would otherwise orphan that process instead of actually killing it.
    const session = this.sessions.get(taskId);
    if (session) { session.kill(); this.sessions.delete(taskId); }
    const patch = { status: 'queued', lastError: null };
    // Two explicit, user-chosen recovery paths for the "bypassPermissions
    // refused as root" failure (see hub-core.mjs's retry route) — never
    // applied unless the user picked one on the failed task's review-bar.
    if (opts.permissionMode) patch.permissionMode = opts.permissionMode;
    if (opts.allowRootBypass) patch.allowRootBypass = 1;
    this.db.patchTask(taskId, patch);
    this.emit(taskId, { k: 'status', status: 'queued', extra: { clearError: true } });
    this.emit(taskId, { k: 'msg', role: 'system', content: { text: '正在重试…' } });
    this._maybeStart(taskId);
  }

  // Auto-retry for turns that fail on a transient upstream/connection error
  // (see TRANSIENT_ERROR_PATTERN) — 3 quick attempts, then every 60s, up to
  // 12h total since the *first* failure in the streak. Never touches a
  // failure that doesn't match the pattern (missing credentials, a bad
  // workspace path, ...) — those need a human, so they still just sit at
  // 'failed' waiting for the manual retry button, same as before this existed.
  // errorCode, when the backend supplies one, replaces the regex entirely:
  // codex's error notifications carry a CodexErrorInfo enum variant, which
  // says "transient" far more reliably than pattern-matching prose ever can.
  _scheduleAutoRetry(taskId, errorText, errorCode = null) {
    const transient = errorCode
      ? TRANSIENT_ERROR_CODES.has(errorCode)
      : TRANSIENT_ERROR_PATTERN.test(errorText);
    if (!transient) return;
    const t = this.db.getTask(taskId);
    if (!t) return;
    const now = Date.now();
    const firstFailedAt = t.retry_first_failed_at || now;
    const maxWindowMs = this.config.autoRetryMaxWindowMs ?? 12 * 3600_000;
    if (now - firstFailedAt > maxWindowMs) {
      this.emit(taskId, { k: 'msg', role: 'system', content: { text: '自动重试已持续 12 小时仍未成功,已停止自动重试 — 可以手动点重试,或先看看问题是不是变了。' } });
      return;
    }
    const attempt = (t.retry_attempt || 0) + 1;
    this.db.patchTask(taskId, { retryAttempt: attempt, retryFirstFailedAt: firstFailedAt });
    const fastDelays = this.config.autoRetryFastDelaysMs ?? [5_000, 15_000, 30_000];
    const slowDelay = this.config.autoRetrySlowDelayMs ?? 60_000;
    const delay = attempt <= fastDelays.length ? fastDelays[attempt - 1] : slowDelay;
    this.emit(taskId, {
      k: 'msg', role: 'system',
      content: { text: `检测到疑似网络/上游连接问题,${Math.round(delay / 1000)} 秒后自动重试(第 ${attempt} 次)…` },
    });
    const timer = setTimeout(() => {
      this._autoRetryTimers.delete(taskId);
      // Re-check right before firing — the user may have already retried
      // manually, sent a message, or cancelled in the meantime, any of
      // which moves status off 'failed' and supersedes this timer.
      const cur = this.db.getTask(taskId);
      if (!cur || cur.status !== 'failed' || cur.retry_attempt !== attempt) return;
      this.retryTask(taskId);
    }, delay);
    if (timer.unref) timer.unref();
    this._autoRetryTimers.set(taskId, timer);
  }

  _cancelAutoRetry(taskId) {
    const timer = this._autoRetryTimers.get(taskId);
    if (timer) { clearTimeout(timer); this._autoRetryTimers.delete(taskId); }
    this.db.patchTask(taskId, { retryAttempt: 0, retryFirstFailedAt: null, retryLastInput: null });
  }

  setLease(taskId, lease) {
    const t = this.db.getTask(taskId);
    const tx = backendFor(t);
    const wasHuman = t?.lease === 'human';
    const session = this.sessions.get(taskId);
    if (lease === 'human' && session?.alive) {
      // Let the CLI finish writing the session file, then release it to the IDE.
      session.kill();
      this.sessions.delete(taskId);
    }
    if (lease === 'human' && t?.session_id && t?.dir) {
      // Baseline "what AgentHub already has" right as control hands off —
      // whatever the IDE's own `claude --resume` appends to this same
      // transcript file from here on is exactly what a later return needs
      // to catch up on. real_config_dir tasks track the real file already
      // (see userMessage()'s auto-import) — nothing extra to baseline here.
      if (!t.real_config_dir) {
        const file = tx.transcriptFile(this.config, t);
        if (file) this.db.patchTask(taskId, { syncedLines: tx.countLines(file) });
      }
    } else if (lease === 'daemon' && wasHuman && t?.session_id && t?.dir) {
      this._resyncFromIde(taskId, t);
    }
    this.db.patchTask(taskId, { lease });
    this.emit(taskId, { k: 'status', status: this.db.getTask(taskId).status, extra: { lease } });
    // The takeover command is backend-specific and, for codex, contains this
    // node's CODEX_HOME — a path the browser has no way to know. Emitting it
    // from here is the only place it can come from.
    const hint = lease === 'human' && t?.session_id ? `\n在你的终端里运行:${tx.resumeCommand(this.config, t)}` : '';
    this.emit(taskId, {
      k: 'msg', role: 'system',
      content: { text: (lease === 'human' ? 'IDE 接管开始,看板暂停驱动此会话。' : 'IDE 接管结束,看板恢复控制。') + hint },
    });
  }

  // AgentHub's own driving of a session and someone running `claude --resume`
  // by hand in an IDE both write to the *same* transcript file (same isolated
  // CLAUDE_CONFIG_DIR + cwd — see session.mjs) — but AgentHub only ever
  // learns about messages from its own spawned process's stdout stream, so
  // whatever happened during an IDE takeover was previously just invisible
  // once control came back. This replays the delta using the exact same
  // {k:'msg', role, content} shape live events already use, same as the
  // external-session-adoption import — no new frontend rendering needed.
  _resyncFromIde(taskId, t) {
    // real_config_dir tasks were never leased against the isolated copy in
    // the first place (see setLease's baseline branch above) — the generic
    // external-delta import already reads the right (real) file for them.
    if (t.real_config_dir) return this._importExternalDelta(taskId, t);
    const tx = backendFor(t);
    const file = tx.transcriptFile(this.config, t);
    if (!file) return;
    const { events, totalLines } = tx.eventsSince(file, t.synced_lines || 0);
    if (!events.length) { this.db.patchTask(taskId, { syncedLines: totalLines }); return; }
    // Cap like a normal import — an IDE session left open a long time could
    // still produce a large delta, and replaying thousands of events as one
    // synchronous loop blocks the event loop long enough to look like a dead
    // connection (observed directly: heartbeats stop going out, the node
    // reads as offline mid-resync).
    const capped = events.length > MAX_IMPORT_EVENTS ? events.slice(events.length - MAX_IMPORT_EVENTS) : events;
    const truncated = capped.length < events.length;
    this.emit(taskId, { k: 'msg', role: 'system', content: { text: `以下是在 IDE 中产生的新消息(${events.length} 条${truncated ? `,仅显示最近 ${capped.length} 条` : ''})` } });
    for (const ev of capped) this.emit(taskId, { k: 'msg', role: ev.role, content: ev.content });
    this.emit(taskId, { k: 'msg', role: 'system', content: { text: '以上是 IDE 中的新消息,以下恢复看板驱动' } });
    // Only mark caught-up once every event has actually been queued for local
    // delivery (emit -> pushEvent is a synchronous local DB write) — if the
    // process dies mid-loop, synced_lines must NOT have already advanced, or
    // a retry would silently skip content that was never actually shown.
    this.db.patchTask(taskId, { syncedLines: totalLines });
  }

  // Shared core for both the manual "刷新历史" button (resyncSession, always
  // noisy) and the automatic pre-send check for real_config_dir tasks
  // (userMessage, silent when there's nothing new) — imports whatever's
  // grown in the real external file since synced_lines into the message log.
  // That original file (found the same way _importHistory found it at
  // adoption time) is the only place ongoing growth outside AgentHub shows
  // up.
  _importExternalDelta(taskId, t, { silent = false } = {}) {
    const tx = backendFor(t);
    const file = tx.externalTranscriptFile(this.config, t);
    if (!file) return;
    const { events, totalLines } = tx.eventsSince(file, t.synced_lines || 0);
    if (!events.length) {
      this.db.patchTask(taskId, { syncedLines: totalLines });
      if (!silent) this.emit(taskId, { k: 'msg', role: 'system', content: { text: '没有发现新的历史记录。' } });
      return;
    }
    // Cap like a normal import — a session that was never baselined (or was
    // kept alive for hours outside AgentHub) can have thousands of lines of
    // backlog; replaying all of it as one synchronous emit loop blocks the
    // event loop long enough that heartbeats stop going out and the node
    // reads as offline mid-resync (observed directly, not theoretical).
    const capped = events.length > MAX_IMPORT_EVENTS ? events.slice(events.length - MAX_IMPORT_EVENTS) : events;
    const truncated = capped.length < events.length;
    this.emit(taskId, { k: 'msg', role: 'system', content: { text: `发现 ${events.length} 条新的历史记录${truncated ? `(仅显示最近 ${capped.length} 条)` : ''}:` } });
    for (const ev of capped) this.emit(taskId, { k: 'msg', role: ev.role, content: ev.content });
    // Only mark caught-up once every event has actually been queued for local
    // delivery (emit -> pushEvent is a synchronous local DB write) — if the
    // process dies mid-loop, synced_lines must NOT have already advanced, or
    // a retry would silently skip content that was never actually shown.
    this.db.patchTask(taskId, { syncedLines: totalLines });
  }

  // Manual "refresh history" — kept as an explicit fallback/status check.
  // For real_config_dir tasks this is now redundant with userMessage()'s
  // automatic pre-send check, but harmless to still offer. Only valid while
  // 'idle' — a task AgentHub is actively driving already has a live,
  // authoritative event stream, and resyncing on top of that risks
  // duplicating or racing against what's about to arrive for real.
  resyncSession(taskId) {
    const t = this.db.getTask(taskId);
    if (!t || t.status !== 'idle' || !t.session_id) return;
    this._importExternalDelta(taskId, t);
  }

  _onSessionExit(taskId, err) {
    this.sessions.delete(taskId);
    const t = this.db.getTask(taskId);
    if (!t) return;
    if (err && ['starting', 'running', 'waiting_human', 'idle'].includes(t.status)) {
      this.db.patchTask(taskId, { pendingRequest: null });
      this.setStatus(taskId, 'failed', { error: err.message.slice(0, 800), clearPending: true });
    }
    this._drainQueue();
  }

  _sweepIdle() {
    for (const [taskId, session] of this.sessions) {
      const t = this.db.getTask(taskId);
      const idleFor = Date.now() - session.lastActivity;
      if (t && t.status === 'review' && !session.busy && idleFor > this.config.idleSessionTimeoutMs) {
        session.kill();
        this.sessions.delete(taskId);
      }
    }
    this._sweepExternalGrowth();
    this._sweepScheduledTasks();
  }

  // Fire due jobs from each task dir's .claude/scheduled_tasks.json — the
  // file the CLI's CronCreate tool writes but which nothing ever reads in
  // AgentHub's -p stream-json mode (see the CRON_* constants' comment). Only
  // fires while the task is idle (review/idle, daemon-leased, no pending
  // permission), mirroring the interactive REPL's fire-while-idle rule; a
  // minute that comes due mid-generation fires on the first sweep after the
  // turn settles (lookback capped at CRON_MAX_LOOKBACK_MS, one fire per job).
  //
  // Both backends have a schedule store the agent process itself never fires,
  // but they are *not* interchangeable: .claude/scheduled_tasks.json lives in
  // the task's working directory, so a codex task that happens to run in a
  // directory a claude task used before would otherwise inherit cron prompts
  // that were never written for it (and vice versa). Dispatching on the
  // task's own backend is what keeps each one reading only its own store.
  _sweepScheduledTasks() {
    const now = Date.now();
    for (const t of this.db.allTasks()) {
      if (!t.dir || t.lease !== 'daemon') continue;
      if (!['review', 'idle'].includes(t.status)) continue;
      if (backendFor(t).name === 'codex') this._sweepCodexAutomations(t, now);
      else this._sweepClaudeCron(t, now);
    }
  }

  _sweepClaudeCron(t, now) {
    const file = path.join(t.dir, '.claude', 'scheduled_tasks.json');
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; } // absent/corrupt → nothing to do
    const jobs = Array.isArray(data?.tasks) ? data.tasks : [];
    if (!jobs.length) return;
    let fired = false, changed = false;
    const kept = [];
    for (const job of jobs) {
      if (!job?.cron || !job?.prompt) { kept.push(job); continue; }
      const key = `${t.task_id}:${job.id}`;
      // Mirror the CLI's own 7-day cap on recurring jobs — also what stops
      // a forgotten hourly job on an abandoned task from burning relay
      // tokens forever.
      if (job.recurring && job.createdAt && now - job.createdAt > CRON_RECURRING_EXPIRY_MS) {
        changed = true;
        this._cronChecked.delete(key);
        this.emit(t.task_id, { k: 'msg', role: 'system', content: { text: `⏰ 定时任务 ${job.id} 已到 7 天上限,自动删除。` } });
        continue;
      }
      // At most one fire per task per sweep — the injected turn makes the
      // task busy anyway; remaining due jobs fire on later sweeps.
      if (fired) { kept.push(job); continue; }
      const seen = this._cronChecked.get(key) ?? Math.max(now - 90_000, job.createdAt ?? 0);
      const winStart = Math.max(seen, now - CRON_MAX_LOOKBACK_MS);
      let due = firstCronMatchIn(job.cron, winStart, now);
      // A one-shot whose single moment passed while the daemon was down
      // entirely still fires once (the REPL does the same catch-up for
      // missed one-shots) — bounded so an ancient leftover doesn't.
      if (!due && !job.recurring) {
        const born = Math.max(job.createdAt ?? 0, now - CRON_ONESHOT_CATCHUP_MS);
        due = firstCronMatchIn(job.cron, born, winStart);
      }
      this._cronChecked.set(key, now);
      if (!due) { kept.push(job); continue; }
      fired = true;
      if (job.recurring) kept.push(job);
      else { changed = true; this._cronChecked.delete(key); }
      this.emit(t.task_id, {
        k: 'msg', role: 'system',
        content: { text: `⏰ 定时任务触发(cron ${job.id}${job.recurring ? '' : ',一次性,触发后自动删除'})` },
      });
      this.userMessage(t.task_id, job.prompt);
    }
    if (changed) {
      try { fs.writeFileSync(file, JSON.stringify({ ...data, tasks: kept }, null, 2)); } catch { /* read-only dir — job just stays */ }
    }
  }

  // Codex's equivalent store, with two structural differences from claude's.
  //
  // (1) It lives under CODEX_HOME, not the task directory, and each entry
  //     names the thread it belongs to (target_thread_id) — so ownership is
  //     "this automation's thread is this task's session", not "this file is
  //     in this task's cwd".
  // (2) Only the Codex *desktop app* can create one. Verified against the
  //     0.144.6 binary: automation.toml / target_thread_id / RRULE / next_run
  //     appear zero times in it, and the app-server JSON-RPC schema has no
  //     automation methods at all — but target_thread_id is present in
  //     Codex.app's asar. So `codex app-server` will never fire these, and
  //     unlike claude's case the agent can't have written them mid-task
  //     either. The payoff is different in kind: it lets a user's existing
  //     automations keep running on a headless server with the desktop app
  //     closed, and pushes the results to their phone.
  _sweepCodexAutomations(t, now) {
    if (!t.session_id) return; // nothing an automation could be bound to
    const { jobs, skipped } = readAutomations(codexHomeFor(this.config, !!t.real_config_dir));
    for (const job of jobs) {
      if (job.threadId !== t.session_id) continue;
      const key = `${t.task_id}:${job.id}`;
      // Same 7-day cap claude's jobs get: an automation left pointing at an
      // abandoned task would otherwise burn relay tokens indefinitely, and
      // AgentHub can't ask the desktop app whether the user still wants it.
      if (job.createdAt && now - job.createdAt > CRON_RECURRING_EXPIRY_MS) {
        if (this._warnOnce(key, 'expired')) {
          this.emit(t.task_id, { k: 'msg', role: 'system', content: { text: `⏰ 定时任务「${job.name}」创建已超过 7 天,AgentHub 不再代跑(可在 Codex App 里重建)。` } });
        }
        continue;
      }
      const seen = this._cronChecked.get(key) ?? Math.max(now - 90_000, job.createdAt ?? 0);
      const winStart = Math.max(seen, now - CRON_MAX_LOOKBACK_MS);
      const due = firstRruleMatchIn(job.spec, job.createdAt ?? winStart, winStart, now);
      this._cronChecked.set(key, now);
      if (!due) continue;
      this.emit(t.task_id, {
        k: 'msg', role: 'system',
        content: { text: `⏰ 定时任务触发(Codex 自动化「${job.name}」)` },
      });
      this.userMessage(t.task_id, job.prompt);
      return; // one fire per task per sweep — the injected turn makes it busy
    }
    // An automation AgentHub can't understand is worth saying out loud once:
    // silently not running it looks identical to running it and getting
    // nothing back. Only surfaced on a task that owns *some* automation, so
    // an unrelated task never gets someone else's warnings.
    if (skipped.length && jobs.some(j => j.threadId === t.session_id)) {
      for (const s of skipped) {
        if (!this._warnOnce(`${t.task_id}:${s.id}`, 'skipped')) continue;
        this.emit(t.task_id, { k: 'msg', role: 'system', content: { text: `⚠️ 跳过 Codex 自动化 ${s.id}:${s.reason}(AgentHub 不会猜它的时间表)` } });
      }
    }
  }

  _warnOnce(key, kind) {
    const k = `${kind}:${key}`;
    if (this._warned.has(k)) return false;
    this._warned.add(k);
    return true;
  }

  // Tasks resumed against the real ~/.claude (real_config_dir) can grow from
  // outside AgentHub at any time (VS Code, a terminal) with no signal to
  // AgentHub other than the file itself changing. userMessage() already
  // catches this right before the *next* message, but that leaves the
  // display stale — and a task sitting on an old 'failed' status looks like
  // a dead end — until the user happens to type something. Catching it here
  // too (runs every minute, same cadence as the idle sweeper) is what
  // actually delivers "you can always just talk to it, wherever you last
  // used it" instead of requiring a message first. A stale 'failed' status
  // specifically resets to 'idle': once there's evidence of a live
  // conversation continuing elsewhere, the errored branch AgentHub
  // remembers isn't a useful thing to keep showing.
  _sweepExternalGrowth() {
    for (const t of this.db.allTasks()) {
      if (!t.real_config_dir || !t.session_id) continue;
      if (this.sessions.has(t.task_id)) continue; // mid-turn — leave it alone
      if (!['failed', 'review', 'idle'].includes(t.status)) continue;
      const tx = backendFor(t);
      const file = tx.externalTranscriptFile(this.config, t);
      if (!file) continue;
      if (tx.countLines(file) <= (t.synced_lines || 0)) continue;
      const wasFailed = t.status === 'failed';
      this.emit(t.task_id, {
        k: 'msg', role: 'system',
        content: { text: '检测到此会话在别处(如 VS Code/终端)有新进展,已自动同步:' },
      });
      this._importExternalDelta(t.task_id, t);
      if (wasFailed) this.setStatus(t.task_id, 'idle', { clearError: true });
    }
  }

  _drainQueue() {
    while ((this.resumeQueue.length || this.startQueue.length)
      && this.runningCount() < this.config.maxParallel) {
      if (this.resumeQueue.length) {
        const taskId = this.resumeQueue.shift();
        const t = this.db.getTask(taskId);
        if (t && ['starting', 'running'].includes(t.status)) {
          this._spawn(taskId, '(daemon 重启,请继续之前未完成的工作)', { fresh: false });
        }
      } else {
        this._maybeStart(this.startQueue.shift());
      }
    }
  }

  // On daemon boot: tasks that were mid-flight resume as best we can.
  recover() {
    for (const t of this.db.allTasks()) {
      if (t.status === 'starting' || t.status === 'running') {
        if (t.session_id) {
          // Session process died with the daemon; queue a resume (slot-limited).
          this.resumeQueue.push(t.task_id);
        } else {
          this.db.patchTask(t.task_id, { status: 'queued' });
          if (!this.startQueue.includes(t.task_id)) this.startQueue.push(t.task_id);
        }
      } else if (t.status === 'waiting_human' && t.pending_request) {
        // The CLI process is gone; the pending tool call died with it.
        this.db.patchTask(t.task_id, { pendingRequest: null });
        this.emit(t.task_id, { k: 'msg', role: 'system', content: { text: 'daemon 重启,之前等待审批的工具调用已失效;回复消息可继续任务。' } });
        this.setStatus(t.task_id, 'review');
      } else if (t.status === 'queued') {
        if (!this.startQueue.includes(t.task_id)) this.startQueue.push(t.task_id);
      } else if (t.status === 'failed' && t.retry_attempt > 0) {
        // An auto-retry streak was mid-flight when the daemon went down —
        // the in-memory setTimeout died with it, but the persisted attempt
        // count/first-failure time didn't. Pick the streak back up rather
        // than silently abandoning it (the pattern already matched once, or
        // retry_attempt would still be 0 — no need to re-check the text).
        this._scheduleAutoRetry(t.task_id, t.last_error || TRANSIENT_ERROR_PATTERN.source);
      }
    }
    // Catch up on anything that grew outside AgentHub while this node was
    // down, immediately — not after waiting up to a minute for the sweeper.
    this._sweepExternalGrowth();
    this._drainQueue();
  }

  shutdown() {
    clearInterval(this._idleSweeper);
    for (const [, timer] of this._autoRetryTimers) clearTimeout(timer);
    this._autoRetryTimers.clear();
    for (const [, s] of this.sessions) s.kill();
  }
}
