// The image-attachment half of a chat composer, shared by the two places that
// have one: task.jsx (sending into an existing conversation) and draftpane.jsx
// (the first message, which is what creates the conversation). Kept here
// because the draft composer used to have none of this — attaching a picture
// worked in every conversation except the one you were starting.
import React, { useEffect, useRef, useState } from 'react';
import { addAttachment, revoke } from './attachments.js';
import { MAX_IMAGES_PER_MESSAGE } from '../../shared/protocol.mjs';

// resetKey: switching to another task/pane drops whatever was staged and
// revokes its object URLs. Read through a ref (not from `attachments`
// directly) since a cleanup closing over a [resetKey]-only effect would
// otherwise capture whatever the list was as of the last reset, not the latest.
export function useAttachments(resetKey, onError) {
  const [attachments, setAttachments] = useState([]);
  const ref = useRef(attachments);
  ref.current = attachments;
  useEffect(() => () => ref.current.forEach(revoke), [resetKey]);

  const addFiles = async (fileList) => {
    const files = [...fileList].filter(f => f.type.startsWith('image/'));
    if (!files.length) return;
    const room = MAX_IMAGES_PER_MESSAGE - ref.current.length;
    if (room <= 0) { onError?.(`最多同时附加 ${MAX_IMAGES_PER_MESSAGE} 张图片`); return; }
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

  // Only call once the send is actually durable — on failure the thumbnails
  // stay put so the user can just hit 发送 again (same reasoning as leaving
  // the text in the box).
  const clearAttachments = () => {
    ref.current.forEach(revoke);
    setAttachments([]);
  };

  return {
    attachments,
    addFiles,
    removeAttachment,
    clearAttachments,
    // What goes on the wire: previewUrl/name/id are local bookkeeping.
    wireImages: () => attachments.map(a => ({ mediaType: a.mediaType, data: a.data })),
    // A file that couldn't be used at all (wrong type, or still too big after
    // downscaling) blocks the send until it's removed — silently dropping it
    // would send a message that's missing the picture it's about.
    hasError: attachments.some(a => a.error),
  };
}

export function AttachmentStrip({ attachments, onRemove }) {
  if (!attachments.length) return null;
  return (
    <div className="composer-attachments">
      {attachments.map(a => (
        <div key={a.id} className={`attachment-thumb${a.error ? ' error' : ''}`} title={a.error || a.name}>
          {a.previewUrl ? <img src={a.previewUrl} alt={a.name} /> : <span className="attachment-err-icon">⚠️</span>}
          <button type="button" className="remove" onClick={() => onRemove(a.id)} aria-label="移除图片">✕</button>
        </div>
      ))}
    </div>
  );
}

// The 📎 button plus the hidden <input type=file> it drives.
export function AttachButton({ onFiles, disabled }) {
  const inputRef = useRef(null);
  return (
    <>
      <input
        type="file" accept="image/*" multiple ref={inputRef} style={{ display: 'none' }}
        onChange={e => { onFiles(e.target.files); e.target.value = ''; }}
      />
      <button
        type="button" className="ghost attach-btn" title="添加图片" disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >📎</button>
    </>
  );
}

// Pulls image files out of a paste event. Returns [] for an ordinary text
// paste, so the caller only preventDefault()s when there was actually an image.
export function imageFilesFromPaste(e) {
  return [...(e.clipboardData?.items || [])]
    .filter(i => i.kind === 'file' && i.type.startsWith('image/'))
    .map(i => i.getAsFile())
    .filter(Boolean);
}
