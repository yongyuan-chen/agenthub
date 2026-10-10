// The one piece of branching logic that is genuinely identical for claude and
// codex: given a transcript's raw JSONL lines, keep everything up to the end
// of some earlier turn and throw the tail away.
//
// Why turns and not individual messages: a turn's assistant output can contain
// a tool_use whose tool_result arrives in the *next* line. Cutting between
// those two produces a context the API rejects outright (an unanswered tool
// call), so the only safe cut points are the lines that begin a user turn.
// Everything between one user turn and the next — assistant text, thinking,
// tool calls and their results — travels as an indivisible unit.
//
// Why the caller counts *trailing* turns to drop rather than naming the turn
// to keep: the cloud derives the count from its own messages table, which for
// an adopted conversation holds only the tail of a much longer transcript (see
// sessions.mjs's MAX_CONVO_TURNS import cap). Counting from the end is the
// only indexing the two sides can agree on without a shared id.

// userTurnText(entry) -> string when that entry begins a user turn, else null.
// A string (even an empty one, e.g. an image-only message) means "turn start";
// only null means "not a turn start". Malformed lines are never turn starts
// but are still preserved verbatim — same never-throw discipline as the two
// transcript readers.
export function truncateAtTurnBoundary(lines, userTurnText, dropTrailingTurns = 0) {
  const starts = [];
  for (let i = 0; i < lines.length; i++) {
    let entry;
    try { entry = JSON.parse(lines[i]); } catch { continue; }
    const text = userTurnText(entry);
    if (text != null) starts.push({ index: i, text });
  }
  if (!starts.length) throw new Error('这个会话里没有可分支的用户回合');

  const drop = Math.max(0, dropTrailingTurns);
  const keptTurns = starts.length - drop;
  // Branching before the first user turn would leave a transcript with no
  // conversation in it at all — resumable, but empty, which is just a worse
  // version of starting a new task.
  if (keptTurns < 1) {
    throw new Error(`分支点太靠前:这个会话只有 ${starts.length} 个用户回合,无法向前跳过 ${drop} 个`);
  }

  const cut = drop === 0 ? lines.length : starts[keptTurns].index;
  return { kept: lines.slice(0, cut), keptTurns, anchorText: starts[keptTurns - 1].text };
}
