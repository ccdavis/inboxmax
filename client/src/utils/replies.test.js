import { describe, expect, it } from 'vitest';
import {
  forwardDraft, forwardSubject, hasOtherRecipients, htmlToText, mailtoDraft, replyDraft, replySubject,
} from './replies';

const ME = 'me@example.com';
const SARAH = { name: 'Sarah Chen', email: 'sarah@acme.example' };
const BOB = { name: 'Bob Park', email: 'bob@acme.example' };
const ANN = { name: null, email: 'ann@acme.example' };
const MINE = { name: null, email: ME };

function message(overrides = {}) {
  return {
    subject: 'Plans',
    from: [SARAH],
    reply_to: [],
    to: [MINE, BOB],
    cc: [ANN],
    date: '2026-09-25T13:00:00Z',
    received: '2026-09-25T13:00:05Z',
    body_text: 'Line one\n\nLine three',
    body_html: null,
    message_id: 'orig@acme.example',
    references: ['root@acme.example'],
    ...overrides,
  };
}

describe('subjects', () => {
  it('adds Re: and Fwd: once', () => {
    expect(replySubject('Plans')).toBe('Re: Plans');
    expect(replySubject('RE: Plans')).toBe('RE: Plans');
    expect(replySubject('re:Plans')).toBe('re:Plans');
    expect(replySubject('')).toBe('Re:');
    expect(forwardSubject('Plans')).toBe('Fwd: Plans');
    expect(forwardSubject('Fw: Plans')).toBe('Fw: Plans');
    expect(forwardSubject('FWD: Plans')).toBe('FWD: Plans');
  });
});

describe('replyDraft', () => {
  it('replies to the sender only, quoting the message and continuing the thread', () => {
    const draft = replyDraft(message(), { me: ME });
    expect(draft.to).toEqual([SARAH]);
    expect(draft.cc).toEqual([]);
    expect(draft.subject).toBe('Re: Plans');
    expect(draft.in_reply_to).toBe('orig@acme.example');
    expect(draft.references).toEqual(['root@acme.example', 'orig@acme.example']);
    expect(draft.focus).toBe('body');
    expect(draft.body).toMatch(/^\n\nOn .+, Sarah Chen <sarah@acme\.example> wrote:\n> Line one\n>\n> Line three\n$/);
  });

  it('replies to Reply-To instead of the sender when one is set', () => {
    const billing = { name: 'Billing', email: 'billing@acme.example' };
    expect(replyDraft(message({ reply_to: [billing] }), { me: ME }).to).toEqual([billing]);
  });

  it('replies to everyone except me, without repeating anyone', () => {
    const draft = replyDraft(message({ cc: [ANN, { name: 'Me Again', email: 'ME@example.com' }, SARAH] }), { me: ME, all: true });
    expect(draft.to).toEqual([SARAH, BOB]);
    expect(draft.cc).toEqual([ANN]);
  });

  it('replying to my own message goes to its recipients', () => {
    const own = message({ from: [MINE], to: [BOB], cc: [ANN] });
    expect(replyDraft(own, { me: ME }).to).toEqual([BOB]);
    expect(replyDraft(own, { me: ME, all: true })).toMatchObject({ to: [BOB], cc: [ANN] });
  });

  it('starts a thread when the original has no Message-ID', () => {
    const draft = replyDraft(message({ message_id: null, references: [] }), { me: ME });
    expect(draft).toMatchObject({ in_reply_to: null, references: [] });
  });

  it('quotes the HTML body when there is no plain-text one', () => {
    const draft = replyDraft(message({ body_text: null, body_html: '<p>Hello <b>there</b></p><p>Bye</p>' }), { me: ME });
    expect(draft.body).toContain('> Hello there\n>\n> Bye');
  });

  it('knows when Reply all reaches more people', () => {
    expect(hasOtherRecipients(message(), { me: ME })).toBe(true);
    expect(hasOtherRecipients(message({ to: [MINE], cc: [] }), { me: ME })).toBe(false);
  });
});

