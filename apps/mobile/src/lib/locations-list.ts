import { idReadSelect, type IdReadClient, type PageResult } from './id-batches';
import { fetchAllRows } from './paginate';

/**
 * The Locations screen's list (src/screens/locations.tsx): every live location
 * in the workspace the member can read, by name. Each row opens the location
 * screen (app/location/[id].tsx, F1-3).
 *
 * The read used to be one `.select()` whose `{ error }` was ignored, so a
 * failed read showed "No locations yet." and a workspace past PostgREST's
 * 1000-row max_rows silently lost every location after the thousandth. It now
 * pages past that cap (fetchAllRows) up to LOCATIONS_LIST_CEILING, says when
 * the ceiling is reached, and THROWS on any failed page, so the screen shows
 * its load error instead of an empty or partial list.
 *
 * Pure and platform-free (the client is passed in), so it is unit-testable
 * under vitest.
 */

export interface LocationListRow {
  id: string;
  name: string;
  type: string | null;
  parent_id: string | null;
  notes: string | null;
}

/** Rows read at most. Far above any real workspace; reaching it is said. */
export const LOCATIONS_LIST_CEILING = 5_000;

export async function readLocationList(
  client: IdReadClient,
  orgId: string,
): Promise<{ rows: LocationListRow[]; atCeiling: boolean }> {
  const rows = await fetchAllRows<LocationListRow>(
    (from, to) =>
      idReadSelect(client, 'locations', 'id, name, type, parent_id, notes')
        .eq('organization_id', orgId)
        .is('deleted_at', null)
        .order('name', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to) as PromiseLike<PageResult<LocationListRow>>,
    { cap: LOCATIONS_LIST_CEILING },
  );
  return { rows, atCeiling: rows.length >= LOCATIONS_LIST_CEILING };
}

export const LOCATIONS_LIST_CEILING_COPY = `Showing the first ${LOCATIONS_LIST_CEILING.toLocaleString('en-US')} locations by name.`;

export const LOCATIONS_LIST_UNAVAILABLE_COPY = "Couldn't load locations.";
