// Supervisor agent: one Durable Object per user, built on the Cloudflare
// Agents SDK. Chats with the user, watches every conversation they own across
// all projects, applies the deterministic approval policy, and writes prompts.
//
// It never executes code. Real commands still run only inside Claude Code on
// the user's own nodes — this agent is pure orchestration, which is why it
// needs no Sandbox/Container, just Worker + Durable Object + D1.
//
// Every tool goes through the Hub DO's existing /api/* surface with the
// owner's id stamped on it, so hub-core's ownership and project-membership
// checks apply unchanged: the agent structurally cannot do anything the user
// couldn't do themselves in the web UI.
import { AIChatAgent } from '@cloudflare/ai-chat';
import {
  convertToModelMessages, createUIMessageStream, createUIMessageStreamResponse,
  generateText, stepCountIs, streamText, tool,
} from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
import {
  AUTO_APPROVE_LEVELS, SUPERVISOR_SYSTEM_PROMPT, auditEntry, classifyRisk,
  parsePendingRequest, shouldAutoApprove, triageTasks,
} from './supervisor-core.mjs';
import { pushAll } from './push.mjs';

const MAX_AUDIT_ENTRIES = 200;
const MAX_NOTICES = 50;
const PATROL_CRON = '*/5 * * * *';   // cheap: a D1 read, no model call unless something needs attention
const DAILY_CRON = '0 9 * * *';      // one model call a day for the progress digest

const DEFAULT_STATE = { autoApprove: 'off', audit: [], notices: [], lastPatrolAt: null };

export class SupervisorAgent extends AIChatAgent {
  // Storage cap only; the model context is bounded separately in onChatMessage.
  maxPersistedMessages = 200;

  initialState = DEFAULT_STATE;

  // `this.name` is the Durable Object instance name, which index.mjs derives
  // from the authenticated session — never from anything the client sends. So
  // it is safe to treat it as the owning user's id.
  get userId() { return this.name; }

  async onStart() {
    // Cron schedules are idempotent by default, so re-running on every wake is
    // a no-op rather than a duplicate.
    try {
      await this.schedule(PATROL_CRON, 'patrol', {});
      await this.schedule(DAILY_CRON, 'dailySummary', {});
    } catch (e) {
      console.error('[supervisor] could not install schedules:', e.message);
    }
  }

  // ---------- plumbing ----------

  // Calls the Hub DO exactly the way the browser does, minus the bearer token:
  // the DO trusts the x-agenthub-user header, which only the Worker sets after
  // validating a session (see index.mjs's withUser).
  async hub(method, path, { body = null, teamId = null, query = null } = {}) {
    const url = new URL(path, 'https://agenthub.internal');
    if (query) for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, String(v));
    const headers = { 'x-agenthub-user': this.userId };
    if (teamId) headers['x-team-id'] = teamId;
    if (body) headers['content-type'] = 'application/json';
    const stub = this.env.HUB.get(this.env.HUB.idFromName('hub'));
    const res = await stub.fetch(new URL(url).toString(), {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok || data?.ok === false) {
      throw new Error(data?.error || `hub ${method} ${path} 返回 HTTP ${res.status}`);
    }
    return data;
  }

  // The user's own relay credentials — the same ones their nodes get pushed.
  // Deliberately read straight from D1 rather than cached: rotating a key in
  // Settings must take effect on the very next turn.
  async modelConfig() {
    const row = await this.env.DB
      .prepare('SELECT api_base_url, api_key, api_model FROM users WHERE id = ?')
      .bind(this.userId).first();
    if (!row?.api_base_url || !row?.api_key) return null;
    return { baseUrl: row.api_base_url, apiKey: row.api_key, model: row.api_model || 'claude-opus-5' };
  }

  resolveModel(config) {
    // The relay speaks the Anthropic Messages API (it's the same endpoint the
    // Claude CLI on every node talks to). createAnthropic's default prefix
    // already includes /v1, so append it to the bare relay URL the user saved.
    const anthropic = createAnthropic({
      baseURL: `${config.baseUrl.replace(/\/+$/, '')}/v1`,
      apiKey: config.apiKey,
    });
    return anthropic(config.model);
  }

