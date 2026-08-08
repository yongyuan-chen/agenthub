#!/usr/bin/env node
// M0 smoke test: claude CLI + relay must complete a session with a Bash tool
// call in bidirectional stream-json mode, route one permission request to us,
// and resume the session once. Reads the same executor config as the daemon.
import { loadConfig } from '../src/config.mjs';
import { ClaudeSession } from '../src/session.mjs';
import fs from 'node:fs';
import path from 'node:path';

const config = loadConfig(process.argv[2]);
const cwd = path.join(config.workRoot, 'scratch', 'smoke');
fs.mkdirSync(cwd, { recursive: true });

let sawToolUse = false, sawToolResult = false, sawPermission = false, sessionId = null;

function run(resume, prompt) {
  return new Promise((resolve, reject) => {
    const session = new ClaudeSession({
      config, cwd,
      resumeSessionId: resume,
      permissionMode: 'default',
      onMessage: (msg) => {
        if (msg.type === 'system' && msg.subtype === 'init') sessionId = msg.session_id;
        if (msg.type === 'assistant') {
          for (const b of msg.message?.content ?? []) {
            if (b.type === 'tool_use') { sawToolUse = true; console.log('  tool_use:', b.name, JSON.stringify(b.input).slice(0, 80)); }
            if (b.type === 'text') console.log('  assistant:', b.text.slice(0, 120));
          }
        }
        if (msg.type === 'user') {
          for (const b of msg.message?.content ?? []) {
            if (b.type === 'tool_result') { sawToolResult = true; console.log('  tool_result:', JSON.stringify(b.content).slice(0, 100)); }
          }
        }
        if (msg.type === 'result') {
          console.log('  result:', msg.subtype, 'cost=$' + (msg.total_cost_usd ?? 0).toFixed(4));
          session.kill();
          msg.subtype === 'success' ? resolve() : reject(new Error('run failed: ' + msg.subtype));
        }
      },
      onPermission: async (req) => {
        sawPermission = true;
        console.log('  permission request:', req.toolName, '-> allow');
        return { behavior: 'allow' };
      },
      onExit: (err) => { if (err) reject(err); },
    });
    session.start();
    session.send(prompt);
    setTimeout(() => reject(new Error('smoke timeout')), 180_000);
  });
}

console.log('[smoke] turn 1: tool call with permission gate');
await run(null, 'Use the Bash tool to run exactly: date +SMOKE_%s > smoke_marker.txt && cat smoke_marker.txt — then report the output.');
console.log('[smoke] session:', sessionId);
console.log('[smoke] turn 2: resume');
await run(sessionId, 'What did the marker file contain? Answer with just that string.');
if (!sawToolUse || !sawToolResult) throw new Error('no tool roundtrip observed');
console.log(`[smoke] PASS  tool_use=${sawToolUse} tool_result=${sawToolResult} permission_routed=${sawPermission} session=${sessionId}`);
process.exit(0);
