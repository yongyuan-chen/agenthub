import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DEFAULTS = {
  cloudUrl: '',                 // e.g. wss://agenthub.win
  nodeId: os.hostname(),
  nodeToken: '',
  // The model relay this node talks to. Named `provider` rather than
  // `anthropic` since a profile now also picks which agent CLI drives the
  // task — see packages/executor/src/backends.mjs.
  provider: { baseUrl: '', apiKey: '', model: 'gpt-5.6' },
  claudeBin: 'claude',
  codexBin: 'codex',
  maxParallel: 3,
  decisionTimeoutMs: 4 * 3600_000,
  idleSessionTimeoutMs: 30 * 60_000,
  // Auto-retry schedule for turns that fail on a transient upstream/
  // connection error — see manager.mjs's TRANSIENT_ERROR_PATTERN. 3 quick
  // attempts, then every 60s, up to 12h total since the first failure.
  autoRetryFastDelaysMs: [5_000, 15_000, 30_000],
  autoRetrySlowDelayMs: 60_000,
  autoRetryMaxWindowMs: 12 * 3600_000,
  workRoot: path.join(os.homedir(), 'agenthub'),
};

export function loadConfig(explicitPath) {
  const p = explicitPath
    || process.env.AGENTHUB_CONFIG
    || path.join(os.homedir(), '.agenthub', 'executor.config.json');
  if (!fs.existsSync(p)) {
    throw new Error(`Config not found: ${p}. Copy executor.config.example.json and fill it in.`);
  }
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  // `anthropic` is the pre-rename spelling still sitting in every already-
  // installed node's config file (written by deploy/setup-*.sh). This is a
  // local file format, not the wire protocol — silently dropping it would
  // wipe the relay credentials of every node on upgrade.
  const provider = { ...DEFAULTS.provider, ...(raw.anthropic || {}), ...(raw.provider || {}) };
  const cfg = { ...DEFAULTS, ...raw, provider };
  delete cfg.anthropic;
  for (const key of ['cloudUrl', 'nodeId', 'nodeToken']) {
    if (!cfg[key]) throw new Error(`Config missing required field: ${key}`);
  }
  if (!cfg.provider.baseUrl || !cfg.provider.apiKey) {
    // Not fatal: a freshly-installed node legitimately has no local relay
    // credentials by design — the cloud pushes them (per the owning user's
    // Settings) on the first hello_ok right after connecting.
    console.warn('[config] no local model relay config — waiting for cloud-pushed config from the owning user\'s Settings page');
  }
  cfg.workRoot = cfg.workRoot.replace(/^~(?=[\\/]|$)/, os.homedir());
  for (const key of ['claudeProjectsRoot', 'codexSessionsRoot']) {
    if (cfg[key]) cfg[key] = path.resolve(cfg[key].replace(/^~(?=[\\/]|$)/, os.homedir()));
  }
  fs.mkdirSync(cfg.workRoot, { recursive: true });
  fs.mkdirSync(path.join(cfg.workRoot, 'scratch'), { recursive: true });
  fs.mkdirSync(path.join(cfg.workRoot, 'repos'), { recursive: true });
  fs.mkdirSync(path.join(cfg.workRoot, 'claude-config'), { recursive: true });
  // One stable CODEX_HOME per node, shared by every codex task: thread/resume
  // only ever looks for sessions/ under the CODEX_HOME its app-server was
  // booted with, so a per-task home would make resume impossible. Per-task
  // relay credentials still stay isolated — they travel in each child's own
  // env, not in this directory. See codex-session.mjs.
  fs.mkdirSync(path.join(cfg.workRoot, 'codex-home'), { recursive: true });
  return cfg;
}
