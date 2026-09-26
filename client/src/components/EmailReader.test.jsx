import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import EmailReader from './EmailReader';

// Mock the api module
vi.mock('../api', () => ({
  getEmail: vi.fn(),
}));

import * as api from '../api';

describe('EmailReader', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('sets target="_blank" and rel="noopener noreferrer" on links in HTML emails', async () => {
    api.getEmail.mockResolvedValue({
      uid: 1,
      subject: 'Test Email',
      from: [{ name: null, email: 'sender@example.com' }],
      to: [{ name: null, email: 'me@example.com' }],
      date: new Date().toISOString(),
      body_html: '<p>Click <a href="https://example.com">here</a> and <a href="https://other.com">there</a></p>',
      body_text: null,
    });

    render(<EmailReader emailUid={1} onBack={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('here')).toBeInTheDocument();
    });

    const links = screen.getByText('here').closest('div').querySelectorAll('a');
    expect(links.length).toBe(2);

    for (const link of links) {
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    }
  });

  it('does not invent links for non-link content', async () => {
    api.getEmail.mockResolvedValue({
      uid: 2,
      subject: 'Plain Email',
      from: [{ name: null, email: 'sender@example.com' }],
      to: [{ name: null, email: 'me@example.com' }],
      date: new Date().toISOString(),
      body_html: '<p>No links here</p>',
      body_text: null,
    });

    render(<EmailReader emailUid={2} onBack={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('No links here')).toBeInTheDocument();
    });

    expect(document.querySelectorAll('a[target="_blank"]')).toHaveLength(0);
  });

  it('blocks scripts, inline styles, and remote images', async () => {
    api.getEmail.mockResolvedValue({
      uid: 4,
      subject: 'Tracked Email',
      from: [{ name: null, email: 'sender@example.com' }],
      to: [{ name: null, email: 'me@example.com' }],
      date: new Date().toISOString(),
      body_html: '<script>alert(1)</script><p style="background:url(https://tracker.test/pixel)">Safe</p><img src="https://tracker.test/pixel">',
      body_text: null,
    });

    render(<EmailReader emailUid={4} onBack={() => {}} />);
    await waitFor(() => expect(screen.getByText('Safe')).toBeInTheDocument());

    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText('Safe')).not.toHaveAttribute('style');
  });

  it('renders plain text body when no HTML', async () => {
    api.getEmail.mockResolvedValue({
      uid: 3,
      subject: 'Plain Text',
      from: [{ name: null, email: 'sender@example.com' }],
      to: [{ name: null, email: 'me@example.com' }],
      date: new Date().toISOString(),
      body_html: null,
      body_text: 'Just plain text content',
    });

    render(<EmailReader emailUid={3} onBack={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('Just plain text content')).toBeInTheDocument();
    });
  });

  it('falls back to "(no subject)" and notes blocked images', async () => {
    api.getEmail.mockResolvedValue({
      uid: 5,
      subject: '',
      from: [{ name: null, email: 'sender@example.com' }],
      to: [{ name: null, email: 'me@example.com' }],
      date: null,
      body_html: '<p>Hi</p><img src="https://tracker.test/pixel">',
      body_text: null,
    });

    render(<EmailReader emailUid={5} onBack={() => {}} />);

    const heading = await screen.findByRole('heading', { name: '(no subject)' });
    // Focus moves in an effect after the message renders.
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByText(/Images in this email are blocked/)).toBeInTheDocument();
    expect(screen.getByText('Hi').closest('.prose')).not.toBeNull();
  });

  describe('headers', () => {
    const SARAH = { name: 'Sarah Chen', email: 'sarah.chen@acme.example' };
    const base = {
      uid: 9,
      subject: 'Headers',
      from: [SARAH],
      reply_to: [],
      to: [{ name: null, email: 'me@example.com' }],
      cc: [],
      date: '2026-09-25T13:00:00Z',
      received: '2026-09-25T13:00:30Z',
      body_html: null,
      body_text: 'Body',
    };
    const row = (label) => screen.getByText(label, { selector: 'dt' }).nextElementSibling;

    async function renderHeaders(overrides) {
      api.getEmail.mockResolvedValue({ ...base, ...overrides });
      render(<EmailReader emailUid={9} onBack={() => {}} />);
      await screen.findByRole('heading', { name: 'Headers' });
    }

    it('shows each sender and recipient as name and address', async () => {
      await renderHeaders({
        cc: [{ name: 'Bob Park', email: 'bob.park@acme.example' }, { name: null, email: 'cy@example.com' }],
      });
      expect(row('From')).toHaveTextContent('Sarah Chen <sarah.chen@acme.example>');
      expect(row('To')).toHaveTextContent('me@example.com');
      expect(row('Cc')).toHaveTextContent('Bob Park <bob.park@acme.example>');
      expect(row('Cc')).toHaveTextContent('cy@example.com');
    });

    it('leaves out Reply-To and Cc when the message has none', async () => {
      await renderHeaders();
      expect(screen.queryByText('Reply-To', { selector: 'dt' })).toBeNull();
      expect(screen.queryByText('Cc', { selector: 'dt' })).toBeNull();
    });

    it('warns when replies go somewhere other than the sender', async () => {
      await renderHeaders({ reply_to: [{ name: 'Billing', email: 'billing@acme.example' }] });
      expect(row('Reply-To')).toHaveTextContent('Billing <billing@acme.example>');
      expect(row('Reply-To')).toHaveTextContent('Replies go here, not to the sender.');
    });

    it('shows a Reply-To that matches the sender without a warning', async () => {
      await renderHeaders({ reply_to: [{ name: null, email: 'SARAH.CHEN@acme.example' }] });
      expect(row('Reply-To')).toHaveTextContent('SARAH.CHEN@acme.example');
      expect(row('Reply-To')).not.toHaveTextContent('Replies go here');
    });

    it('shows when the message was received, and the sent time only when it differs', async () => {
      await renderHeaders();
      expect(row('Received').querySelector('time')).toHaveAttribute('dateTime', base.received);
      expect(screen.queryByText('Sent', { selector: 'dt' })).toBeNull();
    });

    it('shows both times for a delayed delivery', async () => {
      await renderHeaders({ date: '2026-09-25T10:00:00Z' });
      expect(row('Received').querySelector('time')).toHaveAttribute('dateTime', base.received);
      expect(row('Sent').querySelector('time')).toHaveAttribute('dateTime', '2026-09-25T10:00:00Z');
      expect(row('Sent')).toHaveTextContent('by the sender’s clock');
    });

    it('falls back to the sent time when the server gave no received time', async () => {
      await renderHeaders({ received: null });
      expect(screen.queryByText('Received', { selector: 'dt' })).toBeNull();
      expect(row('Sent').querySelector('time')).toHaveAttribute('dateTime', base.date);
      expect(row('Sent')).not.toHaveTextContent('sender’s clock');
    });

    it('says so when there is no sender', async () => {
      await renderHeaders({ from: [] });
      expect(row('From')).toHaveTextContent('Unknown sender');
    });
  });

  it('shows load errors with a way back', async () => {
    api.getEmail.mockRejectedValue(new Error('Message not found'));
    const onBack = vi.fn();
    render(<EmailReader emailUid={6} onBack={onBack} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Message not found');
    screen.getByRole('button', { name: /Back/ }).click();
    expect(onBack).toHaveBeenCalled();
  });
});

