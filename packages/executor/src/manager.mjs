// SessionManager: owns task lifecycle on this node. Local SQLite is the truth;
// every externally visible change is emitted as an outbox event (via emit()).
import { ClaudeSession } from './session.mjs';
import { prepareWorkspace, collectDiff } from './worktree.mjs';

export class SessionManager {
  /**
   * @param {object} config
   * @param {import('./db.mjs').LocalDb} db
   * @param {(taskId:string, seq:number, ev:object) => void} onEvent  notify link that outbox has news
   * @param {(opts:object) => ClaudeSession=} sessionFactory  injectable for tests
   */
  constructor(config, db, onEvent, sessionFactory) {
    this.config = config;
    this.db = db;
    this.onEvent = onEvent;
    this.sessionFactory = sessionFactory ?? ((opts) => new ClaudeSession(opts));
    this.sessions = new Map();       // taskId -> ClaudeSession
    this.pendingDecisions = new Map(); // requestId -> {resolve, timer, taskId}
    this.startQueue = [];            // fresh taskIds waiting for a slot
    this.resumeQueue = [];           // taskIds to resume (daemon restart) waiting for a slot
    this._preparing = 0;             // workspaces being cloned right now
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
    this.db.patchTask(taskId, { status, ...(extra.error !== undefined ? { lastError: extra.error } : {}) });
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
      if (t && ['starting', 'running', 'waiting_human'].includes(t.status)) n++;
    }
    return n;
  }

  // ---- commands from cloud ----

  handleCommand(cmd) {
    switch (cmd.t) {
      case 'start_task': return this.startTask(cmd.task);
      case 'user_message': return this.userMessage(cmd.taskId, cmd.text);
      case 'decision': return this.decide(cmd.taskId, cmd.requestId, cmd.behavior, cmd.message);
      case 'cancel': return this.cancel(cmd.taskId);
      case 'lease': return this.setLease(cmd.taskId, cmd.lease);
      default: console.warn('[manager] unknown command', cmd.t);
    }
  }

  startTask(task) {
    const existing = this.db.getTask(task.id);
    if (existing && !['queued'].includes(existing.status)) {
      console.warn(`[manager] start_task ignored, task ${task.id} already ${existing.status}`);
      return;
    }
    this.db.upsertTask({
      taskId: task.id, title: task.title, spec: task.spec, status: 'queued',
      repoUrl: task.repoUrl ?? null, baseBranch: task.baseBranch ?? 'main',
      permissionMode: task.permissionMode ?? 'acceptEdits', sessionId: task.sessionId ?? null,
    });
    this._maybeStart(task.id);
  }

  async _maybeStart(taskId) {
    if (this.runningCount() >= this.config.maxParallel) {
      if (!this.startQueue.includes(taskId)) this.startQueue.push(taskId);
      return;
    }
    const t = this.db.getTask(taskId);
    if (!t || t.status !== 'queued') return;
    this.setStatus(taskId, 'starting');
    this._preparing++;
    try {
      const { dir, branchName } = await prepareWorkspace(this.config, {
        taskId, repoUrl: t.repo_url, baseBranch: t.base_branch,
      });
      const cur = this.db.getTask(taskId);
      if (!cur || cur.status !== 'starting') return; // cancelled while cloning
      this.db.patchTask(taskId, { dir, branchName });
      this._spawn(taskId, t.spec, { fresh: true });
    } catch (e) {
      this.setStatus(taskId, 'failed', { error: `workspace: ${e.message}` });
    } finally {
      this._preparing--;
      this._drainQueue();
    }
  }

  _spawn(taskId, firstMessage, { fresh = false } = {}) {
    const t = this.db.getTask(taskId);
    const session = this.sessionFactory({
      config: this.config,
      cwd: t.dir,
      resumeSessionId: fresh ? null : (t.session_id || null),
      permissionMode: t.permission_mode || 'acceptEdits',
      onMessage: (msg) => this._onSdkMessage(taskId, msg),
      onPermission: (req) => this._onPermission(taskId, req),
      onExit: (err) => this._onSessionExit(taskId, err),
    });
    this.sessions.set(taskId, session);
    session.start();
    if (firstMessage != null) {
      this.emit(taskId, { k: 'msg', role: 'user', content: { text: firstMessage } });
      session.send(firstMessage);
      this.setStatus(taskId, 'running');
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
        }
        break;
      case 'assistant': {
        for (const block of msg.message?.content ?? []) {
          if (block.type === 'text') {
            this.emit(taskId, { k: 'msg', role: 'assistant', content: { text: block.text } });
          } else if (block.type === 'tool_use') {
            this.emit(taskId, { k: 'msg', role: 'tool_use', content: { id: block.id, name: block.name, input: block.input } });
          }
          // thinking blocks intentionally not persisted
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
        const reported = msg.total_cost_usd ?? 0;
        const prevReported = session?.lastReportedCost ?? 0;
        const delta = reported >= prevReported ? reported - prevReported : reported;
        if (session) session.lastReportedCost = reported;
        const cost = (t.cost_usd ?? 0) + delta;
        this.db.patchTask(taskId, { costUsd: cost });
        this.emit(taskId, {
          k: 'msg', role: 'result',
          content: {
            subtype: msg.subtype, duration_ms: msg.duration_ms, num_turns: msg.num_turns,
            turn_cost_usd: delta, total_cost_usd: cost, is_error: msg.is_error ?? false,
          },
        });
        this.emit(taskId, { k: 'cost', costUsd: cost });
        const cur = this.db.getTask(taskId);
        if (cur.status === 'running') {
          if (msg.is_error || msg.subtype !== 'success') {
            this.setStatus(taskId, 'failed', { error: msg.result || msg.subtype || 'agent error' });
          } else if (cost > this.config.maxCostUsd) {
            this._publishDiff(taskId);
            this.setStatus(taskId, 'waiting_human', {
              note: `cost fuse: $${cost.toFixed(2)} > $${this.config.maxCostUsd} — reply to continue`,
            });
          } else {
            this._publishDiff(taskId);
            this.setStatus(taskId, 'review');
          }
        }
        this._drainQueue();
        break;
      }
      default: break;
    }
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
    const pending = { requestId: req.requestId, toolName: req.toolName, input: req.input, description: req.description };
    this.db.patchTask(taskId, { pendingRequest: JSON.stringify(pending) });
    this.emit(taskId, { k: 'msg', role: 'perm_request', content: pending });
    this.setStatus(taskId, 'waiting_human', { pendingRequest: pending });

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingDecisions.delete(req.requestId);
        resolve({ behavior: 'deny', message: 'approval timed out' });
        // Stay in waiting_human (the human still needs to look at this task),
        // but retire the request so the board stops offering live buttons.
        this.db.patchTask(taskId, { pendingRequest: null });
        this.emit(taskId, { k: 'msg', role: 'system', content: { text: `审批超时,已自动拒绝:${req.toolName}` } });
        this.setStatus(taskId, 'waiting_human', { clearPending: true });
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

  decide(taskId, requestId, behavior, message) {
    const pending = this.pendingDecisions.get(requestId);
    if (!pending) {
      this.emit(taskId, { k: 'msg', role: 'system', content: { text: `该审批请求已失效(超时或任务已重启),操作未生效。` } });
      return;
    }
    this.emit(taskId, { k: 'msg', role: 'system', content: { text: behavior === 'allow' ? '✅ 已批准' : '⛔ 已拒绝' } });
    pending.resolve({ behavior, message });
  }

  userMessage(taskId, text) {
    const t = this.db.getTask(taskId);
    if (!t) return console.warn('[manager] user_message for unknown task', taskId);
    if (t.lease !== 'daemon') {
      this.emit(taskId, { k: 'msg', role: 'system', content: { text: '任务当前由 IDE 接管,消息未投递。' } });
      return;
    }
    let session = this.sessions.get(taskId);
    if (!session || !session.alive) {
      this._spawn(taskId, null, { fresh: false });
      session = this.sessions.get(taskId);
    }
    this.emit(taskId, { k: 'msg', role: 'user', content: { text } });
    session.send(text);
    this.setStatus(taskId, 'running');
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

  setLease(taskId, lease) {
    const session = this.sessions.get(taskId);
    if (lease === 'human' && session?.alive) {
      // Let the CLI finish writing the session file, then release it to the IDE.
      session.kill();
      this.sessions.delete(taskId);
    }
    this.db.patchTask(taskId, { lease });
    this.emit(taskId, { k: 'status', status: this.db.getTask(taskId).status, extra: { lease } });
    this.emit(taskId, {
      k: 'msg', role: 'system',
      content: { text: lease === 'human' ? 'IDE 接管开始,看板暂停驱动此会话。' : 'IDE 接管结束,看板恢复控制。' },
    });
  }

  _onSessionExit(taskId, err) {
    this.sessions.delete(taskId);
    const t = this.db.getTask(taskId);
    if (!t) return;
    if (err && ['starting', 'running', 'waiting_human'].includes(t.status)) {
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
      }
    }
    this._drainQueue();
  }

  shutdown() {
    clearInterval(this._idleSweeper);
    for (const [, s] of this.sessions) s.kill();
  }
}
