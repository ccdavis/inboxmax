import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import ComposeDialog from './ComposeDialog';

const DRAFT_ID = '55555555-5555-4555-8555-555555555555';

function renderCompose(props = {}) {
  const handlers = {
    onSaveDraft: vi.fn().mockResolvedValue(undefined),
    onDeleteDraft: vi.fn().mockResolvedValue(undefined),
    onSend: vi.fn().mockResolvedValue({ message_id: 'm@x', saved_to_sent: true }),
    onSent: vi.fn(),
    onClose: vi.fn(),
    ...props,
  };
  render(<ComposeDialog from="me@example.com" draftId={DRAFT_ID} {...handlers} />);
  return handlers;
}

const type = (label, text) => fireEvent.change(screen.getByLabelText(label, { exact: true }), { target: { value: text } });
const dialog = () => screen.getByRole('dialog');

describe('drafts', () => {
  afterEach(cleanup);

  it('saves what is written a moment after typing stops', async () => {
    const { onSaveDraft } = renderCompose();
    type('To', 'a@x.example, ');
    type('To', 'half-typed');
    type('Subject', 'Plans');
    type('Message', 'Draft body');
    expect(onSaveDraft).not.toHaveBeenCalled();

    await waitFor(() => expect(onSaveDraft).toHaveBeenCalledTimes(1), { timeout: 2500 });
    expect(onSaveDraft).toHaveBeenCalledWith({
      title: 'New message',
      to: [{ name: null, email: 'a@x.example' }],
      cc: [],
      bcc: [],
      pending: { to: 'half-typed', cc: '', bcc: '' },
      subject: 'Plans',
      body: 'Draft body',
      in_reply_to: null,
      references: [],
      attachments: [],
      forward_uid: null,
      forward_folder: null,
    });
    expect(await within(dialog()).findByText('Draft saved')).toBeInTheDocument();
  });

  it('does not save a message nobody has written in', async () => {
    const { onSaveDraft, onClose } = renderCompose({ initial: { subject: 'Re: x', body: '\n\n> quote', focus: 'body' } });
    await new Promise((resolve) => { setTimeout(resolve, 1300); });
    expect(onSaveDraft).not.toHaveBeenCalled();
    fireEvent.keyDown(dialog(), { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalledWith({ draftSaved: false }));
  });

  it('closing keeps the message as a draft, without asking', async () => {
    const { onSaveDraft, onClose } = renderCompose();
    type('Message', 'Unfinished');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('group', { name: 'Discard this message?' })).toBeNull();
    await waitFor(() => expect(onClose).toHaveBeenCalledWith({ draftSaved: true }));
    expect(onSaveDraft).toHaveBeenCalledWith(expect.objectContaining({ body: 'Unfinished' }));
  });

  it('stays open, and says so, when the draft cannot be saved', async () => {
    const { onClose } = renderCompose({ onSaveDraft: vi.fn().mockRejectedValue(new Error('The draft is too large to save')) });
    type('Message', 'Unfinished');
    fireEvent.keyDown(dialog(), { key: 'Escape' });
    expect(await within(dialog()).findByText('Draft not saved: The draft is too large to save')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Message')).toHaveValue('Unfinished');
  });

  it('Discard deletes a saved draft after asking', async () => {
    const { onDeleteDraft, onClose } = renderCompose({ fromDraft: true, initial: { body: 'Saved earlier' } });
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    const question = screen.getByRole('group', { name: 'Discard this message?' });
    expect(question).toHaveTextContent('Discard this message and delete its draft?');
    fireEvent.click(within(question).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledWith({ draftSaved: false }));
    expect(onDeleteDraft).toHaveBeenCalled();
  });

  it('keeps the draft when deleting it fails', async () => {
    const { onClose } = renderCompose({
      fromDraft: true,
      initial: { body: 'Saved earlier' },
      onDeleteDraft: vi.fn().mockRejectedValue(new Error('offline')),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Discard this message?' })).getByRole('button', { name: 'Discard' }));
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent('Could not delete the draft: offline');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('reopens a draft exactly as it was left', async () => {
    const { onSaveDraft, onClose } = renderCompose({
      title: 'Forward',
      fromDraft: true,
      initial: {
        title: 'Forward',
        to: [{ name: 'Sarah', email: 's@x.example' }],
        cc: [{ name: null, email: 'c@x.example' }],
        bcc: [],
        pending: { to: 'bob@', cc: '', bcc: '' },
        subject: 'Fwd: Invoice',
        body: 'FYI',
        forward_uid: 994,
        attachments: [
          { index: 1, filename: 'Receipt.pdf', content_type: 'application/pdf', size: 1024 },
          { filename: 'notes.txt', content_type: 'text/plain', size: 5, data: btoa('hello') },
        ],
      },
    });
    expect(screen.getByRole('list', { name: 'To recipients' })).toHaveTextContent('Sarah <s@x.example>');
    expect(screen.getByLabelText('To', { exact: true })).toHaveValue('bob@');
    expect(screen.getByRole('list', { name: 'Cc recipients' })).toHaveTextContent('c@x.example');
    expect(screen.getByRole('list', { name: 'Attachments' })).toHaveTextContent('Receipt.pdf');
    expect(screen.getByRole('list', { name: 'Attachments' })).toHaveTextContent('notes.txt');

    // Unchanged, it closes without saving again and is still a draft.
    fireEvent.keyDown(dialog(), { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalledWith({ draftSaved: true }));
    expect(onSaveDraft).not.toHaveBeenCalled();
  });

  it('sends with the draft id, after any save in flight, and saves nothing afterwards', async () => {
    let finishSave;
    const onSaveDraft = vi.fn(() => new Promise((resolve) => { finishSave = resolve; }));
    const { onSend } = renderCompose({ onSaveDraft });
    type('To', 'a@x.example');
    type('Subject', 'Hello');
    await waitFor(() => expect(onSaveDraft).toHaveBeenCalledTimes(1), { timeout: 2500 });

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    expect(onSend).not.toHaveBeenCalled();
    finishSave();
    await waitFor(() => expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ draft_id: DRAFT_ID })));
    await new Promise((resolve) => { setTimeout(resolve, 1300); });
    expect(onSaveDraft).toHaveBeenCalledTimes(1);
  });
});
