import React, { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { state } from './store.js';

// A deep path is most informative at its tail, but CSS left-truncation via
// `direction: rtl` reorders the leading slash to the end ("tmp/x/" for
// "/tmp/x") — bidi reordering, not a bug in the path. Shortening here keeps
// the text plain LTR.
const shortPath = (p, keep = 3) => {
  const parts = String(p || '').split('/').filter(Boolean);
  if (parts.length <= keep) return p;
  return `…/${parts.slice(-keep).join('/')}`;
};

const fmtSize = (n) => {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};

// CodeMirror is ~300KB and most sessions never open a file, so it is pulled in
// on first use rather than riding in the main bundle (see build.mjs's
// splitting). Cached across mounts: the second file opens instantly.
let codemirrorPromise = null;
function loadCodemirror() {
  if (!codemirrorPromise) {
    codemirrorPromise = Promise.all([
      import('codemirror'),
      import('@codemirror/state'),
      import('@codemirror/view'),
      import('@codemirror/lang-javascript'),
      import('@codemirror/lang-python'),
      import('@codemirror/lang-json'),
      import('@codemirror/lang-markdown'),
      import('@codemirror/lang-css'),
      import('@codemirror/lang-html'),
    ]).then(([cm, cmState, cmView, js, py, json, md, css, html]) => ({ cm, cmState, cmView, js, py, json, md, css, html }));
  }
  return codemirrorPromise;
}

function languageFor(mods, filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  if (['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx'].includes(ext)) {
    return mods.js.javascript({ jsx: ext.endsWith('x'), typescript: ext.startsWith('ts') });
  }
  if (ext === 'py') return mods.py.python();
  if (['json', 'jsonc', 'webmanifest'].includes(ext)) return mods.json.json();
  if (['md', 'markdown'].includes(ext)) return mods.md.markdown();
  if (['css', 'scss', 'less'].includes(ext)) return mods.css.css();
  if (['html', 'htm', 'xml', 'svg'].includes(ext)) return mods.html.html();
  return null; // plain text: still editable, just unhighlighted
}

// The editor is imperative (CodeMirror owns its own DOM), so it lives behind a
// ref and is fed via effects rather than re-created on every render — a
// re-created editor would lose the cursor on every keystroke.
function Editor({ file, onChange, onSave }) {
  const hostRef = useRef(null);
  const viewRef = useRef(null);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadCodemirror().then(mods => {
      if (cancelled || !hostRef.current) return;
      viewRef.current?.destroy();
      const lang = languageFor(mods, file.path);
      const extensions = [
        mods.cm.basicSetup,
        // basicSetup does not wrap. Without this a long line is simply cut off
        // at the pane's edge and can only be read by scrolling sideways —
        // which for prose-heavy files (a CLAUDE.md, a README) means most of
        // the content is invisible by default.
        mods.cmView.EditorView.lineWrapping,
        mods.cmView.EditorView.updateListener.of(u => { if (u.docChanged) onChange(u.state.doc.toString()); }),
        mods.cmView.keymap.of([{
          key: 'Mod-s',
          run: () => { onSaveRef.current?.(); return true; },
        }]),
      ];
      if (lang) extensions.push(lang);
      viewRef.current = new mods.cmView.EditorView({
        state: mods.cmState.EditorState.create({ doc: file.content, extensions }),
        parent: hostRef.current,
      });
      setLoading(false);
    }).catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; viewRef.current?.destroy(); viewRef.current = null; };
    // Keyed on the file identity, not its content: re-running on every edit
    // would rebuild the editor mid-typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.path, file.loadedAt]);

  return (
    <div className="file-editor">
      {loading && <div className="muted file-editor-loading">正在加载编辑器…</div>}
      <div ref={hostRef} className="file-editor-host" />
    </div>
  );
}


const joinPath = (dir, name) => `${String(dir).replace(/\/+$/, '')}/${name}`;

