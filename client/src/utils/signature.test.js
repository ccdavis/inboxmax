import { describe, expect, it } from 'vitest';
import { withSignature } from './signature';

describe('withSignature', () => {
  it('starts a new message with the signature below where the user writes', () => {
    expect(withSignature({}, 'Ada\nAnalyst')).toEqual({ body: '\n\n-- \nAda\nAnalyst\n' });
  });

  it('goes above a quoted or forwarded message', () => {
    const reply = { subject: 'Re: Hi', body: '\n\nOn Monday, B wrote:\n> Hi\n', focus: 'body' };
    expect(withSignature(reply, 'Ada')).toEqual({
      subject: 'Re: Hi',
      body: '\n\n-- \nAda\n\nOn Monday, B wrote:\n> Hi\n',
      focus: 'body',
    });
  });

  it('leaves the message alone without a signature', () => {
    const reply = { body: '\n\nquoted' };
    expect(withSignature(reply, '')).toBe(reply);
    expect(withSignature(reply, '  \n')).toBe(reply);
    expect(withSignature(reply, undefined)).toBe(reply);
  });
});

describe('withSignature on a message started from a link', () => {
  it('goes after the text the link supplied', () => {
    expect(withSignature({ body: 'Hi there\n\n' }, 'Ada', { quoted: false })).toEqual({ body: 'Hi there\n\n-- \nAda\n' });
    expect(withSignature({ body: '' }, 'Ada', { quoted: false })).toEqual({ body: '\n\n-- \nAda\n' });
  });
});
