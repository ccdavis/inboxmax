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
  sendEmail: vi.fn(),
  searchContacts: vi.fn(),
  listContacts: vi.fn(),
  saveContact: vi.fn(),
  deleteContact: vi.fn(),
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

  describe('compose', () => {
    async function composeTo(address) {
      renderInbox();
      await screen.findByText('Thirty');
      fireEvent.click(screen.getByRole('button', { name: /Compose/ }));
      const dialog = screen.getByRole('dialog', { name: 'New message' });
      fireEvent.change(within(dialog).getByLabelText('To'), { target: { value: address } });
      fireEvent.change(within(dialog).getByLabelText('Subject'), { target: { value: 'Hello' } });
      return dialog;
    }

    it('sends from the open mailbox and says so', async () => {
      api.sendEmail.mockResolvedValue({ message_id: 'm@x', saved_to_sent: true });
      const dialog = await composeTo('Sarah <sarah@acme.example>');
      expect(dialog).toHaveTextContent('work@example.com');
      // Nothing behind the dialog can be used while it is open.
      expect(screen.getByRole('banner', { hidden: true }).closest('[inert]')).not.toBeNull();

      fireEvent.click(within(dialog).getByRole('button', { name: 'Send' }));

      expect(await screen.findByRole('status')).toHaveTextContent('Message sent to Sarah.');
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(api.sendEmail).toHaveBeenCalledWith('work', expect.objectContaining({
        to: [{ name: 'Sarah', email: 'sarah@acme.example' }],
        subject: 'Hello',
      }));
      expect(document.querySelector('[inert]')).toBeNull();
    });

    it('warns when no copy could be filed in Sent', async () => {
      api.sendEmail.mockResolvedValue({ message_id: 'm@x', saved_to_sent: false });
      const dialog = await composeTo('a@x.example, b@x.example');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Send' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Message sent to a@x.example and 1 more, but no copy could be saved in your Sent folder.',
      );
      expect(screen.queryByRole('status')).toBeNull();
    });

    it('keeps the draft open when sending fails', async () => {
      api.sendEmail.mockRejectedValue(new Error('Mail server error: Sending failed: timed out'));
      const dialog = await composeTo('a@x.example');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Send' }));
      expect(await within(dialog).findByRole('alert')).toHaveTextContent('timed out');
      expect(within(dialog).getByLabelText('Subject')).toHaveValue('Hello');
    });
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
      from: [{ name: 'B', email: 'b@example.com' }],
      reply_to: [],
      to: [{ name: null, email: 'work@example.com' }],
      cc: [],
      date: now,
      received: now,
      body_html: '<p>See <a href="https://example.com/">the site</a></p>',
      body_text: null,
      message_id: 'thirty@example.com',
      references: [],
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

  it('reloads the inbox and remembered emails when the open demo starts over', async () => {
    const DEMO = { id: 'demo', email: 'demo@inboxmax.invalid', connected: true, password_saved: false };
    api.listAccounts.mockResolvedValue([DEMO]);
    api.connectDemo.mockResolvedValue({ account: DEMO, provider_detected: false });
    render(<DesktopApp />);
    await screen.findByText('Thirty');
    const emailLoads = api.getEmails.mock.calls.length;
    const rememberedLoads = api.getRemembered.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: '+ Add mailbox' }));
    fireEvent.click(screen.getByRole('button', { name: 'Try the demo mailbox' }));

    await vi.waitFor(() => expect(api.getEmails.mock.calls.length).toBeGreaterThan(emailLoads));
    expect(api.getRemembered.mock.calls.length).toBeGreaterThan(rememberedLoads);
  });

  it('replies from the reader, threaded and quoted', async () => {
    api.sendEmail.mockResolvedValue({ message_id: 'r@x', saved_to_sent: true });
    render(<DesktopApp />);
    fireEvent.click(await screen.findByText('Thirty'));
    await screen.findByRole('heading', { name: 'Thirty', level: 1 });
    // Sent only to this mailbox, so there is no one else to reply to.
    expect(screen.queryByRole('button', { name: 'Reply all' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    const dialog = screen.getByRole('dialog', { name: 'Reply' });
    expect(within(dialog).getByRole('list', { name: 'To recipients' })).toHaveTextContent('B <b@example.com>');
    expect(within(dialog).getByLabelText('Subject')).toHaveValue('Re: Thirty');
    expect(within(dialog).getByLabelText('Message')).toHaveFocus();
    expect(within(dialog).getByLabelText('Message').value).toContain('> See the site (https://example.com/)');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Send' }));
    await screen.findByRole('status');
    expect(api.sendEmail).toHaveBeenCalledWith('work', expect.objectContaining({
      in_reply_to: 'thirty@example.com',
      references: ['thirty@example.com'],
    }));
  });

  it('forwards from the reader with an empty To', async () => {
    render(<DesktopApp />);
    fireEvent.click(await screen.findByText('Thirty'));
    fireEvent.click(await screen.findByRole('button', { name: 'Forward' }));
    const dialog = screen.getByRole('dialog', { name: 'Forward' });
    expect(within(dialog).getByLabelText('To')).toHaveFocus();
    expect(within(dialog).getByLabelText('Subject')).toHaveValue('Fwd: Thirty');
    expect(within(dialog).getByLabelText('Message').value).toContain('From: B <b@example.com>');
  });

  it('opens email links in the system browser', async () => {
    render(<DesktopApp />);
    fireEvent.click(await screen.findByText('Thirty'));
    const link = await screen.findByRole('link', { name: 'the site' });

    fireEvent.click(link);

    expect(api.openExternal).toHaveBeenCalledWith('https://example.com/');
  });
});
