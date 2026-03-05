import { useState, useEffect } from 'react';
import DOMPurify from 'dompurify';
import * as api from '../api';
import { formatFullDate } from '../utils/dates';

export default function EmailReader({ emailUid, onBack }) {
  const [email, setEmail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setEmail(null);
    setError(null);
    setLoading(true);
    api
      .getEmail(emailUid)
      .then((data) => {
        if (!cancelled) setEmail(data);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [emailUid]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-6 h-6 border-2 border-slate-300 border-t-slate-600 rounded-full animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4">
        <button onClick={onBack} className="text-sm text-blue-600 hover:text-blue-700 mb-4 py-1 flex items-center gap-1">
          <span>&larr;</span> Back
        </button>
        <div className="bg-red-50 text-red-700 text-sm px-4 py-3 rounded-lg border border-red-100">
          {error}
        </div>
      </div>
    );
  }

  if (!email) return null;

  const bodyHtml = email.body_html
    ? (() => {
        // Force all links to open in a new tab
        DOMPurify.addHook('afterSanitizeAttributes', (node) => {
          if (node.tagName === 'A' && node.hasAttribute('href')) {
            node.setAttribute('target', '_blank');
            node.setAttribute('rel', 'noopener noreferrer');
          }
        });
        const clean = DOMPurify.sanitize(email.body_html, {
          ALLOW_TAGS: [
            'p', 'br', 'b', 'i', 'u', 'strong', 'em', 'a', 'img', 'div', 'span',
            'table', 'tr', 'td', 'th', 'thead', 'tbody', 'h1', 'h2', 'h3', 'h4',
            'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'hr',
          ],
          ALLOW_ATTR: ['href', 'src', 'alt', 'style', 'class', 'target', 'rel', 'width', 'height'],
        });
        DOMPurify.removeHook('afterSanitizeAttributes');
        return clean;
      })()
    : null;

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-slate-200 bg-white shrink-0">
        <button
          onClick={onBack}
          className="text-sm text-blue-600 hover:text-blue-700 flex items-center gap-1 mb-3 py-1"
        >
          <span>&larr;</span> Back to inbox
        </button>
        <h1 className="text-lg font-semibold text-slate-900">{email.subject}</h1>
        <div className="mt-2 flex items-baseline gap-2 text-sm">
          <span className="font-medium text-slate-700">{email.from}</span>
          <span className="text-slate-400">to {email.to}</span>
        </div>
        <div className="text-xs text-slate-400 mt-1">
          {formatFullDate(email.date)}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto bg-white p-4">
        {bodyHtml ? (
          <div
            className="prose prose-sm prose-slate max-w-none"
            dangerouslySetInnerHTML={{ __html: bodyHtml }}
          />
        ) : (
          <pre className="whitespace-pre-wrap text-sm text-slate-700 font-sans">
            {email.body_text || '(empty message)'}
          </pre>
        )}
      </div>
    </div>
  );
}
