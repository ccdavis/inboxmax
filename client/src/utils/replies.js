// Drafts for replying to and forwarding a message, as the compose dialog's
// `initial` value.
import { formatAddress, withAddresses } from './addresses';
import { formatFullDate } from './dates';

const REPLY_PREFIX = /^\s*re\s*:/i;
const FORWARD_PREFIX = /^\s*fwd?\s*:/i;

export function replySubject(subject = '') {
  const trimmed = subject.trim();
  return REPLY_PREFIX.test(trimmed) ? trimmed : `Re: ${trimmed}`.trim();
}

export function forwardSubject(subject = '') {
  const trimmed = subject.trim();
  return FORWARD_PREFIX.test(trimmed) ? trimmed : `Fwd: ${trimmed}`.trim();
}

const BLOCKS = 'p, div, tr, h1, h2, h3, h4, h5, h6, blockquote, pre, table, ul, ol, hr';

/**
 * Readable text from an HTML body, for quoting: paragraphs and line breaks
 * kept, list items bulleted, and link targets written out.
 */
export function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style, head').forEach((el) => el.remove());
  for (const link of doc.querySelectorAll('a[href]')) {
    const href = link.getAttribute('href');
    if (/^(https?|mailto):/i.test(href) && link.textContent.trim() !== href) {
      link.append(` (${href.replace(/^mailto:/i, '')})`);
    }
  }
  doc.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
  doc.querySelectorAll('li').forEach((li) => {
    li.prepend('\n- ');
  });
  doc.querySelectorAll(BLOCKS).forEach((el) => {
    el.prepend('\n');
    el.append('\n');
  });
  return (doc.body?.textContent ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The message's text, preferring the plain-text part. */
export function bodyText(email) {
  const text = email.body_text ?? (email.body_html ? htmlToText(email.body_html) : '');
  return text.replace(/\r\n/g, '\n').trimEnd();
}

function quote(text) {
  return text.split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n');
}

function addressList(addresses = []) {
  return addresses.map(formatAddress).join(', ');
}

function attribution(email) {
  const who = email.from?.length ? addressList(email.from) : 'Someone';
  const when = email.date ?? email.received;
  return when ? `On ${formatFullDate(when)}, ${who} wrote:` : `${who} wrote:`;
}

/** Continue the message's thread: reply to it, after what it replied to. */
function threading(email) {
  const references = email.references ?? [];
  if (!email.message_id) return { in_reply_to: null, references };
  return {
    in_reply_to: email.message_id,
    references: references.includes(email.message_id) ? references : [...references, email.message_id],
  };
}

/**
 * A reply, or with `all` a reply to everyone. Replies go to Reply-To when
 * the sender set one. Your own address (`me`) is never a recipient; replying
 * to your own message goes to the people it was sent to.
 */
export function replyDraft(email, { me, all = false }) {
  const notMe = (address) => address.email.toLowerCase() !== me.toLowerCase();
  const sender = (email.reply_to?.length ? email.reply_to : email.from) ?? [];
  let to = sender.filter(notMe);
  const ownMessage = to.length === 0;
  if (ownMessage || all) {
    to = withAddresses(to, (email.to ?? []).filter(notMe));
  }
  const cc = all
    ? withAddresses([], (email.cc ?? []).filter(notMe))
      .filter((address) => !to.some((t) => t.email.toLowerCase() === address.email.toLowerCase()))
    : [];
  return {
    to,
    cc,
    subject: replySubject(email.subject),
    body: `\n\n${attribution(email)}\n${quote(bodyText(email))}\n`,
    ...threading(email),
    focus: 'body',
  };
}

/** Whether Reply all would reach anyone that Reply does not. */
export function hasOtherRecipients(email, { me }) {
  const reply = replyDraft(email, { me });
  const all = replyDraft(email, { me, all: true });
  return all.to.length + all.cc.length > reply.to.length;
}

/** A forward: the original's headers in full, then its text. */
export function forwardDraft(email) {
  const header = [
    '---------- Forwarded message ----------',
    `From: ${addressList(email.from)}`,
    `Date: ${formatFullDate(email.date ?? email.received)}`,
    `Subject: ${email.subject ?? ''}`,
    `To: ${addressList(email.to)}`,
    ...(email.cc?.length ? [`Cc: ${addressList(email.cc)}`] : []),
  ];
  return {
    to: [],
    cc: [],
    subject: forwardSubject(email.subject),
    body: `\n\n${header.join('\n')}\n\n${bodyText(email)}\n`,
    in_reply_to: null,
    references: [],
    focus: 'to',
  };
}
