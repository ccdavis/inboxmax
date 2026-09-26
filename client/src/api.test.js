import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, signin } from './api';

describe('api errors', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('expose the server message without the status code, and the status separately', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Invalid email or password' }), { status: 401 }),
    ));

    const error = await signin('a@example.com', 'wrong').catch((caught) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toBe('Invalid email or password');
    expect(error.status).toBe(401);
  });

  it('fall back to the response text for non-JSON errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Bad gateway', { status: 502 })));
    await expect(signin('a@example.com', 'x')).rejects.toThrow('Bad gateway');
  });
});
