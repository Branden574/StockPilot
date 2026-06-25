/**
 * Pure, side-effect-free helpers for working with per-location stock holdings.
 *
 * This file intentionally has NO server-only or 'use client' directive so that
 * both the server-only InventoryService AND client-side dialogs can import from
 * here without hitting the Next.js server/client boundary.
 */

/**
 * Filters a holdings list to only the locations that are valid transfer sources:
 *  - quantity must be > 0 (nothing to transfer from an empty location)
 *  - kind must not be 'staging' or 'unplaced' (those are managed by the
 *    staging workflow, not the manual transfer dialog)
 */
export function transferableHoldings<T extends { kind: string | null; quantity: number }>(
  holdings: T[],
): T[] {
  return holdings.filter((h) => h.quantity > 0 && h.kind !== 'staging' && h.kind !== 'unplaced');
}
