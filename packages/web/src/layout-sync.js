// Pure layout-sync decisions kept outside shell.jsx so the destructive edge
// cases can be regression-tested without mounting the whole React app.
export function samePaneList(a, b) {
  return Array.isArray(a) && a.length === b.length && a.every((id, i) => id === b[i]);
}

export function mergeCloudLayout(localLayout, cloudLayout) {
  const merged = { ...localLayout };
  let changed = false;
  for (const [scope, panes] of Object.entries(cloudLayout)) {
    // Keep a populated local list (it may contain newer offline work), but let
    // a populated cloud list repair a stale/corrupted local []. Cloud [] still
    // does not erase local panes, matching the existing local-first behavior.
    if (!(scope in merged) || (!merged[scope].length && panes.length)) {
      merged[scope] = panes;
      changed = true;
    }
  }
  return changed ? merged : localLayout;
}

export function layoutNeedsSave(previousPanes, panes) {
  if (samePaneList(previousPanes, panes)) return false;
  // Missing means "this scope has never saved a layout", not "the user closed
  // its final pane". A transient empty render must not create a destructive
  // [] record before task loading / jump-to-latest has settled.
  return previousPanes !== undefined || panes.length > 0;
}
