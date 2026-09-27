// Small line icons, drawn in the current text color. Decorative: the button
// around each carries the label.

function Icon({ path, className = 'h-4 w-4' }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d={path} />
    </svg>
  );
}

export function ArchiveIcon(props) {
  return <Icon path="M20 7v11a2 2 0 01-2 2H6a2 2 0 01-2-2V7m16 0H4m16 0l-1.5-3h-13L4 7m6 5h4" {...props} />;
}

export function TrashIcon(props) {
  return (
    <Icon
      path="M19 7l-.87 12.14A2 2 0 0116.14 21H7.86a2 2 0 01-2-1.86L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
      {...props}
    />
  );
}
