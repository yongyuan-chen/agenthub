import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { state, cacheForScope, scopeKeyOf, bump } from './store.js';
import { fmtAge } from './board.jsx';
import { ConversationMessages } from './task.jsx';

export function ConversationSourcePane({ source, onActivated, onClose }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [messages, setMessages] = useState(null);
  const [historyError, setHistoryError] = useState('');
  const [nextCursor, setNextCursor] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hiddenDetailCount, setHiddenDetailCount] = useState(0);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const listRef = useRef(null);
  const contentRef = useRef(null);
  const preserveHeightRef = useRef(null);
  const anchorUntilRef = useRef(0);
  const observedHeightRef = useRef(0);
  const loadingOlderRef = useRef(false);
  const historyGenerationRef = useRef(0);
  const initialPinRef = useRef(true);
  const pinnedRef = useRef(true);
  const mountedRef = useRef(true);
  const sendingRef = useRef(false);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const loadHistory = () => {
    const generation = ++historyGenerationRef.current;
    setMessages(null); setHistoryError(''); setNextCursor(null); setHasMore(false); setHiddenDetailCount(0);
    let cancelled = false;
    api.conversationSourceHistory(source.id)
      .then(result => {
        if (cancelled || generation !== historyGenerationRef.current) return;
        setMessages((result.messages || []).map((message, index) => ({ ...message, historyKey: message.historyKey || `latest:${index}` })));
        setNextCursor(result.nextCursor || null); setHasMore(!!result.hasMore); setHiddenDetailCount(result.hiddenDetailCount || 0);
      })
      .catch(error => { if (!cancelled) setHistoryError(error.message || '历史记录加载失败'); });
    return () => { cancelled = true; };
  };
  useEffect(() => loadHistory(), [source.id]);

  const loadOlder = async () => {
    if (!nextCursor || loadingOlderRef.current) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true); setHistoryError('');
    const generation = historyGenerationRef.current;
    const sourceId = source.id;
    const cursor = nextCursor;
    const scope = scopeKeyOf(state.activeTeamId);
    const element = listRef.current;
    const content = contentRef.current;
    preserveHeightRef.current = element && content ? { height: content.getBoundingClientRect().height, top: element.scrollTop } : null;
    observedHeightRef.current = preserveHeightRef.current?.height || 0;
    anchorUntilRef.current = Date.now() + 3000;
    try {
      const result = await api.conversationSourceHistory(sourceId, { cursor });
      if (!mountedRef.current || generation !== historyGenerationRef.current || source.id !== sourceId || scopeKeyOf(state.activeTeamId) !== scope) return;
      const older = (result.messages || []).map((message, index) => ({ ...message, historyKey: message.historyKey || `${cursor}:${index}` }));
      setMessages(current => [...older, ...(current || [])]);
      setNextCursor(result.nextCursor || null); setHasMore(!!result.hasMore);
    } catch (error) {
      if (mountedRef.current && generation === historyGenerationRef.current) setHistoryError(error.message || '更早历史加载失败');
      preserveHeightRef.current = null;
    } finally {
      loadingOlderRef.current = false;
      if (mountedRef.current) setLoadingOlder(false);
    }
  };
  const loadDetails = async () => {
    if (!hiddenDetailCount || loadingDetails) return;
    setLoadingDetails(true); setHistoryError('');
    const generation = historyGenerationRef.current;
    try {
      const result = await api.conversationSourceHistory(source.id, { details: true });
      if (!mountedRef.current || generation !== historyGenerationRef.current) return;
      const latest = (result.messages || []).map((message, index) => ({ ...message, historyKey: message.historyKey || `latest:${index}` }));
      setMessages(current => [...(current || []).filter(message => !String(message.historyKey).startsWith('latest:')), ...latest]);
      setNextCursor(result.nextCursor || nextCursor); setHasMore(!!(result.nextCursor || nextCursor)); setHiddenDetailCount(0);
    } catch (error) { if (mountedRef.current) setHistoryError(error.message || '本轮工具详情加载失败'); }
    finally { if (mountedRef.current) setLoadingDetails(false); }
  };

  useLayoutEffect(() => {
    const preserve = preserveHeightRef.current;
    const element = listRef.current;
    if (!preserve || !element) return;
    const height = contentRef.current?.getBoundingClientRect().height || preserve.height;
    element.scrollTop = preserve.top + (height - preserve.height);
    observedHeightRef.current = height;
  }, [messages]);
  useEffect(() => {
    const element = listRef.current;
    if (!element || !messages?.length) return;
    if (initialPinRef.current) { element.scrollTop = element.scrollHeight; initialPinRef.current = false; }
    const observer = new ResizeObserver(() => {
      const height = contentRef.current?.getBoundingClientRect().height || 0;
      if (pinnedRef.current) element.scrollTop = element.scrollHeight;
      else if (preserveHeightRef.current && Date.now() < anchorUntilRef.current) {
        element.scrollTop += height - observedHeightRef.current;
      } else if (Date.now() >= anchorUntilRef.current) {
        preserveHeightRef.current = null;
      }
      observedHeightRef.current = height;
    });
    if (contentRef.current) observer.observe(contentRef.current);
    return () => observer.disconnect();
  }, [messages]);

  const send = async (event) => {
    event?.preventDefault();
    const value = text.trim();
    if (!value || sendingRef.current) return;
    sendingRef.current = true;
    setBusy(true); setErr('');
    const activationScope = scopeKeyOf(state.activeTeamId);
    const userGeneration = state.userGeneration;
    try {
      const result = await api.activateConversationSource(source.id, value);
      if (state.userGeneration !== userGeneration) return;
      state.sourceEpochs[activationScope] = (state.sourceEpochs[activationScope] || 0) + 1;
      state.taskEpochs[activationScope] = (state.taskEpochs[activationScope] || 0) + 1;
      const cache = cacheForScope(activationScope);
      cache.tasks.set(result.task.id, result.task);
      cache.conversationSources.delete(source.id);
      state.sourceClaims[activationScope] ||= new Map();
      state.sourceClaims[activationScope].set(`source:${source.id}`, result.task.id);
      if (scopeKeyOf(state.activeTeamId) === activationScope) {
        state.tasks.set(result.task.id, result.task);
        state.conversationSources.delete(source.id);
        bump();
        if (mountedRef.current) onActivated(result.task.id);
      }
    } catch (error) {
      if (mountedRef.current) { setErr(error.message); setBusy(false); }
    } finally {
      sendingRef.current = false;
    }
  };

  return (
    <div className="task-pane source-pane">
      <header className="pane-header source-pane-header">
        <div className="task-head">
          <h2>{source.preview || 'Claude Code 历史对话'}</h2>
          <div className="card-meta">
            <span className="chip source-chip">尚未接入</span>
            <span className="muted">{source.nodeId} · {fmtAge(source.mtime)} 前</span>
          </div>
        </div>
        {onClose && <button type="button" className="ghost pane-close-btn" onClick={onClose} aria-label="关闭">✕</button>}
      </header>
      <div
        className="chat-list source-chat-list" ref={listRef}
        onScroll={() => {
          const element = listRef.current;
          if (element) pinnedRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 60;
        }}
      >
        <div ref={contentRef}>
        {messages && (hasMore || hiddenDetailCount > 0) && (
          <div className="history-page-actions">
            {hasMore && <button type="button" className="ghost" onClick={loadOlder} disabled={loadingOlder}>
              {loadingOlder ? '正在加载更早消息…' : '加载更早消息'}
            </button>}
            {hiddenDetailCount > 0 && <button type="button" className="ghost" onClick={loadDetails} disabled={loadingDetails}>
              {loadingDetails ? '正在加载本轮工具详情…' : `加载本轮工具详情(${hiddenDetailCount})`}
            </button>}
          </div>
        )}
        {messages === null && !historyError && <div className="empty">正在加载最新一轮…</div>}
        {historyError && (
          <div className="source-history-error">
            <div className="err">历史记录加载失败:{historyError}</div>
            <button type="button" className="ghost" onClick={loadHistory}>重试</button>
          </div>
        )}
        {messages && <ConversationMessages messages={messages} staticHistory />}
        </div>
      </div>
      {err && <div className="err source-send-error">{err}</div>}
      <form className="composer" onSubmit={send}>
        <textarea
          value={text} onChange={event => setText(event.target.value)} rows={2}
          placeholder="继续这个历史对话…(Enter 发送,Shift+Enter 换行)" disabled={busy}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault(); send();
            }
          }}
        />
        <button disabled={busy || !text.trim()}>{busy ? '接入中…' : '发送并接入'}</button>
      </form>
    </div>
  );
}
