import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import AddressBookDialog from './AddressBookDialog';

vi.mock('../api', () => ({
  listContacts: vi.fn(),
  saveContact: vi.fn(),
  deleteContact: vi.fn(),
}));

import * as api from '../api';

const SARAH = { id: 1, name: 'Sarah Chen', email: 'sarah.chen@acme.example', times_sent: 3 };
const SAM = { id: 2, name: null, email: 'sam@x.example', times_sent: 0 };

function renderBook() {
  const onClose = vi.fn();
  render(<AddressBookDialog onClose={onClose} />);
  return { onClose };
}

const rows = () => within(screen.getByRole('list', { name: 'Contacts' })).getAllByRole('listitem');

describe('AddressBookDialog', () => {
  beforeEach(() => {
    api.listContacts.mockResolvedValue([SARAH, SAM]);
    api.saveContact.mockResolvedValue({});
    api.deleteContact.mockResolvedValue({});
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('lists each entry with its full address and how often it was written to', async () => {
    renderBook();
    await screen.findByRole('list', { name: 'Contacts' });
    expect(rows().map((r) => r.textContent)).toEqual([
      'Sarah Chen <sarah.chen@acme.example>sent 3×EditDelete',
      'No name <sam@x.example>EditDelete',
    ]);
  });

  it('explains an empty address book', async () => {
    api.listContacts.mockResolvedValue([]);
    renderBook();
    expect(await screen.findByText(/People you write to, and people whose mail you open, appear here/)).toBeInTheDocument();
  });

  it('adds an entry and clears the form', async () => {
    renderBook();
    await screen.findByRole('list', { name: 'Contacts' });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Dana Lee' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'dana@x.example' } });
    api.listContacts.mockResolvedValue([SARAH, SAM, { id: 3, name: 'Dana Lee', email: 'dana@x.example', times_sent: 0 }]);
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(api.saveContact).toHaveBeenCalledWith({ email: 'dana@x.example', name: 'Dana Lee' });
    expect(screen.getByLabelText('Email')).toHaveValue('');
  });

  it('keeps the form when adding fails', async () => {
    api.saveContact.mockRejectedValue(new Error('Enter a valid email address'));
    renderBook();
    await screen.findByRole('list', { name: 'Contacts' });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'bad@' } });
    fireEvent.submit(screen.getByLabelText('Email').closest('form'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a valid email address');
    expect(screen.getByLabelText('Email')).toHaveValue('bad@');
  });

  it('renames an entry, and Escape cancels an edit without closing', async () => {
    const { onClose } = renderBook();
    await screen.findByRole('list', { name: 'Contacts' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit sam@x.example' }));
    const name = screen.getByLabelText('Name for sam@x.example');
    expect(name).toHaveFocus();
    fireEvent.keyDown(name, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Name for sam@x.example')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Edit sam@x.example' }));
    fireEvent.change(screen.getByLabelText('Name for sam@x.example'), { target: { value: 'Sam Smith' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.saveContact).toHaveBeenCalledWith({ email: 'sam@x.example', name: 'Sam Smith' }));
    await waitFor(() => expect(screen.queryByLabelText('Name for sam@x.example')).toBeNull());
  });

  it('deletes an entry', async () => {
    renderBook();
    await screen.findByRole('list', { name: 'Contacts' });
    api.listContacts.mockResolvedValue([SAM]);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Sarah Chen <sarah.chen@acme.example>' }));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(api.deleteContact).toHaveBeenCalledWith(1);
  });

  it('filters by name or address', async () => {
    renderBook();
    await screen.findByRole('list', { name: 'Contacts' });
    fireEvent.change(screen.getByLabelText('Search the address book'), { target: { value: 'CHEN' } });
    expect(rows()).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Search the address book'), { target: { value: 'x.example' } });
    expect(rows()[0]).toHaveTextContent('sam@x.example');
    fireEvent.change(screen.getByLabelText('Search the address book'), { target: { value: 'zzz' } });
    expect(screen.getByText('No one matches “zzz”.')).toBeInTheDocument();
  });

  it('reports a failure to load', async () => {
    api.listContacts.mockRejectedValue(new Error('offline'));
    renderBook();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the address book: offline');
  });

  it('closes with Escape', async () => {
    const { onClose } = renderBook();
    await screen.findByRole('list', { name: 'Contacts' });
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Address book' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('still closes with Escape after the focused row was deleted', async () => {
    const { onClose } = renderBook();
    await screen.findByRole('list', { name: 'Contacts' });
    api.listContacts.mockResolvedValue([SAM]);
    const button = screen.getByRole('button', { name: 'Delete Sarah Chen <sarah.chen@acme.example>' });
    button.focus();
    fireEvent.click(button);
    await waitFor(() => expect(rows()).toHaveLength(1));
    // The button is gone, so focus is on the page body now.
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
