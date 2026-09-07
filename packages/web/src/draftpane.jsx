import React, { useEffect, useState } from 'react';
import { api } from './api.js';
import { state, upsertTask, bump } from './store.js';
import { SessionPicker } from './sessionpicker.jsx';
import { useAttachments, AttachmentStrip, AttachButton, imageFilesFromPaste } from './composer.jsx';

// Below this many options, show them as inline selectable chips instead of
// making the user open a dropdown — most accounts have a handful of nodes
// and model profiles, so a dropdown is needless friction for the common case.
const INLINE_THRESHOLD = 4;

function deriveTitle(text) {
  const line = text.split('\n')[0].trim();
  return line.length > 40 ? line.slice(0, 40) + '…' : (line || '新对话');
}

// A pane slot with no task yet: pick a project path (or take the account
// default), type the first message, and sending it is what actually creates
// the task — no upfront title/spec form to get through first.
export function DraftPane({ onCreated, onClose }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [path, setPath] = useState('');
  const [pathTouched, setPathTouched] = useState(false);
  const [defaultRepoUrl, setDefaultRepoUrl] = useState('');
  const [recents, setRecents] = useState([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [customPath, setCustomPath] = useState('');
  const [pathSuggestions, setPathSuggestions] = useState([]);
  const [nodeId, setNodeId] = useState(null); // null = follow auto-pick until user explicitly chooses
  const [nodePickerOpen, setNodePickerOpen] = useState(false);
  const [profiles, setProfiles] = useState([]);
  const [modelProfileId, setModelProfileId] = useState(null); // null = 默认配置
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [baseBranch, setBaseBranch] = useState(''); // empty = auto-detect the repo's actual default branch
  const [permissionMode, setPermissionMode] = useState('bypassPermissions');
  const [showSessionPicker, setShowSessionPicker] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  // Same composer affordances as an ongoing conversation (task.jsx) — the
  // first message is a message. A draft pane is created fresh per slot, so
  // there's no id to reset on.
  const { attachments, addFiles, removeAttachment, wireImages, hasError: attachmentError }
    = useAttachments('draft', setErr);

  useEffect(() => {
    api.getSettings().then(s => {
      setDefaultRepoUrl(s.defaultRepoUrl || '');
      setPath(prev => (pathTouched ? prev : (s.defaultRepoUrl || '')));
    }).catch(() => {});
    api.recentRepos().then(r => setRecents(r.repos || [])).catch(() => {});
    api.modelProfiles().then(r => {
      const profiles = r.profiles || [];
      setProfiles(profiles);
      // Default to whichever model was used last time (creating a task with
      // a different one makes THAT the new sticky default, see hub-core.mjs's
      // POST /api/tasks) — but only if it's still a real profile; one that's
      // since been deleted falls back to null (the flagged-default profile).
      if (r.lastModelProfileId && profiles.some(p => p.id === r.lastModelProfileId)) {
        setModelProfileId(r.lastModelProfileId);
      }
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const nodes = [...state.nodes.values()];
  const autoNode = nodes.find(n => n.status === 'online') || nodes[0];
  const selectedNode = (nodeId && nodes.find(n => n.id === nodeId)) || autoNode;
  const selectedProfile = modelProfileId ? profiles.find(p => p.id === modelProfileId) : null;

  // Autocomplete subdirectories on the selected node as the custom path is typed.
  useEffect(() => {
    if (!customPath.trim() || !selectedNode) { setPathSuggestions([]); return; }
    const timer = setTimeout(() => {
      api.browseNode(selectedNode.id, customPath.trim()).then(r => setPathSuggestions(r.entries || [])).catch(() => setPathSuggestions([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [customPath, selectedNode?.id]);

  const pickPath = (p) => {
    setPath(p); setPathTouched(true); setPickerOpen(false); setCustomPath(''); setPathSuggestions([]);
  };
  const pickNode = (id) => { setNodeId(id); setNodePickerOpen(false); };
  const pickProfile = (id) => { setModelProfileId(id); setModelPickerOpen(false); };

  // Shared by the composer's send and by picking an existing session:
  // resuming a session already has content to pick up from, so picking one
  // creates the task right away (history import happens immediately, and the
  // pane becomes a real persisted task instead of vanishing on refresh) —
  // any text already typed still goes along as the first message, but it's
  // no longer required when resuming.
  const createNow = async (resumeSessionId, resumePreview) => {
    const t = text.trim();
    const images = wireImages();
    // Images with no text is a complete first message ("这个报错怎么回事?" is
    // often the screenshot alone), so it's enough on its own to create.
    if (!t && !images.length && !resumeSessionId) return;
    if (attachmentError) return;
    if (!selectedNode) { setErr('还没有可用节点,请先在左侧「+ 添加节点」'); return; }
    setBusy(true); setErr('');
    // Resuming with nothing typed uses the session's own first-message
    // preview as the title (a real name, same as any other conversation
    // gets from its first message) — the session id hash is only a last
    // resort when even that preview is empty.
    const fallbackTitle = resumeSessionId
      ? (resumePreview && resumePreview !== '(空会话)' ? deriveTitle(resumePreview) : `继续会话 ${resumeSessionId.slice(0, 8)}`)
      : '图片对话'; // images-only: nothing typed to derive a name from
    try {
      const r = await api.createTask({
        title: t ? deriveTitle(t) : fallbackTitle,
        spec: t || undefined, images: images.length ? images : undefined,
        nodeId: selectedNode.id,
        repoUrl: path.trim() || null, baseBranch: baseBranch.trim() || null, permissionMode,
        modelProfileId: modelProfileId || undefined,
        resumeSessionId: resumeSessionId || undefined,
      });
      // Seed the store from the HTTP response *before* handing the pane
      // over — the WS 'task' broadcast for this creation is still in flight,
      // and until it lands state.tasks doesn't know this id. shell.jsx's
      // stale-pane prune (which runs on every store bump) would see the
      // freshly-swapped pane as "task doesn't exist" and silently close it —
      // found live: the new conversation's pane vanished right after the
      // first message, while the sidebar (fed by the later WS event) showed
      // it fine.
      upsertTask(r.task);
      bump();
      onCreated(r.task.id);
    } catch (e2) { setErr(e2.message); setBusy(false); }
  };
  const send = (e) => { e?.preventDefault(); createNow(); };

  const closeOtherPickers = (keep) => {
    if (keep !== 'node') setNodePickerOpen(false);
    if (keep !== 'path') setPickerOpen(false);
    if (keep !== 'model') setModelPickerOpen(false);
  };

  return (
    <div className="task-pane draft-pane">
      <header className="pane-header">
        <div className="task-head"><h2>新对话</h2></div>
        {onClose && <button type="button" className="ghost pane-close-btn" onClick={onClose} aria-label="关闭">✕</button>}
      </header>

      <div className="draft-body">
        <div className="path-chip-row">
          {/* ---- node picker: inline chips when few, dropdown when many ---- */}
          {nodes.length <= INLINE_THRESHOLD ? (
            <div className="inline-chip-group">
              {nodes.map(n => (
                <button
                  type="button" key={n.id} className={`path-chip ${selectedNode?.id === n.id ? 'selected' : ''}`}
                  onClick={() => pickNode(n.id)}
                >
                  <i className={`dot ${n.status === 'online' ? 'online' : ''}`} /> {n.name || n.id}
                </button>
              ))}
              {!nodes.length && <span className="muted">还没有节点,请先在左侧「+ 添加节点」</span>}
            </div>
          ) : (
            <div className="chip-with-picker">
              <button type="button" className="path-chip" onClick={() => { setNodePickerOpen(!nodePickerOpen); closeOtherPickers('node'); }}>
                🖥 {selectedNode ? (selectedNode.name || selectedNode.id) : '无可用节点'}
              </button>
              {nodePickerOpen && (
                <div className="path-picker">
                  {nodes.map(n => (
                    <button type="button" key={n.id} className="path-picker-item" onClick={() => pickNode(n.id)}>
                      <i className={`dot ${n.status === 'online' ? 'online' : ''}`} /> {n.name || n.id}
                      {n.id === autoNode?.id && <span className="muted">默认</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ---- path picker: recent/default + autocomplete custom path ---- */}
          <div className="chip-with-picker">
            <button type="button" className="path-chip" onClick={() => { setPickerOpen(!pickerOpen); closeOtherPickers('path'); }}>
              📁 {path || '无仓库(临时目录)'}
            </button>
            {pickerOpen && (
              <div className="path-picker">
                {defaultRepoUrl && (
                  <button type="button" className="path-picker-item" onClick={() => pickPath(defaultRepoUrl)}>
                    {defaultRepoUrl} <span className="muted">默认</span>
                  </button>
                )}
                {recents.filter(r => r !== defaultRepoUrl).map(r => (
                  <button type="button" key={r} className="path-picker-item" onClick={() => pickPath(r)}>{r}</button>
                ))}
                <button type="button" className="path-picker-item" onClick={() => pickPath('')}>无仓库(临时目录)</button>
                <div className="path-picker-custom">
                  <input
                    value={customPath} onChange={e => setCustomPath(e.target.value)} placeholder="输入路径,自动补全…"
                    onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); pickPath(customPath.trim()); } }}
                  />
                  {pathSuggestions.length > 0 && (
                    <div className="path-suggestions">
                      {pathSuggestions.map(s => (
                        <button type="button" key={s} className="path-picker-item" onClick={() => pickPath(s)}>{s}</button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* ---- existing-session picker: resume a session created outside
               AgentHub — picking one creates the task immediately ---- */}
          {/* Adoption only discovers claude histories, and a session id belongs
              to exactly one agent CLI — so with a Codex profile picked there is
              nothing here to adopt. Say why instead of offering a button whose
              every outcome is a 409. */}
          {selectedNode && path.trim() && (selectedProfile?.backend === 'codex'
            ? <span className="muted">Codex 档案暂不支持接管已有会话(会话 ID 不通用)</span>
            : <button type="button" className="ghost link" onClick={() => setShowSessionPicker(true)}>查看已有会话…</button>
          )}

          {/* ---- model profile picker: inline chips when few, dropdown when many ---- */}
          {(1 + profiles.length) <= INLINE_THRESHOLD ? (
            <div className="inline-chip-group">
              <button type="button" className={`path-chip ${!modelProfileId ? 'selected' : ''}`} onClick={() => pickProfile(null)}>
                🧠 默认配置
              </button>
              {profiles.map(p => (
                <button
                  type="button" key={p.id} className={`path-chip ${modelProfileId === p.id ? 'selected' : ''}`}
                  onClick={() => pickProfile(p.id)}
                >
                  🧠 {p.name}{p.backend === 'codex' ? ' · Codex' : ''}
                </button>
              ))}
            </div>
          ) : (
            <div className="chip-with-picker">
              <button type="button" className="path-chip" onClick={() => { setModelPickerOpen(!modelPickerOpen); closeOtherPickers('model'); }}>
                🧠 {selectedProfile ? selectedProfile.name : '默认配置'}{selectedProfile?.backend === 'codex' ? ' · Codex' : ''}
              </button>
              {modelPickerOpen && (
                <div className="path-picker">
                  <button type="button" className="path-picker-item" onClick={() => pickProfile(null)}>默认配置</button>
                  {profiles.map(p => (
                    <button type="button" key={p.id} className="path-picker-item" onClick={() => pickProfile(p.id)}>{p.name}{p.backend === 'codex' ? ' · Codex' : ''}</button>
                  ))}
                </div>
              )}
            </div>
          )}

          {!showAdvanced
            ? <button type="button" className="ghost link" onClick={() => setShowAdvanced(true)}>高级选项…</button>
            : (
              <div className="row2 advanced-inline">
                <label>基准分支<input value={baseBranch} onChange={e => setBaseBranch(e.target.value)} placeholder="留空则自动识别仓库默认分支" /></label>
                <label>权限模式
                  <select value={permissionMode} onChange={e => setPermissionMode(e.target.value)}>
                    <option value="bypassPermissions">bypassPermissions(默认:全部放行)</option>
                    <option value="acceptEdits">acceptEdits(自动编辑,Bash 需审批)</option>
                    <option value="default">default(所有敏感操作需审批)</option>
                  </select>
                </label>
              </div>
            )}
        </div>
        {showAdvanced && permissionMode === 'bypassPermissions' && (
          <div className="err">⚠️ 该任务将不经审批执行任何命令</div>
        )}
        {!selectedNode && <div className="err">还没有可用节点,请先在左侧「+ 添加节点」</div>}
        {err && <div className="err">{err}</div>}
        <div className="draft-empty muted">开始输入,发送第一条消息即可创建对话;或点击「查看已有会话…」直接恢复历史记录</div>
      </div>

      <form
        className={`composer${dragOver ? ' drag-over' : ''}`} onSubmit={send}
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }}
      >
        <AttachmentStrip attachments={attachments} onRemove={removeAttachment} />
        <div className="composer-row">
          <AttachButton onFiles={addFiles} disabled={busy} />
          <textarea
            value={text} onChange={e => setText(e.target.value)} rows={2} autoFocus
            placeholder="给 agent 一个任务…(Enter 发送,Shift+Enter 换行,可直接粘贴/拖拽图片)"
            disabled={busy}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}
            onPaste={e => {
              const files = imageFilesFromPaste(e);
              if (files.length) { e.preventDefault(); addFiles(files); }
            }}
          />
          <button disabled={busy || (!text.trim() && !attachments.length) || attachmentError}>{busy ? '创建中…' : '发送'}</button>
        </div>
      </form>

      {showSessionPicker && selectedNode && (
        <SessionPicker
          nodeId={selectedNode.id} path={path.trim()}
          onPick={(sessionId, preview) => { setShowSessionPicker(false); createNow(sessionId, preview); }}
          onClose={() => setShowSessionPicker(false)}
        />
      )}
    </div>
  );
}
