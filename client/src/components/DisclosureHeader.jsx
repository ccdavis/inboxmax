/** Collapsible section header used by the sidebar groups. */
export default function DisclosureHeader({ expanded, onToggle, controls, count, className = '', children }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      aria-controls={controls}
      className={`w-full flex items-center justify-between px-3 py-2 text-xs font-semibold uppercase tracking-wider transition focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500 ${className}`}
    >
      {children}
      <span className="flex items-center gap-1.5">
        <span className="font-normal normal-case text-xs text-ink-muted">{count}</span>
        <svg
          className={`w-3 h-3 text-ink-muted transition-transform ${expanded ? 'rotate-90' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </span>
    </button>
  );
}
