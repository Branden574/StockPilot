import { PLACEMENT_KINDS, PLACEMENT_TYPES, SYSTEM_KINDS } from '@stockpilot/core';

/**
 * THE LOCATION FILTER on the phone's Items and Books lists, held to the web's
 * rule (B28, 2026-10-25).
 *
 * The rule, as the web applies it (InventoryService.list and instant mode's
 * filterInstantRows both test `primary_location_id`, and the filter offers
 * LocationsService.list({ sitesOnly }), core's isSiteLocation):
 *   - the choices are the organization's SITES (a warehouse building, a room,
 *     a vehicle, a job site), never a rack, shelf, crate, bin or area, never
 *     the Staging or Unplaced bucket;
 *   - a record matches when its primary location is one of the chosen sites.
 *
 * The phone's Books tab already matched on the primary location. Its Items tab
 * matched records HOLDING STOCK at the chosen site, which since the owner's
 * no-rack rule (#253, 2026-09-24) can only be stock left there by mistake:
 * stock nobody placed waits in Unplaced, placed stock sits on a rack, and a
 * rack is its own location with no parent site. Choosing "DC4" on the phone
 * listed a handful of leftovers while the web listed every DC4 record. And
 * both tabs offered sites by a fixed list of four types, so a site of type
 * "other" was missing and an area typed as a room was offered.
 */

/**
 * The two PostgREST `.or()` groups that keep exactly the rows core's
 * isSiteLocation calls a site. They AND together, and each keeps NULL (which
 * `not.in` drops on its own). The web's sites-only plan-limit count uses the
 * same pair (apps/web/src/server/services/context.ts).
 */
// in-list-bound: fixed kind and type constants from @stockpilot/core (five and two literals)
export const SITE_KIND_FILTER = `kind.is.null,kind.not.in.(${[...SYSTEM_KINDS, ...PLACEMENT_KINDS].join(',')})`;
// in-list-bound: fixed type constants from @stockpilot/core (two literals)
export const SITE_TYPE_FILTER = `type.is.null,type.not.in.(${PLACEMENT_TYPES.join(',')})`;

/** Narrow a `locations` read to the sites the location filter offers. */
export function onlySiteLocations<Q extends { or(filters: string): Q }>(query: Q): Q {
  return query.or(SITE_KIND_FILTER).or(SITE_TYPE_FILTER);
}
