import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../api';
import Spinner from './Spinner';
import { formatTime } from '../utils/dates';
import { senderColor, senderInitial, senderName } from '../utils/senders';
import { folderLabel, serverName } from '../utils/folders';
import { focusRow, mayMoveFocus } from '../utils/focus';

/**
 * The newest messages in one of the server's folders, to look through.
 * Nothing here changes the folder: no marker, stars or moving from the
 * list. `folder` is { kind, name }; `onSelect(envelope)` opens one.
 * `focusRequest` ({ uid }) puts focus on that row, or where it was, once
 * the list has loaded; `onFocused` says it was done.
 */
export default function FolderView({ accountId, folder, onSelect, onBack, reloadKey = 0, focusRequest, onFocused }) {
  const [state, setState] = useState({ key: null, emails: [], error: null });
  const [refreshCount, setRefreshCount] = useState(0);
  const key = `${accountId}|${folder.kind}|${reloadKey}|${refreshCount}`;
  const loading = state.key !== key;

  useEffect(() => {
    let cancelled = false;
    api.getFolderEmails(accountId, folder.kind)
      .then((emails) => {
        if (!cancelled) setState({ key, emails: Array.isArray(emails) ? emails : [], error: null });
      })
      .catch((caught) => {
        if (!cancelled) setState({ key, emails: [], error: caught.message });
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, folder.kind, key]);

  const listRef = useRef(null);
  const headingRef = useRef(null);
  const rootRef = useRef(null);
  useEffect(() => {
    if (!focusRequest || loading) return;
    if (mayMoveFocus(rootRef.current, focusRequest)) {
      focusRow(listRef.current, focusRequest.uid, headingRef.current, focusRequest);
    }
    onFocused?.();
  }, [focusRequest, loading, onFocused]);

  const refresh = useCallback(() => setRefreshCount((n) => n + 1), []);
  const label = folderLabel(folder.kind);
  const alias = serverName(folder);
  const count = state.emails.length;

  return (
    <div ref={rootRef} className="flex flex-col h-full">
      <div className="px-4 py-2 min-h-12 border-b border-line bg-canvas flex items-center justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={onBack}
            className="text-sm text-accent hover:text-accent-hover flex items-center gap-1 py-1 rounded shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            <span aria-hidden="true">&larr;</span> Inbox
          </button>
          <h2 ref={headingRef} tabIndex={-1} className="text-sm font-medium text-ink truncate focus:outline-none" aria-live="polite">
            {label}
            {alias && <span className="ml-1 font-normal text-ink-muted">({alias})</span>}
            {!loading && !state.error && (
              <span className="ml-2 font-normal text-ink-muted">
                {count === 0 ? 'Empty' : `${count} ${count === 1 ? 'message' : 'messages'}`}
              </span>
            )}
          </h2>
          {loading && <Spinner size="sm" label={`Loading ${label}`} />}
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="text-ink-muted hover:text-ink disabled:opacity-40 p-2 rounded transition hover:bg-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          title="Refresh"
          aria-label={`Refresh ${label}`}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
      </div>

      <div ref={listRef} className="flex-1 overflow-y-auto bg-canvas">
        {state.error && !loading && (
          <div role="alert" className="m-4 bg-danger-bg text-danger-ink text-sm px-4 py-3 rounded-lg border border-danger-line">
            Could not open {label}: {state.error}
          </div>
        )}
        {!loading && !state.error && count === 0 && (
          <p className="py-16 text-center text-sm text-ink-muted">Nothing in {label}.</p>
        )}
        {count > 0 && (
          <ul aria-label={`Messages in ${label}`}>
            {state.emails.map((email) => {
              const subject = email.subject || '(no subject)';
              return (
                <li key={email.uid} data-uid={email.uid} className="border-b border-line-subtle">
                  <button
                    type="button"
                    onClick={() => onSelect(email)}
                    aria-label={`${senderName(email.from)}: ${subject}`}
                    className="flex w-full items-center gap-2.5 py-2 px-3 text-left hover:bg-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500"
                  >
                    <span
                      className={`${senderColor(email.from)} w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-semibold shrink-0`}
                      aria-hidden="true"
                    >
                      {senderInitial(email.from)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs truncate font-medium text-ink">{senderName(email.from)}</span>
                      <span className={`block text-xs truncate ${email.subject ? 'text-ink-soft' : 'italic text-ink-muted'}`}>
                        {subject}
                      </span>
                    </span>
                    <span className="text-[11px] shrink-0 text-ink-muted">{formatTime(email.date)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
