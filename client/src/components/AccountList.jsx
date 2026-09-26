import { useId, useState } from 'react';
import DisclosureHeader from './DisclosureHeader';

/**
 * The user's mailboxes: switch between them, add one, or remove one (with an
 * inline confirmation, since removing deletes its remembered emails).
 */
export default function AccountList({ accounts, activeId, onSelect, onAdd, onRemove }) {
  const [expanded, setExpanded] = useState(true);
  const [confirmingId, setConfirmingId] = useState(null);
  const [removeError, setRemoveError] = useState(null);
  const listId = useId();

  const confirmRemove = async (account) => {
    try {
      setRemoveError(null);
      await onRemove(account.id);
      setConfirmingId(null);
    } catch (caught) {
      setRemoveError(`Could not remove ${account.email}: ${caught.message}`);
    }
  };

  return (
    <div className="border-b border-line">
      <DisclosureHeader
        expanded={expanded}
        onToggle={() => setExpanded(!expanded)}
        controls={listId}
        units={['mailbox', 'mailboxes']}
        count={accounts.length}
        className="text-ink-muted hover:bg-hover"
      >
        <span>Mailboxes</span>
      </DisclosureHeader>
      {expanded && (
        <div id={listId} className="pb-2">
          <ul>
            {accounts.map((account) => {
              const active = account.id === activeId;
              if (confirmingId === account.id) {
                return (
                  <li key={account.id} className="px-3 py-2 text-sm bg-danger-bg text-danger-ink" role="group" aria-label={`Remove ${account.email}`}>
                    <p>Remove {account.email}? Its remembered emails will be deleted.</p>
                    <div className="mt-2 flex gap-2">
                      <button
                        type="button"
                        onClick={() => confirmRemove(account)}
                        className="px-2 py-1 rounded bg-red-600 text-white text-xs font-medium hover:bg-red-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                      >
                        Remove
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmingId(null)}
                        className="px-2 py-1 rounded text-xs text-ink-soft hover:bg-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                      >
                        Cancel
                      </button>
                    </div>
                  </li>
                );
              }
              return (
                <li key={account.id} className={`flex items-center group transition ${active ? 'bg-selected' : 'hover:bg-hover'}`}>
                  <button
                    type="button"
                    data-closes-sidebar
                    onClick={() => onSelect(account.id)}
                    aria-current={active ? 'true' : undefined}
                    className="min-w-0 flex-1 text-left pl-3 py-1.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500"
                  >
                    <span className={`block truncate ${active ? 'font-semibold text-ink' : 'text-ink-soft'}`}>
                      {account.email}
                    </span>
                    {!account.connected && (
                      <span className="block text-xs text-ink-muted">Needs password</span>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingId(account.id)}
                    className="shrink-0 w-9 h-9 md:w-7 md:h-7 mr-1 flex items-center justify-center rounded text-xs text-ink-muted hover:text-danger-ink transition md:opacity-0 md:group-hover:opacity-100 focus:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                    title="Remove mailbox"
                    aria-label={`Remove ${account.email}`}
                  >
                    <span aria-hidden="true">{'✕'}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          {removeError && (
            <p role="alert" className="mx-3 mt-1 text-xs text-danger-ink">{removeError}</p>
          )}
          <button
            type="button"
            data-closes-sidebar
            onClick={onAdd}
            className="mt-1 mx-3 text-sm text-accent hover:text-accent-hover rounded px-1 py-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            + Add mailbox
          </button>
        </div>
      )}
    </div>
  );
}
