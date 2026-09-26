import { useId, useState } from 'react';
import DisclosureHeader from './DisclosureHeader';

export default function RememberedList({ remembered, selectedUid, onForget, onSelect }) {
  const [expanded, setExpanded] = useState(true);
  const listId = useId();

  if (remembered.length === 0) return null;

  return (
    <div className="border-b border-line">
      <DisclosureHeader
        expanded={expanded}
        onToggle={() => setExpanded(!expanded)}
        controls={listId}
        count={remembered.length}
        className="text-star hover:bg-star-soft"
      >
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true">{'★'}</span>
          Remembered
        </span>
      </DisclosureHeader>
      {expanded && (
        <ul id={listId} className="pb-1">
          {remembered.map((r) => {
            const subject = r.subject || '(no subject)';
            const selected = r.email_uid === selectedUid;
            return (
              <li
                key={r.id}
                className={`flex items-center group transition ${selected ? 'bg-selected' : 'hover:bg-star-soft'}`}
              >
                <button
                  type="button"
                  data-closes-sidebar
                  onClick={() => onSelect(r.email_uid)}
                  aria-current={selected ? 'true' : undefined}
                  className="min-w-0 flex-1 text-left text-sm truncate pl-3 py-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500"
                >
                  <span className="font-medium text-ink">{r.sender || 'Unknown'}</span>
                  <span className="text-ink-faint mx-1" aria-hidden="true">-</span>
                  <span className="text-ink-soft">{subject}</span>
                </button>
                <button
                  type="button"
                  onClick={() => onForget(r.email_uid)}
                  className="shrink-0 w-9 h-9 md:w-7 md:h-7 mr-1 flex items-center justify-center rounded text-xs text-ink-muted hover:text-danger-ink transition md:opacity-0 md:group-hover:opacity-100 focus:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                  title="Forget this"
                  aria-label={`Forget “${subject}”`}
                >
                  <span aria-hidden="true">{'✕'}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
