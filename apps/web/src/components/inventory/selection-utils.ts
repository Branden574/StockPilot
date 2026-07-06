/**
 * Header select-all semantics for paginated, live-refreshing tables.
 *
 * `selected` deliberately PERSISTS across pages and data refreshes so bulk
 * actions can span pages. On a live org, realtime refreshes reorder rows
 * under the selection (background writes bump updated_at), so `selected`
 * routinely contains ids that are no longer on the visible page. The old
 * header test — `selected.size === items.length` — desyncs permanently the
 * moment that happens: every visible row shows checked while the header
 * shows unchecked, and clicking it can only re-select, never clear
 * (owner-reported on L4L, unreproducible on the write-quiet demo org).
 *
 * Correct semantics (Gmail-style, page-scoped):
 *  - checked      = every VISIBLE row id ∈ selected (identity, not count)
 *  - indeterminate = some but not all visible rows selected
 *  - toggle       = add/remove the VISIBLE page's ids, preserving any
 *                   off-page selection either way
 */

export function isPageFullySelected(selected: ReadonlySet<string>, pageIds: readonly string[]): boolean {
  return pageIds.length > 0 && pageIds.every((id) => selected.has(id));
}

export function isPagePartiallySelected(
  selected: ReadonlySet<string>,
  pageIds: readonly string[],
): boolean {
  if (isPageFullySelected(selected, pageIds)) return false;
  return pageIds.some((id) => selected.has(id));
}

/** Add every visible id (keeps off-page ids). */
export function selectPage(selected: ReadonlySet<string>, pageIds: readonly string[]): Set<string> {
  const next = new Set(selected);
  for (const id of pageIds) next.add(id);
  return next;
}

/** Remove every visible id (keeps off-page ids). */
export function deselectPage(
  selected: ReadonlySet<string>,
  pageIds: readonly string[],
): Set<string> {
  const next = new Set(selected);
  for (const id of pageIds) next.delete(id);
  return next;
}
