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
export function truncateAtTurnBoundary(lines, userTurnText, dropTrailingTurns = 0, {
  allowEmptyPrefix = false, expectedLastUserText, expectedLastUserTs, previousUserText,
} = {}) {
  const starts = [];
  for (let i = 0; i < lines.length; i++) {
    let entry;
    try { entry = JSON.parse(lines[i]); } catch { continue; }
    const text = userTurnText(entry);
    // Both transcript formats (claude and codex rollouts) carry an ISO
    // top-level `timestamp`; NaN/absent just means "unknown".
    const ts = Date.parse(entry?.timestamp);
    if (text != null) starts.push({ index: i, text, ts: Number.isFinite(ts) ? ts : null });
  }
  if (!starts.length) throw new Error('这个会话里没有可分支的用户回合');

  // Editing must never guess at a native/cloud alignment. In particular a
  // terminal turn or context compaction can invalidate the cloud's anchor.
  //
  // One misalignment is provable rather than guessed: the board message was
  // never written to the transcript at all. Found live — stop pressed ~2s
  // after sending killed the CLI before it persisted the input, so the
  // board's latest user message had no native counterpart and every edit of
  // it was refused. The CLI stamps a user line when it writes it, always
  // after the executor stamped the send (same host clock), so a native last
  // turn that *predates* the send cannot be that message. It must then be
  // exactly the board's previous user message, and nothing native needs
  // dropping for the unsent one. Without timestamps this stays the strict
  // text check.
  let drop = Math.max(0, dropTrailingTurns);
  let unpersisted = false;
  if (expectedLastUserText !== undefined) {
    const last = starts.at(-1);
    unpersisted = expectedLastUserTs != null && last.ts != null && last.ts < expectedLastUserTs;
    const expected = unpersisted ? previousUserText : expectedLastUserText;
    if (expected === undefined || last.text !== expected) {
      throw new Error('原生会话最后一条用户消息与看板不一致,无法安全回退;请同步历史后重试');
    }
    if (unpersisted) drop = Math.max(0, drop - 1);
  }
  const keptTurns = starts.length - drop;
  // Branching before the first user turn would leave a transcript with no
  // conversation in it at all — resumable, but empty, which is just a worse
  // version of starting a new task.
  if (keptTurns < (allowEmptyPrefix ? 0 : 1)) {
    throw new Error(`分支点太靠前:这个会话只有 ${starts.length} 个用户回合,无法向前跳过 ${drop} 个`);
  }

  const cut = drop === 0 ? lines.length : starts[keptTurns].index;
  return { kept: lines.slice(0, cut), keptTurns, anchorText: starts[keptTurns - 1]?.text ?? null, unpersisted };
}