  // Every task the user can see, across personal scope and every project they
  // belong to. hub-core scopes /api/tasks by the x-team-id header, so "all
  // projects" means asking once per scope and merging.
  async allTasks() {
    const scopes = [{ teamId: null, teamName: '个人' }];
    try {
      const { teams } = await this.hub('GET', '/api/teams');
      for (const t of teams || []) scopes.push({ teamId: t.id, teamName: t.name });
    } catch { /* teams unavailable — personal scope alone is still useful */ }

    const byId = new Map();
    for (const scope of scopes) {
      try {
        const { tasks } = await this.hub('GET', '/api/tasks', { teamId: scope.teamId });
        for (const task of tasks || []) {
          if (!byId.has(task.id)) byId.set(task.id, { ...task, scopeName: scope.teamName });
        }
      } catch { /* one unreadable scope must not blank the whole overview */ }
    }
    return [...byId.values()];
  }

  patchState(patch) {
    this.setState({ ...DEFAULT_STATE, ...(this.state || {}), ...patch });
  }

  recordAudit(entry) {
    const audit = [entry, ...((this.state?.audit) || [])].slice(0, MAX_AUDIT_ENTRIES);
    this.patchState({ audit });
  }

  addNotice(notice) {
    const notices = [notice, ...((this.state?.notices) || [])].slice(0, MAX_NOTICES);
    this.patchState({ notices });
    // Clients render notices from synced state; the broadcast is just the
    // nudge to re-render immediately. Deliberately NOT saveMessages() — a
    // notification written into chat history would come back as model context
    // and can re-trigger the very task that produced it.
    try { this.broadcast(JSON.stringify({ type: 'supervisor-notice', notice })); } catch { /* no listeners */ }
  }

  async notify(title, body) {
    if (!this.env.VAPID_PRIVATE_KEY || !this.env.VAPID_PUBLIC_KEY) return;
    try {
      await pushAll(this.env.DB, { title, body }, {
        publicKey: this.env.VAPID_PUBLIC_KEY,
        privateJwk: JSON.parse(this.env.VAPID_PRIVATE_KEY),
        subject: this.env.VAPID_SUBJECT || 'mailto:admin@code-me.app',
      }, this.userId);
    } catch (e) { console.error('[supervisor] push failed:', e.message); }
  }

  // ---------- scheduled work ----------

  // Runs every few minutes. Costs one D1-backed read and no model call at all
  // unless something actually needs attention, so leaving it on is cheap.
  async patrol() {
    let tasks;
    try { tasks = await this.allTasks(); } catch (e) {
      console.error('[supervisor] patrol could not list tasks:', e.message);
      return;
    }
    const triage = triageTasks(tasks, { now: Date.now() });
    this.patchState({ lastPatrolAt: Date.now() });
    if (!triage.total) return;

    const level = this.state?.autoApprove || 'off';
    const approved = [];
    const held = [];

    for (const task of triage.needsApproval) {
      const request = parsePendingRequest(task.pending_request);
      if (!request) continue;
      const { tier, reason } = classifyRisk(request);
      if (shouldAutoApprove(tier, level)) {
        try {
          await this.hub('POST', `/api/tasks/${task.id}/decision`, {
            body: { requestId: request.requestId, behavior: 'allow' },
          });
          const entry = auditEntry({
            taskId: task.id, taskTitle: task.title, toolName: request.toolName,
            tier, reason, action: 'auto-approved', at: Date.now(),
          });
          this.recordAudit(entry);
          approved.push(entry);
        } catch (e) {
          this.recordAudit(auditEntry({
            taskId: task.id, taskTitle: task.title, toolName: request.toolName,
            tier, reason: `自动批准失败:${e.message}`, action: 'failed', at: Date.now(),
          }));
        }
      } else {
        held.push({ task, request, tier, reason });
      }
    }

    if (approved.length) {
      this.addNotice({
        kind: 'auto-approved', at: Date.now(),
        text: `已自动批准 ${approved.length} 个低风险请求:${approved.map(a => `${a.taskTitle}(${a.toolName})`).join('、')}`,
      });
    }
    if (held.length) {
      this.addNotice({
        kind: 'needs-you', at: Date.now(),
        text: `${held.length} 个请求需要你决定:${held.map(h => `${h.task.title}(${h.request.toolName} · ${h.tier} · ${h.reason})`).join(';')}`,
      });
      await this.notify('AgentHub 有请求待授权', held.map(h => `${h.task.title}:${h.request.toolName}`).join('\n').slice(0, 300));
    }
    if (triage.failed.length || triage.stuck.length) {
      const parts = [];
      if (triage.failed.length) parts.push(`${triage.failed.length} 个失败:${triage.failed.map(t => t.title).join('、')}`);
      if (triage.stuck.length) parts.push(`${triage.stuck.length} 个疑似卡住(超过 30 分钟无进展):${triage.stuck.map(t => t.title).join('、')}`);
      this.addNotice({ kind: 'attention', at: Date.now(), text: parts.join(';') });
    }
  }

