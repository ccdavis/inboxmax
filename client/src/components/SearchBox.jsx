import { useState } from 'react';

export default function SearchBox({ onSearch, onClear }) {
  const [query, setQuery] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    if (query.trim()) {
      onSearch(query.trim());
    }
  };

  const handleChange = (e) => {
    setQuery(e.target.value);
    // Emptying the box leaves search mode, like pressing the clear button.
    if (!e.target.value.trim()) onClear?.();
  };

  const handleClear = () => {
    setQuery('');
    onClear?.();
  };

  return (
    <form role="search" onSubmit={handleSubmit} className="px-3 py-2 shrink-0">
      <div className="relative">
        <svg
          className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-faint pointer-events-none"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          type="text"
          value={query}
          onChange={handleChange}
          placeholder="Search emails"
          aria-label="Search emails by subject or sender"
          enterKeyHint="search"
          className="w-full pl-9 pr-9 py-2 text-sm rounded-lg border border-line bg-canvas text-ink placeholder-ink-faint focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition"
        />
        {query && (
          <button
            type="button"
            onClick={handleClear}
            className="absolute right-1 top-1/2 -translate-y-1/2 p-1.5 rounded text-ink-muted hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            aria-label="Clear search"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>
    </form>
  );
}
