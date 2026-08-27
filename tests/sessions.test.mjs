// listExternalSessions/importExternalSession never touch the real ~/.claude —
// both take projectsRoot as an explicit parameter so these tests use a temp dir.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { externalSessionHistory, externalSessionHistoryPage, listExternalSessions, listExternalSessionsForPaths, importExternalSession, transcriptToEvents } from '../packages/executor/src/sessions.mjs';

function makeProjectsRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ah-claude-projects-'));
}

function writeSession(dir, sessionId, lines, mtimeMs) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  if (mtimeMs != null) fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

test('listExternalSessions: primary slug lookup finds sessions, extracts preview + mtime, newest first', () => {
  const root = makeProjectsRoot();
  const target = '/data2/chenyongyuan/tick_llm';
  const slug = target.replace(/[^a-zA-Z0-9]/g, '-');
  const dir = path.join(root, slug);

  writeSession(dir, 'session-old', [
    { type: 'user', message: { content: [{ type: 'text', text: '第一次提问,内容比较长'.repeat(5) }] } },
  ], Date.now() - 10_000);
  writeSession(dir, 'session-new', [
    { type: 'system', subtype: 'init' },
    { type: 'user', message: { content: 'plain string content' } },
  ], Date.now());

  const sessions = listExternalSessions(target, root);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].sessionId, 'session-new', 'newest first');
  assert.equal(sessions[0].preview, 'plain string content');
  assert.ok(sessions[1].preview.startsWith('第一次提问'));
  assert.ok(sessions[0].mtime >= sessions[1].mtime);
});

test('listExternalSessions: falls back to scanning by cwd when the slug directory has nothing', () => {
  const root = makeProjectsRoot();
  const target = '/some/other/path';
  // Deliberately NOT under the slugified directory name.
  const dir = path.join(root, 'totally-unrelated-folder-name');
  writeSession(dir, 'session-cwd-match', [
    { type: 'user', cwd: target, message: { content: [{ type: 'text', text: 'hello from fallback' }] } },
  ], Date.now());
  writeSession(dir, 'session-cwd-other', [
    { type: 'user', cwd: '/not/the/target', message: { content: [{ type: 'text', text: 'irrelevant' }] } },
  ], Date.now());

  const sessions = listExternalSessions(target, root);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionId, 'session-cwd-match');
  assert.equal(sessions[0].preview, 'hello from fallback');
});

test('listExternalSessions: no projectsRoot / no target / no matches -> empty array, never throws', () => {
  assert.deepEqual(listExternalSessions('/x', path.join(os.tmpdir(), 'ah-does-not-exist-' + Date.now())), []);
  assert.deepEqual(listExternalSessions('', makeProjectsRoot()), []);
  const root = makeProjectsRoot();
  writeSession(path.join(root, 'proj'), 'sess', [{ type: 'user', cwd: '/other' }], Date.now());
  assert.deepEqual(listExternalSessions('/nothing/matches/this', root), []);
});

test('listExternalSessionsForPaths: scans several canonical directories once, returns all, deduplicates source files', () => {
  const root = makeProjectsRoot();
  const projectA = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-project-a-'));
  const projectB = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-project-b-'));
  const bucketA = path.join(root, 'bucket-a');
  const bucketB = path.join(root, 'bucket-b');
  for (let i = 0; i < 35; i++) {
    writeSession(bucketA, `a-${i}`, [
      { type: 'user', cwd: projectA, message: { content: `A question ${i}` } },
    ], Date.now() - i);
  }
  writeSession(bucketB, 'b-1', [
    { type: 'user', cwd: projectB, message: { content: 'B question' } },
  ], Date.now() + 100);
  writeSession(bucketB, 'other', [
    { type: 'user', cwd: '/not/shared', message: { content: 'private' } },
  ], Date.now() + 200);

  const sessions = listExternalSessionsForPaths([projectA, projectB, projectA], root);
  assert.equal(sessions.length, 36, 'batch discovery is not capped to 30 per directory');
  assert.equal(sessions[0].sessionId, 'b-1');
  assert.equal(sessions[0].cwd, projectB, 'public response retains the authorized alias instead of leaking its physical realpath');
  assert.equal(sessions[0].path, projectB);
  assert.ok(!sessions.some(session => session.sessionId === 'other'));
});

