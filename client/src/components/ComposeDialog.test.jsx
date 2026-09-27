import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import ComposeDialog from './ComposeDialog';

function renderCompose(props = {}) {
  const handlers = {
    onSend: vi.fn().mockResolvedValue({ message_id: 'id@x', saved_to_sent: true }),
    onSent: vi.fn(),
    onClose: vi.fn(),
  };
  render(<ComposeDialog from="me@example.com" {...handlers} {...props} />);
  return { ...handlers, ...props };
}

const to = () => screen.getByLabelText('To');
const type = (input, text) => fireEvent.change(input, { target: { value: text } });
const dialog = () => screen.getByRole('dialog', { name: 'New message' });

describe('ComposeDialog', () => {
  afterEach(cleanup);

  it('opens with the To field focused and the sending address shown', () => {
    renderCompose();
    expect(to()).toHaveFocus();
    expect(dialog()).toHaveTextContent('Fromme@example.com');
  });

  it('turns typed addresses into chips that show the full address', () => {
    renderCompose();
    type(to(), 'Sarah Chen <sarah@acme.example>');
    fireEvent.keyDown(to(), { key: 'Enter' });
    const chips = screen.getByRole('list', { name: 'To recipients' });
    expect(chips).toHaveTextContent('Sarah Chen <sarah@acme.example>');
    expect(to()).toHaveValue('');

    // Comma, Tab, and leaving the field commit too; duplicates are ignored.
    type(to(), 'bob@acme.example');
    fireEvent.keyDown(to(), { key: ',' });
    type(to(), 'SARAH@acme.example');
    fireEvent.blur(to());
    expect(within(chips).getAllByRole('listitem')).toHaveLength(2);
  });

  it('splits a pasted list and keeps what it cannot read', () => {
    renderCompose();
    type(to(), 'a@x.example, "Chen, Sarah" <s@x.example>; nonsense, ');
    const chips = screen.getByRole('list', { name: 'To recipients' });
    expect(within(chips).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'a@x.example×',
      'Chen, Sarah <s@x.example>×',
    ]);
    expect(to()).toHaveValue('nonsense');
    expect(screen.getByRole('alert')).toHaveTextContent('“nonsense” is not a valid email address');
    expect(to()).toHaveAttribute('aria-invalid', 'true');
  });

  it('removes chips with their button or Backspace', () => {
    renderCompose();
    type(to(), 'a@x.example, b@x.example, ');
    fireEvent.click(screen.getByRole('button', { name: 'Remove a@x.example' }));
    expect(screen.getByRole('list', { name: 'To recipients' })).not.toHaveTextContent('a@x.example');
    fireEvent.keyDown(to(), { key: 'Backspace' });
    expect(screen.queryByRole('list', { name: 'To recipients' })).toBeNull();
  });

  it('sends everything written, including an address still being typed', async () => {
    const { onSend, onSent } = renderCompose();
    type(to(), 'a@x.example, ');
    type(to(), 'Bob <bob@x.example>');
    fireEvent.click(screen.getByRole('button', { name: 'Cc' }));
    await waitFor(() => expect(screen.getByLabelText('Cc')).toHaveFocus());
    type(screen.getByLabelText('Cc'), 'cc@x.example');
    fireEvent.click(screen.getByRole('button', { name: 'Bcc' }));
    type(screen.getByLabelText('Bcc'), 'hidden@x.example');
    type(screen.getByLabelText('Subject'), 'Plans');
    type(screen.getByLabelText('Message'), 'Line one\nLine two');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(onSent).toHaveBeenCalled());
    const request = {
      to: [{ name: null, email: 'a@x.example' }, { name: 'Bob', email: 'bob@x.example' }],
      cc: [{ name: null, email: 'cc@x.example' }],
      bcc: [{ name: null, email: 'hidden@x.example' }],
      subject: 'Plans',
      body: 'Line one\nLine two',
      in_reply_to: null,
      references: [],
      attachments: [],
      forward: null,
    };
    expect(onSend).toHaveBeenCalledWith(request);
    expect(onSent).toHaveBeenCalledWith({ message_id: 'id@x', saved_to_sent: true }, request);
  });

  it('will not send without a recipient', () => {
    const { onSend } = renderCompose();
    type(screen.getByLabelText('Subject'), 'Hi');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Add at least one recipient');
    expect(to()).toHaveFocus();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('will not send while an address is unreadable', () => {
    const { onSend } = renderCompose();
    type(to(), 'good@x.example, bad@');
    type(screen.getByLabelText('Subject'), 'Hi');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.getByRole('alert')).toHaveTextContent('“bad@” is not a valid email address');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('asks before sending without a subject', async () => {
    const { onSend } = renderCompose();
    type(to(), 'a@x.example');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    const question = screen.getByRole('group', { name: 'Send without a subject?' });
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.click(within(question).getByRole('button', { name: 'Add a subject' }));
    expect(screen.queryByRole('group', { name: 'Send without a subject?' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send anyway' }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ subject: '' })));
  });

  it('shows a failed send and allows another try', async () => {
    const onSend = vi.fn()
      .mockRejectedValueOnce(new Error('The mail server refused the message: 550'))
      .mockResolvedValue({ message_id: 'x', saved_to_sent: true });
    const { onSent } = renderCompose({ onSend });
    type(to(), 'a@x.example');
    type(screen.getByLabelText('Subject'), 'Hi');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('refused the message: 550');
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(onSent).toHaveBeenCalled());
  });

  it('disables sending while a send is in progress', async () => {
    const onSend = vi.fn(() => new Promise(() => {}));
    renderCompose({ onSend });
    type(to(), 'a@x.example');
    type(screen.getByLabelText('Subject'), 'Hi');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('button', { name: 'Sending…' })).toBeDisabled();
    fireEvent.keyDown(dialog(), { key: 'Enter', ctrlKey: true });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('sends with Ctrl+Enter', async () => {
    const { onSend } = renderCompose();
    type(to(), 'a@x.example');
    type(screen.getByLabelText('Subject'), 'Hi');
    fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(onSend).toHaveBeenCalled());
  });

  it('closes at once when nothing was written', () => {
    const { onClose } = renderCompose();
    fireEvent.keyDown(dialog(), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('asks before discarding a draft', () => {
    const { onClose } = renderCompose();
    type(screen.getByLabelText('Message'), 'Half a thought');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    const question = screen.getByRole('group', { name: 'Discard this message?' });
    fireEvent.click(within(question).getByRole('button', { name: 'Keep editing' }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Message')).toHaveValue('Half a thought');

    fireEvent.keyDown(dialog(), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(onClose).toHaveBeenCalled();
  });

  describe('attachments', () => {
    const file = (name, content, type = 'text/plain') => new File([content], name, { type });
    const attach = (...files) => fireEvent.change(screen.getByLabelText('Attach files'), { target: { files } });
    const attached = () => screen.queryByRole('list', { name: 'Attachments' });

    it('attaches files, lists them with sizes, and sends them base64-encoded', async () => {
      const { onSend } = renderCompose();
      type(to(), 'a@x.example');
      type(screen.getByLabelText('Subject'), 'Files');
      attach(file('notes.txt', 'hello'), file('photo.jpg', new Uint8Array([0xff, 0xd8]), ''));
      await waitFor(() => expect(within(attached()).getAllByRole('listitem')).toHaveLength(2));
      expect(attached()).toHaveTextContent('notes.txt5 B');

      fireEvent.click(screen.getByRole('button', { name: 'Remove attachment photo.jpg' }));
      attach(file('photo.jpg', new Uint8Array([0xff, 0xd8]), ''));
      await waitFor(() => expect(within(attached()).getAllByRole('listitem')).toHaveLength(2));
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));

      await waitFor(() => expect(onSend).toHaveBeenCalled());
      expect(onSend.mock.calls[0][0]).toMatchObject({
        attachments: [
          { filename: 'notes.txt', content_type: 'text/plain', data: btoa('hello') },
          { filename: 'photo.jpg', content_type: 'application/octet-stream', data: btoa('\xff\xd8') },
        ],
        forward: null,
      });
    });

    it('refuses more than 25 MB in all', async () => {
      const { onSend } = renderCompose();
      // Sizes are checked before anything is read, so stand-ins will do.
      const sized = (name, megabytes) => {
        const stand_in = new File(['x'], name);
        Object.defineProperty(stand_in, 'size', { value: megabytes * 1024 * 1024 });
        return stand_in;
      };
      attach(sized('big.bin', 20));
      await waitFor(() => expect(attached()).not.toBeNull());
      attach(sized('huge.bin', 6));
      expect(await screen.findByRole('alert')).toHaveTextContent('Attachments can total at most 25 MB');
      expect(within(attached()).getAllByRole('listitem')).toHaveLength(1);
      expect(onSend).not.toHaveBeenCalled();
    });

    it("sends a forward's original attachments unless removed", async () => {
      const { onSend } = renderCompose({
        title: 'Forward',
        initial: {
          subject: 'Fwd: Invoice',
          forward_uid: 994,
          attachments: [
            { index: 0, filename: 'Invoice.pdf', content_type: 'application/pdf', size: 2048 },
            { index: 1, filename: 'Receipt.pdf', content_type: 'application/pdf', size: 1024 },
          ],
        },
      });
      expect(attached()).toHaveTextContent('Invoice.pdf2 KB');
      fireEvent.click(screen.getByRole('button', { name: 'Remove attachment Invoice.pdf' }));
      type(to(), 'a@x.example');
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      await waitFor(() => expect(onSend).toHaveBeenCalled());
      expect(onSend.mock.calls[0][0]).toMatchObject({ attachments: [], forward: { uid: 994, indexes: [1] } });
    });

    it('counts attachments as unsaved work', async () => {
      const { onClose } = renderCompose();
      attach(file('notes.txt', 'hello'));
      await waitFor(() => expect(attached()).not.toBeNull());
      fireEvent.keyDown(screen.getByRole('dialog', { name: 'New message' }), { key: 'Escape' });
      expect(screen.getByRole('group', { name: 'Discard this message?' })).toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  it('pre-fills a reply and puts the cursor at the top of the body', () => {
    renderCompose({
      title: 'Reply',
      initial: {
        to: [{ name: 'Sarah', email: 's@x.example' }],
        cc: [{ name: null, email: 'c@x.example' }],
        subject: 'Re: Plans',
        body: '\n\n> quoted',
        in_reply_to: 'orig@x',
        references: ['orig@x'],
        focus: 'body',
      },
    });
    const body = screen.getByLabelText('Message');
    expect(body).toHaveFocus();
    expect(body.selectionStart).toBe(0);
    expect(screen.getByRole('list', { name: 'Cc recipients' })).toHaveTextContent('c@x.example');
    // Untouched, a pre-filled reply closes without asking.
    const onClose = vi.fn();
    cleanup();
    renderCompose({ title: 'Reply', initial: { to: [{ name: null, email: 's@x.example' }], subject: 'Re: x' }, onClose });
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Reply' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
