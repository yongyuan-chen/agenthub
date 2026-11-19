import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';
import {
  state, taskMessages, addMessage, setMessageWindow, bump, taskPendingMessages, setPendingMessages, upsertPendingMessage,
  isTaskUnread, setTaskSeen, resetMessages, messageLoadGuard, acceptMessageResetSeq,
} from './store.js';
import { renderMarkdown } from './md.js';
import { STATUS_META } from './board.jsx';
import { fmtAge, fmtDuration } from './format.js';
import { RUNNING_STATUSES, useElapsed } from './elapsed.js';
import { SessionPicker } from './sessionpicker.jsx';
import { SubagentPanel } from './subagents.jsx';
import { SPAWN_TOOL_NAMES, CONTINUE_TOOL_NAME, isSubagentInternal } from './subagent-tree.js';
import { useAttachments, AttachmentStrip, AttachButton, imageFilesFromPaste } from './composer.jsx';

export function Md({ text }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

// Identifies one send end-to-end (browser -> cloud row -> node event -> back).
// Must match the server's accepted shape (see isValidClientMessageId):
// URL-safe, <= 64 chars. randomUUID isn't available on every mobile browser
// in a non-secure context, hence the fallback.
function newClientMessageId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

// How much of a conversation is on screen when you open it, and how much one
// scroll-up adds. Opening used to fetch and render the entire log: a long
// autonomous run is thousands of messages, so the pane spent seconds
// downloading (and the browser laying out) history nobody asked to see just to
// show the last exchange. Everything older is still there, one scroll away.
const TAIL_PAGE = 60;
// One scroll-up keeps paging until it reaches an earlier message of yours: in
// an agent run a 60-row page can be nothing but tool calls that collapse into
// a single line, so a fixed page size read as "clicked, nothing happened".
const OLDER_PAGE = 500;
// Upper bound for one walk back, so a turn with tens of thousands of tool calls
// stops (and offers the button again) instead of downloading the whole log.
const OLDER_MAX = 2000;
const isRootUserMessage = m => m.role === 'user' && !isSubagentInternal(m);
// Distance from the top at which the next older page starts loading, so it is
// usually already there by the time the user scrolls into it.
const LOAD_OLDER_AT = 400;
// How long a jump to the bottom keeps re-asserting itself while the rows below
// are still growing into their real heights — see scrollToBottom. Long enough
// to outlast content-visibility laying out a tall history plus its inline
// images decoding, short enough that a reader who changes their mind is not
// held for a noticeable time (and a deliberate scroll cancels it outright).
const PIN_SETTLE_MS = 1200;

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
    if (isCancelled() || !acceptMessageResetSeq(taskId, r.resetSeq)) return;
    if (r.messages.length) {
      for (const m of r.messages) addMessage(taskId, m);
      bump();
      cursor = r.messages[r.messages.length - 1].seq;
    }
    if (r.messages.length < 1000) {
      // Server-authoritative on the last page only: earlier pages are a
      // snapshot of the same list, and applying one of those would briefly
      // resurrect bubbles that later pages have already seen delivered.
      // Sends still in flight are part of the conversation's state, so they
      // have to survive a reload/second device exactly like stored messages.
      setPendingMessages(taskId, r.pending);
      bump();
      return; // caught up to the current tail
    }
  }
}

