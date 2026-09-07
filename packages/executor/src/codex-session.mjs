// Drives one OpenAI Codex CLI process via `codex app-server --stdio`, behind
// the exact same interface as session.mjs's ClaudeSession, and translates
// Codex's protocol into the Anthropic SDK message shapes manager.mjs's
// _onSdkMessage already understands. That keeps the event log, approval flow,
// state machine, outbox and the entire frontend backend-agnostic.
//
// Wire protocol: JSON-RPC 2.0 over NDJSON, but the `jsonrpc` field is omitted
// on the wire in both directions (verified against the real binary — sending
// it is accepted, receiving it never happens). Handshake is
//   initialize (req) -> initialized (notif) -> thread/start | thread/resume (req)
// after which turn/start can be called repeatedly on the same process.
//
// Validated against codex 0.144.6. `codex app-server` is marked [experimental]
// upstream, so shapes here are pinned to that version's generated JSON schema
// (`codex app-server generate-json-schema --out DIR`).
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import os from 'node:os';
import path from 'node:path';

// The provider block injected inline via thread/start's `config` param. Doing
// it this way (rather than writing a per-task config.toml) is what lets every
// task on a node share one stable CODEX_HOME — required, because
// thread/resume only ever looks for `sessions/` under the CODEX_HOME the
// app-server was started with. Verified directly: an app-server booted with a
// completely EMPTY config.toml accepted this inline block and echoed back
// modelProvider "agenthub". The API key never appears here — it's named by
// env_key and reaches the child through its own env, so maxParallel > 1 can't
// have two tasks clobber each other's credentials.
export const RELAY_PROVIDER_ID = 'agenthub';
export const RELAY_KEY_ENV = 'AGENTHUB_RELAY_KEY';

// wire_api "chat" was removed upstream; "responses" is the only remaining
// option, so a Codex model profile's relay must speak POST /v1/responses.
export function relayProviderConfig(provider) {
  return {
    model_providers: {
      [RELAY_PROVIDER_ID]: {
        name: 'AgentHub relay',
        base_url: provider.baseUrl,
        env_key: RELAY_KEY_ENV,
        wire_api: 'responses',
      },
    },
  };
}

// AgentHub's three permission modes, expressed in Codex's two orthogonal
// dimensions (approval routing and sandbox reach).
export function codexPolicyFor(permissionMode) {
  switch (permissionMode) {
    case 'bypassPermissions': return { approvalPolicy: 'never', sandbox: 'danger-full-access' };
    case 'acceptEdits': return { approvalPolicy: 'on-request', sandbox: 'workspace-write' };
    default: return { approvalPolicy: 'untrusted', sandbox: 'workspace-write' };
  }
}

export function codexHomeFor(config, realConfigDir) {
  return realConfigDir
    ? path.join(os.homedir(), '.codex')
    : path.join(config.workRoot, 'codex-home');
}

// codexErrorInfo is either a bare string enum ("contextWindowExceeded") or a
// single-key object ({responseStreamDisconnected: {httpStatusCode}}).
export function errorCodeOf(codexErrorInfo) {
  if (!codexErrorInfo) return null;
  if (typeof codexErrorInfo === 'string') return codexErrorInfo;
  const keys = Object.keys(codexErrorInfo);
  return keys.length === 1 ? keys[0] : null;
}

// Transport/upstream hiccups worth retrying — the counterpart of session.mjs's
// TRANSIENT_ERROR_PATTERN, except these are structured enum values from the
// protocol instead of a regex guess at an error string.
export const TRANSIENT_ERROR_CODES = new Set([
  'httpConnectionFailed',
  'responseStreamConnectionFailed',
  'responseStreamDisconnected',
  'responseTooManyFailedAttempts',
  'internalServerError',
  'serverOverloaded',
]);

