// Browsing and adopting pre-existing Claude Code CLI sessions that were
// created *outside* AgentHub (bare `claude` runs in a project directory,
// using the default ~/.claude config dir) — separate concern from
// worktree.mjs (git) and cloudlink.mjs (wire protocol).
//
// Session transcripts live at <configDir>/projects/<cwd-slug>/<session-id>.jsonl.
// The exact format is undocumented/version-dependent, so parsing here is
// deliberately best-effort: never throw on a malformed line, always fall
// back to something reasonable.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const DEFAULT_PROJECTS_ROOT = () => path.join(os.homedir(), '.claude', 'projects');
const PREVIEW_LEN = 120;
const MAX_SESSIONS = 30;
const MAX_BATCH_SESSIONS = 500;
const MAX_LINES_SCANNED = 20;
// Metadata we need (cwd, first user message) always lands in the first few
// lines — real transcripts run into the tens of MB, and reading one whole
// file just for a preview was slow enough (dozens of files x multi-MB each)
// to blow past the cloud's 4s RPC timeout and silently look like "nothing
// found". Bounding the read makes this independent of file size entirely.
const PREFIX_BYTES = 16 * 1024;

function slugify(p) {
  return String(p).replace(/[^a-zA-Z0-9]/g, '-');
}

// `claude --resume` slugifies its *actual runtime* cwd (via getcwd(), which
// resolves symlinks — e.g. macOS's /tmp -> /private/tmp) to pick which single
// projects/<slug>/ folder to look in. Verified directly against the real
// CLI: it does NOT search across all project folders — a session file
// sitting in any other folder (including a generic "imported" catch-all)
// gets "No conversation found", even though the file is perfectly valid and
// trivially findable by just scanning the directory. So the destination for
// a copied-in session has to be the slug of the resolved resume directory,
// not an arbitrary folder name.
function slugifyForResumeCwd(targetCwd) {
  let resolved = targetCwd;
  try { resolved = fs.realpathSync(targetCwd); } catch { /* doesn't exist yet / not resolvable — best effort */ }
  return slugify(resolved);
}

function readLines(file, limit) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return []; }
  try {
    const buf = Buffer.alloc(PREFIX_BYTES);
    const bytesRead = fs.readSync(fd, buf, 0, PREFIX_BYTES, 0);
    const text = buf.toString('utf8', 0, bytesRead);
    const lines = text.split('\n');
    // If we filled the buffer, the last line may be cut off mid-JSON — drop it.
    if (bytesRead === PREFIX_BYTES) lines.pop();
    const filtered = lines.filter(Boolean);
    return limit ? filtered.slice(0, limit) : filtered;
  } catch {
    return [];
  } finally {
    fs.closeSync(fd);
  }
}

// Best-effort: session entries mirror the CLI's own stream-json message
// shape (see manager.mjs's _onSdkMessage for the same 'user'/'assistant'
// content-block parsing applied to live output).
function extractText(entry) {
  const content = entry?.message?.content ?? entry?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const block = content.find(b => b?.type === 'text' && b.text);
    if (block) return block.text;
  }
  return null;
}

function previewForFile(file) {
  for (const line of readLines(file, MAX_LINES_SCANNED)) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.type !== 'user' || entry.isMeta || entry.isSidechain) continue;
    const text = extractText(entry);
    if (text) return text.slice(0, PREVIEW_LEN);
  }
  // Never expose raw transcript JSON: the first record can contain cwd,
  // injected reminders, or version-specific private metadata.
  return '(空会话)';
}

