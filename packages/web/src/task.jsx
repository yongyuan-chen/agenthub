import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';
import { state, taskMessages, addMessage, bump } from './store.js';
import { renderMarkdown } from './md.js';
import { STATUS_META, fmtAge } from './board.jsx';
import { SessionPicker } from './sessionpicker.jsx';
import { addAttachment, revoke } from './attachments.js';
import { MAX_IMAGES_PER_MESSAGE } from '../../shared/protocol.mjs';

function Md({ text }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

// GET /api/tasks/:id/messages is capped at 1000 per request — a
// long-running (especially autonomous/bypassPermissions) conversation can
// easily exceed that, so a single fetch starting from `after` only ever
// returns the *oldest* slice, not the current tail. Loops until a page
// comes back short of the cap (the real end) instead of leaving whatever's
// beyond the first 1000 unfetched — found live: a 2600-message conversation
// showed content from hours earlier, only closing the gap by accident
// whenever a WS reconnect happened to fire the backfill effect again.
async function fetchAllMessagesSince(taskId, after, isCancelled) {
  let cursor = after;
  for (;;) {
    const r = await api.messages(taskId, cursor);
    if (isCancelled()) return;
    if (r.messages.length) {
      for (const m of r.messages) addMessage(taskId, m);
      bump();
      cursor = r.messages[r.messages.length - 1].seq;
    }
    if (r.messages.length < 1000) return; // caught up to the current tail
  }
}

function toolSummary(name, input) {
  if (!input) return name;
  if (input.command) return String(input.command).slice(0, 120);
  if (input.file_path) return input.file_path;
  if (input.pattern) return input.pattern;
  const s = JSON.stringify(input);
  return s.length > 120 ? s.slice(0, 117) + '…' : s;
}

// Line-level classing shared with DiffFile (dl-add/dl-del) — Edit/MultiEdit/
// Write don't get a real LCS diff here, just old_string-as-removed then
// new_string-as-added, which is good enough for the small, targeted edits
// these tools actually apply.
function editLines(old_string, new_string) {
  const out = [];
  if (old_string) old_string.split('\n').forEach((l, i) => out.push(<div key={`o${i}`} className="dl dl-del">{l || ' '}</div>));
  (new_string ?? '').split('\n').forEach((l, i) => out.push(<div key={`n${i}`} className="dl dl-add">{l || ' '}</div>));
  return out;
}

function toolBody(name, input, result) {
  const output = typeof result?.content?.content === 'string'
    ? result.content.content
    : result ? JSON.stringify(result.content?.content, null, 2) : null;
  if (name === 'Bash') {
    return (
      <div className="tool-bash">
        <pre className="tool-bash-cmd">$ {input?.command}</pre>
        {output != null && <pre className={`tool-bash-out ${result?.content?.is_error ? 'bad' : ''}`}>{output}</pre>}
      </div>
    );
  }
  if (name === 'Read' && output != null) {
    // The tool's own output already prefixes each line with "N\t" (cat -n
    // style) — strip that instead of rendering our own numbers on top of it.
    return (
      <pre className="tool-read">
        {output.split('\n').map((l, i) => <div key={i} className="dl"><span className="ln">{i + 1}</span>{l.replace(/^\s*\d+\t/, '')}</div>)}
      </pre>
    );
  }
  if (name === 'Edit' || name === 'Write') {
    return <pre className="diff-body">{editLines(input?.old_string, input?.new_string ?? input?.content)}</pre>;
  }
  if (name === 'MultiEdit' && Array.isArray(input?.edits)) {
    return <pre className="diff-body">{input.edits.flatMap((e, ei) => editLines(e.old_string, e.new_string).map(n => React.cloneElement(n, { key: `${ei}-${n.key}` })))}</pre>;
  }
  if (name === 'TodoWrite' && Array.isArray(input?.todos)) {
    return (
      <ul className="todo-list">
        {input.todos.map((t, i) => (
          <li key={i} className={`todo-item todo-${t.status}`}>
            <span className="todo-check">{t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '▶' : '☐'}</span>
            {t.content}
          </li>
        ))}
      </ul>
    );
  }
  return null;
}

function ToolUseRow({ msg, result }) {
  const [open, setOpen] = useState(false);
  const { name, input } = msg.content;
  const isErr = result?.content?.is_error;
  const special = open ? toolBody(name, input, result) : null;
  return (
    <div className={`tool-row ${isErr ? 'tool-err' : ''}`}>
      <button className="tool-head" onClick={() => setOpen(!open)}>
        <span className="tool-icon">{open ? '▾' : '▸'}</span>
        <span className="tool-name">{name}</span>
        <span className="tool-sum">{toolSummary(name, input)}</span>
        {result && <span className={`tool-status ${isErr ? 'bad' : 'ok'}`}>{isErr ? '✗' : '✓'}</span>}
      </button>
      {open && (
        special ? <div className="tool-body">{special}</div> : (
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
        )
      )}
    </div>
  );
}

// A busy turn can chain a dozen+ tool calls back to back — each one already
// starts collapsed on its own, but a wall of collapsed rows is still a wall.
// Grouping a run of them under one header (collapsed by default) reads as a
// single step instead of N. The exception is the chain still being built —
// no 'result' message after it yet means the turn hasn't finished, so it
// defaults open where you'd actually want to watch it live.
export function ToolChain({ toolUses, resultByToolId, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen);
  if (toolUses.length <= 1) {
    return toolUses.map(m => <ToolUseRow key={m.seq} msg={m} result={resultByToolId.get(m.content.id)} />);
  }
  const errCount = toolUses.filter(m => resultByToolId.get(m.content.id)?.content?.is_error).length;
  return (
    <div className={`tool-chain ${open ? 'open' : ''}`}>
      <button className="tool-chain-head" onClick={() => setOpen(!open)}>
        <span className="tool-icon">{open ? '▾' : '▸'}</span>
        <span className="tool-chain-title">🔧 {toolUses.length} 次工具调用</span>
        {errCount > 0 && <span className="tool-status bad">{errCount} 个失败</span>}
      </button>
      {open && (
        <div className="tool-chain-body">
          {toolUses.map(m => <ToolUseRow key={m.seq} msg={m} result={resultByToolId.get(m.content.id)} />)}
        </div>
      )}
    </div>
  );
}

// Splits the flat message list into standalone messages and runs of
// consecutive tool_use/tool_result messages (rendered via ToolChain instead
// of one-by-one). A chain counts as "still executing" — and defaults open —
// when no 'result' message appears anywhere after it yet.
export function groupForToolChains(messages) {
  const groups = [];
  let chain = null;
  for (const m of messages) {
    if (m.role === 'tool_use' || m.role === 'tool_result') {
      if (!chain) { chain = { type: 'chain', msgs: [] }; groups.push(chain); }
      chain.msgs.push(m);
    } else {
      chain = null;
      groups.push({ type: 'single', msg: m });
    }
  }
  let sawResultAfter = false;
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i];
    if (g.type === 'chain') g.done = sawResultAfter;
    else if (g.msg.role === 'result') sawResultAfter = true;
  }
  return groups;
}

