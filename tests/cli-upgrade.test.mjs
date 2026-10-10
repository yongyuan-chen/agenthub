// cli-upgrade.mjs never runs a real installer or probes a real binary here —
// both spawns are injectable (`exec` for the sync --version probe, `spawnImpl`
// for the async installer), which is the whole reason they're constructor
// arguments rather than direct imports.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  parseVersion, compareVersions, isOutdated, probeCli, binFor,
  runUpgrade, cliVersions, resetCliStateCache, CliUpgrader, shouldTryNativeInstall,
} from '../packages/executor/src/cli-upgrade.mjs';

const CONFIG = { claudeBin: 'claude', codexBin: 'codex' };

// Fake spawnSync: maps bin -> what `<bin> --version` printed, or null for
// "not installed" (which really does come back as status 1 / ENOENT).
function fakeExec(byBin) {
  return (bin) => {
    const out = byBin[bin];
    if (out == null) return { status: 1, stdout: '', stderr: 'command not found' };
    return { status: 0, stdout: out, stderr: '' };
  };
}

// Fake async spawn: a child that emits the given output then closes with
// `code`. `onSpawn` records the argv so tests can assert we ran `<bin> update`
// and not something invented.
function fakeSpawn({ code = 0, output = '', onSpawn } = {}) {
  return (bin, args) => {
    onSpawn?.(bin, args);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      if (output) child.stdout.emit('data', output);
      child.emit('close', code);
    });
    return child;
  };
}

test('parseVersion: both CLIs print their version differently', () => {
  // These two strings are verbatim from the real binaries.
  assert.equal(parseVersion('2.1.105 (Claude Code)'), '2.1.105');
  assert.equal(parseVersion('codex-cli 0.144.6'), '0.144.6');
  assert.equal(parseVersion('0.158.0-alpha.6'), '0.158.0-alpha.6');
  assert.equal(parseVersion('no version here'), null);
  assert.equal(parseVersion(undefined), null);
});

test('compareVersions: numeric segments, not string order', () => {
  // The bug this guards: '2.1.105' > '2.1.273' lexicographically.
  assert.equal(compareVersions('2.1.105', '2.1.273'), -1);
  assert.equal(compareVersions('0.144.6', '0.156.1'), -1);
  assert.equal(compareVersions('2.1.273', '2.1.273'), 0);
  assert.equal(compareVersions('3.0.0', '2.9.9'), 1);
  // Prerelease sorts before its release.
  assert.equal(compareVersions('0.158.0-alpha.6', '0.158.0'), -1);
  assert.equal(compareVersions('0.158.0', '0.158.0-alpha.6'), 1);
  // Unparsable is not a comparison result.
  assert.equal(compareVersions('unknown', '1.0.0'), null);
  assert.equal(compareVersions('1.0.0', null), null);
});

test('isOutdated: false unless we can positively prove "behind"', () => {
  assert.equal(isOutdated('2.1.105', '2.1.273'), true);
  assert.equal(isOutdated('2.1.273', '2.1.273'), false);
  // Ahead of the published target (hand-installed build): never chase it, or
  // that machine shows 可升级 forever.
  assert.equal(isOutdated('2.2.0', '2.1.273'), false);
  // Either side unreadable -> no installer runs on a guess.
  assert.equal(isOutdated(null, '2.1.273'), false);
  assert.equal(isOutdated('2.1.105', null), false);
});

test('probeCli: installed/version are independent facts', () => {
  const exec = fakeExec({ claude: '2.1.105 (Claude Code)', weird: 'some build' });
  assert.deepEqual(probeCli('claude', { exec }),
    { installed: true, version: '2.1.105', output: '2.1.105 (Claude Code)' });
  // Runs, prints something unparsable: still installed, still dispatchable.
  assert.deepEqual(probeCli('weird', { exec }),
    { installed: true, version: null, output: 'some build' });
  assert.deepEqual(probeCli('codex', { exec }),
    { installed: false, version: null, output: 'command not found' });
  // A spawn that throws outright (ENOENT on some platforms) is not a crash.
  assert.deepEqual(probeCli('claude', { exec: () => { throw new Error('ENOENT'); } }),
    { installed: false, version: null, output: 'ENOENT' });
});

