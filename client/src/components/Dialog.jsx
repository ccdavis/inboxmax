import { useEffect, useId, useRef } from 'react';

/**
 * A modal dialog: full screen on phones, a centered panel on wider screens.
 * The page behind it should be made inert while it is open. Escape and the
 * ✕ call `onClose`, unless the dialog's own `onKeyDown` handled Escape first
 * (by calling preventDefault), as a dialog with unsaved work does to ask.
 */
export default function Dialog({ title, onClose, closeDisabled = false, onKeyDown, className = '', children }) {
  const titleId = useId();
  const panel = useRef(null);
  const handlers = useRef({ onKeyDown, onClose });
  useEffect(() => {
    handlers.current = { onKeyDown, onClose };
  });

  const handleKeyDown = (e) => {
    onKeyDown?.(e);
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault();
      onClose();
    }
  };

  // When the focused element goes away (a deleted row's button, say), focus
  // falls to the page body, outside the dialog. Keys pressed then still
  // belong to the dialog.
  useEffect(() => {
    const onDocumentKeyDown = (e) => {
      if (panel.current?.contains(e.target)) return;
      handlers.current.onKeyDown?.(e);
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        handlers.current.onClose();
      }
    };
    document.addEventListener('keydown', onDocumentKeyDown);
    return () => document.removeEventListener('keydown', onDocumentKeyDown);
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/40 sm:items-center sm:p-4">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={handleKeyDown}
        className={`flex h-full w-full flex-col bg-surface shadow-xl sm:h-auto sm:max-h-[90dvh] sm:rounded-xl sm:border sm:border-line ${className}`}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-2">
          <h2 id={titleId} className="font-semibold text-ink">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={closeDisabled}
            className="rounded p-1.5 text-ink-muted hover:bg-hover hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            aria-label="Close"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
