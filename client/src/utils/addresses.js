// Address headers arrive as [{ name, email }]: the name is optional and the
// address is always kept, because one person can write from several.

/** "Name <email>", or just the address when there is no name. */
export function formatAddress({ name, email }) {
  return name ? `${name} <${email}>` : email;
}

/** Whether two address lists name the same mailboxes, ignoring case and order. */
export function sameMailboxes(a = [], b = []) {
  const set = (list) => new Set(list.map((entry) => entry.email.toLowerCase()));
  const left = set(a);
  const right = set(b);
  return left.size === right.size && [...left].every((email) => right.has(email));
}
