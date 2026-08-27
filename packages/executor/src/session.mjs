// Drives one Claude Code CLI process in bidirectional stream-json mode.
// Permission requests arrive as control_request/can_use_tool (requires
// --permission-prompt-tool stdio + an initialize handshake), decisions go back
// as control_response. Validated against claude 2.1.105.
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function buildClaudeArgs({ permissionMode = 'default', resumeSessionId = null } = {}) {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', permissionMode || 'default',
    '--permission-prompt-tool', 'stdio',
  ];
  if (resumeSessionId) args.push('--resume', resumeSessionId);
  return args;
}

export class ClaudeSession {
  /**
   * @param {object} opts
   * @param {object} opts.config       executor config
   * @param {string} opts.cwd          working directory (worktree/scratch)
   * @param {string=} opts.resumeSessionId
   * @param {boolean=} opts.realConfigDir  resume against the real ~/.claude instead of the isolated copy
   * @param {string} opts.permissionMode  default|acceptEdits|bypassPermissions
   * @param {(msg: object) => void} opts.onMessage        raw SDK message (assistant/user/system/result...)
   * @param {(req: {requestId,toolName,input,suggestions}) => Promise<{behavior:'allow'|'deny', message?:string, updatedInput?:object}>} opts.onPermission
   * @param {(err: Error) => void} opts.onExit            called once when process ends (null err = clean)
   */
  constructor(opts) {
    this.opts = opts;
    this.child = null;
    this.alive = false;
    this.busy = false;          // a turn is in flight
    this.sessionId = opts.resumeSessionId ?? null;
    this.lastActivity = Date.now();
    this._exited = false;
  }

  start() {
    const { config, cwd, resumeSessionId, permissionMode, realConfigDir, allowRootBypass } = this.opts;
    const args = buildClaudeArgs({ permissionMode, resumeSessionId });

    const env = { ...process.env };
    // Never inherit host login/session state; force the relay.
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    delete env.CLAUDE_CODE_SSE_PORT;
    delete env.ANTHROPIC_AUTH_TOKEN;
    // Sessions adopted from outside AgentHub resume directly against the
    // real ~/.claude (the CLI's own default) instead of an isolated copy, so
    // VS Code/terminal use of the same session id never silently diverges
    // from what AgentHub shows — see db.mjs's real_config_dir column.
    if (realConfigDir) delete env.CLAUDE_CONFIG_DIR;
    else env.CLAUDE_CONFIG_DIR = path.join(config.workRoot, 'claude-config');
    env.ANTHROPIC_BASE_URL = config.anthropic.baseUrl;
    env.ANTHROPIC_API_KEY = config.anthropic.apiKey;
    if (config.anthropic.model) env.ANTHROPIC_MODEL = config.anthropic.model;
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    // claude CLI refuses --permission-mode bypassPermissions outright when
    // running as root/sudo — an unattended agent with full root and no
    // prompts has no recovery story if it goes wrong. IS_SANDBOX is an
    // undocumented but Anthropic-tooling-sanctioned escape hatch (their own
    // devcontainer/sandbox setups use it to signal "this root is already
    // contained") that skips that check. Only set when the task owner has
    // explicitly opted in on this exact task (see manager.mjs's
    // allowRootBypass / db.mjs's allow_root_bypass) — never a standing
    // default, and note it does NOT add any real sandboxing on its own: it
    // just silences the warning, so this is genuinely the user accepting the
    // risk, not AgentHub making it safe.
    if (allowRootBypass) env.IS_SANDBOX = '1';

    // On Windows, an npm-installed `claude` is a .cmd/.ps1 shim — spawn()
    // can't exec those directly without a shell (a well-known Node.js/
    // Windows gotcha, same reason cross-spawn-style libraries exist). Safe
    // to blanket-enable here: every element of `args` is a fixed literal or
    // a value we generate ourselves (session id, permission-mode enum) —
    // actual conversation text never goes through `args`, only stdin (see
    // send()) — so there's no untrusted content for cmd.exe's
    // shell parsing to mis-handle.
    this.child = spawn(config.claudeBin || 'claude', args, {
      cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32',
    });
    this.alive = true;
    this._stderr = '';
    this.child.stderr.on('data', d => { this._stderr = (this._stderr + d).slice(-4000); });
    this.child.on('exit', (code) => {
      this.alive = false;
      if (this._exited) return;
      this._exited = true;
      const err = (code === 0 || code === null || this._killed)
        ? null
        : new Error(`claude exited with code ${code}: ${this._stderr.slice(-500)}`);
      this.opts.onExit(err);
    });
    this.child.on('error', (e) => {
      this.alive = false;
      if (this._exited) return;
      this._exited = true;
      this.opts.onExit(e);
    });

    const rl = readline.createInterface({ input: this.child.stdout });
    rl.on('line', line => this._onLine(line));

    // SDK-host handshake: without it the CLI auto-denies instead of routing
    // permission requests to us.
    this._write({ type: 'control_request', request_id: `init-${randomUUID()}`, request: { subtype: 'initialize' } });
  }

  _write(obj) {
    if (!this.alive) return false;
    try { this.child.stdin.write(JSON.stringify(obj) + '\n'); return true; } catch { return false; }
  }

  // images (optional): [{mediaType, data}], data base64 — verified directly
  // against the real CLI (piped a stream-json message with an image content
  // block into `claude -p --input-format stream-json ...` and got a correct
  // answer describing the image back) that stdin's `content` accepts the
  // same array-of-blocks shape the Anthropic Messages API does, images
  // first then a trailing text block. content stays a plain string when
  // there are no images, byte-identical to before this existed.
  send(text, images = []) {
    this.busy = true;
    this.lastActivity = Date.now();
    const content = images.length
      ? [...images.map(img => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } })), { type: 'text', text }]
      : text;
    return this._write({
      type: 'user', session_id: this.sessionId ?? '',
      message: { role: 'user', content }, parent_tool_use_id: null,
    });
  }

  interrupt() {
    this._write({ type: 'control_request', request_id: `int-${randomUUID()}`, request: { subtype: 'interrupt' } });
  }

  // The CLI's own stderr is the only place with real diagnostic detail for a
  // 'result' event reporting is_error with an empty/generic `result` string
  // (e.g. subtype "error_during_execution") — previously only surfaced when
  // the process actually exited, leaving mid-stream failures with nothing
  // more than that generic subtype string to show the user.
  recentStderr() {
    return (this._stderr || '').trim();
  }

  kill() {
    this._killed = true;
    try { this.child?.kill(); } catch { /* already dead */ }
  }

  async _onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    this.lastActivity = Date.now();

    if (msg.type === 'control_response') return; // response to our initialize
    if (msg.type === 'control_request') {
      const req = msg.request || {};
      if (req.subtype === 'can_use_tool') {
        let decision;
        try {
          decision = await this.opts.onPermission({
            requestId: msg.request_id,
            toolName: req.tool_name,
            input: req.input,
            suggestions: req.permission_suggestions,
            description: req.description,
          });
        } catch (e) {
          decision = { behavior: 'deny', message: `approval failed: ${e.message}` };
        }
        const response = decision.behavior === 'allow'
          ? { behavior: 'allow', updatedInput: decision.updatedInput ?? req.input }
          : { behavior: 'deny', message: decision.message ?? 'Denied by user' };
        this._write({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response } });
      } else {
        // Politely fail unsupported host requests so the CLI doesn't hang.
        this._write({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: 'unsupported' } });
      }
      return;
    }

    if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
      this.sessionId = msg.session_id;
    }
    if (msg.type === 'result') this.busy = false;
    this.opts.onMessage(msg);
  }
}