describe('forwardDraft', () => {
  it('carries the original attachments to send along', () => {
    const invoice = { index: 0, filename: 'invoice.pdf', content_type: 'application/pdf', size: 9 };
    expect(forwardDraft(message({ uid: 42, attachments: [invoice] })))
      .toMatchObject({ attachments: [invoice], forward_uid: 42, forward_folder: null });
    expect(forwardDraft(message()).attachments).toEqual([]);
    // From a server folder, the attachments are fetched from there.
    expect(forwardDraft(message({ uid: 3 }), { folder: 'sent' }))
      .toMatchObject({ forward_uid: 3, forward_folder: 'sent' });
  });

  it('carries the original headers in full and the text, with no recipients or threading', () => {
    const draft = forwardDraft(message());
    expect(draft).toMatchObject({ to: [], cc: [], subject: 'Fwd: Plans', in_reply_to: null, references: [], focus: 'to' });
    expect(draft.body).toContain('---------- Forwarded message ----------\n');
    expect(draft.body).toContain('From: Sarah Chen <sarah@acme.example>\n');
    expect(draft.body).toContain('Subject: Plans\n');
    expect(draft.body).toContain(`To: ${ME}, Bob Park <bob@acme.example>\n`);
    expect(draft.body).toContain('Cc: ann@acme.example\n');
    expect(draft.body).toMatch(/\n\nLine one\n\nLine three\n$/);
  });
});

describe('htmlToText', () => {
  it('keeps structure and writes out link targets', () => {
    const html = '<style>p{}</style><h2>Title</h2><p>Read <a href="https://x.example/doc">the docs</a> or '
      + '<a href="https://x.example">https://x.example</a>.<br>Next line</p><ul><li>One</li><li>Two</li></ul>';
    expect(htmlToText(html)).toBe(
      'Title\n\nRead the docs (https://x.example/doc) or https://x.example.\nNext line\n\n- One\n- Two',
    );
  });
});

describe('mailtoDraft', () => {
  it('fills in the address, and any subject, body, cc and bcc', () => {
    expect(mailtoDraft('mailto:sarah@acme.example?subject=Lunch%20plans&body=Hi%2C%0D%0Anoon%3F&cc=bob@acme.example')).toEqual({
      to: [{ name: null, email: 'sarah@acme.example' }],
      cc: [{ name: null, email: 'bob@acme.example' }],
      bcc: [],
      pending: { to: '', cc: '', bcc: '' },
      subject: 'Lunch plans',
      body: 'Hi,\nnoon?',
      focus: 'body',
    });
  });

  it('keeps "+" and takes several addresses, leaving what it cannot read to fix', () => {
    const draft = mailtoDraft('MAILTO:a+list@x.example,b@x.example?to=c@x.example&subject=a+b');
    expect(draft.to.map((a) => a.email)).toEqual(['a+list@x.example', 'b@x.example', 'c@x.example']);
    expect(draft.subject).toBe('a+b');
    const odd = mailtoDraft('mailto:not-an-address?subject=%E0%A4%A');
    expect(odd.to).toEqual([]);
    expect(odd.pending.to).toBe('not-an-address');
    expect(odd.subject).toBe('%E0%A4%A');
    expect(odd.focus).toBe('to');
    // Only the first ? and = split.
    const marks = mailtoDraft('mailto:x@y.example?subject=Coming?&body=a=b');
    expect([marks.subject, marks.body]).toEqual(['Coming?', 'a=b']);
  });
});

describe('replying to yourself under another tag', () => {
  it('leaves out plus-addressed forms of your own address', () => {
    const reply = replyDraft(message({ to: [{ name: null, email: 'Me+lists@Example.com' }, BOB], cc: [] }), { me: ME, all: true });
    expect(reply.to.map((a) => a.email)).toEqual(['sarah@acme.example', 'bob@acme.example']);
  });
});
