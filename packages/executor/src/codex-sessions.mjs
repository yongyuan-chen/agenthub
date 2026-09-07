// Reading Codex CLI "rollout" transcripts — the Codex counterpart of
// sessions.mjs (which does the same job for claude's ~/.claude/projects
// *.jsonl files).
//
// Layout, verified directly against a real CODEX_HOME:
//   <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<ISO-ts>-<session-uuid>.jsonl
// Every line is {timestamp, type, payload}. Unlike claude's layout the cwd is
// NOT encoded in the path — it lives in the first line's `session_meta`
// payload — so lookup by session id is a bounded recursive scan rather than a
// slug computation.
//
// Why parse files at all when `codex app-server` exposes thread/read over
// JSON-RPC: several callers in manager.mjs need transcript facts with *no
// live process* — _sweepExternalGrowth runs every 60s for every adopted task,
// _importHistory runs at adoption, setLease baselines at handoff. Spawning an
// app-server per task per minute just to count turns is not acceptable, and
// cheap line counting is exactly the same synced_lines semantics the claude
// path already uses. RPC is still used wherever a session is already live
// (compaction, resume) — see codex-session.mjs.
//
// Same parsing discipline as sessions.mjs: never throw on a malformed line,
// always fall back to something reasonable.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_SESSIONS_ROOT = () => path.join(os.homedir(), '.codex', 'sessions');
const PREVIEW_LEN = 120;
const MAX_SESSIONS = 30;
const MAX_BATCH_SESSIONS = 500;
const MAX_LINES_SCANNED = 20;
const PREFIX_BYTES = 16 * 1024;
// sessions/ is date-bucketed YYYY/MM/DD, so a full walk is bounded by how
// long the user has been using Codex. Cap it anyway — a home directory with
// years of daily buckets shouldn't be able to stall a 60s sweep.
const MAX_SCAN_FILES = 5000;

export function codexSessionsRoot(codexHome) {
  return codexHome ? path.join(codexHome, 'sessions') : DEFAULT_SESSIONS_ROOT();
}

// rollout-2026-08-20T12-19-23-01a01d65-....jsonl -> 01a01d65-...
// The session id is a UUID, so the last five dash-separated groups of the
// basename are it — the timestamp prefix also contains dashes, which is why
// this counts from the end instead of splitting on the first dash.
function sessionIdOfRollout(fileName) {
  const base = path.basename(fileName, '.jsonl');
  const parts = base.split('-');
  if (parts.length < 5) return null;
  const id = parts.slice(-5).join('-');
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id) ? id : null;
}

// Depth-first walk of sessions/YYYY/MM/DD. Returns absolute paths of every
// rollout-*.jsonl, newest-directory-first is NOT guaranteed — callers sort by
// mtime themselves.
function walkRollouts(root, limit = MAX_SCAN_FILES) {
  const out = [];
  const stack = [root];
  while (stack.length && out.length < limit) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (out.length >= limit) break;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) out.push(full);
    }
  }
  return out;
}

function readLines(file, limit) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return []; }
  try {
    const buf = Buffer.alloc(PREFIX_BYTES);
    const bytesRead = fs.readSync(fd, buf, 0, PREFIX_BYTES, 0);
    const text = buf.toString('utf8', 0, bytesRead);
    const lines = text.split('\n');
    if (bytesRead === PREFIX_BYTES) lines.pop(); // possibly truncated mid-JSON
    const filtered = lines.filter(Boolean);
    return limit ? filtered.slice(0, limit) : filtered;
  } catch {
    return [];
  } finally {
    fs.closeSync(fd);
  }
}

// `content` is always an array of {type:'input_text'|'output_text', text}.
function contentText(payload) {
  const content = payload?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts = content.map(b => (typeof b?.text === 'string' ? b.text : '')).filter(Boolean);
  return parts.length ? parts.join('\n') : null;
}

// session_meta is always line 1, but read a few lines anyway in case a future
// version prepends something.
export function cwdOf(file) {
  for (const line of readLines(file, 5)) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.type === 'session_meta' && entry.payload?.cwd) return entry.payload.cwd;
  }
  return null;
}

function previewForFile(file) {
  for (const line of readLines(file, MAX_LINES_SCANNED)) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.type !== 'response_item' || entry.payload?.type !== 'message') continue;
    if (entry.payload.role !== 'user') continue;
    const text = contentText(entry.payload);
    if (text) return text.slice(0, PREVIEW_LEN);
  }
  return '(空会话)';
}

