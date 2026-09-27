import { useCallback, useEffect, useId, useRef, useState } from 'react';
import Dialog from './Dialog';
import RecipientField from './RecipientField';
import { commitText } from '../utils/addresses';
import { MAX_ATTACHMENT_BYTES, formatSize, readAsBase64 } from '../utils/files';

const EMPTY_FIELD = { addresses: [], text: '' };
const FIELDS = [
  ['to', 'To'],
  ['cc', 'Cc'],
  ['bcc', 'Bcc'],
];
// Save a draft this long after the last change.
const AUTOSAVE_DELAY_MS = 1000;

const SECONDARY_BUTTON =
  'px-3 py-2 text-sm rounded-lg text-ink-soft hover:bg-hover transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500';
const PRIMARY_BUTTON =
  'px-4 py-2 text-sm font-medium rounded-lg text-white bg-gradient-to-r from-indigo-500 to-violet-500 hover:from-indigo-600 hover:to-violet-600 disabled:opacity-50 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface';

function field(addresses = [], text = '') {
  return { ...EMPTY_FIELD, addresses, text };
}

/** Attachments as the dialog keeps them, each with a key for the list. */
function keyed(attachments = []) {
  return attachments.map((a, i) => ({ ...a, key: a.data ? `saved-${i}` : `original-${a.index}` }));
}

/**
 * Write and send a message, as a dialog over the inbox so nothing else can
 * be clicked away to while it is open.
 *
 * `initial` pre-fills it: a reply or forward ({ to, cc, bcc, subject, body,
 * in_reply_to, references, focus: 'to' | 'body' }, and for a forward the
 * original's `attachments` and `forward_uid`), or a saved draft, whose
 * content is what this dialog saves (the same fields plus `pending` text
 * still in the recipient boxes).
 *
 * With `onSaveDraft(content)`, the message is saved as the user writes and
 * closing keeps it as a draft; Discard asks, then calls `onDeleteDraft`.
 * Without it, closing a written message asks before discarding.
 * `onSend(request)` sends and resolves to the receipt; `onSent(receipt,
 * request)` follows. `onClose({ draftSaved })` says whether a draft remains.
 * `suggestContacts(query)` resolves to address-book entries to suggest.
 * `warnBeforeLeaving` asks before the page is left with unsaved writing.
 */
