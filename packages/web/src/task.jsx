import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';
import { state, taskMessages, addMessage, bump } from './store.js';
import { renderMarkdown } from './md.js';
import { STATUS_META, fmtAge } from './board.jsx';

function Md({ text }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

function toolSummary(name, input) {
  if (!input) return name;
  if (input.command) return String(input.command).slice(0, 120);
  if (input.file_path) return input.file_path;
  if (input.pattern) return input.pattern;
  const s = JSON.stringify(input);
  return s.length > 120 ? s.slice(0, 117) + '…' : s;
}

function ToolUseRow({ msg, result }) {
  const [open, setOpen] = useState(false);
  const { name, input } = msg.content;
  const isErr = result?.content?.is_error;
  return (
    <div className={`tool-row ${isErr ? 'tool-err' : ''}`}>
      <button className="tool-head" onClick={() => setOpen(!open)}>
        <span className="tool-icon">{open ? '▾' : '▸'}</span>
        <span className="tool-name">{name}</span>
        <span className="tool-sum">{toolSummary(name, input)}</span>
        {result && <span className={`tool-status ${isErr ? 'bad' : 'ok'}`}>{isErr ? '✗' : '✓'}</span>}
      </button>
      {open && (
        <div className="tool-body">
          <div className="tool-section">输入</div>
          <pre>{JSON.stringify(input, null, 2)}</pre>
          {result && <>
            <div className="tool-section">输出</div>
            <pre>{typeof result.content?.content === 'string'
              ? result.content.content
              : JSON.stringify(result.content?.content, null, 2)}</pre>
          </>}
        </div>
      )}
    </div>
  );
}

function PermCard({ task, msg }) {
  const { requestId, toolName, input, description } = msg.content;
  const pending = task.pending_request ? JSON.parse(task.pending_request) : null;
  const isActive = pending?.requestId === requestId && task.status === 'waiting_human';
  const [busy, setBusy] = useState(false);
  const act = async (behavior) => {
    setBusy(true);
    try { await api.decision(task.id, requestId, behavior); } catch (e) { alert(e.message); }
    setBusy(false);
  };
  return (
    <div className={`perm-card ${isActive ? 'active' : ''}`}>
      <div className="perm-title">🔐 请求权限:<b>{toolName}</b></div>
      {description && <div className="muted">{description}</div>}
      <pre className="perm-input">{input?.command || JSON.stringify(input, null, 2)}</pre>
      {isActive ? (
        <div className="perm-actions">
          <button className="allow" disabled={busy} onClick={() => act('allow')}>允许</button>
          <button className="deny" disabled={busy} onClick={() => act('deny')}>拒绝</button>
        </div>
      ) : <div className="muted">已处理</div>}
    </div>
  );
}

function ResultCard({ msg }) {
  const c = msg.content;
  return (
    <div className="result-card">
      <span>{c.is_error ? '❌' : '🏁'} 本轮结束</span>
      <span className="muted">{(c.duration_ms / 1000).toFixed(0)}s · {c.num_turns} turns · 本轮 ${c.turn_cost_usd?.toFixed(3)} · 累计 ${c.total_cost_usd?.toFixed(3)}(参考成本)</span>
    </div>
  );
}

function DiffView({ messages }) {
  const diffMsg = [...messages].reverse().find(m => m.role === 'diff');
  const patch = diffMsg?.content?.patch;
  const files = useMemo(() => splitPatch(patch), [patch]);
  if (!diffMsg) return <div className="empty">还没有变更(任务完成一轮后会生成 diff)</div>;
  const { stat } = diffMsg.content;
  return (
    <div className="diff-view">
      {stat && <pre className="diff-stat">{stat}</pre>}
      {files.map((f, i) => <DiffFile key={i} file={f} />)}
    </div>
  );
}

function splitPatch(patch) {
  if (!patch) return [];
  const files = [];
  let cur = null;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git')) {
      if (cur) files.push(cur);
      const m = line.match(/ b\/(.+)$/);
      cur = { name: m ? m[1] : line, lines: [] };
    } else if (cur) cur.lines.push(line);
  }
  if (cur) files.push(cur);
  return files;
}