test('listExternalSessionsForPaths: skips meta previews and finds cwd after the old 20-line prefix', () => {
  const root = makeProjectsRoot();
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-deep-cwd-'));
  const lines = Array.from({ length: 30 }, (_, index) => ({ type: 'progress', index }));
  lines.unshift({ type: 'user', isMeta: true, message: { content: 'PRIVATE REMINDER' } });
  lines.push({ type: 'user', cwd: target, message: { content: 'safe human preview' } });
  writeSession(path.join(root, 'arbitrary-bucket'), 'deep-cwd', lines, Date.now());
  const sessions = listExternalSessionsForPaths([target], root);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].preview, '(空会话)', 'bounded preview never falls back to raw JSON or metadata');
});

test('listExternalSessions: bounded read — multi-MB files never get fully loaded', async () => {
  const root = makeProjectsRoot();
  const target = '/big/project';
  const slug = target.replace(/[^a-zA-Z0-9]/g, '-');
  const dir = path.join(root, slug);
  fs.mkdirSync(dir, { recursive: true });

  // Real user message right at the top, followed by megabytes of padding —
  // mirrors a real long-running transcript. A naive whole-file read+split
  // would load and tokenize all of it just to find the first ~20 lines.
  const first = JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'large file preview' }] } });
  const padding = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(200) }] } });
  const file = path.join(dir, 'big-session.jsonl');
  const stream = fs.createWriteStream(file);
  stream.write(first + '\n');
  for (let i = 0; i < 20_000; i++) stream.write(padding + '\n');
  await new Promise((resolve, reject) => stream.end(err => (err ? reject(err) : resolve())));

  const sizeMB = fs.statSync(file).size / (1024 * 1024);
  assert.ok(sizeMB > 2, `test file should be multi-MB (was ${sizeMB.toFixed(1)}MB)`);

  const t0 = performance.now();
  const sessions = listExternalSessions(target, root);
  const elapsedMs = performance.now() - t0;

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].preview, 'large file preview');
  assert.ok(elapsedMs < 200, `should be near-instant regardless of file size (took ${elapsedMs.toFixed(1)}ms)`);
});

test('externalSessionHistory: reads the selected cwd copy when session ids collide', () => {
  const root = makeProjectsRoot();
  const cwdA = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-history-a-'));
  const cwdB = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-history-b-'));
  writeSession(path.join(root, 'a'), 'same-id', [
    { type: 'user', cwd: cwdA, message: { content: 'history A' } },
  ], Date.now());
  writeSession(path.join(root, 'b'), 'same-id', [
    { type: 'user', cwd: cwdB, message: { content: 'history B' } },
  ], Date.now() + 1);
  const listed = listExternalSessionsForPaths([cwdA, cwdB], root);
  assert.equal(listed.length, 2, 'same session id in two cwd values remains two distinct sources');
  assert.deepEqual(externalSessionHistory('same-id', cwdA, root), [
    { role: 'user', content: { text: 'history A' } },
  ]);
  assert.deepEqual(externalSessionHistory('same-id', cwdB, root), [
    { role: 'user', content: { text: 'history B' } },
  ]);
});

