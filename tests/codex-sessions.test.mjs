import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  codexSessionsRoot,
  countTranscriptLines,
  cwdOf,
  findExternalSessionFile,
  importExternalSession,
  lastAssistantUsage,
  lastUsage,
  listExternalSessions,
  listExternalSessionsForPaths,
  rolloutLineToEvents,
  transcriptEventsSince,
  transcriptToEvents,
} from '../packages/executor/src/codex-sessions.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-codex-sessions-'));
  const sessions = path.join(root, 'sessions');
  const cwd = path.join(root, 'repo');
  fs.mkdirSync(cwd);
  const files = [];
  const writeRollout = (id, lines, { day = '01', mtime = Date.now() } = {}) => {
    const dir = path.join(sessions, '2026', '09', day);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `rollout-2026-09-${day}T12-00-00-${id}.jsonl`);
    fs.writeFileSync(file, lines.map(line => typeof line === 'string' ? line : JSON.stringify(line)).join('\n') + '\n');
    fs.utimesSync(file, new Date(mtime), new Date(mtime));
    files.push(file);
    return file;
  };
  return { root, sessions, cwd, files, writeRollout, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const meta = cwd => ({ type: 'session_meta', payload: { cwd } });
const message = (role, text) => ({ type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });

test('lists matching rollouts newest-first, canonicalizes cwd, deduplicates and previews', t => {
  const f = fixture();
  t.after(f.cleanup);
  const id1 = '11111111-1111-4111-8111-111111111111';
  const id2 = '22222222-2222-4222-8222-222222222222';
  f.writeRollout(id1, [meta(f.cwd), message('user', 'older prompt')], { day: '01', mtime: 1000 });
  f.writeRollout(id2, ['not json', meta(f.cwd), message('user', 'newer prompt')], { day: '02', mtime: 3000 });
  f.writeRollout(id1, [meta(f.cwd), message('user', 'latest duplicate')], { day: '03', mtime: 4000 });
  f.writeRollout('33333333-3333-4333-8333-333333333333', [meta(path.join(f.root, 'other')), message('user', 'wrong cwd')], { mtime: 5000 });
  f.writeRollout('not-a-session-id', [meta(f.cwd), message('user', 'invalid filename')], { mtime: 6000 });

  assert.equal(cwdOf(f.files[1]), f.cwd);
  const listed = listExternalSessions(path.join(f.cwd, '.'), f.sessions);
  assert.deepEqual(listed.map(x => x.sessionId), [id1, id2, id1]);
  assert.deepEqual(listed.map(x => x.preview), ['latest duplicate', 'newer prompt', 'older prompt']);

  const batched = listExternalSessionsForPaths([f.cwd, path.join(f.cwd, '.')], f.sessions);
  assert.deepEqual(batched.map(x => x.sessionId), [id1, id2]);
  assert.equal(batched[0].cwd, f.cwd);
  assert.equal(batched[0].preview, 'latest duplicate');
});

test('translates rollout items and incrementally tails malformed transcripts', t => {
  const f = fixture();
  t.after(f.cleanup);
  const id = '44444444-4444-4444-8444-444444444444';
  const file = f.writeRollout(id, [
    meta(f.cwd),
    message('user', 'hello'),
    { type: 'response_item', payload: { type: 'reasoning', summary: [{ text: 'thinking' }], encrypted_content: 'secret' } },
    { type: 'response_item', payload: { type: 'function_call', call_id: 'call-1', name: 'read', arguments: '{"path":"a"}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', content: 'done' } },
    'malformed',
    message('assistant', 'answer'),
  ]);

  assert.deepEqual(rolloutLineToEvents({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'c', name: 'exec', input: 'pwd' } }), [
    { role: 'tool_use', content: { id: 'c', name: 'exec', input: { input: 'pwd' } } },
  ]);
  assert.deepEqual(transcriptToEvents(file).map(e => e.role), ['user', 'thinking', 'tool_use', 'tool_result', 'assistant']);
  const tail = transcriptEventsSince(file, 2);
  assert.deepEqual(tail.events.map(e => e.role), ['thinking', 'tool_use', 'tool_result', 'assistant']);
  assert.equal(tail.totalLines, 7);
  assert.equal(countTranscriptLines(file), 7);
});

test('reads latest valid usage and safely finds and imports a rollout', t => {
  const f = fixture();
  t.after(f.cleanup);
  const id = '55555555-5555-4555-8555-555555555555';
  const file = f.writeRollout(id, [
    meta(f.cwd),
    { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 123 }, model_context_window: 258400 } } },
    '{bad',
    { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 456, cached_input_tokens: 200 }, model_context_window: 300000 } } },
  ]);

  assert.deepEqual(lastUsage(file), { contextTokens: 456, contextWindow: 300000 });
  assert.equal(lastAssistantUsage(file), 456);
  assert.equal(findExternalSessionFile(id, f.sessions, f.cwd), file);
  assert.equal(findExternalSessionFile(id, f.sessions, path.join(f.root, 'wrong')), null);

  const isolatedHome = path.join(f.root, 'isolated');
  assert.equal(importExternalSession(id, isolatedHome, f.sessions), true);
  const imported = findExternalSessionFile(id, codexSessionsRoot(isolatedHome));
  assert.ok(imported);
  assert.equal(fs.readFileSync(imported, 'utf8'), fs.readFileSync(file, 'utf8'));
  assert.equal(importExternalSession(id, isolatedHome, f.sessions), true, 'import is idempotent');
  assert.equal(importExternalSession('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', isolatedHome, f.sessions), false);
});
