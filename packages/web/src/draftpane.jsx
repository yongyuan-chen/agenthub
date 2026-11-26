import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from './api.js';
import { AddNodeModal, NodeManageModal } from './board.jsx';
import { state, upsertTask, bump } from './store.js';
import { InheritList } from './inherit.jsx';
import { useAttachments, AttachmentStrip, AttachButton, imageFilesFromPaste } from './composer.jsx';
import { BACKEND_LABELS, NATIVE_MODELS, nativeBackendsFor, authModeOf } from './native-auth.js';

// Below this many options, show them as inline selectable chips instead of
// making the user open a dropdown — most accounts have a handful of nodes
// and model profiles, so a dropdown is needless friction for the common case.
const INLINE_THRESHOLD = 4;

// Node management right where it's needed. A project starts with no machine
// in it, and the new-chat pane is the first thing it shows — so this is where
// "add one of my nodes to this project", "install a new machine" and the node
// manager live, instead of making people find them in the sidebar first.
function DraftNodeTools({ userId, startOpen, onJoined }) {
  const teamId = state.activeTeamId;
  const [open, setOpen] = useState(startOpen);
  const [mine, setMine] = useState(null);   // all of my nodes, for "add to project"
  const [modal, setModal] = useState(null); // 'add' | 'manage'
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!open || !teamId) return;
    api.myNodes().then(r => setMine(r.nodes || [])).catch(e => setErr(e.message));
  }, [open, teamId]);

  // Already in this project = already in the scoped node list.
  const candidates = (mine || []).filter(n => !state.nodes.has(n.id));
  const join = async (node) => {
    setBusy(node.id); setErr('');
    try {
      await api.addNodeTeam(node.id, teamId);
      state.nodes.set(node.id, { ...node, teamIds: [...(node.teamIds || []), teamId] });
      bump();
      onJoined(node.id);
      setOpen(false);
    } catch (e) { setErr(e.message); }
    setBusy('');
  };
  const openModal = (which) => { setOpen(false); setModal(which); };

  return (
    <div className="chip-with-picker">
      <button type="button" className="path-chip" onClick={() => setOpen(o => !o)}>＋ 节点</button>
      {open && (
        <div className="path-picker draft-node-tools">
          {teamId && (
            <>
              <div className="muted path-picker-heading">把我的节点加入这个项目</div>
              {mine === null && !err && <div className="muted path-picker-heading">加载中…</div>}
              {mine !== null && !candidates.length && <div className="muted path-picker-heading">你的节点都已经在这个项目里了</div>}
              {candidates.map(n => (
                <button type="button" key={n.id} className="path-picker-item" disabled={busy === n.id} onClick={() => join(n)}>
                  <i className={`dot ${n.status === 'online' ? 'online' : ''}`} /> {n.name || n.id}
                  <span className="muted">{busy === n.id ? '加入中…' : '加入'}</span>
                </button>
              ))}
            </>
          )}
          <button type="button" className="path-picker-item" onClick={() => openModal('add')}>＋ 安装一台新机器…</button>
          <button type="button" className="path-picker-item" onClick={() => openModal('manage')}>⚙ 节点管理…</button>
          {err && <div className="err path-picker-heading">{err}</div>}
        </div>
      )}
      {modal === 'add' && <AddNodeModal onClose={() => setModal(null)} />}
      {modal === 'manage' && createPortal(<NodeManageModal user={{ id: userId }} onClose={() => setModal(null)} />, document.body)}
    </div>
  );
}

function deriveTitle(text) {
  const line = text.split('\n')[0].trim();
  return line.length > 40 ? line.slice(0, 40) + '…' : (line || '新对话');
}

