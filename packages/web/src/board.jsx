import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, getToken } from './api.js';
import {
  buildNodeInstallCommand, enrollmentNeedsAcknowledgement, nodeDisplayName,
  nodeEnrollmentMode, nodeIdValidationError, nodeLabels, nodeProjectLabels,
  nodeRepairCommands,
} from './node-enrollment.js';
import { state, bump, taskInScope } from './store.js';
import { ModalBackdrop } from './modal.jsx';

export function AddNodeModal({ onClose }) {
  const [copied, setCopied] = useState(false);
  const [os, setOs] = useState('unix'); // 'unix' | 'windows'
  const [nodeId, setNodeId] = useState('');
  const [ownedNodes, setOwnedNodes] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [acknowledgedKey, setAcknowledgedKey] = useState('');
  const loadSeq = useRef(0);
  const token = useRef(getToken()).current;

  const loadOwnedNodes = async () => {
    const seq = ++loadSeq.current;
    setOwnedNodes(null); setLoadError(''); setAcknowledgedKey('');
    try {
      const result = await api.myNodes();
      if (seq === loadSeq.current) setOwnedNodes(result.nodes || []);
    } catch (e) {
      if (seq === loadSeq.current) setLoadError(e.message || '节点清单加载失败');
    }
  };
  useEffect(() => {
    loadOwnedNodes();
    return () => { loadSeq.current++; };
  }, []);

  // Whichever scope is active right now (个人 / a specific team) becomes the
  // node's permanent binding at enrollment — nodes aren't auto-shared with
  // every team the registering user happens to belong to (see hub-core.mjs's
  // team-sharing redesign notes), so this is the only place that decision
  // gets made.
  const activeTeam = state.teams.find(t => t.id === state.activeTeamId);
  const enrollment = nodeEnrollmentMode(nodeId, ownedNodes || []);
  const nodeIdError = nodeIdValidationError(enrollment.nodeId);
  const needsAcknowledgement = enrollmentNeedsAcknowledgement(enrollment);
  const enrollmentKey = `${loadSeq.current}:${enrollment.kind}:${nodeId}:${enrollment.matchingNode?.id || ''}`;
  const acknowledged = acknowledgedKey === enrollmentKey;
  const canCopy = ownedNodes !== null && !nodeIdError && (!needsAcknowledgement || acknowledged);
  const cmd = canCopy ? buildNodeInstallCommand({
    os, origin: location.origin, token, nodeId: enrollment.nodeId, teamId: state.activeTeamId,
  }) : '';
  const inventoryRows = useMemo(() => {
    const teamNames = new Map(state.teams.map(team => [team.id, team.name]));
    return (ownedNodes || []).map(node => {
      const isOnline = node.status === 'online';
      return {
        node, isOnline, statusLabel: isOnline ? '在线' : '离线',
        labels: nodeLabels(node), projects: nodeProjectLabels(node, teamNames),
      };
    });
  }, [ownedNodes, state.teams]);

  const copy = async () => {
    if (!canCopy) return;
    try { await navigator.clipboard.writeText(cmd); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { /* clipboard unavailable, user can select manually */ }
  };

  return createPortal(
    <ModalBackdrop onClose={onClose}>
      <div className="modal modal-lg add-node-modal" onClick={e => e.stopPropagation()}>
        <h2>添加执行节点</h2>
        <p className="muted">模型中转站配置在「设置」里保存一次即可,登录后自动下发到所有节点,不要把中转站地址填成节点 ID。</p>
        <p className="muted">
          这台节点将绑定到:<b>{activeTeam ? activeTeam.name : '个人'}</b>
          {activeTeam ? '(该项目成员都能在上面建任务)' : '(只有你自己能用)'} — 切换左侧的项目 tab 可以改变这里的绑定。
        </p>

        <section className="node-enrollment-inventory" aria-live="polite">
          <div className="node-enrollment-heading">
            <strong>当前账号已有节点</strong>
            {ownedNodes !== null && <button type="button" className="ghost" onClick={loadOwnedNodes}>刷新</button>}
          </div>
          {ownedNodes === null && !loadError && <div className="muted">正在检查你已有的节点…</div>}
          {loadError && (
            <div className="node-enrollment-load-error">
              <span className="err">无法读取已有节点:{loadError}</span>
              <button type="button" className="ghost" onClick={loadOwnedNodes}>重试</button>
            </div>
          )}
          {ownedNodes && !ownedNodes.length && <div className="muted">当前账号还没有节点。</div>}
          {ownedNodes && ownedNodes.length > 0 && (
            <>
              <div className="node-enrollment-count">你已经添加了 {ownedNodes.length} 个节点。添加新机器时不要复用下面的节点 ID。</div>
              <div className="node-enrollment-list">
                {inventoryRows.map(({ node, isOnline, statusLabel, labels, projects }) => (
                    <div className="node-enrollment-row" key={node.id}>
                      <i className={`dot ${isOnline ? 'online' : ''}`} aria-label={statusLabel} />
                      <div className="node-enrollment-row-body">
                        <strong>{nodeDisplayName(node)}</strong>
                        <code className="node-enrollment-id">ID: {node.id}</code>
                        <span className="muted">
                          {statusLabel}
                          {node.last_heartbeat_at ? ` · 最后心跳 ${fmtAge(node.last_heartbeat_at)} 前` : ''}
                          {labels.length ? ` · ${labels.join(' / ')}` : ''}
                          {` · ${projects.join(' / ')}`}
                        </span>
                      </div>
                    </div>
                ))}
              </div>
            </>
          )}
        </section>

        <label>
          节点 ID(逻辑身份,不是显示名称)
          <span className="muted">建议填写一个能唯一识别目标机器的 ID。留空时安装器会在目标机上根据“主机名-系统用户名”生成;显示名称可稍后在“节点管理”中修改。</span>
          <input type="text" value={nodeId} onChange={e => setNodeId(e.target.value)} placeholder="例如:gpu31-chenyongyuan" />
        </label>

        {nodeIdError && <div className="node-enrollment-warning danger" role="alert"><strong>节点 ID 格式不正确</strong><span>{nodeIdError}</span></div>}
        {enrollment.kind === 'repair-owned' && (
          <div className="node-enrollment-warning danger" role="alert">
            <strong>这是已有节点，不是新增节点</strong>
            <span>输入的 ID 精确匹配“{nodeDisplayName(enrollment.matchingNode)}”({enrollment.nodeId})。在另一台机器执行下面的命令会轮换这个节点的 token，原机器下次重连时将失效。</span>
          </div>
        )}
        {enrollment.kind === 'new-derived-id' && ownedNodes !== null && (
          <div className="node-enrollment-warning" role="alert">
            <strong>留空无法预先排除 ID 冲突</strong>
            <span>浏览器不知道目标服务器最终生成的“主机名-系统用户名”。建议填写唯一 ID;如果生成结果与已有节点相同，也会重新接入并轮换旧 token。</span>
          </div>
        )}
        {enrollment.kind === 'new-explicit-id' && ownedNodes !== null && !nodeIdError && (
          <div className="node-enrollment-new-note">
            “{enrollment.nodeId}”不在你的已有节点中，将按新增节点处理。节点 ID 全局唯一，如果已被其他账号占用，安装器会拒绝注册。
          </div>
        )}
        {needsAcknowledgement && ownedNodes !== null && (
          <label className="row-inline node-enrollment-ack">
            <input type="checkbox" checked={acknowledged} onChange={e => setAcknowledgedKey(e.target.checked ? enrollmentKey : '')} />
            {enrollment.kind === 'repair-owned'
              ? '我确认要修复/重新接入这个已有节点，并知晓它会轮换 token。'
              : '我已确认目标服务器自动生成的 ID 不会撞到上面的已有节点。'}
          </label>
        )}

        <nav className="tabs">
          <button type="button" className={os === 'unix' ? 'active' : ''} onClick={() => setOs('unix')}>macOS / Linux</button>
          <button type="button" className={os === 'windows' ? 'active' : ''} onClick={() => setOs('windows')}>Windows</button>
        </nav>
        <label>
          {enrollment.kind === 'repair-owned' ? '修复/重新接入已有节点命令' : '新增节点命令'}
          <span className="muted">
            {os === 'windows'
              ? '在目标服务器的 PowerShell 里执行(Node.js、Git、Claude Code 缺失时会自动安装,无需管理员权限)'
              : '在目标服务器上执行(Node.js、Claude Code 缺失时会自动安装;需要系统已有 git)'}
          </span>
          <textarea
            readOnly rows={4}
            value={cmd || '请先完成上方的节点检查和确认，安装命令随后显示。'}
            onClick={e => e.target.select()}
          />
        </label>
        <button type="button" onClick={copy} disabled={!canCopy}>{copied ? '已复制 ✓' : ownedNodes === null ? '检查已有节点后可复制' : nodeIdError ? '修正节点 ID 后可复制' : '复制命令'}</button>
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

export function fmtAge(ts) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return `${s | 0}s`;
  if (s < 3600) return `${(s / 60) | 0}m`;
  if (s < 86400) return `${(s / 3600) | 0}h`;
  return `${(s / 86400) | 0}d`;
}

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
