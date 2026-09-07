import { useState, useCallback, useRef } from 'react';
import * as api from '../api';

const SINCE_PREFIX = 'inboxmax_since:';
const MAX_STORED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function storageKey(accountKey) {
  return accountKey ? `${SINCE_PREFIX}${accountKey.trim().toLowerCase()}` : null;
}

function readStoredSince(key) {
  if (!key) return undefined;
  try {
    const value = Number(sessionStorage.getItem(key));
    const now = Date.now();
    if (Number.isFinite(value) && value > 0 && value <= now && value >= now - MAX_STORED_WINDOW_MS) {
      return value;
    }
    sessionStorage.removeItem(key);
  } catch {
    // Storage can be disabled; the in-memory cursor still works.
  }
  return undefined;
}

export function useEmails(accountKey) {
  const [emails, setEmails] = useState([]);
  const [searchResults, setSearchResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [sinceTimestamp, setSinceTimestamp] = useState(null);
  const [lastOpen, setLastOpen] = useState(null);
  const [watermarkUid, setWatermarkUid] = useState(null);

  const emailsRef = useRef([]);
  const cursorRef = useRef({ accountKey: null, since: null });
  const watermarkQueueRef = useRef(Promise.resolve());
  const fetchRequestRef = useRef(0);
  const searchRequestRef = useRef(0);

  const fetchEmails = useCallback(async (since, accountOverride) => {
    const requestId = ++fetchRequestRef.current;
    const scope = accountOverride;
    const key = storageKey(scope);
    if (cursorRef.current.accountKey !== scope) {
      cursorRef.current = { accountKey: scope, since: null };
    }
    const effectiveSince = since ?? cursorRef.current.since ?? readStoredSince(key);

    const isRefresh = emailsRef.current.length > 0;
    isRefresh ? setRefreshing(true) : setLoading(true);
    setError(null);
    try {
      const data = await api.getEmails(effectiveSince);
      if (requestId !== fetchRequestRef.current) return;
      emailsRef.current = data.emails;
      setEmails(data.emails);
      setSinceTimestamp(data.since_timestamp);
      setLastOpen(data.last_open);
      cursorRef.current = { accountKey: scope, since: data.since_timestamp };
      if (key) {
        try {
          sessionStorage.setItem(key, String(data.since_timestamp));
        } catch {
          // Storage is an optional optimization.
        }
      }
      setWatermarkUid(data.watermark_uid ?? null);
    } catch (caught) {
      if (requestId === fetchRequestRef.current) setError(caught.message);
    } finally {
      if (requestId === fetchRequestRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  const saveWatermark = useCallback((uid) => {
    if (uid == null) return Promise.resolve();
    setWatermarkUid(uid);
    const save = watermarkQueueRef.current
      .catch(() => undefined)
      .then(() => api.setWatermark(uid));
    watermarkQueueRef.current = save;
    return save.catch((caught) => {
      setError(`Could not save the last-seen marker: ${caught.message}`);
    });
  }, []);

  const search = useCallback(async (query) => {
    const requestId = ++searchRequestRef.current;
    setLoading(true);
    setError(null);
    try {
      const results = await api.searchEmails(query);
      if (requestId === searchRequestRef.current) setSearchResults(results);
    } catch (caught) {
      if (requestId === searchRequestRef.current) setError(caught.message);
    } finally {
      if (requestId === searchRequestRef.current) setLoading(false);
    }
  }, []);

  const clearSearch = useCallback(() => {
    searchRequestRef.current += 1;
    setSearchResults([]);
    setLoading(false);
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
    searchResults,
    loading,
    refreshing,
    error,
    sinceTimestamp,
    lastOpen,
    watermarkUid,
    saveWatermark,
    fetchEmails,
    search,
    clearSearch,
    clearStoredSince,
  };
}
