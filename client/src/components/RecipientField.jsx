import { useId } from 'react';
import { commitText, formatAddress } from '../utils/addresses';

const SEPARATOR = /[,;\n]/;

/**
 * A To/Cc/Bcc field: recipients as removable chips that always show the full
 * address, and a text box that turns typed or pasted addresses into chips on
 * Enter, comma, semicolon, Tab, or leaving the field.
 *
 * `value` is `{ addresses, text }`; `onChange` receives the next value.
 */
export default function RecipientField({ label, value, onChange, inputRef, error, onError, trailing }) {
  const id = useId();
  const errorId = useId();

  const commit = (next = value) => {
    const { value: committed, invalid } = commitText(next);
    onChange(committed);
    onError?.(invalid.length ? `“${invalid[0]}” is not a valid email address` : null);
  };

  const handleKeyDown = (e) => {
    if ((e.key === 'Enter' || e.key === ',' || e.key === ';') && value.text.trim()) {
      e.preventDefault();
      commit();
    } else if (e.key === 'Enter') {
      // An empty field has nothing to add; do not submit the form.
      e.preventDefault();
    } else if (e.key === 'Tab' && value.text.trim()) {
      commit();
    } else if (e.key === 'Backspace' && !value.text && value.addresses.length) {
      onChange({ ...value, addresses: value.addresses.slice(0, -1) });
    }
  };

  const handleChange = (e) => {
    const text = e.target.value;
    // A pasted list, or a separator typed mid-text: keep everything up to
    // the last separator as chips and leave the rest for typing.
    if (SEPARATOR.test(text)) {
      const cut = Math.max(text.lastIndexOf(','), text.lastIndexOf(';'), text.lastIndexOf('\n'));
      const { value: committed, invalid } = commitText({ addresses: value.addresses, text: text.slice(0, cut) });
      const rest = text.slice(cut + 1).trimStart();
      onChange({ addresses: committed.addresses, text: [committed.text, rest].filter(Boolean).join(', ') });
      onError?.(invalid.length ? `“${invalid[0]}” is not a valid email address` : null);
      return;
    }
    onChange({ ...value, text });
    if (error) onError?.(null);
  };

  const remove = (address) => {
    onChange({ ...value, addresses: value.addresses.filter((a) => a !== address) });
  };

  return (
    <div className="border-b border-line">
      <div className="flex items-start gap-2 py-1.5">
        <label htmlFor={id} className="w-12 shrink-0 pt-1 text-sm text-ink-muted">
          {label}
        </label>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          {value.addresses.length > 0 && (
            <ul aria-label={`${label} recipients`} className="contents">
              {value.addresses.map((address) => (
                <li
                  key={address.email}
                  className="inline-flex max-w-full items-center gap-1 rounded-full bg-accent-soft py-0.5 pl-2.5 pr-1 text-sm"
                >
                  <span className="min-w-0 truncate">
                    {address.name ? (
                      <>
                        <span className="text-ink">{address.name}</span>{' '}
                        <span className="text-ink-muted">&lt;{address.email}&gt;</span>
                      </>
                    ) : (
                      <span className="text-ink">{address.email}</span>
                    )}
                  </span>
                  <button
                    type="button"
                    onClick={() => remove(address)}
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-ink-muted hover:bg-hover hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                    aria-label={`Remove ${formatAddress(address)}`}
                  >
                    <span aria-hidden="true">×</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <input
            id={id}
            ref={inputRef}
            type="text"
            inputMode="email"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={value.text}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onBlur={() => value.text.trim() && commit()}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            className="min-w-[10rem] flex-1 bg-transparent py-1 text-sm text-ink placeholder-ink-faint focus:outline-none"
          />
        </div>
        {trailing}
      </div>
      {error && (
        <p id={errorId} role="alert" className="pb-1.5 pl-14 text-xs text-danger-ink">
          {error}
        </p>
      )}
    </div>
  );
}
