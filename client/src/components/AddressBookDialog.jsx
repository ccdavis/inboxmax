import { useCallback, useEffect, useId, useRef, useState } from 'react';
import * as api from '../api';
import Dialog from './Dialog';
import Spinner from './Spinner';
import { formatAddress } from '../utils/addresses';
import { mayMoveFocus } from '../utils/focus';

const INPUT =
  'min-w-0 rounded-lg border border-line bg-field px-3 py-1.5 text-sm text-ink placeholder-ink-faint focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent';
const SMALL_BUTTON =
  'rounded px-2 py-1 text-xs text-ink-muted hover:bg-hover hover:text-ink transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500';
const PRIMARY_BUTTON =
  'rounded-lg bg-gradient-to-r from-indigo-500 to-violet-500 px-3 py-1.5 text-sm font-medium text-white hover:from-indigo-600 hover:to-violet-600 disabled:opacity-50 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500';

function matches(contact, filter) {
  const needle = filter.trim().toLowerCase();
  return !needle || contact.email.toLowerCase().includes(needle) || (contact.name ?? '').toLowerCase().includes(needle);
}

function ContactRow({ contact, onRename, onDelete }) {
  const [draft, setDraft] = useState(null);
  const inputId = useId();
  const label = formatAddress(contact);
  // Saving or cancelling a rename puts focus back on Edit.
  const editRef = useRef(null);
  const wasEditing = useRef(false);
  useEffect(() => {
    if (draft == null && wasEditing.current) editRef.current?.focus();
    wasEditing.current = draft != null;
  }, [draft]);

  if (draft != null) {
    const save = async (e) => {
      e.preventDefault();
      if (await onRename(contact, draft)) setDraft(null);
    };
    return (
      <li className="px-4 py-2">
        <form onSubmit={save} className="flex flex-wrap items-center gap-2">
          <label htmlFor={inputId} className="sr-only">Name for {contact.email}</label>
          <input
            id={inputId}
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Escape cancels the edit, not the whole dialog.
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setDraft(null);
              }
            }}
            placeholder="Name"
            className={`${INPUT} flex-1`}
          />
          <span className="text-sm text-ink-muted break-all">&lt;{contact.email}&gt;</span>
          <button type="submit" className={SMALL_BUTTON}>Save</button>
          <button type="button" onClick={() => setDraft(null)} className={SMALL_BUTTON}>Cancel</button>
        </form>
      </li>
    );
  }

  return (
    <li className="flex items-center gap-3 px-4 py-2 hover:bg-hover">
      <div className="min-w-0 flex-1 text-sm">
        <span className={contact.name ? 'font-medium text-ink' : 'italic text-ink-muted'}>
          {contact.name || 'No name'}
        </span>{' '}
        <span className="text-ink-muted break-all">&lt;{contact.email}&gt;</span>
      </div>
      {contact.times_sent > 0 && (
        <span className="shrink-0 text-xs text-ink-muted">
          sent {contact.times_sent}×
        </span>
      )}
      <button ref={editRef} type="button" onClick={() => setDraft(contact.name ?? '')} className={SMALL_BUTTON} aria-label={`Edit ${label}`}>
        Edit
      </button>
      <button type="button" onClick={() => onDelete(contact)} className={`${SMALL_BUTTON} hover:text-danger-ink`} aria-label={`Delete ${label}`}>
        Delete
      </button>
    </li>
  );
}

/**
 * The address book: everyone written to or read from, with their full
 * address. Entries can be added, renamed (a name set here is kept even when
 * mail shows another), and deleted.
 */