export function cwdOf(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  try {
    const chunk = Buffer.alloc(16 * 1024);
    let text = '';
    let offset = 0;
    let records = 0;
    const maxBytes = 256 * 1024;
    while (offset < maxBytes && records < 256) {
      const read = fs.readSync(fd, chunk, 0, Math.min(chunk.length, maxBytes - offset), offset);
      if (!read) break;
      offset += read;
      text += chunk.toString('utf8', 0, read);
      const lines = text.split('\n');
      text = lines.pop() || '';
      for (const line of lines) {
        if (!line) continue;
        records++;
        try { const entry = JSON.parse(line); if (entry?.cwd) return entry.cwd; } catch { /* malformed metadata line */ }
        if (records >= 256) break;
      }
    }
    if (text && offset < maxBytes) {
      try { const entry = JSON.parse(text); if (entry?.cwd) return entry.cwd; } catch { /* trailing malformed line */ }
    }
  } catch { /* best effort */ }
  finally { fs.closeSync(fd); }
  return null;
}

function canonicalPath(value) {
  if (!value) return null;
  const expanded = String(value).replace(/^~(?=\/|$)/, os.homedir());
  let resolved = path.resolve(expanded);
  try { resolved = fs.realpathSync(resolved); } catch { /* missing/unresolvable: retain the normalized absolute path */ }
  return resolved;
}

export function listExternalSessions(targetPath, projectsRoot = DEFAULT_PROJECTS_ROOT()) {
  if (!targetPath || !fs.existsSync(projectsRoot)) return [];
  const resolvedTarget = canonicalPath(targetPath);

  const collect = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    return entries.filter(e => e.isFile() && e.name.endsWith('.jsonl')).map(e => path.join(dir, e.name));
  };

  // Primary: the documented slug convention.
  let files = collect(path.join(projectsRoot, slugify(resolvedTarget)));

  // Fallback: the slug algorithm is undocumented/version-dependent — scan
  // every project folder and match by the cwd recorded inside each session.
  if (!files.length) {
    let projectDirs;
    try { projectDirs = fs.readdirSync(projectsRoot, { withFileTypes: true }).filter(e => e.isDirectory()); } catch { projectDirs = []; }
    for (const d of projectDirs) {
      for (const f of collect(path.join(projectsRoot, d.name))) {
        if (cwdOf(f) === resolvedTarget) files.push(f);
      }
    }
  }

  return files
    .map(f => {
      let mtime = 0;
      try { mtime = fs.statSync(f).mtimeMs; } catch { /* file vanished mid-scan */ }
      return { sessionId: path.basename(f, '.jsonl'), preview: previewForFile(f), mtime };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_SESSIONS);
}

