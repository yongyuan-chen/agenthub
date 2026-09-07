// Outbound-only WebSocket to the Cloudflare Hub, with reconnect + outbox replay.
// The socket is injectable for in-process tests (makeSocket).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { externalSessionHistoryPage, listExternalSessions, listExternalSessionsForPaths } from './sessions.mjs';
import { PROTOCOL_VERSION, EXECUTOR_FEATURES } from '../../shared/protocol.mjs';

// Which agent CLIs this machine can actually run. Probed once per process
// (spawning a `--version` on every reconnect would be wasteful and, on a
// flapping connection, noisy) — installing a CLI while the daemon is running
// needs a daemon restart to be noticed, which matches how claudeBin/codexBin
// are already treated everywhere else.
let _backendsCache = null;
export function availableBackends(config) {
  if (_backendsCache) return _backendsCache;
  const found = [];
  for (const [name, bin] of [['claude', config.claudeBin || 'claude'], ['codex', config.codexBin || 'codex']]) {
    // shell:true on Windows for the same .cmd-shim reason session.mjs spawns
    // that way; `bin` comes from this node's own config file, never the wire.
    const r = spawnSync(bin, ['--version'], { stdio: 'ignore', timeout: 10_000, shell: process.platform === 'win32' });
    if (!r.error && r.status === 0) found.push(name);
  }
  // An empty list is meaningful: this daemon cannot safely spawn either CLI.
  // Advertising Claude as a fallback made an unconfigured node accept work
  // only to fail later with ENOENT. Restarting the daemon after installing a
  // CLI re-runs this process-level probe.
  _backendsCache = found;
  return _backendsCache;
}

// Prefix-completes a path into matching subdirectories, e.g. '/ho' -> ['/home'].
// Only reachable by the node's owner (ownership-checked cloud-side), who by
// definition already controls this machine (they installed the executor
// daemon on it themselves) — no extra sandboxing beyond OS file permissions,
// same trust boundary the agent itself already operates under once running.
export function listDirs(requestedPath) {
  const raw = String(requestedPath || '').trim();
  let abs;
  if (!raw) abs = os.homedir();
  else if (raw.startsWith('~')) abs = path.join(os.homedir(), raw.slice(1));
  else if (path.isAbsolute(raw)) abs = raw;
  else abs = path.join(os.homedir(), raw);
  abs = path.resolve(abs);

  let dir = abs;
  let prefix = '';
  let isDir = false;
  try { isDir = fs.statSync(abs).isDirectory(); } catch { /* doesn't exist yet / mid-typing */ }
  if (!isDir) { dir = path.dirname(abs); prefix = path.basename(abs); }

  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name.startsWith(prefix))
      .map(e => path.join(dir, e.name))
      .sort()
      .slice(0, 50);
  } catch {
    return [];
  }
}

export class CloudLink {
  /**
   * @param {object} config
   * @param {import('./db.mjs').LocalDb} db
   * @param {(cmd: object) => void} onCommand
   * @param {(url: string) => WebSocket=} makeSocket
   */
  constructor(config, db, onCommand, makeSocket) {
    this.config = config;
    this.db = db;
    this.onCommand = onCommand;
    this.makeSocket = makeSocket || ((url) => new WebSocket(url));
    this.ws = null;
    this.connected = false;
    this.backoff = 1000;
    this.stopped = false;
    this.hbTimer = null;
    this.reconnectTimer = null;   // pending backoff timer, if any
    this.handshakeTimer = null;   // per-attempt open-or-die watchdog
    this._attemptFailLogged = 0;
  }

  wsUrl() {
    const base = this.config.cloudUrl.replace(/^http/, 'ws').replace(/\/$/, '');
    return `${base}/ws/executor?node=${encodeURIComponent(this.config.nodeId)}&token=${encodeURIComponent(this.config.nodeToken)}`;
  }

