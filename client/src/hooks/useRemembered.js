import { useState, useEffect, useCallback } from 'react';
import * as api from '../api';

const NONE = [];

/** Remembered (bookmarked) emails for one mailbox. */
export function useRemembered(accountId) {
  // Results are tagged with their mailbox so a switch never shows another
  // mailbox's bookmarks while the new ones load.
  const [loaded, setLoaded] = useState({ accountId: null, items: NONE });
  const [failure, setFailure] = useState({ accountId: null, message: null });
  const remembered = loaded.accountId === accountId ? loaded.items : NONE;
  const error = failure.accountId === accountId ? failure.message : null;

  const fetchRemembered = useCallback(async () => {
    if (!accountId) return;
    try {
      setFailure({ accountId, message: null });
      setLoaded({ accountId, items: await api.getRemembered(accountId) });
    } catch (caught) {
      setFailure({ accountId, message: caught.message });
    }
  }, [accountId]);

  const remember = useCallback(async (email) => {
    try {
      setFailure({ accountId, message: null });
      const data = {
        subject: email.subject,
        sender: email.from,
        date: email.date ? new Date(email.date).getTime() : null,
      };
      await api.rememberEmail(accountId, email.uid, data);
      await fetchRemembered();
    } catch (caught) {
      setFailure({ accountId, message: `Could not remember the message: ${caught.message}` });
    }
  }, [accountId, fetchRemembered]);

  const forget = useCallback(async (uid) => {
    try {
      setFailure({ accountId, message: null });
      await api.forgetEmail(accountId, uid);
      await fetchRemembered();
    } catch (caught) {
      setFailure({ accountId, message: `Could not forget the message: ${caught.message}` });
    }
  }, [accountId, fetchRemembered]);

  const isRemembered = useCallback((uid) => {
    return remembered.some((r) => r.email_uid === uid);
  }, [remembered]);

  useEffect(() => {
    if (!accountId) return undefined;
    let cancelled = false;
    api.getRemembered(accountId)
      .then((items) => {
        if (!cancelled) setLoaded({ accountId, items });
      })
      .catch((caught) => {
        if (!cancelled) setFailure({ accountId, message: caught.message });
      });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  return { remembered, remember, forget, isRemembered, fetchRemembered, error };
}
