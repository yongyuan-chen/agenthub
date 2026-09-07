// The node self-update tarball must contain everything an executor needs to
// actually boot.
//
// This exists because it once didn't: packages/shared was never bundled, and
// nothing noticed until cloudlink.mjs imported a protocol constant from it —
// at which point every node that self-updated died on boot with
// ERR_MODULE_NOT_FOUND, all at once, with the cloud simply showing them as
// offline. Reading the build script can't catch that class of bug; resolving
// the actual import graph can.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

// What build.mjs ships to nodes. Kept in sync with NODE_PATHS there — the
// point of duplicating it is that a path silently dropped from that list
// fails here rather than in production.
const NODE_PATHS = [
  'packages/executor',
  'packages/shared',
  'deploy/setup-node.sh',
  'deploy/com.agenthub.executor.plist.template',
  'deploy/agenthub-executor.service',
  'deploy/setup-node.ps1',
  'deploy/agenthub-executor-loop.bat.template',
];

test('node package: build.mjs ships exactly the paths this test verifies', () => {
  const build = fs.readFileSync(path.join(repoRoot, 'packages/web/build.mjs'), 'utf8');
  const listed = [...build.matchAll(/^\s*'([^']+)',$/gm)].map(m => m[1]);
  for (const p of NODE_PATHS) {
    assert.ok(listed.includes(p), `build.mjs must still bundle ${p}`);
  }
});

function walkJsFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJsFiles(full, out);
    else if (full.endsWith('.mjs') || full.endsWith('.js')) out.push(full);
  }
  return out;
}

test('node package: every relative import an executor file makes is inside the shipped tarball', () => {
  // Everything the tarball would contain, as absolute paths.
  const shipped = new Set();
  for (const p of NODE_PATHS) {
    const full = path.join(repoRoot, p);
    if (!fs.existsSync(full)) continue;
    if (fs.statSync(full).isDirectory()) for (const f of walkJsFiles(full)) shipped.add(f);
    else shipped.add(full);
  }

  const missing = [];
  // scripts/ are dev-only smoke helpers, never run on a node.
  const sourceFiles = [...shipped].filter(f => f.includes(`${path.sep}src${path.sep}`) || f.includes(`${path.sep}shared${path.sep}`));
  for (const file of sourceFiles) {
    const code = fs.readFileSync(file, 'utf8');
    // Static `import ... from './x'` and dynamic `import('./x')` alike.
    const specifiers = [
      ...[...code.matchAll(/from\s+'(\.[^']+)'/g)].map(m => m[1]),
      ...[...code.matchAll(/import\(\s*'(\.[^']+)'/g)].map(m => m[1]),
    ];
    for (const spec of specifiers) {
      const resolved = path.resolve(path.dirname(file), spec);
      if (!shipped.has(resolved) && !fs.existsSync(resolved)) {
        missing.push(`${path.relative(repoRoot, file)} -> ${spec} (does not exist)`);
      } else if (!shipped.has(resolved)) {
        missing.push(`${path.relative(repoRoot, file)} -> ${spec} (exists but is NOT in the tarball)`);
      }
    }
  }
  assert.deepEqual(missing, [], 'a node installed from the tarball would fail to boot on these imports');
});