// Batch counterpart used by the project sidebar's read-only history index.
// One pass over ~/.claude/projects avoids N independent fallback scans for N
// task directories, and returning cwd lets the cloud bind adoption to the
// exact source it exposed instead of trusting a browser-supplied session id.
export function listExternalSessionsForPaths(targetPaths, projectsRoot = DEFAULT_PROJECTS_ROOT()) {
  if (!Array.isArray(targetPaths) || !targetPaths.length || !fs.existsSync(projectsRoot)) return [];
  const requested = new Map();
  for (const raw of targetPaths) {
    const canonical = canonicalPath(raw);
    if (canonical && !requested.has(canonical)) requested.set(canonical, String(raw));
  }
  if (!requested.size) return [];

  let projectDirs;
  try { projectDirs = fs.readdirSync(projectsRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()); }
  catch { return []; }

  const sessions = new Map();
  for (const dir of projectDirs) {
    const projectDir = path.join(projectsRoot, dir.name);
    let entries;
    try { entries = fs.readdirSync(projectDir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const file = path.join(projectDir, entry.name);
      const recorded = cwdOf(file);
      const canonicalCwd = canonicalPath(recorded);
      if (!canonicalCwd || !requested.has(canonicalCwd)) continue;
      const sessionId = path.basename(entry.name, '.jsonl');
      const key = `${canonicalCwd}\0${sessionId}`;
      let mtime = 0;
      try { mtime = fs.statSync(file).mtimeMs; } catch { /* vanished mid-scan */ }
      const prior = sessions.get(key);
      if (!prior || mtime > prior.mtime) {
        const authorizedPath = requested.get(canonicalCwd);
        sessions.set(key, { sessionId, cwd: authorizedPath, path: authorizedPath, file, mtime });
      }
    }
  }
  const sorted = [...sessions.values()].sort((a, b) => b.mtime - a.mtime);
  return sorted.slice(0, MAX_BATCH_SESSIONS).map(({ file, ...session }) => ({ ...session, preview: previewForFile(file) }));
}

// Only ever show the most recent slice of a long history — a heavily-used
// session can run into the tens of thousands of transcript lines, and
// importing all of it would be slow to emit and unwieldy to scroll through.
// Real agentic sessions are dominated by tool_use/tool_result pairs (one
// verified production transcript had 260 tool events vs. 40 actual user/
// assistant messages in its last 300 raw events) — a plain last-N-events cut
// mostly shows collapsed tool-call rows and crowds out the conversation
// itself. So the cap targets *conversational* turns, not raw events.
const MAX_CONVO_TURNS = 50;
export const MAX_IMPORT_EVENTS = 800; // hard ceiling regardless of turn count, in case one turn has pathologically many tool calls

// Maps one transcript line to zero or more AgentHub {role, content} message
// events — deliberately the *same* shape manager.mjs's _onSdkMessage already
// produces for live output, so imported history renders with the exact same
// (already-existing) chat UI, no new frontend code needed. Best-effort: skip
// anything that doesn't cleanly map rather than guess.
function transcriptLineToEvents(entry) {
  if (entry?.isMeta || entry?.isSidechain) return []; // injected reminders / subagent side-threads, not the main thread
  switch (entry?.type) {
    case 'user': {
      const content = entry.message?.content;
      if (typeof content === 'string') return [{ role: 'user', content: { text: content } }];
      if (Array.isArray(content)) {
        const events = [];
        let textParts = [];
        let images = [];
        const flushVisible = () => {
          if (!textParts.length && !images.length) return;
          events.push({ role: 'user', content: { text: textParts.join('\n'), ...(images.length ? { images } : {}) } });
          textParts = []; images = [];
        };
        for (const block of content) {
          if (block?.type === 'text' && block.text) textParts.push(block.text);
          else if (block?.type === 'image' && block.source?.type === 'base64' && block.source.data) {
            images.push({ mediaType: block.source.media_type || 'image/png', data: block.source.data });
          } else if (block?.type === 'tool_result') {
            flushVisible();
            events.push({ role: 'tool_result', content: { tool_use_id: block.tool_use_id, is_error: block.is_error ?? false, content: block.content } });
          }
        }
        flushVisible();
        return events;
      }
      return [];
    }
    case 'assistant': {
      const blocks = entry.message?.content;
      if (!Array.isArray(blocks)) return [];
      const events = [];
      for (const b of blocks) {
        if (b?.type === 'text' && b.text) events.push({ role: 'assistant', content: { text: b.text } });
        else if (b?.type === 'tool_use') events.push({ role: 'tool_use', content: { id: b.id, name: b.name, input: b.input } });
        else if (b?.type === 'thinking' && b.thinking) events.push({ role: 'thinking', content: { text: b.thinking } });
      }
      return events;
    }
    case 'result':
      return [{
        role: 'result',
        content: {
          subtype: entry.subtype, duration_ms: entry.duration_ms ?? 0, num_turns: entry.num_turns ?? 0,
          turn_cost_usd: entry.total_cost_usd ?? 0, total_cost_usd: entry.total_cost_usd ?? 0, is_error: entry.is_error ?? false,
        },
      }];
    default:
      return []; // mode/permission-mode/system(init, local_command, ...)/summary/etc — CLI-internal noise, not conversation
  }
}

// Reads a session file in full (unlike the bounded reads above — a real
// import genuinely needs the whole transcript, but it's a one-time action on
// a single file, not a scan across dozens of files) and maps it to AgentHub
// message events, capped to the most recent MAX_IMPORT_EVENTS.
function readFully(fd, start, length) {
  const buffer = Buffer.alloc(length);
  let total = 0;
  while (total < length) {
    const read = fs.readSync(fd, buffer, total, length - total, start + total);
    if (!read) break;
    total += read;
  }
  return buffer.subarray(0, total);
}

function boundaryHash(fd, _size, offset) {
  const start = Math.max(0, offset - 128);
  return createHash('sha256').update(readFully(fd, start, offset - start)).digest('hex').slice(0, 24);
}

export function externalSessionHistoryPage(sessionId, expectedCwd, projectsRoot = DEFAULT_PROJECTS_ROOT(), {
  before = null, turns = 1, maxBytes = 256_000, maxEvents = 200, maxInputBytes = 8 * 1024 * 1024,
  includeTools = true,
} = {}) {
  const empty = { events: [], hiddenDetailCount: 0, nextBefore: null, nextBoundaryHash: null, fileSize: null, fileMtime: null, hasMore: false };
  if (!sessionId || !expectedCwd) return empty;
  const file = findExternalSessionFile(sessionId, projectsRoot, expectedCwd);
  if (!file) return empty;
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return empty; }
  let size;
  let mtimeMs;
  let end;
  let start;
  let buffer;
  try {
    const stat = fs.fstatSync(fd);
    size = stat.size;
    mtimeMs = stat.mtimeMs;
    const requestedOffset = before && typeof before === 'object' ? Number(before.offset) : (before == null ? size : Number(before));
    if (!Number.isFinite(requestedOffset) || requestedOffset < 0 || requestedOffset > size) { fs.closeSync(fd); return { ...empty, stale: true }; }
    end = requestedOffset;
    if (before && typeof before === 'object') {
      if (before.fileSize != null && (size !== Number(before.fileSize) || Math.trunc(mtimeMs) !== Number(before.fileMtime))) {
        fs.closeSync(fd); return { ...empty, stale: true };
      }
      if (before.boundaryHash !== boundaryHash(fd, size, end)) { fs.closeSync(fd); return { ...empty, stale: true }; }
    }
    start = Math.max(0, end - maxInputBytes);
    buffer = readFully(fd, start, end - start);
    if (buffer.length !== end - start) { fs.closeSync(fd); return { ...empty, stale: true }; }
  } catch { try { fs.closeSync(fd); } catch { /* already closed */ } return empty; }

  // A bounded range can begin halfway through a JSONL record. Drop the first
  // fragment. If the whole range is one oversized record, advance by one
  // bounded chunk and show an explicit placeholder instead of blocking.
  let scanStart = start;
  if (start > 0) {
    const startsAtBoundary = readFully(fd, start - 1, 1)[0] === 0x0a;
    if (!startsAtBoundary) {
      const newline = buffer.indexOf(0x0a);
      if (newline < 0 || newline === buffer.length - 1) {
        const nextBefore = start;
        const placeholder = { role: 'system', content: { text: '（一条超大历史记录的片段已省略）' } };
        const placeholderBytes = Buffer.byteLength(JSON.stringify(placeholder), 'utf8') + 1;
        const events = maxEvents > 0 && placeholderBytes <= maxBytes ? [placeholder] : [];
        const result = {
          events, hiddenDetailCount: 0, nextBefore: nextBefore > 0 ? nextBefore : null,
          nextBoundaryHash: nextBefore > 0 ? boundaryHash(fd, size, nextBefore) : null,
          fileSize: size, fileMtime: Math.trunc(mtimeMs), hasMore: nextBefore > 0,
        };
        fs.closeSync(fd);
        return result;
      }
      scanStart += newline + 1;
      buffer = buffer.subarray(newline + 1);
    }
  }

  const kept = [];
  let outputBytes = 2;
  let userTurns = 0;
  let omitted = false;
  let hiddenDetailCount = 0;
  let earliestProcessed = end;
  let position = buffer.length;
  if (position && buffer[position - 1] === 0x0a) position--;
  while (position > 0 && kept.length < maxEvents && userTurns < turns) {
    const newline = buffer.lastIndexOf(0x0a, position - 1);
    const relativeStart = newline + 1;
    const absoluteStart = scanStart + relativeStart;
    const line = buffer.subarray(relativeStart, position);
    earliestProcessed = absoluteStart; // blank/malformed lines still advance the cursor
    position = newline < 0 ? 0 : newline;
    if (!line.length) continue;
    if (line.length > maxBytes) {
      if (!omitted) {
        const placeholder = { role: 'system', content: { text: '（一条过大的历史记录已省略）' } };
        const placeholderBytes = Buffer.byteLength(JSON.stringify(placeholder), 'utf8') + 1;
        if (kept.length < maxEvents && outputBytes + placeholderBytes <= maxBytes) { kept.push(placeholder); outputBytes += placeholderBytes; }
        omitted = true;
      }
      continue;
    }
    let entry;
    try { entry = JSON.parse(line.toString('utf8')); } catch { continue; }
    const rawEvents = transcriptLineToEvents(entry);
    const lineHasUserTurn = rawEvents.some(event => event.role === 'user');
    const events = includeTools ? rawEvents : rawEvents.filter(event => {
      const hidden = event.role === 'tool_use' || event.role === 'tool_result' || event.role === 'thinking';
      if (hidden) hiddenDetailCount++;
      return !hidden;
    });
    const serialized = events.map(event => ({ event, bytes: Buffer.byteLength(JSON.stringify(event), 'utf8') + 1 }));
    const lineBytes = serialized.reduce((sum, item) => sum + item.bytes, 0);
    if (events.length > maxEvents - kept.length || outputBytes + lineBytes > maxBytes) {
      if (!omitted) {
        const placeholder = { role: 'system', content: { text: '（一条过大的历史记录已省略）' } };
        const placeholderBytes = Buffer.byteLength(JSON.stringify(placeholder), 'utf8') + 1;
        if (kept.length < maxEvents && outputBytes + placeholderBytes <= maxBytes) { kept.push(placeholder); outputBytes += placeholderBytes; }
        omitted = true;
      }
    } else {
      for (let index = serialized.length - 1; index >= 0; index--) kept.push(serialized[index].event);
      outputBytes += lineBytes;
    }
    if (lineHasUserTurn) userTurns++;
  }
  const nextBefore = earliestProcessed < end ? earliestProcessed : scanStart;
  const hasMore = nextBefore > 0 && nextBefore < end;
  const result = {
    events: kept.reverse(), hiddenDetailCount, nextBefore: hasMore ? nextBefore : null,
    nextBoundaryHash: hasMore ? boundaryHash(fd, size, nextBefore) : null,
    fileSize: size, fileMtime: Math.trunc(mtimeMs), hasMore,
  };
  fs.closeSync(fd);
  return result;
}

