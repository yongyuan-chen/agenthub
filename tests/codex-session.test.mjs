// CodexSession against tests/fake-codex.mjs — a real child process speaking the
// real NDJSON dialect, but zero network and zero cost. What matters here isn't
// that Codex works, it's that CodexSession hands manager.mjs the *Anthropic*
// message shapes _onSdkMessage already understands, so the event log, approval
// flow, state machine and frontend stay backend-agnostic.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CodexSession,
  codexPolicyFor,
  codexHomeFor,
  errorCodeOf,
  relayProviderConfig,
  TRANSIENT_ERROR_CODES,
  RELAY_PROVIDER_ID,
  RELAY_KEY_ENV,
} from '../packages/executor/src/codex-session.mjs';

const FAKE = fileURLToPath(new URL('./fake-codex.mjs', import.meta.url));

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ah-codex-'));
}

// The scenario travels in the child's env. CodexSession captures process.env
// synchronously inside start(), so setting it around that one call is safe even
// if the runner ever starts these concurrently — no window exists where another
// test's spawn could read the wrong value.
function launch(scenario, opts = {}) {
  const work = opts.workRoot ?? tmpdir();
  const messages = [];
  const exits = [];
  const session = new CodexSession({
    config: {
      codexBin: FAKE,
      workRoot: work,
      provider: { baseUrl: 'https://relay.example/v1', apiKey: 'sk-relay-test', model: 'gpt-5.6-sol' },
    },
    cwd: work,
    taskId: opts.taskId ?? 'task-1',
    resumeSessionId: opts.resumeSessionId,
    realConfigDir: opts.realConfigDir,
    permissionMode: opts.permissionMode ?? 'default',
    onMessage: m => messages.push(m),
    onPermission: opts.onPermission ?? (async () => ({ behavior: 'deny', message: 'no' })),
    onWithdrawPermission: opts.onWithdrawPermission,
    onExit: e => exits.push(e ?? null),
  });

  const prev = process.env.FAKE_CODEX_SCENARIO;
  const prevDump = process.env.FAKE_CODEX_DUMP;
  process.env.FAKE_CODEX_SCENARIO = scenario;
  if (opts.dump) process.env.FAKE_CODEX_DUMP = opts.dump;
  try { session.start(); } finally {
    if (prev === undefined) delete process.env.FAKE_CODEX_SCENARIO; else process.env.FAKE_CODEX_SCENARIO = prev;
    if (prevDump === undefined) delete process.env.FAKE_CODEX_DUMP; else process.env.FAKE_CODEX_DUMP = prevDump;
  }
  return { session, messages, exits, work };
}

async function waitFor(fn, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await new Promise(r => setTimeout(r, 10));
  }
}

const results = msgs => msgs.filter(m => m.type === 'result');
const texts = msgs => msgs.flatMap(m =>
  m.type === 'assistant' ? (m.message.content ?? []).filter(b => b.type === 'text').map(b => b.text) : []);

