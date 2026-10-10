// Builds the 子代理 tab's tree out of a conversation's flat message list.
// Kept free of React so tests/subagent-tree.test.mjs can run it directly.
//
// What the executor records (manager.mjs, verified against claude 2.1.296):
// - the spawn itself is an ordinary tool_use named Agent (Task on older CLIs)
//   with input {description, subagent_type, prompt, run_in_background?};
// - everything the subagent then says or does carries
//   content.parentToolUseId = that tool_use's id — including its own Agent
//   calls, which is what nests the tree;
// - its lifecycle arrives as role 'agent_event' {toolUseId, phase, ...};
// - the spawn's tool_result is the subagent's final report — except for a
//   backgrounded subagent, whose tool_result is only the launch receipt and
//   whose real end is the 'finished' agent_event.

export const SPAWN_TOOL_NAMES = new Set(['Agent', 'Task']);

// Statuses in which the CLI process is still working on the conversation;
// a subagent with no outcome yet is only "running" while the task is in one.
const LIVE_TASK_STATUSES = new Set(['running', 'starting', 'waiting_human']);
// A backgrounded subagent outlives the turn that launched it: the CLI process
// stays warm after 'result' (status 'review') and reports it finished later.
// Only these mean that process is gone.
const ENDED_TASK_STATUSES = new Set(['failed', 'cancelled', 'done']);

// Messages in the store carry their time as created_at (store.js, both the
// REST pages and live 'msg' pushes).
const stamp = (m) => m.created_at ?? null;

const isSpawn = (m) => m.role === 'tool_use' && SPAWN_TOOL_NAMES.has(m.content?.name);

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(b => (typeof b === 'string' ? b : b?.text ?? '')).filter(Boolean).join('\n');
  return '';
}

// The CLI wraps a subagent's report in a hand-back frame and indents it; show
// just the report.
export function cleanReport(text) {
  if (!text) return '';
  let out = text;
  const marker = out.indexOf('The report follows:\n');
  if (marker >= 0) out = out.slice(marker + 'The report follows:\n'.length);
  out = out.replace(/\nagentId: [^\n]*[\s\S]*$/, '');
  return out.split('\n').map(l => l.replace(/^ {2}/, '')).join('\n').trim();
}

// finished-event status -> node status. Anything the CLI reports that isn't
// a success is shown as failed rather than guessed at.
function finishedStatus(status) {
  if (status === 'completed') return 'done';
  if (status === 'killed' || status === 'stopped' || status === 'cancelled') return 'stopped';
  return 'error';
}

/**
 * @param {Array<{seq, role, content, created_at?}>} messages
 * @param {{status?: string}=} task
 * @returns {{roots: object[], byId: Map<string, object>}}
 *   node: {id, description, subagentType, prompt, background, status
 *          ('running'|'done'|'error'|'stopped'|'interrupted'), startedAt,
 *          endedAt, toolUses (this subagent's own tool_use messages, spawns
 *          included), lastTool, activity, usage, report, children}
 */
export function buildSubagentTree(messages, task = null) {
  const byId = new Map();
  const order = [];
  for (const m of messages) {
    if (!isSpawn(m)) continue;
    const input = m.content.input || {};
    const node = {
      id: m.content.id,
      parentId: m.content.parentToolUseId || null,
      seq: m.seq,
      description: input.description || '',
      subagentType: input.subagent_type || 'general-purpose',
      prompt: input.prompt || '',
      background: input.run_in_background === true,
      status: 'running',
      startedAt: stamp(m),
      endedAt: null,
      toolUses: [],
      lastTool: null,
      activity: '',
      usage: null,
      report: '',
      result: null,
      finished: null,
      children: [],
    };
    byId.set(node.id, node);
    order.push(node);
  }
  if (!order.length) return { roots: [], byId };

  for (const m of messages) {
    const c = m.content || {};
    if (m.role === 'agent_event') {
      const node = byId.get(c.toolUseId);
      if (!node) continue;
      if (c.background) node.background = true;
      if (c.phase === 'progress') {
        if (c.lastToolName) node.lastTool = c.lastToolName;
        if (c.description) node.activity = c.description;
      }
      if (c.usage) node.usage = c.usage;
      if (c.phase === 'finished') node.finished = { status: c.status, summary: c.summary, ts: stamp(m) };
    } else if (m.role === 'tool_result') {
      const node = byId.get(c.tool_use_id);
      if (node) node.result = { isError: !!c.is_error, text: resultText(c.content), ts: stamp(m) };
    } else if (m.role === 'tool_use' && c.parentToolUseId) {
      const owner = byId.get(c.parentToolUseId);
      if (owner) { owner.toolUses.push(m); owner.lastTool = c.name; }
    }
  }

  const live = LIVE_TASK_STATUSES.has(task?.status);
  for (const node of order) {
    if (node.finished) {
      node.status = finishedStatus(node.finished.status);
      node.endedAt = node.finished.ts;
      node.report = node.finished.summary || (node.background ? '' : cleanReport(node.result?.text));
    } else if (node.result && !node.background) {
      node.status = node.result.isError ? 'error' : 'done';
      node.endedAt = node.result.ts;
      node.report = cleanReport(node.result.text);
    } else {
      // No outcome yet: still going while the CLI is, otherwise the turn (or
      // process) ended under it.
      const going = node.background ? !ENDED_TASK_STATUSES.has(task?.status) : live;
      node.status = going ? 'running' : 'interrupted';
    }
  }

  const roots = [];
  for (const node of order) {
    const parent = node.parentId && byId.get(node.parentId);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return { roots, byId };
}

// Counts for the tab label / root row.
export function countByStatus(byId) {
  const counts = { running: 0, done: 0, error: 0, stopped: 0, interrupted: 0 };
  for (const node of byId.values()) counts[node.status] = (counts[node.status] ?? 0) + 1;
  return counts;
}

// True for messages the main chat should not show for a multiagent
// conversation: subagent internals live in the 子代理 tab instead.
export function isSubagentInternal(m) {
  return !!m.content?.parentToolUseId;
}
