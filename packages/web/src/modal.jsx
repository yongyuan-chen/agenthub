import React, { useRef } from 'react';

// Closes only when the interaction *started* on the backdrop itself. With a
// plain `onClick={onClose}` backdrop, a mousedown inside the dialog that ends
// outside it (dragging to select text in an input, easy to do with long API
// keys) fires the click on the backdrop and silently closed the whole dialog,
// discarding everything typed — found live in the Settings modal.
export function ModalBackdrop({ onClose, children, className = 'modal-backdrop' }) {
  const startedOnBackdrop = useRef(false);
  return (
    <div
      className={className}
      onMouseDown={e => { startedOnBackdrop.current = e.target === e.currentTarget; }}
      onClick={e => { if (startedOnBackdrop.current && e.target === e.currentTarget) onClose(); }}
    >
      {children}
    </div>
  );
}
