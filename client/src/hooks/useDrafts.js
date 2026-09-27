import { useCallback, useEffect, useState } from 'react';
import * as api from '../api';

const NONE = [];
// A list, whatever the response; the sidebar must not break over drafts.
const asList = (items) => (Array.isArray(items) ? items : NONE);

/** The drafts of one mailbox, most recently changed first. */
export function useDrafts(accountId) {
  // Tagged with their mailbox so a switch never shows another's drafts.
  const [loaded, setLoaded] = useState({ accountId: null, items: NONE });
  const drafts = loaded.accountId === accountId ? loaded.items : NONE;

  const refresh = useCallback(async () => {
    if (!accountId) return;
    try {
      setLoaded({ accountId, items: asList(await api.listDrafts(accountId)) });
    } catch {
      // The list is a convenience; drafts are still saved.
    }
  }, [accountId]);

  useEffect(() => {
    if (!accountId) return undefined;
    let cancelled = false;
    api.listDrafts(accountId)
      .then((items) => {
        if (!cancelled) setLoaded({ accountId, items: asList(items) });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  return { drafts, refresh };
}
