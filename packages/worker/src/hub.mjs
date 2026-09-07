// Hub Durable Object: terminates executor + frontend WebSockets (hibernation
// API), serializes all D1 writes, runs the heartbeat alarm. Logic lives in
// hub-core.mjs; this class only binds infrastructure.
import * as core from './hub-core.mjs';
import { pushAll } from './push.mjs';
import { sha256Hex, ulid } from '../../shared/protocol.mjs';

const HEARTBEAT_TIMEOUT_MS = 60_000;
const ALARM_PERIOD_MS = 30_000;
const ASK_TIMEOUT_MS = 4_000;
// Don't re-push a send that was handed to a socket moments ago — give the
// node a heartbeat cycle to actually confirm it first.
const OUTBOUND_RETRY_MIN_AGE_MS = 45_000;

export class Hub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // requestId -> {resolve, timer}. In-memory only: if the DO hibernates
    // mid-round-trip a pending ask just times out, which is fine for the
    // autocomplete-shaped features built on this (no results, not an error).
    this.pendingAsks = new Map();
    // webSocketMessage is async and awaits D1 (a real network round trip);
    // the DO's event loop is free to start handling the *next* incoming
    // message before that await resolves, so back-to-back events for the
    // same task (e.g. a retry's queued -> starting -> idle burst, all within
    // ~10ms) can run absorbEvent() concurrently, each reading the row before
    // the other's write commits — whichever write lands last wins, even if
    // its seq is actually older, silently reverting a newer status. Chaining
    // every message through this promise enforces the strict in-order
    // processing the class comment already promised but never enforced.
    this._processing = Promise.resolve();
  }

  ctx(userId, teamId = null) {
    return {
      db: this.env.DB,
      userId: userId ?? null,
      teamId: teamId ?? null,
      now: () => Date.now(),
      // A resource (task/node) is either personal or bound to exactly one
      // team (see tasks.team_id / nodes.team_id) — so it only ever needs to
      // reach ONE channel: the owner's personal tag when unbound, or that
      // team's tag when bound. No D1 lookup needed here anymore (an earlier
      // version fanned out to every team the owner happened to belong to,
      // which is exactly what leaked personal data into unrelated teams).
      broadcast: (msg, ownerUserId, teamId = null) => {
        if (!ownerUserId) return;
        const data = JSON.stringify(msg);
        const tag = teamId ? `fe:team:${teamId}` : `fe:${ownerUserId}`;
        for (const ws of this.state.getWebSockets(tag)) {
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
      push: (payload, ownerUserId) => {
        const vapid = this.vapid();
        if (vapid && ownerUserId) this.state.waitUntil(pushAll(this.env.DB, payload, vapid, ownerUserId));
      },
      browseNode: (nodeId, path) => this.askNode(nodeId, { t: 'browse', path }).then(r => (r ? { entries: r.entries || [] } : null)),
      listSessions: (nodeId, path) => this.askNode(nodeId, { t: 'list_sessions', path }).then(r => (r ? { sessions: r.sessions || [] } : null)),
      listProjectSessions: (nodeId, paths) => this.askNode(nodeId, { t: 'list_project_sessions', paths }, 12_000)
        .then(r => (r ? { sessions: r.sessions || [] } : null)),
      readProjectSession: (nodeId, sessionId, cwd, options = {}) => this.askNode(nodeId, {
        t: 'read_project_session', sessionId, cwd, before: options.before ?? null,
        boundaryHash: options.boundaryHash ?? null, fileSize: options.fileSize ?? null,
        fileMtime: options.fileMtime ?? null, turns: options.turns ?? 1,
        includeTools: options.includeTools !== false,
      }, 12_000).then(r => (r ? {
        events: r.events || [], nextBefore: r.nextBefore ?? null, nextBoundaryHash: r.nextBoundaryHash ?? null,
        fileSize: r.fileSize ?? null, fileMtime: r.fileMtime ?? null,
        hiddenDetailCount: r.hiddenDetailCount ?? 0, hasMore: !!r.hasMore, stale: !!r.stale,
      } : null)),
    };
  }

  // Cloud-initiated request/response over a node's WS: ask a connected node
  // something and wait for its reply, correlated by requestId. Resolves to
  // null if the node is offline or doesn't answer in time — callers treat
  // that the same as "no results", not an error.
  askNode(nodeId, cmd, timeoutMs = ASK_TIMEOUT_MS) {
    const ctx = this.ctx();
    const requestId = ulid();
    const sent = ctx.sendToNode(nodeId, { ...cmd, requestId });
    if (!sent) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingAsks.delete(requestId);
        resolve(null);
      }, timeoutMs);
      this.pendingAsks.set(requestId, { resolve, timer });
    });
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
    const userId = request.headers.get('x-agenthub-user') || null;

    if (url.pathname === '/ws/frontend') {
      // user token already validated by the worker
      const teamId = url.searchParams.get('teamId') || null;
      if (teamId) {
        const member = await this.env.DB.prepare('SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ?').bind(teamId, userId).first();
        if (!member) return new Response('not a team member', { status: 403 });
      }
      const pair = new WebSocketPair();
      // Personal mode keeps the per-user tag (unchanged behavior); team mode
      // tags by team instead — the viewer's own tasks still reach them
      // through that tag too, since they're a team member by definition to
      // have gotten past the check above.
      const tags = teamId ? ['fe', `fe:team:${teamId}`] : ['fe', `fe:${userId}`];
      this.state.acceptWebSocket(pair[1], tags);
      pair[1].serializeAttachment({ kind: 'fe', userId, teamId });
      this.state.waitUntil((async () => {
        try { pair[1].send(JSON.stringify(await core.snapshot(this.ctx(userId, teamId)))); } catch { /* raced close */ }
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
      if (request.method === 'POST' || request.method === 'PUT') {
        try { body = await request.json(); } catch { body = null; }
      } else {
        body = Object.fromEntries(url.searchParams);
      }
      const teamId = request.headers.get('x-team-id') || null;
      const invoke = () => core.api(this.ctx(userId, teamId), request.method, url.pathname, body);
      let result;
      if (request.method === 'GET') {
        result = await invoke();
      } else {
        const run = this._processing.then(invoke, invoke);
        this._processing = run.catch(() => {});
        result = await run;
      }
      // A send accepted for a node that isn't reachable right now needs the
      // alarm running to be retried (and, eventually, to time out) — without
      // this it would only move again if some node happened to reconnect.
      if (result.body?.delivery === 'queued') await this.ensureAlarm();
      return Response.json(result.body, { status: result.status });
    }

    return new Response('not found', { status: 404 });
  }

  async webSocketMessage(ws, data) {
    let msg;
    try { msg = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data)); } catch { return; }
    const att = ws.deserializeAttachment() || {};
    if (att.kind !== 'node') return; // frontends are receive-only
    if (msg.t === 'durable_cmd_ack' && msg.commandKey) {
      await core.ackDurableCommand(this.ctx(), att.nodeId, msg.commandKey);
      return;
    }
    if (msg.requestId && this.pendingAsks.has(msg.requestId)) {
      const pending = this.pendingAsks.get(msg.requestId);
      clearTimeout(pending.timer);
      this.pendingAsks.delete(msg.requestId);
      pending.resolve(msg);
      return;
    }
    // Chained (not fired independently) so D1-writing handlers never run
    // concurrently with each other, however fast messages arrive — see the
    // constructor comment. The .then() callback has its own try/catch, so a
    // single bad message can't reject the chain and wedge every message
    // after it.
    this._processing = this._processing.then(async () => {
      const ctx = this.ctx();
      try {
        if (msg.t === 'hello') await core.handleHello(ctx, att.nodeId, msg);
        else if (msg.t === 'hb') {
          await core.handleHeartbeat(ctx, att.nodeId);
          // A real round-trip signal, not just "I sent something" — a
          // half-open connection can let send() succeed silently forever on
          // the executor side with nothing ever arriving here to prove it.
          try { ws.send(JSON.stringify({ t: 'hb_ack' })); } catch { /* socket's already dead, next hb cycle's watchdog will catch it */ }
        }
        else if (msg.t === 'ev') await core.absorbEvent(ctx, att.nodeId, msg);
      } catch (e) {
        console.error('hub message error:', e.stack || e.message);
      }
    });
    await this._processing;
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
    // Redeliver user sends the node hasn't confirmed yet. Reconnects already
    // flush (see handleHello), but a message can also be lost into a socket
    // that stays "open" while delivering nothing — that case produces no
    // reconnect to hang the retry off, so the timer is what makes delivery
    // eventually happen instead of eventually not.
    await core.flushOutboundMessages(this.ctx(), null, { minAgeMs: OUTBOUND_RETRY_MIN_AGE_MS });
    // Keep ticking while anything is still undelivered even if no node is
    // connected — otherwise a message queued for an offline node would sit
    // untouched (never retried, never timed out) until unrelated traffic
    // happened to restart the alarm.
    if (this.state.getWebSockets('node').length > 0 || await core.hasPendingOutboundMessages(this.ctx())) {
      await this.state.storage.setAlarm(Date.now() + ALARM_PERIOD_MS);
    }
  }
}