test('probeCli: keeps the failure output, which is the whole diagnosis', () => {
  // Verbatim from win10 on 2026-09-29, after the upgrade that "succeeded".
  const msg = 'Error: Missing optional dependency @openai/codex-win32-x64. '
    + 'Reinstall Codex: npm install -g @openai/codex@latest';
  const probe = probeCli('codex', { exec: () => ({ status: 1, stdout: '', stderr: msg }) });
  assert.equal(probe.installed, false);
  assert.match(probe.output, /@openai\/codex-win32-x64/);
});

test('binFor: honours the per-node config, defaults to bare names', () => {
  assert.equal(binFor({ claudeBin: '/opt/claude' }, 'claude'), '/opt/claude');
  assert.equal(binFor({}, 'claude'), 'claude');
  assert.equal(binFor({}, 'codex'), 'codex');
});

test('cliVersions: only installed CLIs, null version preserved', () => {
  resetCliStateCache();
  const exec = fakeExec({ claude: '2.1.105 (Claude Code)' });
  assert.deepEqual(cliVersions(CONFIG, { exec }), { claude: '2.1.105' });
  resetCliStateCache();
  const exec2 = fakeExec({ claude: 'mystery build', codex: 'codex-cli 0.144.6' });
  // claude present-but-null is "已安装,版本未知", not "未安装" — a different
  // thing to render and a different thing to decide about.
  assert.deepEqual(cliVersions(CONFIG, { exec: exec2 }), { claude: null, codex: '0.144.6' });
  resetCliStateCache();
});

test('runUpgrade: runs `<bin> update`, reports success and failure output', async () => {
  let argv = null;
  const okResult = await runUpgrade('claude', {
    spawnImpl: fakeSpawn({ code: 0, output: 'updated to 2.1.273', onSpawn: (b, a) => { argv = [b, a]; } }),
  });
  assert.deepEqual(argv, ['claude', ['update']]);
  assert.equal(okResult.ok, true);
  assert.match(okResult.output, /2\.1\.273/);

  const failResult = await runUpgrade('claude', {
    spawnImpl: fakeSpawn({ code: 1, output: 'EACCES: permission denied' }),
  });
  assert.equal(failResult.ok, false);
  // The user排错s from this string, so it has to survive verbatim.
  assert.match(failResult.output, /EACCES/);

  // A spawn that can't even start resolves rather than rejecting.
  const throwResult = await runUpgrade('claude', {
    spawnImpl: () => { throw new Error('spawn failed'); },
  });
  assert.deepEqual(throwResult, { ok: false, output: 'spawn failed' });
});

test('runUpgrade: a hung installer is killed and reported, not awaited forever', async () => {
  let killed = false;
  const hang = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { killed = true; };
    return child; // never emits 'close'
  };
  // The real timeout timer is unref'd (a pending upgrade must not keep the
  // daemon alive at shutdown), and the fake child emits nothing — so without
  // a ref'd timer here the test runner's loop empties before it fires.
  const keepAlive = setInterval(() => {}, 5);
  const r = await runUpgrade('claude', { spawnImpl: hang, timeoutMs: 20 });
  clearInterval(keepAlive);
  assert.equal(r.ok, false);
  assert.equal(killed, true);
  assert.match(r.output, /升级超时/);
});

