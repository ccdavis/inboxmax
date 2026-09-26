import { useEffect, useId, useRef, useState } from 'react';
import Dialog from './Dialog';
import RecipientField from './RecipientField';
import { commitText } from '../utils/addresses';

const EMPTY_FIELD = { addresses: [], text: '' };
const FIELDS = [
  ['to', 'To'],
  ['cc', 'Cc'],
  ['bcc', 'Bcc'],
];

const SECONDARY_BUTTON =
  'px-3 py-2 text-sm rounded-lg text-ink-soft hover:bg-hover transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500';
const PRIMARY_BUTTON =
  'px-4 py-2 text-sm font-medium rounded-lg text-white bg-gradient-to-r from-indigo-500 to-violet-500 hover:from-indigo-600 hover:to-violet-600 disabled:opacity-50 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface';

function field(addresses = []) {
  return { ...EMPTY_FIELD, addresses };
}

/**
 * Write and send a message, as a dialog over the inbox so nothing else can
 * be clicked away to while a draft is open: it closes only by sending or by
 * discarding (which asks first once anything has been written).
 *
 * `initial` pre-fills a reply or forward: { to, cc, bcc, subject, body,
 * in_reply_to, references, focus: 'to' | 'body' }. `onSend(request)` sends
 * and resolves to the receipt; `onSent(receipt, request)` follows.
 * `suggestContacts(query)` resolves to address-book entries to suggest.
 */
