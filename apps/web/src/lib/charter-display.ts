/**
 * The ONE definition of how a charter renders when the item has none.
 *
 * `inventory_items.charter_id` is nullable, and NULL is meaningful: it means
 * generic stock that any charter the warehouse services can pull from. The
 * inventory list says so in words (inventory-table.tsx, three render sites);
 * every export path independently said nothing, so the Books PDF printed an em
 * dash and CSV/Excel printed a blank for the same row. This module exists so
 * the list page and the export pipeline read the same string from the same
 * place.
 *
 * NOT a lookup value and NOT stored: no row in `charters` is named "Generic".
 */
export const GENERIC_CHARTER_LABEL = 'Generic';

/**
 * Render the charter cell for an item.
 *
 * - id resolves          -> the charter's name
 * - id is null/undefined -> GENERIC_CHARTER_LABEL
 * - id set, no entry     -> '' (the lookup failed closed; claiming "Generic"
 *                           would assert something the data does not say)
 */
export function formatCharterCell(
  charterId: string | null | undefined,
  names: ReadonlyMap<string, string>,
): string {
  if (!charterId) return GENERIC_CHARTER_LABEL;
  return names.get(charterId) ?? '';
}

/**
 * A charter as a list's Charter cell reads it: the active charters the list
 * offers in its filter, and, for a label only, the archived and inactive ones
 * its records still carry (archiving only sets the status; the items keep
 * their charter). No status is active.
 */
export interface CharterCellEntry {
  name: string;
  code: string | null;
  status?: 'active' | 'inactive' | 'archived';
}

/**
 * What a list's Charter cell shows (Items, Books, Rentals > Items: table row,
 * grid card and group header):
 *
 * - no charter          -> Generic (any charter the warehouse services)
 * - a charter it knows  -> its code, else its name, with '(archived)' or
 *                          '(inactive)' after it when it is no longer active
 *                          (B97: an archived charter's stock was called
 *                          Generic, with a tooltip saying any charter could
 *                          use it)
 * - a charter it does not know (its name could not be read) -> nothing, as
 *   formatCharterCell does: never Generic, which the data does not say.
 */
export type CharterCell =
  { kind: 'generic' } | { kind: 'charter'; text: string; title: string } | { kind: 'unknown' };

export function charterCellFor(
  charterId: string | null | undefined,
  charters: ReadonlyMap<string, CharterCellEntry> | undefined,
): CharterCell {
  if (!charterId) return { kind: 'generic' };
  const entry = charters?.get(charterId);
  if (!entry) return { kind: 'unknown' };
  const mark =
    entry.status === 'archived' || entry.status === 'inactive' ? ` (${entry.status})` : '';
  return {
    kind: 'charter',
    text: `${entry.code ?? entry.name}${mark}`,
    title: `${entry.name}${mark}`,
  };
}

/**
 * The Charter cell's lookup: the list's active charters, and the labels of
 * the others (`unlisted`, each with its status). An id in both keeps its
 * active entry.
 */
export function charterCellLookup(
  active: ReadonlyArray<{ id: string; name: string; code: string | null }>,
  unlisted: ReadonlyArray<{
    id: string;
    name: string;
    code: string | null;
    status: 'active' | 'inactive' | 'archived';
  }> = [],
): Map<string, CharterCellEntry> {
  const map = new Map<string, CharterCellEntry>();
  for (const c of unlisted) map.set(c.id, { name: c.name, code: c.code, status: c.status });
  for (const c of active) map.set(c.id, { name: c.name, code: c.code });
  return map;
}
