import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAgent } from 'agents/react';
import { getToolApproval, useAgentChat } from '@cloudflare/ai-chat/react';
import { getToken } from './api.js';
import { renderMarkdown } from './md.js';

const LEVEL_LABEL = {
  off: '全部人工',
  low: '自动放行低风险',
  medium: '自动放行低+中风险',
};

const TIER_LABEL = { low: '低风险', medium: '中风险', high: '高风险', manual: '人工' };

const SUGGESTIONS = [
  '各个项目现在什么进展?',
  '有哪些对话卡住了或失败了?',
  '现在有待授权的请求吗?风险多大?',
  '帮我给某个对话写一条继续推进的 prompt',
];

// A tool part's type is `tool-<toolName>`; everything else (text, reasoning,
// step markers) is rendered separately.
function toolNameOf(part) {
  return typeof part?.type === 'string' && part.type.startsWith('tool-') ? part.type.slice(5) : null;
}

function ToolPart({ part, onApprove, busy }) {
  const name = toolNameOf(part);
  const approval = getToolApproval(part);
  const pending = approval && approval.approved === undefined;
  const input = part.input ?? part.args;

  return (
    <div className={`sv-tool${pending ? ' pending' : ''}`}>
      <div className="sv-tool-head">
        <span className="chip">🔧 {name}</span>
        {pending && <span className="chip st-waiting">等待你确认</span>}
        {approval?.approved === true && <span className="chip">已批准</span>}
        {approval?.approved === false && <span className="chip st-failed">已拒绝</span>}
      </div>
      {input != null && (
        <pre className="sv-tool-input">{typeof input === 'string' ? input : JSON.stringify(input, null, 1)}</pre>
      )}
      {pending && (
        <div className="sv-tool-actions">
          <button type="button" className="ghost" disabled={busy} onClick={() => onApprove(approval.id, true)}>批准执行</button>
          <button type="button" className="ghost deny" disabled={busy} onClick={() => onApprove(approval.id, false)}>拒绝</button>
        </div>
      )}
    </div>
  );
}

function NoticeList({ notices }) {
  const [open, setOpen] = useState(true);
  if (!notices?.length) return null;
  return (
    <section className="sv-notices">
      <button type="button" className="sv-notices-toggle" onClick={() => setOpen(o => !o)}>
        {open ? '▾' : '▸'} 巡检发现 ({notices.length})
      </button>
      {open && (
        <ul>
          {notices.slice(0, 12).map((n, i) => (
            <li key={`${n.at}-${i}`} className={`sv-notice sv-notice-${n.kind}`}>
              <span className="muted">{new Date(n.at).toLocaleString()}</span>
              <div dangerouslySetInnerHTML={{ __html: renderMarkdown(n.text || '') }} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AuditList({ audit }) {
  const [open, setOpen] = useState(false);
  if (!audit?.length) return null;
  return (
    <section className="sv-notices">
      <button type="button" className="sv-notices-toggle" onClick={() => setOpen(o => !o)}>
        {open ? '▾' : '▸'} 自动决策记录 ({audit.length})
      </button>
      {open && (
        <ul>
          {audit.slice(0, 20).map((a, i) => (
            <li key={`${a.at}-${i}`} className="sv-notice">
              <span className="muted">{new Date(a.at).toLocaleString()}</span>
              <div>
                <b>{a.taskTitle}</b> · {a.toolName} · <span className="chip">{TIER_LABEL[a.tier] || a.tier}</span> · {a.action}
                <div className="muted">{a.reason}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function SupervisorPage() {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef(null);
  const token = useRef(getToken()).current;

  // basePath pins the connection to /supervisor; the Worker decides which
  // Durable Object instance that resolves to from the session token, so the
  // browser can never address another user's supervisor.
  const agent = useAgent({
    agent: 'supervisor-agent',
    basePath: 'supervisor',
    query: { token },
  });

  const {
    messages, sendMessage, status, stop, clearHistory,
    addToolApprovalResponse, isStreaming, connectionError,
  } = useAgentChat({ agent });

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  const state = agent.state || {};
  const level = state.autoApprove || 'off';

  const submit = useCallback((text) => {
    const value = (text ?? input).trim();
    if (!value || isStreaming) return;
    sendMessage({ role: 'user', parts: [{ type: 'text', text: value }] });
    setInput('');
  }, [input, isStreaming, sendMessage]);

  const approve = useCallback(async (id, approved) => {
    setBusy(true);
    try { await addToolApprovalResponse({ id, approved }); }
    finally { setBusy(false); }
  }, [addToolApprovalResponse]);

  const setLevel = (next) => {
    agent.setState({ ...state, autoApprove: next });
  };

  return (
    <div className="sv-page">
      <header className="sv-header">
        <a className="ghost link" href="#/">← 返回看板</a>
        <h1>总控 agent</h1>
        <div className="sv-header-right">
          <label className="sv-level">
            自动授权
            <select value={level} onChange={e => setLevel(e.target.value)}>
              {Object.entries(LEVEL_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <button type="button" className="ghost link" onClick={clearHistory}>清空对话</button>
        </div>
      </header>

      {connectionError && <div className="err sv-banner">连接失败:{connectionError.message || '未知错误'}</div>}
      <div className="sv-banner muted">
        高风险操作(删除、推送、部署、凭据)在任何级别下都不会被自动批准。
      </div>

      <NoticeList notices={state.notices} />
      <AuditList audit={state.audit} />

      <div className="chat-list sv-chat">
        {!messages.length && (
          <div className="empty">
            <p>我会盯着你所有项目里的对话:谁卡住了、谁在等授权、今天有什么进展。</p>
            <div className="sv-suggestions">
              {SUGGESTIONS.map(s => (
                <button type="button" key={s} className="ghost" onClick={() => submit(s)}>{s}</button>
              ))}
            </div>
          </div>
        )}
        {messages.map(m => (
          <div key={m.id} className={`msg-row ${m.role}`}>
            <div className="msg-col">
              {(m.parts || []).map((part, i) => {
                if (part.type === 'text') {
                  return <div key={i} dangerouslySetInnerHTML={{ __html: renderMarkdown(part.text || '') }} />;
                }
                if (toolNameOf(part)) {
                  return <ToolPart key={i} part={part} onApprove={approve} busy={busy} />;
                }
                return null;
              })}
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <div className="composer sv-composer">
        <div className="composer-row">
          <textarea
            rows={2} value={input} placeholder="问我任何关于你项目的问题…(Enter 发送,Shift+Enter 换行)"
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
            }}
          />
          {isStreaming
            ? <button type="button" className="ghost" onClick={stop}>停止</button>
            : <button type="button" onClick={() => submit()} disabled={!input.trim() || status === 'submitted'}>发送</button>}
        </div>
      </div>
    </div>
  );
}
