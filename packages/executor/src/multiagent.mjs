// Multiagent projects: the conversation's main thread is a router that never
// does the work itself — every request goes to the subagent that already
// worked on something related (continued with its context), or to a new one
// when none did; several requests in one message are split and routed apart.
//
// Enforced with the CLI's own agent machinery rather than with prompt text
// alone: --agents defines the roles, and --agent runs the main thread *as*
// the orchestrator role, whose `tools` list is the hard constraint (no
// Edit/Write/Bash). The restriction applies to that agent only; subagents it
// spawns keep their own tool sets. Verified against claude 2.1.296: the init
// message's `tools` is narrowed to the list below, and subagent messages
// arrive with parent_tool_use_id pointing at the spawning Agent call.
import fs from 'node:fs';
import path from 'node:path';

export const ORCHESTRATOR_AGENT = 'agenthub-orchestrator';

// Both spellings of the spawn tool: older CLIs call it Task, newer ones Agent.
// Unknown names in `tools` are dropped by the CLI, so listing both is safe.
export const SPAWN_TOOL_NAMES = ['Agent', 'Task'];

// Continues an existing subagent (to = its agentId) with its context intact —
// what makes the orchestrator a router rather than a spawner. Verified
// against claude 2.1.296: works in -p mode and across --resume; the
// continued subagent runs in the background, and its messages keep the
// parent_tool_use_id of the Agent call that originally spawned it.
export const CONTINUE_TOOL_NAME = 'SendMessage';

const ORCHESTRATOR_PROMPT = `You are the router of an AgentHub multiagent conversation. The user talks to you, but you do not do the work yourself: every piece of real work is done by a subagent. Your job is to send each request to the right subagent.

Routing — for every request:
1. Look at the subagents already working in this conversation. AgentHub lists them at the top of each user message, inside <agenthub-subagents>…</agenthub-subagents>: agentId, type, area, what it was last handed, and whether it is still busy. That list is authoritative; it is not part of what the user wrote. (A subagent you launched earlier in the current turn is not in it yet — its Agent result ends with "agentId: <id>".)
2. If one of them worked on something closely related — the same files, feature, bug or topic — continue THAT subagent with the SendMessage tool (to = its agentId). It still has its whole earlier context, so tell it only what is new.
3. Only when none is related, launch a new subagent with the Agent tool.
Prefer continuing over launching: a subagent that already knows the area is faster and more consistent than a fresh one.

How to work:
- Split each user message into independent requests; one message may hold several unrelated asks. Route each one separately, and dispatch independent ones in the same response so they run in parallel. Run dependent requests in order, passing along what the earlier one found.
- When launching, pick the type that fits: "explorer" for read-only investigation and questions about the code, "implementer" for changing files and running commands, "reviewer" for checking finished work; "general-purpose" only when none fit. Give it a short, specific description naming its area (the user sees it as the subagent's name in a tree view) and a self-contained prompt: a new subagent sees nothing of this conversation except what you write.
- A continued subagent works in the background: SendMessage returns at once, and its report reaches you automatically when it is done. After handing work over, tell the user briefly who is on it and stop; do not guess its result. When the report arrives, relay it.
- You may use Read, Grep and Glob yourself only to route and brief well. Never try to edit files or run commands yourself; you do not have those tools.
- If a subagent fails or comes back incomplete, decide whether to continue it with clearer instructions, hand the work to another subagent, or ask the user.
- Reply to the user with a concise summary of what each subagent did and found, in the user's language. Answer pure conversation directly, without dispatching.`;

const SUBAGENTS = {
  explorer: {
    description: 'Read-only investigation: finds code, explains how things work, answers questions about the repository. Never modifies anything.',
    prompt: 'You are a read-only investigator. Search and read the codebase to answer the task you were given. Do not modify files. Report concrete file paths, function names and findings, concisely.',
    tools: ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'],
  },
  implementer: {
    description: 'Implements changes: edits and creates files, runs commands and tests. Use for any task that changes the repository.',
    prompt: 'You implement the task you were given, end to end: make the changes, run whatever checks are relevant, and fix what they surface. Match the surrounding code style. Finish with a short report of what you changed (files) and how you verified it, including anything left undone.',
  },
  reviewer: {
    description: 'Reviews finished work for correctness bugs and regressions. Read-only.',
    prompt: 'You review code changes for correctness bugs, regressions and missed requirements. Do not modify files. Report concrete problems with file:line and why they are wrong, most severe first; say plainly if you found none.',
    tools: ['Read', 'Grep', 'Glob'],
  },
};

export function multiAgentDefinitions() {
  return {
    [ORCHESTRATOR_AGENT]: {
      description: 'AgentHub multiagent router: routes every request to the most related subagent, or a new one.',
      prompt: ORCHESTRATOR_PROMPT,
      tools: ['Read', 'Grep', 'Glob', ...SPAWN_TOOL_NAMES, CONTINUE_TOOL_NAME, 'TodoWrite', 'AskUserQuestion'],
    },
    ...SUBAGENTS,
  };
}

// ---- the roster injected ahead of each user message ----

const ROSTER_OPEN = '<agenthub-subagents>';
const ROSTER_CLOSE = '</agenthub-subagents>';
const STATUS_WORDS = { running: 'busy', idle: 'idle', failed: 'last run failed' };
const oneLine = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

// rows: db.subagents(taskId), newest first. Unchanged text when there are
// none yet — a conversation's first message reads exactly as typed.
export function withRoster(text, rows) {
  if (!rows?.length) return text;
  const lines = rows.map(r => `- ${r.agent_id} (${r.subagent_type || 'general-purpose'}) "${oneLine(r.description, 80)}"`
    + ` — last handed: ${oneLine(r.last_task, 100) || '—'}; handed work ${r.runs}×; ${STATUS_WORDS[r.status] || r.status}`);
  return `${ROSTER_OPEN}\nSubagents in this conversation, most recently active first. Continue a related one with SendMessage(to=<agentId>); launch a new one only if none is related.\n${lines.join('\n')}\n${ROSTER_CLOSE}\n\n${text}`;
}

// The roster is for the model only: anything reading the CLI's transcript
// back as conversation history (sessions.mjs) shows what the user typed.
export function stripRoster(text) {
  if (typeof text !== 'string' || !text.startsWith(ROSTER_OPEN)) return text;
  const end = text.indexOf(ROSTER_CLOSE);
  return end < 0 ? text : text.slice(end + ROSTER_CLOSE.length).replace(/^\n+/, '');
}

// --agents takes a file path in --print mode. A file rather than inline JSON
// because on Windows the CLI is spawned through a shell (see session.mjs),
// and a multi-kilobyte JSON blob full of quotes is exactly what cmd.exe
// mis-parses. Rewritten on every spawn so a daemon upgrade's prompt changes
// take effect on the next turn without any cleanup step.
export function writeAgentsFile(workRoot) {
  fs.mkdirSync(workRoot, { recursive: true });
  const file = path.join(workRoot, 'multiagent-agents.json');
  fs.writeFileSync(file, JSON.stringify(multiAgentDefinitions(), null, 2));
  return file;
}
