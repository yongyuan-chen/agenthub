// Executor-side filesystem access for the board's file browser.
//
// The interesting cases are all about not making things worse on a machine an
// agent is actively working on: don't read a huge file into memory, don't feed
// binary bytes into a text editor that would then save them back mangled, and
// above all don't let a save silently discard an edit the agent made while the
// file was open.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listDir, readFile, writeFile } from '../packages/executor/src/files.mjs';
import { MAX_FILE_READ_BYTES } from '../packages/shared/protocol.mjs';

function tmpdir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-files-'));
  return dir;
}

test('listDir: returns files as well as directories, dirs first, with a way back up', () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'b.txt'), 'hello');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hi');
  fs.writeFileSync(path.join(dir, '.hidden'), 'x');

  const out = listDir(dir);
  assert.equal(out.path, fs.realpathSync(dir) === dir ? dir : out.path);
  assert.deepEqual(out.entries.map(e => e.name), ['src', '.hidden', 'a.txt', 'b.txt'],
    'directories first, then names — and dotfiles are NOT hidden (this is a file browser, not path autocomplete)');
  assert.equal(out.entries[0].type, 'dir');
  assert.equal(out.entries.find(e => e.name === 'b.txt').size, 5, 'files carry a size');
  assert.ok(out.parent && out.parent !== out.path, 'there is a parent to navigate to');
});

test('listDir: an unreadable path reports the error instead of looking like an empty folder', () => {
  const out = listDir(path.join(tmpdir(), 'does-not-exist'));
  assert.equal(out.entries.length, 0);
  assert.equal(out.error, 'ENOENT', 'an empty listing and a missing directory must be distinguishable');
});

test('readFile: text comes back as utf8, binary as base64', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'a.js'), 'const x = 1;\n');
  // A NUL byte is what marks this as binary — the same heuristic git uses.
  fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));

  const text = readFile(path.join(dir, 'a.js'));
  assert.equal(text.encoding, 'utf8');
  assert.equal(text.binary, false);
  assert.equal(text.content, 'const x = 1;\n');
  assert.ok(text.mtime > 0);

  const bin = readFile(path.join(dir, 'blob.bin'));
  assert.equal(bin.binary, true);
  assert.equal(bin.encoding, 'base64');
  assert.deepEqual([...Buffer.from(bin.content, 'base64')], [0x89, 0x50, 0x00, 0x01, 0x02]);
});

// Both halves of the binary check, and both ways it can be wrong.
test('readFile: binary detection survives random bytes and large non-ASCII text', () => {
  const dir = tmpdir();

  // 40 random bytes contain no NUL ~85% of the time, so the NUL heuristic
  // alone lets a small binary through as "text" — and text is editable and
  // saveable, so the round trip would corrupt it. Run enough samples that a
  // NUL-only implementation cannot pass by luck.
  let misfiled = 0;
  for (let i = 0; i < 40; i++) {
    const f = path.join(dir, `r${i}.bin`);
    fs.writeFileSync(f, Buffer.from(Array.from({ length: 40 }, () => 1 + Math.floor(Math.random() * 255))));
    if (!readFile(f).binary) misfiled++;
  }
  assert.equal(misfiled, 0, 'random bytes without a NUL must still be classified as binary');

  // The opposite failure: the probe is cut at a fixed byte offset, and a cut
  // landing mid-character makes valid UTF-8 look invalid. A large Chinese
  // file is the everyday case where that would misfire.
  const cn = path.join(dir, 'big.md');
  fs.writeFileSync(cn, '中文内容测试'.repeat(4000));
  const out = readFile(cn);
  assert.equal(out.binary, false, 'a large multi-byte text file is text');
  assert.equal(out.encoding, 'utf8');
  assert.ok(out.content.startsWith('中文内容测试'));
});

test('readFile: a file past the cap is truncated, not slurped whole', () => {
  const dir = tmpdir();
  const big = path.join(dir, 'huge.log');
  fs.writeFileSync(big, 'x'.repeat(MAX_FILE_READ_BYTES + 5000));
  const out = readFile(big);
  assert.equal(out.truncated, true);
  assert.equal(out.content.length, MAX_FILE_READ_BYTES, 'only the cap is read');
  assert.equal(out.size, MAX_FILE_READ_BYTES + 5000, 'but the real size is still reported');
});

test('readFile: a directory is an error, not an empty file', () => {
  assert.equal(readFile(tmpdir()).error, 'EISDIR');
});

test('writeFile: refuses to clobber a file that changed since it was read', () => {
  const dir = tmpdir();
  const target = path.join(dir, 'edited.js');
  fs.writeFileSync(target, 'original\n');
  const opened = readFile(target);

  // The agent edits the same file while it sits open in the browser.
  const later = opened.mtime + 5000;
  fs.writeFileSync(target, 'the agent wrote this\n');
  fs.utimesSync(target, new Date(later), new Date(later));

  const refused = writeFile(target, 'what the human typed\n', opened.mtime);
  assert.equal(refused.ok, false);
  assert.equal(refused.conflict, true, 'a stale write is reported, not applied');
  assert.equal(fs.readFileSync(target, 'utf8'), 'the agent wrote this\n', "the agent's edit survives");

  // Passing no expected mtime is the deliberate "overwrite anyway" the UI
  // offers once it has shown the conflict.
  const forced = writeFile(target, 'what the human typed\n', null);
  assert.equal(forced.ok, true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'what the human typed\n');
});

test('writeFile: an unchanged file saves, and a brand-new one needs no expectation', () => {
  const dir = tmpdir();
  const target = path.join(dir, 'a.txt');
  fs.writeFileSync(target, 'v1');
  const opened = readFile(target);
  const saved = writeFile(target, 'v2', opened.mtime);
  assert.equal(saved.ok, true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'v2');
  assert.ok(saved.mtime >= opened.mtime, 'the new mtime comes back so the editor can keep saving');

  const created = writeFile(path.join(dir, 'new.txt'), 'fresh', 12345);
  assert.equal(created.ok, true, 'an expectation about a file that does not exist yet is not a conflict');
  assert.equal(fs.readFileSync(path.join(dir, 'new.txt'), 'utf8'), 'fresh');
});