export class CodexSession {
  /**
   * @param {object} opts
   * @param {object} opts.config       executor config, with `provider` already resolved for this task
   * @param {string} opts.cwd
   * @param {string} opts.taskId       required: namespaces approval request ids (see _onServerRequest)
   * @param {string=} opts.resumeSessionId
   * @param {boolean=} opts.realConfigDir  use the user's real ~/.codex instead of the isolated home
   * @param {string} opts.permissionMode
   * @param {(msg: object) => void} opts.onMessage
   * @param {(req: object) => Promise<{behavior:'allow'|'deny', message?:string}>} opts.onPermission
   * @param {(err: Error|null) => void} opts.onExit
   */
  constructor(opts) {
    this.opts = opts;
    this.child = null;
    this.alive = false;
    this.busy = false;
    this.sessionId = opts.resumeSessionId ?? null;
    this.lastActivity = Date.now();
    this.caps = {
      // Codex reports token counts but never a dollar amount. Emitting a
      // cost of $0.00 would be an outright lie on the Info tab, so manager
      // skips cost accounting entirely for this backend.
      reportsCost: false,
      // Filled in from the first thread/tokenUsage/updated (258400 observed
      // for gpt-5.6-sol) — lets auto-compaction key off the real window
      // instead of a hardcoded constant.
      contextWindow: null,
    };

    this._nextId = 0;
    this._pending = new Map();   // json-rpc id -> {resolve, reject}
    this._ready = false;         // handshake complete, threadId known
    this._sendQueue = [];        // [{text, images}] waiting for the handshake / the in-flight turn
    this._turnInFlight = false;
    this._exited = false;
    this._killed = false;
    this._stderr = '';
    this._openApprovals = new Map(); // json-rpc id -> resolve fn, for serverRequest/resolved
  }

  start() {
    const { config, cwd, permissionMode, realConfigDir } = this.opts;
    const provider = config.provider ?? {};
    const home = codexHomeFor(config, realConfigDir);
    this._codexHome = home;

    const env = { ...process.env };
    // Never inherit host credentials or a host CODEX_HOME — the relay is the
    // only path out, and the home is chosen explicitly above.
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
    env.CODEX_HOME = home;
    env[RELAY_KEY_ENV] = provider.apiKey ?? '';

    // Same Windows .cmd/.ps1 shim reasoning as session.mjs — every argv
    // element here is a fixed literal, and no conversation text ever goes
    // through argv (it all travels as JSON on stdin).
    this.child = spawn(config.codexBin || 'codex', ['app-server', '--stdio'], {
      cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32',
    });
    // Set synchronously and unconditionally: manager's _spawn calls send()
    // on the very next line, and runningCount()/userMessage() both gate on
    // `alive` before the handshake could possibly have finished.
    this.alive = true;

    this.child.stderr.on('data', d => { this._stderr = (this._stderr + d).slice(-4000); });
    this.child.on('exit', (code) => {
      this.alive = false;
      this._failPending(new Error('codex app-server exited'));
      if (this._exited) return;
      this._exited = true;
      const err = (code === 0 || code === null || this._killed)
        ? null
        : new Error(`codex exited with code ${code}: ${this._stderr.slice(-500)}`);
      this.opts.onExit(err);
    });
    this.child.on('error', (e) => {
      this.alive = false;
      this._failPending(e);
      if (this._exited) return;
      this._exited = true;
      this.opts.onExit(e);
    });

    const rl = readline.createInterface({ input: this.child.stdout });
    rl.on('line', line => this._onLine(line));

    this._handshake().catch(e => this._fatal(e));
  }

  // ---- interface parity with ClaudeSession ----

  send(text, images = []) {
    // Synchronous, optimistic: manager flips the task to 'running' right
    // after this returns and relies on busy to serialize its own logic.
    this.busy = true;
    this.lastActivity = Date.now();
    if (this._killed || this._exited) return false;
    this._sendQueue.push({ text, images });
    this._drain();
    return true;
  }

  interrupt() {
    if (!this._ready || !this.sessionId) {
      // Nothing has been started yet — drop anything queued so a pending
      // handshake can't fire a turn the user already tried to stop.
      this._sendQueue.length = 0;
      return;
    }
    this._request('turn/interrupt', { threadId: this.sessionId }).catch(() => { /* already gone */ });
  }

  recentStderr() {
    return (this._stderr || '').trim();
  }

  kill() {
    this._killed = true;
    this._sendQueue.length = 0;
    try { this.child?.kill(); } catch { /* already dead */ }
  }

  // ---- polymorphic operations manager calls without knowing the backend ----

  // Codex has a first-class compaction RPC, so unlike the claude path this
  // never sends "/compact" as conversation text. The thread/compacted
  // notification and the turn it produces flow back through the normal
  // handlers, so manager's compact-then-resend logic is unchanged.
  compact() {
    if (!this._ready || !this.sessionId) return false;
    this._request('thread/compact/start', { threadId: this.sessionId })
      .catch(e => this._emitResult({ isError: true, message: `compact failed: ${e.message}` }));
    return true;
  }

  // The command a human runs to take this session over in their own terminal
  // or IDE. CODEX_HOME is mandatory: without it `codex resume` looks in
  // ~/.codex and simply won't find a session living in AgentHub's isolated
  // home.
  resumeHint() {
    const home = this._codexHome ?? codexHomeFor(this.opts.config, this.opts.realConfigDir);
    return `CODEX_HOME=${home} codex resume ${this.sessionId ?? '<session-id>'}`;
  }

