import { useId, useState } from 'react';
import DisclosureHeader from './DisclosureHeader';

function recipients(draft) {
  if (!draft.to?.length) return 'No recipients';
  return draft.to.map((a) => a.name || a.email).join(', ');
}

/** Messages being written in this mailbox; choosing one reopens it. */
export default function DraftsList({ drafts, onOpen }) {
  const [expanded, setExpanded] = useState(true);
  const listId = useId();

  if (drafts.length === 0) return null;

  return (
    <div className="border-b border-line">
      <DisclosureHeader
        expanded={expanded}
        onToggle={() => setExpanded(!expanded)}
        controls={listId}
        units={['draft', 'drafts']}
        count={drafts.length}
        className="text-ink-muted hover:bg-hover"
      >
        <span>Drafts</span>
      </DisclosureHeader>
      {expanded && (
        <ul id={listId} className="pb-1">
          {drafts.map((draft) => (
            <li key={draft.id}>
              <button
                type="button"
                data-closes-sidebar
                onClick={() => onOpen(draft)}
                aria-label={`${recipients(draft)}: ${draft.subject || '(no subject)'}`}
                className="w-full truncate px-3 py-1.5 text-left text-sm hover:bg-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500"
              >
                <span className="font-medium text-ink">{recipients(draft)}</span>
                <span className="mx-1 text-ink-faint" aria-hidden="true">-</span>
                <span className={draft.subject ? 'text-ink-soft' : 'italic text-ink-muted'}>
                  {draft.subject || '(no subject)'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