export function externalSessionHistory(sessionId, expectedCwd, projectsRoot = DEFAULT_PROJECTS_ROOT(), maxBytes = 1_000_000) {
  return externalSessionHistoryPage(sessionId, expectedCwd, projectsRoot, {
    turns: MAX_CONVO_TURNS, maxBytes, maxEvents: MAX_IMPORT_EVENTS,
  }).events;
}

export function transcriptToEvents(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const events = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    events.push(...transcriptLineToEvents(entry));
  }
  // Walk backward keeping everything until MAX_CONVO_TURNS real messages are
  // collected (tool events tagging along don't count against that budget),
  // subject to the hard MAX_IMPORT_EVENTS ceiling either way.
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

// Where AgentHub's own CLI process (or an IDE-driven `claude --resume` using
// the same isolated CLAUDE_CONFIG_DIR, e.g. after a takeover — see
// session.mjs's env setup) writes/reads a *native* session's transcript —
// same slug rule as the resume-copy destination above, since it's the same
// cwd + config dir the CLI actually runs with.
export function nativeSessionFile(workRoot, cwd, sessionId) {
  return path.join(workRoot, 'claude-config', 'projects', slugifyForResumeCwd(cwd), `${sessionId}.jsonl`);
}

export function countTranscriptLines(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; }
}