function canonicalPath(value) {
  if (!value) return null;
  const expanded = String(value).replace(/^~(?=\/|$)/, os.homedir());
  let resolved = path.resolve(expanded);
  try { resolved = fs.realpathSync(resolved); } catch { /* missing/unresolvable: keep normalized */ }
  return resolved;
}

export function listExternalSessions(targetPath, sessionsRoot = DEFAULT_SESSIONS_ROOT()) {
  if (!targetPath || !fs.existsSync(sessionsRoot)) return [];
  const resolvedTarget = canonicalPath(targetPath);
  const out = [];
  for (const file of walkRollouts(sessionsRoot)) {
    if (canonicalPath(cwdOf(file)) !== resolvedTarget) continue;
    const sessionId = sessionIdOfRollout(file);
    if (!sessionId) continue;
    let mtime = 0;
    try { mtime = fs.statSync(file).mtimeMs; } catch { /* vanished mid-scan */ }
    out.push({ sessionId, file, mtime });
  }
  return out
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_SESSIONS)
    .map(({ file, ...s }) => ({ ...s, preview: previewForFile(file) }));
}

// One pass over sessions/ for N directories, same contract as the claude
// counterpart (cwd echoed back exactly as requested so the cloud can bind
// adoption to the path it actually exposed).
export function listExternalSessionsForPaths(targetPaths, sessionsRoot = DEFAULT_SESSIONS_ROOT()) {
  if (!Array.isArray(targetPaths) || !targetPaths.length || !fs.existsSync(sessionsRoot)) return [];
  const requested = new Map();
  for (const raw of targetPaths) {
    const canonical = canonicalPath(raw);
    if (canonical && !requested.has(canonical)) requested.set(canonical, String(raw));
  }
  if (!requested.size) return [];

  const sessions = new Map();
  for (const file of walkRollouts(sessionsRoot)) {
    const canonicalCwd = canonicalPath(cwdOf(file));
    if (!canonicalCwd || !requested.has(canonicalCwd)) continue;
    const sessionId = sessionIdOfRollout(file);
    if (!sessionId) continue;
    const key = `${canonicalCwd}\0${sessionId}`;
    let mtime = 0;
    try { mtime = fs.statSync(file).mtimeMs; } catch { /* vanished mid-scan */ }
    const prior = sessions.get(key);
    if (!prior || mtime > prior.mtime) {
      const authorizedPath = requested.get(canonicalCwd);
      sessions.set(key, { sessionId, cwd: authorizedPath, path: authorizedPath, file, mtime });
    }
  }
  return [...sessions.values()]
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_BATCH_SESSIONS)
    .map(({ file, ...s }) => ({ ...s, preview: previewForFile(file) }));
}

const MAX_CONVO_TURNS = 50;
export const MAX_IMPORT_EVENTS = 800;

// Maps one rollout line to zero or more AgentHub {role, content} events —
// the exact same shape manager.mjs's _onSdkMessage produces for live output,
// so imported Codex history renders through the existing chat UI unchanged.
//
// Only `response_item/*` lines are translated. The `event_msg/*` family is a
// parallel, UI-oriented view of the same content (verified by census on a
// real 6026-line rollout: event_msg/agent_message and
// response_item/message[assistant] both appear exactly 144 times) — reading
// both would render every assistant reply twice.
export function rolloutLineToEvents(entry) {
  if (entry?.type !== 'response_item') return [];
  const p = entry.payload;
  switch (p?.type) {
    case 'message': {
      // 'developer' is the harness's own injected instruction block, not
      // conversation — the claude path skips isMeta lines for the same reason.
      if (p.role !== 'user' && p.role !== 'assistant') return [];
      const text = contentText(p);
      return text ? [{ role: p.role, content: { text } }] : [];
    }
    case 'reasoning': {
      const summary = Array.isArray(p.summary)
        ? p.summary.map(s => (typeof s?.text === 'string' ? s.text : '')).filter(Boolean).join('\n')
        : '';
      // encrypted_content is opaque ciphertext; only the plaintext summary is
      // ever showable.
      return summary ? [{ role: 'thinking', content: { text: summary } }] : [];
    }
    case 'function_call':
      return [{ role: 'tool_use', content: { id: p.call_id || p.id, name: p.name, input: safeJson(p.arguments) } }];
    case 'custom_tool_call':
      // `input` is a free-form string (a script body for the `exec` tool),
      // not JSON — wrap it so the existing tool_use renderer has an object.
      return [{ role: 'tool_use', content: { id: p.call_id || p.id, name: p.name, input: { input: p.input ?? '' } } }];
    case 'function_call_output':
    case 'custom_tool_call_output':
      return [{
        role: 'tool_result',
        content: { tool_use_id: p.call_id || p.id, is_error: false, content: contentText(p) ?? '' },
      }];
    default:
      return []; // turn_context / world_state / thread_settings_applied / ... — harness internals
  }
}