  start() {
    this.stopped = false;
    // Last-resort supervisor, never cleared while running: if we're not
    // connected AND nothing is scheduled to try (no backoff timer pending,
    // no handshake in flight), the reconnect loop has stalled — force it
    // back to life. This exists because the loop's liveness used to depend
    // entirely on the WebSocket implementation always delivering a
    // close/error event for every failed attempt, and undici doesn't
    // guarantee that on every path — found live: gpu31's executor sat
    // healthy for 5+ hours with zero TCP sockets, zero pending retries and
    // zero log lines, permanently "offline" while the box was fine. Same
    // philosophy as hello_ok's re-assertion: don't trust a one-shot signal
    // chain, re-check the invariant on a timer.
    this.supervisorTimer = setInterval(() => {
      if (this.stopped || this.connected) return;
      if (this.reconnectTimer || this.handshakeTimer) return; // an attempt is in flight/scheduled
      console.warn('[link] reconnect loop stalled — forcing a reconnect');
      this._connect();
    }, this.config.wsSupervisorIntervalMs ?? 60_000);
    // Deliberately NOT unref'd: when disconnected with no socket and no
    // pending retry (the exact stall this heals), this interval may be the
    // only live handle — unref'ing it would let the event loop exit instead.
    this._connect();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.hbTimer);
    clearInterval(this.supervisorTimer);
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.handshakeTimer);
    this.reconnectTimer = null;
    this.handshakeTimer = null;
    try { this.ws?.close(); } catch { /* noop */ }
  }

  _connect() {
    if (this.stopped) return;
    let ws;
    try { ws = this.makeSocket(this.wsUrl()); } catch (e) { return this._scheduleReconnect(e); }
    this.ws = ws;
    // Open-or-die: an attempt that never fires open/close/error (hung
    // handshake, or an implementation path that drops the socket without
    // emitting anything) must not stall the loop forever — see the
    // supervisor comment in start().
    clearTimeout(this.handshakeTimer);
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null;
      if (this.connected || this.ws !== ws) return;
      try { ws.close(); } catch { /* never opened */ }
      this._dropped();
    }, this.config.wsHandshakeTimeoutMs ?? 30_000);
    ws.onopen = () => {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
      this.connected = true;
      this.backoff = 1000;
      this._attemptFailLogged = 0;
      console.log('[link] connected to', this.config.cloudUrl);
      this.lastServerContactAt = Date.now();
      this._sendHello();
      clearInterval(this.hbTimer);
      // Sending a heartbeat only proves *this side* still thinks the socket
      // is open — a half-open TCP connection (a middlebox/NAT silently
      // drops it without either end getting a close/error event, observed
      // directly: gpu31 sat "connected" for 15+ minutes with the cloud
      // showing it offline the whole time, self.send() never throwing)
      // leaves onclose/onerror never firing, so reconnect never kicks in on
      // its own. The cloud now acks every 'hb' (see hub.mjs) specifically so
      // this side has a real round-trip signal — if nothing at all has been
      // heard back in several heartbeat cycles, force-close and let the
      // existing backoff reconnect actually run.
      this.hbTimer = setInterval(() => {
        this._send({ t: 'hb' });
        if (Date.now() - this.lastServerContactAt > 75_000) {
          try { this.ws?.close(); } catch { /* already dead either way */ }
          this._dropped();
        }
      }, 20_000);
      if (this.hbTimer.unref) this.hbTimer.unref();
    };
    ws.onmessage = (evt) => {
      let msg;
      try { msg = JSON.parse(typeof evt.data === 'string' ? evt.data : new TextDecoder().decode(evt.data)); } catch { return; }
      this.lastServerContactAt = Date.now();
      if (msg.t === 'hb_ack') return; // pure liveness signal, nothing to act on
      this._onCloudMessage(msg);
    };
    // Guarded on `this.ws === ws`: a stale attempt's late close/error event
    // must never tear down a newer socket. onerror no longer assumes a
    // close event follows — that assumption is exactly what stalled gpu31
    // (undici skipped close on some failure path); _dropped is idempotent,
    // so when both DO fire the second is a no-op.
    ws.onclose = () => { if (this.ws === ws) this._dropped(); };
    ws.onerror = () => { if (this.ws === ws) this._dropped(); };
  }

  _dropped() {
    if (!this.ws) return;
    this.ws = null;
    const wasConnected = this.connected;
    this.connected = false;
    clearInterval(this.hbTimer);
    clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
    // One line on the transition, then only every ~10th failed attempt —
    // enough journal evidence to diagnose an outage (the gpu31 stall was
    // invisible precisely because nothing here ever logged) without
    // spamming a line per minute for the whole outage.
    if (wasConnected) console.warn('[link] connection lost — reconnecting');
    else if (this._attemptFailLogged++ % 10 === 0) console.warn('[link] still reconnecting…');
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this.stopped) return;
    const delay = this.backoff + Math.random() * 500;
    this.backoff = Math.min(this.backoff * 2, 60_000);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this._connect(); }, delay);
  }

  _send(obj) {
    if (!this.connected || !this.ws) return false;
    try { this.ws.send(JSON.stringify(obj)); return true; } catch { return false; }
  }

  _sendHello() {
    const tasks = this.db.allTasks().map(t => ({
      taskId: t.task_id, status: t.status, lastSeq: this.db.lastSeq(t.task_id),
      sessionId: t.session_id, costUsd: t.cost_usd, lease: t.lease, contextTokens: t.context_tokens,
    }));
    // protocolVersion + backends let the cloud refuse to dispatch work this
    // node would mis-handle rather than dispatch it and get a confusing
    // failure: a pre-rename node silently ignores `provider` and falls back to
    // the node-wide relay, and a node without the codex CLI can't run a codex
    // profile at all. Both are answered here, once, instead of being
    // discovered per-task.
    this._send({
      t: 'hello', nodeId: this.config.nodeId, tasks,
      protocolVersion: PROTOCOL_VERSION,
      backends: availableBackends(this.config),
      // Fine-grained capabilities the coarse protocol version can't express —
      // see EXECUTOR_FEATURES. Absent = an older node, which the cloud then
      // treats conservatively rather than refusing outright.
      features: EXECUTOR_FEATURES,
    });
  }

  _onCloudMessage(msg) {
    switch (msg.t) {
      case 'hello_ok': {
        // The cloud speaks a newer protocol than this daemon and has refused to
        // hand it work rather than let it run against the wrong relay. Nothing
        // this process can do about it, so say so loudly on every reconnect —
        // the alternative is a node that looks connected and never picks
        // anything up, with no explanation anywhere.
        if (msg.upgradeRequired) {
          console.error(`[link] 这个 executor 太旧了(协议 v${PROTOCOL_VERSION},云端要求 v${msg.upgradeRequired}),云端不会向它派发任务。请升级本机的 AgentHub daemon。`);
        }
        // Replay everything the cloud hasn't absorbed yet, oldest first.
        const known = new Map((msg.tasks || []).map(x => [x.taskId, x.lastSeq]));
        const taskIds = new Set(this.db.allTasks().map(t => t.task_id));
        for (const taskId of taskIds) {
          const after = known.get(taskId) ?? 0;
          for (const row of this.db.unackedAfter(taskId, after, 2000)) {
            this._send({ t: 'ev', taskId: row.task_id, seq: row.seq, ev: JSON.parse(row.payload) });
          }
        }
        // Cloud is authoritative for these settings (see hub-core.mjs's
        // handleHello comment) — reassert on every reconnect rather than
        // trusting the one-shot push from whenever they were originally
        // set. All handlers already no-op if the value already matches.
        // providerOverride is only present when the cloud has an explicit
        // stance (pinned profile, or explicit revert-to-default) — absent
        // for legacy tasks, whose executor-side override must be left alone.
        // A checkout node can restart into newer executor code before the
        // Worker is deployed; accept v1's anthropicOverride spelling too.
        for (const x of msg.tasks || []) {
          if (x.permissionMode) this.onCommand({ t: 'set_permission_mode', taskId: x.taskId, permissionMode: x.permissionMode });
          if ('autoDecideAll' in x) this.onCommand({ t: 'set_auto_decide_all', taskId: x.taskId, autoDecideAll: x.autoDecideAll });
          if ('providerOverride' in x) this.onCommand({ t: 'set_provider_override', taskId: x.taskId, provider: x.providerOverride, backend: x.backend ?? null });
          else if ('anthropicOverride' in x) this.onCommand({ t: 'set_provider_override', taskId: x.taskId, provider: x.anthropicOverride, backend: null });
        }
        // Every hello carries the owning user's current relay credentials —
        // route it through the same path a live {t:'config'} push uses. The
        // stable production Worker still calls this field `anthropic`, so the
        // rename must be backward-compatible rather than silently dropping it.
        const provider = msg.provider ?? msg.anthropic;
        if (provider) this.onCommand({ t: 'config', provider });
        break;
      }
      case 'ack':
        this.db.ack(msg.taskId, msg.seq);
        break;
      case 'resync':
        this._sendHello();
        break;
      case 'browse':
        this._send({ t: 'browse_result', requestId: msg.requestId, entries: listDirs(msg.path) });
        break;
      case 'list_sessions':
        this._send({ t: 'list_sessions_result', requestId: msg.requestId, sessions: listExternalSessions(msg.path) });
        break;
      case 'list_project_sessions':
        this._send({
          t: 'list_project_sessions_result', requestId: msg.requestId,
          sessions: listExternalSessionsForPaths(msg.paths, this.config.claudeProjectsRoot),
        });
        break;
      case 'read_project_session': {
        const page = externalSessionHistoryPage(msg.sessionId, msg.cwd, this.config.claudeProjectsRoot, {
          before: msg.before == null ? null : {
            offset: msg.before, boundaryHash: msg.boundaryHash, fileSize: msg.fileSize, fileMtime: msg.fileMtime,
          },
          turns: msg.turns === 1 ? 1 : 10,
          maxBytes: msg.turns === 1 ? 256_000 : 1_000_000,
          maxEvents: msg.turns === 1 ? 200 : 800,
          includeTools: msg.includeTools !== false,
        });
        this._send({ t: 'read_project_session_result', requestId: msg.requestId, ...page });
        break;
      }
      default:
        this.onCommand(msg);
        if (msg.commandKey) this._send({ t: 'durable_cmd_ack', commandKey: msg.commandKey });
    }
  }

  // Called by the manager whenever a new event lands in the outbox.
  notifyEvent(taskId, seq, ev) {
    this._send({ t: 'ev', taskId, seq, ev });
  }
}