// Builds an upgrader whose probe answers `versions` before the upgrade and
// `after` once the installer has run — the real thing re-probes in a finally
// block, and several behaviours below depend on that actually happening.
function makeUpgrader({ versions, after = versions, idle = true, code = 0, output = '' } = {}) {
  resetCliStateCache();
  let ran = false;
  const reports = [];
  const spawns = [];
  const upgrader = new CliUpgrader({
    config: CONFIG,
    isIdle: () => (typeof idle === 'function' ? idle() : idle),
    report: (payload) => reports.push(structuredClone(payload)),
    exec: (bin) => {
      const table = ran ? after : versions;
      const out = table[bin];
      if (out == null) return { status: 1, stdout: '', stderr: '' };
      return { status: 0, stdout: out, stderr: '' };
    },
    spawnImpl: fakeSpawn({ code, output, onSpawn: (b, a) => { ran = true; spawns.push([b, a]); } }),
    log: () => {},
  });
  return { upgrader, reports, spawns };
}

test('CliUpgrader: no target version means no upgrade, ever', async () => {
  const { upgrader, spawns } = makeUpgrader({ versions: { claude: '2.1.105 (Claude Code)' } });
  // A node that has never heard from the cloud knows no `latest`.
  await upgrader.tick();
  assert.deepEqual(spawns, []);
});

test('CliUpgrader: auto-upgrades an outdated CLI when idle', async () => {
  const { upgrader, reports, spawns } = makeUpgrader({
    versions: { claude: '2.1.105 (Claude Code)', codex: 'codex-cli 0.156.1' },
    after: { claude: '2.1.273 (Claude Code)', codex: 'codex-cli 0.156.1' },
  });
  await upgrader.setPolicy({ latest: { claude: '2.1.273', codex: '0.156.1' }, autoUpgrade: true });
  // Only the outdated one ran.
  assert.deepEqual(spawns, [['claude', ['update']]]);
  const last = reports.at(-1);
  assert.equal(last.upgrades.claude.state, 'ok');
  // Reported from a fresh probe, not from the target number we were chasing.
  assert.equal(last.versions.claude, '2.1.273');
  assert.equal(last.upgrades.codex, undefined);
});

test('CliUpgrader: autoUpgrade=false leaves the machine alone', async () => {
  const { upgrader, spawns } = makeUpgrader({ versions: { claude: '2.1.105 (Claude Code)' } });
  await upgrader.setPolicy({ latest: { claude: '2.1.273' }, autoUpgrade: false });
  await upgrader.tick();
  assert.deepEqual(spawns, []);
});

test('CliUpgrader: a busy node queues instead of replacing a running binary', async () => {
  let busy = true;
  const { upgrader, reports, spawns } = makeUpgrader({
    versions: { claude: '2.1.105 (Claude Code)' },
    after: { claude: '2.1.273 (Claude Code)' },
    idle: () => !busy,
  });
  await upgrader.setPolicy({ latest: { claude: '2.1.273' }, autoUpgrade: true });
  assert.deepEqual(spawns, [], 'mid-generation: nothing spawned');
  assert.equal(reports.at(-1).upgrades.claude.state, 'pending');
  assert.equal(reports.at(-1).versions.claude, '2.1.105', 'still reporting the truth while queued');

  busy = false;
  // The rate limiter must not swallow the retry of an already-queued upgrade.
  await upgrader.tick();
  assert.deepEqual(spawns, [['claude', ['update']]]);
  assert.equal(reports.at(-1).upgrades.claude.state, 'ok');
});

test('CliUpgrader: a failed upgrade reports the installer output, keeps the old version', async () => {
  const { upgrader, reports } = makeUpgrader({
    versions: { claude: '2.1.105 (Claude Code)' },
    code: 1, output: 'EACCES: permission denied, mkdir /usr/local/lib',
  });
  await upgrader.setPolicy({ latest: { claude: '2.1.273' }, autoUpgrade: true });
  const last = reports.at(-1);
  assert.equal(last.upgrades.claude.state, 'failed');
  assert.match(last.upgrades.claude.error, /EACCES/);
  assert.equal(last.versions.claude, '2.1.105', 'a failed install must not claim the new version');
});

