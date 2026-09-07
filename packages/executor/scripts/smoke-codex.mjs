#!/usr/bin/env node
// The Codex counterpart of smoke.mjs, and the only test in this repo that
// spends real money: `codex app-server --stdio` + a real relay must complete a
// turn with a Bash tool call, route one approval back to us, compact over the
// RPC, and resume the same thread in a fresh process.
//
// Not part of `npm test` on purpose — run it by hand (`npm run smoke:codex`)
// when the Codex path changes.
//
// Codex speaks only wire_api "responses", so the relay must serve
// POST /v1/responses. The node's default profile is a *claude* relay
// (AgentHub refuses to make a Codex profile the account default), so point
// this at the Codex one explicitly:
//
//   CODEX_SMOKE_BASE_URL=https://your-relay/v1 \
//   CODEX_SMOKE_API_KEY=sk-... \
//   CODEX_SMOKE_MODEL=gpt-5.6-sol \
//   npm run smoke:codex
import fs from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../src/config.mjs';
import { CodexSession, codexHomeFor } from '../src/codex-session.mjs';

const config = loadConfig(process.argv[2]);
const provider = {
  baseUrl: process.env.CODEX_SMOKE_BASE_URL || config.provider?.baseUrl,
  apiKey: process.env.CODEX_SMOKE_API_KEY || config.provider?.apiKey,
  model: process.env.CODEX_SMOKE_MODEL || config.provider?.model || '',
};
if (!provider.baseUrl || !provider.apiKey) {
  console.error('[smoke-codex] 需要中转站配置:设置 CODEX_SMOKE_BASE_URL / CODEX_SMOKE_API_KEY,或先在网页端保存默认配置。');
  process.exit(1);
}
config.provider = provider;

const cwd = path.join(config.workRoot, 'scratch', 'smoke-codex');
fs.mkdirSync(cwd, { recursive: true });

console.log('[smoke-codex] bin=%s home=%s model=%s', config.codexBin || 'codex',
  codexHomeFor(config, false), provider.model || '(relay default)');

let sawToolUse = false, sawToolResult = false, sawApproval = false, sawCompaction = false;
let threadId = null;

// Resolves when the turn settles. `compactAfter` reuses the same live process
// for the compaction RPC, because that's how manager drives it too.
function run({ resume, prompt, compactAfter = false }) {
  return new Promise((resolve, reject) => {
    let compactRequested = false;
    const timer = setTimeout(() => { session.kill(); reject(new Error('smoke timeout')); }, 300_000);
    const finish = (fn, arg) => { clearTimeout(timer); session.kill(); fn(arg); };

    const session = new CodexSession({
      config, cwd,
      taskId: 'smoke',
      resumeSessionId: resume,
      permissionMode: 'default',
      onMessage: (msg) => {
        if (msg.type === 'system' && msg.subtype === 'init') {
          threadId = msg.session_id;
          console.log('  thread:', threadId);
        }
        if (msg.type === 'system' && msg.subtype === 'compacted') {
          sawCompaction = true;
          console.log('  compacted');
          finish(resolve);
        }
        if (msg.type === 'assistant') {
          for (const b of msg.message?.content ?? []) {
            if (b.type === 'tool_use') { sawToolUse = true; console.log('  tool_use:', b.name, JSON.stringify(b.input).slice(0, 80)); }
            if (b.type === 'thinking') console.log('  thinking:', b.thinking.slice(0, 80).replace(/\n/g, ' '));
            if (b.type === 'text') console.log('  assistant:', b.text.slice(0, 120));
          }
          const u = msg.message?.usage;
          if (u) console.log('  usage: input=%d window=%s', u.input_tokens, session.caps.contextWindow ?? '?');
        }
        if (msg.type === 'user') {
          for (const b of msg.message?.content ?? []) {
            if (b.type === 'tool_result') { sawToolResult = true; console.log('  tool_result:', JSON.stringify(b.content).slice(0, 100)); }
          }
        }
        if (msg.type === 'result') {
          console.log('  result:', msg.subtype, msg.error_code ? `code=${msg.error_code}` : '');
          if (msg.is_error) return finish(reject, new Error(`run failed: ${msg.subtype} ${msg.result}`));
          if (!compactAfter) return finish(resolve);
          // Compaction is a real RPC here, not a "/compact" message — the
          // thread/compacted notification above is what settles this run.
          if (compactRequested) return;
          compactRequested = true;
          console.log('[smoke-codex] compacting over thread/compact/start');
          if (!session.compact()) finish(reject, new Error('compact() refused: session not ready'));
        }
      },
      onPermission: async (req) => {
        sawApproval = true;
        console.log('  approval:', req.requestId, req.toolName, JSON.stringify(req.input).slice(0, 80), '-> allow');
        return { behavior: 'allow' };
      },
      onExit: (err) => { if (err) finish(reject, err); },
    });
    session.start();
    session.send(prompt);
  });
}

console.log('[smoke-codex] turn 1: tool call behind an approval gate, then compact');
await run({
  resume: null,
  compactAfter: true,
  prompt: 'Use the shell to run exactly: date +SMOKE_%s > smoke_marker.txt && cat smoke_marker.txt — then report the output.',
});

console.log('[smoke-codex] turn 2: resume the same thread in a fresh process');
await run({ resume: threadId, prompt: 'What did the marker file contain? Answer with just that string.' });

if (!sawToolUse || !sawToolResult) throw new Error('no tool roundtrip observed');
if (!sawCompaction) throw new Error('thread/compacted never arrived');
console.log(`[smoke-codex] PASS  tool_use=${sawToolUse} tool_result=${sawToolResult} approval_routed=${sawApproval} compacted=${sawCompaction} thread=${threadId}`);
process.exit(0);
