// One entry per agent CLI AgentHub can drive. Everything manager.mjs needs to
// know that differs between backends lives here, so manager never branches on
// a backend *name* — it looks the adapter up once per task and calls through
// it. (The two genuinely behavioural differences — whether a backend reports
// dollar cost, and how big its context window is — travel on the live
// session's `caps` instead, since they're properties of the running process
// rather than of the on-disk layout.)
//
// The two transcript accessors are deliberately distinct:
//   transcriptFile()          the file this task's own process writes right now
//                             (an isolated copy for ordinary tasks, the user's
//                             real one for real_config_dir/adopted tasks)
//   externalTranscriptFile()  the original file out in the user's real home,
//                             which can keep growing from VS Code/a terminal
//                             with no signal to AgentHub
// For real_config_dir tasks they're the same file; for ordinary ones they're
// not, and conflating them re-imports content that was already streamed live.
import os from 'node:os';
import path from 'node:path';

import { ClaudeSession } from './session.mjs';
import { CodexSession, codexHomeFor } from './codex-session.mjs';
import * as claudeTx from './sessions.mjs';
import * as codexTx from './codex-sessions.mjs';

export const DEFAULT_BACKEND = 'claude';

// config.claudeProjectsRoot / config.codexSessionsRoot are undefined in real
// deployments (each module falls back to its own ~/ default) and only set by
// tests, so nothing ever touches a real home directory under `node --test`.
function codexExternalRoot(config) {
  return config.codexSessionsRoot ?? codexTx.codexSessionsRoot(path.join(os.homedir(), '.codex'));
}
function codexNativeRoot(config) {
  return codexTx.codexSessionsRoot(codexHomeFor(config, false));
}

const claude = {
  name: 'claude',
  label: 'Claude Code',
  Session: ClaudeSession,

  transcriptFile(config, t) {
    if (!t?.session_id) return null;
    if (t.real_config_dir) return this.externalTranscriptFile(config, t);
    return t.dir ? claudeTx.nativeSessionFile(config.workRoot, t.dir, t.session_id) : null;
  },

  externalTranscriptFile(config, t, sessionId = null) {
    const id = sessionId ?? t?.session_id;
    if (!id) return null;
    return claudeTx.findExternalSessionFile(id, config.claudeProjectsRoot, t?.source_cwd || null);
  },

  // Ordinary tasks resume against an isolated CLAUDE_CONFIG_DIR, so a session
  // that originated outside AgentHub has to be copied in first (idempotent,
  // and a no-op for sessions AgentHub created itself). real_config_dir tasks
  // resume against the real location directly — copying would recreate the
  // stale-fork problem that flag exists to avoid.
  prepareResume(config, t, sessionId) {
    if (t.real_config_dir) return;
    claudeTx.importExternalSession(sessionId, config.workRoot, t.dir, config.claudeProjectsRoot);
  },

  // Where a session picked externally actually lives — `claude --resume` only
  // finds it from the exact cwd it was created in, so switchSession moves the
  // task's dir to match.
  sessionCwd(config, sessionId) {
    const file = claudeTx.findExternalSessionFile(sessionId, config.claudeProjectsRoot);
    return file ? claudeTx.cwdOf(file) : null;
  },

  countLines: claudeTx.countTranscriptLines,
  toEvents: claudeTx.transcriptToEvents,
  eventsSince: claudeTx.transcriptEventsSince,

  usageOf(file) {
    const contextTokens = claudeTx.lastAssistantUsage(file);
    return contextTokens ? { contextTokens, contextWindow: null } : null;
  },

  // CLAUDE_CONFIG_DIR mirrors codex's CODEX_HOME below: an ordinary task's
  // session lives in AgentHub's isolated config dir, and `claude --resume`
  // without it looks in ~/.claude and reports the session as not found. A
  // real_config_dir task is already in ~/.claude, so it must NOT be set.
  resumeCommand(config, t) {
    const prefix = t.real_config_dir ? '' : `CLAUDE_CONFIG_DIR=${path.join(config.workRoot, 'claude-config')} `;
    return `${prefix}claude --resume ${t.session_id}`;
  },

  listSessions(config, paths) {
    return claudeTx.listExternalSessionsForPaths(paths, config.claudeProjectsRoot);
  },
};

const codex = {
  name: 'codex',
  label: 'Codex',
  Session: CodexSession,

  // No cwd slug to compute (unlike claude's project folders): a rollout is
  // found by its session uuid, the only difference between the two cases
  // being which sessions/ root gets walked.
  transcriptFile(config, t) {
    if (!t?.session_id) return null;
    if (t.real_config_dir) return this.externalTranscriptFile(config, t);
    return codexTx.findExternalSessionFile(t.session_id, codexNativeRoot(config), null);
  },

  externalTranscriptFile(config, t, sessionId = null) {
    const id = sessionId ?? t?.session_id;
    if (!id) return null;
    return codexTx.findExternalSessionFile(id, codexExternalRoot(config), t?.source_cwd || null);
  },

  prepareResume(config, t, sessionId) {
    if (t.real_config_dir) return;
    codexTx.importExternalSession(sessionId, codexHomeFor(config, false), codexExternalRoot(config));
  },

  sessionCwd(config, sessionId) {
    const file = codexTx.findExternalSessionFile(sessionId, codexExternalRoot(config));
    return file ? codexTx.cwdOf(file) : null;
  },

  countLines: codexTx.countTranscriptLines,
  toEvents: codexTx.transcriptToEvents,
  eventsSince: codexTx.transcriptEventsSince,

  // The rollout records the model's real context window alongside the token
  // count, so auto-compaction can key off the actual limit instead of a
  // hardcoded constant.
  usageOf(file) {
    const u = codexTx.lastUsage(file);
    return u?.contextTokens ? u : null;
  },

  // CODEX_HOME is mandatory: without it `codex resume` looks in ~/.codex and
  // simply won't find a session living in AgentHub's isolated home.
  resumeCommand(config, t) {
    return `CODEX_HOME=${codexHomeFor(config, !!t.real_config_dir)} codex resume ${t.session_id}`;
  },

  listSessions(config, paths) {
    return codexTx.listExternalSessionsForPaths(paths, codexExternalRoot(config));
  },
};

export const BACKENDS = { claude, codex };

// Unknown/absent -> claude, which is what every task predating this column is.
export function backendFor(t) {
  return BACKENDS[t?.backend] ?? BACKENDS[DEFAULT_BACKEND];
}

export function backendByName(name) {
  return BACKENDS[name] ?? BACKENDS[DEFAULT_BACKEND];
}
