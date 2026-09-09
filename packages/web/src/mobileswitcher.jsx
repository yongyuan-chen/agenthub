import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { STATUS_META } from './board.jsx';
import { fmtAge, fmtDuration } from './format.js';
import { RUNNING_STATUSES, elapsedOf, useNow } from './elapsed.js';

function rowMeta(item, now) {
  if (item.kind === 'source') return { label: '历史 · 未接入', cls: 'source-chip', age: fmtAge(item.mtime) };
  if (item.kind === 'draft') return { label: '草稿', cls: '', age: '' };
  const status = STATUS_META[item.status] || { label: item.status, cls: '' };
  // Same rule as the sidebar: a running turn shows its own duration, because
  // updated_at churns every second while it runs and "0s / 1s / 0s" is not a
  // time anyone can read.
  const elapsed = elapsedOf(item, now);
  if (elapsed !== null) return { label: status.label, cls: status.cls, age: `⏱ ${fmtDuration(elapsed)}` };
  return {
    label: status.label, cls: status.cls,
    age: RUNNING_STATUSES.has(item.status) ? '' : fmtAge(item.updated_at),
  };
}

function ConversationRow({ item, now, active, open, onSelect, onClose }) {
  const meta = rowMeta(item, now);
  return (
    <div className={`mobile-switcher-row ${active ? 'active' : ''}`}>
      <button type="button" className="mobile-switcher-select" onClick={() => onSelect(item.paneId)}>
        <span className="mobile-switcher-title">{item.title}</span>
        <span className="mobile-switcher-meta">
          <span className={`chip ${meta.cls}`}>{meta.label}</span>
          {item.nodeId && <span>{item.nodeId}</span>}
          {meta.age && <span>{meta.age}</span>}
          {open && <span>已打开</span>}
        </span>
      </button>
      {open && <button type="button" className="ghost mobile-switcher-close" onClick={() => onClose(item.paneId)} aria-label={`关闭 ${item.title}`}>✕</button>}
    </div>
  );
}

export function MobileConversationSwitcher({ openItems, allItems, activePaneId, query, onQuery, onSelect, onClosePane, onNew, onClose }) {
  const inputRef = useRef(null);
  const sheetRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const opener = document.activeElement;
    const onKey = event => {
      if (event.key === 'Escape') { event.preventDefault(); onCloseRef.current(); return; }
      if (event.key !== 'Tab') return;
      const focusable = [...sheetRef.current.querySelectorAll('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])')];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey);
    inputRef.current?.focus();
    return () => { window.removeEventListener('keydown', onKey); opener?.focus?.(); };
  }, []);
  const normalized = query.trim().toLowerCase();
  const matches = item => !normalized || item.title.toLowerCase().includes(normalized) || item.nodeId?.toLowerCase().includes(normalized);
  const filteredOpen = openItems.filter(matches);
  const filtered = allItems.filter(matches);
  const openIds = new Set(openItems.map(item => item.paneId));
  const now = useNow(allItems.some(item => RUNNING_STATUSES.has(item.status) && item.run_started_at));

  return createPortal(
    <div className="mobile-sheet-backdrop" onClick={onClose}>
      <section ref={sheetRef} className="mobile-sheet" role="dialog" aria-modal="true" aria-label="切换对话" onClick={event => event.stopPropagation()}>
        <div className="mobile-sheet-handle" />
        <header className="mobile-sheet-header">
          <strong>切换对话</strong>
          <button type="button" onClick={onNew}>+ 新对话</button>
        </header>
        <input ref={inputRef} value={query} onChange={event => onQuery(event.target.value)} placeholder="搜索当前项目对话…" />
        <div className="mobile-sheet-list">
          {!!filteredOpen.length && <div className="mobile-sheet-section">已打开</div>}
          {filteredOpen.map(item => <ConversationRow key={item.paneId} item={item} now={now} active={item.paneId === activePaneId} open onSelect={onSelect} onClose={onClosePane} />)}
          <div className="mobile-sheet-section">当前范围全部对话</div>
          {filtered.filter(item => !openIds.has(item.paneId)).map(item => <ConversationRow key={item.paneId} item={item} now={now} active={false} open={false} onSelect={onSelect} />)}
          {!filtered.length && <div className="empty">没有匹配的对话</div>}
        </div>
      </section>
    </div>,
    document.body,
  );
}