function DiffFile({ file }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="diff-file">
      <button className="diff-file-head" onClick={() => setOpen(!open)}>{open ? '▾' : '▸'} {file.name}</button>
      {open && (
        <pre className="diff-body">
          {file.lines.map((l, i) => {
            const cls = l.startsWith('+') && !l.startsWith('+++') ? 'dl-add'
              : l.startsWith('-') && !l.startsWith('---') ? 'dl-del'
              : l.startsWith('@@') ? 'dl-hunk' : '';
            return <div key={i} className={`dl ${cls}`}>{l || ' '}</div>;
          })}
        </pre>
      )}
    </div>
  );
}

function Message({ task, msg, resultByToolId }) {
  switch (msg.role) {
    case 'user':
      return <div className="bubble user"><Md text={msg.content.text} /></div>;
    case 'assistant':
      return <div className="bubble assistant"><Md text={msg.content.text} /></div>;
    case 'tool_use':
      return <ToolUseRow msg={msg} result={resultByToolId.get(msg.content.id)} />;
    case 'tool_result':
      return null; // rendered inline with its tool_use
    case 'perm_request':
      return <PermCard task={task} msg={msg} />;
    case 'result':
      return <ResultCard msg={msg} />;
    case 'diff': {
      const n = (msg.content.stat || '').split('\n').filter(Boolean).length;
      return <div className="sys-note">📝 生成了变更({Math.max(n - 1, 0)} 个文件)— 见「变更」标签页</div>;
    }
    case 'system':
      return <div className="sys-note">{msg.content.text}</div>;
    default:
      return <div className="sys-note">{msg.role}</div>;
  }
}

