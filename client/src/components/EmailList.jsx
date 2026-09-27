import { useRef, useEffect } from 'react';
import EmailRow from './EmailRow';
import Spinner from './Spinner';
import { isToday } from '../utils/dates';
import { focusRow, mayMoveFocus } from '../utils/focus';

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

function EmptyState({ title, children }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center text-ink-muted">
      <svg className="w-12 h-12 mb-3 text-ink-faint" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
      </svg>
      <p className="text-sm">{title}</p>
      {children && <p className="text-xs mt-1">{children}</p>}
    </div>
  );
}

/**
 * The line between new emails (above) and ones already seen (below), for
 * when the last-seen email itself is not in the list to be highlighted.
 */
function SeenDivider() {
  return (
    <div role="separator" aria-label="Already seen: emails below this line" className="flex items-center gap-2 px-3 py-1.5 bg-canvas">
      <span className="h-0.5 flex-1 rounded-full bg-marker-line" aria-hidden="true" />
      <span className="shrink-0 rounded-full bg-marker px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-accent" aria-hidden="true">
        Already seen
      </span>
      <span className="h-0.5 flex-1 rounded-full bg-marker-line" aria-hidden="true" />
    </div>
  );
}

/**
 * The main pane. For the inbox it shows every unseen email (UID above the
 * last-seen marker), then the highlighted marker email and the rest of
 * today's; older seen emails are browsed by day in the sidebar. In search
 * mode it shows the results instead.
 */
