import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const outdir = 'dist';
fs.rmSync(outdir, { recursive: true, force: true });
fs.mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: ['src/main.jsx'],
  bundle: true,
  minify: true,
  format: 'iife',
  jsx: 'automatic',
  outfile: path.join(outdir, 'app.js'),
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.js': 'jsx' },
  logLevel: 'info',
});

for (const f of fs.readdirSync('public')) {
  fs.copyFileSync(path.join('public', f), path.join(outdir, f));
}
console.log('web build complete ->', outdir);
