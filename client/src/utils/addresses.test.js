import { describe, expect, it } from 'vitest';
import { formatAddress, parseAddresses, sameMailboxes } from './addresses';

describe('addresses', () => {
  it('formats with and without a name', () => {
    expect(formatAddress({ name: 'Sarah Chen', email: 's@x.example' })).toBe('Sarah Chen <s@x.example>');
    expect(formatAddress({ name: null, email: 's@x.example' })).toBe('s@x.example');
  });

  it('compares mailboxes ignoring case and order', () => {
    const a = [{ email: 'A@x.example' }, { email: 'b@x.example' }];
    expect(sameMailboxes(a, [{ email: 'b@x.example' }, { email: 'a@X.example' }])).toBe(true);
    expect(sameMailboxes(a, [{ email: 'a@x.example' }])).toBe(false);
    expect(sameMailboxes([], [])).toBe(true);
  });

  it('parses a pasted list with names, quotes, and mixed separators', () => {
    const { addresses, invalid } = parseAddresses(
      'a@x.example, "Chen, Sarah" <sarah@x.example>; Bob Park <bob@x.example>\nc@x.example',
    );
    expect(addresses).toEqual([
      { name: null, email: 'a@x.example' },
      { name: 'Chen, Sarah', email: 'sarah@x.example' },
      { name: 'Bob Park', email: 'bob@x.example' },
      { name: null, email: 'c@x.example' },
    ]);
    expect(invalid).toEqual([]);
  });

  it('reports what it could not understand', () => {
    const { addresses, invalid } = parseAddresses('ok@x.example, not an address, <also bad>, missing@');
    expect(addresses).toEqual([{ name: null, email: 'ok@x.example' }]);
    expect(invalid).toEqual(['not an address', '<also bad>', 'missing@']);
  });

  it('ignores empty pieces', () => {
    expect(parseAddresses(' , ;\n')).toEqual({ addresses: [], invalid: [] });
    expect(parseAddresses('<a@x.example>').addresses).toEqual([{ name: null, email: 'a@x.example' }]);
  });
});
