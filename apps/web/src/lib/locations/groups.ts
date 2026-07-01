/**
 * Location grouping — the single source of truth for how a `locations` row is
 * classified, shared by the server (LocationsService.list picker filter) and
 * the client (the 3-tab Locations page). Keep it dependency-free so both a
 * `server-only` module and a `'use client'` component can import it.
 *
 * Three mutually-exclusive, total groups:
 *   - system    → the automatic buckets (Staging, Unplaced)
 *   - rack-shelf → fine-grained placements inside a site (racks, crates, areas,
 *                  shelves, bins)
 *   - site      → an actual place stock lives at (warehouse, room, vehicle,
 *                 job site). This is what location PICKERS should offer:
 *                 an item's primary stocking location / a PO's receiving
 *                 destination is a SITE, never a rack.
 *
 * `site` is the catch-all so the three groups partition every row — the picker
 * set and the "Sites" tab always match exactly.
 */
export type LocationGroup = 'site' | 'rack-shelf' | 'system';

export interface LocationLike {
  type: string | null;
  kind: string | null;
}

const SYSTEM_KINDS = new Set(['staging', 'unplaced']);
// `area` is a warehouse subdivision — a placement, not a top-level site.
const PLACEMENT_KINDS = new Set(['rack', 'crate', 'area']);
const PLACEMENT_TYPES = new Set(['shelf', 'bin']);

export function isSystemLocation(loc: LocationLike): boolean {
  return SYSTEM_KINDS.has(loc.kind ?? '');
}

export function isRackShelfLocation(loc: LocationLike): boolean {
  if (isSystemLocation(loc)) return false;
  return PLACEMENT_KINDS.has(loc.kind ?? '') || PLACEMENT_TYPES.has(loc.type ?? '');
}

/**
 * A pickable stocking site (warehouse/room/vehicle/job site + any future
 * non-placement type). Excludes racks/shelves/crates/bins/areas and the
 * staging/unplaced system buckets. Used by every location picker.
 */
export function isSiteLocation(loc: LocationLike): boolean {
  return !isSystemLocation(loc) && !isRackShelfLocation(loc);
}

export function locationGroup(loc: LocationLike): LocationGroup {
  if (isSystemLocation(loc)) return 'system';
  if (isRackShelfLocation(loc)) return 'rack-shelf';
  return 'site';
}
