import React, { useEffect, useMemo, useState } from 'react';
import { api } from './api.js';
import { state, upsertTask, bump } from './store.js';
import { fmtAge } from './format.js';
import { BACKEND_LABELS } from './native-auth.js';

// 「继续这台节点上的对话」 — the new-chat pane's answer to "I just brought
// this machine into the project; where's everything I already did on it?"
// Adding a node to a project brings the machine, not its history, so this
// lists, for the picked node, what could be brought into the current scope:
//   - your own AgentHub conversations on it that live elsewhere (personal, or
//     another project) — move / share / copy them here;
//   - claude/codex CLI sessions on the machine nothing has picked up yet —
//     adopt one, which creates the conversation right away.
// No path is needed first: that's exactly what the user doesn't have yet for
// a node that's new to this project. See GET /api/nodes/:id/inheritable.

const SESSIONS_NOTE = {
  'not-owner': '本机 CLI 会话只对节点主人可见',
  upgrade: '节点的 executor 还不支持列出本机 CLI 会话,等它自动升级(约 2-3 分钟)后再打开',
  offline: '节点不在线,暂时读不到本机 CLI 会话',
};

const pathLabel = (p) => p || '无仓库(临时目录)';

export function InheritList({ node, draftBackend, busy, onAdoptSession, onOpened, autoOpen = false }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState(null);   // key of the expanded row
  const [working, setWorking] = useState(false);
  const teamId = state.activeTeamId;
  const team = state.teams.find(t => t.id === teamId);
  const scopeName = team ? `「${team.name}」` : '个人';

  useEffect(() => {
    if (!node?.id) return undefined;
    let stale = false;
    setData(null); setErr(''); setPicked(null);
    api.nodeInheritable(node.id)
      .then(r => { if (!stale) setData(r); })
      .catch(e => { if (!stale) { setErr(e.message); setData({ conversations: [], sessions: [], sessionsState: 'ok' }); } });
    return () => { stale = true; };
  }, [node?.id, teamId]);
  // A node with no conversations in this scope yet is exactly the "I just
  // added this machine here" case — show what it has without a click.
  useEffect(() => {
    if (data && autoOpen && data.conversations.length + data.sessions.length > 0) setOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // One list, grouped by directory: a conversation and a CLI session in the
  // same repo are the same body of work from the user's point of view.
  const groups = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    const items = [
      ...data.conversations.map(c => ({
        key: `t:${c.id}`, kind: 'task', path: c.repoUrl || '', title: c.title, at: c.updatedAt,
        backend: c.backend, source: c.teams.length ? `项目:${c.teams.map(t => t.name).join('、')}` : '个人', item: c,
      })),
      ...data.sessions.map(s => ({
        key: `s:${s.backend}:${s.sessionId}`, kind: 'session', path: s.cwd, title: s.preview, at: s.mtime,
        backend: s.backend, source: '本机CLI', item: s,
      })),
    ].filter(x => !q || `${x.title} ${x.path}`.toLowerCase().includes(q));
    const byPath = new Map();
    for (const x of items) {
      if (!byPath.has(x.path)) byPath.set(x.path, []);
      byPath.get(x.path).push(x);
    }
    return [...byPath].map(([path, list]) => ({ path, list: list.sort((a, b) => b.at - a.at) }))
      .sort((a, b) => b.list[0].at - a.list[0].at);
  }, [data, query]);

  if (!node) return null;
  const total = data ? data.conversations.length + data.sessions.length : null;
  // Nothing at all to offer and nothing to explain: stay out of the way.
  if (data && !total && !err && data.sessionsState === 'ok') return null;

  // Move/share leave the conversation as it is and only change where it's
  // visible; the pane then just opens it. Fetched rather than assumed so the
  // store has it before the pane swaps (same race draftpane.jsx guards).
  const openTask = async (id) => {
    const r = await api.getTask(id);
    upsertTask(r.task); bump();
    onOpened(id);
  };
  const run = async (fn) => {
    setWorking(true); setErr('');
    try { await fn(); } catch (e) { setErr(e.message); setWorking(false); }
  };
  const share = (c) => run(async () => { await api.addTaskTeam(c.id, teamId); await openTask(c.id); });
  const copy = (c) => run(async () => {
    const r = await api.copyTask(c.id);
    if (r.warnings?.length) alert(r.warnings.join('\n\n'));
    upsertTask(r.task); bump();
    onOpened(r.task.id);
  });

  const actionsFor = (x) => {
    if (x.kind === 'session') {
      const s = x.item;
      if (s.backend !== draftBackend) {
        return <span className="muted">这是 {BACKEND_LABELS[s.backend] || s.backend} 会话,先在上面把模型切到 {BACKEND_LABELS[s.backend] || s.backend} 才能接管(会话 ID 不通用)</span>;
      }
      return (
        <>
          <button type="button" disabled={busy || working} onClick={() => onAdoptSession(s)}>接管并继续</button>
          <span className="muted">会在 {s.cwd} 里接着这个会话往下聊{teamId ? ',项目成员都能看到完整历史' : ''}</span>
        </>
      );
    }
    const c = x.item;
    const personal = !c.teams.length;
    const copyBtn = c.hasSession
      ? <button type="button" disabled={working} onClick={() => copy(c)}>复制一份到{scopeName}</button>
      : <span className="muted">还没跑完第一轮,无法复制</span>;
    // A personal conversation added to a project leaves the personal list by
    // itself (see scopedTasks), so "add" already is a move — say it that way.
    if (teamId && personal) {
      return (
        <>
          <button type="button" disabled={working} onClick={() => share(c)}>移入本项目</button>
          <span className="muted">从「个人」移到{scopeName},项目成员都能看到完整历史</span>
        </>
      );
    }
    if (teamId) {
      return (
        <>
          {copyBtn}
          <button type="button" className="ghost" disabled={working} onClick={() => share(c)}>同时共享到本项目</button>
          <span className="muted">复制:独立的新对话,原项目看不到后续;共享:两个项目看到的是同一个对话</span>
        </>
      );
    }
    return (
      <>
        {copyBtn}
        <span className="muted">原对话留在 {x.source.replace('项目:', '')} 不动</span>
      </>
    );
  };

  return (
    <div className="inherit">
      <button type="button" className="ghost link inherit-toggle" onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} 继续 {node.name || node.id} 上已有的对话{total ? ` (${total})` : data ? '' : ' …'}
      </button>
      {open && (
        <div className="inherit-body">
          {err && <div className="err">{err}</div>}
          {data === null && <div className="muted">加载中…</div>}
          {data && total > 6 && (
            <input className="inherit-search" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索标题或路径…" />
          )}
          {groups.map(g => (
            <div key={g.path} className="inherit-group">
              <div className="inherit-path">📁 {pathLabel(g.path)}</div>
              {g.list.map(x => (
                <div key={x.key} className={`inherit-row${picked === x.key ? ' picked' : ''}`}>
                  <button type="button" className="inherit-item" onClick={() => setPicked(picked === x.key ? null : x.key)}>
                    <span className="inherit-title">{x.title}</span>
                    <span className="inherit-meta">
                      <span className="chip">{x.source}</span>
                      <span className="chip">{BACKEND_LABELS[x.backend] || x.backend}</span>
                      <span className="muted">{fmtAge(x.at)} 前</span>
                    </span>
                  </button>
                  {picked === x.key && <div className="inherit-actions">{actionsFor(x)}</div>}
                </div>
              ))}
            </div>
          ))}
          {data && SESSIONS_NOTE[data.sessionsState] && <div className="muted">{SESSIONS_NOTE[data.sessionsState]}</div>}
          {data && !total && !err && <div className="muted">这台节点上没有可以带过来的对话</div>}
        </div>
      )}
    </div>
  );
}
