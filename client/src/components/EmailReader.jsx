import { useState, useEffect, useRef } from 'react';
import DOMPurify from 'dompurify';
import * as api from '../api';
import Spinner from './Spinner';
import { formatFullDate } from '../utils/dates';
import { sameMailboxes } from '../utils/addresses';
import { hasOtherRecipients } from '../utils/replies';
import { formatSize } from '../utils/files';
import { ArchiveIcon, TrashIcon } from './icons';

function sanitizeEmailHtml(html) {
  // No img, style or class attributes: remote images and CSS backgrounds are
  // the common tracking channels, and dropping inline styles lets the email
  // follow the app's light/dark theme.
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'p', 'br', 'b', 'i', 'u', 's', 'strong', 'em', 'small', 'sub', 'sup', 'a', 'div', 'span',
      'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'blockquote', 'pre', 'code', 'hr',
    ],
    ALLOWED_ATTR: ['href', 'colspan', 'rowspan'],
  });
  const template = document.createElement('template');
  template.innerHTML = clean;
  for (const link of template.content.querySelectorAll('a[href]')) {
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer');
  }
  return template.innerHTML;
}

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
function AttachmentList({ accountId, uid, attachments }) {
  const [saved, setSaved] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  if (!attachments?.length) return null;

  const download = async (attachment) => {
    setError(null);
    setBusy(attachment.index);
    try {
      setSaved(await api.downloadAttachment(accountId, uid, attachment.index));
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
 * `onMove(email, 'archive' | 'trash')` offers Archive and Delete.
 */
export default function EmailReader({ accountId, emailUid, onBack, me, onReply, onMove }) {
  const [request, setRequest] = useState({ uid: null, email: null, error: null });
  const headingRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getEmail(accountId, emailUid)
      .then((data) => {
        if (!cancelled) setRequest({ uid: emailUid, email: data, error: null });
      })
      .catch((e) => {
        if (!cancelled) setRequest({ uid: emailUid, email: null, error: e.message });
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, emailUid]);

  const loaded = request.uid === emailUid && request.email;
  // Announce the newly opened message to screen readers and keyboard users.
  useEffect(() => {
    if (loaded) headingRef.current?.focus();
  }, [loaded]);

  if (request.uid !== emailUid) {
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

  // The desktop WebView cannot follow target="_blank" links, so hand them to
  // the system browser. (Enter on a focused link also fires click.)
  const handleBodyClick = (e) => {
    const link = e.target.closest?.('a[href]');
    if (!link || !api.isDesktop) return;
    e.preventDefault();
    api.openExternal(link.href).catch(() => {});
  };

  const bodyHtml = email.body_html ? sanitizeEmailHtml(email.body_html) : null;
  const imagesBlocked = Boolean(email.body_html && /<img\b/i.test(email.body_html));

  return (
    <article className="flex flex-col h-full">
      <header className="px-4 py-3 border-b border-line bg-canvas shrink-0">
        <div className="mb-3">
          <BackButton onBack={onBack}>Back to inbox</BackButton>
        </div>
        <h1
          ref={headingRef}
          tabIndex={-1}
          className={`text-lg font-semibold break-words focus:outline-none ${email.subject ? 'text-ink' : 'text-ink-muted'}`}
        >
          {email.subject || '(no subject)'}
        </h1>
        <MessageHeaders email={email} />
        <AttachmentList key={email.uid} accountId={accountId} uid={email.uid} attachments={email.attachments} />
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
          </div>
        )}
      </header>

      <div className="flex-1 overflow-y-auto bg-canvas p-4">
        {imagesBlocked && (
          <p className="mb-3 text-xs text-ink-muted bg-hover rounded px-3 py-2">
            Images in this email are blocked to protect your privacy.
          </p>
        )}
        {bodyHtml ? (
          <div
            className="prose prose-sm prose-slate dark:prose-invert max-w-none break-words prose-a:text-accent"
            onClick={handleBodyClick}
            dangerouslySetInnerHTML={{ __html: bodyHtml }}
          />
        ) : (
          <pre className="whitespace-pre-wrap break-words text-sm text-ink-soft font-sans">
            {email.body_text || '(empty message)'}
          </pre>
        )}
      </div>
    </article>
  );
}
