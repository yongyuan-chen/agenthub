// Outbound-only WebSocket to the Cloudflare Hub, with reconnect + outbox replay.
// The socket is injectable for in-process tests (makeSocket).
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
  }

  wsUrl() {
    const base = this.config.cloudUrl.replace(/^http/, 'ws').replace(/\/$/, '');
    return `${base}/ws/executor?node=${encodeURIComponent(this.config.nodeId)}&token=${encodeURIComponent(this.config.nodeToken)}`;
  }

  start() {
    this.stopped = false;
    this._connect();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.hbTimer);
    try { this.ws?.close(); } catch { /* noop */ }
  }

  _connect() {
    if (this.stopped) return;
    let ws;
    try { ws = this.makeSocket(this.wsUrl()); } catch (e) { return this._scheduleReconnect(e); }
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.backoff = 1000;
      this._sendHello();
      clearInterval(this.hbTimer);
      this.hbTimer = setInterval(() => this._send({ t: 'hb' }), 20_000);
      if (this.hbTimer.unref) this.hbTimer.unref();
    };
    ws.onmessage = (evt) => {
      let msg;
      try { msg = JSON.parse(typeof evt.data === 'string' ? evt.data : new TextDecoder().decode(evt.data)); } catch { return; }
      this._onCloudMessage(msg);
    };
    ws.onclose = () => this._dropped();
    ws.onerror = () => { /* onclose follows */ };
  }

  _dropped() {
    if (!this.ws) return;
    this.ws = null;
    this.connected = false;
    clearInterval(this.hbTimer);
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this.stopped) return;
    const delay = this.backoff + Math.random() * 500;
    this.backoff = Math.min(this.backoff * 2, 60_000);
    setTimeout(() => this._connect(), delay);
  }

  _send(obj) {
    if (!this.connected || !this.ws) return false;
    try { this.ws.send(JSON.stringify(obj)); return true; } catch { return false; }
  }

  _sendHello() {
    const tasks = this.db.allTasks().map(t => ({
      taskId: t.task_id, status: t.status, lastSeq: this.db.lastSeq(t.task_id),
      sessionId: t.session_id, costUsd: t.cost_usd, lease: t.lease,
    }));
    this._send({ t: 'hello', nodeId: this.config.nodeId, tasks });
  }

  _onCloudMessage(msg) {
    switch (msg.t) {
      case 'hello_ok': {
        // Replay everything the cloud hasn't absorbed yet, oldest first.
        const known = new Map((msg.tasks || []).map(x => [x.taskId, x.lastSeq]));
        const taskIds = new Set(this.db.allTasks().map(t => t.task_id));
        for (const taskId of taskIds) {
          const after = known.get(taskId) ?? 0;
          for (const row of this.db.unackedAfter(taskId, after, 2000)) {
            this._send({ t: 'ev', taskId: row.task_id, seq: row.seq, ev: JSON.parse(row.payload) });
          }
        }
        break;
      }
      case 'ack':
        this.db.ack(msg.taskId, msg.seq);
        break;
      case 'resync':
        this._sendHello();
        break;
      default:
        this.onCommand(msg);
    }
  }

  // Called by the manager whenever a new event lands in the outbox.
  notifyEvent(taskId, seq, ev) {
    this._send({ t: 'ev', taskId, seq, ev });
  }
}
