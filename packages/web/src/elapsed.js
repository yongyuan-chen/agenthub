import { useEffect, useState } from 'react';

// Statuses where a turn is actually in flight — mirrors hub-core.mjs's
// BUSY_STATUSES, which is what decides when run_started_at gets stamped.
export const RUNNING_STATUSES = new Set(['running', 'starting']);

// A clock that only ticks while something on screen needs it. One interval per
// component, not per row: the sidebar re-renders as a whole anyway.
export function useNow(active) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

// How long the current turn has been running, or null when nothing is.
// Anchored to the server's run_started_at rather than to when the component
// mounted: opening the conversation (or a second device) mid-run shows the
// real elapsed time instead of restarting from zero.
export function useElapsed(since, active) {
  const running = !!active && !!since;
  const now = useNow(running);
  return running ? Math.max(0, now - since) : null;
}

// Same thing for a list, where one clock drives many rows.
export function elapsedOf(task, now) {
  if (!task || !RUNNING_STATUSES.has(task.status) || !task.run_started_at) return null;
  return Math.max(0, now - task.run_started_at);
}
