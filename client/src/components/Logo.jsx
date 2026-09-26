/** The gradient "Μ" mark plus the "Inbox Max" wordmark. */
export function LogoMark({ className = '' }) {
  return (
    <span
      className={`font-bold bg-gradient-to-r from-indigo-500 to-violet-500 bg-clip-text text-transparent ${className}`}
      aria-hidden="true"
    >
      Μ
    </span>
  );
}

export function Wordmark({ className = '', boldClassName = 'font-bold' }) {
  return (
    <span className={`tracking-tight text-ink ${className}`}>
      <span className="font-light">Inbox</span>
      <span className={boldClassName}> Max</span>
    </span>
  );
}
