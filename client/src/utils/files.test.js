import { describe, expect, it } from 'vitest';
import { formatSize, readAsBase64 } from './files';

describe('files', () => {
  it('formats sizes readably', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(1023)).toBe('1023 B');
    expect(formatSize(1024)).toBe('1 KB');
    expect(formatSize(48_000)).toBe('47 KB');
    expect(formatSize(1.4 * 1024 * 1024)).toBe('1.4 MB');
    expect(formatSize(25 * 1024 * 1024)).toBe('25 MB');
  });

  it('reads a file as plain base64', async () => {
    expect(await readAsBase64(new File(['hello'], 'a.txt', { type: 'text/plain' }))).toBe(btoa('hello'));
    expect(await readAsBase64(new File([], 'empty.bin'))).toBe('');
  });
});