// AskUserQuestion's permission prompt needs the user's actual pick, not just
// allow/deny — approving with an unmodified input leaves the CLI with no way
// to know what was chosen. Verified directly against the real CLI: approving
// with `updatedInput: {...input, answers: {[question]: label}}` (array of
// labels for multiSelect) is what the tool itself expects back.
function AskUserQuestionCard({ input, isActive, busy, onDecide }) {
  const questions = input.questions || [];
  const [selected, setSelected] = useState({}); // question text -> label | label[]

  const pick = (q, label) => {
    setSelected(prev => {
      if (q.multiSelect) {
        const cur = prev[q.question] || [];
        const next = cur.includes(label) ? cur.filter(l => l !== label) : [...cur, label];
        return { ...prev, [q.question]: next };
      }
      return { ...prev, [q.question]: label };
    });
  };

  const allAnswered = questions.every(q => {
    const a = selected[q.question];
    return q.multiSelect ? Array.isArray(a) && a.length > 0 : !!a;
  });

  const submit = () => {
    const answers = {};
    for (const q of questions) answers[q.question] = selected[q.question];
    onDecide('allow', { ...input, answers });
  };

  return (
    <div className={`perm-card askq-card ${isActive ? 'active' : ''}`}>
      <div className="perm-title">❓ 需要你选择</div>
      {questions.map((q, qi) => (
        <div className="askq-question" key={qi}>
          <div className="askq-question-text">{q.question}</div>
          <div className="askq-options">
            {(q.options || []).map(opt => {
              const isSel = q.multiSelect
                ? (selected[q.question] || []).includes(opt.label)
                : selected[q.question] === opt.label;
              return (
                <button
                  type="button" key={opt.label} title={opt.description}
                  className={`askq-option ${isSel ? 'selected' : ''}`}
                  disabled={busy || !isActive} onClick={() => pick(q, opt.label)}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      {isActive ? (
        <div className="perm-actions">
          <button className="allow" disabled={busy || !allAnswered} onClick={submit}>{busy ? '提交中…' : '确认'}</button>
          <button className="deny" disabled={busy} onClick={() => onDecide('deny')}>{busy ? '提交中…' : '拒绝'}</button>
        </div>
      ) : <div className="muted">已处理</div>}
    </div>
  );
}

function PermCard({ task, msg, isCreator }) {
  const { requestId, toolName, input, description } = msg.content;
  const pending = task.pending_request ? JSON.parse(task.pending_request) : null;
  // Deciding is a mutating action — creator-only, same as every other
  // action, even though the request card itself is visible to the whole team.
  const isActive = pending?.requestId === requestId && task.status === 'waiting_human' && isCreator;
  const [busy, setBusy] = useState(false);
  const act = async (behavior, updatedInput, autoApprove, forceAll) => {
    setBusy(true);
    try { await api.decision(task.id, requestId, behavior, undefined, updatedInput, autoApprove, forceAll); } catch (e) { alert(e.message); }
    setBusy(false);
  };

  if (toolName === 'AskUserQuestion' && input?.questions?.length) {
    return <AskUserQuestionCard input={input} isActive={isActive} busy={busy} onDecide={act} />;
  }

  // A plan can run to hundreds of lines of markdown — rendering it raw via
  // JSON.stringify (below) shows literal "\n" instead of real line breaks
  // *and* has no height limit, so the 允许/拒绝 buttons end up pushed far
  // below the fold with nothing that looks clickable in view — found live,
  // reported as "没有任何可以点击的地方". Render it as actual markdown in a
  // scrollable box instead, so the buttons always stay right below it.
  if (toolName === 'ExitPlanMode' && typeof input?.plan === 'string') {
    return (
      <div className={`perm-card ${isActive ? 'active' : ''}`}>
        <div className="perm-title">🔐 请求权限:<b>退出计划模式,开始执行</b></div>
        <div className="perm-plan"><Md text={input.plan} /></div>
        {isActive ? (
          <div className="perm-actions">
            <button className="allow" disabled={busy} onClick={() => act('allow')}>{busy ? '提交中…' : '批准计划'}</button>
            <button className="deny" disabled={busy} onClick={() => act('deny')}>{busy ? '提交中…' : '拒绝'}</button>
          </div>
        ) : <div className="muted">已处理</div>}
      </div>
    );
  }

  // "Auto-approve from here on" switches permission_mode to bypassPermissions
  // — pointless to offer when it's already there (no more prompts to skip)
  // or on ExitPlanMode (Claude CLI's own hard gate asks regardless of mode,
  // see the ExitPlanMode branch above — bypass genuinely can't skip it).
  const offerAutoApprove = task.permission_mode !== 'bypassPermissions';

  return (
    <div className={`perm-card ${isActive ? 'active' : ''}`}>
      <div className="perm-title">🔐 请求权限:<b>{toolName}</b></div>
      {description && <div className="muted">{description}</div>}
      <pre className="perm-input">{input?.command || JSON.stringify(input, null, 2)}</pre>
      {isActive ? (
        <div className="perm-actions">
          <button className="allow" disabled={busy} onClick={() => act('allow')}>{busy ? '提交中…' : '允许'}</button>
          <button className="deny" disabled={busy} onClick={() => act('deny')}>{busy ? '提交中…' : '拒绝'}</button>
          {offerAutoApprove && (
            <>
              <button
                className="ghost" disabled={busy}
                title="批准这次,并且这个对话以后的操作都不再询问(切到 bypassPermissions)"
                onClick={() => act('allow', undefined, 'this')}
              >此对话自动授权</button>
              <button
                className="ghost" disabled={busy}
                title="批准这次,并且当前账户下所有对话(含正在运行的)以后都不再询问"
                onClick={() => {
                  if (confirm('确定要让当前账户下所有对话——包括正在运行的——都切换为自动授权(bypassPermissions)吗?切换后这些对话后续的操作将不再询问你,请确保你信任所有正在运行的任务在做的事。')) {
                    act('allow', undefined, 'account');
                  }
                }}
              >账户全部对话自动授权</button>
            </>
          )}
        </div>
      ) : <div className="muted">已处理</div>}
      {isActive && !offerAutoApprove && (
        <div className="perm-bypass-note">
          <div className="muted">
            此对话已是自动授权(bypassPermissions)模式,但仍出现了这个请求 —
            这类操作(常见于包含 rm 的命令)是 claude CLI 自身强制要求人工确认的安全底线,
            任何权限模式都无法跳过。可以继续手动点允许/拒绝,或者让 AgentHub 代你自动点允许
            (这会彻底关掉这道人工把关,不只是切换权限模式)。
          </div>
          <div className="perm-actions">
            <button
              className="ghost" disabled={busy}
              title="批准这次,并且这个对话以后遇到这类强制确认都自动点允许,不再弹出"
              onClick={() => {
                if (confirm('这不是切换权限模式,而是让 AgentHub 代你自动批准 claude CLI 自身要求人工确认的操作(如 rm)——相当于关掉 Anthropic 特意保留的最后一道人工把关。之后这个对话里这类请求将不再有任何人工审核,请确保你完全信任这个任务接下来会做的所有事。确定要这样做吗?')) {
                  act('allow', undefined, undefined, 'this');
                }
              }}
            >仍然自动批准(此对话)</button>
            <button
              className="ghost" disabled={busy}
              title="批准这次,并且当前账户下所有对话(含正在运行的)以后遇到这类强制确认都自动点允许"
              onClick={() => {
                if (confirm('这不是切换权限模式,而是让 AgentHub 代你自动批准 claude CLI 自身要求人工确认的操作(如 rm)——相当于关掉 Anthropic 特意保留的最后一道人工把关,并且是账户下所有对话(含正在运行的)一起生效。之后这些对话里这类请求将不再有任何人工审核,请确保你完全信任所有正在运行的任务接下来会做的所有事。确定要这样做吗?')) {
                  act('allow', undefined, undefined, 'account');
                }
              }}
            >仍然自动批准(账户全部对话)</button>
          </div>
        </div>
      )}
    </div>
  );
}

// Sonnet/Opus-family context window — not exact per-model, but close enough
// to give an early warning before the hard "prompt too long" API failure,
// which is the whole point (see the executor's usage-tracking comment).
const CONTEXT_WINDOW_TOKENS = 200_000;

// claude CLI's own fixed wording when it refuses --permission-mode
// bypassPermissions under root/sudo (session.mjs's error surfaces this
// verbatim in last_error) — matched here to offer the two explicit recovery
// choices instead of just the generic retry button.
const ROOT_BYPASS_ERROR = '--dangerously-skip-permissions cannot be used with root/sudo';

function ContextChip({ tokens }) {
  const pct = Math.min(100, Math.round((tokens / CONTEXT_WINDOW_TOKENS) * 100));
  const level = pct >= 90 ? 'ctx-danger' : pct >= 70 ? 'ctx-warn' : 'ctx-ok';
  return (
    <span className={`chip ctx-chip ${level}`} title={`上下文约 ${tokens.toLocaleString()} / ${CONTEXT_WINDOW_TOKENS.toLocaleString()} tokens`}>
      上下文 {pct}%
    </span>
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

// Fetched lazily and shared by every pane's ModelChip so N idle chips don't
// each issue a request for identical data — but opening the picker always
// refetches: the list changes exactly when the user edits Settings, and a
// page-lifetime cache meant profiles added after load never appeared in the
// picker until a full refresh (found live).
let profilesPromise = null;
function loadProfiles({ fresh = false } = {}) {
  if (fresh || !profilesPromise) {
    profilesPromise = api.modelProfiles().catch(() => { profilesPromise = null; return { profiles: [] }; });
  }
  return profilesPromise;
}

// Shows which model this conversation currently uses; creator can click to
// switch. Like permission_mode, the model is a spawn-time env on the CLI
// child — a switch takes effect from the next turn, and the executor logs a
// visible "已切换模型" system message when it lands.
function ModelChip({ task, isCreator }) {
  const [open, setOpen] = useState(false);
  const [profiles, setProfiles] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { loadProfiles().then(r => setProfiles(r.profiles || [])); }, []);
  useEffect(() => {
    if (open) loadProfiles({ fresh: true }).then(r => setProfiles(r.profiles || []));
  }, [open]);

  const pid = task.model_profile_id || null; // '' (explicit default) -> null, same label
  const profile = pid && profiles?.find(p => p.id === pid);
  const label = !pid ? '默认模型'
    : profile ? profile.name
    : profiles ? '自定义模型' : '…';

  const pick = async (profileId) => {
    setBusy(true);
    try { await api.switchModel(task.id, profileId); setOpen(false); } catch (e) { alert(e.message); }
    setBusy(false);
  };

  return (
    <span className="model-chip-wrap">
      <span
        className={`chip model-chip${isCreator ? ' clickable' : ''}`}
        title={isCreator ? '当前模型 — 点击切换(下一轮生效)' : '当前模型'}
        onClick={isCreator ? () => setOpen(o => !o) : undefined}
      >🧠 {label}</span>
      {open && (
        <div className="model-picker">
          <button type="button" disabled={busy} className={!pid ? 'selected' : ''} onClick={() => pick(null)}>默认配置</button>
          {(profiles || []).map(p => (
            <button type="button" key={p.id} disabled={busy} className={p.id === pid ? 'selected' : ''} onClick={() => pick(p.id)}>
              {p.name}<span className="muted"> · {p.model || p.baseUrl}</span>
            </button>
          ))}
          <div className="muted model-picker-note">切换在下一轮对话生效,当前正在生成的回复不受影响</div>
        </div>
      )}
    </span>
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

function ThinkingRow({ msg }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="thinking-row">
      <button className="thinking-head" onClick={() => setOpen(!open)}>
        <span className="tool-icon">{open ? '▾' : '▸'}</span>
        <span>💭 思考过程</span>
      </button>
      {open && <div className="thinking-body">{msg.content.text}</div>}
    </div>
  );
}

// Shown while task.status === 'running' and no new message has arrived yet
// — without it, the gap between submitting a decision (or sending a message)
// and the model's next turn reads as the UI being stuck, especially since
// that gap is routinely 10-30s (found live: user submitted an AskUserQuestion
// answer, saw zero feedback for ~30s, assumed it had frozen).
function ThinkingIndicator() {
  return (
    <div className="msg-row assistant thinking-indicator">
      <div className="msg-col">
        <span className="thinking-dots" aria-label="正在生成回复">
          <span></span><span></span><span></span>
        </span>
      </div>
    </div>
  );
}

function AttachedImages({ images, onImageClick }) {
  if (!images?.length) return null;
  return (
    <div className="msg-images">
      {images.map((img, i) => {
        const src = `data:${img.mediaType};base64,${img.data}`;
        return <img key={i} className="msg-image" src={src} onClick={() => onImageClick(src)} />;
      })}
    </div>
  );
}

export function Message({ task, msg, resultByToolId, isCreator, onImageClick }) {
  switch (msg.role) {
    case 'user':
      return (
        <div className="msg-row user">
          <div className="msg-col">
            {!!msg.content.text && <Md text={msg.content.text} />}
            <AttachedImages images={msg.content.images} onImageClick={onImageClick} />
          </div>
        </div>
      );
    case 'assistant':
      return <div className="msg-row assistant"><div className="msg-col"><Md text={msg.content.text} /></div></div>;
    case 'thinking':
      return <ThinkingRow msg={msg} />;
    case 'tool_use':
      return <ToolUseRow msg={msg} result={resultByToolId.get(msg.content.id)} />;
    case 'tool_result':
      return null; // rendered inline with its tool_use
    case 'perm_request':
      return <PermCard task={task} msg={msg} isCreator={isCreator} />;
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

const messageKey = message => message.historyKey ?? message.seq;

export function ConversationMessages({ messages, task = null, isCreator = false, staticHistory = false, onImageClick = () => {} }) {
  const resultByToolId = useMemo(() => {
    const map = new Map();
    for (const message of messages) if (message.role === 'tool_result') map.set(message.content.tool_use_id, message);
    return map;
  }, [messages]);
  const groups = useMemo(() => groupForToolChains(messages), [messages]);
  return (
    <>
      {groups.map(group => group.type === 'chain'
        ? <ToolChain
            key={messageKey(group.msgs[0])} resultByToolId={resultByToolId} defaultOpen={!staticHistory && !group.done}
            toolUses={group.msgs.filter(message => message.role === 'tool_use')}
          />
        : <Message key={messageKey(group.msg)} task={task} msg={group.msg} resultByToolId={resultByToolId} isCreator={isCreator} onImageClick={onImageClick} />)}
      {!messages.length && <div className="empty">暂无消息</div>}
    </>
  );
}

export function TaskPane({ taskId, user, onClose }) {
  const task = state.tasks.get(taskId);
  // Visibility can be team-wide, but actions stay creator-only (see the
  // hub-core.mjs guard this mirrors) — falls back to true if owner_user_id
  // is somehow absent, so this never accidentally locks out the personal
  // (non-team) case a stale/incomplete task row shouldn't be able to break.
  const isCreator = !task?.owner_user_id || task.owner_user_id === user?.id;
  const messages = taskMessages(taskId);
  const [tab, setTab] = useState('chat');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [sendError, setSendError] = useState(null);
  const [attachments, setAttachments] = useState([]);
  const [dragOver, setDragOver] = useState(false);
  const [lightboxSrc, setLightboxSrc] = useState(null);
  useEffect(() => {
    if (!lightboxSrc) return;
    const onKey = e => { if (e.key === 'Escape') setLightboxSrc(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightboxSrc]);
  // Object URLs don't get cleaned up on their own — revoke whatever's still
  // pending if the pane closes/switches tasks without sending. Kept in a
  // ref (not read from `attachments` directly in the cleanup) since a
  // cleanup closure over a [taskId]-only effect would otherwise capture
  // whatever `attachments` was as of the last taskId change, not the latest.
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  useEffect(() => () => attachmentsRef.current.forEach(revoke), [taskId]);
  const [atBottom, setAtBottom] = useState(true);
  const [showSessionPicker, setShowSessionPicker] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const listRef = useRef(null);
  const loadedRef = useRef(false);
  const firstPinRef = useRef(false);
  const suppressScrollUntilRef = useRef(0);
  // Synchronous guard, separate from the `busy` state — setBusy(true) alone
  // doesn't take effect until the next render, so Enter-to-send's direct
  // send() call and the button's onSubmit-triggered send() can both pass the
  // "not busy yet" check in the same tick if they fire back-to-back (seen
  // live: a message sent right after a slow response landed twice in the
  // chat log, same text, same second — a stale-closure double-submit, not a
  // network retry). A ref updates immediately, so the second call sees it.
  const sendingRef = useRef(false);
  const fileInputRef = useRef(null);

  useEffect(() => {
    loadedRef.current = false;
    let cancelled = false;
    fetchAllMessagesSince(taskId, 0, () => cancelled)
      .catch(() => {})
      .then(() => { if (!cancelled) { loadedRef.current = true; bump(); } });
    return () => { cancelled = true; };
  }, [taskId]);

  // WS reconnected: backfill anything missed while disconnected/locked.
  // Debounced — a real mobile connection can flap (weak signal, network
  // handoff, tab backgrounding suspending the socket) several times in a
  // row, each transition toggling wsConnected and firing this effect; without
  // coalescing, that's a burst of fetch + full-app-rerender cycles, which on
  // a long history feels exactly like "loads a bit, every few seconds,
  // repeatedly" — found from a user report, not fully reproducible in this
  // sandbox's simulated throttling, but this is a real, direct mechanism for
  // it regardless of the underlying network cause.
  const wsConnected = state.wsConnected;
  useEffect(() => {
    if (!wsConnected || !loadedRef.current) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      const known = taskMessages(taskId);
      const after = known.length ? known[known.length - 1].seq : 0;
      fetchAllMessagesSince(taskId, after, () => cancelled).catch(() => {});
    }, 1500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [wsConnected, taskId]);

  // .chat-list has scroll-behavior:smooth and its rows use content-visibility
  // (heights get (re)measured as they're laid out), so a single scrollTop
  // assignment can take a few hundred ms — or longer, for a long imported
  // history — to actually settle, firing several intermediate 'scroll'
  // events along the way. onScroll reading those as "far from bottom" was
  // flipping the new-message banner on for a jump the page itself triggered.
  // Scroll events for a window after *our own* assignment (long enough to
  // cover a long animated scroll, not just a short one) are not real user
  // scrolling and must not be read as one.
  const scrollToBottom = (behavior) => {
    const el = listRef.current;
    if (!el) return;
    suppressScrollUntilRef.current = Date.now() + (behavior === 'smooth' ? 1500 : 300);
    el.scrollTo({ top: el.scrollHeight, behavior });
  };

  useEffect(() => {
    // Nothing loaded yet: skip entirely, so firstPinRef isn't consumed by
    // this trivial empty run — otherwise the *real* first load (which can be
    // hundreds of imported-history messages) loses its instant jump and
    // animates instead, which is exactly the long-distance case most likely
    // to outrun a short suppression window.
    if (!atBottom || !listRef.current || !messages.length) return;
    const behavior = firstPinRef.current ? 'smooth' : 'instant';
    firstPinRef.current = true;
    scrollToBottom(behavior);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, atBottom, tab]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    if (Date.now() < suppressScrollUntilRef.current) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
  };

  if (!taskId || !task) return null;
  const meta = STATUS_META[task.status] || { label: task.status, cls: '' };

  const addFiles = async (fileList) => {
    const files = [...fileList].filter(f => f.type.startsWith('image/'));
    if (!files.length) return;
    const room = MAX_IMAGES_PER_MESSAGE - attachments.length;
    if (room <= 0) { setSendError(`最多同时附加 ${MAX_IMAGES_PER_MESSAGE} 张图片`); return; }
    const results = await Promise.all(files.slice(0, room).map(f => addAttachment(f)));
    setAttachments(prev => [...prev, ...results]);
  };

  const removeAttachment = (id) => {
    setAttachments(prev => {
      const found = prev.find(a => a.id === id);
      if (found) revoke(found);
      return prev.filter(a => a.id !== id);
    });
  };

  const send = async (e) => {
    e?.preventDefault();
    const t = text.trim();
    if ((!t && !attachments.length) || attachments.some(a => a.error) || sendingRef.current) return;
    sendingRef.current = true;
    setBusy(true);
    setSendError(null);
    // alert() alone isn't enough here — found live: a message sent right
    // before the sender stepped away (network/device went to sleep right
    // after) failed silently, the alert had no one there to see it, and
    // there was nothing left behind to show it had failed rather than just
    // gone unanswered. This banner persists until the next attempt so
    // coming back later still shows what happened. Attachments are left
    // intact on failure too, same reasoning — nothing lost, easy to retry.
    try {
      await api.sendMessage(taskId, t, attachments.map(a => ({ mediaType: a.mediaType, data: a.data })));
      setText('');
      attachments.forEach(revoke);
      setAttachments([]);
    } catch (e2) { setSendError(e2.message || '发送失败'); }
    sendingRef.current = false;
    setBusy(false);
  };

  const startRename = () => { setTitleDraft(task.title); setEditingTitle(true); };
  const saveRename = async () => {
    setEditingTitle(false);
    const title = titleDraft.trim();
    if (!title || title === task.title) return;
    try { await api.renameTask(taskId, title); } catch (e) { alert(e.message); }
  };

  const takeover = async () => {
    if (!task.session_id) { alert('会话尚未建立(任务还没真正开始),暂时无法接管。'); return; }
    const r = await api.lease(taskId, 'human').catch(e => alert(e.message));
    if (r) alert(`已切换为 IDE 接管。\n\n在节点 ${r.nodeId} 上执行:\n  CLAUDE_CONFIG_DIR=~/agenthub/claude-config \\\n  ANTHROPIC_BASE_URL=<中转站> ANTHROPIC_API_KEY=<key> \\\n  claude --resume ${r.sessionId}\n\n(会话文件存放在 executor 的 claude-config 目录,不带 CLAUDE_CONFIG_DIR 将找不到会话。)在 IDE 里聊的内容,点「归还」时会自动同步回这里的对话记录。完成后点「归还」。`);
  };

  return (
    <div className="task-pane">
      <header className="pane-header">
        <div className="task-head">
          {isCreator && editingTitle ? (
            <input
              className="task-title-input" autoFocus value={titleDraft}
              onChange={e => setTitleDraft(e.target.value)}
              onBlur={saveRename}
              onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setEditingTitle(false); }}
            />
          ) : (
            <h2
              className={isCreator ? 'editable-title' : ''}
              onClick={isCreator ? startRename : undefined}
              title={isCreator ? '点击重命名' : undefined}
            >
              {task.title}
            </h2>
          )}
          <div className="card-meta">
            <span className={`chip ${meta.cls}`}>{meta.label}</span>
            {!isCreator && task.owner_username && <span className="chip owner-chip" title="创建者">{task.owner_username}</span>}
            {task.lease === 'human' && <span className="chip st-waiting">IDE 接管中</span>}
            <ModelChip task={task} isCreator={isCreator} />
            <span className="muted">{task.node_id}</span>
            <span className="muted">${(task.cost_usd ?? 0).toFixed(3)}</span>
            {!!task.context_tokens && <ContextChip tokens={task.context_tokens} />}
          </div>
        </div>
        <nav className="tabs">
          {[['chat', '对话'], ['diff', '变更'], ['info', '信息']].map(([k, label]) => (
            <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{label}</button>
          ))}
        </nav>
        {onClose && <button type="button" className="ghost pane-close-btn" onClick={onClose} aria-label="关闭">✕</button>}
      </header>

      {tab === 'chat' && (
        <>
          <div className="chat-list" ref={listRef} onScroll={onScroll}>
            <ConversationMessages messages={messages} task={task} isCreator={isCreator} onImageClick={setLightboxSrc} />
            {task.status === 'running' && <ThinkingIndicator />}
          </div>
          {!atBottom && (
            <button className="jump-latest" onClick={() => { setAtBottom(true); scrollToBottom('smooth'); }}>
              有新消息 ↓
            </button>
          )}
          {/* Every conversation stays immediately continuable regardless of
              status — sending a message already (re)spawns a session on its
              own (see manager.mjs's userMessage()), so the composer is never
              hidden behind a mandatory extra click. Status-specific banners
              are informational, not gates. Most of this still doesn't apply
              if you're not the creator — the backend rejects every mutating
              action except sending a message for a team member who didn't
              create the task (see hub-core.mjs's isCreator guard), so
              showing live buttons that would just 403 is worse than not
              showing them at all. Sending a message is the one exception —
              a shared conversation only a single person can talk to isn't
              much of a shared conversation. */}
          {!isCreator && (
            <div className="review-bar">
              <span>由 {task.owner_username || '其他成员'} 创建 — 你可以直接对话,但取消/重试/改名/归档等操作仅创建者可用</span>
            </div>
          )}
          {isCreator && task.status === 'failed' && (
            <div className="review-bar">
              <span>❌ 上次失败{task.last_error ? `:${task.last_error}` : ''} — 直接发消息会自动重试</span>
              <button onClick={() => api.retryTask(taskId).catch(e => alert(e.message))}>🔁 重试</button>
            </div>
          )}
          {isCreator && task.status === 'failed' && task.last_error?.includes(ROOT_BYPASS_ERROR) && (
            <div className="review-bar">
              <span>这台节点以 root 身份运行,claude CLI 拒绝在 root 下使用"完全自主"权限模式(bypassPermissions)</span>
              <div className="review-bar-actions">
                <button
                  title="改用 default 权限模式重试 — CLI 不再需要被拒绝的那个标志,但之后的工具调用会需要你审批"
                  onClick={() => api.retryTask(taskId, { permissionMode: 'default' }).catch(e => alert(e.message))}
                >降级权限模式重试</button>
                <button
                  title="设置 IS_SANDBOX 环境变量绕过 root 检查 — 这是 Anthropic 自己的沙箱工具链在用的未公开逃生舱口,不会真的隔离这台机器"
                  onClick={() => {
                    if (confirm('IS_SANDBOX 只是让 claude CLI 跳过它自己的 root 安全检查,并不会真的把这台机器隔离起来——如果这台节点不是一次性/可丢弃的沙箱环境,不建议开启。确定要继续,让这个对话以后都在 root + 完全自主模式下运行吗?')) {
                      api.retryTask(taskId, { allowRootBypass: true }).catch(e => alert(e.message));
                    }
                  }}
                >确认沙箱环境并继续</button>
              </div>
            </div>
          )}
          {isCreator && task.status === 'idle' && task.lease === 'daemon' && (
            <div className="review-bar">
              <span>此会话可能在看板之外继续过(如终端里的 --resume)</span>
              <button onClick={() => api.resyncSession(taskId).catch(e => alert(e.message))}>🔄 刷新历史</button>
            </div>
          )}
          {sendError && (
            <div className="review-bar">
              <span className="err">⚠️ 上一条消息发送失败:{sendError} — 消息还在输入框里,可以重试</span>
              <button className="ghost" onClick={() => setSendError(null)}>知道了</button>
            </div>
          )}
          <form
            className={`composer${dragOver ? ' drag-over' : ''}`} onSubmit={send}
            onDragOver={e => { e.preventDefault(); if (task.lease !== 'human') setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={e => { e.preventDefault(); setDragOver(false); if (task.lease !== 'human') addFiles(e.dataTransfer.files); }}
          >
            {!!attachments.length && (
              <div className="composer-attachments">
                {attachments.map(a => (
                  <div key={a.id} className={`attachment-thumb${a.error ? ' error' : ''}`} title={a.error || a.name}>
                    {a.previewUrl ? <img src={a.previewUrl} alt={a.name} /> : <span className="attachment-err-icon">⚠️</span>}
                    <button type="button" className="remove" onClick={() => removeAttachment(a.id)} aria-label="移除图片">✕</button>
                  </div>
                ))}
              </div>
            )}
            <div className="composer-row">
              <input
                type="file" accept="image/*" multiple ref={fileInputRef} style={{ display: 'none' }}
                onChange={e => { addFiles(e.target.files); e.target.value = ''; }}
              />
              <button
                type="button" className="ghost attach-btn" title="添加图片" disabled={task.lease === 'human' || busy}
                onClick={() => fileInputRef.current?.click()}
              >📎</button>
              <textarea
                value={text} onChange={e => setText(e.target.value)} rows={2}
                placeholder={task.lease === 'human' ? 'IDE 接管中,看板只读' : '发消息继续对话…(Enter 发送,Shift+Enter 换行,可直接粘贴/拖拽图片)'}
                disabled={task.lease === 'human' || busy}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}
                onPaste={e => {
                  const files = [...(e.clipboardData?.items || [])]
                    .filter(i => i.kind === 'file' && i.type.startsWith('image/'))
                    .map(i => i.getAsFile()).filter(Boolean);
                  if (files.length) { e.preventDefault(); addFiles(files); }
                }}
              />
              <button disabled={busy || task.lease === 'human' || (!text.trim() && !attachments.length) || attachments.some(a => a.error)}>发送</button>
            </div>
          </form>
          {lightboxSrc && (
            <div className="lightbox-backdrop" onClick={() => setLightboxSrc(null)}>
              <img className="lightbox-img" src={lightboxSrc} onClick={e => e.stopPropagation()} />
            </div>
          )}
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
            <dt>分支</dt><dd>{task.branch_name || `task/${task.id}`} ← {task.base_branch || '(自动识别)'}</dd>
            <dt>权限模式</dt><dd>{task.permission_mode}{task.permission_mode === 'bypassPermissions' && ' ⚠️'}</dd>
            <dt>当前模型</dt><dd><ModelChip task={task} isCreator={isCreator} /></dd>
            {!!task.auto_decide_all && (
              <><dt>强制确认自动批准</dt><dd className="err">已开启 ⚠️ — 包括 claude CLI 自身要求人工确认的操作(如 rm)</dd></>
            )}
            <dt>成本(参考)</dt><dd>${(task.cost_usd ?? 0).toFixed(4)}</dd>
            <dt>创建于</dt><dd>{new Date(task.created_at).toLocaleString()}</dd>
            {task.last_error && <><dt>最近错误</dt><dd className="err">{task.last_error}</dd></>}
          </dl>
          {!isCreator && <p className="muted">只读 — 由 {task.owner_username || '其他成员'} 创建,以下操作仅创建者可用。</p>}
          <div className="info-actions">
            {isCreator && (task.lease === 'daemon'
              ? <button onClick={takeover}>⌨️ 在 IDE 中接管</button>
              : <button onClick={() => api.lease(taskId, 'daemon').catch(e => alert(e.message))}>↩️ 归还给看板</button>)}
            {isCreator && task.repo_url && !['starting', 'running', 'waiting_human'].includes(task.status) &&
              <button className="ghost" onClick={() => setShowSessionPicker(true)}>🔀 切换会话</button>}
            {isCreator && !['done', 'failed', 'cancelled'].includes(task.status) &&
              <button className="deny" onClick={() => confirm('确认取消任务?') && api.cancel(taskId).catch(e => alert(e.message))}>✕ 取消任务</button>}
          </div>
          <div className="spec-box">
            <h4>任务描述</h4>
            <Md text={task.spec} />
          </div>
        </div>
      )}

      {showSessionPicker && (
        <SessionPicker
          nodeId={task.node_id} path={task.repo_url}
          onPick={(sessionId) => {
            setShowSessionPicker(false);
            api.switchSession(taskId, sessionId).catch(e => alert(e.message));
          }}
          onClose={() => setShowSessionPicker(false)}
        />
      )}
    </div>
  );
}