test('externalSessionHistoryPage: latest turn first, opaque caller can page ten earlier turns', () => {
  const root = makeProjectsRoot();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-page-history-'));
  const lines = [{ type: 'system', cwd, subtype: 'init' }];
  for (let index = 0; index < 15; index++) {
    lines.push({ type: 'user', message: { content: `question ${index}` } });
    lines.push({ type: 'assistant', message: { content: [{ type: 'text', text: `answer ${index}` }] } });
  }
  writeSession(path.join(root, 'pages'), 'paged-id', lines, Date.now());
  const latest = externalSessionHistoryPage('paged-id', cwd, root, { turns: 1 });
  assert.deepEqual(latest.events.map(event => event.content.text), ['question 14', 'answer 14']);
  assert.equal(latest.hasMore, true);
  assert.ok(Number.isInteger(latest.nextBefore));
  const older = externalSessionHistoryPage('paged-id', cwd, root, { before: latest.nextBefore, turns: 10, maxBytes: 1_000_000, maxEvents: 800 });
  assert.equal(older.events.filter(event => event.role === 'user').length, 10);
  assert.equal(older.events[0].content.text, 'question 4');
  assert.equal(older.events.at(-1).content.text, 'answer 13');
  assert.equal(older.hasMore, true);
});

test('externalSessionHistoryPage: latest text can omit tool details until requested', () => {
  const root = makeProjectsRoot();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-detail-history-'));
  writeSession(path.join(root, 'details'), 'detail-id', [
    { type: 'system', cwd },
    { type: 'user', message: { content: 'latest question' } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'run' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'latest answer' }] } },
  ], Date.now());
  const compact = externalSessionHistoryPage('detail-id', cwd, root, { turns: 1, includeTools: false });
  assert.deepEqual(compact.events.map(event => event.role), ['user', 'assistant']);
  assert.equal(compact.hiddenDetailCount, 2);
  const detailed = externalSessionHistoryPage('detail-id', cwd, root, { turns: 1, includeTools: true });
  assert.ok(detailed.events.some(event => event.role === 'tool_use'));
  assert.ok(detailed.events.some(event => event.role === 'tool_result'));
});

test('externalSessionHistoryPage: stale boundary after transcript rewrite is rejected', () => {
  const root = makeProjectsRoot();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-stale-history-'));
  const file = writeSession(path.join(root, 'stale'), 'stale-id', [
    { type: 'system', cwd },
    { type: 'user', message: { content: 'old question' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'old answer' }] } },
  ], Date.now());
  const latest = externalSessionHistoryPage('stale-id', cwd, root, { turns: 1 });
  assert.ok(latest.nextBefore > 0 && latest.nextBoundaryHash);
  const original = fs.readFileSync(file, 'utf8');
  const rewritten = original.replace('old question', 'new question');
  assert.equal(Buffer.byteLength(rewritten), Buffer.byteLength(original), 'rewrite fixture preserves file size');
  fs.writeFileSync(file, rewritten);
  const bumped = Date.now() / 1000 + 2;
  fs.utimesSync(file, bumped, bumped);
  const stale = externalSessionHistoryPage('stale-id', cwd, root, {
    before: {
      offset: latest.nextBefore, boundaryHash: latest.nextBoundaryHash,
      fileSize: latest.fileSize, fileMtime: latest.fileMtime,
    }, turns: 10,
  });
  assert.equal(stale.stale, true);
  assert.deepEqual(stale.events, []);
});

test('externalSessionHistoryPage: blank prefix terminates instead of repeating a cursor', () => {
  const root = makeProjectsRoot();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-blank-history-'));
  const file = writeSession(path.join(root, 'blank'), 'blank-id', [
    { type: 'system', cwd }, { type: 'user', message: { content: 'question' } },
  ], Date.now());
  fs.writeFileSync(file, `\n${fs.readFileSync(file, 'utf8')}`);
  let page = externalSessionHistoryPage('blank-id', cwd, root, { turns: 1 });
  for (let index = 0; index < 5 && page.hasMore; index++) {
    const previous = page.nextBefore;
    page = externalSessionHistoryPage('blank-id', cwd, root, { before: page.nextBefore, turns: 10 });
    if (page.hasMore) assert.ok(page.nextBefore < previous, 'cursor must strictly advance toward zero');
  }
  assert.equal(page.hasMore, false);
});

