import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, getToken } from './api.js';
import {
  buildNodeInstallCommand, buildNodeInstallPrompt, nodeDisplayName, nodeLabels,
  nodeProjectLabels, nodeRepairCommands,
} from './node-enrollment.js';
import { state, bump, taskInScope } from './store.js';
import { ModalBackdrop } from './modal.jsx';
import { fmtAge } from './format.js';

// The install command plus the AI-assist fallback. Shared by the "add node"
// modal and the first-run wizard so both stay in step — onboarding is exactly
// this panel with a heading around it, not a second copy of it.
export function NodeInstallPanel() {
  const [os, setOs] = useState('unix'); // 'unix' | 'windows'
  const [copied, setCopied] = useState('');
  const [showPrompt, setShowPrompt] = useState(false);
  const token = useRef(getToken()).current;
  const shared = { os, origin: location.origin, token, teamId: state.activeTeamId };
  // No node id is passed: the installer derives one from the target machine's
  // hostname + OS username, and the server steps past any collision (see the
  // autoName branch in hub-core.mjs).
  const cmd = buildNodeInstallCommand(shared);
  const prompt = buildNodeInstallPrompt(shared);

  const copy = async (what, text) => {
    try { await navigator.clipboard.writeText(text); setCopied(what); setTimeout(() => setCopied(''), 2000); }
    catch { /* clipboard unavailable, user can select manually */ }
  };

  return (
    <>
      <nav className="tabs">
        <button type="button" className={os === 'unix' ? 'active' : ''} onClick={() => setOs('unix')}>macOS / Linux</button>
        <button type="button" className={os === 'windows' ? 'active' : ''} onClick={() => setOs('windows')}>Windows</button>
      </nav>
      <textarea readOnly rows={4} value={cmd} onClick={e => e.target.select()} />
      <button type="button" onClick={() => copy('cmd', cmd)}>{copied === 'cmd' ? '已复制 ✓' : '复制命令'}</button>

      <div className="install-fallback">
        <button type="button" className="ghost link" onClick={() => setShowPrompt(v => !v)}>
          {showPrompt ? '收起' : '装不上?让 AI 帮你装 →'}
        </button>
        {showPrompt && (
          <>
            <p className="muted">
              把下面这段话发给那台机器上的 Claude Code(或任何能执行命令的 AI),它会自己装、自己排错、装完验证。
            </p>
            <p className="err">
              ⚠️ 这段话里带着你的登录令牌,拿到的人可以操作你的账号。只发给你自己机器上的 AI,别贴到公开的地方。
            </p>
            <textarea readOnly rows={7} value={prompt} onClick={e => e.target.select()} />
            <button type="button" className="ghost" onClick={() => copy('prompt', prompt)}>
              {copied === 'prompt' ? '已复制 ✓' : '复制这段 prompt'}
            </button>
          </>
        )}
      </div>
    </>
  );
}

export function AddNodeModal({ onClose }) {
  // Whichever scope is active right now (个人 / a specific team) becomes the
  // node's permanent binding at enrollment — nodes aren't auto-shared with
  // every team the registering user happens to belong to (see hub-core.mjs's
  // team-sharing redesign notes), so this is the only place that decision
  // gets made.
  const activeTeam = state.teams.find(t => t.id === state.activeTeamId);

  return createPortal(
    <ModalBackdrop onClose={onClose}>
      <div className="modal add-node-modal" onClick={e => e.stopPropagation()}>
        <h2>添加执行节点</h2>
        <p className="muted">
          在要接入的机器上执行下面这条命令就行。节点名字会自动按「主机名-用户名」生成,重名会自动加后缀,
          之后可以在「节点管理」里改显示名。缺 Node.js / Git / claude / codex 会自动装好。
        </p>
        <p className="muted">
          这台机器会加入:<b>{activeTeam ? activeTeam.name : '个人'}</b>
          {activeTeam ? '(项目成员都能用它建任务)' : '(只有你自己能用)'} — 切换左侧项目 tab 可改变这里。
        </p>
        <NodeInstallPanel />
        <div className="modal-actions">
          <button type="button" className="ghost" onClick={onClose}>关闭</button>
        </div>
      </div>
    </ModalBackdrop>,
    document.body,
  );
}