function toolSummary(name, input) {
  if (!input) return name;
  // A subagent spawn: its description is the name it goes by in the 子代理 tab.
  if (SPAWN_TOOL_NAMES.has(name) && input.description) {
    return input.subagent_type ? `${input.subagent_type} · ${input.description}` : input.description;
  }
  // Work handed back to an existing subagent.
  if (name === CONTINUE_TOOL_NAME && input.to) return `→ ${input.to} · ${input.summary || String(input.message || '').slice(0, 100)}`;
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

export function ToolUseRow({ msg, result }) {
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
  // A decision this browser has already submitted successfully. The task row
  // doesn't clear pending_request until the node has actually applied it and
  // reported back, so between the HTTP response and that broadcast the card
  // still looks undecided — the buttons went dark on click and then lit back
  // up before finally settling on 已处理 (reported live, and it reads like
  // the click didn't take). Once the cloud has accepted the decision it is
  // durable (dispatch falls back to pending_cmds for an offline node), so
  // there is nothing left for the human to do here either way.
  const [submitted, setSubmitted] = useState(false);
  // Deciding is a mutating action — creator-only, same as every other
  // action, even though the request card itself is visible to the whole team.
  const isActive = pending?.requestId === requestId && task.status === 'waiting_human' && isCreator && !submitted;
  const [busy, setBusy] = useState(false);
  const act = async (behavior, updatedInput, autoApprove, forceAll) => {
    setBusy(true);
    try {
      await api.decision(task.id, requestId, behavior, undefined, updatedInput, autoApprove, forceAll);
      setSubmitted(true);
    } catch (e) {
      // A decision that never reached the cloud is the one case where the
      // buttons must come back — nothing was recorded, so this is a retry.
      alert(e.message);
    }
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
            这类操作(常见于包含 rm 的命令)是 agent CLI 自身强制要求人工确认的安全底线,
            任何权限模式都无法跳过。可以继续手动点允许/拒绝,或者让 AgentHub 代你自动点允许
            (这会彻底关掉这道人工把关,不只是切换权限模式)。
          </div>
          <div className="perm-actions">
            <button
              className="ghost" disabled={busy}
              title="批准这次,并且这个对话以后遇到这类强制确认都自动点允许,不再弹出"
              onClick={() => {
                if (confirm('这不是切换权限模式,而是让 AgentHub 代你自动批准 agent CLI 自身要求人工确认的操作(如 rm)——相当于关掉 agent 特意保留的最后一道人工把关。之后这个对话里这类请求将不再有任何人工审核,请确保你完全信任这个任务接下来会做的所有事。确定要这样做吗?')) {
                  act('allow', undefined, undefined, 'this');
                }
              }}
            >仍然自动批准(此对话)</button>
            <button
              className="ghost" disabled={busy}
              title="批准这次,并且当前账户下所有对话(含正在运行的)以后遇到这类强制确认都自动点允许"
              onClick={() => {
                if (confirm('这不是切换权限模式,而是让 AgentHub 代你自动批准 agent CLI 自身要求人工确认的操作(如 rm)——相当于关掉 agent 特意保留的最后一道人工把关,并且是账户下所有对话(含正在运行的)一起生效。之后这些对话里这类请求将不再有任何人工审核,请确保你完全信任所有正在运行的任务接下来会做的所有事。确定要这样做吗?')) {
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
  const hasCost = Number.isFinite(c.turn_cost_usd) && Number.isFinite(c.total_cost_usd);
  return (
    <div className="result-card">
      <span>{c.is_error ? '❌' : '🏁'} 本轮结束</span>
      <span className="muted">
        {fmtDuration(c.duration_ms)} · {c.num_turns} turns
        {hasCost && <> · 本轮 ${c.turn_cost_usd.toFixed(3)} · 累计 ${c.total_cost_usd.toFixed(3)}(参考成本)</>}
      </span>
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

  // A profile now pins the agent CLI as well as the relay, and a session id
  // means nothing to a different CLI — the server refuses such a switch with a
  // 409, so don't offer it. Only once a session exists: before the first spawn
  // there's nothing to be incompatible with.
  const backend = task.backend || (profile ? (profile.backend || 'claude') : 'claude');
  const locked = !!task.session_id;
  // Multiagent conversations are claude-only regardless (no subagents in
  // Codex) — the server 409s the switch, so it isn't offered either.
  const multiAgent = task.agent_mode === 'multi';
  const compatible = (b) => (!multiAgent || (b || 'claude') === 'claude') && (!locked || (b || 'claude') === backend);
  // A session that ran against a relay lives in AgentHub's isolated home and
  // can't move into ~/.claude for 「本机账号」 (the server 409s it too).
  const nativeLocked = locked && profile?.kind !== 'native';
  const offered = (p) => compatible(p.backend) && !(nativeLocked && p.kind === 'native');

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
      >🧠 {label}{backend === 'codex' ? ' · Codex' : ''}{profile?.kind === 'native' ? ' · 本机账号' : ''}</span>
      {open && (
        <div className="model-picker">
          {compatible('claude') && <button type="button" disabled={busy} className={!pid ? 'selected' : ''} onClick={() => pick(null)}>默认配置</button>}
          {(profiles || []).filter(offered).map(p => (
            <button type="button" key={p.id} disabled={busy} className={p.id === pid ? 'selected' : ''} onClick={() => pick(p.id)}>
              {p.name}<span className="muted"> · {p.model || (p.kind === 'native' ? '本机账号' : p.baseUrl)}</span>
            </button>
          ))}
          <div className="muted model-picker-note">
            切换在下一轮对话生效,当前正在生成的回复不受影响
            {locked && <>{'　'}只列出了 {backend === 'codex' ? 'Codex' : 'Claude Code'} 档案:会话 ID 不能跨 agent 复用,换 agent 请新建一张卡。</>}
          </div>
        </div>
      )}
    </span>
  );
}

// The diff is read off the newest 'diff' message, which a turn emits after it
// ends — so it normally sits in the loaded tail of the conversation. hasOlder
// covers the case where it doesn't: say so instead of claiming there are no
// changes at all.
function DiffView({ messages, hasOlder = false, onLoadOlder = null }) {
  const diffMsg = [...messages].reverse().find(m => m.role === 'diff');
  const patch = diffMsg?.content?.patch;
  const files = useMemo(() => splitPatch(patch), [patch]);
  if (!diffMsg && hasOlder) {
    return (
      <div className="empty">
        已加载的这段对话里没有 diff — 更早的历史还没加载
        {onLoadOlder && <> · <button type="button" className="ghost" onClick={onLoadOlder}>加载更早消息</button></>}
      </div>
    );
  }
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
// The elapsed time is repeated here, at the bottom of the conversation, and
// not only in the header chip: while a turn is running this is where the eye
// already is, and "is it stuck or just slow" is a question you ask staring at
// the dots, not at the top of the page.
function ThinkingIndicator({ elapsed }) {
  return (
    <div className="msg-row assistant thinking-indicator">
      <div className="msg-col">
        <span className="thinking-dots" aria-label="正在生成回复">
          <span></span><span></span><span></span>
        </span>
        {elapsed !== null && <span className="muted run-timer thinking-elapsed">{fmtDuration(elapsed)}</span>}
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

// A send that's been stored by the cloud but not yet echoed back by the node.
// Rendering it (instead of nothing) is the whole point: the text the user
// typed stays visible and attributable while it's in flight, and a delivery
// that ultimately fails becomes a button rather than a silent disappearance.
function PendingMessage({ pending, canRetry, onRetry, onImageClick }) {
  const failed = pending.state === 'failed';
  return (
    <div className={`msg-row user pending-msg${failed ? ' failed' : ''}`}>
      <div className="msg-col">
        {!!pending.text && <Md text={pending.text} />}
        <AttachedImages images={pending.images} onImageClick={onImageClick} />
        <div className="pending-msg-note muted">
          {failed
            ? '⚠️ 这条消息一直没能送到节点(节点长时间离线)。消息没有丢,可以重发。'
            : '⏳ 已保存,正在等待节点接收…'}
          {failed && canRetry && (
            <button type="button" className="ghost" onClick={() => onRetry(pending.clientMessageId)}>重发</button>
          )}
        </div>
      </div>
    </div>
  );
}

// A message the user sent while a turn was still running. It is real and
// durable (a row in outbound_messages) but has not been handed to the agent
// yet, which is the entire point: until the turn ends it can still be
// rewritten or taken back.
function QueuedMessage({ pending, canEdit, waitingDecision, onEdit, onCancel, onSendNow }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(pending.text || '');
  const [menuOpen, setMenuOpen] = useState(false);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (!next || next === pending.text) { setDraft(pending.text || ''); return; }
    onEdit(pending.clientMessageId, next);
  };

  return (
    <div className="queued-msg">
      <div className="queued-msg-head">
        <span className="queued-msg-badge">排队中</span>
        {editing ? (
          <textarea
            className="queued-msg-input" autoFocus rows={2} value={draft}
            onChange={e => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.blur(); }
              if (e.key === 'Escape') { setDraft(pending.text || ''); setEditing(false); }
            }}
          />
        ) : (
          <span className="queued-msg-text" title={pending.text}>{pending.text}</span>
        )}
        {canEdit && !editing && (
          <span className="queued-msg-actions">
            <button
              type="button" className="queued-msg-send" title="不等这个回合结束,现在就发给 agent"
              onClick={() => onSendNow(pending.clientMessageId)}
            >直接发送</button>
            <button type="button" className="ghost" title="取消这条" onClick={() => onCancel(pending.clientMessageId)}>取消</button>
            <button type="button" className="ghost" onClick={() => setMenuOpen(v => !v)} aria-label="更多">⋯</button>
            {menuOpen && (
              <span className="queued-msg-menu">
                <button type="button" className="ghost" onClick={() => { setMenuOpen(false); setDraft(pending.text || ''); setEditing(true); }}>编辑消息</button>
              </span>
            )}
          </span>
        )}
      </div>
      <div className="muted queued-msg-note">
        {waitingDecision
          ? '等你决定上面的权限请求、这一轮跑完后自动发送'
          : '当前回合结束后自动发送'}
      </div>
    </div>
  );
}

// Hover-revealed toolbar under an assistant reply. Only ever one action so
// far; it lives in its own component for the busy state, since forking a big
// transcript on the node takes a visible moment.
function MessageActions({ onBranch }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="msg-actions">
      <button
        type="button" className="ghost" disabled={busy}
        title="以这条回复为止的上下文开一个新对话,原对话保持不变"
        onClick={async () => { setBusy(true); try { await onBranch(); } finally { setBusy(false); } }}
      >{busy ? '分支中…' : '⑂ 分支到新对话'}</button>
    </div>
  );
}

async function branchFrom(taskId, seq) {
  try {
    const r = await api.branchTask(taskId, seq);
    // Warnings are advisory, not failures (shared working directory, a branch
    // point the node cut slightly differently) — say them once, then go.
    if (r.warnings?.length) alert(r.warnings.join('\n\n'));
    location.hash = '#/task/' + r.task.id;
  } catch (e) { alert(e.message); }
}

export function Message({ task, msg, resultByToolId, isCreator, onImageClick, canBranch = false, onEdit }) {
  switch (msg.role) {
    case 'user':
      return (
        <div className="msg-row user" onDoubleClick={onEdit ? () => onEdit(msg) : undefined}>
          <div className="msg-col">
            {!!msg.content.text && <Md text={msg.content.text} />}
            <AttachedImages images={msg.content.images} onImageClick={onImageClick} />
            {onEdit && <div className="msg-actions user-edit-actions">
              <button type="button" className="ghost" aria-label="编辑最后一条用户消息" onClick={() => onEdit(msg)}>编辑</button>
            </div>}
          </div>
        </div>
      );
    case 'assistant':
      return (
        <div className="msg-row assistant">
          <div className="msg-col">
            <Md text={msg.content.text} />
            {canBranch && msg.seq && <MessageActions onBranch={() => branchFrom(task.id, msg.seq)} />}
          </div>
        </div>
      );
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

export function ConversationMessages({ messages: allMessages, task = null, isCreator = false, staticHistory = false, onImageClick = () => {}, hideEmpty = false, onEdit, userId }) {
  // Subagent lifecycle is never chat content; in a multiagent conversation
  // neither is what the subagents say and do — that's the 子代理 tab's, and
  // left in it would break the orchestrator's own tool chains into pieces.
  const multiAgent = task?.agent_mode === 'multi';
  const messages = useMemo(
    () => allMessages.filter(m => m.role !== 'agent_event' && !(multiAgent && isSubagentInternal(m))),
    [allMessages, multiAgent],
  );
  const resultByToolId = useMemo(() => {
    const map = new Map();
    for (const message of messages) if (message.role === 'tool_result') map.set(message.content.tool_use_id, message);
    return map;
  }, [messages]);
  const groups = useMemo(() => groupForToolChains(messages), [messages]);
  // Branching needs a live task to fork from and creator rights to do it; the
  // read-only history viewer reuses this component and has neither.
  const canBranch = !!task && !staticHistory && isCreator;
  const latestUser = [...allMessages].reverse().find(m => m.role === 'user' && !isSubagentInternal(m));
  const editableSeq = canBranch && task.lease !== 'human' && onEdit
    && (!latestUser?.content?.senderUserId || latestUser.content.senderUserId === userId) ? latestUser?.seq : null;
  return (
    <>
      {groups.map(group => group.type === 'chain'
        ? <ToolChain
            key={messageKey(group.msgs[0])} resultByToolId={resultByToolId} defaultOpen={!staticHistory && !group.done}
            toolUses={group.msgs.filter(message => message.role === 'tool_use')}
          />
        : <Message key={messageKey(group.msg)} task={task} msg={group.msg} resultByToolId={resultByToolId} isCreator={isCreator} onImageClick={onImageClick} canBranch={canBranch} onEdit={group.msg.seq != null && group.msg.seq === editableSeq ? onEdit : undefined} />)}
      {!messages.length && !hideEmpty && <div className="empty">暂无消息</div>}
    </>
  );
}

export function TaskPane({ taskId, user, onClose, onOpenFiles, maximized, onToggleMaximize }) {
  const task = state.tasks.get(taskId);
  // Visibility can be team-wide, but actions stay creator-only (see the
  // hub-core.mjs guard this mirrors) — falls back to true if owner_user_id
  // is somehow absent, so this never accidentally locks out the personal
  // (non-team) case a stale/incomplete task row shouldn't be able to break.
  const isCreator = !task?.owner_user_id || task.owner_user_id === user?.id;
  const messages = taskMessages(taskId);
  const pendingMessages = taskPendingMessages(taskId);
  // Held-for-this-turn messages are shown as an editable strip above the
  // composer, not as conversation bubbles — they aren't part of the
  // transcript yet, and rendering them inline implies the agent has seen them.
  const queuedMessages = pendingMessages.filter(p => p.state === 'queued');
  const inFlightMessages = pendingMessages.filter(p => p.state !== 'queued');
  const [tab, setTab] = useState('chat');
  // Queueing is on by default. Turning it off is a per-conversation choice
  // about how *this* agent should be interrupted, so it lives next to the
  // composer and persists locally rather than becoming an account setting.
  const [queueEnabled, setQueueEnabled] = useState(
    () => localStorage.getItem(`agenthub_queue_off_${taskId}`) !== '1',
  );
  const setQueue = (on) => {
    setQueueEnabled(on);
    if (on) localStorage.removeItem(`agenthub_queue_off_${taskId}`);
    else localStorage.setItem(`agenthub_queue_off_${taskId}`, '1');
  };
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [editingMessage, setEditingMessage] = useState(null);
  const composerRef = useRef(null);
  const sendRequestRef = useRef(null);
  const stoppingRef = useRef(false);
  // Held messages don't count: they're waiting on the agent, not running, and
  // sending more while a turn runs is exactly what the queue is for.
  const stopMode = busy || ['running', 'starting', 'waiting_human'].includes(task?.status)
    || pendingMessages.some(p => p.state !== 'failed' && p.state !== 'queued');
  const messageEpoch = state.messageEpochs[taskId] || 0;
  const [sendError, setSendError] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [lightboxSrc, setLightboxSrc] = useState(null);
  useEffect(() => {
    if (!lightboxSrc) return;
    const onKey = e => { if (e.key === 'Escape') setLightboxSrc(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightboxSrc]);
  const { attachments, addFiles, removeAttachment, clearAttachments, wireImages, hasError: attachmentError }
    = useAttachments(taskId, setSendError);
  const [atBottom, setAtBottom] = useState(true);
  const [showSessionPicker, setShowSessionPicker] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Rows fetched by the walk in progress (progress bar), and the last walk's failure.
  const [olderLoaded, setOlderLoaded] = useState(0);
  const [olderError, setOlderError] = useState(null);
  const listRef = useRef(null);
  const loadedRef = useRef(false);
  const firstPinRef = useRef(false);
  const suppressScrollUntilRef = useRef(0);
  const loadingOlderRef = useRef(false);
  // Pending frame of the settle loop that holds the list at the bottom.
  const pinFrameRef = useRef(0);
  // Bumped on every task switch so a page that lands after the pane moved on
  // can't push another conversation's messages into this one.
  const loadGenerationRef = useRef(0);
  // Scroll position captured just before an older page is prepended.
  const preserveRef = useRef(null);
  // See onScroll: one auto-load per approach to the top of the list.
  const autoLoadArmedRef = useRef(true);
  // Synchronous guard, separate from the `busy` state — setBusy(true) alone
  // doesn't take effect until the next render, so Enter-to-send's direct
  // send() call and the button's onSubmit-triggered send() can both pass the
  // "not busy yet" check in the same tick if they fire back-to-back (seen
  // live: a message sent right after a slow response landed twice in the
  // chat log, same text, same second — a stale-closure double-submit, not a
  // network retry). A ref updates immediately, so the second call sees it.
  const sendingRef = useRef(false);
  const elapsed = useElapsed(task?.run_started_at, RUNNING_STATUSES.has(task?.status));

  // "看到了" = this conversation is open in a pane and the tab is actually in
  // front. Re-runs on every new attention_at, so a turn that finishes while
  // you're watching never flashes a dot, and one that finished while the tab
  // was in the background clears the moment you come back to it. Failures are
  // ignored on purpose: an unread dot that outlives one flaky request is
  // self-correcting (the next visit re-tries), and there is nothing useful to
  // tell the user about it.
  const attentionAt = task?.attention_at ?? null;
  useEffect(() => {
    if (!attentionAt || !isTaskUnread({ id: taskId, attention_at: attentionAt })) return undefined;
    let cancelled = false;
    const mark = () => {
      if (cancelled || document.hidden) return;
      api.markTaskSeen(taskId)
        .then(r => { if (!cancelled && setTaskSeen(taskId, r.seenAt)) bump(); })
        .catch(() => {});
    };
    mark();
    document.addEventListener('visibilitychange', mark);
    return () => { cancelled = true; document.removeEventListener('visibilitychange', mark); };
  }, [taskId, attentionAt]);

  // Opening loads the newest page only; loadOlder walks up from there.
  useEffect(() => {
    loadedRef.current = false;
    loadGenerationRef.current++;
    let cancelled = false;
    const isCurrent = messageLoadGuard(taskId);
    setHasOlder(false);
    setLoadingOlder(false);
    setOlderLoaded(0);
    setOlderError(null);
    loadingOlderRef.current = false;
    preserveRef.current = null;
    const generation = loadGenerationRef.current;
    api.messagesBefore(taskId, 0, TAIL_PAGE)
      .then(r => {
        if (cancelled || !isCurrent() || !acceptMessageResetSeq(taskId, r.resetSeq)) return;
        setMessageWindow(taskId, r.messages);
        setPendingMessages(taskId, r.pending);
        setHasOlder(!!r.hasMore);
        // The tail is mid-turn (no message of yours in it): keep going back
        // until the command that started this turn is on screen too.
        if (r.hasMore && r.messages.length && !r.messages.some(isRootUserMessage)) {
          queueMicrotask(() => walkBack(generation, isCurrent));
        }
      })
      .catch(() => {})
      .then(() => { if (!cancelled && isCurrent()) { loadedRef.current = true; bump(); } });
    return () => { cancelled = true; };
  }, [taskId, messageEpoch]);

  // The row the reader is actually looking at — the first one reaching into the
  // viewport — so the layout effect below can put it back where it was after a
  // page is prepended above it. Deliberately an *element* rather than a
  // scrollHeight delta: .chat-list rows use content-visibility, so off-screen
  // rows report an estimated height and the total can even shrink as rows are
  // added. Measuring one on-screen node, whose real height is known both
  // before and after, is exact. The "加载更早消息" row is skipped because it
  // stays above the new messages and would report no movement at all — which,
  // when the reader is at the very top, left them still at the very top and
  // cascaded into loading the entire history one scroll at a time.
  const captureScrollAnchor = () => {
    const el = listRef.current;
    if (!el) return null;
    const top = el.getBoundingClientRect().top;
    const node = [...el.children]
      .filter(child => !child.classList.contains('history-page-actions'))
      .find(child => child.getBoundingClientRect().bottom > top + 1);
    return node ? { node, offset: node.getBoundingClientRect().top - top } : null;
  };

  // Scrolling up (or the button at the top of the list) walks back until it
  // has loaded an earlier message of yours (or OLDER_MAX rows, or the start).
  const walkBack = async (generation, isCurrent) => {
    if (loadingOlderRef.current) return;
    const live = () => generation === loadGenerationRef.current && isCurrent();
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    setOlderLoaded(0);
    setOlderError(null);
    let loaded = 0;
    try {
      for (;;) {
        const known = taskMessages(taskId);
        if (!known.length) break;
        const r = await api.messagesBefore(taskId, known[0].seq, OLDER_PAGE);
        if (!live() || !acceptMessageResetSeq(taskId, r.resetSeq)) return;
        // Captured per page, right before the prepend it has to compensate for.
        preserveRef.current = captureScrollAnchor();
        for (const m of r.messages) addMessage(taskId, m);
        loaded += r.messages.length;
        setHasOlder(!!r.hasMore);
        setOlderLoaded(loaded);
        bump();
        if (!r.hasMore || !r.messages.length || r.messages.some(isRootUserMessage) || loaded >= OLDER_MAX) break;
      }
    } catch (e) {
      if (live()) {
        preserveRef.current = null;
        setOlderError(e?.message || '网络错误');
      }
    } finally {
      if (live()) {
        loadingOlderRef.current = false;
        setLoadingOlder(false);
      }
    }
  };
  const loadOlder = () => {
    if (!hasOlder) return;
    walkBack(loadGenerationRef.current, messageLoadGuard(taskId));
  };

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
    const isCurrent = messageLoadGuard(taskId);
    const timer = setTimeout(() => {
      if (!isCurrent()) return;
      const known = taskMessages(taskId);
      const after = known.length ? known[known.length - 1].seq : 0;
      fetchAllMessagesSince(taskId, after, () => cancelled || !isCurrent()).catch(() => {});
    }, 1500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [wsConnected, taskId, messageEpoch]);

  const cancelPin = () => {
    if (!pinFrameRef.current) return;
    cancelAnimationFrame(pinFrameRef.current);
    pinFrameRef.current = 0;
  };
  useEffect(() => cancelPin, []);

  // Going to the bottom can't be a single assignment. .chat-list rows use
  // content-visibility, so an off-screen row reports contain-intrinsic-size's
  // fallback height rather than its real one until the browser lays it out —
  // and on a freshly mounted pane not one of them has a remembered size to
  // fall back to instead. Switching projects swaps the whole pane set, so
  // coming back to a conversation is always that fresh mount: scrollHeight
  // right then is a large under-estimate, jumping to it strands the reader
  // mid-history, the rows below grow to their real heights, and since
  // scrollTop itself never moved, no scroll event ever fires to notice. So
  // hold the bottom across the frames it takes for the heights to settle
  // (which covers rows that grow late for other reasons too — inline images
  // decoding, fonts), re-issuing the scroll only when the height actually
  // changed: re-targeting a smooth scroll mid-flight is fine, but re-issuing
  // it every frame would fight the animation it just started.
  const scrollToBottom = (behavior) => {
    if (!listRef.current) return;
    cancelPin();
    const until = Date.now() + PIN_SETTLE_MS;
    let lastHeight = -1;
    const step = () => {
      pinFrameRef.current = 0;
      const el = listRef.current;
      if (!el) return;
      if (el.scrollHeight !== lastHeight) {
        lastHeight = el.scrollHeight;
        // .chat-list has scroll-behavior:smooth and rows still being
        // measured, so one assignment takes a few hundred ms — or longer, for
        // a long imported history — to actually settle, firing several
        // intermediate 'scroll' events along the way. onScroll reading those
        // as "far from bottom" was flipping the new-message banner on for a
        // jump the page itself triggered. Scroll events for a window after
        // *our own* assignment (long enough to cover a long animated scroll,
        // not just a short one) are not real user scrolling and must not be
        // read as one.
        suppressScrollUntilRef.current = Date.now() + (behavior === 'smooth' ? 1500 : 300);
        el.scrollTo({ top: lastHeight, behavior });
      }
      if (Date.now() < until) pinFrameRef.current = requestAnimationFrame(step);
    };
    step(); // first pass synchronous — the jump itself must not wait a frame
  };

  // Puts the viewport back on the message the reader was looking at after an
  // older page is prepended above it. Runs before the pin-to-bottom effect
  // below (layout effects go first), which skips anyway: you can only be
  // loading older messages while scrolled away from the bottom.
  useLayoutEffect(() => {
    const preserve = preserveRef.current;
    const el = listRef.current;
    if (!preserve || !el) return;
    preserveRef.current = null;
    if (!preserve.node.isConnected) return; // the anchor row is gone (task switched, window dropped)
    const moved = (preserve.node.getBoundingClientRect().top - el.getBoundingClientRect().top) - preserve.offset;
    if (!moved) return;
    // A page prepended above changes the height, which is exactly what a
    // still-running settle loop reads as "keep chasing the bottom" — and
    // being at the bottom is not where someone loading older messages wants
    // to be put.
    cancelPin();
    // 'instant' overrides .chat-list's scroll-behavior:smooth — the point is
    // to stay where we already were, not to animate a jump there.
    suppressScrollUntilRef.current = Date.now() + 300;
    el.scrollTo({ top: el.scrollTop + moved, behavior: 'instant' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length]);

  useEffect(() => {
    // Nothing loaded yet: skip entirely, so firstPinRef isn't consumed by
    // this trivial empty run — otherwise the *real* first load (which can be
    // hundreds of imported-history messages) loses its instant jump and
    // animates instead, which is exactly the long-distance case most likely
    // to outrun a short suppression window.
    if (!atBottom || !listRef.current || !(messages.length + pendingMessages.length)) return;
    const behavior = firstPinRef.current ? 'smooth' : 'instant';
    firstPinRef.current = true;
    scrollToBottom(behavior);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, pendingMessages.length, atBottom, tab]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    if (Date.now() < suppressScrollUntilRef.current) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
    // Checked after the suppression window on purpose: the intermediate events
    // of our own smooth jump to the bottom start out near the top, and reading
    // those as "the user scrolled up" would fetch history nobody asked for.
    //
    // One page per approach to the top, re-armed by scrolling back away from
    // it. A single scroll gesture is a long stream of events, and .chat-list
    // scrolls smoothly, so "load whenever we're near the top" fires dozens of
    // times over one animation — measured in a browser: one scroll-to-top
    // pulled five pages, i.e. most of the history the paging exists to avoid.
    if (el.scrollTop > LOAD_OLDER_AT) autoLoadArmedRef.current = true;
    else if (autoLoadArmedRef.current) { autoLoadArmedRef.current = false; loadOlder(); }
  };

  if (!taskId || !task) return null;
  const meta = STATUS_META[task.status] || { label: task.status, cls: '' };

  const send = async (e) => {
    e?.preventDefault();
    const liveTask = state.tasks.get(taskId);
    if (!liveTask || liveTask.lease === 'human') return;
    if (editingMessage) {
      const latest = [...taskMessages(taskId)].reverse().find(m => m.role === 'user' && !isSubagentInternal(m));
      if (latest?.seq !== editingMessage.seq) { setSendError('最后一条消息已改变,请取消编辑后重试'); return; }
      if (latest.content?.senderUserId && latest.content.senderUserId !== user?.id) return;
    }
    const t = text.trim();
    // A running turn doesn't block sending — the server holds the message
    // until the turn ends (see queueEnabled).
    if (stoppingRef.current
      || (!t && !attachments.length && !editingMessage?.images.length) || attachmentError || sendingRef.current) return;
    if (editingMessage && (!isCreator || (liveTask.owner_user_id && liveTask.owner_user_id !== user?.id))) return;
    sendingRef.current = true;
    setBusy(true);
    setSendError(null);
    // Identifies this exact send everywhere it travels (cloud row, node
    // event, this bubble) — see api.sendMessage. Generated before the request
    // so a retry of a request whose response was lost reuses it and can never
    // produce a second copy of the message.
    const clientMessageId = newClientMessageId();
    const images = [...(editingMessage?.images || []), ...wireImages()];
    // alert() alone isn't enough here — found live: a message sent right
    // before the sender stepped away (network/device went to sleep right
    // after) failed silently, the alert had no one there to see it, and
    // there was nothing left behind to show it had failed rather than just
    // gone unanswered. This banner persists until the next attempt so
    // coming back later still shows what happened. Attachments are left
    // intact on failure too, same reasoning — nothing lost, easy to retry.
    try {
      const isCurrent = messageLoadGuard(taskId);
      sendRequestRef.current = editingMessage
        ? api.editLastMessage(taskId, editingMessage.seq, t, images, clientMessageId)
        : api.sendMessage(taskId, t, images, clientMessageId, queueEnabled);
      const res = await sendRequestRef.current;
      if (editingMessage) {
        setEditingMessage(null);
        // Also refresh without WS; never merge a shortened transcript into the old window.
        if (isCurrent()) { resetMessages(taskId); bump(); }
        setText('');
        clearAttachments();
        return;
      }
      if (!isCurrent()) return;
      // The composer only clears once the cloud has *stored* the send. Until
      // then the text stays where the user can see (and re-send) it — the
      // old code cleared on a 200 that only meant "handed to a socket",
      // which is how a message could disappear from the box without ever
      // reaching the conversation.
      setText('');
      clearAttachments();
      // Show it immediately rather than waiting for the broadcast to come
      // back: on a slow link that round trip is exactly the window where the
      // composer looks like it swallowed the message. Harmless if the real
      // one has already landed — the store drops a pending entry whose
      // message it already has.
      upsertPendingMessage(taskId, {
        // 'held' means the server is holding it until the current turn ends —
        // a different bubble from 'pending' (on its way to the node), so the
        // optimistic copy has to agree with what the broadcast will say.
        clientMessageId, text: t, images, senderUserId: user?.id ?? null,
        state: res?.delivery === 'held' ? 'queued' : 'pending', createdAt: Date.now(),
      });
      bump();
    } catch (e2) { setSendError(e2.message || '发送失败'); }
    finally {
      sendRequestRef.current = null;
      sendingRef.current = false;
      setBusy(false);
    }
  };

  const stop = async () => {
    if (task.lease === 'human' || stoppingRef.current || !stopMode) return;
    stoppingRef.current = true;
    setStopping(true);
    setSendError(null);
    try {
      // Let an in-flight POST become durable before cancelling its outbound delivery.
      await sendRequestRef.current?.catch(() => {});
      const liveTask = state.tasks.get(taskId);
      if (!liveTask || liveTask.lease === 'human') return;
      await api.cancel(taskId);
    } catch (e) { setSendError(e.message || '停止失败'); }
    finally { stoppingRef.current = false; setStopping(false); }
  };

  const startEdit = (msg) => {
    if (!isCreator || task.lease === 'human' || busy || stopping) return;
    if (text.trim() && !editingMessage && !confirm('用这条消息替换输入框中的草稿?')) return;
    setEditingMessage({ seq: msg.seq, images: msg.content.images || [], draft: editingMessage?.draft ?? text });
    setText(msg.content.text || '');
    setSendError(null);
    composerRef.current?.focus();
  };
  const cancelEdit = () => {
    setText(editingMessage?.draft || '');
    setEditingMessage(null);
    setSendError(null);
  };

  const retryPending = async (clientMessageId) => {
    setSendError(null);
    try { await api.retryMessage(taskId, clientMessageId); } catch (e2) { setSendError(e2.message || '重发失败'); }
  };

  const editQueued = async (clientMessageId, newText) => {
    setSendError(null);
    try { await api.editQueuedMessage(taskId, clientMessageId, newText); }
    catch (e2) { setSendError(e2.message || '修改失败'); }
  };
  const sendQueuedNow = async (clientMessageId) => {
    setSendError(null);
    try { await api.sendQueuedMessageNow(taskId, clientMessageId); }
    catch (e2) { setSendError(e2.message || '发送失败'); }
  };
  const cancelQueued = async (clientMessageId) => {
    setSendError(null);
    try { await api.cancelQueuedMessage(taskId, clientMessageId); }
    catch (e2) { setSendError(e2.message || '取消失败'); }
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
    // The exact command depends on the task's backend *and* on paths only that
    // node knows (its isolated CLAUDE_CONFIG_DIR / CODEX_HOME), so the executor
    // posts it into the conversation as a system message the moment the lease
    // lands. Repeating a guessed version here is how it would go stale.
    if (r) alert(`已切换为 IDE 接管(节点 ${r.nodeId},会话 ${r.sessionId})。\n\n接管命令已发到下面的对话里 —— 直接复制那一行到节点的终端执行即可(里面的环境变量是必需的,少了会找不到会话),另外记得带上中转站的 base url / api key。\n\n在 IDE 里聊的内容,点「归还」时会自动同步回这里的对话记录。完成后点「归还」。`);
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
            {elapsed !== null && (
              <span className="chip st-running run-timer" title="本轮已运行时间">⏱ {fmtDuration(elapsed)}</span>
            )}
            {!isCreator && task.owner_username && <span className="chip owner-chip" title="创建者">{task.owner_username}</span>}
            {task.lease === 'human' && <span className="chip st-waiting">IDE 接管中</span>}
            <ModelChip task={task} isCreator={isCreator} />
            <span className="muted">{task.node_id}</span>
            {/* A conversation that hasn't spent anything yet has nothing to
                say here — $0.000 is a chip's worth of width for no
                information, and width is the scarce thing in a tiled pane.
                The 信息 tab always shows it. */}
            {task.backend !== 'codex' && (task.cost_usd ?? 0) > 0
              && <span className="muted">${task.cost_usd.toFixed(3)}</span>}
            {!!task.context_tokens && (task.backend === 'codex'
              ? <span className="chip ctx-chip ctx-ok" title={`当前上下文约 ${task.context_tokens.toLocaleString()} tokens`}>上下文 {task.context_tokens.toLocaleString()} tokens</span>
              : <ContextChip tokens={task.context_tokens} />)}
          </div>
        </div>
        {/* Tabs and pane buttons travel together: as one flex item they wrap
            onto a single shared line when the pane is narrow, instead of the
            tabs staying up beside the title and the buttons dropping onto a
            line of their own. */}
        <div className="pane-header-actions">
          <nav className="tabs">
            {[['chat', '对话'], ...(task.agent_mode === 'multi' ? [['agents', '子代理']] : []), ['diff', '变更'], ['info', '信息']].map(([k, label]) => (
              <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{label}</button>
            ))}
          </nav>
          {/* Opens a file browser for this task's node, starting in its own
              working directory — the pane tiles alongside the conversation so
              you can read the code while the agent talks about it. */}
          {onOpenFiles && task.node_id && (
            <button type="button" className="ghost" title="浏览这台机器上的文件" onClick={() => onOpenFiles(task.node_id)}>📁 文件</button>
          )}
          {onToggleMaximize && (
            <button type="button" className="ghost pane-max-btn" onClick={onToggleMaximize}
              title={maximized ? '还原' : '最大化(占满工作区)'} aria-label={maximized ? '还原' : '最大化'}>
              {maximized ? '⤡' : '⤢'}
            </button>
          )}
          {onClose && <button type="button" className="ghost pane-close-btn" onClick={onClose} aria-label="关闭">✕</button>}
        </div>
      </header>

      {tab === 'chat' && (
        <>
          {/* Reaching for the list during the settle window means the reader
              wants to be somewhere other than the bottom — stop holding them
              there. onScroll can't stand in for this: the settle loop's own
              assignments produce scroll events too, and these two are the
              gestures only a person can produce. */}
          <div
            className="chat-list" ref={listRef} onScroll={onScroll}
            onWheel={cancelPin} onTouchMove={cancelPin}
          >
            {/* Scrolling up loads this by itself; the button is what that
                looks like while it happens, and the way out if the automatic
                trigger can't fire (a list too short to scroll, a failed
                page the user wants to retry). */}
            {(hasOlder || loadingOlder) && (
              <div className="history-page-actions">
                {loadingOlder ? (
                  <div className="history-loading" role="status">
                    <div className="history-progress"><span /></div>
                    <span>正在加载更早消息{olderLoaded ? `,已加载 ${olderLoaded} 条` : ''}…</span>
                  </div>
                ) : (
                  <>
                    {olderError && <span className="history-error">加载失败:{olderError}</span>}
                    <button type="button" className="ghost" onClick={loadOlder}>
                      {olderError ? '重试' : '加载更早消息'}
                    </button>
                  </>
                )}
              </div>
            )}
            <ConversationMessages
              messages={messages} task={task} isCreator={isCreator} onImageClick={setLightboxSrc}
              hideEmpty={pendingMessages.length > 0} onEdit={startEdit} userId={user?.id}
            />
            {inFlightMessages.map(pending => (
              <PendingMessage
                key={pending.clientMessageId} pending={pending}
                canRetry={task.lease !== 'human'} onRetry={retryPending} onImageClick={setLightboxSrc}
              />
            ))}
            {task.status === 'running' && <ThinkingIndicator elapsed={elapsed} />}
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
              <span>此会话可能在看板之外继续过(如在终端里 resume 过)</span>
              <button onClick={() => api.resyncSession(taskId).catch(e => alert(e.message))}>🔄 刷新历史</button>
            </div>
          )}
          {sendError && (
            <div className="review-bar">
              <span className="err">操作失败:{sendError}</span>
              <button className="ghost" onClick={() => setSendError(null)}>知道了</button>
            </div>
          )}
          {/* Queued strip sits directly on top of the composer, the way Codex
              shows it — it belongs to "what I'm about to send", not to the
              transcript above. */}
          {!!queuedMessages.length && (
            <div className="queued-strip">
              {queuedMessages.map(pending => (
                <QueuedMessage
                  key={pending.clientMessageId} pending={pending} canEdit={isCreator || pending.senderUserId === user?.id}
                  waitingDecision={task.status === 'waiting_human'}
                  onEdit={editQueued} onCancel={cancelQueued} onSendNow={sendQueuedNow}
                />
              ))}
              {isCreator && (
                <button type="button" className="ghost link queued-strip-off" onClick={() => setQueue(false)}>
                  关闭排队(以后直接发给正在运行的 agent)
                </button>
              )}
            </div>
          )}
          {!queueEnabled && isCreator && task.status === 'running' && (
            <div className="queued-strip queued-strip-notice">
              <span className="muted">排队已关闭 — 消息会直接插进正在运行的回合</span>
              <button type="button" className="ghost link" onClick={() => setQueue(true)}>重新开启排队</button>
            </div>
          )}
          <form
            className={`composer${dragOver ? ' drag-over' : ''}`} onSubmit={send}
            onDragOver={e => { e.preventDefault(); if (task.lease !== 'human') setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={e => { e.preventDefault(); setDragOver(false); if (task.lease !== 'human') addFiles(e.dataTransfer.files); }}
          >
            {editingMessage && <div className="composer-edit-banner" role="status">
              <span>正在编辑最后一条消息{editingMessage.images.length ? ` · 保留 ${editingMessage.images.length} 张原图` : ''} — 将重新生成后续回复</span>
              <button type="button" className="ghost" disabled={busy || stopping} onClick={cancelEdit}>取消编辑</button>
            </div>}
            <AttachmentStrip attachments={attachments} onRemove={removeAttachment} />
            <div className="composer-row">
              <AttachButton onFiles={addFiles} disabled={task.lease === 'human' || busy} />
              <textarea
                ref={composerRef} value={text} onChange={e => setText(e.target.value)} rows={2}
                placeholder={task.lease === 'human' ? 'IDE 接管中,看板只读' : '发消息继续对话…(Enter 发送,Shift+Enter 换行,可直接粘贴/拖拽图片)'}
                disabled={task.lease === 'human' || busy}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}
                onPaste={e => {
                  const files = imageFilesFromPaste(e);
                  if (files.length) { e.preventDefault(); addFiles(files); }
                }}
              />
              {stopMode && <button type="button" className="composer-stop deny" aria-label="停止任务" disabled={task.lease === 'human' || stopping} onClick={stop}>{stopping ? '停止中…' : '停止'}</button>}
              <button type="submit" disabled={busy || stopping || task.lease === 'human' || (!text.trim() && !attachments.length && !editingMessage?.images.length) || attachmentError}>{editingMessage ? '保存并重新发送' : '发送'}</button>
            </div>
          </form>
          {lightboxSrc && (
            <div className="lightbox-backdrop" onClick={() => setLightboxSrc(null)}>
              <img className="lightbox-img" src={lightboxSrc} onClick={e => e.stopPropagation()} />
            </div>
          )}
        </>
      )}

      {tab === 'agents' && (
        <div className="tab-scroll"><SubagentPanel task={task} messages={messages} /></div>
      )}

      {tab === 'diff' && <div className="tab-scroll"><DiffView messages={messages} hasOlder={hasOlder} onLoadOlder={loadOlder} /></div>}

      {tab === 'info' && (
        <div className="tab-scroll info-view">
          <dl>
            <dt>任务 ID</dt><dd><code>{task.id}</code></dd>
            <dt>会话 ID</dt><dd><code>{task.session_id || '—'}</code></dd>
            <dt>节点</dt><dd>{task.node_id}</dd>
            <dt>仓库</dt><dd>{task.repo_url || '(无,scratch 目录)'}</dd>
            {/* No branch_name means no worktree was made: the agent works
                directly in the directory above. Showing a `task/<id>` branch
                there would be inventing one that does not exist. */}
            <dt>分支</dt><dd>{task.branch_name
              ? <>{task.branch_name} ← {task.base_branch || '(自动识别)'}</>
              : '— 直接在该目录工作,不建分支'}</dd>
            <dt>权限模式</dt><dd>{task.permission_mode}{task.permission_mode === 'bypassPermissions' && ' ⚠️'}</dd>
            <dt>当前模型</dt><dd><ModelChip task={task} isCreator={isCreator} /></dd>
            {!!task.auto_decide_all && (
              <><dt>强制确认自动批准</dt><dd className="err">已开启 ⚠️ — 包括 agent CLI 自身要求人工确认的操作(如 rm)</dd></>
            )}
            {task.backend === 'codex'
              ? <><dt>上下文 tokens</dt><dd>{task.context_tokens?.toLocaleString() || '—'}</dd></>
              : <><dt>成本(参考)</dt><dd>${(task.cost_usd ?? 0).toFixed(4)}</dd></>}
            <dt>创建于</dt><dd>{new Date(task.created_at).toLocaleString()}</dd>
            {task.last_error && <><dt>最近错误</dt><dd className="err">{task.last_error}</dd></>}
          </dl>
          {!isCreator && <p className="muted">只读 — 由 {task.owner_username || '其他成员'} 创建,以下操作仅创建者可用。</p>}
          <div className="info-actions">
            {isCreator && (task.lease === 'daemon'
              ? <button onClick={takeover}>⌨️ 在 IDE 中接管</button>
              : <button onClick={() => api.lease(taskId, 'daemon').catch(e => alert(e.message))}>↩️ 归还给看板</button>)}
            {isCreator && task.backend !== 'codex' && task.repo_url && !['starting', 'running', 'waiting_human'].includes(task.status) &&
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
