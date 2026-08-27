// Pure logic for the supervisor agent — no Durable Object, no network, no AI
// SDK — so it can be unit-tested with plain node:test like hub-core.mjs.
// supervisor.mjs owns the runtime wiring (agents SDK, streaming, scheduling).

// Risk tiers, ordered. A request is auto-approved only when its tier is at or
// below the user's configured threshold, so 'high' is never auto-approved by
// any setting — that ceiling is deliberate and not user-configurable.
export const RISK_ORDER = { low: 0, medium: 1, high: 2 };
export const AUTO_APPROVE_LEVELS = ['off', 'low', 'medium'];

// Claude Code tools that only read. Approving these can't mutate the machine,
// so they're the one group safe to wave through by default.
const READ_ONLY_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'NotebookRead', 'WebSearch', 'WebFetch',
  'TodoWrite', 'ListMcpResources', 'ReadMcpResource',
]);

// Writes confined to the working tree: reversible via git, and the whole point
// of the task — medium rather than high.
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// Not a yes/no permission gate at all — the CLI is asking for a real answer
// (which option, what value). Auto-"allowing" it fabricates an empty choice on
// the user's behalf, so it can never be automated. Mirrors the same carve-out
// the executor already makes for auto_decide_all (see manager.mjs).
const NEVER_AUTOMATABLE = new Set(['AskUserQuestion']);

// Paths outside a task's workspace: editing these escapes the git worktree, so
// the "reversible via git" argument for WRITE_TOOLS no longer holds.
const SYSTEM_PATH = /^(\/etc\/|\/usr\/|\/bin\/|\/sbin\/|\/boot\/|\/System\/|\/Library\/LaunchDaemons\/|[A-Za-z]:\\Windows\\)/;

// Anything touching credentials is high regardless of the verb — reading a key
// is how a key leaks.
const CREDENTIAL_PATH = /(^|\/|\\)(\.env(\.|$)|\.ssh(\/|$)|id_rsa|id_ed25519|\.aws(\/|$)|\.npmrc$|credentials$|\.pem$)/i;