  // ---- handshake ----

  async _handshake() {
    await this._request('initialize', {
      clientInfo: { name: 'agenthub', title: 'AgentHub', version: '1' },
      capabilities: { experimentalApi: true },
    });
    if (this._killed || this._exited) return;
    this._notify('initialized', {});

    const { cwd, permissionMode, resumeSessionId, config } = this.opts;
    const policy = codexPolicyFor(permissionMode);
    const provider = config.provider ?? {};
    const common = {
      cwd,
      approvalPolicy: policy.approvalPolicy,
      sandbox: policy.sandbox,
      config: relayProviderConfig(provider),
      modelProvider: RELAY_PROVIDER_ID,
      ...(provider.model ? { model: provider.model } : {}),
    };
    const res = resumeSessionId
      ? await this._request('thread/resume', { threadId: resumeSessionId, ...common })
      : await this._request('thread/start', common);
    if (this._killed || this._exited) return;

    const threadId = res?.thread?.id;
    if (!threadId) throw new Error('codex thread/start returned no thread id');
    this.sessionId = threadId;
    this._ready = true;
    // Same shape the claude CLI's own init line has — manager persists the
    // session id and emits {k:'session'} off exactly this.
    this.opts.onMessage({ type: 'system', subtype: 'init', session_id: threadId });
    this._drain();
  }

  // A handshake that never completes would otherwise leave the task pinned at
  // 'running' forever: _onSessionExit is the only route to 'failed', so an
  // explicit onExit(err) is mandatory here, not just nice to have.
  _fatal(err) {
    if (this._exited) return;
    this._exited = true;
    this.alive = false;
    this._sendQueue.length = 0;
    try { this.child?.kill(); } catch { /* already dead */ }
    this.opts.onExit(err instanceof Error ? err : new Error(String(err)));
  }

  // ---- json-rpc plumbing ----

  _write(obj) {
    if (!this.child || this._exited) return false;
    try { this.child.stdin.write(JSON.stringify(obj) + '\n'); return true; } catch { return false; }
  }

  _notify(method, params) {
    this._write({ method, params });
  }

