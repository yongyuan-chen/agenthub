// Periodic self-update: compares the running install's content-hash VERSION
// (baked into the tarball at build time, see packages/web/build.mjs) against
// what the cloud currently serves, and if different, downloads + extracts
// the fresh tarball over the current install directory, then reports back
// so the caller can exit cleanly — both service templates (systemd
// Restart=always, launchd KeepAlive) already restart the process on exit,
// so no sudo / privileged restart call is needed here at all.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // .../packages/executor/src
export const INSTALL_ROOT = path.resolve(HERE, '../../..'); // tarball root: VERSION, packages/, deploy/

function toHttp(cloudUrl) {
  return cloudUrl.replace(/^ws/, 'http');
}

// No VERSION file (e.g. running straight from a git checkout, like a dev
// machine set up via setup-all.sh) -> self-update is a deliberate no-op.
export function currentVersion(installRoot = INSTALL_ROOT) {
  try { return fs.readFileSync(path.join(installRoot, 'VERSION'), 'utf8').trim(); }
  catch { return null; }
}

export async function fetchLatestVersion(cloudUrl, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`${toHttp(cloudUrl)}/agenthub-node.version`);
    if (!res.ok) return null;
    return (await res.text()).trim() || null;
  } catch {
    return null;
  }
}

export async function downloadAndExtract(cloudUrl, installRoot, { fetchImpl = fetch, exec = execFileSync } = {}) {
  const res = await fetchImpl(`${toHttp(cloudUrl)}/agenthub-node.tar.gz`);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const tmp = path.join(os.tmpdir(), `agenthub-node-${Date.now()}-${Math.random().toString(36).slice(2)}.tar.gz`);
  fs.writeFileSync(tmp, buf);
  try {
    exec('tar', ['-xzf', tmp, '-C', installRoot]);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// Returns true if an update was applied (caller should shut down and exit so
// the service manager restarts with the fresh code); false otherwise — no
// update available, not a tarball install, a task is currently running, or
// the check/download itself failed (logged, never throws).
export async function checkAndApply(cloudUrl, { installRoot = INSTALL_ROOT, isIdle, fetchImpl = fetch, exec = execFileSync, log = console.log } = {}) {
  const current = currentVersion(installRoot);
  if (!current) return false;
  const latest = await fetchLatestVersion(cloudUrl, fetchImpl);
  if (!latest || latest === current) return false;
  if (!isIdle()) {
    log(`[selfupdate] new version ${latest.slice(0, 12)} available, waiting until idle`);
    return false;
  }
  log(`[selfupdate] updating ${current.slice(0, 12)} -> ${latest.slice(0, 12)}`);
  try {
    await downloadAndExtract(cloudUrl, installRoot, { fetchImpl, exec });
  } catch (e) {
    log(`[selfupdate] failed: ${e.message}`);
    return false;
  }
  log('[selfupdate] extracted new code, restarting');
  return true;
}

// ---- git-checkout installs ----
// checkAndApply above is a deliberate no-op without a VERSION file, which
// left dev/checkout nodes with *no* update path at all: the daemon keeps
// running whatever the source said the moment it booted, silently, for as
// long as it stays up. Found live: a node ran 5-day-old code that still
// passed `--max-turns 100`, so the commit removing that cap never took
// effect and a task died at turn 101 with `error_max_turns` — a bug that was
// already fixed in the repo it was literally running from. Comparing source
// mtimes to boot time gives the checkout case the same "exit so the service
// manager restarts into the new code" behaviour tarball installs already
// have.
// Only the two trees this process actually imports: editing the web app or
// the Cloudflare worker has no bearing on the running daemon.
const WATCHED_SOURCE_DIRS = ['packages/executor/src', 'packages/shared'];

// An editor mid-save, or a half-applied `git checkout`, must not bounce the
// daemon into a syntax error — act only once the newest file has been quiet
// for a while.
export const SOURCE_SETTLE_MS = 60_000;

export function newestSourceMtime(installRoot = INSTALL_ROOT) {
  let newest = 0;
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.mjs')) {
        try { newest = Math.max(newest, fs.statSync(p).mtimeMs); } catch { /* vanished mid-scan */ }
      }
    }
  };
  for (const dir of WATCHED_SOURCE_DIRS) walk(path.join(installRoot, dir));
  return newest;
}

// True when this process is running a checkout whose source has since moved
// on. Never true for a tarball install — checkAndApply owns that case, and
// its extraction rewrites these same files (which would otherwise read as
// "stale" forever after).
export function checkoutSourceDirty(installRoot = INSTALL_ROOT, exec = execFileSync) {
  // A plain extracted install without VERSION isn't necessarily a git checkout;
  // preserve the old mtime behavior there. If .git does exist, however, never
  // auto-load half-written executor/shared changes from an active development
  // session. Clean committed pulls still restart automatically as intended.
  if (!fs.existsSync(path.join(installRoot, '.git'))) return false;
  try {
    return exec('git', [
      '-C', installRoot, 'status', '--porcelain', '--untracked-files=all', '--',
      'packages/executor/src', 'packages/shared',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().length > 0;
  } catch {
    // If a directory advertises itself as a checkout but git cannot verify its
    // state, fail closed: an unattended restart into unknown source is worse
    // than waiting for an explicit service restart.
    return true;
  }
}

export function sourceChangedSinceBoot(bootedAtMs, { installRoot = INSTALL_ROOT, now = Date.now() } = {}) {
  if (currentVersion(installRoot) || checkoutSourceDirty(installRoot)) return false;
  const newest = newestSourceMtime(installRoot);
  return newest > bootedAtMs && now - newest > SOURCE_SETTLE_MS;
}
