import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from './App';
import DesktopApp from './DesktopApp';

const desktop = vi.hoisted(() => ({ enabled: false }));

vi.mock('./api', () => ({
  get isDesktop() {
    return desktop.enabled;
  },
  getSession: vi.fn(),
  listAccounts: vi.fn(),
  connectAccount: vi.fn(),
  connectDemo: vi.fn(),
  removeAccount: vi.fn(),
  getEmails: vi.fn(),
  getRemembered: vi.fn(),
  setWatermark: vi.fn(),
  signout: vi.fn(),
  searchEmails: vi.fn(),
  rememberEmail: vi.fn(),
  forgetEmail: vi.fn(),
  getEmail: vi.fn(),
  openExternal: vi.fn(),
}));

import * as api from './api';

const USER = { user_id: 'u', email: 'me@example.com', display_name: 'Me' };
const WORK = { id: 'work', email: 'work@example.com', connected: true, password_saved: false };
const HOME = { id: 'home', email: 'home@example.com', connected: true, password_saved: false };
const now = new Date().toISOString();

const inbox = (emails, watermark = 10) => ({
  emails,
  since_timestamp: Date.now() - 60_000,
  last_open: Date.now() - 60_000,
  watermark_uid: watermark,
});

function setVisibility(state) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

function renderInbox() {
  render(
    <MemoryRouter initialEntries={['/inbox']}>
      <App />
    </MemoryRouter>,
  );
}

