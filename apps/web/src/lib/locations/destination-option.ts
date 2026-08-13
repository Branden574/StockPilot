import { hasRackPosition } from '@stockpilot/core';

/**
 * ONE shape for a put-away destination as it crosses the RSC → client
 * boundary. Pure types + a pure mapper, so a `server-only` page and a
 * `'use client'` dialog can both import it.
 *
 * It used to be declared THREE times (staging-table.tsx, place-from-staging-
 * dialog.tsx, bulk-place-dialog.tsx) as `{ id, name, kind }`, and the staging
 * page mapped locations down to exactly those three fields — so every
 * destination's rack/crate metadata was dropped on the floor and the dialog had
 * no way to show which crate an existing destination IS. Widening it in one
 * place is the fix; the field names deliberately mirror the `locations`
 * columns (migration 0188) so nothing has to guess at a translation.
 *
 * DISPLAY ONLY. Nothing a client sends back is trusted as proof of state: the
 * placement service re-reads the destination's crate columns from the DB
 * immediately before it writes anything (see
 * packages/core/src/inventory/book-crate-placement.ts).
 */
export interface DestinationOption {
  id: string;
  /** locations.name — "22-B" for a rack, "Blue #42" for a crate. */
  name: string;
  /** locations.kind — 'rack' | 'crate'. */
  kind: string;
  rackNumber: string | null;
  rackRow: string | null;
  crateColor: string | null;
  /** FREE TEXT — production holds 0, 1..16, "Bin", "Blue Shelf". */
  crateNumber: string | null;
}

/** The `locations` row columns this mapper needs. */
export interface DestinationLocationRow {
  id: string;
  name: string;
  kind: string | null;
  rack_number?: string | null;
  rack_row?: string | null;
  crate_color?: string | null;
  crate_number?: string | null;
}

export function toDestinationOption(loc: DestinationLocationRow): DestinationOption {
  return {
    id: loc.id,
    name: loc.name,
    kind: loc.kind ?? '',
    rackNumber: loc.rack_number ?? null,
    rackRow: loc.rack_row ?? null,
    crateColor: loc.crate_color ?? null,
    crateNumber: loc.crate_number ?? null,
  };
}

/**
 * The SERVER-side twin of DestinationOption: everything a put-away needs to
 * stamp an item's placement LABEL (bin_location + rack_* custom_fields) and —
 * for books — to re-synchronize the crate SUMMARY.
 *
 * It lives beside DestinationOption because both describe the same `locations`
 * row, and keeping one column list (`PLACE_DEST_COLUMNS`) feeding both is what
 * stops a write path from quietly forgetting the crate pair.
 *
 * EVERY FIELD IS SERVER-RESOLVED. Build it from the row you just re-read, or
 * from the row `findOrCreateRackOrCrate` RETURNED — never from client input.
 * A case-insensitive reuse ("blue #4" matching an existing "Blue #4") must
 * stamp the metadata that location really carries, not the user's spelling of
 * it, or the item summary and the location row start disagreeing about the
 * same crate.
 */
export type PlaceDest = {
  kind: string | null;
  rackNumber: string | null;
  rackRow: string | null;
  name: string | null;
  /** locations.crate_color — null for a rack. */
  crateColor?: string | null;
  /** locations.crate_number — null for a rack. FREE TEXT (see book-storage.ts). */
  crateNumber?: string | null;
};

/**
 * The `locations` columns a placement destination must be read back with. ONE
 * constant, so no write path can forget the crate pair and then "helpfully"
 * reconstruct it by parsing `name` — which is a DEDUPE KEY, not a data source.
 */
export const PLACE_DEST_COLUMNS =
  'id, warehouse_id, kind, rack_number, rack_row, crate_color, crate_number, name';

/**
 * Map a `locations` row — one just re-read from the DB, or the row
 * `findOrCreateRackOrCrate` returned — to a PlaceDest.
 *
 * This is the ONLY place a locations row becomes a placement destination. It
 * replaced four hand-rolled copies (two server actions, the mobile transfer
 * route, and the bulk path), each of which independently decided which columns
 * to carry — which is how the crate pair went missing from all four.
 */
export function toPlaceDest(loc: Record<string, unknown>): PlaceDest {
  return {
    kind: (loc.kind as string | null) ?? null,
    rackNumber: (loc.rack_number as string | null) ?? null,
    rackRow: (loc.rack_row as string | null) ?? null,
    name: (loc.name as string | null) ?? null,
    crateColor: (loc.crate_color as string | null) ?? null,
    crateNumber: (loc.crate_number as string | null) ?? null,
  };
}

/**
 * The PROVISIONAL destination for a "+ New rack / crate" branch — the row the
 * server is ABOUT to create, described before it exists.
 *
 * ═══ WHY A DESTINATION THAT DOES NOT EXIST YET IS A LEGITIMATE ONE ═══
 *
 * The placement gate now runs BEFORE the mint, because a gate that runs after it
 * leaves an empty rack/crate behind whenever the operator taps "Go back" — a
 * user-visible orphan with no cleanup path. Running first means the gate has to
 * compare against values that are not in the database yet.
 *
 * That is safe, and it is worth being precise about why, because the opposite
 * mistake caused the original data loss. The gate has two halves. The ITEM's
 * current summary is the safety-critical one and it still comes from the row the
 * server just read — never from the client, on any path. The DESTINATION half is
 * simply what the operator typed and is about to create; there is no stored
 * truth to disagree with, and trusting it here is not trusting a client's claim
 * about STATE.
 *
 * It is built from the ONE `planNewLocation` verdict — the same verdict that
 * names the row and fills its columns — so the crate the gate compares against
 * is character-for-character the crate the insert will hold. Hand-assembling
 * this from the raw form fields is exactly how a confirmation and a created row
 * came to differ before.
 *
 * An EXISTING match is never described this way: the caller resolves it first
 * (`LocationsService.findRackOrCrate`) and uses that row's real columns, because
 * a case-insensitive reuse means the stored spelling — not the typed one — is
 * the truth about that crate.
 */
export function plannedPlaceDest(plan: {
  kind: 'rack' | 'crate';
  name: string;
  rackNumber: string | null;
  rackRow: string | null;
  crateColor: string | null;
  crateNumber: string | null;
}): PlaceDest {
  return {
    kind: plan.kind,
    name: plan.name,
    rackNumber: plan.rackNumber,
    rackRow: plan.rackRow,
    crateColor: plan.crateColor,
    crateNumber: plan.crateNumber,
  };
}

/**
 * Is this destination a CRATE that sits on a rack?
 *
 * The TRANSFER paths (web `transferStockAction`, the mobile route's rack→rack
 * branch) deliberately do not stamp a placement label — "a transfer is not a
 * put-away", an asymmetry that predates all of this. They call
 * `stampPlacementBin` only when this returns true, and the narrowing is exact:
 * a positioned crate is the one destination whose crate summary and rack
 * summary describe the SAME physical place, so writing one without the other
 * publishes a row that contradicts itself — "recorded in Blue 13, on no rack" —
 * which is the owner-reported defect. A RACK destination and a position-less
 * crate keep the old asymmetry untouched.
 *
 * It lives beside `PlaceDest` rather than on InventoryService because it is a
 * pure question about the destination SHAPE, and because a static on a service
 * disappears the moment a caller's test mocks that service — which is not a
 * property you want on the predicate guarding a write.
 */
export function isPositionedCrate(dest: PlaceDest): boolean {
  return (
    dest.kind === 'crate' && hasRackPosition({ rackNumber: dest.rackNumber, rackRow: dest.rackRow })
  );
}
