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

// Exported as plain lists so SQL-side mirrors (the sites-only plan-limit count
// in assertPlanLimit) build their filters from the same values as the
// classifiers below — one source of truth for "what is a site".
export const SYSTEM_KINDS = ['staging', 'unplaced'] as const;
// `area` is a warehouse subdivision — a placement, not a top-level site.
export const PLACEMENT_KINDS = ['rack', 'crate', 'area'] as const;
export const PLACEMENT_TYPES = ['shelf', 'bin'] as const;

const SYSTEM_KIND_SET = new Set<string>(SYSTEM_KINDS);
const PLACEMENT_KIND_SET = new Set<string>(PLACEMENT_KINDS);
const PLACEMENT_TYPE_SET = new Set<string>(PLACEMENT_TYPES);

export function isSystemLocation(loc: LocationLike): boolean {
  return SYSTEM_KIND_SET.has(loc.kind ?? '');
}

export function isRackShelfLocation(loc: LocationLike): boolean {
  if (isSystemLocation(loc)) return false;
  return PLACEMENT_KIND_SET.has(loc.kind ?? '') || PLACEMENT_TYPE_SET.has(loc.type ?? '');
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
