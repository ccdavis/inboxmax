import { useState, useEffect, useCallback } from 'react';
import * as api from '../api';

const ACTIVE_KEY = 'inboxmax_active_account';

function readActive() {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

function writeActive(id) {
  try {
    if (id) localStorage.setItem(ACTIVE_KEY, id);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {
    // Remembering the last mailbox is only a convenience.
  }
}

/**
 * The user's mailboxes and which one is showing. An account is `connected`
 * when its password is available; others need reconnecting before use.
 */
export function useAccounts() {
  const [accounts, setAccounts] = useState(null); // null until first load
  const [error, setError] = useState(null);
  const [preferredId, setPreferredId] = useState(readActive);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const list = await api.listAccounts();
      setAccounts(list);
      return list;
    } catch (caught) {
      setError(caught);
      setAccounts((current) => current ?? []);
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.listAccounts()
      .then((list) => {
        if (!cancelled) setAccounts(list);
      })
      .catch((caught) => {
        if (cancelled) return;
        setError(caught);
        setAccounts([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The remembered choice if it still exists, else the first connected
  // mailbox, else the first one.
  const list = accounts ?? [];
  const active =
    list.find((a) => a.id === preferredId) ??
    list.find((a) => a.connected) ??
    list[0] ??
    null;

  const selectAccount = useCallback((id) => {
    setPreferredId(id);
    writeActive(id);
  }, []);

  /** Verify and add (or reconnect) a mailbox, then show it. */
  const connectAccount = useCallback(async (details) => {
    const result = await api.connectAccount(details);
    await refresh();
    selectAccount(result.account.id);
    return result;
  }, [refresh, selectAccount]);

  const removeAccount = useCallback(async (id) => {
    await api.removeAccount(id);
    if (id === preferredId) selectAccount(null);
    await refresh();
  }, [preferredId, refresh, selectAccount]);

  return {
    accounts: list,
    loaded: accounts !== null,
    error,
    active,
    selectAccount,
    connectAccount,
    removeAccount,
    refresh,
  };
}