// One directory's children, rendered inline under it. Recursive rather than a
// flattened list because the depth is what carries the structure — and because
// collapsing a folder should take its whole subtree with it without any
// bookkeeping about which rows belonged to it.
//
// Children are fetched the first time a folder is opened and then kept: a home
// directory can hold hundreds of entries, and re-listing every one on each
// toggle would make the tree feel slower the more you use it.
function TreeLevel({ dir, depth, dirs, expanded, activePath, onToggle, onOpenFile }) {
  const node = dirs.get(dir);
  if (!node) return null;
  if (node.loading) return <div className="muted file-tree-loading" style={{ paddingLeft: depth * 13 + 10 }}>载入中…</div>;
  if (node.error) return <div className="err file-tree-error" style={{ paddingLeft: depth * 13 + 10 }}>无法读取:{node.error}</div>;
  if (!node.entries.length) return <div className="muted file-tree-empty" style={{ paddingLeft: depth * 13 + 10 }}>空</div>;

  return (
    <>
      {node.entries.map(entry => {
        const full = joinPath(dir, entry.name);
        const isDir = entry.type === 'dir';
        const isOpen = expanded.has(full);
        return (
          <React.Fragment key={full}>
            <button
              type="button"
              className={`file-entry ${isDir ? 'is-dir' : ''} ${activePath === full ? 'active' : ''}`}
              style={{ paddingLeft: depth * 13 + 6 }}
              onClick={() => (isDir ? onToggle(full) : onOpenFile(full))}
              title={entry.name}
            >
              {/* The chevron column is reserved on files too, so names line up
                  in a column instead of stepping in and out by folder. */}
              <span className="file-entry-twisty">{isDir ? (isOpen ? '▾' : '▸') : ''}</span>
              <span className="file-entry-icon">{isDir ? (isOpen ? '📂' : '📁') : '📄'}</span>
              <span className="file-entry-name">{entry.name}</span>
              {!isDir && <span className="muted file-entry-size">{fmtSize(entry.size)}</span>}
            </button>
            {isDir && isOpen && (
              <TreeLevel
                dir={full} depth={depth + 1} dirs={dirs} expanded={expanded}
                activePath={activePath} onToggle={onToggle} onOpenFile={onOpenFile}
              />
            )}
          </React.Fragment>
        );
      })}
      {node.truncated && (
        <div className="muted file-tree-empty" style={{ paddingLeft: depth * 13 + 10 }}>条目过多,只显示了前面一部分</div>
      )}
    </>
  );
}

