import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import EmailReader from './EmailReader';
import { sanitizeEmailHtml } from '../utils/emailHtml';

// Mock the api module
vi.mock('../api', () => ({
  getEmail: vi.fn(),
  downloadAttachment: vi.fn(),
  getFolderEmail: vi.fn(),
  downloadFolderAttachment: vi.fn(),
  showInFolder: vi.fn(),
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

  it('leaves the email as it is when the page around it changes', async () => {
    api.getEmail.mockResolvedValue({
      uid: 3,
      subject: 'Links',
      from: [],
      to: [],
      date: null,
      body_html: '<p><a href="https://example.com">here</a></p>',
      body_text: null,
    });
    const { rerender } = render(<EmailReader accountId="a" emailUid={3} onBack={() => {}} onWrite={() => {}} />);
    const link = await screen.findByRole('link', { name: 'here' });
    link.focus();
    // A new onWrite each time, as the page gives it on every render.
    rerender(<EmailReader accountId="a" emailUid={3} onBack={() => {}} onWrite={() => {}} />);
    expect(link.isConnected).toBe(true);
    expect(link).toHaveFocus();
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

  describe('images on request', () => {
    const IMAGES = '<p>Hello</p>'
      + '<img src="https://cdn.test/photo.png" alt="Photo" width="300" onerror="alert(1)" style="border:1px">'
      + '<img src="cid:logo@x" alt="Logo">'
      + '<img src="javascript:alert(1)">'
      + '<img src="data:image/png;base64,iVBORw0KGgo=" alt="Inline">';

    function show(uid, bodyHtml) {
      api.getEmail.mockImplementation(async (_account, requested) => ({
        uid: requested,
        subject: `Message ${requested}`,
        from: [{ name: null, email: 'shop@x.example' }],
        to: [],
        date: null,
        body_html: bodyHtml,
        body_text: null,
      }));
      return render(<EmailReader accountId="a" emailUid={uid} onBack={() => {}} />);
    }

    it('loads images only when asked, without a referrer, and only ones it can load', async () => {
      show(7, IMAGES);
      await screen.findByText('Hello');
      expect(document.querySelector('img')).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'Show images' }));
      const images = [...document.querySelectorAll('article img')];
      expect(images.map((img) => img.getAttribute('src'))).toEqual([
        'https://cdn.test/photo.png',
        'data:image/png;base64,iVBORw0KGgo=',
      ]);
      const [photo] = images;
      expect(photo).toHaveAttribute('referrerpolicy', 'no-referrer');
      expect(photo).toHaveAttribute('alt', 'Photo');
      expect(photo).toHaveAttribute('width', '300');
      expect(photo).not.toHaveAttribute('onerror');
      expect(photo).not.toHaveAttribute('style');
      expect(screen.queryByText(/Images in this email are blocked/)).toBeNull();
    });

    it('leaves no empty paragraph where an image could not be shown', () => {
      const html = sanitizeEmailHtml('<p><img src="cid:logo@x"></p><p>Text <img src="cid:y"></p>', { images: true });
      expect(html).toBe('<p>Text </p>');
    });

    it('blocks images again for the next message', async () => {
      const { rerender } = show(7, IMAGES);
      await screen.findByText('Hello');
      fireEvent.click(screen.getByRole('button', { name: 'Show images' }));
      expect(document.querySelector('article img')).not.toBeNull();

      rerender(<EmailReader accountId="a" emailUid={8} onBack={() => {}} />);
      await screen.findByRole('heading', { name: 'Message 8' });
      expect(document.querySelector('article img')).toBeNull();
      expect(screen.getByRole('button', { name: 'Show images' })).toBeInTheDocument();
    });

    it('offers nothing when no image could be shown anyway', async () => {
      show(9, '<p>Hello</p><img src="cid:logo@x"><img src="javascript:alert(1)">');
      await screen.findByText('Hello');
      expect(screen.queryByText(/Images in this email are blocked/)).toBeNull();
      expect(screen.queryByRole('button', { name: 'Show images' })).toBeNull();
    });
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

  describe('attachments', () => {
    const INVOICE = { index: 0, filename: 'Invoice-1042.pdf', content_type: 'application/pdf', size: 48_000 };
    const ITINERARY = { index: 1, filename: 'Itinerary.ics', content_type: 'text/calendar', size: 300 };

    async function renderWithAttachments(attachments) {
      api.getEmail.mockResolvedValue({
        uid: 12,
        subject: 'Files',
        from: [{ name: null, email: 'a@x.example' }],
        to: [],
        date: null,
        body_html: null,
        body_text: 'See attached',
        attachments,
      });
      render(<EmailReader accountId="acct" emailUid={12} onBack={() => {}} />);
      await screen.findByRole('heading', { name: 'Files' });
    }

    it('lists each attachment with its size, and downloads the one chosen', async () => {
      api.downloadAttachment.mockResolvedValue(null);
      await renderWithAttachments([INVOICE, ITINERARY]);
      const list = screen.getByRole('region', { name: 'Attachments' });
      expect(list).toHaveTextContent('Invoice-1042.pdf47 KB');
      expect(list).toHaveTextContent('Itinerary.ics300 B');

      screen.getByRole('button', { name: 'Download Itinerary.ics, 300 B' }).click();
      await waitFor(() => expect(api.downloadAttachment).toHaveBeenCalledWith('acct', 12, 1));
      // The web app leaves the file to the browser; nothing to report.
      expect(screen.queryByRole('status')).toBeNull();
    });

    it('says where the desktop app saved a file and can show it', async () => {
      api.downloadAttachment.mockResolvedValue({ path: 'C:\\Users\\me\\Downloads\\Invoice-1042 (1).pdf', filename: 'Invoice-1042 (1).pdf' });
      api.showInFolder.mockResolvedValue(undefined);
      await renderWithAttachments([INVOICE]);
      screen.getByRole('button', { name: /^Download Invoice-1042\.pdf/ }).click();
      expect(await screen.findByRole('status')).toHaveTextContent('Saved Invoice-1042 (1).pdf in Downloads.');
      screen.getByRole('button', { name: 'Show in folder' }).click();
      expect(api.showInFolder).toHaveBeenCalledWith('C:\\Users\\me\\Downloads\\Invoice-1042 (1).pdf');
    });

    it('reports a failed download', async () => {
      api.downloadAttachment.mockRejectedValue(new Error('Attachment not found'));
      await renderWithAttachments([INVOICE]);
      screen.getByRole('button', { name: /^Download Invoice-1042\.pdf/ }).click();
      expect(await screen.findByRole('alert')).toHaveTextContent('Could not download Invoice-1042.pdf: Attachment not found');
    });

    it('shows nothing for a message without attachments', async () => {
      await renderWithAttachments([]);
      expect(screen.queryByRole('region', { name: 'Attachments' })).toBeNull();
    });
  });


  describe('in a server folder', () => {
    const TRASHED = {
      uid: 5,
      subject: 'Old news',
      from: [{ name: 'Ann', email: 'ann@x.example' }],
      to: [{ name: null, email: 'me@example.com' }],
      date: null,
      body_html: null,
      body_text: 'Hello',
      message_id: 'old@x.example',
      attachments: [{ index: 0, filename: 'notes.txt', content_type: 'text/plain', size: 5 }],
    };

    it('reads from the folder, downloads from it, and offers to move back to the inbox', async () => {
      api.getFolderEmail.mockResolvedValue(TRASHED);
      api.downloadFolderAttachment.mockResolvedValue(null);
      const onMoveToInbox = vi.fn();
      const onBack = vi.fn();
      render(
        <EmailReader
          accountId="acct"
          emailUid={5}
          folder={{ kind: 'trash', name: 'Deleted Items' }}
          me="me@example.com"
          onReply={() => {}}
          onMoveToInbox={onMoveToInbox}
          onBack={onBack}
        />,
      );
      await screen.findByRole('heading', { name: 'Old news' });
      expect(api.getFolderEmail).toHaveBeenCalledWith('acct', 'trash', 5);
      expect(api.getEmail).not.toHaveBeenCalled();
      // Nothing that moves mail out of the inbox.
      expect(screen.queryByRole('button', { name: /Archive|Delete/ })).toBeNull();

      screen.getByRole('button', { name: /^Download notes\.txt/ }).click();
      await waitFor(() => expect(api.downloadFolderAttachment).toHaveBeenCalledWith('acct', 'trash', 5, 0));

      screen.getByRole('button', { name: /Move to Inbox/ }).click();
      expect(onMoveToInbox).toHaveBeenCalledWith(TRASHED);
      screen.getByRole('button', { name: /Back to Trash/ }).click();
      expect(onBack).toHaveBeenCalled();
    });

    it('offers no move for sent mail, or for a message it could not find again', async () => {
      api.getFolderEmail.mockResolvedValue(TRASHED);
      const props = { accountId: 'acct', emailUid: 5, me: 'me@example.com', onReply: () => {}, onMoveToInbox: () => {}, onBack: () => {} };
      render(<EmailReader {...props} folder={{ kind: 'sent', name: 'Sent' }} />);
      await screen.findByRole('heading', { name: 'Old news' });
      expect(screen.getByRole('button', { name: /Forward/ })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Move to Inbox/ })).toBeNull();
      cleanup();

      api.getFolderEmail.mockResolvedValue({ ...TRASHED, message_id: null });
      render(<EmailReader {...props} folder={{ kind: 'junk', name: 'Spam' }} />);
      await screen.findByRole('heading', { name: 'Old news' });
      expect(screen.queryByRole('button', { name: /Move to Inbox/ })).toBeNull();
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

