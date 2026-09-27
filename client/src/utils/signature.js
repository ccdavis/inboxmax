// A mailbox's signature in the compose form.

/**
 * The compose form's starting state with the signature added: below where
 * the user writes, and above any quoted or forwarded message, set off by
 * the usual "-- " line that mail programs recognize.
 */
export function withSignature(initial, signature) {
  if (!signature?.trim()) return initial;
  const rest = (initial.body ?? '').replace(/^\n+/, '');
  const block = `-- \n${signature}`;
  return { ...initial, body: `\n\n${block}${rest ? `\n\n${rest}` : '\n'}` };
}
