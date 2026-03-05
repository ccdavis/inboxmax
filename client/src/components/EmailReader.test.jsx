import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import EmailReader from './EmailReader';

// Mock the api module
vi.mock('../api', () => ({
  getEmail: vi.fn(),
}));

import * as api from '../api';

describe('EmailReader', () => {
  beforeEach(() => {
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

  it('does not add target to non-link elements', async () => {
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

    const links = document.querySelectorAll('a[target="_blank"]');
    // Only the "Back to inbox" button link should exist, not email body links
    for (const link of links) {
      expect(link.textContent).not.toBe('No links here');
    }
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
});
