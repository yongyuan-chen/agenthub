// cli-releases.mjs never reaches registry.npmjs.org here — `fetchImpl` and
// `now` are injectable, which is also how the TTL is exercised without
// sleeping an hour.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeD1 } from './d1-shim.mjs';
import { cachedCliVersions, refreshCliVersions, CLI_RELEASE_TTL_MS } from '../packages/worker/src/cli-releases.mjs';

const SCHEMA = path.join(path.dirname(fileURLToPath(import.meta.url)), '../packages/worker/schema.sql');
const db = () => makeD1(SCHEMA);

// Abbreviated-metadata responses, the shape npm actually returns for
// `Accept: application/vnd.npm.install-v1+json`.
const PACKUMENTS = {
  '@anthropic-ai/claude-code': { 'dist-tags': { latest: '2.1.280', stable: '2.1.273' } },
  '@openai/codex': { 'dist-tags': { latest: '0.156.1' } },
};

function fakeFetch({ fail = [], onCall } = {}) {
  return async (url, init) => {
    onCall?.(url, init);
    const pkg = decodeURIComponent(url.replace('https://registry.npmjs.org/', ''));
    if (fail.includes(pkg)) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => PACKUMENTS[pkg] ?? {} };
  };
}

test('refreshCliVersions: claude follows `stable`, codex follows `latest`', async () => {
  const calls = [];
  const d = db();
  const r = await refreshCliVersions(d, { fetchImpl: fakeFetch({ onCall: (u, i) => calls.push([u, i]) }) });
  // 2.1.273, not 2.1.280: `stable` is what `claude update` actually installs,
  // so showing `latest` would park nodes on 可升级 forever.
  assert.deepEqual(r.versions, { claude: '2.1.273', codex: '0.156.1' });
  assert.equal(r.fetched, true);
  assert.equal(r.changed, true);
  // The full packument for @openai/codex is ~12MB; this header is what keeps
  // the response small enough to parse in a Worker.
  assert.equal(calls[0][1].headers.Accept, 'application/vnd.npm.install-v1+json');
  // And it persisted for the hot paths that never fetch.
  assert.deepEqual(await cachedCliVersions(d), { claude: '2.1.273', codex: '0.156.1' });
});

test('refreshCliVersions: inside the TTL it does not hit the network at all', async () => {
  const d = db();
  let calls = 0;
  const count = fakeFetch({ onCall: () => { calls++; } });
  const t0 = 1_700_000_000_000;
  await refreshCliVersions(d, { now: t0, fetchImpl: count });
  const first = calls;
  assert.ok(first > 0);

  const cached = await refreshCliVersions(d, { now: t0 + CLI_RELEASE_TTL_MS - 1, fetchImpl: count });
  assert.equal(calls, first, 'still inside the TTL');
  assert.equal(cached.fetched, false);
  assert.deepEqual(cached.versions, { claude: '2.1.273', codex: '0.156.1' });

  await refreshCliVersions(d, { now: t0 + CLI_RELEASE_TTL_MS + 1, fetchImpl: count });
  assert.ok(calls > first, 'past the TTL it refetches');
});

test('refreshCliVersions: changed=false when the registry answers the same thing', async () => {
  const d = db();
  const t0 = 1_700_000_000_000;
  await refreshCliVersions(d, { now: t0, fetchImpl: fakeFetch() });
  const again = await refreshCliVersions(d, { now: t0 + CLI_RELEASE_TTL_MS + 1, fetchImpl: fakeFetch() });
  assert.equal(again.fetched, true);
  // This is what gates the cli_policy broadcast — a true here every hour would
  // wake every node in the fleet for no reason.
  assert.equal(again.changed, false);
});

test('refreshCliVersions: a registry outage keeps the last known target', async () => {
  const d = db();
  const t0 = 1_700_000_000_000;
  await refreshCliVersions(d, { now: t0, fetchImpl: fakeFetch() });

  const down = async () => { throw new Error('ECONNREFUSED'); };
  const r = await refreshCliVersions(d, { now: t0 + CLI_RELEASE_TTL_MS + 1, fetchImpl: down });
  // Never throws (it runs inside the DO alarm), and above all never blanks a
  // good cache — telling the whole fleet "you're up to date" because npm was
  // down for a minute is the failure this feature exists to prevent.
  assert.deepEqual(r.versions, { claude: '2.1.273', codex: '0.156.1' });
  assert.equal(r.changed, false);
  assert.deepEqual(await cachedCliVersions(d), { claude: '2.1.273', codex: '0.156.1' });

  // And it did not stamp the cache as freshly checked, so the next tick
  // retries instead of waiting out another full hour.
  let retried = false;
  await refreshCliVersions(d, {
    now: t0 + CLI_RELEASE_TTL_MS + 2,
    fetchImpl: fakeFetch({ onCall: () => { retried = true; } }),
  });
  assert.equal(retried, true);
});

test('refreshCliVersions: one CLI failing does not drag the other down', async () => {
  const d = db();
  const r = await refreshCliVersions(d, { fetchImpl: fakeFetch({ fail: ['@openai/codex'] }) });
  assert.equal(r.versions.claude, '2.1.273');
  assert.equal(r.versions.codex, undefined);
});

test('refreshCliVersions: a junk version string from the registry is ignored', async () => {
  const d = db();
  const junk = async (url) => ({
    ok: true, status: 200,
    json: async () => (url.includes('claude-code')
      // Rendered in everyone's UI and handed to nodes as an upgrade target —
      // it has to look like a version or it doesn't get used.
      ? { 'dist-tags': { stable: 'rm -rf /', latest: '2.1.280' } }
      : { 'dist-tags': { latest: '0.156.1' } }),
  });
  const r = await refreshCliVersions(d, { fetchImpl: junk });
  assert.equal(r.versions.claude, '2.1.280', 'falls through to the next valid tag');
  assert.equal(r.versions.codex, '0.156.1');
});

test('cachedCliVersions: empty before anything has ever been fetched', async () => {
  assert.deepEqual(await cachedCliVersions(db()), {});
});
