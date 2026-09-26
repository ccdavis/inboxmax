import { useEffect, useId, useRef, useState } from 'react';
import { commitText, formatAddress, isEmailAddress, withAddresses } from '../utils/addresses';

const SEPARATOR = /[,;\n]/;
// Wait for a pause in typing before asking for suggestions.
const SUGGEST_DELAY_MS = 120;

function invalidMessage(invalid) {
  return invalid.length ? `“${invalid[0]}” is not a valid email address` : null;
}

/**
 * A To/Cc/Bcc field: recipients as removable chips that always show the full
 * address, and a text box that turns typed or pasted addresses into chips on
 * Enter, comma, semicolon, Tab, or leaving the field.
 *
 * With `suggest(query)`, typing offers address-book entries (a combobox):
 * arrows move through them, Enter or Tab picks one (staying in the field),
 * Escape closes the list.
 * Each shows its full address, since one person can have several.
 *
 * `value` is `{ addresses, text }`; `onChange` receives the next value.
 */
export default function RecipientField({ label, value, onChange, inputRef, error, onError, suggest, trailing }) {
  const id = useId();
  const errorId = useId();
  const listId = useId();
  // Suggestions for the text they were asked for; shown only while it is
  // still what the field holds.
  const [result, setResult] = useState({ query: null, items: [] });
  const [active, setActive] = useState(-1);
  const request = useRef(0);
  const query = value.text.trim();
  const suggestions = result.query === query ? result.items : [];
  const open = suggestions.length > 0;

  // Suggestions follow the typed text; anything already added is left out.
  useEffect(() => {
    const requestId = ++request.current;
    if (!suggest || !query || SEPARATOR.test(query)) return undefined;
    const timer = setTimeout(async () => {
      let items = [];
      try {
        const chosen = new Set(value.addresses.map((a) => a.email.toLowerCase()));
        items = (await suggest(query)).filter((contact) => !chosen.has(contact.email.toLowerCase()));
      } catch {
        // Suggestions are a convenience; typing still works without them.
      }
      if (requestId !== request.current) return;
      setResult({ query, items });
      // Pre-select the first only while the text is not a complete
      // address, so Enter never swaps a typed address for another.
      setActive(items.length && !isEmailAddress(query) ? 0 : -1);
    }, SUGGEST_DELAY_MS);
    return () => clearTimeout(timer);
  }, [suggest, query, value.addresses]);

  const close = () => {
    request.current += 1;
    setResult({ query: null, items: [] });
    setActive(-1);
  };

  const commit = (next = value) => {
    const { value: committed, invalid } = commitText(next);
    onChange(committed);
    onError?.(invalidMessage(invalid));
  };

  const pick = (contact) => {
    onChange({ addresses: withAddresses(value.addresses, [{ name: contact.name, email: contact.email }]), text: '' });
    onError?.(null);
    close();
  };

  const handleKeyDown = (e) => {
    if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      const last = suggestions.length - 1;
      const down = e.key === 'ArrowDown';
      setActive((current) => (down
        ? (current >= last ? 0 : current + 1)
        : (current <= 0 ? last : current - 1)));
      return;
    }
    if (open && e.key === 'Escape') {
      // Close the list, not the dialog around it.
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (open && active >= 0 && (e.key === 'Enter' || e.key === 'Tab')) {
      // Stay in the field, ready for the next recipient.
      e.preventDefault();
      pick(suggestions[active]);
      return;
    }
    if ((e.key === 'Enter' || e.key === ',' || e.key === ';') && value.text.trim()) {
      e.preventDefault();
      commit();
      close();
    } else if (e.key === 'Enter') {
      // An empty field has nothing to add; do not submit the form.
      e.preventDefault();
    } else if (e.key === 'Tab' && value.text.trim()) {
      commit();
      close();
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
      onError?.(invalidMessage(invalid));
      return;
    }
    onChange({ ...value, text });
    if (error) onError?.(null);
  };

  const handleBlur = () => {
    close();
    if (value.text.trim()) commit();
  };

  const remove = (address) => {
    onChange({ ...value, addresses: value.addresses.filter((a) => a !== address) });
  };

  const optionId = (index) => `${listId}-${index}`;

  return (
    <div className="border-b border-line">
      <div className="flex items-start gap-2 py-1.5">
        <label htmlFor={id} className="w-12 shrink-0 pt-1 text-sm text-ink-muted">
          {label}
        </label>
        <div className="relative flex min-w-0 flex-1 flex-wrap items-center gap-1">
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
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={listId}
            aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
            inputMode="email"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={value.text}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            className="min-w-[10rem] flex-1 bg-transparent py-1 text-sm text-ink placeholder-ink-faint focus:outline-none"
          />
          <ul
            id={listId}
            role="listbox"
            aria-label={`Suggestions for ${label}`}
            hidden={!open}
            className="absolute left-0 right-0 top-full z-10 mt-1 max-h-64 overflow-auto rounded-lg border border-line bg-surface py-1 shadow-lg"
          >
            {suggestions.map((contact, index) => (
              <li
                key={contact.email}
                id={optionId(index)}
                role="option"
                aria-selected={index === active}
                // Keep focus in the text box, so picking does not blur it.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(contact)}
                onMouseEnter={() => setActive(index)}
                className={`cursor-pointer px-3 py-1.5 text-sm ${index === active ? 'bg-selected' : ''}`}
              >
                {contact.name && <span className="font-medium text-ink">{contact.name} </span>}
                <span className={contact.name ? 'text-ink-muted' : 'text-ink'}>
                  {contact.name ? `<${contact.email}>` : contact.email}
                </span>
              </li>
            ))}
          </ul>
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
