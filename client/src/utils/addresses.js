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

// Deliberately loose: the server does the real check. This only catches
// typing mistakes such as a missing @ or a stray space.
const EMAIL = /^[^\s@<>,;"]+@[^\s@<>,;"]+$/;

export function isEmailAddress(text) {
  return EMAIL.test(text);
}

/** Split on commas, semicolons, and line breaks outside quotes and <...>. */
function splitAddressList(text) {
  const parts = [];
  let current = '';
  let quoted = false;
  let bracketed = false;
  for (const char of text) {
    if (char === '"' && !bracketed) quoted = !quoted;
    else if (char === '<' && !quoted) bracketed = true;
    else if (char === '>' && !quoted) bracketed = false;
    if (!quoted && !bracketed && /[,;\n\r]/.test(char)) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

function parseOne(text) {
  const bracketed = text.match(/^(.*?)<\s*([^<>]+?)\s*>$/s);
  if (bracketed) {
    const name = bracketed[1].trim().replace(/^"(.*)"$/s, '$1').trim();
    const email = bracketed[2];
    return isEmailAddress(email) ? { name: name || null, email } : null;
  }
  return isEmailAddress(text) ? { name: null, email: text } : null;
}

/** Add addresses that are not already in the list (ignoring case). */
export function withAddresses(addresses, added) {
  const seen = new Set(addresses.map((a) => a.email.toLowerCase()));
  const result = [...addresses];
  for (const address of added) {
    if (!seen.has(address.email.toLowerCase())) {
      seen.add(address.email.toLowerCase());
      result.push(address);
    }
  }
  return result;
}

/**
 * Turn a recipient field's typed text ({ addresses, text }) into addresses.
 * Returns the new field value, whose text keeps whatever could not be
 * understood, and those pieces.
 */
export function commitText({ addresses, text }) {
  const { addresses: parsed, invalid } = parseAddresses(text);
  return {
    value: { addresses: withAddresses(addresses, parsed), text: invalid.join(', ') },
    invalid,
  };
}

/**
 * Parse typed or pasted recipients: `a@x.com, "Chen, Sarah" <s@x.com>; b@x.com`.
 * Returns the addresses understood and the pieces that were not.
 */
export function parseAddresses(text) {
  const addresses = [];
  const invalid = [];
  for (const part of splitAddressList(text)) {
    const address = parseOne(part);
    if (address) addresses.push(address);
    else invalid.push(part);
  }
  return { addresses, invalid };
}
