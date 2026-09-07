#!/usr/bin/env node
// AgentHub executor daemon entrypoint.
import { loadConfig } from './config.mjs';
import { LocalDb } from './db.mjs';
import { SessionManager } from './manager.mjs';
import { CloudLink } from './cloudlink.mjs';
import { checkAndApply, sourceChangedSinceBoot } from './selfupdate.mjs';

// Captured before anything else so a source file written during startup
// still counts as newer than this boot (see the staleness check below).
const BOOTED_AT = Date.now();

const config = loadConfig(process.argv[2]);
const db = new LocalDb(config.workRoot);

const link = new CloudLink(config, db, (cmd) => manager.handleCommand(cmd));
const manager = new SessionManager(config, db, (taskId, seq, ev) => link.notifyEvent(taskId, seq, ev));

console.log(`[executor] node=${config.nodeId} cloud=${config.cloudUrl} workRoot=${config.workRoot}`);
manager.recover();
link.start();

let shuttingDown = false;
function shutdown(exitCode) {
  if (shuttingDown) { process.exit(1); return; } // already in progress: force it
  shuttingDown = true;
  console.log('[executor] shutting down...');
  manager.shutdown();
  link.stop();
  setTimeout(() => process.exit(exitCode), 500);
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => shutdown(0));
}

// Periodic self-update: no-op for dev checkouts (no VERSION file), only
// restarts when idle (no turn actively generating — see manager.mjs's
// hasActiveGeneration(), deliberately looser than the parallelism-slot count
// so a task merely waiting on a human decision can't starve the node of
// updates for as long as that human takes), and both service templates
// already auto-restart the process on exit — see selfupdate.mjs for the
// full story. The version check itself is a single small GET, so there's no
// real cost to checking often — short interval keeps deploys reaching nodes
// quickly.
const SELF_UPDATE_INTERVAL_MS = (2 + Math.random()) * 60_000; // 2-3min, jittered across nodes
async function runSelfUpdateCheck() {
  const updated = await checkAndApply(config.cloudUrl, { isIdle: () => !manager.hasActiveGeneration() }).catch(e => {
    console.error('[selfupdate] check failed:', e.message);
    return false;
  });
  if (updated) { shutdown(0); return; }
  // Checkout installs get no VERSION file and so never match above — same
  // idle gate, same "exit and let the service manager restart us" exit, just
  // driven by the source on disk instead of a published version. See
  // selfupdate.mjs's sourceChangedSinceBoot for why this exists at all.
  if (sourceChangedSinceBoot(BOOTED_AT) && !manager.hasActiveGeneration()) {
    console.log('[selfupdate] source checkout changed since boot, restarting into it');
    shutdown(0);
  }
}
const updateTimer = setInterval(runSelfUpdateCheck, SELF_UPDATE_INTERVAL_MS);
if (updateTimer.unref) updateTimer.unref();
// Also check shortly after boot instead of waiting a full interval for the
// very first check — matters if a deploy landed while this node was down.
const initialCheckTimer = setTimeout(runSelfUpdateCheck, 30_000);
if (initialCheckTimer.unref) initialCheckTimer.unref();

process.on('uncaughtException', (e) => console.error('[executor] uncaught:', e));
process.on('unhandledRejection', (e) => console.error('[executor] unhandled rejection:', e));
