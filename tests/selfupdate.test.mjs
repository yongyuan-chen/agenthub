// selfupdate.mjs never touches the real install dir or network in tests —
// installRoot/fetchImpl/exec are all injectable.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { currentVersion, fetchLatestVersion, checkAndApply } from '../packages/executor/src/selfupdate.mjs';

function makeInstallRoot(version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-install-'));
  if (version != null) fs.writeFileSync(path.join(dir, 'VERSION'), version + '\n');
  return dir;
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
