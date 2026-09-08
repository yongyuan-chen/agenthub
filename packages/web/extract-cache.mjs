// Offline helper: pull exact package tarballs out of the local npm cacache so
// the frontend can be built with no registry access. Only used in restricted
// environments; normal machines just `npm install`.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const WANT = [
  ['react', '19.2.7'],
  ['react-dom', '19.2.7'],
  ['scheduler', '0.27.0'],
  ['marked', '17.0.6'],
  // File-browser editor; loaded as a separate chunk (see build.mjs).
  ['codemirror', '6.0.2'],
  ['esbuild', '0.28.1'],
  ['@esbuild/darwin-arm64', '0.28.1'],
];

const cacheRoot = path.join(os.homedir(), '.npm', '_cacache');
const indexDir = path.join(cacheRoot, 'index-v5');
const outDir = path.join(process.cwd(), 'vendor');
fs.mkdirSync(outDir, { recursive: true });

const entries = new Map(); // url key -> integrity
function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p);
    else {
      const lines = fs.readFileSync(p, 'utf8').split('\n');
      for (const line of lines) {
        const tab = line.indexOf('\t');
        if (tab < 0) continue;
        try {
          const meta = JSON.parse(line.slice(tab + 1));
          if (meta.key && meta.integrity) entries.set(meta.key, meta.integrity);
        } catch { /* partial line */ }
      }
    }
  }
}
walk(indexDir);

function contentPath(integrity) {
  const [algo, digest] = integrity.split('-', 2);
  const hex = Buffer.from(digest, 'base64').toString('hex');
  return path.join(cacheRoot, 'content-v2', algo, hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
}

const found = [];
for (const [pkg, version] of WANT) {
  const base = pkg.startsWith('@') ? pkg.split('/')[1] : pkg;
  const needles = [
    `/${pkg}/${version}/${base}-${version}.tgz`,
    `/${pkg.replace('@', '%40')}/${version}/${base}-${version}.tgz`,
    `/${pkg.replace('@', '%40').replace('/', '%2f')}/${version}/${base}-${version}.tgz`,
  ];
  let hit = null;
  for (const key of entries.keys()) {
    if (needles.some(n => key.endsWith(n))) { hit = key; break; }
  }
  if (!hit) { console.error('MISSING in cache:', pkg, version); process.exit(1); }
  const src = contentPath(entries.get(hit));
  const outName = `${pkg.replace(/[@/]/g, '_')}-${version}.tgz`;
  fs.copyFileSync(src, path.join(outDir, outName));
  found.push(outName);
  console.log('extracted', outName);
}
console.log('OK', found.length, 'tarballs in', outDir);
