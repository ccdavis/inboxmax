import { useState } from 'react';

export default function Layout({ email, displayName, onLogout, sidebar, children }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="h-dvh flex flex-col bg-white">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-2 border-b border-slate-200 bg-white shrink-0">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setSidebarOpen(true)}
            className="md:hidden p-2 -ml-2 text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded"
            aria-label="Open sidebar"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <span className="text-xl font-bold bg-gradient-to-r from-indigo-500 to-violet-500 bg-clip-text text-transparent" aria-hidden="true">
            Μ
          </span>
          <h1 className="text-lg tracking-tight text-slate-900">
            <span className="font-light">Inbox</span>
            <span className="font-bold"> Max</span>
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-slate-500 hidden sm:inline">{email}</span>
          <button
            onClick={onLogout}
            className="text-xs text-slate-400 hover:text-slate-600 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded"
          >
            Sign out
          </button>
        </div>
      </header>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden relative">
        {/* Mobile backdrop */}
        {sidebarOpen && (
          <div
            className="fixed inset-0 z-30 bg-black/30 md:hidden"
            onClick={() => setSidebarOpen(false)}
            aria-hidden="true"
          />
        )}

        {/* Sidebar */}
        <aside
          className={`
            fixed inset-y-0 left-0 z-40 w-72 bg-white border-r border-slate-200 transform transition-transform duration-200 ease-in-out overflow-hidden
            md:static md:translate-x-0 md:w-64 md:shrink-0
            ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
          `}
          aria-label="Sidebar"
          onClick={(e) => {
            // Auto-close sidebar on mobile when an interactive element is clicked
            if (window.innerWidth < 768 && e.target.closest('button, a')) {
              setSidebarOpen(false);
            }
          }}
        >
          {/* Mobile close button */}
          <div className="md:hidden flex items-center justify-between px-3 py-2 border-b border-slate-200">
            <span className="text-sm font-medium text-slate-700">Menu</span>
            <button
              onClick={() => setSidebarOpen(false)}
              className="p-2 text-slate-400 hover:text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded"
              aria-label="Close sidebar"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          {sidebar}
        </aside>

        {/* Main content */}
        <main className="flex-1 overflow-hidden">
          {children}
        </main>
      </div>
    </div>
  );
}
