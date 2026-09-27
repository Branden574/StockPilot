import { describe, expect, it } from 'vitest';

import { fakePostgrest, filterValue, rowsServer, uuid } from './__fixtures__/fake-postgrest';
import { IdBatchReadError } from './id-batches';
import { LOCATIONS_LIST_CEILING, readLocationList } from './locations-list';

/**
 * The Locations screen's read (src/screens/locations.tsx). It used to be one
 * `.select()` with its `{ error }` ignored: a failed read showed "No locations
 * yet." and every location past the 1000-row max_rows cap was dropped.
 */

const ORG = 'org-1';

function locations(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: uuid(i),
    name: `L-${String(i).padStart(5, '0')}`,
    type: null,
    parent_id: null,
    notes: null,
  }));
}

describe('readLocationList', () => {
  it("reads this workspace's live locations, by name with the id tiebreak", async () => {
    const client = fakePostgrest(rowsServer(() => locations(3)));
    const res = await readLocationList(client, ORG);
    expect(res).toEqual({ rows: locations(3), atCeiling: false });
    const [call] = client.calls;
    expect(call!.table).toBe('locations');
    expect(filterValue(call!, 'eq', 'organization_id')).toBe(ORG);
    expect(filterValue(call!, 'is', 'deleted_at')).toBeNull();
    expect(call!.order).toEqual([
      ['name', true],
      ['id', true],
    ]);
  });

  // Mutation caught: a single read, which returned the first 1000 locations
  // as the whole list.
  it('pages past the 1000-row cap', async () => {
    const all = locations(2345);
    const client = fakePostgrest((call) => ({
      // Like PostgREST: never more than 1000 rows for one request.
      data: all.slice(call.from, Math.min(call.to, call.from + 999) + 1),
      error: null,
      status: 200,
      statusText: 'OK',
    }));
    const res = await readLocationList(client, ORG);
    expect(res.rows).toHaveLength(2345);
    expect(res.atCeiling).toBe(false);
    expect(client.calls.map((c) => [c.from, c.to])).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  it('stops at the ceiling and says so', async () => {
    const client = fakePostgrest(rowsServer(() => locations(LOCATIONS_LIST_CEILING + 10)));
    const res = await readLocationList(client, ORG);
    expect(res.rows).toHaveLength(LOCATIONS_LIST_CEILING);
    expect(res.atCeiling).toBe(true);
  });

  // Mutation caught: `data ?? []` on an error, which showed "No locations yet."
  it('a failed page throws; it never resolves to an empty or partial list', async () => {
    const all = locations(1500);
    const client = fakePostgrest((call) =>
      call.from === 0
        ? { data: all.slice(0, 1000), error: null, status: 200, statusText: 'OK' }
        : {
            data: null,
            error: { message: 'upstream timeout' },
            status: 504,
            statusText: 'Gateway Timeout',
          },
    );
    await expect(readLocationList(client, ORG)).rejects.toBeInstanceOf(IdBatchReadError);
  });
});
