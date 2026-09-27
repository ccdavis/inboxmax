// Keeping keyboard and screen-reader users in place when a list changes.

/**
 * Focus the row for `uid` in `container` (rows are `li[data-uid]`, newest
 * first), or, unless `exact`, where it was: the next row down, else the
 * last. With no `uid`, no such row, or no rows, `fallback` (a heading, say)
 * gets focus, so it never drops to the page.
 */
export function focusRow(container, uid, fallback, { exact = false } = {}) {
  const rows = uid == null ? [] : [...(container?.querySelectorAll('li[data-uid]') ?? [])];
  const at = (row) => Number(row.dataset.uid);
  const row = rows.find((r) => at(r) === uid)
    ?? (exact ? undefined : rows.find((r) => at(r) < uid) ?? rows.at(-1));
  const target = row?.querySelector('button') ?? fallback;
  target?.focus();
}

/**
 * Whether a request to move focus into `container` should be carried out:
 * when it says so (`force`), or when focus has been lost to the page (the
 * control that had it went away) or is still in that container. Focus the
 * user has since taken elsewhere, into the search box say, stays there.
 */
export function mayMoveFocus(container, { force = false } = {}) {
  const current = document.activeElement;
  return force || !current || current === document.body || Boolean(container?.contains(current));
}