// The win10 regression, 2026-09-25 → 09-29: `codex update` exited 0, left the
// package without its platform binary, and the node filed
// {state:"ok", from:"0.156.1"} — note the missing `to`, because the post-run
// probe came back with nothing. Nobody looks at a green row, so codex stayed
// broken for five days and the only hint was the node silently dropping the
// backend from its capabilities.
test('CliUpgrader: "succeeded" but the CLI no longer runs is a failure', async () => {
  resetCliStateCache();
  const reason = 'Error: Missing optional dependency @openai/codex-win32-x64. '
    + 'Reinstall Codex: npm install -g @openai/codex@latest';
  let ran = false;
  const reports = [];
  const upgrader = new CliUpgrader({
    config: CONFIG,
    isIdle: () => true,
    report: (p) => reports.push(structuredClone(p)),
    exec: (bin) => {
      if (bin !== 'codex') return { status: 1, stdout: '', stderr: 'command not found' };
      return ran
        ? { status: 1, stdout: '', stderr: reason }
        : { status: 0, stdout: 'codex-cli 0.156.1', stderr: '' };
    },
    spawnImpl: fakeSpawn({ code: 0, output: 'installed', onSpawn: () => { ran = true; } }),
    log: () => {},
  });
  await upgrader.setPolicy({ latest: { codex: '0.159.3' }, autoUpgrade: true });
  const last = reports.at(-1);
  assert.equal(last.upgrades.codex.state, 'failed');
  // The actionable line has to reach the UI, not just the node's own log.
  assert.match(last.upgrades.codex.error, /codex-win32-x64/);
  assert.equal(last.versions.codex, undefined, 'a CLI that cannot run is not installed');
  resetCliStateCache();
});

test('CliUpgrader: runs but prints no version -> failed, not an unverifiable ok', async () => {
  const { upgrader, reports } = makeUpgrader({
    versions: { codex: 'codex-cli 0.156.1' },
    after: { codex: 'some rebuilt thing' },   // runs fine, version unparsable
  });
  await upgrader.setPolicy({ latest: { codex: '0.159.3' }, autoUpgrade: true });
  const last = reports.at(-1);
  assert.equal(last.upgrades.codex.state, 'failed');
  assert.match(last.upgrades.codex.error, /读不出版本号/);
  // Still installed and still dispatchable — only the upgrade is unconfirmed.
  assert.equal(last.versions.codex, null);
});

test('CliUpgrader: manual request runs even when the CLI is already current', async () => {
  const { upgrader, spawns } = makeUpgrader({ versions: { claude: '2.1.273 (Claude Code)' } });
  await upgrader.setPolicy({ latest: { claude: '2.1.273' }, autoUpgrade: false });
  // Explicit button press: autoUpgrade being off is about the *automatic*
  // path, and "立即升级" is the user asking directly.
  await upgrader.request('claude');
  assert.deepEqual(spawns, [['claude', ['update']]]);
});

test('CliUpgrader: manual request for a CLI this machine lacks fails visibly', async () => {
  const { upgrader, reports, spawns } = makeUpgrader({ versions: { claude: '2.1.105 (Claude Code)' } });
  await upgrader.request('codex');
  assert.deepEqual(spawns, []);
  assert.equal(reports.at(-1).upgrades.codex.state, 'failed');
  assert.match(reports.at(-1).upgrades.codex.error, /没有安装/);
});

test('CliUpgrader: rate limit keeps the auto check off the 2-minute timer', async () => {
  let now = 10_000_000;   // comfortably past the 30min window from t=0
  resetCliStateCache();
  const spawns = [];
  const upgrader = new CliUpgrader({
    config: CONFIG,
    isIdle: () => true,
    report: () => {},
    // Always outdated: nothing here stops a second upgrade except the clock.
    exec: () => ({ status: 0, stdout: '2.1.105 (Claude Code)', stderr: '' }),
    spawnImpl: fakeSpawn({ code: 0, onSpawn: (b, a) => spawns.push([b, a]) }),
    log: () => {},
    now: () => now,
  });
  await upgrader.setPolicy({ latest: { claude: '2.1.273', codex: '0.156.1' }, autoUpgrade: true });
  const afterFirst = spawns.length;
  assert.ok(afterFirst > 0);
  now += 60_000;              // one self-update tick later
  await upgrader.tick();
  assert.equal(spawns.length, afterFirst, 'inside the 30min window: no re-check');
  now += 31 * 60_000;
  await upgrader.tick();
  assert.ok(spawns.length > afterFirst, 'past the window: checks again');
});

