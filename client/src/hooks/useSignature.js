import { useCallback, useEffect, useState } from 'react';
import * as api from '../api';

/** The signature of one mailbox, and a way to change it. */
export function useSignature(accountId) {
  // Tagged with its mailbox so a switch never uses another's signature.
  const [loaded, setLoaded] = useState({ accountId: null, signature: '' });
  const signature = loaded.accountId === accountId ? loaded.signature : '';

  useEffect(() => {
    if (!accountId) return undefined;
    let cancelled = false;
    api.getSignature(accountId)
      .then((result) => {
        if (!cancelled) setLoaded({ accountId, signature: result?.signature ?? '' });
      })
      // Without it, messages simply start unsigned.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  /** Save a new signature; rejects with the reason if it cannot be. */
  const save = useCallback(async (text) => {
    const result = await api.setSignature(accountId, text);
    setLoaded({ accountId, signature: result.signature });
    return result.signature;
  }, [accountId]);

  return { signature, save };
}
