// The file tree's shape, rendered.
//
// The behaviours worth pinning are structural rather than visual: a collapsed
// folder must take its whole subtree with it, depth has to actually indent,
// and a folder that hasn't been fetched yet must not look like an empty one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { transformSync } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webSrc = path.join(here, '../packages/web/src');
const webRequire = createRequire(path.join(here, '../packages/web/package.json'));
const React = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');

// filepane.jsx imports the api/store graph and CodeMirror; compiling just the
// tree component keeps this a rendering test rather than an app boot.
function loadTreeLevel() {
  const source = fs.readFileSync(path.join(webSrc, 'filepane.jsx'), 'utf8');
  const start = source.indexOf('const joinPath =');
  const end = source.indexOf('export function FilePane(');
  assert.ok(start > 0 && end > start, 'the tree component still exists in filepane.jsx');
  const snippet = `${source.slice(start, end)}\nexport { TreeLevel };`;
  const { code } = transformSync(
    `const fmtSize = (n) => (n == null ? '' : String(n));\n${snippet}`,
    { loader: 'jsx', format: 'cjs', jsx: 'automatic' },
  );
  const module = { exports: {} };
  // The component uses <React.Fragment> explicitly, which the automatic JSX
  // runtime does not provide — it only injects jsx()/jsxs(). So React has to
  // be in scope here too.
  new Function('module', 'exports', 'require', 'React', code)(module, module.exports, webRequire, React);
  return module.exports.TreeLevel;
}

const TreeLevel = loadTreeLevel();
const render = (props) => renderToStaticMarkup(React.createElement(TreeLevel, {
  depth: 0, activePath: null, onToggle: () => {}, onOpenFile: () => {}, ...props,
}));

test('file tree: a collapsed folder hides its whole subtree, expanding reveals it', () => {
  const dirs = new Map([
    ['/r', { entries: [{ name: 'src', type: 'dir' }, { name: 'a.js', type: 'file', size: 3 }] }],
    ['/r/src', { entries: [{ name: 'deep.js', type: 'file', size: 5 }] }],
  ]);

  const collapsed = render({ dir: '/r', dirs, expanded: new Set() });
  assert.ok(collapsed.includes('src') && collapsed.includes('a.js'));
  assert.ok(!collapsed.includes('deep.js'), 'children of a collapsed folder are not rendered at all');
  assert.ok(collapsed.includes('▸'), 'a collapsed folder shows it can be opened');

  const open = render({ dir: '/r', dirs, expanded: new Set(['/r/src']) });
  assert.ok(open.includes('deep.js'), 'expanding renders the child level inline');
  assert.ok(open.includes('▾'));
});

test('file tree: depth indents, and files reserve the twisty column so names align', () => {
  const dirs = new Map([
    ['/r', { entries: [{ name: 'src', type: 'dir' }] }],
    ['/r/src', { entries: [{ name: 'deep.js', type: 'file', size: 5 }] }],
  ]);
  const html = render({ dir: '/r', dirs, expanded: new Set(['/r/src']) });
  const pads = [...html.matchAll(/padding-left:\s*(\d+)px/g)].map(m => Number(m[1]));
  assert.ok(pads.length >= 2, 'every row carries an explicit indent');
  assert.ok(pads[1] > pads[0], 'a nested row is indented further than its parent');
  // Two twisty spans: one with a chevron (the folder), one empty (the file).
  assert.equal((html.match(/file-entry-twisty/g) || []).length, 2);
});

test('file tree: an unfetched or failed folder is not shown as empty', () => {
  const loading = render({ dir: '/r', dirs: new Map([['/r', { entries: [], loading: true }]]), expanded: new Set() });
  assert.ok(loading.includes('载入中'), 'a pending fetch says so rather than showing nothing');

  const failed = render({ dir: '/r', dirs: new Map([['/r', { entries: [], error: 'EACCES' }]]), expanded: new Set() });
  assert.ok(failed.includes('EACCES'), 'a permission error is surfaced, not swallowed into "empty"');

  const missing = render({ dir: '/nope', dirs: new Map(), expanded: new Set() });
  assert.equal(missing, '', 'a folder with no record yet renders nothing at all');
});

test('file tree: the open file is the one marked active, by full path not name', () => {
  const dirs = new Map([
    ['/r', { entries: [{ name: 'a.js', type: 'file', size: 1 }, { name: 'src', type: 'dir' }] }],
    // Same basename in two places — matching on the name alone would light up both.
    ['/r/src', { entries: [{ name: 'a.js', type: 'file', size: 1 }] }],
  ]);
  const html = render({ dir: '/r', dirs, expanded: new Set(['/r/src']), activePath: '/r/src/a.js' });
  assert.equal((html.match(/file-entry [^"]*active/g) || []).length, 1, 'exactly one row is active');
});