  // One model call per day: a real digest rather than a list of statuses.
  async dailySummary() {
    const config = await this.modelConfig();
    if (!config) return;
    let tasks;
    try { tasks = await this.allTasks(); } catch { return; }
    if (!tasks.length) return;

    const digestInput = tasks.map(t => ({
      project: t.scopeName, title: t.title, status: t.status,
      node: t.node_id, cost: t.cost_usd, error: t.last_error || null,
      updatedAt: t.updated_at ? new Date(t.updated_at).toISOString() : null,
    }));
    try {
      const { text } = await generateText({
        model: this.resolveModel(config),
        system: '你是 AgentHub 总控 agent。用中文写一份简短的每日进展简报,按项目分组,指出卡点和需要用户决策的事项。不要罗列原始字段,要给判断。',
        prompt: `以下是用户当前所有对话的状态快照(JSON):\n${JSON.stringify(digestInput, null, 1)}`,
      });
      this.addNotice({ kind: 'daily', at: Date.now(), text });
      await this.notify('AgentHub 每日进展简报', text.slice(0, 300));
    } catch (e) {
      console.error('[supervisor] daily summary failed:', e.message);
    }
  }

  // ---------- chat ----------

  // Emit one plain assistant turn without involving a model. Used for states
  // the agent can answer by itself (missing config, upstream failure).
  say(text) {
    const stream = createUIMessageStream({
      execute: ({ writer }) => {
        const id = `sv-${Date.now()}`;
        writer.write({ type: 'text-start', id });
        writer.write({ type: 'text-delta', id, delta: text });
        writer.write({ type: 'text-end', id });
      },
    });
    return createUIMessageStreamResponse({ stream });
  }

  async onChatMessage(_onFinish, options) {
    const config = await this.modelConfig();
    if (!config) {
      // Delivered as a normal assistant turn (a proper UI message stream, not
      // a hand-rolled SSE frame — that renders as nothing at all) so the user
      // gets an actionable sentence instead of silence.
      return this.say('还没有可用的模型配置 — 请先在「设置 → 模型」里保存 Base URL 和 API Key,总控 agent 会直接用你那套配置。');
    }

    const result = streamText({
      model: this.resolveModel(config),
      system: `${SUPERVISOR_SYSTEM_PROMPT}\n\n当前自动授权级别:${this.state?.autoApprove || 'off'}(off=全部人工;low=只自动放行低风险;medium=低+中风险自动放行;高风险永远人工)。`,
      messages: await convertToModelMessages(this.messages),
      tools: this.buildTools(),
      stopWhen: stepCountIs(24),
      abortSignal: options?.abortSignal,
    });
    return result.toUIMessageStreamResponse();
  }

