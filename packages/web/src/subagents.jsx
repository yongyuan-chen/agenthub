// The 子代理 tab of a multiagent conversation: which subagent the orchestrator
// (or another subagent) launched, as a tree, and the selected one's state.
// Built from the same message list the chat renders — see subagent-tree.js.
import React, { useEffect, useMemo, useState } from 'react';
import { api } from './api.js';
import { buildSubagentTree, countByStatus } from './subagent-tree.js';
import { Md, ToolUseRow } from './task.jsx';
import { fmtDuration } from './format.js';
import { useNow } from './elapsed.js';

const STATUS_LABEL = {
  running: '运行中', done: '已完成', error: '失败', stopped: '已停止', interrupted: '已中断',
};

function StatusDot({ status }) {
  return <i className={`sa-dot sa-${status}`} aria-label={STATUS_LABEL[status]} title={STATUS_LABEL[status]} />;
}

function elapsedOf(node, now) {
  if (!node.startedAt) return null;
  const end = node.endedAt ?? (node.status === 'running' ? now : null);
  return end ? Math.max(0, end - node.startedAt) : null;
}

function TreeRow({ node, depth, selectedId, onSelect }) {
  return (
    <>
      <button
        type="button" className={`sa-row ${selectedId === node.id ? 'selected' : ''}`}
        style={{ paddingLeft: 10 + depth * 16 }} onClick={() => onSelect(node.id)}
      >
        <StatusDot status={node.status} />
        <span className="sa-type">{node.subagentType}</span>
        <span className="sa-desc">{node.description || '(无描述)'}</span>
        {node.runs.length > 1 && <span className="sa-count" title={`接过 ${node.runs.length} 次任务`}>×{node.runs.length}</span>}
      </button>
      {node.children.map(child => (
        <TreeRow key={child.id} node={child} depth={depth + 1} selectedId={selectedId} onSelect={onSelect} />
      ))}
    </>
  );
}

// One handout of work: the creating Agent call, or a later SendMessage.
function RunSection({ run, index, resultByToolId, now, open }) {
  const elapsed = elapsedOf(run, now);
  return (
    <details className="sa-run" open={open}>
      <summary>
        <StatusDot status={run.status} />
        <span>第 {index + 1} 次 · {run.kind === 'spawn' ? '新建' : '续派'}</span>
        <span className="muted">{STATUS_LABEL[run.status]}{elapsed != null ? ` · ${fmtDuration(elapsed)}` : ''}</span>
      </summary>
      {run.status === 'interrupted' && (
        <div className="sys-note">这次任务没有返回结果就结束了:所在的回合被中断,或者进程已退出。</div>
      )}
      <div className="tool-section">任务</div>
      <pre className="sa-prompt">{run.prompt}</pre>
      {run.toolUses.length > 0 && <>
        <div className="tool-section">步骤</div>
        {run.toolUses.map(m => <ToolUseRow key={m.seq} msg={m} result={resultByToolId.get(m.content.id)} />)}
      </>}
      {run.report && <>
        <div className="tool-section">结果</div>
        <div className="sa-report"><Md text={run.report} /></div>
      </>}
    </details>
  );
}

