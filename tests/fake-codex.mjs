#!/usr/bin/env node
// Stand-in for `codex app-server --stdio`, used as config.codexBin in
// codex-session.test.mjs. Speaks the same JSON-RPC-over-NDJSON dialect the real
// binary does (no `jsonrpc` field on the wire) and plays one canned scenario,
// picked by FAKE_CODEX_SCENARIO. Zero network, zero cost, deterministic.
//
// It also appends every inbound request to FAKE_CODEX_DUMP (when set), so a
// test can assert what CodexSession actually put on the wire (the inline relay
// provider block, the approval policy / sandbox mapping, the pinned model) —
// stdin isn't observable from the parent any other way.
import readline from 'node:readline';
import fs from 'node:fs';

const scenario = process.env.FAKE_CODEX_SCENARIO || 'basic';
const dump = process.env.FAKE_CODEX_DUMP || null;
const record = (msg) => { if (dump) fs.appendFileSync(dump, JSON.stringify(msg) + '\n'); };
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Server->client requests get small per-connection integer ids, exactly like
// the real thing — which is the whole reason CodexSession namespaces them.
let nextServerId = 0;
const awaitingClient = new Map(); // server request id -> resolve(clientResult)
function askClient(method, params) {
  const id = ++nextServerId;
  return { id, answered: new Promise(resolve => { awaitingClient.set(id, resolve); out({ id, method, params }); }) };
}

let turnNo = 0;

async function runTurn(req) {
  turnNo++;
  const done = (status = 'completed', error = null) =>
    out({ method: 'turn/completed', params: { turn: { id: `t${turnNo}`, status, durationMs: 12, ...(error ? { error } : {}) } } });

  switch (scenario) {
    case 'basic': {
      out({ method: 'item/agentMessage/delta', params: { delta: '部' } });   // must be ignored
      out({ method: 'item/started', params: { item: { id: 'i1', type: 'agentMessage' } } }); // must be ignored
      out({ method: 'item/completed', params: { item: { id: 'i1', type: 'reasoning', summary: ['先看看目录'] } } });
      out({ method: 'item/completed', params: { item: { id: 'i2', type: 'commandExecution', command: 'ls', cwd: '/tmp', status: 'completed', exitCode: 0, aggregatedOutput: 'out.txt\n' } } });
      out({ method: 'item/completed', params: { item: { id: 'i3', type: 'fileChange', status: 'completed', changes: [{ path: 'a.txt', kind: 'add', diff: '+hello' }] } } });
      out({ method: 'item/completed', params: { item: { id: 'i4', type: 'agentMessage', text: `回复${turnNo}:${req.params.input.map(i => i.text ?? i.url).join('|')}` } } });
      out({ method: 'thread/tokenUsage/updated', params: { tokenUsage: { last: { inputTokens: 4321, cachedInputTokens: 100 }, modelContextWindow: 258400 } } });
      done();
      return;
    }
    case 'approval': {
      const { answered } = askClient('item/commandExecution/requestApproval', { command: 'rm -rf build', cwd: '/tmp', reason: '要删构建产物' });
      const reply = await answered;
      out({ method: 'item/completed', params: { item: { id: 'i1', type: 'agentMessage', text: `决定=${reply.result?.decision}` } } });
      done();
      return;
    }
    case 'withdraw': {
      askClient('item/commandExecution/requestApproval', { command: 'rm -rf build', cwd: '/tmp' });
      await sleep(30);
      // Codex takes the request back, e.g. because the turn was interrupted.
      out({ method: 'serverRequest/resolved', params: { requestId: nextServerId } });
      done('aborted');
      return;
    }
    case 'retry': {
      out({ method: 'error', params: { willRetry: true, error: { message: '上游抖了一下', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } } } } });
      await sleep(10);
      out({ method: 'error', params: { willRetry: false, error: { message: '上游还是不行', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } } } } });
      return; // no turn/completed: the error notification settles the turn
    }
    case 'overflow': {
      done('failed', { message: 'prompt is too long', codexErrorInfo: 'contextWindowExceeded' });
      return;
    }
    default:
      done();
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  record(msg);

  // A response to something this fake asked for (an approval decision).
  if (msg.id !== undefined && msg.method === undefined) {
    const resolve = awaitingClient.get(msg.id);
    if (resolve) { awaitingClient.delete(msg.id); resolve(msg); }
    return;
  }

  switch (msg.method) {
    case 'initialize':
      if (scenario === 'handshake-fail') out({ id: msg.id, error: { code: -32000, message: 'initialize refused' } });
      else out({ id: msg.id, result: { userAgent: 'fake-codex/0' } });
      return;
    case 'initialized':
      return;
    case 'thread/start':
    case 'thread/resume':
      out({ method: 'thread/started', params: { threadId: msg.params.threadId ?? 'th-fake-1' } });
      out({ id: msg.id, result: { thread: { id: msg.params.threadId ?? 'th-fake-1', ...msg.params } } });
      return;
    case 'turn/start':
      out({ id: msg.id, result: {} });
      await runTurn(msg);
      return;
    case 'thread/compact/start':
      out({ id: msg.id, result: {} });
      out({ method: 'thread/compacted', params: { threadId: msg.params.threadId } });
      return;
    case 'turn/interrupt':
      out({ id: msg.id, result: {} });
      return;
    default:
      if (msg.id !== undefined) out({ id: msg.id, error: { code: -32601, message: `unknown ${msg.method}` } });
  }
});
