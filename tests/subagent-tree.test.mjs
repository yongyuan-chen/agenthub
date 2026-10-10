import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSubagentTree, cleanReport, countByStatus, isSubagentInternal } from '../packages/web/src/subagent-tree.js';

let seq = 0;
const msg = (role, content) => { seq++; return { seq, role, content, created_at: seq * 1000 }; };
const spawn = (id, description, extra = {}) =>
  msg('tool_use', { id, name: 'Agent', input: { description, subagent_type: 'implementer', prompt: `do ${description}` }, ...extra });

test('subagent tree: parallel spawns, nesting through parentToolUseId, and outcomes', () => {
  const messages = [
    spawn('a', 'A'),
    msg('tool_use', { id: 'b', name: 'Task', input: { description: 'B', subagent_type: 'explorer', prompt: 'look' } }),
    msg('tool_use', { id: 'bash-a', name: 'Bash', input: { command: 'ls' }, parentToolUseId: 'a' }),
    spawn('a1', 'A child', { parentToolUseId: 'a' }),
    msg('tool_result', { tool_use_id: 'a1', is_error: false, content: [{ type: 'text', text: 'child ok' }], parentToolUseId: 'a' }),
    msg('tool_result', { tool_use_id: 'a', is_error: false, content: 'A done' }),
    msg('tool_result', { tool_use_id: 'b', is_error: true, content: 'B broke' }),
  ];
  const { roots, byId } = buildSubagentTree(messages, { status: 'review' });
  assert.deepEqual(roots.map(n => n.id), ['a', 'b']);
  assert.deepEqual(roots[0].children.map(n => n.id), ['a1']);
  assert.equal(byId.get('a').status, 'done');
  assert.equal(byId.get('b').status, 'error');
  assert.equal(byId.get('b').subagentType, 'explorer');
  assert.equal(byId.get('a1').report, 'child ok');
  // A's own steps: its Bash call and its spawn of a1 — not a1's internals.
  assert.deepEqual(byId.get('a').toolUses.map(m => m.content.id), ['bash-a', 'a1']);
  assert.deepEqual(countByStatus(byId), { running: 0, done: 2, error: 1, stopped: 0, interrupted: 0 });
});

test('subagent tree: no outcome is running while the task is live, interrupted once it is not', () => {
  const messages = [spawn('x', 'X')];
  assert.equal(buildSubagentTree(messages, { status: 'running' }).byId.get('x').status, 'running');
  assert.equal(buildSubagentTree(messages, { status: 'waiting_human' }).byId.get('x').status, 'running');
  assert.equal(buildSubagentTree(messages, { status: 'failed' }).byId.get('x').status, 'interrupted');
});

test('subagent tree: a backgrounded subagent is done only when its finished event says so', () => {
  const launched = [
    spawn('bg', 'BG'),
    msg('agent_event', { toolUseId: 'bg', phase: 'started', background: true }),
    msg('tool_result', { tool_use_id: 'bg', is_error: false, content: 'launched in background' }),
    msg('agent_event', { toolUseId: 'bg', phase: 'progress', lastToolName: 'Bash', description: 'Running tests', usage: { toolUses: 3 } }),
  ];
  // The launch receipt is not an outcome, and the turn ending doesn't end it
  // either — only the process going away does.
  const running = buildSubagentTree(launched, { status: 'review' }).byId.get('bg');
  assert.equal(running.status, 'running');
  assert.equal(buildSubagentTree(launched, { status: 'failed' }).byId.get('bg').status, 'interrupted');
  assert.equal(running.lastTool, 'Bash');
  assert.equal(running.activity, 'Running tests');
  const finished = buildSubagentTree([...launched, msg('agent_event', { toolUseId: 'bg', phase: 'finished', status: 'completed', summary: 'all green' })], { status: 'review' }).byId.get('bg');
  assert.equal(finished.status, 'done');
  assert.equal(finished.report, 'all green');
  assert.ok(finished.endedAt > finished.startedAt, 'timed from spawn to finished event');
  const failed = buildSubagentTree([...launched, msg('agent_event', { toolUseId: 'bg', phase: 'finished', status: 'failed' })], { status: 'review' }).byId.get('bg');
  assert.equal(failed.status, 'error');
});

test('subagent tree: the CLI hand-back frame is stripped from reports', () => {
  const framed = '[Subagent hand-back] The text below is the final report of a subagent.\nThe report follows:\n  line one\n  line two\nagentId: abc\n<usage>subagent_tokens: 1</usage>';
  assert.equal(cleanReport(framed), 'line one\nline two');
  assert.equal(cleanReport('plain'), 'plain');
});

test('subagent tree: only subagent output counts as internal', () => {
  assert.equal(isSubagentInternal({ role: 'assistant', content: { text: 'x', parentToolUseId: 'a' } }), true);
  assert.equal(isSubagentInternal({ role: 'assistant', content: { text: 'x' } }), false);
  assert.deepEqual(buildSubagentTree([msg('tool_use', { id: 'r', name: 'Read', input: {} })]).roots, []);
});
