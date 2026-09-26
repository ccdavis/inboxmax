import { useState, useCallback, useRef } from 'react';
import * as api from '../api';

const SINCE_PREFIX = 'inboxmax_since:';
// The server rejects cursors older than seven days; stay safely inside that.
const MAX_CURSOR_AGE_MS = 7 * 24 * 60 * 60 * 1000 - 60 * 1000;

function storageKey(accountKey) {
  return accountKey ? `${SINCE_PREFIX}${accountKey.trim().toLowerCase()}` : null;
}

function isUsableCursor(value, now = Date.now()) {
  return Number.isFinite(value) && value > 0 && value <= now && value >= now - MAX_CURSOR_AGE_MS;
}

function readStoredSince(key) {
  if (!key) return undefined;
  try {
    const value = Number(sessionStorage.getItem(key));
    if (isUsableCursor(value)) return value;
    sessionStorage.removeItem(key);
  } catch {
    // Storage can be disabled; the in-memory cursor still works.
  }
  return undefined;
}

/**
 * Inbox state for one mailbox (`accountKey` is its account id): the email window, the "last seen"
 * watermark, and search results (kept separate so searching never disturbs
 * the inbox window or watermark).
 *
 * Emails with a UID above the watermark are unseen, meaning their headers
 * have not been shown to the user yet; opening a message is not required.
 */
export function useEmails(accountKey) {
  const [emails, setEmails] = useState([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [lastOpen, setLastOpen] = useState(null);
  const [watermarkUid, setWatermarkUid] = useState(null);
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState(null);

  const emailsRef = useRef([]);
  const watermarkRef = useRef(null);
  // Set once the user positions the marker themselves; automatic "seen"
  // updates then stay off for this page load so they cannot override it.
  const manualWatermarkRef = useRef(false);
  const cursorRef = useRef({ accountKey: null, since: null });
  const watermarkQueueRef = useRef(Promise.resolve());
  const fetchRequestRef = useRef(0);
  const searchRequestRef = useRef(0);

  const fetchEmails = useCallback(async () => {
    if (!accountKey) return;
    const requestId = ++fetchRequestRef.current;
    const key = storageKey(accountKey);
    if (cursorRef.current.accountKey !== accountKey) {
      // Switched mailbox: never show one account's emails under another.
      cursorRef.current = { accountKey, since: null };
      emailsRef.current = [];
      watermarkRef.current = null;
      manualWatermarkRef.current = false;
      setEmails([]);
      setWatermarkUid(null);
      setLastOpen(null);
    }
    const memorySince = cursorRef.current.since;
    const effectiveSince = isUsableCursor(memorySince) ? memorySince : readStoredSince(key);

    const isRefresh = emailsRef.current.length > 0;
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const data = await api.getEmails(accountKey, effectiveSince);
      if (requestId !== fetchRequestRef.current) return;
      emailsRef.current = data.emails;
      setEmails(data.emails);
      setLastOpen(data.last_open);
      cursorRef.current = { accountKey, since: data.since_timestamp };
      if (key) {
        try {
          sessionStorage.setItem(key, String(data.since_timestamp));
        } catch {
          // Storage is an optional optimization.
        }
      }
      watermarkRef.current = data.watermark_uid ?? null;
      setWatermarkUid(watermarkRef.current);
    } catch (caught) {
      if (requestId === fetchRequestRef.current) setError(caught);
    } finally {
      if (requestId === fetchRequestRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [accountKey]);

  const persistWatermark = useCallback((uid) => {
    watermarkRef.current = uid;
    setWatermarkUid(uid);
    const save = watermarkQueueRef.current
      .catch(() => undefined)
      .then(() => api.setWatermark(accountKey, uid));
    watermarkQueueRef.current = save;
    return save.catch((caught) => {
      setError(new Error(`Could not save the last-seen marker: ${caught.message}`));
    });
  }, [accountKey]);

  /** The user placed the marker on `uid` (click or arrow keys). */
  const setWatermarkManually = useCallback((uid) => {
    if (uid == null) return Promise.resolve();
    manualWatermarkRef.current = true;
    return persistWatermark(uid);
  }, [persistWatermark]);

  /**
   * Everything in the inbox has been shown, so move the marker to the newest
   * UID. Never moves it backwards and never overrides a manual placement.
   */
  const markAllSeen = useCallback(() => {
    if (manualWatermarkRef.current) return Promise.resolve();
    const newest = emailsRef.current.reduce((max, email) => Math.max(max, email.uid), 0);
    if (!newest || (watermarkRef.current != null && newest <= watermarkRef.current)) {
      return Promise.resolve();
    }
    return persistWatermark(newest);
  }, [persistWatermark]);

  const search = useCallback(async (query) => {
    const requestId = ++searchRequestRef.current;
    setSearchLoading(true);
    setSearchError(null);
    try {
      const results = await api.searchEmails(accountKey, query);
      if (requestId === searchRequestRef.current) setSearchResults(results);
    } catch (caught) {
      if (requestId === searchRequestRef.current) setSearchError(caught);
    } finally {
      if (requestId === searchRequestRef.current) setSearchLoading(false);
    }
  }, [accountKey]);

  const clearSearch = useCallback(() => {
    searchRequestRef.current += 1;
    setSearchResults([]);
    setSearchLoading(false);
    setSearchError(null);
  }, []);

  const clearStoredSince = useCallback(() => {
    const key = storageKey(accountKey);
    if (key) {
      try {
        sessionStorage.removeItem(key);
      } catch {
        // Storage is optional.
      }
    }
    cursorRef.current = { accountKey: null, since: null };
  }, [accountKey]);

  return {
    emails,
    loading,
    refreshing,
    error,
    lastOpen,
    watermarkUid,
    fetchEmails,
    setWatermarkManually,
    markAllSeen,
    searchResults,
    searchLoading,
    searchError,
    search,
    clearSearch,
    clearStoredSince,
  };
}
