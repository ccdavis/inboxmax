import { useRef, useEffect, useCallback } from 'react';
import EmailRow from './EmailRow';
import { relativeTime } from '../utils/dates';

export default function EmailList({
  emails,
  loading,
  refreshing,
  error,
  lastOpen,
  sinceTimestamp,
  onSelectEmail,
  isRemembered,
  onToggleRemember,
  searchMode,
  watermarkUid,
  onSetWatermark,
  hideSeen,
  onToggleHideSeen,
  onRefresh,
}) {
  const todayStr = new Date().toDateString();
  const todayEmails = emails.filter((e) => e.date && new Date(e.date).toDateString() === todayStr);
  const olderCount = emails.length - todayEmails.length;

  const baseEmails = searchMode ? emails : todayEmails;

  const visibleEmails = hideSeen && watermarkUid != null
    ? baseEmails.filter((e) => e.uid >= watermarkUid)
    : baseEmails;

  const newCount = watermarkUid != null
    ? baseEmails.filter((e) => e.uid > watermarkUid).length
    : null;

  const headerText = searchMode
    ? `${visibleEmails.length} result${visibleEmails.length !== 1 ? 's' : ''}`
    : newCount != null
    ? `${newCount} new today`
    : lastOpen
    ? `${todayEmails.length} new today`
    : `${todayEmails.length} email${todayEmails.length !== 1 ? 's' : ''} today`;

  const listRef = useRef(null);

  // Scroll watermark row into view when it changes
  useEffect(() => {
    if (watermarkUid != null && listRef.current) {
      const el = listRef.current.querySelector(`[data-uid="${watermarkUid}"]`);
      if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [watermarkUid]);

  const handleKeyDown = useCallback((e) => {
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
    } else if (e.key === 'ArrowUp' && currentIndex > 0) {
      onSetWatermark(visibleEmails[currentIndex - 1].uid);
    }
  }, [searchMode, visibleEmails, watermarkUid, onSetWatermark]);

  return (
    <div className="flex flex-col h-full" tabIndex={0} onKeyDown={handleKeyDown} style={{ outline: 'none' }}>
      <div className="px-4 py-3 border-b border-slate-200 bg-white flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium text-slate-500">{headerText}</h2>
          {refreshing && (
            <div className="w-3.5 h-3.5 border-2 border-slate-200 border-t-indigo-500 rounded-full animate-spin" />
          )}
        </div>
        <div className="flex items-center gap-2">
          {!searchMode && watermarkUid != null && (
            <button
              onClick={onToggleHideSeen}
              className={`text-xs px-2 py-1 rounded transition ${
                hideSeen
                  ? 'bg-indigo-100 text-indigo-700 hover:bg-indigo-200'
                  : 'text-slate-400 hover:text-slate-600 hover:bg-slate-100'
              }`}
              title={hideSeen ? 'Show all emails' : 'Hide seen emails'}
            >
              {hideSeen ? 'Show all' : 'Hide seen'}
            </button>
          )}
          {!searchMode && onRefresh && (
            <button
              onClick={() => onRefresh()}
              disabled={loading || refreshing}
              className="text-slate-400 hover:text-slate-600 disabled:opacity-40 p-1 rounded transition hover:bg-slate-100"
              title="Refresh"
            >
              <svg className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto bg-white" ref={listRef}>
        {loading && (
          <div className="flex flex-col items-center justify-center py-16 gap-3">
            <div className="w-6 h-6 border-2 border-slate-300 border-t-indigo-500 rounded-full animate-spin" />
            <p className="text-sm text-slate-400">Connecting to your mailbox...</p>
          </div>
        )}

        {error && (
          <div className="m-4 bg-red-50 text-red-700 text-sm px-4 py-3 rounded-lg border border-red-100">
            {error}
          </div>
        )}

        {!loading && !error && visibleEmails.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-slate-400">
            <svg className="w-12 h-12 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0l-3-3m0 0l-3 3m3-3v9" />
            </svg>
            <p className="text-sm">No new emails today</p>
            {olderCount > 0 && !searchMode ? (
              <p className="text-xs mt-1">
                {olderCount} older email{olderCount !== 1 ? 's' : ''} available in Days on the left
              </p>
            ) : (
              <p className="text-xs mt-1">We'll check automatically, or hit refresh above</p>
            )}
          </div>
        )}

        {!loading &&
          visibleEmails.map((email) => (
            <EmailRow
              key={email.uid}
              email={email}
              onClick={onSelectEmail}
              isRemembered={isRemembered(email.uid)}
              onToggleRemember={onToggleRemember}
              isSeen={watermarkUid != null && email.uid < watermarkUid}
              isWatermark={watermarkUid != null && email.uid === watermarkUid}
              onSetWatermark={onSetWatermark}
            />
          ))}

        {!loading && !searchMode && olderCount > 0 && visibleEmails.length > 0 && (
          <div className="px-4 py-3 text-center border-t border-slate-100">
            <p className="text-xs text-slate-400">
              {olderCount} more from yesterday and earlier — browse by day in the sidebar
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
