// Hub Durable Object: terminates executor + frontend WebSockets (hibernation
// API), serializes all D1 writes, runs the heartbeat alarm. Logic lives in
// hub-core.mjs; this class only binds infrastructure.
import * as core from './hub-core.mjs';
import { pushAll } from './push.mjs';
import { sha256Hex } from '../../shared/protocol.mjs';

const HEARTBEAT_TIMEOUT_MS = 60_000;
const ALARM_PERIOD_MS = 30_000;

export class Hub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  ctx() {
    return {
      db: this.env.DB,
      now: () => Date.now(),
      broadcast: (msg) => {
        const data = JSON.stringify(msg);
        for (const ws of this.state.getWebSockets('fe')) {
          try { ws.send(data); } catch { /* dying socket */ }
        }
      },
      sendToNode: (nodeId, msg) => {
        const sockets = this.state.getWebSockets(`node:${nodeId}`);
        let sent = false;
        for (const ws of sockets) {
          try { ws.send(JSON.stringify(msg)); sent = true; } catch { /* dying socket */ }
        }
        return sent;
      },
      push: (payload) => {
        const vapid = this.vapid();
        if (vapid) this.state.waitUntil(pushAll(this.env.DB, payload, vapid));
      },
    };
  }

  vapid() {
    if (!this.env.VAPID_PRIVATE_KEY || !this.env.VAPID_PUBLIC_KEY) return null;
    return {
      publicKey: this.env.VAPID_PUBLIC_KEY,
      privateJwk: JSON.parse(this.env.VAPID_PRIVATE_KEY),
      subject: this.env.VAPID_SUBJECT || 'mailto:admin@code-me.app',
    };
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/ws/frontend') {
      // user token already validated by the worker
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1], ['fe']);
      pair[1].serializeAttachment({ kind: 'fe' });
      this.state.waitUntil((async () => {
        try { pair[1].send(JSON.stringify(await core.snapshot(this.ctx()))); } catch { /* raced close */ }
      })());
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (url.pathname === '/ws/executor') {
      const nodeId = url.searchParams.get('node') || '';
      const token = url.searchParams.get('token') || '';
      const node = await this.env.DB.prepare('SELECT id, token_hash FROM nodes WHERE id = ?').bind(nodeId).first();
      if (!node || node.token_hash !== await sha256Hex(token)) {
        return new Response('unauthorized node', { status: 401 });
      }
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1], [`node:${nodeId}`, 'node']);
      pair[1].serializeAttachment({ kind: 'node', nodeId });
      await this.ensureAlarm();
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (url.pathname.startsWith('/api/')) {
      let body = null;
      if (request.method === 'POST') {
        try { body = await request.json(); } catch { body = null; }
      } else {
        body = Object.fromEntries(url.searchParams);
      }
      const { status, body: resBody } = await core.api(this.ctx(), request.method, url.pathname, body);
      return Response.json(resBody, { status });
    }

    return new Response('not found', { status: 404 });
  }

  async webSocketMessage(ws, data) {
    let msg;
    try { msg = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data)); } catch { return; }
    const att = ws.deserializeAttachment() || {};
    if (att.kind !== 'node') return; // frontends are receive-only
    const ctx = this.ctx();
    try {
      if (msg.t === 'hello') await core.handleHello(ctx, att.nodeId, msg);
      else if (msg.t === 'hb') await core.handleHeartbeat(ctx, att.nodeId);
      else if (msg.t === 'ev') await core.absorbEvent(ctx, att.nodeId, msg);
    } catch (e) {
      console.error('hub message error:', e.stack || e.message);
    }
  }

  async webSocketClose(ws) {
    const att = ws.deserializeAttachment() || {};
    if (att.kind === 'node') {
      // Only mark offline if this was the last socket for that node.
      const remaining = this.state.getWebSockets(`node:${att.nodeId}`).filter(s => s !== ws);
      if (remaining.length === 0) await core.markNodeOffline(this.ctx(), att.nodeId);
    }
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }

  async ensureAlarm() {
    const current = await this.state.storage.getAlarm();
    if (current === null) await this.state.storage.setAlarm(Date.now() + ALARM_PERIOD_MS);
  }

  async alarm() {
    await core.checkHeartbeats(this.ctx(), HEARTBEAT_TIMEOUT_MS);
    if (this.state.getWebSockets('node').length > 0) {
      await this.state.storage.setAlarm(Date.now() + ALARM_PERIOD_MS);
    }
  }
}