test('externalSessionHistoryPage: exact input-window record boundary remains readable', () => {
  const root = makeProjectsRoot();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-exact-window-'));
  const dir = path.join(root, 'exact'); fs.mkdirSync(dir);
  const prefix = `${JSON.stringify({ type: 'system', cwd })}\n`;
  const record = `${JSON.stringify({ type: 'user', message: { content: 'exact boundary' } })}\n`;
  fs.writeFileSync(path.join(dir, 'exact-id.jsonl'), prefix + record);
  const page = externalSessionHistoryPage('exact-id', cwd, root, { turns: 1, maxInputBytes: Buffer.byteLength(record) });
  assert.deepEqual(page.events.map(event => event.content.text), ['exact boundary']);
});

test('externalSessionHistoryPage: oversized newest raw record yields bounded placeholder and older cursor', () => {
  const root = makeProjectsRoot();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-oversized-window-'));
  const dir = path.join(root, 'oversized'); fs.mkdirSync(dir);
  const prefix = `${JSON.stringify({ type: 'system', cwd })}\n${JSON.stringify({ type: 'user', message: { content: 'latest real question' } })}\n`;
  const huge = `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(5000) }] } })}\n`;
  fs.writeFileSync(path.join(dir, 'huge-id.jsonl'), prefix + huge);
  const page = externalSessionHistoryPage('huge-id', cwd, root, { turns: 1, maxInputBytes: 1000, maxBytes: 1000, maxEvents: 10 });
  assert.ok(page.events.some(event => event.role === 'system' && event.content.text.includes('超大')));
  assert.equal(page.hasMore, true);
  const zeroBudget = externalSessionHistoryPage('huge-id', cwd, root, { turns: 1, maxInputBytes: 1000, maxBytes: 1, maxEvents: 0 });
  assert.deepEqual(zeroBudget.events, []);
});

test('externalSessionHistory: bounded tail skips oversized newest event but retains earlier history', () => {
  const root = makeProjectsRoot();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-bounded-history-'));
  const dir = path.join(root, 'bounded');
  const file = writeSession(dir, 'bounded-id', [
    { type: 'system', cwd, subtype: 'init' },
    { type: 'user', message: { content: 'old padding ' + 'x'.repeat(300_000) } },
    { type: 'user', cwd, message: { content: 'small recent question' } },
    { type: 'assistant', cwd, message: { content: [{ type: 'text', text: 'y'.repeat(20_000) }] } },
  ], Date.now());
  assert.ok(fs.statSync(file).size > 300_000);
  const events = externalSessionHistory('bounded-id', cwd, root, 2_000, 64_000);
  assert.ok(events.some(event => event.content?.text === 'small recent question'));
  assert.ok(events.some(event => event.role === 'system' && event.content.text.includes('过大')));
  assert.ok(Buffer.byteLength(JSON.stringify(events)) <= 2_000);
});

test('transcriptToEvents: maps user/assistant/tool_use/tool_result/result to AgentHub message shape', () => {
  const root = makeProjectsRoot();
  const file = writeSession(root, 'transcript-basic', [
    { type: 'mode', mode: 'normal', sessionId: 'x' }, // noise, skipped
    { type: 'permission-mode', permissionMode: 'bypassPermissions', sessionId: 'x' }, // noise, skipped
    { type: 'system', subtype: 'init', sessionId: 'x' }, // noise, skipped
    { type: 'user', message: { content: '查看最近的对话' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: '好的,我来看看' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: false, content: 'file1\nfile2' }] } },
    { type: 'result', subtype: 'success', duration_ms: 1200, num_turns: 2, total_cost_usd: 0.05, is_error: false },
  ], Date.now());

  const events = transcriptToEvents(file);
  assert.deepEqual(events, [
    { role: 'user', content: { text: '查看最近的对话' } },
    { role: 'assistant', content: { text: '好的,我来看看' } },
    { role: 'tool_use', content: { id: 'tu1', name: 'Bash', input: { command: 'ls' } } },
    { role: 'tool_result', content: { tool_use_id: 'tu1', is_error: false, content: 'file1\nfile2' } },
    { role: 'result', content: { subtype: 'success', duration_ms: 1200, num_turns: 2, turn_cost_usd: 0.05, total_cost_usd: 0.05, is_error: false } },
  ]);
});

