// selfupdate.mjs never touches the real install dir or network in tests —
// installRoot/fetchImpl/exec are all injectable.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  currentVersion, fetchLatestVersion, checkAndApply,
  newestSourceMtime, checkoutSourceDirty, sourceChangedSinceBoot, SOURCE_SETTLE_MS,
} from '../packages/executor/src/selfupdate.mjs';

function makeInstallRoot(version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-install-'));
  if (version != null) fs.writeFileSync(path.join(dir, 'VERSION'), version + '\n');
  return dir;
}

// Writes one source file with an explicit mtime, so staleness can be tested
// without sleeping out a real settle window.
function writeSource(installRoot, relPath, mtimeMs) {
  const file = path.join(installRoot, relPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '// test\n');
  fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

test('currentVersion: reads and trims VERSION; null when absent (dev checkout)', () => {
  assert.equal(currentVersion(makeInstallRoot('abc123')), 'abc123');
  assert.equal(currentVersion(makeInstallRoot(null)), null);
});

test('fetchLatestVersion: trims response text; null on non-ok or thrown fetch', async () => {
  assert.equal(await fetchLatestVersion('wss://cloud', async () => ({ ok: true, text: async () => 'v1\n' })), 'v1');
  assert.equal(await fetchLatestVersion('wss://cloud', async () => ({ ok: false })), null);
  assert.equal(await fetchLatestVersion('wss://cloud', async () => { throw new Error('offline'); }), null);
});

test('checkAndApply: dev checkout (no VERSION) never even calls fetch', async () => {
  const installRoot = makeInstallRoot(null);
  let fetchCalled = false;
  const result = await checkAndApply('wss://cloud', {
    installRoot, isIdle: () => true, fetchImpl: async () => { fetchCalled = true; return { ok: true, text: async () => 'x' }; },
    log: () => {},
  });
  assert.equal(result, false);
  assert.equal(fetchCalled, false);
});

test('checkAndApply: same version -> no-op, no download attempted', async () => {
  const installRoot = makeInstallRoot('same-hash');
  let downloadCalled = false;
  const fetchImpl = async (url) => {
    if (url.endsWith('.version')) return { ok: true, text: async () => 'same-hash' };
    downloadCalled = true;
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  const result = await checkAndApply('wss://cloud', { installRoot, isIdle: () => true, fetchImpl, log: () => {} });
  assert.equal(result, false);
  assert.equal(downloadCalled, false);
});

test('checkAndApply: new version but busy -> defers, no download attempted', async () => {
  const installRoot = makeInstallRoot('old-hash');
  let downloadCalled = false;
  const fetchImpl = async (url) => {
    if (url.endsWith('.version')) return { ok: true, text: async () => 'new-hash' };
    downloadCalled = true;
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  const result = await checkAndApply('wss://cloud', { installRoot, isIdle: () => false, fetchImpl, log: () => {} });
  assert.equal(result, false);
  assert.equal(downloadCalled, false);
});

test('checkAndApply: new version + idle -> downloads, extracts via exec, returns true', async () => {
  const installRoot = makeInstallRoot('old-hash');
  const execCalls = [];
  const fetchImpl = async (url) => {
    if (url.endsWith('.version')) return { ok: true, text: async () => 'new-hash' };
    if (url.endsWith('.tar.gz')) return { ok: true, arrayBuffer: async () => new TextEncoder().encode('fake-tarball-bytes').buffer };
    throw new Error('unexpected url: ' + url);
  };
  const exec = (cmd, args) => {
    execCalls.push({ cmd, args });
    assert.ok(fs.existsSync(args[1]), 'the downloaded tarball exists on disk when tar is invoked');
  };
  const result = await checkAndApply('wss://cloud', { installRoot, isIdle: () => true, fetchImpl, exec, log: () => {} });
  assert.equal(result, true);
  assert.equal(execCalls.length, 1);
  assert.equal(execCalls[0].cmd, 'tar');
  assert.deepEqual(execCalls[0].args.slice(0, 1).concat(execCalls[0].args.slice(2)), ['-xzf', '-C', installRoot]);
  assert.equal(fs.existsSync(execCalls[0].args[1]), false, 'temp tarball cleaned up after extraction');
});

test('checkAndApply: download failure is caught and returns false, never throws', async () => {
  const installRoot = makeInstallRoot('old-hash');
  const fetchImpl = async (url) => {
    if (url.endsWith('.version')) return { ok: true, text: async () => 'new-hash' };
    return { ok: false };
  };
  const result = await checkAndApply('wss://cloud', { installRoot, isIdle: () => true, fetchImpl, log: () => {} });
  assert.equal(result, false);
});

test('newestSourceMtime: only the trees the daemon actually imports count', () => {
  const installRoot = makeInstallRoot(null);
  // Second-aligned: utimesSync takes seconds as a float, so a sub-second
  // mtime doesn't survive the round-trip through the filesystem.
  const boot = Math.floor(Date.now() / 1000) * 1000;
  writeSource(installRoot, 'packages/executor/src/manager.mjs', boot - 10_000);
  writeSource(installRoot, 'packages/shared/protocol.mjs', boot - 5_000);
  assert.equal(newestSourceMtime(installRoot), boot - 5_000);

  // The web app and the Cloudflare worker have no bearing on this process.
  writeSource(installRoot, 'packages/web/src/task.jsx', boot + 60_000);
  writeSource(installRoot, 'packages/worker/src/hub-core.mjs', boot + 60_000);
  assert.equal(newestSourceMtime(installRoot), boot - 5_000);
});

test('checkoutSourceDirty: only executor/shared changes block an automatic checkout restart', () => {
  const installRoot = makeInstallRoot(null);
  fs.mkdirSync(path.join(installRoot, '.git'));
  const calls = [];
  const exec = (_bin, args) => { calls.push(args); return ' M packages/executor/src/manager.mjs\n'; };
  assert.equal(checkoutSourceDirty(installRoot, exec), true);
  assert.deepEqual(calls[0].slice(-2), ['packages/executor/src', 'packages/shared']);

  assert.equal(checkoutSourceDirty(installRoot, () => ''), false);
  assert.equal(checkoutSourceDirty(makeInstallRoot(null), () => { throw new Error('must not run'); }), false,
    'a non-git install keeps the existing mtime behavior');
  assert.equal(checkoutSourceDirty(installRoot, () => { throw new Error('git broken'); }), true,
    'an unverifiable checkout fails closed');
});

test('sourceChangedSinceBoot: a checkout whose source moved on since boot is stale, once it settles', () => {
  const installRoot = makeInstallRoot(null);
  // Second-aligned: utimesSync takes seconds as a float, so a sub-second
  // mtime doesn't survive the round-trip through the filesystem.
  const boot = Math.floor(Date.now() / 1000) * 1000;

  // Source older than boot: this is the code we are already running.
  writeSource(installRoot, 'packages/executor/src/manager.mjs', boot - 60_000);
  assert.equal(sourceChangedSinceBoot(boot, { installRoot, now: boot + 10 * SOURCE_SETTLE_MS }), false);

  // Just edited: newer than boot, but an editor may still be mid-save.
  writeSource(installRoot, 'packages/executor/src/manager.mjs', boot + 1_000);
  assert.equal(sourceChangedSinceBoot(boot, { installRoot, now: boot + 1_000 + SOURCE_SETTLE_MS - 1 }), false);

  // Settled: the exact case that left this node running a `--max-turns 100`
  // build for five days after the commit removing it.
  assert.equal(sourceChangedSinceBoot(boot, { installRoot, now: boot + 1_000 + SOURCE_SETTLE_MS + 1 }), true);
});

test('sourceChangedSinceBoot: dirty executor source is never loaded automatically', () => {
  const installRoot = makeInstallRoot(null);
  fs.mkdirSync(path.join(installRoot, '.git'));
  const boot = Math.floor(Date.now() / 1000) * 1000;
  writeSource(installRoot, 'packages/executor/src/manager.mjs', boot + 1_000);
  // This temporary .git directory is not a real repository, so git status
  // fails and checkoutSourceDirty deliberately fails closed.
  assert.equal(sourceChangedSinceBoot(boot, { installRoot, now: boot + 10 * SOURCE_SETTLE_MS }), false);
});

test('sourceChangedSinceBoot: never fires on a tarball install (checkAndApply owns those)', () => {
  const installRoot = makeInstallRoot('some-hash');
  // Second-aligned: utimesSync takes seconds as a float, so a sub-second
  // mtime doesn't survive the round-trip through the filesystem.
  const boot = Math.floor(Date.now() / 1000) * 1000;
  // Extraction rewrites these very files, which would otherwise read as
  // "changed since boot" forever after every successful update.
  writeSource(installRoot, 'packages/executor/src/manager.mjs', boot + 1_000);
  assert.equal(sourceChangedSinceBoot(boot, { installRoot, now: boot + 10 * SOURCE_SETTLE_MS }), false);
});
