import { describe, expect, it } from 'vitest';
import { senderColor, senderInitial, senderName } from './senders';

describe('sender helpers', () => {
  it('derive a display name, initial, and stable color', () => {
    expect(senderName('  Ada Lovelace ')).toBe('Ada Lovelace');
    expect(senderName('')).toBe('Unknown');
    expect(senderInitial('"ada" ')).toBe('A');
    expect(senderInitial('😀 Party')).toBe('😀');
    expect(senderInitial(null)).toBe('?');
    expect(senderColor('Ada')).toBe(senderColor('Ada'));
  });
});
