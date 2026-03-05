import { useState, useCallback, useRef } from 'react';
import * as api from '../api';

const SINCE_KEY = 'inboxmax_since';

export function useEmails() {
  const [emails, setEmails] = useState([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [sinceTimestamp, setSinceTimestamp] = useState(null);
  const [lastOpen, setLastOpen] = useState(null);
  const [watermarkUid, setWatermarkUid] = useState(null);

  const emailsRef = useRef(emails);
  emailsRef.current = emails;
  const sinceRef = useRef(null);

  const fetchEmails = useCallback(async (since) => {
    // On refreshes / returning to the page, reuse the stored since so
    // we keep showing the same window of emails.
    const effectiveSince = since ?? sinceRef.current
      ?? (sessionStorage.getItem(SINCE_KEY) ? Number(sessionStorage.getItem(SINCE_KEY)) : undefined);

    const isRefresh = emailsRef.current.length > 0;
    if (isRefresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError(null);
    try {
      const data = await api.getEmails(effectiveSince);
      setEmails(data.emails);
      setSinceTimestamp(data.since_timestamp);
      setLastOpen(data.last_open);
      // Persist the since_timestamp so subsequent fetches (including after
      // navigation away + back) use the same window.
      sinceRef.current = data.since_timestamp;
      try { sessionStorage.setItem(SINCE_KEY, String(data.since_timestamp)); } catch {}
      if (data.watermark_uid != null) {
        setWatermarkUid(data.watermark_uid);
      }
    } catch (e) {
      if (!isRefresh) setError(e.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const saveWatermark = useCallback(async (uid) => {
    if (uid == null) return;
    setWatermarkUid(uid);
    try {
      await api.setWatermark(uid);
    } catch {
      // Best-effort — local state is already updated
    }
  }, []);

  const search = useCallback(async (query) => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.searchEmails(query);
      setEmails(data);
      setSinceTimestamp(null);
      setLastOpen(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  return { emails, loading, refreshing, error, sinceTimestamp, lastOpen, watermarkUid, saveWatermark, fetchEmails, search };
}
