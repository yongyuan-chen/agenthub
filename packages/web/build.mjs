import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Content hash (not the tarball's own bytes — tar embeds mtimes, which would
// change on every build even with zero code changes) of everything shipped
// to nodes, so the executor's self-updater only restarts when the code it
// actually runs has changed.
function hashTree(root, relPaths) {
  const hash = createHash('sha256');
  const files = [];
  const walk = (rel) => {
    const abs = path.join(root, rel);
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      for (const entry of fs.readdirSync(abs).sort()) walk(path.join(rel, entry));
    } else {
      files.push(rel);
    }
  };
  for (const rp of relPaths) walk(rp);
  for (const f of files.sort()) {
    hash.update(f);
    hash.update(fs.readFileSync(path.join(root, f)));
  }
  return hash.digest('hex');
}

const outdir = 'dist';
fs.rmSync(outdir, { recursive: true, force: true });
fs.mkdirSync(outdir, { recursive: true });

// The agents SDK and its React hooks live in the repo-root node_modules while
// the app's own React lives here, so npm resolved a second React copy up there
// as a peer. Two copies means two hook dispatchers, and every SDK hook throws
// "Cannot read properties of null (reading 'useMemo')" at runtime. Pinning
// both packages to this one copy is the standard dedupe; esbuild rewrites
// subpaths (react/jsx-runtime) along with the bare package name.
const dedupe = ['react', 'react-dom'];
const alias = Object.fromEntries(dedupe.map(pkg => [pkg, path.resolve('node_modules', pkg)]));

await build({
  entryPoints: ['src/main.jsx'],
  bundle: true,
  minify: true,
  format: 'iife',
  jsx: 'automatic',
  alias,
  outfile: path.join(outdir, 'app.js'),
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.js': 'jsx' },
  logLevel: 'info',
});

for (const f of fs.readdirSync('public')) {
  fs.copyFileSync(path.join('public', f), path.join(outdir, f));
}

// Bundle the executor + node-enrollment scripts so /install.sh (served as a
// static asset) can pull down everything a new server needs in one curl|bash.
const repoRoot = path.resolve('../..');
const NODE_PATHS = [
  'packages/executor',
  'deploy/setup-node.sh',
  'deploy/com.agenthub.executor.plist.template',
  'deploy/agenthub-executor.service',
  'deploy/setup-node.ps1',
  'deploy/agenthub-executor-loop.bat.template',
];
const version = hashTree(repoRoot, NODE_PATHS);
const versionTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-version-'));
fs.writeFileSync(path.join(versionTmpDir, 'VERSION'), version);

execFileSync('tar', [
  '--exclude', '.claude',
  '-czf', path.join(path.resolve(outdir), 'agenthub-node.tar.gz'),
  '-C', repoRoot, ...NODE_PATHS,
  '-C', versionTmpDir, 'VERSION',
]);
fs.rmSync(versionTmpDir, { recursive: true, force: true });
fs.writeFileSync(path.join(outdir, 'agenthub-node.version'), version);

console.log('web build complete ->', outdir, `(node version ${version.slice(0, 12)})`);
