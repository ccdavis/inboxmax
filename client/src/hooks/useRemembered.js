import { useState, useEffect, useCallback } from 'react';
import * as api from '../api';

export function useRemembered() {
  const [remembered, setRemembered] = useState([]);
  const [error, setError] = useState(null);

  const fetchRemembered = useCallback(async () => {
    try {
      setError(null);
      const data = await api.getRemembered();
      setRemembered(data);
    } catch (caught) {
      setError(caught.message);
    }
  }, []);

  const remember = useCallback(async (email) => {
    try {
      setError(null);
      const data = {
        subject: email.subject,
        sender: email.from,
        date: email.date ? new Date(email.date).getTime() : null,
      };
      await api.rememberEmail(email.uid, data);
      await fetchRemembered();
    } catch (caught) {
      setError(`Could not remember the message: ${caught.message}`);
    }
  }, [fetchRemembered]);

  const forget = useCallback(async (uid) => {
    try {
      setError(null);
      await api.forgetEmail(uid);
      await fetchRemembered();
    } catch (caught) {
      setError(`Could not forget the message: ${caught.message}`);
    }
  }, [fetchRemembered]);

  const isRemembered = useCallback((uid) => {
    return remembered.some((r) => r.email_uid === uid);
  }, [remembered]);

  useEffect(() => {
    let cancelled = false;
    api.getRemembered()
      .then((data) => {
        if (!cancelled) setRemembered(data);
      })
      .catch(() => {
        // An IMAP account may not be connected yet; connect retries explicitly.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { remembered, remember, forget, isRemembered, fetchRemembered, error };
}