// The live stdout stream's per-message `usage` cannot be trusted as-is: some
// ANTHROPIC_BASE_URL relays (verified directly — a non-Anthropic model behind
// an Anthropic-compatible proxy) report all-zero usage on every streamed
// assistant message, even though the CLI's own on-disk transcript later has
// the real, non-zero counts (computed/backfilled by the CLI itself, not the
// relay). Reading the last assistant usage from disk at turn-end is the only
// reliable source across both direct-API and relayed setups.
export function lastAssistantUsage(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]) continue;
    let entry;
    try { entry = JSON.parse(lines[i]); } catch { continue; }
    if (entry?.type !== 'assistant') continue;
    const usage = entry.message?.usage;
    if (!usage) continue;
    const contextTokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    // A zeroed-out entry (relay didn't report real usage for that particular
    // message) isn't useful — keep walking back for the most recent real one
    // rather than giving up, so a stale-but-real number beats nothing.
    if (contextTokens > 0) return contextTokens;
  }
  return null;
}

// Incremental counterpart to transcriptToEvents: skips lines already known
// (fromLine, from a prior read) and maps only what's new — no recency cap,
// since this is for picking up a bounded delta (e.g. whatever got added
// during an IDE takeover), not importing an entire history. Returns the new
// total line count too, so the caller can persist "caught up to here".
export function transcriptEventsSince(file, fromLine = 0) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { events: [], totalLines: fromLine }; }
  const lines = text.split('\n').filter(Boolean);
  const events = [];
  for (const line of lines.slice(fromLine)) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    events.push(...transcriptLineToEvents(entry));
  }
  return { events, totalLines: lines.length };
}

