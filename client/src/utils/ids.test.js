import { afterEach, describe, expect, it, vi } from 'vitest';
import { newId } from './ids';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('newId', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('makes version 4 UUIDs', () => {
    expect(newId()).toMatch(UUID);
    expect(newId()).not.toBe(newId());
  });

  it('works without crypto.randomUUID (plain HTTP)', () => {
    const real = globalThis.crypto;
    vi.stubGlobal('crypto', { getRandomValues: (a) => real.getRandomValues(a) });
    expect(newId()).toMatch(UUID);
  });
});
