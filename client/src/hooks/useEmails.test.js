import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useEmails } from './useEmails';

// Mock the api module
vi.mock('../api', () => ({
  getEmails: vi.fn(),
  setWatermark: vi.fn(),
  searchEmails: vi.fn(),
}));

import * as api from '../api';

const SINCE_KEY = 'inboxmax_since';

function makeEmailResponse(overrides = {}) {
  return {
    emails: [
      { uid: 100, subject: 'Hello', from: 'alice@test.com', date: new Date().toISOString() },
      { uid: 99, subject: 'Older', from: 'bob@test.com', date: new Date().toISOString() },
    ],
    since_timestamp: 1700000000000,
    last_open: null,
    watermark_uid: null,
    ...overrides,
  };
}

describe('useEmails', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  afterEach(() => {
    sessionStorage.clear();
  });

  it('stores since_timestamp in sessionStorage after fetch', async () => {
    api.getEmails.mockResolvedValue(makeEmailResponse({ since_timestamp: 1700000000000 }));

    const { result } = renderHook(() => useEmails());

    await act(async () => {
      await result.current.fetchEmails();
    });

    expect(sessionStorage.getItem(SINCE_KEY)).toBe('1700000000000');
  });

  it('uses sessionStorage since on subsequent fetches', async () => {
    // Simulate a previous session having stored a since value
    sessionStorage.setItem(SINCE_KEY, '1699000000000');

    api.getEmails.mockResolvedValue(makeEmailResponse());

    const { result } = renderHook(() => useEmails());

    await act(async () => {
      await result.current.fetchEmails();
    });

    // Should have passed the sessionStorage value as the since param
    expect(api.getEmails).toHaveBeenCalledWith(1699000000000);
  });

  it('uses in-memory ref over sessionStorage after first fetch', async () => {
    api.getEmails.mockResolvedValue(makeEmailResponse({ since_timestamp: 1700000000000 }));

    const { result } = renderHook(() => useEmails());

    // First fetch - no since stored anywhere
    await act(async () => {
      await result.current.fetchEmails();
    });

    expect(api.getEmails).toHaveBeenCalledWith(undefined);

    // Second fetch - should use the ref (1700000000000)
    api.getEmails.mockClear();
    api.getEmails.mockResolvedValue(makeEmailResponse({ since_timestamp: 1700000000000 }));

    await act(async () => {
      await result.current.fetchEmails();
    });

    expect(api.getEmails).toHaveBeenCalledWith(1700000000000);
  });

  it('explicit since param overrides stored value', async () => {
    sessionStorage.setItem(SINCE_KEY, '1699000000000');
    api.getEmails.mockResolvedValue(makeEmailResponse());

    const { result } = renderHook(() => useEmails());

    await act(async () => {
      await result.current.fetchEmails(1650000000000);
    });

    expect(api.getEmails).toHaveBeenCalledWith(1650000000000);
  });

  it('updates emails state from API response', async () => {
    const emails = [{ uid: 50, subject: 'Test', from: 'x@y.com', date: null }];
    api.getEmails.mockResolvedValue(makeEmailResponse({ emails }));

    const { result } = renderHook(() => useEmails());

    await act(async () => {
      await result.current.fetchEmails();
    });

    expect(result.current.emails).toEqual(emails);
    expect(result.current.sinceTimestamp).toBe(1700000000000);
  });

  it('sets watermark_uid from response', async () => {
    api.getEmails.mockResolvedValue(makeEmailResponse({ watermark_uid: 95 }));

    const { result } = renderHook(() => useEmails());

    await act(async () => {
      await result.current.fetchEmails();
    });

    expect(result.current.watermarkUid).toBe(95);
  });

  it('search clears sinceTimestamp and lastOpen', async () => {
    api.getEmails.mockResolvedValue(makeEmailResponse({ since_timestamp: 123, last_open: 456 }));
    api.searchEmails.mockResolvedValue([{ uid: 1, subject: 'Found' }]);

    const { result } = renderHook(() => useEmails());

    // First fetch
    await act(async () => {
      await result.current.fetchEmails();
    });
    expect(result.current.sinceTimestamp).toBe(123);

    // Search
    await act(async () => {
      await result.current.search('test');
    });

    expect(result.current.sinceTimestamp).toBeNull();
    expect(result.current.lastOpen).toBeNull();
  });
});