export default function ComposeDialog({ from, title = 'New message', initial = {}, onSend, onSent, onClose, suggestContacts }) {
  const subjectId = useId();
  const bodyId = useId();
  const [fields, setFields] = useState(() => ({
    to: field(initial.to),
    cc: field(initial.cc),
    bcc: field(initial.bcc),
  }));
  const [fieldErrors, setFieldErrors] = useState({});
  const [shown, setShown] = useState(() => ({
    cc: Boolean(initial.cc?.length),
    bcc: Boolean(initial.bcc?.length),
  }));
  const [subject, setSubject] = useState(initial.subject ?? '');
  const [body, setBody] = useState(initial.body ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // An open question before acting: 'discard' or 'no-subject'.
  const [confirming, setConfirming] = useState(null);
  const inputs = { to: useRef(null), cc: useRef(null), bcc: useRef(null) };
  const bodyRef = useRef(null);

  useEffect(() => {
    if (initial.focus === 'body') {
      bodyRef.current?.focus();
      bodyRef.current?.setSelectionRange(0, 0);
    } else {
      inputs.to.current?.focus();
    }
    // Only when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirty = FIELDS.some(([key]) => {
    const start = initial[key] ?? [];
    return fields[key].text.trim() || fields[key].addresses.length !== start.length;
  }) || subject !== (initial.subject ?? '') || body !== (initial.body ?? '');

  const requestClose = () => {
    if (busy) return;
    if (dirty) setConfirming('discard');
    else onClose();
  };

  const setField = (key) => (value) => setFields((current) => ({ ...current, [key]: value }));
  const setFieldError = (key) => (message) => setFieldErrors((current) => ({ ...current, [key]: message }));

  const send = async ({ allowEmptySubject = false } = {}) => {
    if (busy) return;
    setError(null);
    // Anything still typed in a recipient box counts.
    const committed = {};
    for (const [key] of FIELDS) {
      const { value, invalid } = commitText(fields[key]);
      committed[key] = value;
      if (invalid.length) {
        setFields((current) => ({ ...current, ...committed, [key]: value }));
        setShown((current) => ({ ...current, [key]: true }));
        setFieldError(key)(`“${invalid[0]}” is not a valid email address`);
        inputs[key].current?.focus();
        return;
      }
    }
    setFields(committed);
    if (!FIELDS.some(([key]) => committed[key].addresses.length)) {
      setFieldError('to')('Add at least one recipient');
      inputs.to.current?.focus();
      return;
    }
    if (!subject.trim() && !allowEmptySubject) {
      setConfirming('no-subject');
      return;
    }
    setConfirming(null);
    const request = {
      to: committed.to.addresses,
      cc: committed.cc.addresses,
      bcc: committed.bcc.addresses,
      subject,
      body,
      in_reply_to: initial.in_reply_to ?? null,
      references: initial.references ?? [],
    };
    setBusy(true);
    try {
      const receipt = await onSend(request);
      onSent(receipt, request);
    } catch (caught) {
      setError(caught.message);
      setBusy(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      send();
    } else if (e.key === 'Escape' && !e.defaultPrevented) {
      // Escape answers an open question first; otherwise it asks to close.
      e.preventDefault();
      if (confirming) setConfirming(null);
      else requestClose();
    }
  };

  const reveal = (key) => {
    setShown((current) => ({ ...current, [key]: true }));
    // After the field renders.
    setTimeout(() => inputs[key].current?.focus());
  };

  const toggles = (
    <div className="flex shrink-0 gap-1 pt-0.5">
      {['cc', 'bcc'].filter((key) => !shown[key]).map((key) => (
        <button key={key} type="button" onClick={() => reveal(key)} className="rounded px-1.5 py-0.5 text-xs text-ink-muted hover:bg-hover hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
          {key === 'cc' ? 'Cc' : 'Bcc'}
        </button>
      ))}
    </div>
  );

  return (
    <Dialog title={title} onClose={requestClose} closeDisabled={busy} onKeyDown={handleKeyDown} className="sm:max-w-2xl">
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <div className="px-4">
            <div className="flex items-center gap-2 border-b border-line py-2 text-sm">
              <span className="w-12 shrink-0 text-ink-muted">From</span>
              <span className="min-w-0 break-all text-ink-soft">{from}</span>
            </div>
            {FIELDS.filter(([key]) => key === 'to' || shown[key]).map(([key, label]) => (
              <RecipientField
                key={key}
                label={label}
                value={fields[key]}
                onChange={setField(key)}
                inputRef={inputs[key]}
                error={fieldErrors[key]}
                onError={setFieldError(key)}
                suggest={suggestContacts}
                trailing={key === 'to' ? toggles : null}
              />
            ))}
            <div className="flex items-center gap-2 border-b border-line py-1.5">
              <label htmlFor={subjectId} className="w-12 shrink-0 text-sm text-ink-muted">Subject</label>
              <input
                id={subjectId}
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                className="min-w-0 flex-1 bg-transparent py-1 text-sm text-ink focus:outline-none"
              />
            </div>
          </div>

          <label htmlFor={bodyId} className="sr-only">Message</label>
          <textarea
            id={bodyId}
            ref={bodyRef}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            className="min-h-[12rem] flex-1 resize-none bg-surface px-4 py-3 text-sm text-ink focus:outline-none"
          />

          <div className="border-t border-line px-4 py-3">
            {error && (
              <p role="alert" className="mb-2 rounded-lg border border-danger-line bg-danger-bg px-3 py-2 text-sm text-danger-ink">
                {error}
              </p>
            )}
            {confirming === 'discard' ? (
              <div role="group" aria-label="Discard this message?" className="flex flex-wrap items-center justify-end gap-2">
                <span className="mr-auto text-sm text-ink">Discard this message?</span>
                <button type="button" onClick={() => setConfirming(null)} className={SECONDARY_BUTTON}>Keep editing</button>
                <button type="button" onClick={onClose} className="px-3 py-2 text-sm font-medium rounded-lg text-white bg-red-600 hover:bg-red-700 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
                  Discard
                </button>
              </div>
            ) : confirming === 'no-subject' ? (
              <div role="group" aria-label="Send without a subject?" className="flex flex-wrap items-center justify-end gap-2">
                <span className="mr-auto text-sm text-ink">Send without a subject?</span>
                <button type="button" onClick={() => setConfirming(null)} className={SECONDARY_BUTTON}>Add a subject</button>
                <button type="button" onClick={() => send({ allowEmptySubject: true })} disabled={busy} className={PRIMARY_BUTTON}>
                  Send anyway
                </button>
              </div>
            ) : (
              <div className="flex items-center justify-end gap-2">
                <span className="mr-auto hidden text-xs text-ink-muted sm:inline">Ctrl+Enter to send</span>
                <button type="button" onClick={requestClose} disabled={busy} className={SECONDARY_BUTTON}>Discard</button>
                <button type="submit" disabled={busy} className={PRIMARY_BUTTON}>
                  {busy ? 'Sending…' : 'Send'}
                </button>
              </div>
            )}
          </div>
        </form>
    </Dialog>
  );
}
