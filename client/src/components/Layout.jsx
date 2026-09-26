import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { LogoMark, Wordmark } from './Logo';

const MOBILE_QUERY = '(max-width: 767.98px)'; // below Tailwind's md breakpoint

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() => window.matchMedia?.(MOBILE_QUERY).matches ?? false);
  useEffect(() => {
    const media = window.matchMedia?.(MOBILE_QUERY);
    if (!media) return undefined;
    const update = () => setIsMobile(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return isMobile;
}

/**
 * A message across the top of the page. The live-region role is on the text
 * alone, so assistive technology announces the message, not the ✕.
 */
function Banner({ role, onDismiss, className, children }) {
  return (
    <div className={`flex items-start justify-between gap-3 text-sm px-4 py-2 border-b ${className}`}>
      <span role={role}>{children}</span>
      {onDismiss && (
        <button
          onClick={onDismiss}
          className="shrink-0 rounded px-1 hover:opacity-70 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          aria-label="Dismiss message"
        >
          {'✕'}
        </button>
      )}
    </div>
  );
}

/**
 * App shell: header, a sidebar that is a slide-over drawer on small screens,
 * and the main pane. Sidebar content marks elements that navigate (and so
 * should close the drawer) with `data-closes-sidebar`. The desktop app
 * passes no `onLogout` and `homeLink={false}`: it has no sign-in or landing page.
 *
 * `notice` is a problem to report; `status` is good news (such as a sent
 * message). `actions` sit in the header; `inert` shuts the page off while a
 * dialog is open over it.
 */
export default function Layout({
  email,
  onLogout,
  homeLink = true,
  notice,
  onDismissNotice,
  status,
  onDismissStatus,
  actions,
  inert = false,
  sidebar,
  children,
}) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const isMobile = useIsMobile();
  const drawerOpen = isMobile && sidebarOpen;
  const openButtonRef = useRef(null);
  const closeButtonRef = useRef(null);
  const wasOpenRef = useRef(false);

  // Move focus into the drawer when it opens and back when it closes.
  useEffect(() => {
    if (drawerOpen) {
      closeButtonRef.current?.focus();
    } else if (wasOpenRef.current && isMobile) {
      openButtonRef.current?.focus();
    }
    wasOpenRef.current = drawerOpen;
  }, [drawerOpen, isMobile]);

  useEffect(() => {
    if (!drawerOpen) return undefined;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') setSidebarOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [drawerOpen]);

  const closeOnMobile = () => {
    if (isMobile) setSidebarOpen(false);
  };

  return (
    <div className="h-dvh flex flex-col bg-canvas" inert={inert}>
      <header
        className="flex items-center justify-between px-4 py-2 border-b border-line bg-canvas shrink-0"
        inert={drawerOpen}
      >
        <div className="flex items-center gap-2">
          <button
            ref={openButtonRef}
            onClick={() => setSidebarOpen(true)}
            className="md:hidden p-2 -ml-2 text-ink-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded"
            aria-label="Open sidebar"
            aria-expanded={drawerOpen}
            aria-controls="sidebar"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          {homeLink ? (
            <Link
              to="/"
              className="flex items-center gap-2 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
              aria-label="Inbox Max home"
            >
              <LogoMark className="text-xl" />
              <Wordmark className="text-lg" />
            </Link>
          ) : (
            <span className="flex items-center gap-2">
              <LogoMark className="text-xl" />
              <Wordmark className="text-lg" />
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {actions}
          <span className="text-sm text-ink-muted hidden sm:inline">{email}</span>
          {onLogout && (
            <button
              onClick={onLogout}
              className="text-sm text-ink-muted hover:text-ink px-2 py-1 rounded transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            >
              Sign out
            </button>
          )}
        </div>
      </header>

      {notice && (
        <Banner role="alert" onDismiss={onDismissNotice} className="bg-danger-bg text-danger-ink border-danger-line">
          {notice}
        </Banner>
      )}
      {status && (
        <Banner role="status" onDismiss={onDismissStatus} className="bg-accent-soft text-ink border-line">
          {status}
        </Banner>
      )}

      <div className="flex flex-1 min-h-0 relative">
        {drawerOpen && (
          <div
            className="fixed inset-0 z-30 bg-black/40"
            onClick={() => setSidebarOpen(false)}
            aria-hidden="true"
          />
        )}

        <aside
          id="sidebar"
          className={`
            fixed inset-y-0 left-0 z-40 w-72 max-w-[85vw] flex flex-col bg-canvas-subtle border-r border-line
            transform transition-transform duration-200 ease-in-out
            md:static md:z-auto md:translate-x-0 md:w-64 md:shrink-0
            ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
          `}
          aria-label="Sidebar"
          inert={isMobile && !sidebarOpen}
          onClick={(e) => {
            if (e.target.closest('[data-closes-sidebar]')) closeOnMobile();
          }}
          onSubmit={closeOnMobile}
        >
          <div className="md:hidden flex items-center justify-between px-3 py-2 border-b border-line shrink-0">
            <span className="text-sm font-medium text-ink-soft">Menu</span>
            <button
              ref={closeButtonRef}
              onClick={() => setSidebarOpen(false)}
              className="p-2 text-ink-muted hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded"
              aria-label="Close sidebar"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          {sidebar}
        </aside>

        <main className="flex-1 min-w-0 overflow-hidden" inert={drawerOpen}>
          {children}
        </main>
      </div>
    </div>
  );
}
