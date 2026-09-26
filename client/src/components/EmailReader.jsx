import { useState, useEffect, useRef } from 'react';
import DOMPurify from 'dompurify';
import * as api from '../api';
import Spinner from './Spinner';
import { formatFullDate } from '../utils/dates';

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

export default function EmailReader({ accountId, emailUid, onBack }) {
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
        <div className="mt-2 flex flex-wrap items-baseline gap-x-2 text-sm">
          <span className="font-medium text-ink-soft">{email.from || 'Unknown sender'}</span>
          {email.to && <span className="text-ink-muted break-all">to {email.to}</span>}
        </div>
        <div className="text-xs text-ink-muted mt-1">
          {formatFullDate(email.date)}
        </div>
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