export default function EmailList({
  emails,
  loading,
  refreshing,
  error,
  lastOpen,
  focusRequest,
  onFocused,
  onSelectEmail,
  isRemembered,
  onToggleRemember,
  searchQuery,
  watermarkUid,
  onSetWatermark,
  onMarkAllSeen,
  onMove,
  hideSeen,
  onToggleHideSeen,
  onRefresh,
}) {
  const searchMode = searchQuery != null;
  const now = new Date();
  const isUnseen = (email) => watermarkUid == null || email.uid > watermarkUid;

  // The marker email always shows, whatever its day, so the line does too.
  const baseEmails = searchMode
    ? emails
    : emails.filter((email) => isUnseen(email) || isToday(email.date, now) || email.uid === watermarkUid);
  const earlierSeenCount = searchMode ? 0 : emails.length - baseEmails.length;
  const visibleEmails = !searchMode && hideSeen && watermarkUid != null
    ? baseEmails.filter((email) => email.uid >= watermarkUid)
    : baseEmails;
  const newCount = baseEmails.filter(isUnseen).length;
  // The highlighted marker row is the line between new and seen. When that
  // email is not in the list, a divider stands in for it: above the first
  // seen row, or after the list if every row is new.
  let dividerIndex = -1;
  if (!searchMode && watermarkUid != null && !visibleEmails.some((email) => email.uid === watermarkUid)) {
    dividerIndex = visibleEmails.findIndex((email) => !isUnseen(email));
    if (dividerIndex === -1) dividerIndex = visibleEmails.length;
  }

  let headerText;
  if (searchMode) {
    headerText = loading
      ? `Searching for “${searchQuery}”…`
      : `${plural(visibleEmails.length, 'result')} for “${searchQuery}”`;
  } else if (watermarkUid == null && !lastOpen) {
    headerText = plural(baseEmails.length, 'email');
  } else {
    headerText = newCount === 0 ? 'No new emails' : `${newCount} new`;
  }

  const renderRow = (email) => (
    <EmailRow
      key={email.uid}
      email={email}
      onClick={onSelectEmail}
      isRemembered={isRemembered(email.uid)}
      onToggleRemember={onToggleRemember}
      isSeen={!isUnseen(email)}
      isWatermark={email.uid === watermarkUid}
      onSetWatermark={onSetWatermark}
      onMove={onMove}
    />
  );

  const listRef = useRef(null);
  const headingRef = useRef(null);
  const rootRef = useRef(null);

  // Put focus where it was asked for (back from a message, or after one
  // left the list), once.
  useEffect(() => {
    if (!focusRequest) return;
    if (mayMoveFocus(rootRef.current, focusRequest)) {
      focusRow(listRef.current, focusRequest.uid, headingRef.current, focusRequest);
    }
    onFocused?.();
  }, [focusRequest, onFocused]);

  // Keep the last-seen marker in view when it moves.
  useEffect(() => {
    if (watermarkUid != null && listRef.current) {
      const el = listRef.current.querySelector(`[data-uid="${watermarkUid}"]`);
      el?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    }
  }, [watermarkUid]);

  // Up/Down move the last-seen marker to the newer/older neighbouring row.
  const handleKeyDown = (e) => {
    if (searchMode || !visibleEmails.length) return;
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;

    e.preventDefault();
    const currentIndex = watermarkUid != null
      ? visibleEmails.findIndex((em) => em.uid === watermarkUid)
      : -1;

    if (e.key === 'ArrowDown') {
      if (currentIndex === -1) {
        onSetWatermark(visibleEmails[0].uid);
      } else if (currentIndex < visibleEmails.length - 1) {
        onSetWatermark(visibleEmails[currentIndex + 1].uid);
      }
    } else if (currentIndex > 0) {
      onSetWatermark(visibleEmails[currentIndex - 1].uid);
    }
  };

  let emptyState = null;
  if (!loading && !error && visibleEmails.length === 0) {
    if (searchMode) {
      emptyState = (
        <EmptyState title={`No emails match “${searchQuery}”`}>
          Search looks at subjects and senders in your inbox.
        </EmptyState>
      );
    } else if (baseEmails.length > 0) {
      emptyState = (
        <EmptyState title="You're all caught up">
          Seen emails are hidden. Choose “Show all” to bring them back.
        </EmptyState>
      );
    } else {
      emptyState = (
        <EmptyState title="No new emails">
          {earlierSeenCount > 0
            ? `${plural(earlierSeenCount, 'earlier email')} you've seen are in the sidebar, grouped by day.`
            : 'We check every 2 minutes, or refresh now.'}
        </EmptyState>
      );
    }
  }

  return (
    <div ref={rootRef} className="flex flex-col h-full">
      <div className="px-4 py-2 min-h-12 border-b border-line bg-canvas flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <h2 ref={headingRef} tabIndex={-1} className="text-sm font-medium text-ink-muted truncate focus:outline-none" aria-live="polite">{headerText}</h2>
          {refreshing && <Spinner size="sm" label="Refreshing" />}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {!searchMode && newCount > 0 && (
            <button
              type="button"
              onClick={() => onMarkAllSeen()}
              className="text-xs px-2 py-1.5 rounded text-accent hover:text-accent-hover hover:bg-hover transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            >
              Mark all seen
            </button>
          )}
          {!searchMode && watermarkUid != null && (
            <button
              type="button"
              onClick={onToggleHideSeen}
              aria-pressed={hideSeen}
              className={`text-xs px-2 py-1.5 rounded transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                hideSeen
                  ? 'bg-marker text-accent hover:bg-marker-hover'
                  : 'text-ink-muted hover:text-ink hover:bg-hover'
              }`}
            >
              Hide seen
            </button>
          )}
          {!searchMode && (
            <button
              type="button"
              onClick={() => onRefresh()}
              disabled={loading || refreshing}
              className="text-ink-muted hover:text-ink disabled:opacity-40 p-2 rounded transition hover:bg-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
              title="Refresh"
              aria-label="Refresh"
            >
              <svg className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
          )}
        </div>
      </div>

      <div
        className="flex-1 overflow-y-auto bg-canvas focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500"
        ref={listRef}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        aria-label={searchMode ? 'Search results' : 'Emails. Up and down arrow keys move the last-seen marker.'}
        aria-keyshortcuts={searchMode ? undefined : 'ArrowUp ArrowDown'}
      >
        {loading && (
          <div className="flex flex-col items-center justify-center py-16 gap-3">
            <Spinner label={searchMode ? 'Searching' : 'Loading emails'} />
            <p className="text-sm text-ink-muted">
              {searchMode ? 'Searching your mailbox…' : 'Connecting to your mailbox…'}
            </p>
          </div>
        )}

        {error && (
          <div role="alert" className="m-4 bg-danger-bg text-danger-ink text-sm px-4 py-3 rounded-lg border border-danger-line">
            {error}
          </div>
        )}

        {emptyState}

        {!loading && visibleEmails.length > 0 && (dividerIndex === -1 ? (
          <ul>{visibleEmails.map(renderRow)}</ul>
        ) : (
          // The divider sits between two lists so each list holds only emails.
          <>
            {dividerIndex > 0 && <ul>{visibleEmails.slice(0, dividerIndex).map(renderRow)}</ul>}
            <SeenDivider />
            {dividerIndex < visibleEmails.length && <ul>{visibleEmails.slice(dividerIndex).map(renderRow)}</ul>}
          </>
        ))}

        {!loading && earlierSeenCount > 0 && visibleEmails.length > 0 && (
          <p className="px-4 py-3 text-center text-xs text-ink-muted border-t border-line-subtle">
            {plural(earlierSeenCount, 'earlier email')} you've already seen — browse them by day in the sidebar.
          </p>
        )}
      </div>
    </div>
  );
}
