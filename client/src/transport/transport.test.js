import { afterEach, describe, expect, it, vi } from 'vitest';
import { transport as http } from './http';
import { transport as tauri } from './tauri';
import { ApiError } from '../apiError';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
import { invoke } from '@tauri-apps/api/core';

const ok = (body) => new Response(JSON.stringify(body), { status: 200 });

describe('http transport', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('scopes mailbox calls to the account', async () => {
    const fetch = vi.fn().mockImplementation(async () => ok({}));
    vi.stubGlobal('fetch', fetch);

    await http.getEmails('a/1', 123);
    await http.searchEmails('a1', 'café & co');
    await http.setWatermark('a1', 9);
    await http.forgetEmail('a1', 9);

    const calls = fetch.mock.calls.map(([url, init]) => [init.method ?? 'GET', url]);
    expect(calls).toEqual([
      ['GET', '/api/accounts/a%2F1/emails?since=123'],
      ['GET', '/api/accounts/a1/search?q=caf%C3%A9%20%26%20co'],
      ['PUT', '/api/accounts/a1/watermark'],
      ['DELETE', '/api/accounts/a1/remembered/9'],
    ]);
  });

  it('does not send the desktop-only remember flag', async () => {
    const fetch = vi.fn().mockResolvedValue(ok({ account: {} }));
    vi.stubGlobal('fetch', fetch);
    await http.connectAccount({ email: 'a@example.com', password: 'pw', remember: true });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ email: 'a@example.com', password: 'pw' });
  });
});

describe('tauri transport', () => {
  afterEach(() => vi.clearAllMocks());

  it('calls commands with camelCase arguments', async () => {
    invoke.mockResolvedValue([]);
    await tauri.getEmails('a1');
    await tauri.rememberEmail('a1', 5, { subject: 'S' });
    await tauri.connectAccount({ email: 'a@example.com', password: 'pw', remember: false });

    expect(invoke.mock.calls).toEqual([
      ['list_emails', { accountId: 'a1', since: null }],
      ['remember_email', { accountId: 'a1', uid: 5, data: { subject: 'S' } }],
      ['connect_account', { request: { email: 'a@example.com', password: 'pw', remember: false } }],
    ]);
  });

  it('turns command errors into ApiErrors', async () => {
    invoke.mockRejectedValueOnce({ status: 401, message: 'Not authenticated' });
    const error = await tauri.listAccounts().catch((caught) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 401, message: 'Not authenticated' });

    invoke.mockRejectedValueOnce('window closed');
    await expect(tauri.listAccounts()).rejects.toMatchObject({ status: 500, message: 'window closed' });
  });

  it('adds app details to the always-signed-in session', async () => {
    invoke.mockResolvedValueOnce({ version: '0.1.0', can_save_passwords: true });
    expect(await tauri.getSession()).toEqual({
      logged_in: true,
      user: null,
      app: { version: '0.1.0', can_save_passwords: true },
    });
  });
});
