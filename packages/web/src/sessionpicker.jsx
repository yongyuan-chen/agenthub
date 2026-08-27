import React, { useEffect, useState } from 'react';
import { api } from './api.js';
import { fmtAge } from './board.jsx';
import { ModalBackdrop } from './modal.jsx';

// Shared by draftpane.jsx (pick a session to start a new chat from) and
// task.jsx (switch an already-open task to a different session) — lists
// pre-existing Claude Code CLI sessions found on a node for a given path.
export function SessionPicker({ nodeId, path, onPick, onClose }) {
  const [sessions, setSessions] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    api.listNodeSessions(nodeId, path).then(r => setSessions(r.sessions || [])).catch(e => { setErr(e.message); setSessions([]); });
  }, [nodeId, path]);

  return (
    <ModalBackdrop onClose={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h2>选择已有会话</h2>
        <p className="muted">在节点「{nodeId}」的 {path} 目录下找到的 Claude Code 会话,点击继续。</p>
        {sessions === null && <div className="muted">加载中…</div>}
        {err && <div className="err">{err}</div>}
        {sessions && !sessions.length && <div className="muted">没有找到已有会话</div>}
        {sessions && sessions.length > 0 && (
          <div className="session-list">
            {sessions.map(s => (
              <button type="button" key={s.sessionId} className="session-card" onClick={() => onPick(s.sessionId, s.preview)}>
                <div className="session-preview">{s.preview}</div>
                <div className="muted">{fmtAge(s.mtime)} 前 · {s.sessionId.slice(0, 8)}</div>
              </button>
            ))}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="ghost" onClick={onClose}>取消</button>
        </div>
      </div>
    </ModalBackdrop>
  );
}
