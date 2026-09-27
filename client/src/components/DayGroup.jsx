import { useId, useState } from 'react';
import DisclosureHeader from './DisclosureHeader';
import { senderName } from '../utils/senders';

export default function DayGroup({ label, emails, selectedUid, onSelectEmail }) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();

  return (
    <div className="border-b border-line-subtle last:border-b-0">
      <DisclosureHeader
        expanded={expanded}
        onToggle={() => setExpanded(!expanded)}
        controls={listId}
        units={['email', 'emails']}
        count={emails.length}
        className="text-ink-muted hover:bg-hover"
      >
        <span>{label}</span>
      </DisclosureHeader>
      {expanded && (
        <ul id={listId} className="pb-1">
          {emails.map((email) => {
            const selected = email.uid === selectedUid;
            return (
              <li key={email.uid}>
                <button
                  type="button"
                  data-closes-sidebar
                  onClick={() => onSelectEmail(email)}
                  aria-label={`${senderName(email.from)}: ${email.subject || '(no subject)'}`}
                  aria-current={selected ? 'true' : undefined}
                  className={`w-full text-left px-3 py-1.5 transition text-sm truncate text-ink-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500 ${
                    selected ? 'bg-selected' : 'hover:bg-hover'
                  }`}
                >
                  <span className="font-medium text-ink">{senderName(email.from)}</span>
                  <span className="text-ink-faint mx-1" aria-hidden="true">-</span>
                  <span>{email.subject || '(no subject)'}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
