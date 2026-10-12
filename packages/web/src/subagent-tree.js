// Builds the 子代理 tab's tree out of a conversation's flat message list.
// Kept free of React so tests/subagent-tree.test.mjs can run it directly.
//
// What the executor records (manager.mjs, verified against claude 2.1.296):
// - a subagent is created by a tool_use named Agent (Task on older CLIs) with
//   input {description, subagent_type, prompt, run_in_background?, name?};
// - the router hands it more work later with a SendMessage tool_use
//   {to: <agentId or name>, message, summary?} — same subagent, same context;
// - everything the subagent says or does, in any of its runs, carries
//   content.parentToolUseId = the id of the Agent call that *created* it —
//   including its own Agent calls, which is what nests the tree;
// - its lifecycle arrives as role 'agent_event' {toolUseId, agentId, phase,
//   ...}, where toolUseId is the Agent or SendMessage call of that run and
//   agentId is the subagent's identity across all of them;
// - an Agent call's tool_result is the subagent's report (ending in an
//   "agentId: <id>" line) — except for a backgrounded run, whose tool_result
//   is only a launch receipt and whose real end is the 'finished' event. Every
//   SendMessage run is backgrounded.

export const SPAWN_TOOL_NAMES = new Set(['Agent', 'Task']);
export const CONTINUE_TOOL_NAME = 'SendMessage';

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

const AGENT_ID_LINE = /\nagentId: (\S+)/;

function newRun(m, kind, prompt, background) {
  return {
    toolUseId: m.content.id, kind, prompt, background, seq: m.seq,
    status: 'running', startedAt: stamp(m), endedAt: null,
    toolUses: [], usage: null, report: '', result: null, finished: null,
  };
}

// One run's outcome, from its own finished event / tool_result.
function settleRun(run, task) {
  if (run.finished) {
    run.status = finishedStatus(run.finished.status);
    run.endedAt = run.finished.ts;
    run.report = run.finished.summary || (run.background ? '' : cleanReport(run.result?.text));
  } else if (run.result && !run.background) {
    run.status = run.result.isError ? 'error' : 'done';
    run.endedAt = run.result.ts;
    run.report = cleanReport(run.result.text);
  } else {
    // No outcome yet: still going while the CLI is, otherwise the turn (or
    // process) ended under it.
    const going = run.background ? !ENDED_TASK_STATUSES.has(task?.status) : LIVE_TASK_STATUSES.has(task?.status);
    run.status = going ? 'running' : 'interrupted';
  }
}

/**
 * One node per subagent, however many times it was handed work.
 *
 * @param {Array<{seq, role, content, created_at?}>} messages
 * @param {{status?: string}=} task
 * @returns {{roots: object[], byId: Map<string, object>}}  byId is keyed by node id
 *   node: {id (the creating Agent call's id), agentId, description, subagentType,
 *          runs: [{toolUseId, kind ('spawn'|'continue'), prompt, background,
 *                  status, startedAt, endedAt, toolUses, usage, report}],
 *          status/report/usage (of the latest run), startedAt (first run),
 *          endedAt (latest run), toolUses (all runs), lastTool, activity, children}
 *   status: 'running'|'done'|'error'|'stopped'|'interrupted'
 */
export function buildSubagentTree(messages, task = null) {
  const byId = new Map();
  const order = [];
  const runByToolUseId = new Map();
  for (const m of messages) {
    if (!isSpawn(m)) continue;
    const input = m.content.input || {};
    const run = newRun(m, 'spawn', input.prompt || '', input.run_in_background === true);
    const node = {
      id: m.content.id,
      parentId: m.content.parentToolUseId || null,
      agentId: null,
      name: input.name || null,
      description: input.description || '',
      subagentType: input.subagent_type || 'general-purpose',
      runs: [run],
      toolUses: [],
      lastTool: null,
      activity: '',
      children: [],
    };
    byId.set(node.id, node);
    runByToolUseId.set(run.toolUseId, { node, run });
    order.push(node);
  }
  if (!order.length) return { roots: [], byId };

  // Every subagent's identity, from its lifecycle events and, for history
  // recorded before events carried it, from its report's trailing line.
  const agentIdOfRun = new Map();
  for (const m of messages) {
    const c = m.content || {};
    if (m.role === 'agent_event' && c.agentId && c.toolUseId) agentIdOfRun.set(c.toolUseId, c.agentId);
    if (m.role === 'tool_result' && byId.has(c.tool_use_id)) {
      const hit = AGENT_ID_LINE.exec(resultText(c.content));
      if (hit && !agentIdOfRun.has(c.tool_use_id)) agentIdOfRun.set(c.tool_use_id, hit[1]);
    }
  }
  const byAgent = new Map();
  for (const node of order) {
    node.agentId = agentIdOfRun.get(node.id) ?? null;
    if (node.agentId) byAgent.set(node.agentId, node);
    if (node.name) byAgent.set(node.name, node);
  }

  // Continuations: the run's own event names the subagent; failing that, the
  // address the router used.
  for (const m of messages) {
    if (m.role !== 'tool_use' || m.content?.name !== CONTINUE_TOOL_NAME) continue;
    const input = m.content.input || {};
    const node = byAgent.get(agentIdOfRun.get(m.content.id)) ?? byAgent.get(input.to);
    if (!node) continue;
    const run = newRun(m, 'continue', input.message || input.summary || '', true);
    node.runs.push(run);
    runByToolUseId.set(run.toolUseId, { node, run });
  }
  for (const node of order) node.runs.sort((a, b) => a.seq - b.seq);

  for (const m of messages) {
    const c = m.content || {};
    if (m.role === 'agent_event') {
      const hit = runByToolUseId.get(c.toolUseId);
      if (!hit) continue;
      const { node, run } = hit;
      if (c.background) run.background = true;
      if (c.phase === 'progress') {
        if (c.lastToolName) node.lastTool = c.lastToolName;
        if (c.description) node.activity = c.description;
      }
      if (c.usage) run.usage = c.usage;
      if (c.phase === 'finished') run.finished = { status: c.status, summary: c.summary, ts: stamp(m) };
    } else if (m.role === 'tool_result') {
      const hit = runByToolUseId.get(c.tool_use_id);
      if (hit) hit.run.result = { isError: !!c.is_error, text: resultText(c.content), ts: stamp(m) };
    } else if (m.role === 'tool_use' && c.parentToolUseId) {
      const node = byId.get(c.parentToolUseId);
      if (!node) continue;
      node.toolUses.push(m);
      node.lastTool = c.name;
      // A step belongs to the latest run handed out before it.
      const run = [...node.runs].reverse().find(r => r.seq < m.seq) ?? node.runs[0];
      run.toolUses.push(m);
    }
  }

  for (const node of order) {
    for (const run of node.runs) settleRun(run, task);
    const latest = node.runs[node.runs.length - 1];
    node.status = latest.status;
    node.report = latest.report;
    node.usage = latest.usage;
    node.startedAt = node.runs[0].startedAt;
    node.endedAt = latest.endedAt;
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
