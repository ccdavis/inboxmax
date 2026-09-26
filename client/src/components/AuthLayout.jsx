import { useId } from 'react';
import { Link } from 'react-router-dom';
import { LogoMark } from './Logo';

/** Centered card page shared by sign-in, registration, and mailbox connection. */
export function AuthLayout({ title, subtitle, logoLinksHome = true, topRight, children }) {
  const logo = <LogoMark className="text-5xl" />;
  return (
    <div className="min-h-dvh bg-gradient-to-br from-canvas-subtle to-canvas-deep flex flex-col">
      {topRight && <div className="flex justify-end px-4 pt-4">{topRight}</div>}
      <main className="flex-1 flex items-center justify-center p-4">
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            {logoLinksHome ? (
              <Link to="/" className="inline-block focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded" aria-label="Inbox Max home">
                {logo}
              </Link>
            ) : logo}
            <h1 className="text-2xl font-bold text-ink mt-2">{title}</h1>
            {subtitle && <p className="text-ink-muted text-sm mt-1">{subtitle}</p>}
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}

export function AuthForm({ onSubmit, children }) {
  return (
    <form onSubmit={onSubmit} className="bg-surface rounded-2xl shadow-sm border border-line p-6 sm:p-8 space-y-5">
      {children}
    </form>
  );
}

export function FormError({ children }) {
  if (!children) return null;
  return (
    <div role="alert" className="bg-danger-bg text-danger-ink text-sm px-4 py-3 rounded-lg border border-danger-line">
      {children}
    </div>
  );
}

export function FormField({ label, hint, small = false, ...inputProps }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className={`block font-medium mb-1.5 ${small ? 'text-xs text-ink-muted' : 'text-sm text-ink-soft'}`}>
        {label}
        {hint && <span className="text-ink-muted font-normal"> {hint}</span>}
      </label>
      <input
        id={id}
        {...inputProps}
        className={`w-full rounded-lg border border-line bg-field text-ink placeholder-ink-faint focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition ${
          small ? 'px-3 py-2 text-sm' : 'px-4 py-2.5'
        }`}
      />
    </div>
  );
}

export function SubmitButton({ loading, loadingText, children }) {
  return (
    <button
      type="submit"
      disabled={loading}
      className="w-full py-2.5 bg-gradient-to-r from-indigo-500 to-violet-500 hover:from-indigo-600 hover:to-violet-600 disabled:opacity-50 text-white font-medium rounded-lg transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
    >
      {loading ? loadingText : children}
    </button>
  );
}
