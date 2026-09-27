import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { hasLoadableImages, sanitizeEmailHtml } from '../utils/emailHtml';
import * as api from '../api';
import Spinner from './Spinner';
import { formatFullDate } from '../utils/dates';
import { sameMailboxes } from '../utils/addresses';
import { hasOtherRecipients, mailtoDraft } from '../utils/replies';
import { formatSize } from '../utils/files';
import { canMoveToInbox, folderLabel } from '../utils/folders';
import { ArchiveIcon, TrashIcon } from './icons';

/**
 * The message's (sanitized) HTML. React rewrites innerHTML on every render
 * of an element that sets it, which would rebuild the email under the
 * reader (losing a focused link, a selection, a screen reader's place)
 * each time anything else on the page changed; so it renders only when
 * the HTML does.
 */
const EmailBody = memo(function EmailBody({ html, onClick }) {
  return (
    <div
      className="prose prose-sm prose-slate dark:prose-invert max-w-none break-words prose-a:text-accent prose-img:inline-block prose-img:my-2 prose-img:max-w-full prose-img:h-auto"
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});

// Sender and server clocks disagree by seconds routinely; beyond this the
// sent time is worth showing next to the received time.
const CLOCK_SLACK_MS = 5 * 60 * 1000;

function Address({ address }) {
  return (
    <span className="break-words">
      {address.name ? (
        <>
          <span className="font-medium text-ink">{address.name}</span>{' '}
          <span className="text-ink-muted break-all">&lt;{address.email}&gt;</span>
        </>
      ) : (
        <span className="text-ink break-all">{address.email}</span>
      )}
    </span>
  );
}

function HeaderRow({ label, children }) {
  return (
    <>
      <dt className="text-ink-muted">{label}</dt>
      <dd className="min-w-0 text-ink-soft">{children}</dd>
    </>
  );
}

function AddressList({ addresses }) {
  if (!addresses?.length) return <span className="text-ink-muted">(none)</span>;
  return (
    <ul className="flex flex-col gap-0.5">
      {addresses.map((address) => (
        <li key={`${address.email}|${address.name ?? ''}`}>
          <Address address={address} />
        </li>
      ))}
    </ul>
  );
}

/**
 * Who and when, spelled out: every address in full (people write from more
 * than one), where replies really go, and when the message arrived as well
 * as when the sender says they sent it.
 */
export function MessageHeaders({ email }) {
  const replyToDiffers = email.reply_to?.length > 0 && !sameMailboxes(email.reply_to, email.from);
  const sentDiffers = email.date && email.received
    && Math.abs(new Date(email.received) - new Date(email.date)) > CLOCK_SLACK_MS;

  return (
    <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
      <HeaderRow label="From">
        {email.from?.length ? <AddressList addresses={email.from} /> : <span className="text-ink-muted">Unknown sender</span>}
      </HeaderRow>
      {email.reply_to?.length > 0 && (
        <HeaderRow label="Reply-To">
          <AddressList addresses={email.reply_to} />
          {replyToDiffers && (
            <p className="mt-0.5 text-xs font-medium text-star">
              Replies go here, not to the sender.
            </p>
          )}
        </HeaderRow>
      )}
      <HeaderRow label="To">
        <AddressList addresses={email.to} />
      </HeaderRow>
      {email.cc?.length > 0 && (
        <HeaderRow label="Cc">
          <AddressList addresses={email.cc} />
        </HeaderRow>
      )}
      {email.received ? (
        <HeaderRow label="Received">
          <time dateTime={email.received}>{formatFullDate(email.received)}</time>
        </HeaderRow>
      ) : null}
      {(sentDiffers || !email.received) && email.date && (
        <HeaderRow label="Sent">
          <time dateTime={email.date}>{formatFullDate(email.date)}</time>
          {sentDiffers && <span className="text-ink-muted"> (by the sender&rsquo;s clock)</span>}
        </HeaderRow>
      )}
    </dl>
  );
}

/**
 * The message's attachments, each downloadable. The desktop app saves into
 * Downloads and says where, with a way to show the file.
 */
function AttachmentList({ accountId, folder, uid, attachments }) {
  const [saved, setSaved] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  if (!attachments?.length) return null;

  const download = async (attachment) => {
    setError(null);
    setBusy(attachment.index);
    try {
      setSaved(await (folder
        ? api.downloadFolderAttachment(accountId, folder, uid, attachment.index)
        : api.downloadAttachment(accountId, uid, attachment.index)));
    } catch (caught) {
      setError(`Could not download ${attachment.filename}: ${caught.message}`);
    } finally {
      setBusy(null);
    }
  };

  const show = () => api.showInFolder(saved.path).catch((caught) => setError(caught.message));

  return (
    <section aria-label="Attachments" className="mt-3">
      <ul className="flex flex-wrap gap-2">
        {attachments.map((attachment) => (
          <li key={attachment.index}>
            <button
              type="button"
              onClick={() => download(attachment)}
              disabled={busy === attachment.index}
              className="flex max-w-xs items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-left text-sm hover:bg-hover disabled:opacity-50 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
              aria-label={`Download ${attachment.filename}, ${formatSize(attachment.size)}`}
            >
              <span aria-hidden="true">📎</span>
              <span className="min-w-0 truncate text-ink">{attachment.filename}</span>
              <span className="shrink-0 text-xs text-ink-muted">{formatSize(attachment.size)}</span>
            </button>
          </li>
        ))}
      </ul>
      {saved && (
        <p role="status" className="mt-2 flex flex-wrap items-center gap-2 text-sm text-ink-soft">
          Saved {saved.filename} in Downloads.
          <button type="button" onClick={show} className="text-accent hover:text-accent-hover underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded">
            Show in folder
          </button>
        </p>
      )}
      {error && <p role="alert" className="mt-2 text-sm text-danger-ink">{error}</p>}
    </section>
  );
}

function ActionButton({ onClick, icon, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm text-ink-soft hover:bg-hover hover:text-ink transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
    >
      <span aria-hidden="true">{icon}</span>
      {children}
    </button>
  );
}

function BackButton({ onBack, children }) {
  return (
    <button
      type="button"
      onClick={onBack}
      className="text-sm text-accent hover:text-accent-hover flex items-center gap-1 py-1 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
    >
      <span aria-hidden="true">&larr;</span> {children}
    </button>
  );
}

/**
 * One message. `onReply(kind, email)` with kind 'reply', 'all', or 'forward'
 * offers the reply actions; `me` is the mailbox's own address, so Reply all
 * appears only when it would reach someone besides the sender.
 * `onMove(email, 'archive' | 'trash')` offers Archive and Delete, and
 * `onWrite(initial)` starts a message from a mailto: link in the email.
 *
 * With `folder` ({ kind, name }) the message is one in that server folder,
 * read without marking it read; `onMoveToInbox(email)` offers to put it back.
 */
export default function EmailReader({ accountId, emailUid, folder, onBack, me, onReply, onWrite, onMove, onMoveToInbox }) {
  const [request, setRequest] = useState({ key: null, email: null, error: null });
  // The message whose images the user asked to see; only ever that one.
  const [imagesShownFor, setImagesShownFor] = useState(null);
  const imagesShownRef = useRef(null);
  const headingRef = useRef(null);
  const folderKind = folder?.kind ?? null;
  // UIDs are only unique within one folder.
  const key = `${folderKind ?? 'inbox'}|${emailUid}`;

  useEffect(() => {
    let cancelled = false;
    const fetched = folderKind
      ? api.getFolderEmail(accountId, folderKind, emailUid)
      : api.getEmail(accountId, emailUid);
    fetched
      .then((data) => {
        if (!cancelled) setRequest({ key, email: data, error: null });
      })
      .catch((e) => {
        if (!cancelled) setRequest({ key, email: null, error: e.message });
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, emailUid, folderKind, key]);

  const loaded = request.key === key && request.email;
  // Announce the newly opened message to screen readers and keyboard users.
  useEffect(() => {
    if (loaded) headingRef.current?.focus();
  }, [loaded]);
  const imagesShown = imagesShownFor === key;
  useEffect(() => {
    if (imagesShown) imagesShownRef.current?.focus();
  }, [imagesShown]);

  // An address link starts a message here. The desktop WebView cannot
  // follow target="_blank" links, so web links go to the system browser.
  // (Enter on a focused link also fires click.) The handler never changes,
  // so the body is not redrawn; it reads the latest onWrite.
  const onWriteRef = useRef(onWrite);
  useEffect(() => {
    onWriteRef.current = onWrite;
  });
  const handleBodyClick = useCallback((e) => {
    const link = e.target.closest?.('a[href]');
    if (!link) return;
    if (onWriteRef.current && /^mailto:/i.test(link.getAttribute('href'))) {
      e.preventDefault();
      onWriteRef.current(mailtoDraft(link.getAttribute('href')));
      return;
    }
    if (!api.isDesktop) return;
    e.preventDefault();
    api.openExternal(link.href).catch(() => {});
  }, []);

  if (request.key !== key) {
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner label="Loading email" />
      </div>
    );
  }

  if (request.error) {
    return (
      <div className="p-4">
        <div className="mb-4">
          <BackButton onBack={onBack}>Back</BackButton>
        </div>
        <div role="alert" className="bg-danger-bg text-danger-ink text-sm px-4 py-3 rounded-lg border border-danger-line">
          {request.error}
        </div>
      </div>
    );
  }

  const email = request.email;

  const bodyHtml = email.body_html ? sanitizeEmailHtml(email.body_html, { images: imagesShown }) : null;
  const imagesBlocked = !imagesShown && hasLoadableImages(email.body_html);

  return (
    <article className="flex flex-col h-full">
      <header className="px-4 py-3 border-b border-line bg-canvas shrink-0">
        <div className="mb-3">
          <BackButton onBack={onBack}>{folder ? `Back to ${folderLabel(folder.kind)}` : 'Back to inbox'}</BackButton>
        </div>
        <h1
          ref={headingRef}
          tabIndex={-1}
          className={`text-lg font-semibold break-words focus:outline-none ${email.subject ? 'text-ink' : 'text-ink-muted'}`}
        >
          {email.subject || '(no subject)'}
        </h1>
        <MessageHeaders email={email} />
        <AttachmentList
          key={email.uid}
          accountId={accountId}
          folder={folder?.kind}
          uid={email.uid}
          attachments={email.attachments}
        />
        {onReply && (
          <div className="mt-3 flex flex-wrap gap-2">
            <ActionButton icon="↩" onClick={() => onReply('reply', email)}>Reply</ActionButton>
            {hasOtherRecipients(email, { me }) && (
              <ActionButton icon="↩↩" onClick={() => onReply('all', email)}>Reply all</ActionButton>
            )}
            <ActionButton icon="↪" onClick={() => onReply('forward', email)}>Forward</ActionButton>
            {onMove && (
              <>
                <ActionButton icon={<ArchiveIcon />} onClick={() => onMove(email, 'archive')}>Archive</ActionButton>
                <ActionButton icon={<TrashIcon />} onClick={() => onMove(email, 'trash')}>Delete</ActionButton>
              </>
            )}
            {/* Putting it back finds the message by its Message-ID. */}
            {onMoveToInbox && folderKind && canMoveToInbox(folderKind) && email.message_id && (
              <ActionButton icon="⤴" onClick={() => onMoveToInbox(email)}>Move to Inbox</ActionButton>
            )}
          </div>
        )}
      </header>

      <div className="flex-1 overflow-y-auto bg-canvas p-4">
        {imagesBlocked && (
          <p className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-muted bg-hover rounded px-3 py-2">
            <span>Images in this email are blocked to protect your privacy.</span>
            {/* Loading them tells the sender the email was opened, and when. */}
            <button
              type="button"
              onClick={() => setImagesShownFor(key)}
              className="font-medium text-accent hover:text-accent-hover underline-offset-2 hover:underline rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            >
              Show images
            </button>
          </p>
        )}
        {imagesShown && (
          // Takes the focus from the button it replaces, and says what happened.
          <p ref={imagesShownRef} tabIndex={-1} className="mb-3 text-xs text-ink-muted rounded px-3 py-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
            Images are shown for this message.
          </p>
        )}
        {bodyHtml ? (
          <EmailBody html={bodyHtml} onClick={handleBodyClick} />
        ) : (
          <pre className="whitespace-pre-wrap break-words text-sm text-ink-soft font-sans">
            {email.body_text || '(empty message)'}
          </pre>
        )}
      </div>
    </article>
  );
}