// Self-service repair steps for an offline node, tailored to its OS. Exists
// because "节点离线" alone left the owner with nothing to act on (found live:
// gpu31's daemon process was healthy but its cloud link had stalled — the fix
// was a one-line restart on the box, but nothing on the site said so). The
// re-install one-liner is the recommended path: it's idempotent (re-enrolls
// the same NODE_ID under the same account, refreshes code, rewrites config,
// restarts the daemon) and works no matter what state the box is in.
function NodeRepairGuide({ node }) {
  const [copied, setCopied] = useState(false);
  const repair = nodeRepairCommands(node, location.origin);
  const cmd = buildNodeInstallCommand({
    os: repair.os, origin: location.origin, token: getToken(), nodeId: node.id,
  });
  const copy = async () => {
    try { await navigator.clipboard.writeText(cmd); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { /* clipboard unavailable, user can select manually */ }
  };
  return (
    <div className="node-repair-guide">
      <ol>
        <li>先确认服务器本身开机且能访问本站:在服务器的{repair.shell}里执行 <code>{repair.connectivity}</code>,{repair.connectivityExpected}。</li>
        <li>
          <b>推荐的一步修复</b>:在服务器的{repair.shell}里重新运行安装命令(可重复执行:自动更新代码、重写配置并重启守护进程,节点身份不变):
          <textarea readOnly rows={3} value={cmd} onClick={e => e.target.select()} />
          <button type="button" className="ghost" onClick={copy}>{copied ? '已复制 ✓' : '复制命令'}</button>
        </li>
        <li>或只重启守护进程:<code>{repair.restart}</code></li>
        <li>执行后约 1 分钟内,这里的圆点应变绿;仍离线时查看日志:<code>{repair.logs}</code>,把最后几行发给管理员。</li>
      </ol>
    </div>
  );
}

export const STATUS_META = {
  queued: { label: '排队', cls: 'st-queued' },
  starting: { label: '启动中', cls: 'st-queued' },
  idle: { label: '待续 · 已恢复', cls: 'st-queued' },
  running: { label: '运行中', cls: 'st-running' },
  waiting_human: { label: '等待决策', cls: 'st-waiting' },
  review: { label: '待 Review', cls: 'st-review' },
  done: { label: '完成', cls: 'st-done' },
  failed: { label: '失败', cls: 'st-failed' },
  cancelled: { label: '已取消', cls: 'st-done' },
  unknown: { label: '状态未知', cls: 'st-failed' },
};

// Archiving only hides a task from the sidebar (packages/worker/src/hub-core.mjs
// archive/unarchive routes just set/clear tasks.archived_at, nothing executor-side)
// — this modal is the only place to find and restore ("恢复") one again.
export function ArchivedModal({ onClose }) {
  const archived = [...state.tasks.values()]
    .filter(t => t.archived_at && taskInScope(t))
    .sort((a, b) => b.archived_at - a.archived_at);

  return (
    <ModalBackdrop onClose={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h2>已归档的对话</h2>
        {!archived.length && <p className="muted">还没有归档的对话</p>}
        {archived.length > 0 && (
          <div className="archived-list">
            {archived.map(t => {
              const meta = STATUS_META[t.status] || { label: t.status, cls: '' };
              return (
                <div key={t.id} className="archived-row">
                  <span className="archived-row-title">{t.title}</span>
                  <span className={`chip ${meta.cls}`}>{meta.label}</span>
                  <span className="muted">已归档 {fmtAge(t.archived_at)} 前</span>
                  <button type="button" className="ghost" onClick={() => api.unarchiveTask(t.id).catch(e => alert(e.message))}>
                    ↩ 恢复
                  </button>
                </div>
              );
            })}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="ghost" onClick={onClose}>关闭</button>
        </div>
      </div>
    </ModalBackdrop>
  );
}

// A node can belong to several projects at once, same as tasks — this is
// the only place to add/remove an EXISTING node's project associations
// after enrollment. Shows whatever the active scope already shows, PLUS
// (when viewing a project) every node you personally own even if it isn't
// bound to that project yet — otherwise assigning one of your other nodes
// to the project you're currently looking at meant switching to 个人 first,
// finding it there, toggling it, then switching back. Found live: reported
// as wanting to "在项目中点击节点管理...还能看我个人视角的所有节点信息,方便
// 我操作节点的归属" (see the checkboxes below — every one of your nodes
// already lists every project you're in, not just the active one; the gap
// was purely which nodes showed up in the list at all).
export function NodeManageModal({ user, onClose }) {
  const [busy, setBusy] = useState(null); // node id currently being toggled
  const [err, setErr] = useState('');
  const [renamingId, setRenamingId] = useState(null);
  const [nameDraft, setNameDraft] = useState('');
  const [repairId, setRepairId] = useState(null); // node id whose offline-repair guide is expanded
  const [myExtraNodes, setMyExtraNodes] = useState(null);

  useEffect(() => {
    if (!state.activeTeamId) return; // already inclusive of everything you own
    api.myNodes().then(r => setMyExtraNodes(r.nodes)).catch(() => {});
  }, []);

  const nodeMap = new Map(state.nodes);
  if (myExtraNodes) for (const n of myExtraNodes) if (!nodeMap.has(n.id)) nodeMap.set(n.id, n);
  const nodes = [...nodeMap.values()];

  const startRename = (node) => { setNameDraft(node.name || node.id); setRenamingId(node.id); };
  const saveRename = async (node) => {
    setRenamingId(null);
    const name = nameDraft.trim();
    if (!name || name === (node.name || node.id)) return;
    try {
      await api.renameNode(node.id, name);
      state.nodes.set(node.id, { ...node, name });
      bump();
    } catch (e) { setErr(e.message); }
  };

  const toggle = async (node, teamId) => {
    setBusy(node.id); setErr('');
    const currentlyIn = (node.teamIds || []).includes(teamId);
    try {
      await (currentlyIn ? api.removeNodeTeam(node.id, teamId) : api.addNodeTeam(node.id, teamId));
      // No live "removed from old scope" push reaches viewers who aren't in
      // the new scope (same as team-membership removal already behaves) —
      // reflect it locally right away so the row doesn't look stuck.
      const newTeamIds = currentlyIn ? (node.teamIds || []).filter(id => id !== teamId) : [...(node.teamIds || []), teamId];
      // Personal view is inclusive of everything you own regardless of team
      // bindings (see hub-core.mjs's GET /api/nodes) — only team scope is
      // exclusive to its own binding. Toggling a project checkbox from
      // personal view must never make the row vanish out from under you.
      const stillVisible = state.activeTeamId ? newTeamIds.includes(state.activeTeamId) : true;
      if (!stillVisible) state.nodes.delete(node.id);
      else state.nodes.set(node.id, { ...node, teamIds: newTeamIds });
      bump();
    } catch (e) { setErr(e.message); }
    setBusy(null);
  };

  return (
    <ModalBackdrop onClose={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h2>节点管理</h2>
        <p className="muted">个人视角始终显示你拥有的全部节点,不受项目绑定影响。在项目视角下,这里除了显示绑定到该项目的节点,也会显示你个人的其他节点,方便直接勾选归属;勾选项目会把节点加入该项目(不会影响它在你个人视角下的可见性),一个节点可以同时属于多个项目。</p>
        {!nodes.length && <p className="muted">当前视角下还没有节点</p>}
        {nodes.length > 0 && (
          <div className="archived-list">
            {nodes.map(n => {
              const isMine = n.owner_user_id === user?.id;
              return (
                <React.Fragment key={n.id}>
                <div className="archived-row node-manage-row">
                  <span className="archived-row-title">
                    <i className={`dot ${n.status === 'online' ? 'online' : ''}`} />{' '}
                    {isMine && renamingId === n.id ? (
                      <input
                        autoFocus className="node-name-input" value={nameDraft}
                        onChange={e => setNameDraft(e.target.value)}
                        onBlur={() => saveRename(n)}
                        onKeyDown={e => { if (e.key === 'Enter') saveRename(n); if (e.key === 'Escape') setRenamingId(null); }}
                      />
                    ) : (
                      <span
                        className={isMine ? 'editable-title' : ''} title={isMine ? '点击重命名' : n.id}
                        onClick={isMine ? () => startRename(n) : undefined}
                      >
                        {n.name || n.id}
                      </span>
                    )}
                  </span>
                  {state.activeTeamId && n.owner_username && (
                    <span className="chip owner-chip" title="所有者">{n.owner_username}</span>
                  )}
                  {isMine && n.status !== 'online' && (
                    <button
                      type="button" className="ghost repair-toggle"
                      onClick={() => setRepairId(repairId === n.id ? null : n.id)}
                    >
                      {repairId === n.id ? '收起修复指引' : '离线?修复指引'}
                    </button>
                  )}
                  {isMine ? (
                    state.teams.map(t => (
                      <label key={t.id} className="row-inline">
                        <input
                          type="checkbox" checked={(n.teamIds || []).includes(t.id)} disabled={busy === n.id}
                          onChange={() => toggle(n, t.id)}
                        />
                        {t.name}
                      </label>
                    ))
                  ) : <span className="muted">非你所有,无法管理</span>}
                </div>
                {isMine && n.status !== 'online' && repairId === n.id && <NodeRepairGuide node={n} />}
                </React.Fragment>
              );
            })}
          </div>
        )}
        {err && <div className="err">{err}</div>}
        <div className="modal-actions">
          <button type="button" className="ghost" onClick={onClose}>关闭</button>
        </div>
      </div>
    </ModalBackdrop>
  );
}

// Any user can spin up their own project (self-service — see hub-core.mjs's
// POST /api/teams, mirrors the admin-panel's team creation but without the
// is_admin gate). Creator becomes 'owner' server-side; onCreated switches the
// sidebar straight to it so it doesn't just silently appear in the tab strip.
export function CreateProjectModal({ onClose, onCreated }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true); setErr('');
    try {
      const r = await api.createTeam(trimmed);
      state.teams = [...state.teams, r.team];
      bump();
      onCreated(r.team.id);
      onClose();
    } catch (e) { setErr(e.message); setBusy(false); }
  };

  return (
    <ModalBackdrop onClose={onClose}>
      <form className="modal" onClick={e => e.stopPropagation()} onSubmit={submit}>
        <h2>新建项目</h2>
        <p className="muted">创建后你会自动成为该项目的所有者(owner),可以邀请成员、把节点和对话共享进来。</p>
        <label>
          项目名称
          <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="例如:量化训练" />
        </label>
        {err && <div className="err">{err}</div>}
        <div className="modal-actions">
          <button type="button" className="ghost" onClick={onClose}>取消</button>
          <button type="submit" disabled={busy || !name.trim()}>创建</button>
        </div>
      </form>
    </ModalBackdrop>
  );
}

// Self-service membership for the *currently active* project — only ever
// opened when the caller's own role in it is 'owner' (see the "⚙" trigger
// next to the project tab in sidebar.jsx's TeamSwitcher); the backend
// enforces the same owner-only rule independently, this is just the UI gate.
export function ProjectMembersModal({ teamId, teamName, currentUserId, onClose }) {
  const [members, setMembers] = useState(null);
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = () => api.projectMembers(teamId).then(r => setMembers(r.members)).catch(e => setErr(e.message));
  useEffect(() => { load(); }, [teamId]);

  const add = async (e) => {
    e.preventDefault();
    if (!username.trim()) return;
    setBusy(true); setErr('');
    try { await api.addProjectMember(teamId, username.trim()); setUsername(''); await load(); }
    catch (e2) { setErr(e2.message); }
    setBusy(false);
  };

  const remove = async (userId) => {
    setBusy(true); setErr('');
    try { await api.removeProjectMember(teamId, userId); await load(); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  };

  return (
    <ModalBackdrop onClose={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h2>{teamName} · 项目成员</h2>
        {members === null ? <div className="muted">加载中…</div> : (
          <div className="archived-list">
            {members.map(m => (
              <div key={m.user_id} className="archived-row">
                <span className="archived-row-title">{m.username}</span>
                {m.role === 'owner' && <span className="chip">owner</span>}
                <button type="button" className="ghost" disabled={busy} onClick={() => remove(m.user_id)}>
                  {m.user_id === currentUserId ? '退出' : '移除'}
                </button>
              </div>
            ))}
            {!members.length && <div className="muted">还没有成员</div>}
          </div>
        )}
        <form className="row2" onSubmit={add}>
          <input value={username} onChange={e => setUsername(e.target.value)} placeholder="用户名" />
          <button type="submit" className="ghost" disabled={busy || !username.trim()}>拉人进来</button>
        </form>
        {err && <div className="err">{err}</div>}
        <div className="modal-actions">
          <button type="button" className="ghost" onClick={onClose}>关闭</button>
        </div>
      </div>
    </ModalBackdrop>
  );
}
