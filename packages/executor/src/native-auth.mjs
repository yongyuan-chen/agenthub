// "本机账号" mode: run claude/codex against whatever the CLI on this machine is
// already set up with, instead of an AgentHub relay — an official login
// (Claude subscription / Console, Codex ChatGPT), a key in
// ~/.claude/settings.json's env block or ~/.codex/config.toml, or variables
// the user exports from their shell profile.
//
// Two things here, both read-only:
//   nativeEnv()         the env a native-mode child should get
//   detectNativeAuth()  what this node can report to the board ("Claude Code
//                       已登录(订阅)") — booleans and method names only, never a
//                       key, a token or an env value
//
// Native tasks always run against the REAL ~/.claude / ~/.codex (they are
// real_config_dir tasks — see manager.mjs). Copying credentials into
// AgentHub's isolated dirs is not an option: OAuth refresh tokens rotate, so
// two copies means one of them (likely the user's own terminal login) gets
// silently invalidated, and on macOS the Claude login lives in the keychain
// under a name derived from the config dir.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// What a shell profile is allowed to contribute. The daemon runs under
// launchd/systemd/Task Scheduler, which never read ~/.zshrc or ~/.bashrc — so
// `export ANTHROPIC_BASE_URL=...` (the usual way people point claude at a
// relay) and a proxy for reaching the official API from behind the GFW are
// both invisible to it unless picked up here. Deliberately a whitelist:
// importing the whole interactive environment would drag in PATH tweaks,
// prompt hooks and whatever else, and change behaviour nobody asked for.
// CLAUDE_CONFIG_DIR / CODEX_HOME are excluded on purpose — native tasks are
// pinned to the default homes, which is where AgentHub looks for their
// transcripts.
const SHELL_VAR_RE = /^(ANTHROPIC_\w+|CLAUDE_CODE_\w+|OPENAI_\w+|CODEX_(?!HOME$)\w+|AWS_\w+|GOOGLE_\w+|CLOUD_ML_\w+|VERTEX_\w+|(?:https?|all|no)_proxy)$/i;
const SHELL_ENV_TTL_MS = 5 * 60_000;
let _shellEnv = null;   // { at, vars }

export function pickShellVars(raw) {
  const vars = {};
  for (const entry of String(raw || '').split('\0')) {
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    const key = entry.slice(0, eq);
    if (SHELL_VAR_RE.test(key)) vars[key] = entry.slice(eq + 1);
  }
  return vars;
}

// Interactive login shell, because that's what a terminal is: zsh reads
// .zshrc only when interactive, and bash's .bash_profile commonly sources
// .bashrc. stdin is closed so a profile that prompts can't hang us, and the
// timeout bounds a profile that's merely slow. Best effort: any failure just
// means no extra variables.
export function shellEnvVars({ exec = spawnSync, now = Date.now() } = {}) {
  if (process.platform === 'win32') return {};   // Windows has no shell profile; user env vars already reach the daemon
  if (_shellEnv && now - _shellEnv.at < SHELL_ENV_TTL_MS) return _shellEnv.vars;
  let vars = {};
  try {
    const shell = process.env.SHELL || '/bin/bash';
    const r = exec(shell, ['-ilc', 'env -0'], {
      stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, encoding: 'utf8',
      env: { ...process.env, AGENTHUB_ENV_PROBE: '1' },
    });
    if (r.status === 0) vars = pickShellVars(r.stdout);
  } catch { /* keep {} */ }
  _shellEnv = { at: now, vars };
  return vars;
}
export function resetShellEnvCache() { _shellEnv = null; }

// The child env for a native-mode session. The daemon's own env, plus the
// whitelisted shell variables on top (the shell is where the user actually
// configured things), minus AgentHub/IDE leftovers that would change how the
// CLI behaves. Nothing is injected: no base URL, no key, no model unless the
// profile names one.
export function nativeEnv(base = process.env, shellVars = shellEnvVars()) {
  const env = { ...base, ...shellVars };
  for (const key of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME']) {
    delete env[key];
  }
  return env;
}

