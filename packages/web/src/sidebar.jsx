import React, { useRef, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { api } from './api.js';
import { state, bump, taskInScope, cacheForScope, scopeKeyOf } from './store.js';
import { STATUS_META, fmtAge, AddNodeModal, ArchivedModal, NodeManageModal, ProjectMembersModal, CreateProjectModal } from './board.jsx';
import { ModalBackdrop } from './modal.jsx';

// A conversation can be shared with several projects at once — toggling one
// checkbox adds/removes just that association. Same reasoning as
// NodeManageModal's move(): no live "removed from old scope" push reaches a
// viewer who isn't in the new scope, so reflect the resulting visibility
// locally right away rather than leaving a stale row until next refresh.
function toggleTaskTeam(task, teamId) {
  const currentlyIn = (task.teamIds || []).includes(teamId);
  const scopeKey = scopeKeyOf(state.activeTeamId);
  const call = currentlyIn ? api.removeTaskTeam(task.id, teamId) : api.addTaskTeam(task.id, teamId);
  call.then(() => {
    const newTeamIds = currentlyIn ? (task.teamIds || []).filter(id => id !== teamId) : [...(task.teamIds || []), teamId];
    const stillVisible = state.activeTeamId ? newTeamIds.includes(state.activeTeamId) : newTeamIds.length === 0;
    const scopedTasks = cacheForScope(scopeKey).tasks;
    if (!stillVisible) { state.tasks.delete(task.id); scopedTasks.delete(task.id); }
    else {
      const updated = { ...task, teamIds: newTeamIds };
      state.tasks.set(task.id, updated); scopedTasks.set(task.id, updated);
    }
    state.taskEpochs[scopeKey] = (state.taskEpochs[scopeKey] || 0) + 1;
    bump();
  }).catch(err => alert(err.message));
}

// A dedicated modal (not an inline popover) because .sidebar-list scrolls
// (overflow-y: auto) — an absolutely-positioned popover anchored inside a
// task row gets clipped by that same overflow, found live via a real-browser
// screenshot showing the picker cut down to a sliver. Modals render via the
// existing fixed-position .modal-backdrop, outside any scrolling ancestor.
function TaskTeamsModal({ task, onClose }) {
  return (
    <ModalBackdrop onClose={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h2>{task.title} · 所属项目</h2>
        <p className="muted">
          {(task.teamIds || []).length ? '取消勾选下面全部项目可恢复为个人' : '个人(未加入任何项目)'}
        </p>
        {state.teams.map(team => (
          <label key={team.id} className="row-inline">
            <input
              type="checkbox" checked={(task.teamIds || []).includes(team.id)}
              onChange={() => toggleTaskTeam(task, team.id)}
            />
            {team.name}
          </label>
        ))}
        {!state.teams.length && <p className="muted">还没有加入任何项目</p>}
        <div className="modal-actions">
          <button type="button" className="ghost" onClick={onClose}>关闭</button>
        </div>
      </div>
    </ModalBackdrop>
  );
}

const DRAG_MIME = 'application/x-agenthub-task';

// Switching teams reconnects the WS (its scope tag is fixed at connect
// time) and refetches tasks/nodes for the new scope — see main.jsx's
// switchTeam(), passed down as onSwitchTeam. The "⚙" member-management
// trigger only shows next to a project you're the *owner* of (state.teams'
// `role` field, from GET /api/teams) — the backend enforces the same rule
// independently, this is just so non-owners never see a button that'd 403.
function TeamSwitcher({ onSwitchTeam, onManageMembers, onCreateProject }) {
  const activeTeam = state.teams.find(t => t.id === state.activeTeamId);
  return (
    <nav className="tabs team-switcher">
      <button
        type="button" className={!state.activeTeamId ? 'active' : ''}
        onClick={() => onSwitchTeam(null)}
      >个人</button>
      {state.teams.map(t => (
        <button
          key={t.id} type="button" className={state.activeTeamId === t.id ? 'active' : ''}
          onClick={() => onSwitchTeam(t.id)}
        >{t.name}</button>
      ))}
      {activeTeam?.role === 'owner' && (
        <button type="button" className="ghost" title="管理项目成员" onClick={() => onManageMembers(activeTeam)}>⚙</button>
      )}
      <button type="button" className="ghost" title="新建项目" onClick={onCreateProject}>+ 新建项目</button>
    </nav>
  );
}

export function Sidebar({ open, selectedTaskId, openPanes, onNewDraft, onSelect, user, pushState, onEnablePush, onOpenSettings, onLogout, onSwitchTeam }) {
  const [showAddNode, setShowAddNode] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [showNodeManage, setShowNodeManage] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [teamsModalTaskId, setTeamsModalTaskId] = useState(null);
  const [manageMembersTeam, setManageMembersTeam] = useState(null);
  const [showCreateProject, setShowCreateProject] = useState(false);
  const asideRef = useRef(null);
  useEffect(() => {
    if (open && matchMedia('(max-width: 720px)').matches) asideRef.current?.querySelector('button')?.focus();
  }, [open]);
  const mobileClosed = !open && matchMedia('(max-width: 720px)').matches;
  const tasks = [...state.tasks.values()].filter(t => !t.archived_at && taskInScope(t)).sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
  const sources = [...state.conversationSources.values()].sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
  const nodes = [...state.nodes.values()];
  const sourceStatus = state.sourceStatus[state.activeTeamId || 'personal'] || {};
  const teamsModalTask = teamsModalTaskId ? tasks.find(t => t.id === teamsModalTaskId) : null;

  return (
    <>
    <aside ref={asideRef} id="app-sidebar" className={`sidebar ${open ? 'open' : ''}`} aria-hidden={mobileClosed} inert={mobileClosed ? '' : undefined}>
      <div className="sidebar-top">
        <div className="brand">AgentHub</div>
        <button className="new-chat-btn" onClick={onNewDraft}>+ 新对话</button>
        <a className="supervisor-link" href="#/supervisor">🧭 总控 agent</a>
      </div>
      <TeamSwitcher onSwitchTeam={onSwitchTeam} onManageMembers={setManageMembersTeam} onCreateProject={() => setShowCreateProject(true)} />

      <nav className="sidebar-list">
        {tasks.map(t => {
          const meta = STATUS_META[t.status] || { label: t.status, cls: '' };
          const isOpen = openPanes?.includes(t.id);
          // Personal view is always "mine" (the API already scopes it that
          // way); team view needs the actual creator check, since actions
          // are creator-only even when the task is visible to the whole team.
          const isMine = !state.activeTeamId || t.owner_user_id === user?.id;
          return (
            <a
              key={t.id} href={`#/task/${t.id}`}
              className={`sidebar-item ${t.id === selectedTaskId ? 'active' : ''} ${isOpen ? 'open-pane' : ''}`}
              draggable onDragStart={e => e.dataTransfer.setData(DRAG_MIME, t.id)}
              onClick={e => { e.preventDefault(); onSelect(t.id); }}
            >
              <span className="sidebar-item-title">{t.title}</span>
              <span className="sidebar-item-meta">
                {state.activeTeamId && t.owner_username && (
                  <span className="chip owner-chip" title="创建者">{t.owner_username}</span>
                )}
                <span className={`chip ${meta.cls}`}>{meta.label}</span>
                <span className="muted">{fmtAge(t.updated_at)}</span>
                {t.status === 'review' && isMine && (
                  <button
                    type="button" className="ghost sidebar-item-action" title="标记完成"
                    onClick={e => { e.preventDefault(); e.stopPropagation(); api.markDone(t.id).catch(err => alert(err.message)); }}
                  >
                    ✓ 完成
                  </button>
                )}
                {isMine && <button
                  type="button" className="ghost sidebar-item-action"
                  onClick={e => { e.preventDefault(); e.stopPropagation(); api.archiveTask(t.id).catch(err => alert(err.message)); }}
                >
                  归档
                </button>}
                {isMine && (
                  <button
                    type="button" className="ghost sidebar-item-action"
                    onClick={e => { e.preventDefault(); e.stopPropagation(); setTeamsModalTaskId(t.id); }}
                  >
                    所属项目
                  </button>
                )}
              </span>
            </a>
          );
        })}
        {sources.map(source => {
          const paneId = `source:${source.id}`;
          return (
            <button
              type="button" key={source.id}
              className={`sidebar-item source-sidebar-item ${paneId === selectedTaskId ? 'active' : ''} ${openPanes?.includes(paneId) ? 'open-pane' : ''}`}
              onClick={() => onSelect(paneId)}
            >
              <span className="sidebar-item-title">{source.preview || 'Claude Code 历史对话'}</span>
              <span className="sidebar-item-meta">
                <span className="chip source-chip">历史 · 未接入</span>
                {source.stale && <span className="chip st-waiting">暂不可刷新</span>}
                <span className="muted">{source.nodeId} · {fmtAge(source.mtime)}</span>
              </span>
            </button>
          );
        })}
        {sourceStatus.error && <div className="sidebar-source-warning">历史会话扫描失败:{sourceStatus.error}</div>}
        {!!sourceStatus.unavailableNodeIds?.length && <div className="sidebar-source-warning">以下节点暂时无法扫描历史:{sourceStatus.unavailableNodeIds.join('、')}</div>}
        {!tasks.length && !sources.length && !sourceStatus.loading && <div className="sidebar-empty muted">还没有对话,点击「+ 新对话」开始</div>}
      </nav>

      <div className="sidebar-footer">
        <div className="node-strip">
          {nodes.map(n => (
            <span
              key={n.id} className={`node-chip ${n.status}`}
              title={n.status === 'online'
                ? `最后心跳 ${fmtAge(n.last_heartbeat_at)} 前`
                : `节点离线(最后心跳 ${fmtAge(n.last_heartbeat_at)} 前)— 打开「节点管理」查看修复指引`}
            >
              <i className={`dot ${n.status === 'online' ? 'online' : ''}`} />{n.name || n.id}
            </span>
          ))}
          {!nodes.length && <span className="muted">无节点</span>}
          {!state.wsConnected && <span className="chip st-failed">连接断开</span>}
        </div>
        <button className="ghost sidebar-btn" onClick={() => setShowAddNode(true)}>+ 添加节点</button>
        <button className="ghost sidebar-btn" onClick={() => setShowNodeManage(true)}>⚙ 节点管理</button>
        <button className="ghost sidebar-btn" onClick={() => setShowArchived(true)}>📥 已归档</button>
        {pushState !== 'on' && <button className="ghost sidebar-btn" onClick={onEnablePush}>🔔 开启推送</button>}
        <div className="user-menu">
          <button className="ghost sidebar-btn user-menu-btn" onClick={() => setMenuOpen(!menuOpen)}>
            {user?.username || '…'}{user?.isAdmin ? ' (管理员)' : ''}
          </button>
          {menuOpen && (
            <div className="user-menu-popover">
              <button className="ghost" onClick={() => { setMenuOpen(false); onOpenSettings(); }}>设置</button>
              <button className="ghost" onClick={onLogout}>退出</button>
            </div>
          )}
        </div>
      </div>

    </aside>
    {createPortal(<>
      {showAddNode && <AddNodeModal onClose={() => setShowAddNode(false)} />}
      {showNodeManage && <NodeManageModal user={user} onClose={() => setShowNodeManage(false)} />}
      {showArchived && <ArchivedModal onClose={() => setShowArchived(false)} />}
      {manageMembersTeam && <ProjectMembersModal teamId={manageMembersTeam.id} teamName={manageMembersTeam.name} currentUserId={user?.id} onClose={() => setManageMembersTeam(null)} />}
      {teamsModalTask && <TaskTeamsModal task={teamsModalTask} onClose={() => setTeamsModalTaskId(null)} />}
      {showCreateProject && <CreateProjectModal onClose={() => setShowCreateProject(false)} onCreated={(teamId) => onSwitchTeam(teamId)} />}
    </>, document.body)}
    </>
  );
}
