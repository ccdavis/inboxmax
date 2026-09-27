import { useId, useState } from 'react';
import Dialog from './Dialog';

// As the server allows.
const MAX_SIGNATURE_CHARS = 2000;

const PRIMARY_BUTTON =
  'rounded-lg bg-gradient-to-r from-indigo-500 to-violet-500 px-3 py-1.5 text-sm font-medium text-white hover:from-indigo-600 hover:to-violet-600 disabled:opacity-50 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500';
const SECONDARY_BUTTON =
  'rounded-lg border border-line px-3 py-1.5 text-sm text-ink-soft hover:bg-hover hover:text-ink transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500';

/**
 * Edit the signature of the mailbox `email`. `onSave(text)` stores it and
 * rejects with the reason if it cannot; the dialog closes once it has.
 */
export default function SignatureDialog({ email, signature, onSave, onClose }) {
  const [text, setText] = useState(signature);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const fieldId = useId();
  const hintId = useId();
  const length = [...text].length;
  const tooLong = length > MAX_SIGNATURE_CHARS;

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSave(text);
      onClose();
    } catch (caught) {
      setError(`Could not save the signature: ${caught.message}`);
      setBusy(false);
    }
  };

  return (
    <Dialog title="Signature" onClose={onClose} closeDisabled={busy} className="sm:max-w-xl">
      <form onSubmit={save} className="flex min-h-0 flex-1 flex-col gap-2 px-4 py-3">
        <label htmlFor={fieldId} className="text-sm text-ink-soft">
          Added below new messages, replies and forwards from <span className="font-medium text-ink">{email}</span>
        </label>
        <textarea
          id={fieldId}
          autoFocus
          rows={6}
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-describedby={hintId}
          aria-invalid={tooLong || undefined}
          placeholder={'Your name\nTitle, company\nPhone'}
          className="min-h-[8rem] flex-1 resize-y rounded-lg border border-line bg-field px-3 py-2 font-sans text-sm text-ink placeholder-ink-faint focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
        />
        <p id={hintId} className={`text-xs ${tooLong ? 'text-danger-ink' : 'text-ink-muted'}`}>
          {tooLong
            ? `${length - MAX_SIGNATURE_CHARS} characters over the limit of ${MAX_SIGNATURE_CHARS}.`
            : 'Leave it empty for no signature.'}
        </p>
        {error && <p role="alert" className="text-sm text-danger-ink">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} disabled={busy} className={SECONDARY_BUTTON}>Cancel</button>
          <button type="submit" disabled={busy || tooLong} className={PRIMARY_BUTTON}>Save</button>
        </div>
      </form>
    </Dialog>
  );
}
