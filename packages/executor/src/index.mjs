#!/usr/bin/env node
// AgentHub executor daemon entrypoint.
import { loadConfig } from './config.mjs';
import { LocalDb } from './db.mjs';
import { SessionManager } from './manager.mjs';
import { CloudLink } from './cloudlink.mjs';

const config = loadConfig(process.argv[2]);
const db = new LocalDb(config.workRoot);

const link = new CloudLink(config, db, (cmd) => manager.handleCommand(cmd));
const manager = new SessionManager(config, db, (taskId, seq, ev) => link.notifyEvent(taskId, seq, ev));

console.log(`[executor] node=${config.nodeId} cloud=${config.cloudUrl} workRoot=${config.workRoot}`);
manager.recover();
link.start();

let shuttingDown = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    console.log('[executor] shutting down...');
    manager.shutdown();
    link.stop();
    setTimeout(() => process.exit(0), 500);
  });
}
process.on('uncaughtException', (e) => console.error('[executor] uncaught:', e));
process.on('unhandledRejection', (e) => console.error('[executor] unhandled rejection:', e));