export function FilePane({ nodeId, taskId, onClose, maximized, onToggleMaximize }) {
  const [root, setRoot] = useState('');            // the folder the tree is rooted at
  const [rootParent, setRootParent] = useState(null);
  const [dirs, setDirs] = useState(() => new Map()); // path -> {entries, truncated, error, loading}
  const [expanded, setExpanded] = useState(() => new Set());
  const [listError, setListError] = useState('');
  // Hiding the tree hands its 246px to the editor. Remembered because it's a
  // working preference ("I'm reading code now, not navigating"), unlike
  // maximizing which is a momentary gesture.
  const [treeOpen, setTreeOpen] = useState(() => localStorage.getItem('agenthub_filetree_off') !== '1');
  const toggleTree = () => setTreeOpen(v => {
    if (v) localStorage.setItem('agenthub_filetree_off', '1');
    else localStorage.removeItem('agenthub_filetree_off');
    return !v;
  });
  const [file, setFile] = useState(null);         // {path, content, mtime, binary, truncated, loadedAt}
  const [draft, setDraft] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [conflict, setConflict] = useState(false);
  const node = state.nodes.get(nodeId);

  // Fetch one folder's children into `dirs`. Marking it loading first is what
  // keeps a slow directory from looking like an empty one.
  const fetchDir = (path, { asRoot = false, taskScoped = false } = {}) => {
    setDirs(prev => new Map(prev).set(path, { entries: [], loading: true }));
    // taskId only steers the *first* listing — once the user navigates, an
    // explicit path always wins, or every click would bounce back to the
    // task's directory.
    return api.listNodeFiles(nodeId, taskScoped ? '' : path, taskScoped ? (taskId || '') : '')
      .then(r => {
        // The node resolves '~', a taskId, or a relative path into a real
        // absolute one, and that resolved path — not what we asked for — is
        // the key every child path is built from.
        const resolved = r.path || path;
        setDirs(prev => {
          const next = new Map(prev);
          if (resolved !== path) next.delete(path);
          next.set(resolved, { entries: r.entries || [], truncated: !!r.truncated, error: r.error || null });
          return next;
        });
        if (asRoot) { setRoot(resolved); setRootParent(r.parent ?? null); }
        return resolved;
      })
      .catch(e => {
        setDirs(prev => new Map(prev).set(path, { entries: [], error: e.message || '读取失败' }));
        if (asRoot) setListError(e.message || '读取目录失败');
      });
  };

  // Re-root the tree (used by ".." and by the initial load). Collapsing
  // everything is deliberate: the previous root's expansions describe a
  // different subtree and would otherwise linger as stale state.
  const reroot = (path, taskScoped = false) => {
    setListError('');
    setExpanded(new Set());
    setDirs(new Map());
    fetchDir(path ?? '', { asRoot: true, taskScoped });
  };
  useEffect(() => { reroot('', true); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [nodeId]);

  const toggleDir = (path) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else {
        next.add(path);
        if (!dirs.has(path)) fetchDir(path);
      }
      return next;
    });
  };

  const openFile = (full) => {
    if (dirty && !confirm('当前文件有未保存的修改,确定要打开别的文件吗?')) return;
    setSaveError(''); setConflict(false);
    api.readNodeFile(nodeId, full)
      .then(r => {
        setFile({ ...r, loadedAt: Date.now() });
        setDraft(r.content || '');
        setDirty(false);
      })
      .catch(e => setSaveError(e.message || '读取文件失败'));
  };

  const save = async (force = false) => {
    if (!file || saving) return;
    setSaving(true); setSaveError(''); setConflict(false);
    try {
      const r = await api.writeNodeFile(nodeId, file.path, draft, force ? null : file.mtime);
      setFile(f => ({ ...f, mtime: r.mtime }));
      setDirty(false);
    } catch (e) {
      // The 409 body carries {conflict:true} — the file changed under us,
      // almost always because the agent edited it. Offer both ways out
      // instead of just failing.
      let parsed = null;
      try { parsed = JSON.parse(e.message); } catch { /* a plain error */ }
      if (parsed?.conflict) setConflict(true);
      else setSaveError(e.message || '保存失败');
    }
    setSaving(false);
  };

  const reload = () => {
    if (!file) return;
    api.readNodeFile(nodeId, file.path).then(r => {
      setFile({ ...r, loadedAt: Date.now() });
      setDraft(r.content || '');
      setDirty(false); setConflict(false); setSaveError('');
    }).catch(e => setSaveError(e.message || '读取失败'));
  };

  return (
    <div className="file-pane">
      <header className="pane-header">
        <div className="task-head">
          <h2>📁 {node?.name || nodeId}</h2>
          <div className="muted file-pane-path" title={root}>{root ? shortPath(root) : '…'}</div>
        </div>
        <button type="button" className="ghost pane-tree-btn" onClick={toggleTree}
          title={treeOpen ? '收起文件树' : '展开文件树'} aria-label={treeOpen ? '收起文件树' : '展开文件树'}>
          {treeOpen ? '◧' : '▤'}
        </button>
        {file && dirty && <span className="chip st-waiting">未保存</span>}
        {file && (
          <button type="button" disabled={!dirty || saving} onClick={() => save(false)}>
            {saving ? '保存中…' : '保存'}
          </button>
        )}
{onToggleMaximize && (
          <button type="button" className="ghost pane-max-btn" onClick={onToggleMaximize}
            title={maximized ? '还原' : '最大化(占满工作区)'} aria-label={maximized ? '还原' : '最大化'}>
            {maximized ? '⤡' : '⤢'}
          </button>
        )}
        {onClose && <button type="button" className="ghost pane-close-btn" onClick={onClose} aria-label="关闭">✕</button>}
      </header>

      {conflict && (
        <div className="review-bar file-conflict">
          <span>⚠️ 这个文件在你编辑期间被改过(多半是 agent 改的) — 直接保存会覆盖掉它的修改</span>
          <div className="review-bar-actions">
            <button type="button" className="ghost" onClick={reload}>放弃我的修改,重新加载</button>
            <button type="button" className="deny" onClick={() => save(true)}>强制覆盖</button>
          </div>
        </div>
      )}
      {saveError && (
        <div className="review-bar"><span className="err">{saveError}</span></div>
      )}

      <div className="file-body">
        {treeOpen && <nav className="file-tree">
          {listError && <div className="err file-tree-error">{listError}</div>}
          {/* Climbing out of the root re-roots the tree rather than nesting
              upward — a tree whose root drifts toward / gets unusable fast. */}
          {rootParent && (
            <button type="button" className="file-entry file-entry-up" onClick={() => reroot(rootParent)}>
              <span className="file-entry-twisty" />
              <span className="file-entry-icon">↰</span>
              <span className="file-entry-name">..</span>
            </button>
          )}
          {root && (
            <TreeLevel
              dir={root} depth={0} dirs={dirs} expanded={expanded}
              activePath={file?.path || null} onToggle={toggleDir} onOpenFile={openFile}
            />
          )}
        </nav>}

        <section className="file-view">
          {!file && <div className="empty">从左边选一个文件</div>}
          {file?.binary && (
            <div className="empty">
              二进制文件({fmtSize(file.size)}),不支持编辑
              {/^data:|\.(png|jpe?g|gif|webp|svg)$/i.test(file.path) && (
                <img className="file-image" alt="" src={`data:image;base64,${file.content}`} />
              )}
            </div>
          )}
          {file && !file.binary && (
            <>
              {file.truncated && (
                <div className="muted file-truncated">
                  文件超过 1MB,只加载了前面一部分 — 保存会截断内容,请改用编辑器直接在机器上改
                </div>
              )}
              <Editor
                file={{ ...file, content: file.content }}
                onChange={(v) => { setDraft(v); setDirty(true); }}
                onSave={() => save(false)}
              />
            </>
          )}
        </section>
      </div>
    </div>
  );
}
