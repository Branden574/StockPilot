/**
 * Human-readable name for an inline-created rack or crate.
 *
 * Shared by the web Transfer/Put-away server actions (transferStockAction /
 * placeStockAction / bulkPlaceStockAction) and the mobile transfer API route
 * (POST /api/v1/items/[id]/transfer) so a rack created from either surface gets
 * the IDENTICAL name. Lives here (not in the 'use server' action module, which
 * may only export async functions) so both callers can import the pure helper.
 *
 *   crate → "Blue #42"  (see formatCrateLocationName — this is the DEDUPE KEY
 *                        migration 0270's unique index is built on)
 *   rack  → "22-B"      (rack number + row) or just "22" when there's no row
 *
 * A crate is decided by `isCrateDestination` — a crate NUMBER alone is enough.
 * Four write paths used to test `crateColor ? 'crate' : 'rack'`, so a
 * number-only crate silently became a rack.
 */
import { formatCrateLocationName, formatRackLabel, isCrateDestination, normalizeRackFields } from '@stockpilot/core';

export interface NewRackFields {
  /** Optional: a crate does not need one (only a rack does). */
  rackNumber?: string | null;
  rackRow?: string | null;
  crateColor?: string | null;
  crateNumber?: string | null;
}

export function deriveLocationName(n: NewRackFields): string {
  if (isCrateDestination(n)) {
    // A crate identified only by color has no number to name it with, so it
    // falls back to the rack number the user typed — the same fallback the
    // colored branch has always had.
    return (
      formatCrateLocationName(n.crateColor, n.crateNumber) ||
      formatCrateLocationName(n.crateColor, n.rackNumber)
    );
  }
  // Compose through the ONE parser so the rack's display name always matches
  // the decomposed pair LocationsService.create stores. Typing "22-B" into the
  // number box yields the name "22-B" AND the columns ("22","B") — before, the
  // name was right while the columns were composite (incident 2026-07-23).
  return formatRackLabel(normalizeRackFields({ number: n.rackNumber, row: n.rackRow }));
}
