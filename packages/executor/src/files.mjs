// Filesystem access for the board's file browser.
//
// Deliberately separate from cloudlink.mjs's listDirs(), which answers a
// different question: that one feeds the "which repo?" path autocomplete, so
// it returns directories only, capped at 50, hiding dotfiles. Reusing it here
// would mean a file browser that cannot show files.
//
// Every path is resolved and used as-is: the account owner is browsing their
// own machine, and the cloud route is owner-only. There is no allowlist.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_FILE_READ_BYTES, MAX_DIR_ENTRIES } from '../../shared/protocol.mjs';

// Shared with listDirs: '~' and relative paths are resolved against $HOME so
// the browser can send something human-typed without knowing the real root.
export function resolvePath(requestedPath) {
  const raw = String(requestedPath || '').trim();
  if (!raw) return os.homedir();
  if (raw.startsWith('~')) return path.resolve(path.join(os.homedir(), raw.slice(1)));
  if (path.isAbsolute(raw)) return path.resolve(raw);
  return path.resolve(path.join(os.homedir(), raw));
}

export function listDir(requestedPath) {
  const abs = resolvePath(requestedPath);
  const entries = [];
  let dirents;
  try {
    dirents = fs.readdirSync(abs, { withFileTypes: true });
  } catch (err) {
    return { path: abs, parent: path.dirname(abs), entries: [], error: err.code || String(err.message || err) };
  }
  for (const d of dirents) {
    if (entries.length >= MAX_DIR_ENTRIES) break;
    // A symlink's own stat is useless here (it reports the link, not the
    // target), and a broken one must not abort the whole listing.
    let stat = null;
    try { stat = fs.statSync(path.join(abs, d.name)); } catch { /* broken link, permission denied */ }
    const isDir = stat ? stat.isDirectory() : d.isDirectory();
    entries.push({
      name: d.name,
      type: isDir ? 'dir' : 'file',
      size: stat && !isDir ? stat.size : null,
      mtime: stat ? stat.mtimeMs : null,
    });
  }
  // Directories first, then case-insensitive by name — the ordering every
  // file tree uses, and the one that makes a long list navigable.
  entries.sort((a, b) => (a.type === b.type
    ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    : (a.type === 'dir' ? -1 : 1)));
  // The root has no parent to climb to; reporting itself would render an
  // ".." that silently does nothing.
  const parent = path.dirname(abs);
  return { path: abs, parent: parent === abs ? null : parent, entries, truncated: dirents.length > MAX_DIR_ENTRIES };
}

// NUL in the first few KB is git's heuristic, but on its own it is only
// probabilistic: 40 bytes of random data contain no NUL about 85% of the time,
// so a small binary sails through as "text" — caught with a real /dev/urandom
// file during end-to-end testing. Since anything classified as text goes into
// an editor and can be saved *back*, the round trip has to be lossless, so the
// real test is whether the bytes are valid UTF-8. Decoding is exact and cheap.
function looksBinary(buf) {
  let end = Math.min(buf.length, 8192);
  if (end < buf.length) {
    // Cutting the probe at a fixed offset can land mid-character, and a
    // truncated multi-byte sequence is *itself* invalid UTF-8 — which would
    // misfile every large non-ASCII text file (any sizeable Chinese source
    // file) as binary. Back off over continuation bytes (0b10xxxxxx) to the
    // last complete character.
    let back = 0;
    while (end > 0 && back < 4 && (buf[end - 1] & 0xc0) === 0x80) { end--; back++; }
    // Now the last byte is either ASCII (a clean cut, leave it) or the lead
    // byte of a sequence whose continuations we just dropped (incomplete).
    if (end > 0 && buf[end - 1] >= 0xc0) end--;
  }
  const probe = buf.subarray(0, end);
  if (probe.includes(0)) return true;
  // Re-encoding a lossy decode changes the bytes: invalid UTF-8 comes back as
  // U+FFFD, which would be silently written over the original on save.
  return !Buffer.from(probe.toString('utf8'), 'utf8').equals(probe);
}

export function readFile(requestedPath) {
  const abs = resolvePath(requestedPath);
  let stat;
  try { stat = fs.statSync(abs); } catch (err) {
    return { path: abs, error: err.code || String(err.message || err) };
  }
  if (stat.isDirectory()) return { path: abs, error: 'EISDIR' };
  // Read only what's allowed rather than reading a huge file into memory and
  // then deciding — a multi-GB log would otherwise take the daemon down.
  const size = stat.size;
  const cap = MAX_FILE_READ_BYTES;
  let buf;
  try {
    if (size <= cap) {
      buf = fs.readFileSync(abs);
    } else {
      const fd = fs.openSync(abs, 'r');
      try {
        buf = Buffer.alloc(cap);
        const read = fs.readSync(fd, buf, 0, cap, 0);
        buf = buf.subarray(0, read);
      } finally { fs.closeSync(fd); }
    }
  } catch (err) {
    return { path: abs, error: err.code || String(err.message || err) };
  }
  const binary = looksBinary(buf);
  return {
    path: abs,
    content: binary ? buf.toString('base64') : buf.toString('utf8'),
    encoding: binary ? 'base64' : 'utf8',
    binary,
    size,
    mtime: stat.mtimeMs,
    truncated: size > cap,
  };
}

// expectedMtime is an optimistic lock against the agent, not against another
// human: these files are the ones a running agent is actively editing, and an
// unconditional write would throw away whatever it did between the read and
// the save with nothing left to show it happened. Passing null opts out (the
// "overwrite anyway" the UI offers after showing the conflict).
export function writeFile(requestedPath, content, expectedMtime = null) {
  const abs = resolvePath(requestedPath);
  let stat = null;
  try { stat = fs.statSync(abs); } catch { /* new file: nothing to conflict with */ }
  if (stat?.isDirectory()) return { path: abs, ok: false, error: 'EISDIR' };
  if (expectedMtime != null && stat) {
    // Millisecond timestamps survive the JSON round trip as floats; compare
    // with a small tolerance so a filesystem with coarser resolution than the
    // one that produced the number doesn't report a permanent conflict.
    if (Math.abs(stat.mtimeMs - Number(expectedMtime)) > 1) {
      return { path: abs, ok: false, conflict: true, mtime: stat.mtimeMs };
    }
  }
  try {
    fs.writeFileSync(abs, String(content ?? ''), 'utf8');
    const after = fs.statSync(abs);
    return { path: abs, ok: true, mtime: after.mtimeMs, size: after.size };
  } catch (err) {
    return { path: abs, ok: false, error: err.code || String(err.message || err) };
  }
}
