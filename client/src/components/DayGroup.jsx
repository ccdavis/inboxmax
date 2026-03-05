import { useState } from 'react';
import EmailRow from './EmailRow';

export default function DayGroup({ label, emails, onSelectEmail }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border-b border-slate-100 last:border-b-0">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold text-slate-500 uppercase tracking-wider hover:bg-slate-50 transition"
      >
        <span>{label}</span>
        <span className="flex items-center gap-1.5">
          <span className="text-slate-400 font-normal normal-case text-xs">{emails.length}</span>
          <svg
            className={`w-3 h-3 text-slate-400 transition-transform ${expanded ? 'rotate-90' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </span>
      </button>
      {expanded && (
        <div className="pb-1">
          {emails.map((email) => (
            <EmailRow
              key={email.uid}
              email={email}
              compact
              onClick={onSelectEmail}
            />
          ))}
        </div>
      )}
    </div>
  );
}