function SubagentDetail({ node, resultByToolId, now }) {
  const elapsed = elapsedOf(node, now);
  const latest = node.runs.length - 1;
  return (
    <div className="sa-detail">
      <h3><StatusDot status={node.status} /> {node.description || node.subagentType}</h3>
      <dl className="sa-facts">
        <dt>状态</dt><dd>{STATUS_LABEL[node.status]}{node.runs[latest].background ? '(后台运行)' : ''}</dd>
        <dt>类型</dt><dd><code>{node.subagentType}</code></dd>
        <dt>接过任务</dt><dd>{node.runs.length} 次{node.runs.length > 1 ? '(之后的任务由主 agent 续派给它,沿用之前的上下文)' : ''}</dd>
        {elapsed != null && <><dt>{node.runs.length > 1 ? '总跨度' : '耗时'}</dt><dd>{fmtDuration(elapsed)}</dd></>}
        <dt>工具调用</dt><dd>{node.toolUses.length} 次</dd>
        {node.usage?.totalTokens != null && <><dt>Token</dt><dd>{node.usage.totalTokens.toLocaleString()}</dd></>}
        {node.status === 'running' && (node.activity || node.lastTool) && (
          <><dt>当前</dt><dd>{node.activity || `正在使用 ${node.lastTool}`}</dd></>
        )}
        {node.children.length > 0 && <><dt>下级</dt><dd>{node.children.length} 个 subagent</dd></>}
        {node.agentId && <><dt>Agent ID</dt><dd><code>{node.agentId}</code></dd></>}
      </dl>
      {[...node.runs].reverse().map((run, i) => (
        <RunSection
          key={run.toolUseId} run={run} index={latest - i}
          resultByToolId={resultByToolId} now={now} open={i === 0}
        />
      ))}
    </div>
  );
}

// The chat's loaded window plus the conversation's full subagent history,
// fetched once when the tab opens: the window alone is the newest 60 rows,
// which in a multiagent conversation usually covers only the latest
// subagent. Live messages keep arriving through the window; seq dedupes the
// overlap.
function useSubagentMessages(taskId, windowMessages) {
  const [history, setHistory] = useState({ taskId: null, messages: [], hasMore: false, loading: true });
  useEffect(() => {
    let cancelled = false;
    setHistory({ taskId, messages: [], hasMore: false, loading: true });
    api.subagentMessages(taskId)
      .then(r => { if (!cancelled) setHistory({ taskId, messages: r.messages || [], hasMore: !!r.hasMore, loading: false }); })
      .catch(() => { if (!cancelled) setHistory({ taskId, messages: [], hasMore: false, loading: false }); });
    return () => { cancelled = true; };
  }, [taskId]);
  const merged = useMemo(() => {
    if (history.taskId !== taskId || !history.messages.length) return windowMessages;
    const bySeq = new Map(history.messages.map(m => [m.seq, m]));
    for (const m of windowMessages) bySeq.set(m.seq, m);
    return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  }, [history, taskId, windowMessages]);
  return { messages: merged, truncated: history.hasMore, loading: history.loading };
}

export function SubagentPanel({ task, messages: windowMessages }) {
  const { messages, truncated, loading } = useSubagentMessages(task.id, windowMessages);
  const { roots, byId } = useMemo(() => buildSubagentTree(messages, task), [messages, task?.status]);
  const resultByToolId = useMemo(() => {
    const map = new Map();
    for (const m of messages) if (m.role === 'tool_result') map.set(m.content.tool_use_id, m);
    return map;
  }, [messages]);
  const [selectedId, setSelectedId] = useState(null);
  const counts = countByStatus(byId);
  const now = useNow(counts.running > 0);
  // Default to the newest top-level subagent: on a running conversation that
  // is the one being worked on.
  const selected = byId.get(selectedId) ?? roots[roots.length - 1] ?? null;

  if (!roots.length) {
    return <div className="empty">{loading ? '正在加载子代理…' : '还没有 subagent。发一条需求,主 agent 会把它派给 subagent 处理。'}</div>;
  }
  return (
    <div className="sa-panel">
      <div className="sa-tree">
        <div className="sa-root">
          🧭 主 agent
          <span className="muted">
            {byId.size} 个 subagent{counts.running ? ` · ${counts.running} 运行中` : ''}{counts.error ? ` · ${counts.error} 失败` : ''}
          </span>
        </div>
        {roots.map(node => (
          <TreeRow key={node.id} node={node} depth={1} selectedId={selected?.id} onSelect={setSelectedId} />
        ))}
        {truncated && <div className="muted sa-truncated">对话太长,最早的一部分子代理记录没有显示。</div>}
      </div>
      {selected && <SubagentDetail node={selected} resultByToolId={resultByToolId} now={now} />}
    </div>
  );
}