function run(bin, args, env, timeoutMs = 15_000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
    } catch { resolve(null); return; }
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeoutMs);
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

// `claude auth status --json` (Claude Code >= 2.x):
//   {"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty",...}
//   {"loggedIn":true,"authMethod":"api_key","apiKeySource":"ANTHROPIC_API_KEY",...}
// Only whitelisted, non-secret fields leave this function.
export function parseClaudeStatus(text) {
  let j;
  try { j = JSON.parse(String(text).slice(String(text).indexOf('{'))); } catch { return null; }
  if (typeof j?.loggedIn !== 'boolean') return null;
  const str = (v) => (typeof v === 'string' ? v.slice(0, 64) : null);
  return {
    loggedIn: j.loggedIn, method: str(j.authMethod), provider: str(j.apiProvider), source: str(j.apiKeySource),
  };
}

// `codex login status` prints one line and exits 0 when logged in:
//   "Logged in using ChatGPT" / "Logged in using an API key - sk-...***"
// The key suffix is dropped here, never forwarded.
export function parseCodexStatus(code, text) {
  const s = String(text || '');
  if (code === 0 && /logged in using chatgpt/i.test(s)) return { loggedIn: true, method: 'chatgpt' };
  if (code === 0 && /logged in using an api key/i.test(s)) return { loggedIn: true, method: 'api_key' };
  return { loggedIn: false, method: null };
}

// A [model_providers] entry selected by `model_provider = "..."` in
// config.toml is the Codex equivalent of a relay set up by hand, and
// `codex login status` knows nothing about it. Top-level key only: a
// model_provider inside a [profiles.x] table is opt-in per invocation.
export function codexConfiguredProvider(home = path.join(os.homedir(), '.codex')) {
  let text;
  try { text = fs.readFileSync(path.join(home, 'config.toml'), 'utf8'); } catch { return null; }
  for (const line of text.split('\n')) {
    if (/^\s*\[/.test(line)) break;   // first table header ends the top level
    const m = line.match(/^\s*model_provider\s*=\s*["']([^"']+)["']/);
    if (m && m[1] !== 'openai') return m[1].slice(0, 64);
  }
  return null;
}

// {claude: {...}|null, codex: {...}|null} — null = CLI not installed (or the
// probe didn't answer), which the board shows differently from "installed,
// not logged in".
function claudeSettingsEnv(home) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
    return j?.env && typeof j.env === 'object' ? j.env : {};
  } catch { return {}; }
}

export async function detectNativeAuth(config, { installed = {}, runImpl = run, env = nativeEnv(), home = os.homedir() } = {}) {
  const out = { claude: null, codex: null, checkedAt: Date.now() };
  if (installed.claude !== false) {
    const r = await runImpl(config.claudeBin || 'claude', ['auth', 'status', '--json'], env);
    if (r) out.claude = parseClaudeStatus(r.out);
    // `auth status` reports a relay's ANTHROPIC_AUTH_TOKEN as "oauth_token",
    // indistinguishable from an official login. Whether a base URL is set
    // (shell or settings.json) is what tells them apart — a boolean, the URL
    // itself stays here.
    if (out.claude && (env.ANTHROPIC_BASE_URL || claudeSettingsEnv(home).ANTHROPIC_BASE_URL)) {
      out.claude = { ...out.claude, customEndpoint: true };
    }
  }
  if (installed.codex !== false) {
    const r = await runImpl(config.codexBin || 'codex', ['login', 'status'], env);
    if (r) {
      out.codex = parseCodexStatus(r.code, r.out);
      const provider = codexConfiguredProvider(path.join(home, '.codex'));
      if (provider) out.codex = { ...out.codex, loggedIn: true, method: out.codex.method || 'config', customProvider: provider };
    }
  }
  return out;
}
