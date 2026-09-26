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

  it('loads the mailbox\'s bookmarks and can retry after a failure', async () => {
    api.getRemembered
      .mockRejectedValueOnce(new Error('Not connected'))
      .mockResolvedValueOnce([{ id: 1, email_uid: 42, subject: 'Saved' }]);
    const { result } = renderHook(() => useRemembered('a1'));
    await waitFor(() => expect(result.current.error).toBe('Not connected'));
    expect(api.getRemembered).toHaveBeenCalledWith('a1');

    await act(async () => result.current.fetchRemembered());

    expect(result.current.error).toBeNull();
    expect(result.current.isRemembered(42)).toBe(true);
  });

  it('does nothing without a mailbox, and never shows another mailbox\'s bookmarks', async () => {
    api.getRemembered.mockResolvedValueOnce([{ id: 1, email_uid: 42, subject: 'Work' }]);
    const { result, rerender } = renderHook(({ id }) => useRemembered(id), { initialProps: { id: null } });
    expect(api.getRemembered).not.toHaveBeenCalled();

    rerender({ id: 'work' });
    await waitFor(() => expect(result.current.remembered).toHaveLength(1));

    api.getRemembered.mockReturnValueOnce(new Promise(() => {}));
    rerender({ id: 'home' });
    expect(result.current.remembered).toEqual([]);
  });

  it('surfaces bookmark write failures', async () => {
    api.getRemembered.mockResolvedValue([]);
    api.rememberEmail.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useRemembered('a1'));

    await act(async () => {
      await result.current.remember({ uid: 7, subject: 'Test', from: 'A', date: null });
    });

    expect(api.rememberEmail).toHaveBeenCalledWith('a1', 7, { subject: 'Test', sender: 'A', date: null });
    expect(result.current.error).toContain('offline');
  });
});
