import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DEFAULTS = {
  cloudUrl: '',                 // e.g. wss://agenthub.win
  nodeId: os.hostname(),
  nodeToken: '',
  anthropic: { baseUrl: '', apiKey: '', model: 'gpt-5.6' },
  claudeBin: 'claude',
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
  const cfg = { ...DEFAULTS, ...raw, anthropic: { ...DEFAULTS.anthropic, ...(raw.anthropic || {}) } };
  for (const key of ['cloudUrl', 'nodeId', 'nodeToken']) {
    if (!cfg[key]) throw new Error(`Config missing required field: ${key}`);
  }
  if (!cfg.anthropic.baseUrl || !cfg.anthropic.apiKey) {
    // Not fatal: a freshly-installed node legitimately has no local relay
    // credentials by design — the cloud pushes them (per the owning user's
    // Settings) on the first hello_ok right after connecting.
    console.warn('[config] no local anthropic relay config — waiting for cloud-pushed config from the owning user\'s Settings page');
  }
  cfg.workRoot = cfg.workRoot.replace(/^~(?=[\\/]|$)/, os.homedir());
  if (cfg.claudeProjectsRoot) {
    cfg.claudeProjectsRoot = path.resolve(cfg.claudeProjectsRoot.replace(/^~(?=[\\/]|$)/, os.homedir()));
  }
  fs.mkdirSync(cfg.workRoot, { recursive: true });
  fs.mkdirSync(path.join(cfg.workRoot, 'scratch'), { recursive: true });
  fs.mkdirSync(path.join(cfg.workRoot, 'repos'), { recursive: true });
  fs.mkdirSync(path.join(cfg.workRoot, 'claude-config'), { recursive: true });
  return cfg;
}
