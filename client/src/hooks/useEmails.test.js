import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useEmails } from './useEmails';

vi.mock('../api', () => ({
  getEmails: vi.fn(),
  setWatermark: vi.fn(),
  searchEmails: vi.fn(),
}));

import * as api from '../api';

const ACCOUNT = 'account-1';
const SINCE_KEY = `inboxmax_since:${ACCOUNT}`;
const DAY_MS = 24 * 60 * 60 * 1000;

function makeEmailResponse(overrides = {}) {
  return {
    emails: [
      { uid: 100, subject: 'Hello', from: 'alice@test.com', date: new Date().toISOString() },
      // Dated later than uid 100 so the newest-by-date email is not the newest UID.
      { uid: 99, subject: 'Older', from: 'bob@test.com', date: new Date(Date.now() + 1000).toISOString() },
    ],
    since_timestamp: Date.now() - 60_000,
    last_open: null,
    watermark_uid: null,
    ...overrides,
  };
}

async function fetchEmails(result) {
  await act(async () => {
    await result.current.fetchEmails();
  });
}

describe('useEmails', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    sessionStorage.clear();
    api.setWatermark.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    sessionStorage.clear();
  });

  it('stores a cursor under an account-scoped key', async () => {
    const since = Date.now() - 60_000;
    api.getEmails.mockResolvedValue(makeEmailResponse({ since_timestamp: since }));
    const { result } = renderHook(() => useEmails(ACCOUNT));

    await fetchEmails(result);

    expect(sessionStorage.getItem(SINCE_KEY)).toBe(String(since));
    expect(sessionStorage.getItem('inboxmax_since')).toBeNull();
  });

  it('does nothing without an account', async () => {
    const { result } = renderHook(() => useEmails(null));
    await fetchEmails(result);
    expect(api.getEmails).not.toHaveBeenCalled();
  });

  it('uses a recent stored cursor for the same account', async () => {
    const storedSince = Date.now() - 120_000;
    sessionStorage.setItem(SINCE_KEY, String(storedSince));
    api.getEmails.mockResolvedValue(makeEmailResponse());
    const { result } = renderHook(() => useEmails(ACCOUNT));

    await fetchEmails(result);

    expect(api.getEmails).toHaveBeenCalledWith(ACCOUNT, storedSince);
  });

  it('rejects stale and future stored cursors', async () => {
    for (const invalid of [Date.now() - 8 * DAY_MS, Date.now() + 60_000]) {
      sessionStorage.setItem(SINCE_KEY, String(invalid));
      api.getEmails.mockResolvedValueOnce(makeEmailResponse());
      const { result, unmount } = renderHook(() => useEmails(ACCOUNT));
      await fetchEmails(result);
      expect(api.getEmails).toHaveBeenLastCalledWith(ACCOUNT, undefined);
      unmount();
    }
  });

  it('uses its in-memory cursor after the first fetch', async () => {
    const since = Date.now() - 60_000;
    api.getEmails.mockResolvedValue(makeEmailResponse({ since_timestamp: since }));
    const { result } = renderHook(() => useEmails(ACCOUNT));

    await fetchEmails(result);
    api.getEmails.mockClear();
    await fetchEmails(result);

    expect(api.getEmails).toHaveBeenCalledWith(ACCOUNT, since);
  });

  it('drops the in-memory cursor once it is too old for the server', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const since = Date.now() - 60_000;
    api.getEmails.mockResolvedValue(makeEmailResponse({ since_timestamp: since }));
    const { result } = renderHook(() => useEmails(ACCOUNT));
    await fetchEmails(result);

    // The tab stays open for a week.
    vi.setSystemTime(Date.now() + 7 * DAY_MS);
    api.getEmails.mockClear();
    await fetchEmails(result);

    expect(api.getEmails).toHaveBeenCalledWith(ACCOUNT, undefined);
  });

  it('updates inbox and watermark state from the API', async () => {
    const emails = [{ uid: 50, subject: 'Test', from: 'x@y.com', date: null }];
    api.getEmails.mockResolvedValue(makeEmailResponse({ emails, watermark_uid: 49 }));
    const { result } = renderHook(() => useEmails(ACCOUNT));

    await fetchEmails(result);

    expect(result.current.emails).toEqual(emails);
    expect(result.current.watermarkUid).toBe(49);
  });

  it('exposes the HTTP status of a failed fetch', async () => {
    api.getEmails.mockRejectedValue(Object.assign(new Error('Not authenticated'), { status: 401 }));
    const { result } = renderHook(() => useEmails(ACCOUNT));

    await fetchEmails(result);

    expect(result.current.error.message).toBe('Not authenticated');
    expect(result.current.error.status).toBe(401);
  });

  it('keeps search results, loading, and errors separate from the inbox', async () => {
    api.getEmails.mockResolvedValue(makeEmailResponse({ last_open: 456 }));
    api.searchEmails.mockRejectedValueOnce(new Error('Search failed'));
    const { result } = renderHook(() => useEmails(ACCOUNT));
    await fetchEmails(result);

    await act(async () => result.current.search('test'));
    expect(result.current.searchError.message).toBe('Search failed');
    expect(result.current.error).toBeNull();

    api.searchEmails.mockResolvedValueOnce([{ uid: 1, subject: 'Found' }]);
    await act(async () => result.current.search('test'));
    expect(result.current.searchError).toBeNull();
    expect(result.current.searchResults).toEqual([{ uid: 1, subject: 'Found' }]);
    expect(result.current.lastOpen).toBe(456);
    expect(result.current.emails).toHaveLength(2);

    act(() => result.current.clearSearch());
    expect(result.current.searchResults).toEqual([]);
  });

  it('serializes watermark writes in user order', async () => {
    const resolvers = [];
    api.setWatermark.mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)));
    const { result } = renderHook(() => useEmails(ACCOUNT));

    let first;
    let second;
    act(() => {
      first = result.current.setWatermarkManually(10);
      second = result.current.setWatermarkManually(11);
    });
    await act(async () => Promise.resolve());
    expect(api.setWatermark).toHaveBeenCalledTimes(1);
    resolvers.shift()();
    await act(async () => first);
    expect(api.setWatermark).toHaveBeenCalledTimes(2);
    resolvers.shift()();
    await act(async () => second);
    expect(result.current.watermarkUid).toBe(11);
  });

  it('clears one mailbox\'s emails and marker when switching to another', async () => {
    api.getEmails.mockResolvedValueOnce(makeEmailResponse({ watermark_uid: 90 }));
    const { result, rerender } = renderHook(({ account }) => useEmails(account), {
      initialProps: { account: ACCOUNT },
    });
    await fetchEmails(result);
    expect(result.current.emails).toHaveLength(2);

    let resolveOther;
    api.getEmails.mockReturnValueOnce(new Promise((resolve) => { resolveOther = resolve; }));
    rerender({ account: 'account-2' });
    let pending;
    act(() => {
      pending = result.current.fetchEmails();
    });
    expect(result.current.emails).toEqual([]);
    expect(result.current.watermarkUid).toBeNull();
    expect(api.getEmails).toHaveBeenLastCalledWith('account-2', undefined);

    resolveOther(makeEmailResponse({ emails: [], watermark_uid: 5 }));
    await act(async () => pending);
    expect(result.current.watermarkUid).toBe(5);
  });

  describe('markAllSeen', () => {
    it('moves the marker to the highest UID, not the newest date', async () => {
      api.getEmails.mockResolvedValue(makeEmailResponse({ watermark_uid: 90 }));
      const { result } = renderHook(() => useEmails(ACCOUNT));
      await fetchEmails(result);

      await act(async () => result.current.markAllSeen());

      expect(api.setWatermark).toHaveBeenCalledWith(ACCOUNT, 100);
      expect(result.current.watermarkUid).toBe(100);
    });

    it('never moves the marker backwards', async () => {
      api.getEmails.mockResolvedValue(makeEmailResponse({ watermark_uid: 150 }));
      const { result } = renderHook(() => useEmails(ACCOUNT));
      await fetchEmails(result);

      await act(async () => result.current.markAllSeen());

      expect(api.setWatermark).not.toHaveBeenCalled();
      expect(result.current.watermarkUid).toBe(150);
    });

    it('does not override a marker the user placed', async () => {
      api.getEmails.mockResolvedValue(makeEmailResponse({ watermark_uid: 90 }));
      const { result } = renderHook(() => useEmails(ACCOUNT));
      await fetchEmails(result);

      await act(async () => result.current.setWatermarkManually(99));
      await act(async () => result.current.markAllSeen());

      expect(api.setWatermark).toHaveBeenCalledTimes(1);
      expect(result.current.watermarkUid).toBe(99);
    });

    it('does nothing for an empty inbox', async () => {
      api.getEmails.mockResolvedValue(makeEmailResponse({ emails: [] }));
      const { result } = renderHook(() => useEmails(ACCOUNT));
      await fetchEmails(result);

      await act(async () => result.current.markAllSeen());

      expect(api.setWatermark).not.toHaveBeenCalled();
    });
  });
});