// Idempotent: copies the first matching <sessionId>.jsonl found anywhere
// under projectsRoot into the app-isolated config dir, under the project
// folder matching targetCwd's slug — see slugifyForResumeCwd above for why
// that specific placement is required for `claude --resume` to actually find
// it (CLAUDE_CONFIG_DIR is set to the isolated dir at spawn time — see
// session.mjs). targetCwd should be the exact directory the CLI is about to
// be spawned in; pass null when the copy is only for reading (e.g. history
// preview) and will never itself be the target of --resume — it then falls
// back to a generic "imported" folder, which is fine for that purpose since
// nothing ever resumes from it directly.
// Scans every project folder under projectsRoot for a <sessionId>.jsonl —
// the *original*, authoritative file for an externally-adopted session.
// Unlike AgentHub's own isolated copy (made once at adoption time and never
// updated), this is the file that keeps growing if the user just keeps
// using `claude --resume <id>` directly outside AgentHub entirely (not even
// via the IDE-takeover flow) — the only place later changes actually show
// up.
export function findExternalSessionFile(sessionId, projectsRoot = DEFAULT_PROJECTS_ROOT(), expectedCwd = null) {
  if (!fs.existsSync(projectsRoot)) return null;
  let projectDirs;
  try { projectDirs = fs.readdirSync(projectsRoot, { withFileTypes: true }).filter(e => e.isDirectory()); } catch { return null; }
  const expected = expectedCwd ? canonicalPath(expectedCwd) : null;
  let newest = null;
  for (const d of projectDirs) {
    const candidate = path.join(projectsRoot, d.name, `${sessionId}.jsonl`);
    if (!fs.existsSync(candidate)) continue;
    if (expected && canonicalPath(cwdOf(candidate)) !== expected) continue;
    let mtime = 0;
    try { mtime = fs.statSync(candidate).mtimeMs; } catch { /* vanished */ }
    if (!newest || mtime > newest.mtime) newest = { file: candidate, mtime };
  }
  if (newest) return newest.file;
  return null;
}

export function importExternalSession(sessionId, workRoot, targetCwd, projectsRoot = DEFAULT_PROJECTS_ROOT()) {
  const destSlug = targetCwd ? slugifyForResumeCwd(targetCwd) : 'imported';
  const destDir = path.join(workRoot, 'claude-config', 'projects', destSlug);
  const destFile = path.join(destDir, `${sessionId}.jsonl`);
  if (fs.existsSync(destFile)) return true;
  const source = findExternalSessionFile(sessionId, projectsRoot);
  if (!source) return false;
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(source, destFile);
  return true;
}