export default function ComposeDialog({
  from,
  title = 'New message',
  initial = {},
  draftId = null,
  fromDraft = false,
  onSaveDraft,
  onDeleteDraft,
  onSend,
  onSent,
  onClose,
  suggestContacts,
  warnBeforeLeaving = false,
}) {
  const subjectId = useId();
  const bodyId = useId();
  const [fields, setFields] = useState(() => ({
    to: field(initial.to, initial.pending?.to),
    cc: field(initial.cc, initial.pending?.cc),
    bcc: field(initial.bcc, initial.pending?.bcc),
  }));
  const [fieldErrors, setFieldErrors] = useState({});
  const [shown, setShown] = useState(() => ({
    cc: Boolean(initial.cc?.length || initial.pending?.cc),
    bcc: Boolean(initial.bcc?.length || initial.pending?.bcc),
  }));
  const [subject, setSubject] = useState(initial.subject ?? '');
  const [body, setBody] = useState(initial.body ?? '');
  // Attachments: files added here ({ key, filename, content_type, size, data })
  // and a forward's originals ({ key, index, filename, content_type, size }).
  const [files, setFiles] = useState(() => keyed(initial.attachments));
  const fileInput = useRef(null);
  const fileKey = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // An open question before acting: 'discard' or 'no-subject'.
  const [confirming, setConfirming] = useState(null);
  // 'saving', 'saved', or { error } for the draft; null before any save.
  const [draftState, setDraftState] = useState(null);
  const inputs = { to: useRef(null), cc: useRef(null), bcc: useRef(null) };
  const bodyRef = useRef(null);
  const subjectRef = useRef(null);
  const discardRef = useRef(null);
  const promptRef = useRef(null);
  const promptId = useId();
  // Where focus goes once the open question is answered.
  const afterPrompt = useRef(null);

  useEffect(() => {
    if (confirming) {
      promptRef.current?.querySelector('button')?.focus();
    } else {
      afterPrompt.current?.current?.focus();
      afterPrompt.current = null;
    }
  }, [confirming]);

  /** Put the question away and focus `ref`'s element. */
  const answer = (ref) => {
    afterPrompt.current = ref;
    setConfirming(null);
  };

  // What the form holds, cheaply comparable (attachments by key, not data).
  const signature = JSON.stringify({ fields, subject, body, files: files.map((f) => f.key) });
  const initialSignature = useRef(signature);
  const savedSignature = useRef(signature);
  const hasDraft = useRef(fromDraft);
  const saving = useRef(Promise.resolve());
  const sending = useRef(false);
  const dirty = signature !== initialSignature.current;
  const unsaved = signature !== savedSignature.current;

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

  const content = () => ({
    title,
    to: fields.to.addresses,
    cc: fields.cc.addresses,
    bcc: fields.bcc.addresses,
    pending: { to: fields.to.text, cc: fields.cc.text, bcc: fields.bcc.text },
    subject,
    body,
    in_reply_to: initial.in_reply_to ?? null,
    references: initial.references ?? [],
    attachments: files.map(({ filename, content_type, size, data, index }) => ({
      filename, content_type, size, data, index,
    })),
    forward_uid: initial.forward_uid ?? null,
    forward_folder: initial.forward_folder ?? null,
  });
  const contentRef = useRef(content);
  contentRef.current = content;

  /** Save the draft now; resolves to whether it worked. */
  const saveDraft = useCallback(() => {
    if (!onSaveDraft || sending.current) return Promise.resolve(false);
    const saved = signature;
    setDraftState('saving');
    const attempt = saving.current
      .catch(() => undefined)
      .then(() => onSaveDraft(contentRef.current()))
      .then(() => {
        savedSignature.current = saved;
        hasDraft.current = true;
        setDraftState('saved');
        return true;
      })
      .catch((caught) => {
        setDraftState({ error: caught.message });
        return false;
      });
    saving.current = attempt;
    return attempt;
  }, [onSaveDraft, signature]);

  // Leaving the page with something unsaved: save it, and let the browser
  // ask first. (The desktop app's window has no such question.)
  useEffect(() => {
    if (!warnBeforeLeaving || !onSaveDraft || !unsaved) return undefined;
    const warn = (e) => {
      saveDraft();
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [warnBeforeLeaving, onSaveDraft, unsaved, saveDraft]);

  // Save a little while after each change.
  useEffect(() => {
    if (!onSaveDraft || !unsaved || busy) return undefined;
    const timer = setTimeout(saveDraft, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [onSaveDraft, unsaved, busy, saveDraft]);

  const addFiles = async (fileList) => {
    const added = [...fileList];
    if (!added.length) return;
    setError(null);
    const total = [...files, ...added].reduce((sum, f) => sum + f.size, 0);
    if (total > MAX_ATTACHMENT_BYTES) {
      setError(`Attachments can total at most ${formatSize(MAX_ATTACHMENT_BYTES)}`);
      return;
    }
    try {
      const read = await Promise.all(added.map(async (file) => ({
        key: `file-${fileKey.current++}`,
        filename: file.name,
        content_type: file.type || 'application/octet-stream',
        size: file.size,
        data: await readAsBase64(file),
      })));
      setFiles((current) => [...current, ...read]);
    } catch (caught) {
      setError(caught.message);
    }
  };

  const removeFile = (key) => setFiles((current) => current.filter((f) => f.key !== key));

  /** ✕ and Escape: keep the message as a draft, or (without drafts) ask. */
  const requestClose = async () => {
    if (busy) return;
    if (!onSaveDraft) {
      if (dirty) setConfirming('discard');
      else onClose({ draftSaved: false });
      return;
    }
    if (unsaved && !(await saveDraft())) return;
    onClose({ draftSaved: hasDraft.current });
  };

  /** The Discard button: throw the message (and any draft of it) away. */
  const requestDiscard = () => {
    if (busy) return;
    if (dirty || hasDraft.current) setConfirming('discard');
    else onClose({ draftSaved: false });
  };

  const discard = async () => {
    sending.current = true; // no more saves
    await saving.current.catch(() => undefined);
    if (hasDraft.current && onDeleteDraft) {
      try {
        await onDeleteDraft();
      } catch (caught) {
        sending.current = false;
        answer(discardRef);
        setError(`Could not delete the draft: ${caught.message}`);
        return;
      }
    }
    onClose({ draftSaved: false });
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
    if (confirming) answer(bodyRef);
    const request = {
      to: committed.to.addresses,
      cc: committed.cc.addresses,
      bcc: committed.bcc.addresses,
      subject,
      body,
      in_reply_to: initial.in_reply_to ?? null,
      references: initial.references ?? [],
      attachments: files
        .filter((f) => f.data)
        .map(({ filename, content_type, data }) => ({ filename, content_type, data })),
      forward: files.some((f) => f.data == null)
        ? {
          uid: initial.forward_uid,
          indexes: files.filter((f) => f.data == null).map((f) => f.index),
          folder: initial.forward_folder ?? null,
        }
        : null,
      draft_id: draftId,
    };
    setBusy(true);
    // A save still in flight could land after the server removes the sent
    // message's draft and bring it back, so let it finish first.
    sending.current = true;
    await saving.current.catch(() => undefined);
    try {
      const receipt = await onSend(request);
      onSent(receipt, request);
    } catch (caught) {
      sending.current = false;
      setError(caught.message);
      setBusy(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      send();
    } else if (e.key === 'Escape' && !e.defaultPrevented) {
      // Escape answers an open question first; otherwise it closes.
      e.preventDefault();
      if (confirming) answer(confirming === 'discard' ? discardRef : subjectRef);
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

  let draftNote = null;
  if (draftState === 'saving') draftNote = 'Saving draft…';
  else if (draftState === 'saved' && !unsaved) draftNote = 'Draft saved';
  else if (draftState?.error) draftNote = `Draft not saved: ${draftState.error}`;

  return (
    <Dialog title={title} onClose={requestClose} closeDisabled={busy} onKeyDown={handleKeyDown} className="sm:max-w-2xl">
      <form
        className="flex min-h-0 flex-1 flex-col"
        // Files dropped anywhere on the message are attached.
        onDragOver={(e) => {
          if (e.dataTransfer?.types?.includes('Files')) e.preventDefault();
        }}
        onDrop={(e) => {
          // Not while sending: the message has already been put together.
          if (!e.dataTransfer?.files?.length || busy) return;
          e.preventDefault();
          addFiles(e.dataTransfer.files);
        }}
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
              ref={subjectRef}
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="min-w-0 flex-1 bg-transparent py-1 text-sm text-ink focus:outline-none"
            />
          </div>
        </div>

        {files.length > 0 && (
          <ul aria-label="Attachments" className="flex flex-wrap gap-1.5 border-b border-line px-4 py-2">
            {files.map((file) => (
              <li key={file.key} className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-line py-0.5 pl-2 pr-1 text-sm">
                <span aria-hidden="true">📎</span>
                <span className="min-w-0 truncate text-ink">{file.filename}</span>
                <span className="shrink-0 text-xs text-ink-muted">{formatSize(file.size)}</span>
                <button
                  type="button"
                  onClick={() => removeFile(file.key)}
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-muted hover:bg-hover hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                  aria-label={`Remove attachment ${file.filename}`}
                >
                  <span aria-hidden="true">×</span>
                </button>
              </li>
            ))}
          </ul>
        )}

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
          {draftState?.error && (
            <p role="alert" className="sr-only">Draft not saved: {draftState.error}</p>
          )}
          {/* A question takes the focus (so it is read out) and gives it back. */}
          {confirming === 'discard' ? (
            <div ref={promptRef} role="group" aria-labelledby={promptId} className="flex flex-wrap items-center justify-end gap-2">
              <span id={promptId} className="mr-auto text-sm text-ink">
                {hasDraft.current ? 'Discard this message and delete its draft?' : 'Discard this message?'}
              </span>
              <button type="button" onClick={() => answer(discardRef)} className={SECONDARY_BUTTON}>Keep editing</button>
              <button type="button" onClick={discard} className="px-3 py-2 text-sm font-medium rounded-lg text-white bg-red-600 hover:bg-red-700 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
                Discard
              </button>
            </div>
          ) : confirming === 'no-subject' ? (
            <div ref={promptRef} role="group" aria-labelledby={promptId} className="flex flex-wrap items-center justify-end gap-2">
              <span id={promptId} className="mr-auto text-sm text-ink">Send without a subject?</span>
              <button type="button" onClick={() => answer(subjectRef)} className={SECONDARY_BUTTON}>Add a subject</button>
              <button type="button" onClick={() => send({ allowEmptySubject: true })} disabled={busy} className={PRIMARY_BUTTON}>
                Send anyway
              </button>
            </div>
          ) : (
            <div className="flex items-center justify-end gap-2">
              <button type="button" onClick={() => fileInput.current?.click()} disabled={busy} className={SECONDARY_BUTTON}>
                <span aria-hidden="true">📎</span> Attach
              </button>
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                aria-label="Attach files"
                onChange={(e) => {
                  addFiles(e.target.files);
                  e.target.value = '';
                }}
              />
              {/* Saving is shown, not spoken: only a failed save is announced. */}
              <span className={`mr-auto text-xs text-ink-muted ${draftNote ? '' : 'hidden sm:inline'}`}>
                {draftNote ?? 'Ctrl+Enter to send'}
              </span>
              <button ref={discardRef} type="button" onClick={requestDiscard} disabled={busy} className={SECONDARY_BUTTON}>Discard</button>
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
