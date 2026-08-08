// Drives one Claude Code CLI process in bidirectional stream-json mode.
// Permission requests arrive as control_request/can_use_tool (requires
// --permission-prompt-tool stdio + an initialize handshake), decisions go back
// as control_response. Validated against claude 2.1.105.
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class ClaudeSession {
  /**
   * @param {object} opts
   * @param {object} opts.config       executor config
   * @param {string} opts.cwd          working directory (worktree/scratch)
   * @param {string=} opts.resumeSessionId
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
    const { config, cwd, resumeSessionId, permissionMode } = this.opts;
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', permissionMode || 'default',
      '--permission-prompt-tool', 'stdio',
      '--max-turns', String(config.maxTurnsPerRun ?? 100),
    ];
    if (resumeSessionId) args.push('--resume', resumeSessionId);

    const env = { ...process.env };
    // Never inherit host login/session state; force the relay.
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    delete env.CLAUDE_CODE_SSE_PORT;
    delete env.ANTHROPIC_AUTH_TOKEN;
    env.CLAUDE_CONFIG_DIR = path.join(config.workRoot, 'claude-config');
    env.ANTHROPIC_BASE_URL = config.anthropic.baseUrl;
    env.ANTHROPIC_API_KEY = config.anthropic.apiKey;
    if (config.anthropic.model) env.ANTHROPIC_MODEL = config.anthropic.model;
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';

    this.child = spawn(config.claudeBin || 'claude', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
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

  send(text) {
    this.busy = true;
    this.lastActivity = Date.now();
    return this._write({
      type: 'user', session_id: this.sessionId ?? '',
      message: { role: 'user', content: text }, parent_tool_use_id: null,
    });
  }

  interrupt() {
    this._write({ type: 'control_request', request_id: `int-${randomUUID()}`, request: { subtype: 'interrupt' } });
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
