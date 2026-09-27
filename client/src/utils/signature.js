// A mailbox's signature in the compose form.

/**
 * The compose form's starting state with the signature added, set off by
 * the usual "-- " line that mail programs recognize. It goes below where
 * the user writes, and above a quoted or forwarded message; with `quoted`
 * false the body is the user's own start (a mailto: link's), and the
 * signature follows it.
 */
export function withSignature(initial, signature, { quoted = true } = {}) {
  if (!signature?.trim()) return initial;
  const block = `-- \n${signature}`;
  const body = initial.body ?? '';
  if (!quoted) {
    return { ...initial, body: body.trim() ? `${body.trimEnd()}\n\n${block}\n` : `\n\n${block}\n` };
  }
  const rest = body.replace(/^\n+/, '');
  return { ...initial, body: `\n\n${block}${rest ? `\n\n${rest}` : '\n'}` };
}