test('transcriptToEvents: preserves array-form user text and images alongside tool results', () => {
  const root = makeProjectsRoot();
  const file = writeSession(root, 'array-user', [{
    type: 'user', message: { content: [
      { type: 'text', text: '带图片的问题' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
      { type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' },
      { type: 'text', text: '后续文字' },
    ] },
  }], Date.now());
  assert.deepEqual(transcriptToEvents(file), [
    { role: 'user', content: { text: '带图片的问题', images: [{ mediaType: 'image/png', data: 'aGVsbG8=' }] } },
    { role: 'tool_result', content: { tool_use_id: 'tool-1', is_error: false, content: 'ok' } },
    { role: 'user', content: { text: '后续文字' } },
  ]);
});

test('transcriptToEvents: thinking blocks map to their own role, matching live-stream handling', () => {
  const root = makeProjectsRoot();
  const file = writeSession(root, 'transcript-thinking', [
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: '先想一下' }, { type: 'text', text: '好的' }] } },
  ], Date.now());

  const events = transcriptToEvents(file);
  assert.deepEqual(events, [
    { role: 'thinking', content: { text: '先想一下' } },
    { role: 'assistant', content: { text: '好的' } },
  ]);
});

test('transcriptToEvents: skips isMeta and isSidechain entries', () => {
  const root = makeProjectsRoot();
  const file = writeSession(root, 'transcript-meta', [
    { type: 'user', isMeta: true, message: { content: '<system-reminder>ignore me</system-reminder>' } },
    { type: 'user', isSidechain: true, message: { content: 'subagent thread, not the main conversation' } },
    { type: 'user', message: { content: '这条是真实内容' } },
  ], Date.now());

  const events = transcriptToEvents(file);
  assert.deepEqual(events, [{ role: 'user', content: { text: '这条是真实内容' } }]);
});

test('transcriptToEvents: malformed lines and unknown entry types are skipped, never throws', () => {
  const root = makeProjectsRoot();
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'transcript-malformed.jsonl');
  fs.writeFileSync(file, [
    'not even json',
    JSON.stringify({ type: 'summary', summary: 'compacted earlier context' }),
    JSON.stringify({ type: 'user', message: { content: 'valid line after garbage' } }),
    '',
  ].join('\n'));

  const events = transcriptToEvents(file);
  assert.deepEqual(events, [{ role: 'user', content: { text: 'valid line after garbage' } }]);
});

test('transcriptToEvents: missing file -> empty array, never throws', () => {
  assert.deepEqual(transcriptToEvents(path.join(os.tmpdir(), 'ah-nope-' + Date.now() + '.jsonl')), []);
});

test('transcriptToEvents: caps to the most recent conversational turns for very long histories', () => {
  const root = makeProjectsRoot();
  const lines = [];
  for (let i = 0; i < 400; i++) {
    lines.push({ type: 'user', message: { content: `message number ${i}` } });
  }
  const file = writeSession(root, 'transcript-long', lines, Date.now());

  const events = transcriptToEvents(file);
  assert.equal(events.length, 50, 'capped to MAX_CONVO_TURNS since every line is a real turn');
  assert.equal(events[0].content.text, 'message number 350', 'kept the most recent slice, not the oldest');
  assert.equal(events[events.length - 1].content.text, 'message number 399');
});

