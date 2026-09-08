// Time formatting shared by the sidebar, session lists and result cards.
// Plain .js (not board.jsx) so the rollup arithmetic is unit-testable —
// node --test can't import JSX.

// How long ago something happened, at a glance: one unit only, since an age
// is a rough "when", not a measurement.
export function fmtAge(ts) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return `${s | 0}s`;
  if (s < 3600) return `${(s / 60) | 0}m`;
  if (s < 86400) return `${(s / 3600) | 0}h`;
  return `${(s / 86400) | 0}d`;
}

// A span of time (not an age): long agent turns run for many minutes, and
// "743s" is something you have to divide in your head. Rolls up at 60 —
// seconds into minutes, minutes into hours — keeping the next-smaller unit
// alongside so the number stays precise ("12m03s", not "12m").
export function fmtDuration(ms) {
  const total = Math.max(0, Math.round((ms || 0) / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  if (m < 60) return `${m}m${String(total % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}