export default function AddressBookDialog({ onClose }) {
  const [contacts, setContacts] = useState(null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('');
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [adding, setAdding] = useState(false);
  const filterId = useId();
  const nameId = useId();
  const emailId = useId();

  const load = useCallback(async () => {
    try {
      setContacts(await api.listContacts());
    } catch (caught) {
      setError(`Could not load the address book: ${caught.message}`);
      setContacts((current) => current ?? []);
    }
  }, []);

  useEffect(() => {
    // load() sets state only after awaiting the request.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const run = async (action) => {
    setError(null);
    try {
      await action();
      await load();
      return true;
    } catch (caught) {
      setError(caught.message);
      return false;
    }
  };

  const add = async (e) => {
    e.preventDefault();
    setAdding(true);
    if (await run(() => api.saveContact({ email: newEmail, name: newName }))) {
      setNewName('');
      setNewEmail('');
    }
    setAdding(false);
  };

  const shown = (contacts ?? []).filter((contact) => matches(contact, filter));

  const [spoken, setSpoken] = useState('');
  const listRef = useRef(null);
  const filterRef = useRef(null);
  // The row whose place focus goes to once the list has reloaded.
  const focusAfterDelete = useRef(null);
  useEffect(() => {
    const index = focusAfterDelete.current;
    if (index == null) return;
    focusAfterDelete.current = null;
    // Only if its buttons took the focus with them (the reload may also
    // come much later, after a failed one, when focus is elsewhere).
    if (!mayMoveFocus(listRef.current)) return;
    const rows = listRef.current?.querySelectorAll('li') ?? [];
    const row = rows[Math.min(index, rows.length - 1)];
    (row?.querySelector('button') ?? filterRef.current)?.focus();
  }, [contacts]);

  return (
    <Dialog title="Address book" onClose={onClose} className="sm:max-w-2xl">
      <form onSubmit={add} className="flex flex-wrap items-end gap-2 border-b border-line px-4 py-3">
        <div className="flex min-w-[8rem] flex-1 flex-col gap-1">
          <label htmlFor={nameId} className="text-xs text-ink-muted">Name</label>
          <input id={nameId} value={newName} onChange={(e) => setNewName(e.target.value)} className={INPUT} autoComplete="off" />
        </div>
        <div className="flex min-w-[12rem] flex-[2] flex-col gap-1">
          <label htmlFor={emailId} className="text-xs text-ink-muted">Email</label>
          <input
            id={emailId}
            type="email"
            required
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            className={INPUT}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
          />
        </div>
        <button type="submit" disabled={adding} className={PRIMARY_BUTTON}>Add</button>
      </form>

      <div className="border-b border-line px-4 py-2">
        <label htmlFor={filterId} className="sr-only">Search the address book</label>
        <input
          id={filterId}
          ref={filterRef}
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search the address book"
          className={`${INPUT} w-full`}
        />
      </div>

      <p role="status" className="sr-only">{spoken}</p>
      {error && (
        <p role="alert" className="mx-4 mt-3 rounded-lg border border-danger-line bg-danger-bg px-3 py-2 text-sm text-danger-ink">
          {error}
        </p>
      )}

      <div className="min-h-[12rem] flex-1 overflow-y-auto py-1">
        {contacts == null ? (
          <div className="flex justify-center py-8"><Spinner label="Loading the address book" /></div>
        ) : shown.length ? (
          <ul ref={listRef} aria-label="Contacts">
            {shown.map((contact, index) => (
              <ContactRow
                key={contact.id}
                contact={contact}
                onRename={(c, name) => run(() => api.saveContact({ email: c.email, name }))}
                onDelete={async (c) => {
                  // Its buttons go with it: focus moves on to the next one
                  // (or the search) when the list has reloaded.
                  focusAfterDelete.current = index;
                  if (await run(() => api.deleteContact(c.id))) {
                    setSpoken(`Deleted ${formatAddress(c)}`);
                  } else {
                    focusAfterDelete.current = null;
                  }
                }}
              />
            ))}
          </ul>
        ) : (
          <p className="px-4 py-8 text-center text-sm text-ink-muted">
            {contacts.length
              ? `No one matches “${filter.trim()}”.`
              : 'No one yet. People you write to, and people whose mail you open, appear here.'}
          </p>
        )}
      </div>
    </Dialog>
  );
}
