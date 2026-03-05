import { useState, useEffect, useCallback } from 'react';
import * as api from '../api';

export function useRemembered() {
  const [remembered, setRemembered] = useState([]);

  const fetchRemembered = useCallback(async () => {
    try {
      const data = await api.getRemembered();
      setRemembered(data);
    } catch {
      // ignore
    }
  }, []);

  const remember = useCallback(async (email) => {
    try {
      const data = {
        subject: email.subject,
        sender: email.from,
        date: email.date ? new Date(email.date).getTime() : null,
      };
      await api.rememberEmail(email.uid, data);
      await fetchRemembered();
    } catch {
      // silent — UI will stay in sync on next fetch
    }
  }, [fetchRemembered]);

  const forget = useCallback(async (uid) => {
    try {
      await api.forgetEmail(uid);
      await fetchRemembered();
    } catch {
      // silent
    }
  }, [fetchRemembered]);

  const isRemembered = useCallback((uid) => {
    return remembered.some((r) => r.email_uid === uid);
  }, [remembered]);

  useEffect(() => {
    fetchRemembered();
  }, [fetchRemembered]);

  return { remembered, remember, forget, isRemembered };
}
