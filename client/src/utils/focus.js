// Keeping keyboard and screen-reader users in place when a list changes.

/**
 * Focus the row for `uid` in `container` (rows are `li[data-uid]`, newest
 * first), or where it was: the next row down, else the last. With no `uid`
 * or no rows, `fallback` (a heading, say) gets focus, so it never drops to
 * the page.
 */
export function focusRow(container, uid, fallback) {
  const rows = uid == null ? [] : [...(container?.querySelectorAll('li[data-uid]') ?? [])];
  const at = (row) => Number(row.dataset.uid);
  const row = rows.find((r) => at(r) === uid) ?? rows.find((r) => at(r) < uid) ?? rows.at(-1);
  const target = row?.querySelector('button') ?? fallback;
  target?.focus();
}
