import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import FoldersList from './FoldersList';
import FolderView from './FolderView';

vi.mock('../api', () => ({
  listFolders: vi.fn(),
  getFolderEmails: vi.fn(),
}));

import * as api from '../api';

const FOLDERS = [
  { kind: 'sent', name: 'Sent' },
  { kind: 'junk', name: 'Spam' },
  { kind: 'archive', name: '[Gmail]/All Mail' },
];

describe('FoldersList', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  const toggle = () => screen.getByRole('button', { name: /Server folders/ });

  it('stays folded away, and asks the server only when opened', async () => {
    api.listFolders.mockResolvedValue(FOLDERS);
    const onOpen = vi.fn();
    render(<FoldersList accountId="a" onOpen={onOpen} />);
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(api.listFolders).not.toHaveBeenCalled();

    fireEvent.click(toggle());
    const junk = await screen.findByRole('button', { name: /Junk/ });
    expect(api.listFolders).toHaveBeenCalledWith('a');
    expect(toggle()).toHaveAccessibleName(/^Server folders,\s*3\s*folders$/);
    // The server's own name shows where it differs from the app's.
    expect(junk).toHaveTextContent('Junk(Spam)');
    expect(screen.getByRole('button', { name: /^Sent$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Archive/ })).toHaveTextContent('[Gmail]/All Mail');

    fireEvent.click(junk);
    expect(onOpen).toHaveBeenCalledWith(FOLDERS[1]);
  });

  it('marks the open folder', async () => {
    api.listFolders.mockResolvedValue(FOLDERS);
    render(<FoldersList accountId="a" activeKind="sent" onOpen={() => {}} />);
    fireEvent.click(toggle());
    expect(await screen.findByRole('button', { name: /^Sent$/ })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: /Junk/ })).not.toHaveAttribute('aria-current');
  });

  it('reports a failure and can try again', async () => {
    api.listFolders.mockRejectedValueOnce(new Error('Server unreachable'));
    api.listFolders.mockResolvedValueOnce(FOLDERS);
    render(<FoldersList accountId="a" onOpen={() => {}} />);
    fireEvent.click(toggle());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load folders: Server unreachable');
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: /Junk/ })).toBeInTheDocument();
  });

  it('says when the server has no folders', async () => {
    api.listFolders.mockResolvedValue([]);
    render(<FoldersList accountId="a" onOpen={() => {}} />);
    fireEvent.click(toggle());
    expect(await screen.findByText('The mail server has no other folders.')).toBeInTheDocument();
  });

  it('loads the folders of the mailbox switched to', async () => {
    api.listFolders.mockResolvedValue(FOLDERS);
    const { rerender } = render(<FoldersList accountId="a" onOpen={() => {}} />);
    fireEvent.click(toggle());
    await screen.findByRole('button', { name: /Junk/ });
    api.listFolders.mockResolvedValue([{ kind: 'trash', name: 'Trash' }]);
    rerender(<FoldersList accountId="b" onOpen={() => {}} />);
    expect(await screen.findByRole('button', { name: /Trash/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Junk/ })).toBeNull();
    expect(api.listFolders).toHaveBeenLastCalledWith('b');
  });
});

describe('FolderView', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  const JUNK = { kind: 'junk', name: 'Spam' };
  const PRIZE = { uid: 1, subject: 'You have won!', from: 'Prize Desk', date: null, message_id: 'p@x' };

  it('lists the folder and opens a message', async () => {
    api.getFolderEmails.mockResolvedValue([PRIZE, { ...PRIZE, uid: 2, subject: '' }]);
    const onSelect = vi.fn();
    render(<FolderView accountId="a" folder={JUNK} onSelect={onSelect} onBack={() => {}} />);
    const list = await screen.findByRole('list', { name: 'Messages in Junk' });
    expect(api.getFolderEmails).toHaveBeenCalledWith('a', 'junk');
    expect(screen.getByRole('heading')).toHaveTextContent('Junk(Spam)2 messages');
    expect(within(list).getByRole('button', { name: 'Prize Desk: (no subject)' })).toBeInTheDocument();

    fireEvent.click(within(list).getByRole('button', { name: 'Prize Desk: You have won!' }));
    expect(onSelect).toHaveBeenCalledWith(PRIZE);
  });

  it('says when a folder is empty, and refreshes on request', async () => {
    api.getFolderEmails.mockResolvedValueOnce([]);
    api.getFolderEmails.mockResolvedValueOnce([PRIZE]);
    render(<FolderView accountId="a" folder={JUNK} onSelect={() => {}} onBack={() => {}} />);
    expect(await screen.findByText('Nothing in Junk.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Junk' }));
    expect(await screen.findByRole('button', { name: 'Prize Desk: You have won!' })).toBeInTheDocument();
  });

  it('reports a folder that cannot be opened, with a way back', async () => {
    api.getFolderEmails.mockRejectedValue(new Error('The mail server has no Junk folder'));
    const onBack = vi.fn();
    render(<FolderView accountId="a" folder={JUNK} onSelect={() => {}} onBack={onBack} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not open Junk: The mail server has no Junk folder');
    fireEvent.click(screen.getByRole('button', { name: /Inbox/ }));
    await waitFor(() => expect(onBack).toHaveBeenCalled());
  });
});
