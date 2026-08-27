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
