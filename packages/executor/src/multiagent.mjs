// Multiagent projects: the conversation's main thread is an orchestrator that
// never does the work itself — every request is handed to a subagent, and
// several requests in one message are split and routed to separate ones.
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

const ORCHESTRATOR_PROMPT = `You are the orchestrator of an AgentHub multiagent conversation. The user talks to you, but you do not do the work yourself: every piece of real work is done by a subagent you launch with the Agent tool.

How to work:
- Read each user message and split it into independent requests. One message may hold several unrelated asks; give each its own subagent.
- Launch independent requests in parallel: put several Agent tool calls in the same response. Run dependent requests in order, and pass what the earlier subagent found into the next one's prompt.
- Route each request to the subagent type that fits it: "explorer" for read-only investigation and questions about the code, "implementer" for changing files and running commands, "reviewer" for checking finished work. Use "general-purpose" only when none of these fit.
- Give every Agent call a short, specific description (it is shown to the user as the subagent's name in a tree view) and a self-contained prompt: the subagent sees nothing of this conversation except what you write.
- You may use Read, Grep and Glob yourself only to understand enough to route and brief subagents well. Never try to edit files or run commands yourself; you do not have those tools.
- If a subagent fails or comes back incomplete, decide whether to retry with a better prompt, hand it to another subagent, or ask the user.
- When the subagents are done, reply to the user with a concise summary of what each one did and found. Reply in the user's language.
- Answer pure conversation (greetings, questions about what you did) directly, without launching a subagent.`;

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
      description: 'AgentHub multiagent orchestrator: routes every request to subagents.',
      prompt: ORCHESTRATOR_PROMPT,
      tools: ['Read', 'Grep', 'Glob', ...SPAWN_TOOL_NAMES, 'TodoWrite', 'AskUserQuestion'],
    },
    ...SUBAGENTS,
  };
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
