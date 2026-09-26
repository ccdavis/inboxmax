const AVATAR_COLORS = [
  'bg-blue-500', 'bg-emerald-500', 'bg-violet-500', 'bg-amber-500',
  'bg-rose-500', 'bg-cyan-500', 'bg-indigo-500', 'bg-orange-500',
];

/** Display name for a sender; the server sends a name or a bare address. */
export function senderName(from) {
  return from?.trim() || 'Unknown';
}

/** First visible character of the sender, ignoring quote marks. */
export function senderInitial(from) {
  const clean = (from || '').replace(/["']/g, '').trim();
  const [first] = Array.from(clean); // whole code point, so emoji stay intact
  return first ? first.toUpperCase() : '?';
}

/** Stable avatar color for a sender. */
export function senderColor(from) {
  const name = from || '';
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}