test('handshake queues an early send, and Codex items become Anthropic blocks', async (t) => {
  const dump = path.join(tmpdir(), 'wire.ndjson');
  const { session, messages } = launch('basic', { dump });
  t.after(() => session.kill());

  // send() lands on the very next line after start() in manager's _spawn —
  // long before initialize/thread/start have come back. It must queue, not drop.
  assert.equal(session.send('你好'), true);
  assert.equal(session.busy, true, 'busy is set synchronously so manager can serialize');
  assert.equal(session.alive, true, 'alive is set synchronously so runningCount() sees it');

  await waitFor(() => results(messages).length === 1, 'first turn result');

  const init = messages.find(m => m.type === 'system' && m.subtype === 'init');
  assert.ok(init, 'emits a claude-shaped init line');
  assert.equal(init.session_id, 'th-fake-1');
  assert.equal(session.sessionId, 'th-fake-1');

  // reasoning -> thinking
  const thinking = messages.flatMap(m =>
    m.type === 'assistant' ? (m.message.content ?? []).filter(b => b.type === 'thinking') : []);
  assert.deepEqual(thinking.map(b => b.thinking), ['先看看目录']);

  // commandExecution / fileChange -> tool_use then tool_result
  const toolUses = messages.flatMap(m =>
    m.type === 'assistant' ? (m.message.content ?? []).filter(b => b.type === 'tool_use') : []);
  const toolResults = messages.flatMap(m =>
    m.type === 'user' ? (m.message.content ?? []).filter(b => b.type === 'tool_result') : []);
  assert.deepEqual(toolUses.map(b => [b.id, b.name]), [['i2', 'Bash'], ['i3', 'Edit']]);
  assert.deepEqual(toolUses[0].input, { command: 'ls', cwd: '/tmp' });
  assert.deepEqual(toolResults.map(b => [b.tool_use_id, b.content, b.is_error]), [
    ['i2', 'out.txt\n', false],
    ['i3', '+hello', false],
  ]);

  // The delta and item/started lines must be ignored: manager appends every
  // event it is given, so translating both would render the reply twice.
  assert.deepEqual(texts(messages), ['回复1:你好']);

  // tokenUsage is authoritative for codex (no on-disk tailing), and carries
  // the real window that auto-compaction keys off.
  const usage = messages.filter(m => m.type === 'assistant' && m.message.usage);
  assert.deepEqual(usage.map(m => m.message.usage), [{ input_tokens: 4321 }]);
  assert.equal(session.caps.contextWindow, 258400);
  assert.equal(session.caps.reportsCost, false, 'codex reports tokens but never dollars');

  const r = results(messages)[0];
  assert.equal(r.subtype, 'success');
  assert.equal(r.is_error, false);
  assert.equal(r.error_code, null);
  assert.equal('total_cost_usd' in r, false, 'no fabricated $0.00');
  assert.equal(session.busy, false);

  // A second turn on the same process, this time with an image.
  session.send('看图', [{ mediaType: 'image/png', data: 'AAAA' }]);
  await waitFor(() => results(messages).length === 2, 'second turn result');
  assert.deepEqual(texts(messages), ['回复1:你好', '回复2:data:image/png;base64,AAAA|看图']);

  // What actually went on the wire: one inline relay provider block, the
  // permission-mode mapping, and the pinned model.
  const wire = fs.readFileSync(dump, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const startReq = wire.find(m => m.method === 'thread/start');
  assert.ok(startReq, 'started a thread rather than resuming');
  assert.equal(startReq.params.approvalPolicy, 'untrusted');
  assert.equal(startReq.params.sandbox, 'workspace-write');
  assert.equal(startReq.params.model, 'gpt-5.6-sol');
  assert.equal(startReq.params.modelProvider, RELAY_PROVIDER_ID);
  const block = startReq.params.config.model_providers[RELAY_PROVIDER_ID];
  assert.equal(block.base_url, 'https://relay.example/v1');
  assert.equal(block.wire_api, 'responses', 'chat wire_api was removed upstream');
  assert.equal(block.env_key, RELAY_KEY_ENV);
  assert.equal(JSON.stringify(startReq).includes('sk-relay-test'), false,
    'the key travels in the child env, never in a config the rollout could record');

  // Turns are serialized: the second turn/start only goes out after the first
  // turn/completed, so nothing was dropped and nothing overlapped.
  assert.equal(wire.filter(m => m.method === 'turn/start').length, 2);
});

test('resumeSessionId resumes the thread instead of starting a new one', async (t) => {
  const dump = path.join(tmpdir(), 'wire.ndjson');
  const { session, messages } = launch('basic', { dump, resumeSessionId: 'th-existing' });
  t.after(() => session.kill());

  session.send('继续');
  await waitFor(() => results(messages).length === 1, 'result');
  assert.equal(session.sessionId, 'th-existing');

  const wire = fs.readFileSync(dump, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(wire.some(m => m.method === 'thread/start'), false);
  const resume = wire.find(m => m.method === 'thread/resume');
  assert.equal(resume.params.threadId, 'th-existing');
});

test('approval request ids are namespaced, so two concurrent tasks do not cross wires', async (t) => {
  // Codex hands out small per-connection integers, so both fakes ask with
  // id 1. manager's pendingDecisions is one process-wide Map keyed only by
  // requestId — decide() never checks taskId — so without the namespace the
  // second task would evict the first and answer the wrong one.
  const seen = [];
  const mk = (taskId, behavior) => launch('approval', {
    taskId,
    onPermission: async (req) => {
      seen.push(req);
      return { behavior };
    },
  });

  const a = mk('task-A', 'allow');
  const b = mk('task-B', 'deny');
  t.after(() => { a.session.kill(); b.session.kill(); });

  a.session.send('删点东西');
  b.session.send('也删点东西');

  await waitFor(() => results(a.messages).length && results(b.messages).length, 'both turns done');

  assert.equal(seen.length, 2);
  const ids = seen.map(r => r.requestId).sort();
  assert.deepEqual(ids, ['codex:task-A:1', 'codex:task-B:1']);
  assert.equal(new Set(ids).size, 2, 'no collision despite identical json-rpc ids');

  // The decision each fake actually received back, proving the answers did not
  // get swapped between the two processes.
  assert.deepEqual(texts(a.messages), ['决定=accept']);
  assert.deepEqual(texts(b.messages), ['决定=decline']);

  // The approval carried enough for a human to judge it.
  const one = seen.find(r => r.requestId === 'codex:task-A:1');
  assert.equal(one.toolName, 'Bash');
  assert.deepEqual(one.input, { command: 'rm -rf build', cwd: '/tmp' });
  assert.equal(one.description, '要删构建产物');
});

test('serverRequest/resolved withdraws a pending approval instead of hanging for 4 hours', async (t) => {
  const withdrawn = [];
  let answered = false;
  const { session, messages } = launch('withdraw', {
    taskId: 'task-W',
    // A human who never answers — exactly the state Codex withdrawing the
    // request has to be able to break out of.
    onPermission: () => new Promise(() => { answered = true; }),
    onWithdrawPermission: id => withdrawn.push(id),
  });
  t.after(() => session.kill());

  session.send('删点东西');
  await waitFor(() => withdrawn.length === 1, 'withdrawal');
  assert.deepEqual(withdrawn, ['codex:task-W:1']);
  assert.equal(answered, true, 'the human was asked before the request was taken back');

  const r = await waitFor(() => results(messages)[0], 'aborted result');
  assert.equal(r.subtype, 'aborted');
  assert.equal(r.is_error, true);
});

test('error{willRetry} is shown, not failed on; willRetry:false settles the turn with a code', async (t) => {
  const { session, messages } = launch('retry');
  t.after(() => session.kill());

  session.send('干活');
  const r = await waitFor(() => results(messages)[0], 'final result');

  // Codex retries internally. Emitting a failed result for the first error
  // would race that recovery and could mark the task failed mid-retry.
  assert.ok(texts(messages).some(t2 => t2.includes('上游抖了一下')), 'the retry is visible');
  assert.equal(results(messages).length, 1, 'only the terminal error settles the turn');

  assert.equal(r.is_error, true);
  assert.ok(r.result.includes('上游还是不行'));
  // Structured, from the protocol's own enum — the claude path has to guess
  // this from a regex over the message text.
  assert.equal(r.error_code, 'responseStreamDisconnected');
  assert.equal(TRANSIENT_ERROR_CODES.has(r.error_code), true, 'manager will schedule an auto-retry');
  assert.equal(session.busy, false);
});

test('a context-window overflow arrives as a structured code, not a regex match', async (t) => {
  const { session, messages } = launch('overflow');
  t.after(() => session.kill());

  session.send('一段很长的东西');
  const r = await waitFor(() => results(messages)[0], 'result');
  assert.equal(r.is_error, true);
  assert.equal(r.error_code, 'contextWindowExceeded');
  assert.equal(TRANSIENT_ERROR_CODES.has(r.error_code), false, 'compaction, not a blind retry');
});

test('a failed handshake calls onExit(err) so the task can reach failed', async (t) => {
  const { session, exits } = launch('handshake-fail');
  t.after(() => session.kill());

  session.send('你好');
  const err = await waitFor(() => exits[0], 'exit');
  // _onSessionExit is the only route out of 'running'; without this the task
  // would sit there until the idle sweeper eventually noticed.
  assert.ok(err instanceof Error);
  assert.ok(/initialize refused/.test(err.message), err.message);
  assert.equal(session.alive, false);
  assert.equal(exits.length, 1, 'the child exit must not report a second time');
});

test('interrupt before the handshake completes drops the queued turn', async (t) => {
  const { session, messages } = launch('basic');
  t.after(() => session.kill());

  session.send('别做了');
  session.interrupt();

  await new Promise(r => setTimeout(r, 250));
  assert.equal(texts(messages).length, 0, 'the turn the user cancelled never ran');
});

test('compact() uses the RPC rather than sending "/compact" as conversation text', async (t) => {
  const dump = path.join(tmpdir(), 'wire.ndjson');
  const { session, messages } = launch('basic', { dump });
  t.after(() => session.kill());

  session.send('你好');
  await waitFor(() => results(messages).length === 1, 'result');

  assert.equal(session.compact(), true);
  await waitFor(() => messages.some(m => m.type === 'system' && m.subtype === 'compacted'), 'compacted');

  const wire = fs.readFileSync(dump, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(wire.find(m => m.method === 'thread/compact/start'));
  const sent = wire.filter(m => m.method === 'turn/start').flatMap(m => m.params.input.map(i => i.text));
  assert.equal(sent.includes('/compact'), false, 'the literal never reaches the model as a prompt');
});

test('resumeHint carries CODEX_HOME, without which `codex resume` cannot find the session', async (t) => {
  const { session, messages, work } = launch('basic');
  t.after(() => session.kill());

  session.send('你好');
  await waitFor(() => results(messages).length === 1, 'result');
  assert.equal(session.resumeHint(), `CODEX_HOME=${path.join(work, 'codex-home')} codex resume th-fake-1`);
});

// ---- pure helpers ----

test('codexPolicyFor maps AgentHub permission modes onto both Codex dimensions', () => {
  assert.deepEqual(codexPolicyFor('bypassPermissions'), { approvalPolicy: 'never', sandbox: 'danger-full-access' });
  assert.deepEqual(codexPolicyFor('acceptEdits'), { approvalPolicy: 'on-request', sandbox: 'workspace-write' });
  assert.deepEqual(codexPolicyFor('default'), { approvalPolicy: 'untrusted', sandbox: 'workspace-write' });
  // An unknown mode must land on the strictest option, never the loosest.
  assert.deepEqual(codexPolicyFor('something-new'), { approvalPolicy: 'untrusted', sandbox: 'workspace-write' });
});

test('errorCodeOf reads both codexErrorInfo encodings', () => {
  assert.equal(errorCodeOf('contextWindowExceeded'), 'contextWindowExceeded');
  assert.equal(errorCodeOf({ responseStreamDisconnected: { httpStatusCode: 502 } }), 'responseStreamDisconnected');
  assert.equal(errorCodeOf(null), null);
  assert.equal(errorCodeOf({}), null);
});

test('codexHomeFor isolates ordinary tasks and only uses the real ~/.codex when asked', () => {
  const config = { workRoot: '/srv/agenthub' };
  assert.equal(codexHomeFor(config, false), path.join('/srv/agenthub', 'codex-home'));
  assert.equal(codexHomeFor(config, true), path.join(os.homedir(), '.codex'));
});

test('relayProviderConfig never embeds the key', () => {
  const cfg = relayProviderConfig({ baseUrl: 'https://x/v1', apiKey: 'sk-secret' });
  assert.equal(JSON.stringify(cfg).includes('sk-secret'), false);
  assert.equal(cfg.model_providers[RELAY_PROVIDER_ID].env_key, RELAY_KEY_ENV);
});
