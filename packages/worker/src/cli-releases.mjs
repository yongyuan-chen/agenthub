// What the newest published version of each agent CLI is, fetched once for
// the whole fleet and cached in D1.
//
// Nodes deliberately don't do this themselves. One cached answer serves every
// node instead of N polls for the same number, and a node on a slow or
// filtered link to registry.npmjs.org (several of this deployment's boxes are)
// would otherwise never learn it's behind — which is the exact failure this
// whole feature exists to fix.
//
// Channel choice per CLI, and why they differ:
//   claude -> dist-tag `stable`. That is what the CLI's own `claude update`
//     installs, and the upgrade path runs `claude update`. Using `latest`
//     (which tracks `next`) would show a target the upgrade button provably
//     cannot reach, i.e. a node stuck on "可升级" forever.
//   codex  -> dist-tag `latest`. It publishes no `stable` tag at all; its
//     other tags are per-platform builds and alphas, neither of which is a
//     thing to chase.

// Same one-liner hub-core.mjs uses, redeclared rather than imported: this
// module is imported *by* hub-core, and an import cycle for a three-token
// helper isn't worth the load-order risk.
const q = (db, sql, ...params) => db.prepare(sql).bind(...params);

const SETTINGS_KEY = 'cli_latest_versions';
export const CLI_RELEASE_TTL_MS = 3600_000;

const SOURCES = {
  claude: { pkg: '@anthropic-ai/claude-code', tags: ['stable', 'latest'] },
  codex: { pkg: '@openai/codex', tags: ['latest'] },
};

// The full packument for these packages is enormous (@openai/codex alone is
// ~12MB of version history) and we want four bytes of it. This Accept header
// is npm's documented "abbreviated metadata" form, which still carries
// dist-tags.
const ABBREVIATED = 'application/vnd.npm.install-v1+json';

const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+.][0-9A-Za-z.]+)?$/;

async function fetchOne(source, fetchImpl) {
  const res = await fetchImpl(`https://registry.npmjs.org/${source.pkg}`, {
    headers: { Accept: ABBREVIATED },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  for (const tag of source.tags) {
    const v = body?.['dist-tags']?.[tag];
    // Validated rather than trusted: this value is handed to nodes as an
    // upgrade target and rendered in the UI, and a registry that answers with
    // something unexpected shouldn't be able to put arbitrary text there.
    if (typeof v === 'string' && VERSION_RE.test(v)) return v;
  }
  return null;
}

async function readCache(db) {
  const row = await q(db, 'SELECT value FROM app_settings WHERE key = ?', SETTINGS_KEY).first();
  if (!row?.value) return null;
  try {
    const parsed = JSON.parse(row.value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
}

// Cheap read for every hot path (hello, GET /api/nodes). Never fetches:
// blocking a node handshake on a third-party HTTP request is how one slow
// registry turns into every node reconnecting slowly.
export async function cachedCliVersions(db) {
  const cache = await readCache(db);
  return cache?.versions ?? {};
}

// Refresh if the cache is older than the TTL. Returns
// {versions, changed, fetched}. Never throws and never blanks a good cached
// answer on a failed fetch — a registry outage should leave the fleet on the
// last known target, not tell every node it's up to date.
export async function refreshCliVersions(db, { now = Date.now(), fetchImpl = fetch, ttlMs = CLI_RELEASE_TTL_MS } = {}) {
  const cache = await readCache(db);
  const versions = { ...(cache?.versions ?? {}) };
  if (cache?.fetchedAt && now - cache.fetchedAt < ttlMs) {
    return { versions, changed: false, fetched: false };
  }

  let changed = false;
  let anyOk = false;
  for (const [backend, source] of Object.entries(SOURCES)) {
    try {
      const v = await fetchOne(source, fetchImpl);
      if (!v) continue;
      anyOk = true;
      if (versions[backend] !== v) { versions[backend] = v; changed = true; }
    } catch { /* keep the previous value for this CLI */ }
  }
  // Only stamp fetchedAt when something actually came back, so a failed pass
  // is retried on the next tick instead of being cached as "checked" for an
  // hour.
  if (!anyOk) return { versions, changed: false, fetched: false };

  await q(db,
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    SETTINGS_KEY, JSON.stringify({ fetchedAt: now, versions })).run();
  return { versions, changed, fetched: true };
}
