import { useState } from 'react';

export default function RememberedList({ remembered, onForget, onSelect }) {
  const [expanded, setExpanded] = useState(true);

  if (remembered.length === 0) return null;

  return (
    <div className="border-b border-slate-200">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold text-amber-600 uppercase tracking-wider hover:bg-amber-50/50 transition"
      >
        <span className="flex items-center gap-1.5">
          <span className="text-amber-400">{'\u2605'}</span>
          Remembered
        </span>
        <span className="flex items-center gap-1.5">
          <span className="text-amber-400 font-normal normal-case text-xs">{remembered.length}</span>
          <svg
            className={`w-3 h-3 text-amber-400 transition-transform ${expanded ? 'rotate-90' : ''}`}
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
          {remembered.map((r) => (
            <div
              key={r.id}
              className="flex items-center gap-2 px-3 py-1.5 hover:bg-amber-50/50 rounded-md transition group cursor-pointer"
              onClick={() => onSelect?.(r.email_uid)}
            >
              <div className="min-w-0 flex-1 text-sm truncate">
                <span className="font-medium text-slate-800">{r.sender || 'Unknown'}</span>
                <span className="text-slate-400 mx-1">-</span>
                <span className="text-slate-600">{r.subject || '(no subject)'}</span>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onForget(r.email_uid);
                }}
                className="text-xs text-slate-400 hover:text-red-500 md:opacity-0 md:group-hover:opacity-100 transition shrink-0"
                title="Forget this"
              >
                {'\u2715'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
