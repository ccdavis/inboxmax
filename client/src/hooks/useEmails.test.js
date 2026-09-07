import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useEmails } from './useEmails';

vi.mock('../api', () => ({
  getEmails: vi.fn(),
  setWatermark: vi.fn(),
  searchEmails: vi.fn(),
}));

import * as api from '../api';

const ACCOUNT = 'test@example.com';
const SINCE_KEY = `inboxmax_since:${ACCOUNT}`;

function makeEmailResponse(overrides = {}) {
  return {
    emails: [
      { uid: 100, subject: 'Hello', from: 'alice@test.com', date: new Date().toISOString() },
      { uid: 99, subject: 'Older', from: 'bob@test.com', date: new Date().toISOString() },
    ],
    since_timestamp: Date.now() - 60_000,
    last_open: null,
    watermark_uid: null,
    ...overrides,
  };
}

async function fetchForAccount(result, since) {
  await act(async () => {
    await result.current.fetchEmails(since, ACCOUNT);
  });
}

describe('useEmails', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  afterEach(() => sessionStorage.clear());

  it('stores a cursor under an account-scoped key', async () => {
    const since = Date.now() - 60_000;
    api.getEmails.mockResolvedValue(makeEmailResponse({ since_timestamp: since }));
    const { result } = renderHook(() => useEmails(ACCOUNT));

    await fetchForAccount(result);

    expect(sessionStorage.getItem(SINCE_KEY)).toBe(String(since));
    expect(sessionStorage.getItem('inboxmax_since')).toBeNull();
  });

  it('uses a recent stored cursor for the same account', async () => {
    const storedSince = Date.now() - 120_000;
    sessionStorage.setItem(SINCE_KEY, String(storedSince));
    api.getEmails.mockResolvedValue(makeEmailResponse());
    const { result } = renderHook(() => useEmails(ACCOUNT));

    await fetchForAccount(result);

    expect(api.getEmails).toHaveBeenCalledWith(storedSince);
  });

  it('rejects stale and future stored cursors', async () => {
    for (const invalid of [Date.now() - 8 * 24 * 60 * 60 * 1000, Date.now() + 60_000]) {
      sessionStorage.setItem(SINCE_KEY, String(invalid));
      api.getEmails.mockResolvedValueOnce(makeEmailResponse());
      const { result, unmount } = renderHook(() => useEmails(ACCOUNT));
      await fetchForAccount(result);
      expect(api.getEmails).toHaveBeenLastCalledWith(undefined);
      unmount();
    }
  });

  it('uses its in-memory cursor after the first fetch', async () => {
    const since = Date.now() - 60_000;
    api.getEmails.mockResolvedValue(makeEmailResponse({ since_timestamp: since }));
    const { result } = renderHook(() => useEmails(ACCOUNT));

    await fetchForAccount(result);
    api.getEmails.mockClear();
    await fetchForAccount(result);

    expect(api.getEmails).toHaveBeenCalledWith(since);
  });

  it('lets an explicit cursor override stored state', async () => {
    sessionStorage.setItem(SINCE_KEY, String(Date.now() - 120_000));
    api.getEmails.mockResolvedValue(makeEmailResponse());
    const { result } = renderHook(() => useEmails(ACCOUNT));

    await fetchForAccount(result, 1_650_000_000_000);

    expect(api.getEmails).toHaveBeenCalledWith(1_650_000_000_000);
  });

  it('updates inbox and watermark state from the API', async () => {
    const emails = [{ uid: 50, subject: 'Test', from: 'x@y.com', date: null }];
    api.getEmails.mockResolvedValue(makeEmailResponse({ emails, watermark_uid: 49 }));
    const { result } = renderHook(() => useEmails(ACCOUNT));

    await fetchForAccount(result);

    expect(result.current.emails).toEqual(emails);
    expect(result.current.watermarkUid).toBe(49);
  });

  it('keeps search results separate from the inbox window', async () => {
    api.getEmails.mockResolvedValue(makeEmailResponse({ since_timestamp: 123, last_open: 456 }));
    api.searchEmails.mockResolvedValue([{ uid: 1, subject: 'Found' }]);
    const { result } = renderHook(() => useEmails(ACCOUNT));
    await fetchForAccount(result);

    await act(async () => result.current.search('test'));

    expect(result.current.sinceTimestamp).toBe(123);
    expect(result.current.lastOpen).toBe(456);
    expect(result.current.searchResults).toEqual([{ uid: 1, subject: 'Found' }]);
    expect(result.current.emails).toHaveLength(2);
  });

  it('serializes watermark writes in user order', async () => {
    const resolvers = [];
    api.setWatermark.mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)));
    const { result } = renderHook(() => useEmails(ACCOUNT));

    let first;
    let second;
    act(() => {
      first = result.current.saveWatermark(10);
      second = result.current.saveWatermark(11);
    });
    await act(async () => Promise.resolve());
    expect(api.setWatermark).toHaveBeenCalledTimes(1);
    resolvers.shift()();
    await act(async () => first);
    expect(api.setWatermark).toHaveBeenCalledTimes(2);
    resolvers.shift()();
    await act(async () => second);
  });
});
