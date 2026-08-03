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
