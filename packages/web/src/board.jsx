import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from './api.js';
import {
  buildNodeInstallCommand, buildNodeInstallPrompt, nodeDisplayName, nodeLabels,
  nodeProjectLabels, nodeRepairCommands,
} from './node-enrollment.js';
import { state, bump, taskInScope } from './store.js';
import { ModalBackdrop } from './modal.jsx';
import { fmtAge } from './format.js';
import { isOutdated } from '../../shared/protocol.mjs';
import { BACKEND_LABELS, nativeAuthLabel } from './native-auth.js';

// The install command plus the AI-assist fallback. Shared by the "add node"
// modal and the first-run wizard so both stay in step — onboarding is exactly
// this panel with a heading around it, not a second copy of it.
export function NodeInstallPanel() {
  const [os, setOs] = useState('unix'); // 'unix' | 'windows'
  const [copied, setCopied] = useState('');
  const [showPrompt, setShowPrompt] = useState(false);
  const shared = { os, origin: location.origin };
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
      <textarea readOnly rows={os === 'windows' ? 3 : 1} value={cmd} onClick={e => e.target.select()} />
      <button type="button" onClick={() => copy('cmd', cmd)}>{copied === 'cmd' ? '已复制 ✓' : '复制命令'}</button>
      <p className="muted">
        运行后终端会打印一个链接,在浏览器里打开它、点「连接」,这台机器就接入了。
        命令里不含任何密钥,可以放心粘贴。
      </p>

      <div className="install-fallback">
        <button type="button" className="ghost link" onClick={() => setShowPrompt(v => !v)}>
          {showPrompt ? '收起' : '装不上?让 AI 帮你装 →'}
        </button>
        {showPrompt && (
          <>
            <p className="muted">
              把下面这段话发给那台机器上的 Claude Code(或任何能执行命令的 AI),它会自己装、自己排错、装完验证。
              中途它会把连接链接发给你,打开点「连接」即可。
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

// Which project the machine joins is picked on the /connect page now (see
// connect.jsx), not inherited from the active tab when the command is copied.
export function AddNodeModal({ onClose }) {
  return createPortal(
    <ModalBackdrop onClose={onClose}>
      <div className="modal add-node-modal" onClick={e => e.stopPropagation()}>
        <h2>添加执行节点</h2>
        <p className="muted">
          在要接入的机器上执行下面这条命令就行。缺 Node.js / Git / claude 会自动装好。
          节点名字会自动按「主机名-用户名」生成,加入个人还是某个项目在点「连接」时选。
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
  const cmd = buildNodeInstallCommand({ os: repair.os, origin: location.origin, nodeId: node.id });
  const copy = async () => {
    try { await navigator.clipboard.writeText(cmd); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { /* clipboard unavailable, user can select manually */ }
  };
  return (
    <div className="node-repair-guide">
      <ol>
        <li>先确认服务器本身开机且能访问本站:在服务器的{repair.shell}里执行 <code>{repair.connectivity}</code>,{repair.connectivityExpected}。</li>
        <li>
          <b>推荐的一步修复</b>:在服务器的{repair.shell}里重新运行安装命令,打开它打印的链接点「连接」(可重复执行:自动更新代码、重写配置并重启守护进程,节点身份不变):
          <textarea readOnly rows={3} value={cmd} onClick={e => e.target.select()} />
          <button type="button" className="ghost" onClick={copy}>{copied ? '已复制 ✓' : '复制命令'}</button>
        </li>
        <li>或只重启守护进程:<code>{repair.restart}</code></li>
        <li>执行后约 1 分钟内,这里的圆点应变绿;仍离线时查看日志:<code>{repair.logs}</code>,把最后几行发给管理员。</li>
      </ol>
    </div>
  );
}

// Whether this machine's claude / codex can already run on their own login
// or config — what a 「本机账号」 model profile would use here.
function NodeNativeAuthPanel({ node, isMine }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const auth = node.nativeAuth;
  const probe = async () => {
    setBusy(true); setErr('');
    try { await api.probeNodeNativeAuth(node.id); } catch (e) { setErr(e.message); }
    // The answer comes back as a 'node' broadcast; give the probe a moment.
    setTimeout(() => setBusy(false), 4000);
  };
  return (
    <div className="node-cli-panel">
      <span className="muted">账号直连:</span>
      {!auth ? <span className="muted">等待节点上报(节点自更新到新版后自动出现)</span>
        : Object.keys(BACKEND_LABELS).filter(b => auth[b] !== undefined).map(b => (
          <span key={b} className={`chip ${auth[b]?.loggedIn ? 'st-done' : ''}`}>
            {BACKEND_LABELS[b]}:{auth[b] ? nativeAuthLabel(b, auth[b]) : '未安装'}
          </span>
        ))}
      {isMine && node.status === 'online' && (
        <button type="button" className="ghost link" disabled={busy} onClick={probe}>{busy ? '检测中…' : '重新检测'}</button>
      )}
      {err && <span className="err">{err}</span>}
    </div>
  );
}

const CLI_LABELS = { claude: 'Claude Code', codex: 'Codex' };

// Is any CLI on this node behind the published release? Used both by the
// version panel below and by the sidebar's ⬆ marker, so the two can't disagree
// about which nodes need attention.
export function nodeCliOutdated(node) {
  const versions = node?.cliVersions || {};
  return Object.keys(versions).some(b => isOutdated(versions[b], state.cliLatest?.[b]));
}

// Per-node agent-CLI versions, and the controls to move them forward.
//
// This exists because a stale CLI is invisible until it isn't: the daemon is
// online, the node takes work, and then a task fails with a 400 from the model
// API about a request body AgentHub never built (see cli-upgrade.mjs). Showing
// 当前版本 → 最新版本 makes "this machine is two hundred releases behind" a
// thing you can see instead of something you deduce from a broken task.
function NodeCliPanel({ node, isMine }) {
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const latest = state.cliLatest || {};
  const versions = node.cliVersions || {};
  const upgrades = node.cliUpgrades || {};
  const autoOn = node.autoUpgradeCli !== false;

  // A node running an AgentHub old enough to predate this feature reports
  // nothing. It also has no handler for 'upgrade_cli', so there are no
  // controls to offer — just say why it's blank. Its own self-update fixes it.
  if (!Object.keys(versions).length) {
    return <div className="node-cli-panel"><span className="muted">CLI 版本:等待节点上报(节点自更新到新版后自动出现)</span></div>;
  }

  const upgrade = async (backend) => {
    setBusy(backend); setErr('');
    try {
      await api.upgradeNodeCli(node.id, backend);
      // The real state arrives as a 'node' broadcast the moment the daemon
      // starts (or queues) the installer — this is just so the click has an
      // immediate effect even if the node is mid-turn and takes a while.
      state.nodes.set(node.id, {
        ...node, cliUpgrades: { ...upgrades, [backend]: { state: 'pending' } },
      });
      bump();
    } catch (e) { setErr(e.message); }
    setBusy('');
  };

  const toggleAuto = async (enabled) => {
    setBusy('auto'); setErr('');
    try {
      await api.setNodeAutoUpgrade(node.id, enabled);
      state.nodes.set(node.id, { ...node, autoUpgradeCli: enabled });
      bump();
    } catch (e) { setErr(e.message); }
    setBusy('');
  };

  return (
    <div className="node-cli-panel">
      {Object.keys(versions).map((backend) => {
        const cur = versions[backend];
        const target = latest[backend];
        const up = upgrades[backend];
        const behind = isOutdated(cur, target);
        const inFlight = up?.state === 'running' || up?.state === 'pending';
        // A failure from before a successful upgrade is history, not a
        // problem — only surface it while this CLI is actually still behind.
        const failed = up?.state === 'failed' && (behind || !cur);
        let chip = { cls: 'st-done', text: '最新' };
        if (up?.state === 'running') chip = { cls: 'st-running', text: '升级中…' };
        else if (up?.state === 'pending') chip = { cls: 'st-queued', text: '排队中(等节点空闲)' };
        else if (failed) chip = { cls: 'st-failed', text: '升级失败' };
        else if (behind) chip = { cls: 'st-waiting', text: '可升级' };
        else if (!cur) chip = { cls: 'st-queued', text: '版本未知' };
        else if (!target) chip = { cls: 'st-queued', text: '已安装' };
        return (
          <div className="node-cli-row" key={backend}>
            <span className="node-cli-name">{CLI_LABELS[backend] || backend}</span>
            <span className="node-cli-ver">
              {cur || '版本未知'}
              {behind && <> <span className="node-cli-arrow">→</span> <b>{target}</b></>}
            </span>
            <span className={`chip ${chip.cls}`}>{chip.text}</span>
            {isMine && (behind || !cur) && !inFlight && (
              <button
                type="button" className="ghost repair-toggle" disabled={busy === backend}
                onClick={() => upgrade(backend)}
              >
                {busy === backend ? '发送中…' : '立即升级'}
              </button>
            )}
            {failed && up.error && <span className="node-cli-error" title={up.error}>{up.error}</span>}
          </div>
        );
      })}
      {isMine && (
        <label className="row-inline node-cli-auto">
          <input
            type="checkbox" checked={autoOn} disabled={busy === 'auto'}
            onChange={e => toggleAuto(e.target.checked)}
          />
          自动升级(节点空闲时自动升到最新版)
        </label>
      )}
      {err && <div className="err">{err}</div>}
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
                <NodeCliPanel node={n} isMine={isMine} />
                <NodeNativeAuthPanel node={n} isMine={isMine} />
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
  const [kind, setKind] = useState('single');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true); setErr('');
    try {
      const r = await api.createTeam(trimmed, kind);
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
        <div className="field-label">项目类型</div>
        <div className="row-inline">
          <label><input type="radio" name="project-kind" checked={kind === 'single'} onChange={() => setKind('single')} /> 单 agent</label>
          <label><input type="radio" name="project-kind" checked={kind === 'multi'} onChange={() => setKind('multi')} /> 多 agent 编排</label>
        </div>
        <p className="muted">
          {kind === 'multi'
            ? '和你对话的 agent 只负责拆分和派发:每个需求都交给 subagent 去做,互不相关的需求并行处理。会话里多一个「子代理」标签页,能看到 subagent 树和每个 subagent 的状态。只支持 Claude Code,创建后不能更改。'
            : '和你对话的 agent 自己完成工作,和以前一样。创建后不能更改。'}
        </p>
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