describe('inbox page', () => {
  beforeEach(() => {
    desktop.enabled = false;
    api.getSession.mockResolvedValue({ logged_in: true, user: USER });
    api.listAccounts.mockResolvedValue([WORK]);
    api.getRemembered.mockResolvedValue([]);
    api.setWatermark.mockResolvedValue({ ok: true });
    api.getEmails.mockImplementation(async (accountId) => (
      accountId === 'home'
        ? inbox([{ uid: 7, subject: 'Home news', from: 'H', date: now }], null)
        : inbox([
          { uid: 12, subject: 'Twelve', from: 'A', date: now },
          { uid: 30, subject: 'Thirty', from: 'B', date: now },
        ])
    ));
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    sessionStorage.clear();
    localStorage.clear();
    delete document.visibilityState;
  });

  it('marks everything seen when the page is hidden', async () => {
    renderInbox();
    await screen.findByText('Thirty');

    await act(async () => setVisibility('hidden'));

    expect(api.setWatermark).toHaveBeenCalledWith('work', 30);
  });

  it('keeps a manually placed marker when the page is hidden', async () => {
    renderInbox();
    await screen.findByText('Thirty');

    await act(async () => screen.getByRole('button', { name: 'Mark “Twelve” as the last one seen' }).click());
    await act(async () => setVisibility('hidden'));

    expect(api.setWatermark).toHaveBeenCalledTimes(1);
    expect(api.setWatermark).toHaveBeenCalledWith('work', 12);
  });

  it('does not mark the inbox seen when leaving during a search', async () => {
    api.searchEmails.mockResolvedValue([]);
    renderInbox();
    await screen.findByText('Thirty');

    const box = screen.getByRole('textbox', { name: /Search emails/ });
    fireEvent.change(box, { target: { value: 'zebra' } });
    fireEvent.submit(box);
    await screen.findByText('No emails match “zebra”');
    await act(async () => setVisibility('hidden'));

    expect(api.searchEmails).toHaveBeenCalledWith('work', 'zebra');
    expect(api.setWatermark).not.toHaveBeenCalled();
  });

  it('switches between mailboxes and remembers the choice', async () => {
    api.listAccounts.mockResolvedValue([WORK, HOME]);
    renderInbox();
    await screen.findByText('Thirty');

    const mailboxes = screen.getByRole('button', { name: /Mailboxes/ }).parentElement;
    expect(within(mailboxes).getByRole('button', { name: 'work@example.com' })).toHaveAttribute('aria-current', 'true');
    await act(async () => within(mailboxes).getByRole('button', { name: 'home@example.com' }).click());

    expect(await screen.findByText('Home news')).toBeInTheDocument();
    expect(screen.queryByText('Thirty')).toBeNull();
    expect(api.getRemembered).toHaveBeenCalledWith('home');
    // Leaving the work mailbox marked what it showed as seen.
    expect(api.setWatermark).toHaveBeenCalledWith('work', 30);
    expect(localStorage.getItem('inboxmax_active_account')).toBe('home');
  });

  it('asks for the password of a mailbox that is not connected', async () => {
    api.listAccounts.mockResolvedValue([{ ...WORK, connected: false }]);
    api.connectAccount.mockResolvedValue({ account: WORK, provider_detected: false });
    renderInbox();

    expect(await screen.findByRole('heading', { name: 'Reconnect your mailbox' })).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveValue('work@example.com');
    expect(api.getEmails).not.toHaveBeenCalled();

    api.listAccounts.mockResolvedValue([WORK]);
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Email Account' }));

    expect(await screen.findByText('Thirty')).toBeInTheDocument();
    expect(api.connectAccount).toHaveBeenCalledWith({ email: 'work@example.com', password: 'pw' });
  });

  it('adds a mailbox from the sidebar', async () => {
    api.connectAccount.mockResolvedValue({ account: HOME, provider_detected: true });
    renderInbox();
    await screen.findByText('Thirty');

    fireEvent.click(screen.getByRole('button', { name: '+ Add mailbox' }));
    expect(screen.getByRole('heading', { name: 'Add a mailbox' })).toBeInTheDocument();

    api.listAccounts.mockResolvedValue([WORK, HOME]);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'home@example.com' } });
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Email Account' }));

    expect(await screen.findByText('Home news')).toBeInTheDocument();
  });

  it('removes a mailbox after confirming', async () => {
    api.listAccounts.mockResolvedValue([WORK, HOME]);
    api.removeAccount.mockResolvedValue({ ok: true });
    renderInbox();
    await screen.findByText('Thirty');

    fireEvent.click(screen.getByRole('button', { name: 'Remove work@example.com' }));
    const confirm = screen.getByRole('group', { name: 'Remove work@example.com' });
    api.listAccounts.mockResolvedValue([HOME]);
    await act(async () => within(confirm).getByRole('button', { name: 'Remove' }).click());

    expect(api.removeAccount).toHaveBeenCalledWith('work');
    expect(await screen.findByText('Home news')).toBeInTheDocument();
  });

  it('asks to reconnect when the mail session has ended', async () => {
    api.getEmails.mockRejectedValue(Object.assign(new Error('Not authenticated'), { status: 401 }));
    api.listAccounts
      .mockResolvedValueOnce([WORK])
      .mockResolvedValue([{ ...WORK, connected: false }]);

    renderInbox();

    expect(await screen.findByRole('heading', { name: 'Reconnect your mailbox' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Your mail connection ended');
  });

  it('moves on quietly when the mailbox was removed on another device', async () => {
    const unauthorized = Object.assign(new Error('Not authenticated'), { status: 401 });
    api.getEmails.mockImplementation(async (accountId) => {
      if (accountId === 'work') throw unauthorized;
      return inbox([{ uid: 7, subject: 'Home news', from: 'H', date: now }], null);
    });
    api.listAccounts
      .mockResolvedValueOnce([WORK, HOME])
      .mockResolvedValue([HOME]);

    renderInbox();

    expect(await screen.findByText('Home news')).toBeInTheDocument();
    expect(screen.queryByText(/Your mail connection ended/)).toBeNull();
  });

  it('starts at the connect screen when there are no mailboxes', async () => {
    api.listAccounts.mockResolvedValue([]);
    renderInbox();
    expect(await screen.findByRole('heading', { name: 'Connect your email' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /demo/ })).toBeNull();
  });
});

describe('desktop app', () => {
  beforeEach(() => {
    desktop.enabled = true;
    api.getSession.mockResolvedValue({ logged_in: true, user: null, app: { can_save_passwords: true } });
    api.listAccounts.mockResolvedValue([WORK]);
    api.getRemembered.mockResolvedValue([]);
    api.getEmails.mockResolvedValue(inbox([{ uid: 30, subject: 'Thirty', from: 'B', date: now }]));
    api.getEmail.mockResolvedValue({
      uid: 30,
      subject: 'Thirty',
      from: 'B',
      to: 'work@example.com',
      date: now,
      body_html: '<p>See <a href="https://example.com/">the site</a></p>',
      body_text: null,
    });
    api.openExternal.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    localStorage.clear();
    desktop.enabled = false;
  });

  it('opens straight into the inbox with no sign-out or landing link', async () => {
    render(<DesktopApp />);
    await screen.findByText('Thirty');
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Inbox Max home' })).toBeNull();
  });

  it('offers the keychain when connecting', async () => {
    api.listAccounts.mockResolvedValue([]);
    render(<DesktopApp />);
    expect(await screen.findByRole('checkbox', { name: /keychain/ })).toBeChecked();
  });

  it('opens the demo mailbox from the connect screen', async () => {
    const DEMO = { id: 'demo', email: 'demo@inboxmax.invalid', connected: true, password_saved: false };
    api.listAccounts.mockResolvedValue([]);
    api.connectDemo.mockResolvedValue({ account: DEMO, provider_detected: false });
    render(<DesktopApp />);

    const demo = await screen.findByRole('button', { name: 'Try the demo mailbox' });
    api.listAccounts.mockResolvedValue([DEMO]);
    fireEvent.click(demo);

    expect(await screen.findByText('Thirty')).toBeInTheDocument();
    expect(api.connectDemo).toHaveBeenCalled();
    expect(api.connectAccount).not.toHaveBeenCalled();
    expect(api.getEmails.mock.calls.map(([accountId]) => accountId)).toContain('demo');
  });

  it('opens email links in the system browser', async () => {
    render(<DesktopApp />);
    fireEvent.click(await screen.findByText('Thirty'));
    const link = await screen.findByRole('link', { name: 'the site' });

    fireEvent.click(link);

    expect(api.openExternal).toHaveBeenCalledWith('https://example.com/');
  });
});
