import { useEffect, useId, useRef } from 'react';

/**
 * A modal dialog: full screen on phones, a centered panel on wider screens.
 * The page behind it should be made inert while it is open. Escape and the
 * ✕ call `onClose`, unless the dialog's own `onKeyDown` handled Escape first
 * (by calling preventDefault), as a dialog with unsaved work does to ask,
 * or `closeDisabled` is set. Focus starts on its first control and returns
 * to what opened it.
 */
export default function Dialog({ title, onClose, closeDisabled = false, onKeyDown, className = '', children }) {
  const titleId = useId();
  const panel = useRef(null);
  const handlers = useRef({ onKeyDown, onClose, closeDisabled });
  useEffect(() => {
    handlers.current = { onKeyDown, onClose, closeDisabled };
  });

  // Focus moves in when the dialog opens (unless a field inside took it),
  // and back to whatever opened it when it closes, so neither is lost.
  useEffect(() => {
    const opener = document.activeElement;
    if (!panel.current?.contains(document.activeElement)) {
      const first = panel.current?.querySelector(
        'input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]):not([data-dialog-close]), [href], [tabindex]:not([tabindex="-1"])',
      );
      (first ?? panel.current)?.focus();
    }
    return () => {
      // After the page behind stops being inert.
      setTimeout(() => {
        if (opener instanceof HTMLElement && opener.isConnected && !document.querySelector('[role="dialog"]')) {
          opener.focus();
        }
      }, 0);
    };
  }, []);

  const handleKeyDown = (e) => {
    onKeyDown?.(e);
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault();
      if (!closeDisabled) onClose();
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
        if (!handlers.current.closeDisabled) handlers.current.onClose();
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
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={handleKeyDown}
        className={`flex h-full w-full flex-col bg-surface shadow-xl sm:h-auto sm:max-h-[90dvh] sm:rounded-xl sm:border sm:border-line ${className}`}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-2">
          <h2 id={titleId} className="font-semibold text-ink">{title}</h2>
          <button
            type="button"
            data-dialog-close
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
