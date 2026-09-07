import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useRemembered } from './useRemembered';

vi.mock('../api', () => ({
  getRemembered: vi.fn(),
  rememberEmail: vi.fn(),
  forgetEmail: vi.fn(),
}));

import * as api from '../api';

describe('useRemembered', () => {
  beforeEach(() => vi.clearAllMocks());

  it('can retry after the initial pre-connection request fails', async () => {
    api.getRemembered
      .mockRejectedValueOnce(new Error('Not connected'))
      .mockResolvedValueOnce([{ id: 1, email_uid: 42, subject: 'Saved' }]);
    const { result } = renderHook(() => useRemembered());
    await waitFor(() => expect(api.getRemembered).toHaveBeenCalledTimes(1));

    await act(async () => result.current.fetchRemembered());

    expect(result.current.remembered).toHaveLength(1);
    expect(result.current.isRemembered(42)).toBe(true);
  });

  it('surfaces bookmark write failures', async () => {
    api.getRemembered.mockResolvedValue([]);
    api.rememberEmail.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useRemembered());

    await act(async () => {
      await result.current.remember({ uid: 7, subject: 'Test', from: 'A', date: null });
    });

    expect(result.current.error).toContain('offline');
  });
});
