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