export function TaskDetail({ taskId }) {
  const task = state.tasks.get(taskId);
  const messages = taskMessages(taskId);
  const [tab, setTab] = useState('chat');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const listRef = useRef(null);
  const loadedRef = useRef(false);

  useEffect(() => {
    loadedRef.current = false;
    api.messages(taskId).then(r => {
      for (const m of r.messages) addMessage(taskId, m);
      loadedRef.current = true;
      bump();
    }).catch(() => {});
  }, [taskId]);

  // WS reconnected: backfill anything missed while disconnected/locked.
  const wsConnected = state.wsConnected;
  useEffect(() => {
    if (!wsConnected || !loadedRef.current) return;
    const known = taskMessages(taskId);
    const after = known.length ? known[known.length - 1].seq : 0;
    api.messages(taskId, after).then(r => {
      if (!r.messages.length) return;
      for (const m of r.messages) addMessage(taskId, m);
      bump();
    }).catch(() => {});
  }, [wsConnected, taskId]);

  useEffect(() => {
    if (atBottom && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages.length, atBottom, tab]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
  };

  const resultByToolId = useMemo(() => {
    const map = new Map();
    for (const m of messages) if (m.role === 'tool_result') map.set(m.content.tool_use_id, m);
    return map;
  }, [messages]);

  if (!task) return <div className="empty page-pad"><a href="#/">← 返回</a> 任务不存在或尚未加载</div>;
  const meta = STATUS_META[task.status] || { label: task.status, cls: '' };

  const send = async (e) => {
    e?.preventDefault();
    const t = text.trim();
    if (!t) return;
    setBusy(true);
    try { await api.sendMessage(taskId, t); setText(''); } catch (e2) { alert(e2.message); }
    setBusy(false);
  };

  const takeover = async () => {
    if (!task.session_id) { alert('会话尚未建立(任务还没真正开始),暂时无法接管。'); return; }
    const r = await api.lease(taskId, 'human').catch(e => alert(e.message));
    if (r) alert(`已切换为 IDE 接管。\n\n在节点 ${r.nodeId} 上执行:\n  CLAUDE_CONFIG_DIR=~/agenthub/claude-config \\\n  ANTHROPIC_BASE_URL=<中转站> ANTHROPIC_API_KEY=<key> \\\n  claude --resume ${r.sessionId}\n\n(会话文件存放在 executor 的 claude-config 目录,不带 CLAUDE_CONFIG_DIR 将找不到会话。)完成后点「归还」。`);
  };

  return (
    <div className="task-page">
      <header className="topbar">
        <a className="back" href="#/">←</a>
        <div className="task-head">
          <h2>{task.title}</h2>
          <div className="card-meta">
            <span className={`chip ${meta.cls}`}>{meta.label}</span>
            {task.lease === 'human' && <span className="chip st-waiting">IDE 接管中</span>}
            <span className="muted">{task.node_id}</span>
            <span className="muted">${(task.cost_usd ?? 0).toFixed(3)}</span>
          </div>
        </div>
        <nav className="tabs">
          {[['chat', '对话'], ['diff', '变更'], ['info', '信息']].map(([k, label]) => (
            <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{label}</button>
          ))}
        </nav>
      </header>

      {tab === 'chat' && (
        <>
          <div className="chat-list" ref={listRef} onScroll={onScroll}>
            {messages.map(m => <Message key={m.seq} task={task} msg={m} resultByToolId={resultByToolId} />)}
            {!messages.length && <div className="empty">暂无消息</div>}
          </div>
          {!atBottom && (
            <button className="jump-latest" onClick={() => { listRef.current.scrollTop = listRef.current.scrollHeight; }}>
              有新消息 ↓
            </button>
          )}
          {task.status === 'review' && task.lease !== 'human' && (
            <div className="review-bar">
              任务待 Review
              <button onClick={() => api.markDone(taskId).catch(e => alert(e.message))}>✓ 标记完成</button>
            </div>
          )}
          <form className="composer" onSubmit={send}>
            <textarea
              value={text} onChange={e => setText(e.target.value)} rows={2}
              placeholder={task.lease === 'human' ? 'IDE 接管中,看板只读' : '发消息继续对话…(Enter 发送,Shift+Enter 换行)'}
              disabled={task.lease === 'human' || busy}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            />
            <button disabled={busy || task.lease === 'human' || !text.trim()}>发送</button>
          </form>
        </>
      )}

      {tab === 'diff' && <div className="tab-scroll"><DiffView messages={messages} /></div>}

      {tab === 'info' && (
        <div className="tab-scroll info-view">
          <dl>
            <dt>任务 ID</dt><dd><code>{task.id}</code></dd>
            <dt>会话 ID</dt><dd><code>{task.session_id || '—'}</code></dd>
            <dt>节点</dt><dd>{task.node_id}</dd>
            <dt>仓库</dt><dd>{task.repo_url || '(无,scratch 目录)'}</dd>
            <dt>分支</dt><dd>{task.branch_name || `task/${task.id}`} ← {task.base_branch}</dd>
            <dt>权限模式</dt><dd>{task.permission_mode}{task.permission_mode === 'bypassPermissions' && ' ⚠️'}</dd>
            <dt>成本(参考)</dt><dd>${(task.cost_usd ?? 0).toFixed(4)}</dd>
            <dt>创建于</dt><dd>{new Date(task.created_at).toLocaleString()}</dd>
            {task.last_error && <><dt>最近错误</dt><dd className="err">{task.last_error}</dd></>}
          </dl>
          <div className="info-actions">
            {task.lease === 'daemon'
              ? <button onClick={takeover}>⌨️ 在 IDE 中接管</button>
              : <button onClick={() => api.lease(taskId, 'daemon').catch(e => alert(e.message))}>↩️ 归还给看板</button>}
            {!['done', 'failed', 'cancelled'].includes(task.status) &&
              <button className="deny" onClick={() => confirm('确认取消任务?') && api.cancel(taskId).catch(e => alert(e.message))}>✕ 取消任务</button>}
          </div>
          <div className="spec-box">
            <h4>任务描述</h4>
            <Md text={task.spec} />
          </div>
        </div>
      )}
    </div>
  );
}