function safeJson(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return { arguments: String(raw) }; }
}

export function transcriptToEvents(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const events = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    events.push(...rolloutLineToEvents(entry));
  }
  const kept = [];
  let turns = 0;
  for (let i = events.length - 1; i >= 0 && kept.length < MAX_IMPORT_EVENTS; i--) {
    const e = events[i];
    kept.push(e);
    if (e.role === 'user' || e.role === 'assistant') {
      turns++;
      if (turns >= MAX_CONVO_TURNS) break;
    }
  }
  kept.reverse();
  return kept;
}

export function transcriptEventsSince(file, fromLine = 0) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { events: [], totalLines: fromLine }; }
  const lines = text.split('\n').filter(Boolean);
  const events = [];
  for (const line of lines.slice(fromLine)) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    events.push(...rolloutLineToEvents(entry));
  }
  return { events, totalLines: lines.length };
}

export function countTranscriptLines(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; }
}

// Codex records usage itself in `event_msg/token_count`. Unlike claude's
// streamed usage this is trustworthy even behind a relay (Codex computes it
// from its own request accounting), but reading it from disk keeps this
// callable with no live process, same as the claude counterpart.
//
// `cached_input_tokens` is a *subset* of `input_tokens` (verified on a real
// rollout: input 23911 + output 138 == total 24049 while cached was 3840), so
// input_tokens alone is the context size — adding the cached count like the
// Anthropic shape requires would double-count.
export function lastUsage(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]) continue;
    let entry;
    try { entry = JSON.parse(lines[i]); } catch { continue; }
    if (entry?.type !== 'event_msg' || entry.payload?.type !== 'token_count') continue;
    const info = entry.payload.info;
    const contextTokens = info?.last_token_usage?.input_tokens ?? 0;
    if (contextTokens > 0) {
      return { contextTokens, contextWindow: info?.model_context_window ?? null };
    }
  }
  return null;
}

// contextTokens-only wrapper, matching sessions.mjs's lastAssistantUsage
// signature so the backend adapter can expose one uniform shape.
export function lastAssistantUsage(file) {
  return lastUsage(file)?.contextTokens ?? null;
}

export function findExternalSessionFile(sessionId, sessionsRoot = DEFAULT_SESSIONS_ROOT(), expectedCwd = null) {
  if (!sessionId || !fs.existsSync(sessionsRoot)) return null;
  const expected = expectedCwd ? canonicalPath(expectedCwd) : null;
  let newest = null;
  for (const file of walkRollouts(sessionsRoot)) {
    if (sessionIdOfRollout(file) !== sessionId) continue;
    if (expected && canonicalPath(cwdOf(file)) !== expected) continue;
    let mtime = 0;
    try { mtime = fs.statSync(file).mtimeMs; } catch { /* vanished */ }
    if (!newest || mtime > newest.mtime) newest = { file, mtime };
  }
  return newest ? newest.file : null;
}

// Idempotent copy of an externally-created rollout into AgentHub's own
// isolated CODEX_HOME, preserving the sessions/YYYY/MM/DD/ relative path —
// `thread/resume` looks the thread up by id under whatever CODEX_HOME the
// app-server was started with, and the date bucket is part of how it indexes.
// Unlike claude's counterpart there's no cwd-slug rule to satisfy (Codex
// records cwd inside the file, not in the path), so targetCwd isn't needed.
export function importExternalSession(sessionId, codexHome, sourceRoot = DEFAULT_SESSIONS_ROOT()) {
  const source = findExternalSessionFile(sessionId, sourceRoot);
  if (!source) return false;
  const destRoot = codexSessionsRoot(codexHome);
  const rel = path.relative(sourceRoot, source);
  // A source outside sourceRoot (path.relative escaping upward) would write
  // outside the isolated home — fall back to a flat placement instead.
  const dest = rel.startsWith('..') || path.isAbsolute(rel)
    ? path.join(destRoot, path.basename(source))
    : path.join(destRoot, rel);
  if (fs.existsSync(dest)) return true;
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(source, dest);
    return true;
  } catch {
    return false;
  }
}