test('transcriptToEvents: tool-call-heavy history does not crowd out the actual conversation', () => {
  const root = makeProjectsRoot();
  const lines = [];
  // Mirrors a real agentic session: each user/assistant text turn is
  // followed by several tool_use/tool_result pairs. A plain last-N-raw-events
  // cut would mostly show tool noise; the turn-based cap should still surface
  // a healthy number of actual user/assistant messages.
  for (let i = 0; i < 60; i++) {
    lines.push({ type: 'user', message: { content: `question ${i}` } });
    lines.push({ type: 'assistant', message: { content: [{ type: 'text', text: `answer ${i}` }] } });
    for (let j = 0; j < 10; j++) {
      lines.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `t${i}-${j}`, name: 'Bash', input: {} }] } });
      lines.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `t${i}-${j}`, is_error: false, content: 'ok' }] } });
    }
  }
  const file = writeSession(root, 'transcript-tool-heavy', lines, Date.now());

  const events = transcriptToEvents(file);
  const convo = events.filter(e => e.role === 'user' || e.role === 'assistant');
  assert.ok(convo.length >= 50, `expected at least MAX_CONVO_TURNS real messages, got ${convo.length}`);
  assert.ok(events.some(e => e.role === 'assistant' && e.content.text === 'answer 59'), 'kept the most recent real exchange');
});

test('importExternalSession: copies once, idempotent, false when nothing matches', () => {
  const root = makeProjectsRoot();
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-workroot-'));
  const sourceDir = path.join(root, 'some-project-slug');
  const sourceFile = writeSession(sourceDir, 'ext-session-1', [{ type: 'user', message: { content: 'hi' } }], Date.now());

  // targetCwd=null: falls back to the generic "imported" folder (only used
  // for the read-only history-preview copy, never itself resumed from).
  const ok1 = importExternalSession('ext-session-1', workRoot, null, root);
  assert.equal(ok1, true);
  const destFile = path.join(workRoot, 'claude-config', 'projects', 'imported', 'ext-session-1.jsonl');
  assert.ok(fs.existsSync(destFile));
  assert.equal(fs.readFileSync(destFile, 'utf8'), fs.readFileSync(sourceFile, 'utf8'));

  // second call is a no-op (idempotent) — mutate the source to prove it isn't re-copied
  fs.writeFileSync(sourceFile, JSON.stringify({ type: 'user', message: { content: 'changed' } }) + '\n');
  const ok2 = importExternalSession('ext-session-1', workRoot, null, root);
  assert.equal(ok2, true);
  assert.notEqual(fs.readFileSync(destFile, 'utf8'), fs.readFileSync(sourceFile, 'utf8'), 'dest was not overwritten on the second call');

  const missing = importExternalSession('never-existed', workRoot, null, root);
  assert.equal(missing, false);
});

test('importExternalSession: with a targetCwd, lands in the folder matching *that* cwd\'s slug, not a generic "imported" one', () => {
  // This is the actual bug: `claude --resume` was verified directly against
  // the real CLI to only search the project folder matching the slug of its
  // real (realpath-resolved) runtime cwd — a copy sitting anywhere else,
  // including a shared "imported" catch-all, gets "No conversation found"
  // even though the file itself is perfectly valid.
  const root = makeProjectsRoot();
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-workroot-'));
  const sourceDir = path.join(root, 'wherever-it-was-originally-slugged');
  writeSession(sourceDir, 'ext-session-2', [{ type: 'user', message: { content: 'hi' } }], Date.now());

  // The resume target is a *different* real directory the CLI will actually
  // spawn in — realpathSync resolves it (e.g. through symlinks) exactly like
  // a spawned process's own getcwd() would.
  const targetCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-resume-target-'));
  const resolvedTarget = fs.realpathSync(targetCwd);
  const expectedSlug = resolvedTarget.replace(/[^a-zA-Z0-9]/g, '-');

  const ok = importExternalSession('ext-session-2', workRoot, targetCwd, root);
  assert.equal(ok, true);

  const correctlyPlaced = path.join(workRoot, 'claude-config', 'projects', expectedSlug, 'ext-session-2.jsonl');
  assert.ok(fs.existsSync(correctlyPlaced), `expected the copy at ${correctlyPlaced}`);

  const genericImportedFolder = path.join(workRoot, 'claude-config', 'projects', 'imported', 'ext-session-2.jsonl');
  assert.ok(!fs.existsSync(genericImportedFolder), 'should not also land in the generic "imported" folder');
});