// Bash commands that are destructive, irreversible, or reach outside the box.
// Ordered most-specific-first only for readability; all are tested.
const DANGEROUS_BASH = [
  // Any rm, not just rm -rf: deleting an untracked file is just as
  // irreversible, and "it wasn't recursive" is no comfort afterwards.
  [/\brm\b/, '删除文件'],
  [/\bdd\s+if=/, '直接写块设备'],
  [/\bmkfs(\.\w+)?\b/, '格式化文件系统'],
  [/\b(shutdown|reboot|halt|poweroff)\b/, '关机或重启机器'],
  [/\bsudo\b/, '提权执行'],
  [/\bchmod\s+(-\S+\s+)*777\b/, '把权限放开到所有人'],
  [/\bgit\s+push\b/, '推送到远程仓库'],
  [/\bgit\s+reset\s+--hard\b/, '丢弃未提交改动'],
  [/\bgit\s+clean\s+-\S*[fd]/, '删除未跟踪文件'],
  [/--force\b/, '强制覆盖'],
  [/\bmv\s+\S+\s+\/(etc|usr|bin|sbin|boot)\//, '移动文件到系统目录'],
  [/\b(curl|wget)\b[^|]*\|\s*(ba|z|k)?sh\b/, '下载脚本并直接执行'],
  [/\bnpm\s+publish\b/, '发布 npm 包'],
  [/\b(wrangler|vercel|netlify|fly)\s+deploy\b/, '部署到线上环境'],
  [/\bdrop\s+(table|database)\b/i, '删除数据库对象'],
  [/\b(truncate)\s+table\b/i, '清空数据表'],
  [/\b(kill|pkill|killall)\b/, '结束进程'],
  [/\b(systemctl|launchctl|sc)\s+(stop|disable|delete)\b/, '停止或禁用服务'],
  [/\bdocker\s+(rm|rmi|system\s+prune)\b/, '删除容器或镜像'],
  [/>\s*\/dev\/(sd|nvme|disk)/, '写入磁盘设备'],
  [/\bcrontab\s+-r\b/, '删除定时任务'],
  [/\biptables\b|\bufw\s+(disable|allow)/, '修改防火墙'],
];

// Commands that only inspect. Anchored at the start so a safe prefix can't be
// used to smuggle a second command — the separator check below handles chains.
const SAFE_BASH = [
  /^(ls|pwd|whoami|date|uname|hostname|df|du|free|uptime)\b/,
  /^(cat|head|tail|wc|file|stat)\b/,
  /^(grep|rg|find|fd|which|type)\b/,
  /^git\s+(status|log|diff|show|branch|remote|describe|rev-parse)\b/,
  /^(node|npm|python3?|pip3?|go|cargo)\s+(--version|-v|version)\b/,
  /^npm\s+(test|run\s+(test|lint|typecheck|build))\b/,
  /^(pytest|jest|vitest)\b/,
  /^echo\b/,
];

// A chained/substituted command can hide anything after a safe-looking head,
// so a command containing these never qualifies for the SAFE_BASH fast path.
const COMMAND_CHAINING = /[;&|`]|\$\(|>>|(^|\s)>(\s|$)/;

function stringsIn(value, depth = 0) {
  // Tool inputs are small JSON objects; the depth cap is a cheap guard against
  // a pathological nesting rather than an expected case.
  if (depth > 6) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(v => stringsIn(v, depth + 1));
  if (value && typeof value === 'object') return Object.values(value).flatMap(v => stringsIn(v, depth + 1));
  return [];
}

/**
 * Deterministically classify one pending permission request.
 *
 * Deliberately rule-based, not model-based: an approval decision needs to be
 * reproducible and auditable after the fact, and must not vary with model
 * temperature or prompt drift. The model's job is to explain and summarize,
 * never to decide whether something gets approved.
 *
 * @returns {{tier: 'low'|'medium'|'high', reason: string}}
 */
export function classifyRisk(request) {
  const toolName = request?.toolName || '';
  const input = request?.input ?? {};

  if (NEVER_AUTOMATABLE.has(toolName)) {
    return { tier: 'high', reason: `${toolName} 需要你给出实际答案,不是能代为批准的权限确认` };
  }

  // Credential exposure outranks everything else, including "it's just a Read".
  for (const s of stringsIn(input)) {
    if (CREDENTIAL_PATH.test(s)) {
      return { tier: 'high', reason: '涉及凭据文件(密钥/token/.env)' };
    }
  }

  if (toolName === 'Bash' || toolName === 'BashOutput' || toolName === 'KillShell') {
    const command = typeof input.command === 'string' ? input.command : '';
    if (!command) return { tier: 'high', reason: '无法读取要执行的命令内容' };
    for (const [re, why] of DANGEROUS_BASH) {
      if (re.test(command)) return { tier: 'high', reason: `命令会${why}` };
    }
    if (!COMMAND_CHAINING.test(command) && SAFE_BASH.some(re => re.test(command.trim()))) {
      return { tier: 'low', reason: '只读命令,不修改任何文件' };
    }
    return { tier: 'medium', reason: '普通 shell 命令,会改动工作区但未命中危险模式' };
  }

  if (READ_ONLY_TOOLS.has(toolName)) {
    return { tier: 'low', reason: `${toolName} 是只读操作` };
  }

  if (WRITE_TOOLS.has(toolName)) {
    for (const s of stringsIn(input)) {
      if (SYSTEM_PATH.test(s)) {
        return { tier: 'high', reason: '写入工作区之外的系统路径' };
      }
    }
    return { tier: 'medium', reason: `${toolName} 修改工作区内文件,可用 git 回滚` };
  }

  // Unknown tools (new CLI tools, MCP servers) default to the ceiling on
  // purpose: an unrecognized capability must never be auto-approved just
  // because this table hasn't been updated yet.
  return { tier: 'high', reason: `未知工具 ${toolName || '(未命名)'},默认不自动批准` };
}

/**
 * Decide whether a classified request may be auto-approved under the user's
 * setting. 'high' is unreachable by design — see RISK_ORDER above.
 */
export function shouldAutoApprove(tier, level) {
  if (!AUTO_APPROVE_LEVELS.includes(level) || level === 'off') return false;
  if (tier === 'high') return false;
  return RISK_ORDER[tier] <= RISK_ORDER[level];
}

/**
 * Build the JSON-serializable audit record written to supervisor state (and
 * shown in the chat) for every automated decision. Kept as a pure function so
 * the shape is pinned by tests rather than by whatever the DO happened to write.
 */
export function auditEntry({ taskId, taskTitle, toolName, tier, reason, action, at }) {
  return {
    taskId, taskTitle: taskTitle || taskId, toolName: toolName || '(未知)',
    tier, reason, action, at,
  };
}

/** Tasks the supervisor should surface, newest signal first. */
export function triageTasks(tasks, { now, stuckMs = 30 * 60_000 } = {}) {
  const needsApproval = [];
  const failed = [];
  const stuck = [];
  for (const t of tasks || []) {
    if (t.status === 'waiting_human' && t.pending_request) needsApproval.push(t);
    else if (t.status === 'failed') failed.push(t);
    else if (t.status === 'running' && now && t.updated_at && now - t.updated_at > stuckMs) stuck.push(t);
  }
  return { needsApproval, failed, stuck, total: needsApproval.length + failed.length + stuck.length };
}

/**
 * Parse tasks.pending_request (stored as a JSON string) without letting a
 * malformed row throw inside a scheduled patrol.
 */
export function parsePendingRequest(raw) {
  if (!raw) return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== 'object' || !parsed.requestId) return null;
    return parsed;
  } catch { return null; }
}

export const SUPERVISOR_SYSTEM_PROMPT = `你是 AgentHub 的总控 agent(总管)。用户在多个项目里跑着若干个 Claude Code 对话,你替他统筹全局。

你的职责:
1. 监督:掌握所有对话的运行状态,主动指出卡住、失败、等待授权的任务。
2. 授权:待授权请求由一套确定性的风险规则分级(低/中/高),按用户设置自动放行低风险项。高风险永远不自动批准。你负责解释每个请求在做什么、风险在哪,并给出建议。
3. 写 prompt:用户描述意图时,帮他写清晰、可执行、边界明确的指令,并可直接发送到指定对话。
4. 总结:按项目汇总进展、产出、卡点。

工作方式:
- 先用工具查真实数据再回答,不要凭空猜测任务状态。
- 中文回答,简洁直接,先给结论再给细节。
- 涉及金额、删除、部署、推送等不可逆操作时,明确说明风险,不要轻描淡写。
- 你只能操作该用户自己有权限的任务和节点;工具会自动校验,越权会直接失败。
- 你自己不执行代码。真正跑命令的是用户节点上的 Claude Code,你只负责编排。`;