// ---- native-installer fallback ----
//
// Every error string below is copied verbatim out of node_cli_versions after
// the first live auto-upgrade run (2026-09-24), where four of five nodes
// failed along the npm path. That run is why this fallback exists, so the
// tests are pinned to what those machines actually printed rather than to
// text invented here.
const NPM_NOT_WRITABLE = [
  'Current version: 2.1.173',
  'Checking for updates to latest version...',
  "Warning: Can't auto-update: npm global folder isn't writable",
  'Fix: Run `claude install` to switch to the native installer (no sudo)',
].join('\n');
const REGISTRY_UNREACHABLE = [
  'Current version: 2.1.226',
  'Installation method set to: global',
  'Failed to check for updates',
  'Unable to fetch latest version from npm registry',
].join('\n');
const CODEX_EACCES = [
  'Updating Codex via `npm install -g @openai/codex`...',
  'npm error code EACCES',
  'npm error path /usr/lib/node_modules/@openai/codex',
].join('\n');

test('shouldTryNativeInstall: only for claude, only for npm-path failures', () => {
  assert.equal(shouldTryNativeInstall('claude', NPM_NOT_WRITABLE), true);
  assert.equal(shouldTryNativeInstall('claude', REGISTRY_UNREACHABLE), true);
  // codex has `update` but no `install` subcommand (checked against 0.147.0),
  // so there is nothing to fall back to — offering it would just spawn a
  // command that exits non-zero and bury the real error.
  assert.equal(shouldTryNativeInstall('codex', CODEX_EACCES), false);
  // A genuine build failure is not a packaging problem; reinstalling natively
  // would be a shot in the dark.
  assert.equal(shouldTryNativeInstall('claude', 'error: checksum mismatch'), false);
  assert.equal(shouldTryNativeInstall('claude', ''), false);
});

// Upgrader whose `update` fails with `updateOutput` and whose `install` exits
// with `installCode`; the probe reports `after` only once an install has run,
// which is what distinguishes "the fallback worked" from "PATH still shadows
// the new binary".
function makeFallbackUpgrader({
  versions, after, updateOutput, installCode = 0, installOutput = '', which = null,
}) {
  resetCliStateCache();
  let installed = false;
  const reports = [];
  const spawns = [];
  const upgrader = new CliUpgrader({
    config: CONFIG,
    isIdle: () => true,
    report: (payload) => reports.push(structuredClone(payload)),
    exec: (bin, args) => {
      if (bin === 'which' || bin === 'where') {
        return which ? { status: 0, stdout: `${which}\n`, stderr: '' } : { status: 1, stdout: '', stderr: '' };
      }
      const table = installed && after ? after : versions;
      const out = table[bin];
      if (out == null) return { status: 1, stdout: '', stderr: '' };
      return { status: 0, stdout: out, stderr: '' };
    },
    spawnImpl: (bin, args) => {
      spawns.push([bin, args]);
      const isInstall = args[0] === 'install';
      if (isInstall) installed = true;
      return fakeSpawn({
        code: isInstall ? installCode : 1,
        output: isInstall ? installOutput : updateOutput,
      })(bin, args);
    },
    log: () => {},
  });
  return { upgrader, reports, spawns };
}