  _request(method, params) {
    const id = ++this._nextId;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      if (!this._write({ id, method, params })) {
        this._pending.delete(id);
        reject(new Error('codex app-server stdin closed'));
      }
    });
  }

  _failPending(err) {
    for (const [, p] of this._pending) p.reject(err);
    this._pending.clear();
    // Any approval still waiting on a human can never be answered now.
    for (const [, resolve] of this._openApprovals) resolve();
    this._openApprovals.clear();
  }

  _onLine(line) {
    // Refresh on *every* inbound line, handshake responses included — the
    // 30-minute idle sweeper reads lastActivity and would otherwise kill a
    // session that is demonstrably alive but hasn't produced a turn yet.
    this.lastActivity = Date.now();
    let msg;
    try { msg = JSON.parse(line); } catch { return; }

    if (msg.id !== undefined && msg.method === undefined) {
      const pending = this._pending.get(msg.id);
      if (!pending) return;
      this._pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else pending.resolve(msg.result);
      return;
    }
    if (msg.id !== undefined && msg.method !== undefined) {
      this._onServerRequest(msg);
      return;
    }
    if (msg.method !== undefined) this._onNotification(msg.method, msg.params ?? {});
  }

  // ---- outbound turns ----

  _drain() {
    if (!this._ready || this._turnInFlight || this._killed) return;
    const next = this._sendQueue.shift();
    if (!next) return;
    this._turnInFlight = true;
    this.busy = true;
    const input = [
      // data: URLs are accepted by ImageUserInput.url (verified) — same
      // {mediaType, data} pairs manager's decodeInput produces.
      ...next.images.map(img => ({ type: 'image', url: `data:${img.mediaType};base64,${img.data}` })),
      { type: 'text', text: next.text },
    ];
    this._request('turn/start', { threadId: this.sessionId, input })
      .catch(e => {
        // turn/start itself was rejected (e.g. activeTurnNotSteerable) — no
        // turn/completed will ever arrive for it, so settle it here or the
        // task hangs at 'running' with a queue that never moves.
        this._turnInFlight = false;
        this._emitResult({ isError: true, message: e.message });
        this._drain();
      });
  }

  _emitResult({ isError, message = '', durationMs = 0, subtype, errorCode = null }) {
    this.busy = false;
    this.opts.onMessage({
      type: 'result',
      subtype: subtype ?? (isError ? 'error' : 'success'),
      duration_ms: durationMs,
      num_turns: 1,
      is_error: !!isError,
      result: message,
      // Structured failure reason from the protocol's own enum. manager
      // prefers it over pattern-matching the message text when deciding
      // "transient, retry" vs "context wall, compact" vs "a human must look" —
      // the claude path has no equivalent and still uses its regexes.
      error_code: errorCode,
      // Deliberately absent: total_cost_usd. Codex doesn't report spend, and
      // manager skips cost accounting via caps.reportsCost === false.
    });
  }

  // ---- inbound: server -> client requests (approvals) ----

  async _onServerRequest(msg) {
    const { id, method, params = {} } = msg;
    const respond = (result) => this._write({ id, result });

    // Codex's JSON-RPC ids are small per-connection integers, so two
    // concurrent Codex tasks both produce `id: 1`. manager's pendingDecisions
    // is a single process-wide Map keyed only by requestId (decide() never
    // checks taskId), so an un-namespaced id would let the second task's
    // request silently evict the first's and route a human's answer to the
    // wrong task. Claude never hit this only because its request ids are
    // UUIDs.
    const requestId = `codex:${this.opts.taskId}:${id}`;

    const ask = async (toolName, input, description) => {
      let decision;
      // Registered before awaiting, so a serverRequest/resolved that arrives
      // while the human is still deciding can unblock this.
      const withdrawal = new Promise(resolve => this._openApprovals.set(id, () => resolve('withdrawn')));
      try {
        decision = await Promise.race([
          this.opts.onPermission({ requestId, toolName, input, description }),
          withdrawal,
        ]);
      } catch (e) {
        decision = { behavior: 'deny', message: `approval failed: ${e.message}` };
      } finally {
        this._openApprovals.delete(id);
      }
      // 'withdrawn': Codex already took the request back (it resolved it
      // itself, e.g. after an interrupt) — answering now would be a protocol
      // error, and manager has already been told to drop the pending card.
      if (decision === 'withdrawn') return null;
      return decision;
    };

    switch (method) {
      case 'item/commandExecution/requestApproval': {
        const decision = await ask('Bash', { command: params.command, cwd: params.cwd }, params.reason);
        if (decision) respond({ decision: decision.behavior === 'allow' ? 'accept' : 'decline' });
        return;
      }
      case 'item/fileChange/requestApproval': {
        const decision = await ask('Edit', { grantRoot: params.grantRoot ?? null }, params.reason);
        if (decision) respond({ decision: decision.behavior === 'allow' ? 'accept' : 'decline' });
        return;
      }
      case 'item/permissions/requestApproval': {
        const decision = await ask('Permissions', { permissions: params.permissions, cwd: params.cwd }, params.reason);
        // Granting nothing is how this request is declined — there is no
        // "decline" variant in the response schema, only a granted profile.
        if (decision) {
          respond(decision.behavior === 'allow'
            ? { permissions: params.permissions ?? {}, scope: 'turn' }
            : { permissions: {} });
        }
        return;
      }
      // The next two are NOT yes/no gates — they ask for substantive content
      // (which option, what value). Auto-"approving" them would fabricate an
      // answer on the user's behalf rather than approve anything, which is
      // exactly why manager excludes claude's AskUserQuestion from
      // auto_decide_all. Decline with an explanation instead; the agent sees
      // it and can ask in plain text, which the user *can* answer.
      case 'item/tool/requestUserInput':
        respond({ answers: {} });
        this.opts.onMessage({
          type: 'assistant',
          message: { content: [{ type: 'text', text: '(AgentHub:Codex 请求结构化输入,已跳过 — 请直接在对话里说明你的选择。)' }] },
        });
        return;
      case 'mcpServer/elicitation/request':
        respond({ action: 'decline' });
        return;
      case 'item/tool/call':
        // A client-implemented tool. AgentHub implements none, so failing
        // explicitly is the only honest answer — leaving it unanswered would
        // hang the turn.
        respond({ success: false, contentItems: [{ type: 'text', text: 'not supported by AgentHub' }] });
        return;
      default:
        this._write({ id, error: { code: -32601, message: `unsupported request ${method}` } });
    }
  }

  // ---- inbound: notifications ----

  _onNotification(method, params) {
    switch (method) {
      case 'item/completed':
        this._onItem(params.item);
        return;

      // Deliberately ignored: item/agentMessage/delta, item/reasoning/*Delta,
      // item/commandExecution/outputDelta and friends. manager has no
      // streaming concept — every event it receives is appended to the log —
      // so translating deltas as well as item/completed would render every
      // message twice. item/started is skipped for the same reason (its
      // payload is also incomplete: exitCode/aggregatedOutput only exist once
      // the item completes).

      case 'thread/tokenUsage/updated': {
        const usage = params.tokenUsage ?? {};
        if (usage.modelContextWindow) this.caps.contextWindow = usage.modelContextWindow;
        const input = usage.last?.inputTokens ?? 0;
        if (input > 0) {
          // cachedInputTokens is a subset of inputTokens (verified against a
          // real rollout), so inputTokens alone is the context size — the
          // Anthropic-shaped fields manager sums must not double-count it.
          this.opts.onMessage({ type: 'assistant', message: { usage: { input_tokens: input } } });
        }
        return;
      }

      case 'turn/completed': {
        const turn = params.turn ?? {};
        this._turnInFlight = false;
        const ok = turn.status === 'completed';
        this._emitResult({
          isError: !ok,
          subtype: ok ? 'success' : (turn.status || 'error'),
          message: turn.error?.message ?? '',
          durationMs: turn.durationMs ?? 0,
          errorCode: errorCodeOf(turn.error?.codexErrorInfo),
        });
        this._drain();
        return;
      }

      case 'error': {
        // willRetry means Codex is handling it internally — surfacing it as a
        // failed turn here would race its own recovery and could mark the
        // task failed mid-retry. Show it, don't fail on it.
        const message = params.error?.message || 'codex error';
        if (params.willRetry) {
          this.opts.onMessage({
            type: 'assistant',
            message: { content: [{ type: 'text', text: `(Codex 正在自动重试:${message})` }] },
          });
          return;
        }
        this._turnInFlight = false;
        this._emitResult({ isError: true, message, errorCode: errorCodeOf(params.error?.codexErrorInfo) });
        this._drain();
        return;
      }

      case 'serverRequest/resolved': {
        // Codex withdrew an approval it had asked for (typically after an
        // interrupt). Release the awaiting ask() so the task doesn't sit in
        // waiting_human until the 4-hour decision timeout.
        const resolve = this._openApprovals.get(params.requestId);
        if (resolve) resolve();
        this.opts.onWithdrawPermission?.(`codex:${this.opts.taskId}:${params.requestId}`);
        return;
      }

      case 'thread/compacted':
        this.opts.onMessage({
          type: 'system', subtype: 'compacted',
          session_id: this.sessionId,
        });
        return;

      default:
        return;
    }
  }

  _onItem(item) {
    if (!item) return;
    const emitAssistant = (blocks) => this.opts.onMessage({ type: 'assistant', message: { content: blocks } });
    const emitToolUse = (id, name, input) => emitAssistant([{ type: 'tool_use', id, name, input }]);
    const emitToolResult = (id, content, isError) => this.opts.onMessage({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: !!isError, content }] },
    });

    switch (item.type) {
      case 'agentMessage':
        if (item.text) emitAssistant([{ type: 'text', text: item.text }]);
        return;
      case 'reasoning': {
        // Both fields are plain string arrays. `summary` is the showable
        // paraphrase; `content` is the raw chain when the model exposes it.
        const text = [...(item.summary ?? []), ...(item.summary?.length ? [] : item.content ?? [])]
          .filter(Boolean).join('\n');
        if (text) emitAssistant([{ type: 'thinking', thinking: text }]);
        return;
      }
      case 'commandExecution':
        emitToolUse(item.id, 'Bash', { command: item.command, cwd: item.cwd });
        emitToolResult(item.id, item.aggregatedOutput ?? '', item.status !== 'completed' || (item.exitCode ?? 0) !== 0);
        return;
      case 'fileChange': {
        const changes = item.changes ?? [];
        emitToolUse(item.id, 'Edit', { changes: changes.map(c => ({ path: c.path, kind: c.kind })) });
        emitToolResult(item.id, changes.map(c => c.diff).filter(Boolean).join('\n'), item.status !== 'completed');
        return;
      }
      case 'mcpToolCall':
        emitToolUse(item.id, `${item.server}/${item.tool}`, item.arguments ?? {});
        emitToolResult(
          item.id,
          item.error ? (item.error.message ?? JSON.stringify(item.error)) : JSON.stringify(item.result?.content ?? ''),
          item.status !== 'completed' || !!item.error,
        );
        return;
      case 'webSearch':
        emitToolUse(item.id, 'WebSearch', { query: item.query });
        return;
      default:
        // userMessage (already logged when AgentHub sent it), todoList, plan,
        // hookPrompt, contextCompaction, ... — harness bookkeeping, not
        // conversation.
        return;
    }
  }
}