  buildTools() {
    return {
      listProjects: tool({
        description: '列出用户的全部项目(团队)。',
        inputSchema: z.object({}),
        execute: async () => {
          const { teams } = await this.hub('GET', '/api/teams');
          return { projects: [{ id: null, name: '个人' }, ...(teams || []).map(t => ({ id: t.id, name: t.name }))] };
        },
      }),

      listTasks: tool({
        description: '列出用户所有项目下的对话及其状态。回答任何“进展/状态/有没有卡住”的问题前都应先调用它。',
        inputSchema: z.object({
          status: z.string().optional().describe('只看某个状态,如 running / failed / waiting_human / review'),
        }),
        execute: async ({ status }) => {
          const tasks = await this.allTasks();
          const filtered = status ? tasks.filter(t => t.status === status) : tasks;
          return {
            count: filtered.length,
            tasks: filtered.map(t => ({
              id: t.id, title: t.title, project: t.scopeName, status: t.status,
              node: t.node_id, cost: t.cost_usd, lastError: t.last_error || null,
              updatedAt: t.updated_at ? new Date(t.updated_at).toISOString() : null,
            })),
          };
        },
      }),

      readConversation: tool({
        description: '读取某个对话最近的消息,用于判断它在做什么、卡在哪。',
        inputSchema: z.object({
          taskId: z.string().describe('对话 ID'),
          limit: z.number().int().min(1).max(80).default(30).describe('最多读取多少条最新消息'),
        }),
        execute: async ({ taskId, limit }) => {
          const { task } = await this.hub('GET', `/api/tasks/${taskId}`);
          const after = Math.max(0, (task?.last_seq || 0) - limit);
          const { messages } = await this.hub('GET', `/api/tasks/${taskId}/messages`, {
            query: { after_seq: after, limit },
          });
          return {
            task: { id: task.id, title: task.title, status: task.status, lastError: task.last_error || null },
            messages: (messages || []).map(m => ({
              seq: m.seq, role: m.role,
              text: typeof m.content?.text === 'string' ? m.content.text.slice(0, 1200) : undefined,
              tool: m.content?.name || undefined,
            })),
          };
        },
      }),

      listPendingApprovals: tool({
        description: '列出所有等待人工授权的请求,并给出确定性风险分级结果。',
        inputSchema: z.object({}),
        execute: async () => {
          const tasks = await this.allTasks();
          const { needsApproval } = triageTasks(tasks, { now: Date.now() });
          return {
            count: needsApproval.length,
            pending: needsApproval.map(t => {
              const request = parsePendingRequest(t.pending_request);
              const risk = request ? classifyRisk(request) : { tier: 'high', reason: '无法解析请求内容' };
              return {
                taskId: t.id, title: t.title, project: t.scopeName,
                requestId: request?.requestId || null, toolName: request?.toolName || null,
                input: request?.input ?? null, tier: risk.tier, reason: risk.reason,
                autoApprovable: shouldAutoApprove(risk.tier, this.state?.autoApprove || 'off'),
              };
            }),
          };
        },
      }),

      decideApproval: tool({
        description: '批准或拒绝一个等待中的授权请求。高风险请求也要先经用户在本对话里确认。',
        inputSchema: z.object({
          taskId: z.string(),
          requestId: z.string(),
          behavior: z.enum(['allow', 'deny']),
          message: z.string().optional().describe('拒绝时告诉 agent 的理由'),
        }),
        // Any decision the supervisor makes on your behalf inside a live chat
        // gets one confirmation click. The unattended path (patrol) is the one
        // governed by the risk policy instead.
        needsApproval: async () => true,
        execute: async ({ taskId, requestId, behavior, message }) => {
          await this.hub('POST', `/api/tasks/${taskId}/decision`, { body: { requestId, behavior, message } });
          this.recordAudit(auditEntry({
            taskId, taskTitle: taskId, toolName: '(chat)', tier: 'manual',
            reason: message || '用户在总控对话中确认', action: behavior === 'allow' ? 'approved' : 'denied', at: Date.now(),
          }));
          return { ok: true, taskId, behavior };
        },
      }),

      sendPrompt: tool({
        description: '把写好的 prompt 发送到指定对话,继续推进它。发送前必须让用户确认内容。',
        inputSchema: z.object({
          taskId: z.string().describe('目标对话 ID'),
          text: z.string().min(1).describe('要发送的完整 prompt'),
        }),
        needsApproval: async () => true,
        execute: async ({ taskId, text }) => {
          await this.hub('POST', `/api/tasks/${taskId}/message`, { body: { text } });
          return { ok: true, taskId, sent: text.length };
        },
      }),

      retryTask: tool({
        description: '重试一个失败的对话。注意它会重发上次失败的输入。',
        inputSchema: z.object({ taskId: z.string() }),
        needsApproval: async () => true,
        execute: async ({ taskId }) => {
          await this.hub('POST', `/api/tasks/${taskId}/retry`, { body: {} });
          return { ok: true, taskId };
        },
      }),

      listNodes: tool({
        description: '查看执行节点在线状态。',
        inputSchema: z.object({}),
        execute: async () => {
          const { nodes } = await this.hub('GET', '/api/nodes');
          return {
            nodes: (nodes || []).map(n => ({
              id: n.id, name: n.name || n.id, status: n.status,
              lastHeartbeatAt: n.last_heartbeat_at ? new Date(n.last_heartbeat_at).toISOString() : null,
            })),
          };
        },
      }),

      setAutoApproveLevel: tool({
        description: '修改自动授权级别。off=全部人工;low=自动放行低风险;medium=自动放行低和中风险。高风险任何级别都不会自动放行。',
        inputSchema: z.object({ level: z.enum(['off', 'low', 'medium']) }),
        needsApproval: async () => true,
        execute: async ({ level }) => {
          if (!AUTO_APPROVE_LEVELS.includes(level)) throw new Error('无效的级别');
          this.patchState({ autoApprove: level });
          return { ok: true, level };
        },
      }),

      recentAutomatedDecisions: tool({
        description: '查看总控 agent 最近自动做过的决定(审计日志)。',
        inputSchema: z.object({ limit: z.number().int().min(1).max(50).default(20) }),
        execute: async ({ limit }) => ({ entries: ((this.state?.audit) || []).slice(0, limit) }),
      }),
    };
  }
}
