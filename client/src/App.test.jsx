import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from './App';

vi.mock('./api', () => ({
  getStatus: vi.fn(),
  getEmails: vi.fn(),
  getRemembered: vi.fn(),
  setWatermark: vi.fn(),
  signout: vi.fn(),
  searchEmails: vi.fn(),
  rememberEmail: vi.fn(),
  forgetEmail: vi.fn(),
  getEmail: vi.fn(),
  connect: vi.fn(),
}));

import * as api from './api';

const USER = { user_id: 'u', email: 'me@example.com', display_name: 'Me' };
const CONNECTED = {
  logged_in: true,
  email: USER.email,
  user: USER,
  imap_connected: true,
  imap_email: 'mail@example.com',
};
const now = new Date().toISOString();

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
    api.getStatus.mockResolvedValue(CONNECTED);
    api.getRemembered.mockResolvedValue([]);
    api.setWatermark.mockResolvedValue({ ok: true });
    api.getEmails.mockResolvedValue({
      emails: [
        { uid: 12, subject: 'Twelve', from: 'A', date: now },
        { uid: 30, subject: 'Thirty', from: 'B', date: now },
      ],
      since_timestamp: Date.now() - 60_000,
      last_open: Date.now() - 60_000,
      watermark_uid: 10,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    sessionStorage.clear();
    delete document.visibilityState;
  });

  it('marks everything seen when the page is hidden', async () => {
    renderInbox();
    await screen.findByText('Thirty');

    await act(async () => setVisibility('hidden'));

    expect(api.setWatermark).toHaveBeenCalledWith(30);
  });

  it('keeps a manually placed marker when the page is hidden', async () => {
    renderInbox();
    await screen.findByText('Thirty');

    await act(async () => screen.getByRole('button', { name: 'Mark “Twelve” as the last one seen' }).click());
    await act(async () => setVisibility('hidden'));

    expect(api.setWatermark).toHaveBeenCalledTimes(1);
    expect(api.setWatermark).toHaveBeenCalledWith(12);
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

    expect(api.setWatermark).not.toHaveBeenCalled();
  });

  it('returns to the connect screen when the mail session has ended', async () => {
    api.getEmails.mockRejectedValue(Object.assign(new Error('Not authenticated'), { status: 401 }));
    api.getStatus
      .mockResolvedValueOnce(CONNECTED)
      .mockResolvedValue({ ...CONNECTED, imap_connected: false, imap_email: null });

    renderInbox();

    expect(await screen.findByRole('heading', { name: 'Connect your email' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Your mail connection ended');
  });
});
