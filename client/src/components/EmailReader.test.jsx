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
      from: 'sender@example.com',
      to: 'me@example.com',
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
      from: 'sender@example.com',
      to: 'me@example.com',
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
      from: 'sender@example.com',
      to: 'me@example.com',
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
      from: 'sender@example.com',
      to: 'me@example.com',
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
      from: 'sender@example.com',
      to: 'me@example.com',
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

  it('shows load errors with a way back', async () => {
    api.getEmail.mockRejectedValue(new Error('Message not found'));
    const onBack = vi.fn();
    render(<EmailReader emailUid={6} onBack={onBack} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Message not found');
    screen.getByRole('button', { name: /Back/ }).click();
    expect(onBack).toHaveBeenCalled();
  });
});

