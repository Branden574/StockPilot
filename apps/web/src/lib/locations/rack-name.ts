/**
 * Human-readable name for an inline-created rack or crate.
 *
 * Shared by the web Transfer/Put-away server actions (transferStockAction /
 * placeStockAction) and the mobile transfer API route (POST
 * /api/v1/items/[id]/transfer) so a rack created from either surface gets the
 * IDENTICAL name. Lives here (not in the 'use server' action module, which may
 * only export async functions) so both callers can import the pure helper.
 *
 *   crate → "Blue #42"  (color + crate number, or the rack number as fallback)
 *   rack  → "A1-Row 3"  (rack number + row) or just "A1" when there's no row
 */
import { formatRackLabel, normalizeRackFields } from '@stockpilot/core';

export interface NewRackFields {
  rackNumber: string;
  rackRow?: string | null;
  crateColor?: string | null;
  crateNumber?: string | null;
}

export function deriveLocationName(n: NewRackFields): string {
  if (n.crateColor) {
    return `${n.crateColor} #${n.crateNumber ?? n.rackNumber}`;
  }
  // Compose through the ONE parser so the rack's display name always matches
  // the decomposed pair LocationsService.create stores. Typing "22-B" into the
  // number box yields the name "22-B" AND the columns ("22","B") — before, the
  // name was right while the columns were composite (incident 2026-07-23).
  return formatRackLabel(normalizeRackFields({ number: n.rackNumber, row: n.rackRow }));
}