test('CliUpgrader: an unwritable npm prefix falls back to the native installer', async () => {
  const { upgrader, reports, spawns } = makeFallbackUpgrader({
    versions: { claude: '2.1.173 (Claude Code)' },
    after: { claude: '2.1.273 (Claude Code)' },
    updateOutput: NPM_NOT_WRITABLE,
  });
  await upgrader.setPolicy({ latest: { claude: '2.1.273' }, autoUpgrade: true });
  // `install stable`, not `install latest`: the cloud computes the target off
  // the npm `stable` dist-tag, so this lands on the number the UI promised.
  assert.deepEqual(spawns, [['claude', ['update']], ['claude', ['install', 'stable']]]);
  const last = reports.at(-1);
  assert.equal(last.upgrades.claude.state, 'ok');
  assert.equal(last.versions.claude, '2.1.273');
  assert.equal(last.upgrades.claude.to, '2.1.273');
});

test('CliUpgrader: an unreachable npm registry falls back too', async () => {
  const { upgrader, reports, spawns } = makeFallbackUpgrader({
    versions: { claude: '2.1.226 (Claude Code)' },
    after: { claude: '2.1.273 (Claude Code)' },
    updateOutput: REGISTRY_UNREACHABLE,
  });
  await upgrader.setPolicy({ latest: { claude: '2.1.273' }, autoUpgrade: true });
  assert.equal(spawns.length, 2);
  assert.deepEqual(spawns[1], ['claude', ['install', 'stable']]);
  assert.equal(reports.at(-1).upgrades.claude.state, 'ok');
});

test('CliUpgrader: codex never gets a native-install fallback', async () => {
  const { upgrader, reports, spawns } = makeFallbackUpgrader({
    versions: { codex: 'codex-cli 0.147.0' },
    after: { codex: 'codex-cli 0.156.1' },
    updateOutput: CODEX_EACCES,
  });
  await upgrader.setPolicy({ latest: { codex: '0.156.1' }, autoUpgrade: true });
  assert.deepEqual(spawns, [['codex', ['update']]], 'one spawn, no install');
  const last = reports.at(-1);
  assert.equal(last.upgrades.codex.state, 'failed');
  assert.match(last.upgrades.codex.error, /EACCES/);
});

test('CliUpgrader: a native install shadowed on PATH is reported, not called ok', async () => {
  // The realistic trap on a node with an npm global in /usr/bin: `install`
  // writes ~/.local/bin/claude and exits 0, but /usr/bin/claude still wins the
  // PATH lookup, so the node keeps running the old binary. Calling that "ok"
  // would show 最新 in the UI for a CLI that still 400s on new models.
  const { upgrader, reports } = makeFallbackUpgrader({
    versions: { claude: '2.1.173 (Claude Code)' },
    after: { claude: '2.1.173 (Claude Code)' },   // unchanged: still shadowed
    updateOutput: NPM_NOT_WRITABLE,
    which: '/usr/bin/claude',
  });
  await upgrader.setPolicy({ latest: { claude: '2.1.273' }, autoUpgrade: true });
  const last = reports.at(-1);
  assert.equal(last.upgrades.claude.state, 'failed');
  assert.match(last.upgrades.claude.error, /PATH/);
  assert.match(last.upgrades.claude.error, /\/usr\/bin\/claude/, 'names the shadowing file');
});

test('CliUpgrader: when the fallback fails too, the original reason survives', async () => {
  const { upgrader, reports, spawns } = makeFallbackUpgrader({
    versions: { claude: '2.1.173 (Claude Code)' },
    after: { claude: '2.1.173 (Claude Code)' },
    updateOutput: NPM_NOT_WRITABLE,
    installCode: 1,
    installOutput: 'error: could not download native build',
  });
  await upgrader.setPolicy({ latest: { claude: '2.1.273' }, autoUpgrade: true });
  assert.equal(spawns.length, 2);
  const last = reports.at(-1);
  assert.equal(last.upgrades.claude.state, 'failed');
  // The npm message is the one that says *why* the normal path was closed, so
  // it leads; briefError truncates, which is why only the head is asserted.
  assert.match(last.upgrades.claude.error, /npm global folder isn't writable/);
});
