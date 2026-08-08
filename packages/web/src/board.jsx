import React, { useState } from 'react';
import { api } from './api.js';
import { state } from './store.js';

export const STATUS_META = {
  queued: { label: '排队', cls: 'st-queued' },
  starting: { label: '启动中', cls: 'st-queued' },
  running: { label: '运行中', cls: 'st-running' },
  waiting_human: { label: '等待决策', cls: 'st-waiting' },
  review: { label: '待 Review', cls: 'st-review' },
  done: { label: '完成', cls: 'st-done' },
  failed: { label: '失败', cls: 'st-failed' },
  cancelled: { label: '已取消', cls: 'st-done' },
  unknown: { label: '状态未知', cls: 'st-failed' },
};

const COLUMNS = [
  { key: 'queued', title: 'Queued', statuses: ['queued', 'starting'] },
  { key: 'running', title: 'Running', statuses: ['running'] },
  { key: 'waiting', title: 'Waiting', statuses: ['waiting_human', 'unknown'] },
  { key: 'review', title: 'Review', statuses: ['review'] },
  { key: 'closed', title: 'Done', statuses: ['done', 'failed', 'cancelled'] },
];

export function fmtAge(ts) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return `${s | 0}s`;
  if (s < 3600) return `${(s / 60) | 0}m`;
  if (s < 86400) return `${(s / 3600) | 0}h`;
  return `${(s / 86400) | 0}d`;
}

function TaskCard({ task }) {
  const meta = STATUS_META[task.status] || { label: task.status, cls: '' };
  return (
    <a className="card" href={`#/task/${task.id}`}>
      <div className="card-title">{task.title}</div>
      <div className="card-meta">
        <span className={`chip ${meta.cls}`}>{meta.label}</span>
        {task.lease === 'human' && <span className="chip st-waiting">IDE 接管中</span>}
        <span className="muted">{task.node_id}</span>
        <span className="muted">{fmtAge(task.updated_at)}</span>
        {task.cost_usd > 0 && <span className="muted">${task.cost_usd.toFixed(2)}</span>}
      </div>
    </a>
  );
}

function NewTaskModal({ onClose }) {
  const nodes = [...state.nodes.values()];
  const [form, setForm] = useState({
    title: '', spec: '', nodeId: nodes.find(n => n.status === 'online')?.id || nodes[0]?.id || '',
    repoUrl: '', baseBranch: 'main', permissionMode: 'acceptEdits',
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const r = await api.createTask({
        title: form.title.trim(), spec: form.spec.trim(), nodeId: form.nodeId,
        repoUrl: form.repoUrl.trim() || null, baseBranch: form.baseBranch.trim() || 'main',
        permissionMode: form.permissionMode,
      });
      onClose();
      location.hash = `#/task/${r.task.id}`;
    } catch (e2) { setErr(e2.message); setBusy(false); }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal" onClick={e => e.stopPropagation()} onSubmit={submit}>
        <h2>新建任务</h2>
        <label>标题<input value={form.title} onChange={set('title')} required autoFocus placeholder="修复 xx bug" /></label>
        <label>任务描述(首条 prompt)
          <textarea value={form.spec} onChange={set('spec')} required rows={6} placeholder="详细描述要做什么、验收标准…" />
        </label>
        <label>执行节点
          <select value={form.nodeId} onChange={set('nodeId')} required>
            {nodes.map(n => <option key={n.id} value={n.id}>{n.id}{n.status !== 'online' ? '(离线)' : ''}</option>)}
          </select>
        </label>
        <div className="row2">
          <label>仓库 URL(可选)<input value={form.repoUrl} onChange={set('repoUrl')} placeholder="git@github.com:me/repo.git" /></label>
          <label>基准分支<input value={form.baseBranch} onChange={set('baseBranch')} /></label>
        </div>
        <label>权限模式
          <select value={form.permissionMode} onChange={set('permissionMode')}>
            <option value="acceptEdits">acceptEdits(推荐:自动编辑,Bash 需审批)</option>
            <option value="default">default(所有敏感操作需审批)</option>
            <option value="bypassPermissions">bypassPermissions(⚠️ 全部放行)</option>
          </select>
        </label>
        {form.permissionMode === 'bypassPermissions' && <div className="err">⚠️ 该任务将不经审批执行任何命令</div>}
        {err && <div className="err">{err}</div>}
        <div className="modal-actions">
          <button type="button" className="ghost" onClick={onClose}>取消</button>
          <button disabled={busy}>{busy ? '创建中…' : '创建'}</button>
        </div>
      </form>
    </div>
  );
}

export function Board({ pushState, onEnablePush, onLogout }) {
  const [showNew, setShowNew] = useState(false);
  const tasks = [...state.tasks.values()];
  const nodes = [...state.nodes.values()];

  return (
    <div className="board-page">
      <header className="topbar">
        <h1>🤖 AgentHub</h1>
        <div className="node-strip">
          {nodes.map(n => (
            <span key={n.id} className={`node-chip ${n.status}`} title={`最后心跳 ${fmtAge(n.last_heartbeat_at)} 前`}>
              <i className="dot" />{n.id}
            </span>
          ))}
          {!nodes.length && <span className="muted">无节点</span>}
        </div>
        <div className="topbar-actions">
          {!state.wsConnected && <span className="chip st-failed">连接断开</span>}
          {pushState !== 'on' && <button className="ghost" onClick={onEnablePush}>🔔 开启推送</button>}
          <button onClick={() => setShowNew(true)}>+ 新建任务</button>
          <button className="ghost" onClick={onLogout}>退出</button>
        </div>
      </header>
      <div className="columns">
        {COLUMNS.map(col => {
          const list = tasks
            .filter(t => col.statuses.includes(t.status))
            .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
          return (
            <section className="column" key={col.key}>
              <h3>{col.title} <span className="count">{list.length}</span></h3>
              {list.map(t => <TaskCard key={t.id} task={t} />)}
            </section>
          );
        })}
      </div>
      {showNew && <NewTaskModal onClose={() => setShowNew(false)} />}
    </div>
  );
}