// A pane slot with no task yet: pick a project path (or take the account
// default), type the first message, and sending it is what actually creates
// the task — no upfront title/spec form to get through first.
export function DraftPane({ onCreated, onClose, maximized, onToggleMaximize, onOpenSettings, userId }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [path, setPath] = useState('');
  // A ref, not state: the prefill below resolves asynchronously and must not
  // clobber a path the user picked while those requests were still in flight.
  const pathTouched = useRef(false);
  const [defaultRepoUrl, setDefaultRepoUrl] = useState('');
  const [recents, setRecents] = useState([]);
  const [topRepo, setTopRepo] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [customPath, setCustomPath] = useState('');
  const [pathSuggestions, setPathSuggestions] = useState([]);
  const [nodeId, setNodeId] = useState(null); // null = follow auto-pick until user explicitly chooses
  const [nodePickerOpen, setNodePickerOpen] = useState(false);
  const [profiles, setProfiles] = useState([]);
  const [modelProfileId, setModelProfileId] = useState(null); // null = 默认配置
  // Conversations take their agent mode from the project they're created in.
  const multiAgent = state.teams.find(t => t.id === state.activeTeamId)?.kind === 'multi';
  // Relay profiles only: 账号直连 has its own picker (the official models,
  // shown when the selected node is logged in), and listing the native
  // profile among the API ones read as one more relay.
  const usableIn = (list) => list.filter(p => p.kind !== 'native' && (!multiAgent || p.backend !== 'codex'));
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [baseBranch, setBaseBranch] = useState(''); // empty = auto-detect the repo's actual default branch
  const [permissionMode, setPermissionMode] = useState('bypassPermissions');
  const [dragOver, setDragOver] = useState(false);
  // Same composer affordances as an ongoing conversation (task.jsx) — the
  // first message is a message. A draft pane is created fresh per slot, so
  // there's no id to reset on.
  const { attachments, addFiles, removeAttachment, wireImages, hasError: attachmentError }
    = useAttachments('draft', setErr);

  useEffect(() => {
    // Offered in the path picker, never pre-filled: it's one path for every
    // machine, and the pre-fill has to be a path that exists on the node
    // actually picked (see the per-node effect below).
    api.getSettings().then(s => setDefaultRepoUrl(s.defaultRepoUrl || '')).catch(() => {});
    api.modelProfiles().then(r => {
      const profiles = r.profiles || [];
      setProfiles(profiles);
      // Default to whichever model was used last time (creating a task with
      // a different one makes THAT the new sticky default, see hub-core.mjs's
      // POST /api/tasks) — but only if it's still a real profile; one that's
      // since been deleted falls back to null (the flagged-default profile).
      // A multiagent project can only run Claude (see hub-core.mjs's
      // multiAgentRefusal), so a sticky Codex default doesn't carry into one.
      if (r.lastModelProfileId && usableIn(profiles).some(p => p.id === r.lastModelProfileId)) {
        setModelProfileId(r.lastModelProfileId);
      } else if (!profiles.some(p => p.isDefault) && usableIn(profiles).length) {
        // No account default (e.g. only 「本机账号」 profiles): 默认配置 would
        // start a task with no relay at all, so pick a real profile instead.
        setModelProfileId(usableIn(profiles)[0].id);
      }
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const usable = usableIn(profiles);
  const nodes = [...state.nodes.values()];
  const autoNode = nodes.find(n => n.status === 'online') || nodes[0];
  const selectedNode = (nodeId && nodes.find(n => n.id === nodeId)) || autoNode;
  const selectedProfile = modelProfileId ? profiles.find(p => p.id === modelProfileId) : null;

  // The pre-filled path follows the node: this project's most used path ON
  // THAT MACHINE, else the scratch dir. A local path only exists where it was
  // typed, so carrying one across a node switch (as this used to) defaults
  // the new node to a directory it doesn't have. Switching node also drops a
  // hand-picked path for the same reason.
  const nodeKey = selectedNode?.id || null;

  // A node whose own claude/codex is logged in (an official subscription, a
  // ChatGPT login, keys set up on the box) runs on that, with the official
  // models to pick from — the relay profiles mean nothing there. Only for the
  // node's owner: it's their account. 「改用中转站档案」 is the way back.
  const nativeBackends = nativeBackendsFor(selectedNode, userId).filter(b => !multiAgent || b === 'claude');
  const [useRelay, setUseRelay] = useState(false);
  const [nativeChoice, setNativeChoice] = useState({ backend: 'claude', model: '' });
  const nativeMode = nativeBackends.length > 0 && !useRelay;
  const nativeKey = nativeBackends.join(',');
  useEffect(() => {
    setUseRelay(false);
    setNativeChoice(c => (nativeBackends.includes(c.backend) ? c : { backend: nativeBackends[0] || 'claude', model: '' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeKey, nativeKey]);
  // The CLI the new conversation will drive, whichever way it's picked.
  const draftBackend = nativeMode ? nativeChoice.backend : (selectedProfile?.backend || 'claude');

  useEffect(() => {
    if (!nodeKey) return undefined;
    let stale = false;
    pathTouched.current = false;
    api.recentRepos(nodeKey).catch(() => ({})).then(r => {
      if (stale) return;   // the user already moved on to another node
      setRecents(r.repos || []);
      setTopRepo(r.top || '');
      setPath(prev => (pathTouched.current ? prev : (r.top || '')));
    });
    return () => { stale = true; };
  }, [nodeKey]);
  // 默认配置 = the relay mirrored to every node; without a default profile
  // there's nothing behind it, so don't offer it.
  const hasDefault = profiles.some(p => p.isDefault);
  const profileSuffix = (p) => (p.backend === 'codex' ? ' · Codex' : '');

  // Autocomplete subdirectories on the selected node as the custom path is typed.
  useEffect(() => {
    if (!customPath.trim() || !selectedNode) { setPathSuggestions([]); return; }
    const timer = setTimeout(() => {
      api.browseNode(selectedNode.id, customPath.trim()).then(r => setPathSuggestions(r.entries || [])).catch(() => setPathSuggestions([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [customPath, selectedNode?.id]);

  const pickPath = (p) => {
    setPath(p); pathTouched.current = true; setPickerOpen(false); setCustomPath(''); setPathSuggestions([]);
  };
  const pickNode = (id) => { setNodeId(id); setNodePickerOpen(false); };
  const pickProfile = (id) => { setModelProfileId(id); setModelPickerOpen(false); };

  // Shared by the composer's send and by picking an existing session:
  // resuming a session already has content to pick up from, so picking one
  // creates the task right away (history import happens immediately, and the
  // pane becomes a real persisted task instead of vanishing on refresh) —
  // any text already typed still goes along as the first message, but it's
  // no longer required when resuming.
  // `resume` comes from the node-wide list (inherit.jsx): a session found
  // anywhere on the machine carries its own directory and CLI, which win over
  // whatever path the pane currently shows.
  const createNow = async (resumeSessionId, resumePreview, resume = {}) => {
    const t = text.trim();
    const images = wireImages();
    // Images with no text is a complete first message ("这个报错怎么回事?" is
    // often the screenshot alone), so it's enough on its own to create.
    if (!t && !images.length && !resumeSessionId) return;
    if (attachmentError) return;
    if (!selectedNode) { setErr('还没有可用节点:点上面的「＋ 节点」加入或安装一台'); return; }
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
        repoUrl: (resume.cwd ?? path.trim()) || null, baseBranch: baseBranch.trim() || null, permissionMode,
        ...(nativeMode ? { native: nativeChoice } : { modelProfileId: modelProfileId || undefined }),
        resumeSessionId: resumeSessionId || undefined,
        resumeBackend: resumeSessionId ? (resume.backend || draftBackend) : undefined,
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
        {onToggleMaximize && (
          <button type="button" className="ghost pane-max-btn" onClick={onToggleMaximize}
            title={maximized ? '还原' : '最大化(占满工作区)'} aria-label={maximized ? '还原' : '最大化'}>
            {maximized ? '⤡' : '⤢'}
          </button>
        )}
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
              {!nodes.length && (
                <span className="muted">
                  {state.activeTeamId ? '这个项目还没有节点:把你已有的节点加进来,或者安装一台新机器 →' : '还没有节点,先安装一台机器 →'}
                </span>
              )}
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
          <DraftNodeTools userId={userId} startOpen={!nodes.length} onJoined={pickNode} />

          {/* ---- path picker: recent/default + autocomplete custom path ---- */}
          <div className="chip-with-picker">
            <button type="button" className="path-chip" onClick={() => { setPickerOpen(!pickerOpen); closeOtherPickers('path'); }}>
              📁 {path || '无仓库(临时目录)'}
            </button>
            {pickerOpen && (
              <div className="path-picker">
                {topRepo && (
                  <button type="button" className="path-picker-item" onClick={() => pickPath(topRepo)}>
                    {topRepo} <span className="muted">常用</span>
                  </button>
                )}
                {defaultRepoUrl && defaultRepoUrl !== topRepo && (
                  <button type="button" className="path-picker-item" onClick={() => pickPath(defaultRepoUrl)}>
                    {defaultRepoUrl} <span className="muted">默认</span>
                  </button>
                )}
                {recents.filter(r => r !== defaultRepoUrl && r !== topRepo).map(r => (
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

          {/* ---- model picker: the node's official login, or relay profiles ---- */}
          {(() => {
            const native = nativeMode || selectedProfile?.kind === 'native';
            const mode = authModeOf(native, selectedProfile ? selectedProfile.baseUrl : profiles.find(p => p.isDefault)?.baseUrl);
            return <span className={`chip auth-badge ${mode.cls}`} title={mode.title}>{mode.text}</span>;
          })()}
          {nativeMode ? (
            <div className="inline-chip-group">
              {nativeBackends.flatMap(b => NATIVE_MODELS[b].map(m => (
                <button
                  type="button" key={`${b}:${m.id}`}
                  className={`path-chip ${nativeChoice.backend === b && nativeChoice.model === m.id ? 'selected' : ''}`}
                  title={`用这台机器上已登录的 ${BACKEND_LABELS[b]} 账号`}
                  onClick={() => setNativeChoice({ backend: b, model: m.id })}
                >
                  🧠 {nativeBackends.length > 1 || b !== 'claude' ? `${BACKEND_LABELS[b]} · ` : ''}{m.label}
                </button>
              )))}
              <button type="button" className="ghost link" onClick={() => setUseRelay(true)}>改用中转站档案…</button>
            </div>
          ) : ((hasDefault ? 1 : 0) + usable.length) <= INLINE_THRESHOLD ? (
            <div className="inline-chip-group">
              {hasDefault && (
                <button type="button" className={`path-chip ${!modelProfileId ? 'selected' : ''}`} onClick={() => pickProfile(null)}>
                  🧠 默认配置
                </button>
              )}
              {usable.map(p => (
                <button
                  type="button" key={p.id} className={`path-chip ${modelProfileId === p.id ? 'selected' : ''}`}
                  onClick={() => pickProfile(p.id)}
                >
                  🧠 {p.name}{profileSuffix(p)}
                </button>
              ))}
            </div>
          ) : (
            <div className="chip-with-picker">
              <button type="button" className="path-chip" onClick={() => { setModelPickerOpen(!modelPickerOpen); closeOtherPickers('model'); }}>
                🧠 {selectedProfile ? selectedProfile.name : '默认配置'}{selectedProfile ? profileSuffix(selectedProfile) : ''}
              </button>
              {modelPickerOpen && (
                <div className="path-picker">
                  {hasDefault && <button type="button" className="path-picker-item" onClick={() => pickProfile(null)}>默认配置</button>}
                  {usable.map(p => (
                    <button type="button" key={p.id} className="path-picker-item" onClick={() => pickProfile(p.id)}>{p.name}{profileSuffix(p)}</button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Which agent CLI a card drives is a property of its model profile,
              not a per-card switch — so with only Claude profiles around, the
              picker above gives no clue that Codex exists at all. Reported as
              "新建对话和历史对话都没看到 codex 标识" by someone who had the
              feature deployed and two nodes with the CLI installed, but no
              Codex profile. Disappears the moment one exists, at which point
              the picker labels it "· Codex" and says so itself. */}
          {multiAgent && (
            <div className="muted">多 agent 编排项目:和你对话的 agent 会把需求拆开派给 subagent,只能使用 Claude Code 档案。</div>
          )}
          {nativeMode && (
            <div className="muted">这台机器上的 {nativeBackends.map(b => BACKEND_LABELS[b]).join(' / ')} 已登录官方账号,直接用它的账号和额度。</div>
          )}
          {!nativeMode && nativeBackends.length > 0 && (
            <div className="muted"><button type="button" className="ghost link" onClick={() => setUseRelay(false)}>← 改用这台机器的官方账号</button></div>
          )}
          {!nativeMode && !multiAgent && !profiles.some(p => p.backend === 'codex') && (
            <div className="muted">
              想用 Codex 对话?先到「<button type="button" className="ghost link" onClick={() => onOpenSettings?.()}>设置 → 模型档案</button>」
              新建一个后端选 Codex 的档案(中转站需支持 <code>/v1/responses</code>),再回这里选它。跑它的节点上也要装好 <code>codex</code> CLI。
            </div>
          )}

          {!showAdvanced
            ? <button type="button" className="ghost link" onClick={() => setShowAdvanced(true)}>高级选项…</button>
            : (
              <div className="row2 advanced-inline">
                {/* Only remote URLs still get a clone+worktree, so this is
                    the only case a base branch can apply to — a local path is
                    worked in directly, on whatever it is already checked out to. */}
                <label>基准分支<input value={baseBranch} onChange={e => setBaseBranch(e.target.value)} placeholder="仅对远程仓库 URL 有效,本地路径直接原地工作" /></label>
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
        {/* Below the pickers rather than inside the chip row: it's a list,
            and it needs the model choice above to say which sessions can be
            adopted as-is. */}
        <InheritList
          node={selectedNode} draftBackend={draftBackend} busy={busy}
          onAdoptSession={(s) => createNow(s.sessionId, s.preview, { cwd: s.cwd, backend: s.backend })}
          onOpened={onCreated}
          autoOpen={!recents.length && !topRepo}
        />
        {err && <div className="err">{err}</div>}
        <div className="draft-empty muted">开始输入,发送第一条消息即可创建对话;或在上面「继续…已有的对话」里接着之前的聊</div>
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

    </div>
  );
}
