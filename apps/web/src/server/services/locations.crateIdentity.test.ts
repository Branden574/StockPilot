/**
 * CRATE IDENTITY at the dedupe boundary — five real bins stay five rows, and
 * every crate row already in production stays FOUND.
 *
 * `findOrCreateRackOrCrate` matches on `lower(name)` and migration 0270's
 * partial unique index keys on `(organization_id, warehouse_id, lower(name),
 * kind)`. So the NAME is the identity, and the decision this file pins is that
 * a crate's name carries the rack it SITS ON.
 *
 * WHY IT HAD TO — production, L4L North Region, books carrying BOTH summaries:
 *
 *   gray "BIN"        → 43-B, 43-C, 42-B, 42-C, 41-C   (FIVE distinct bins)
 *   yellow 5          → 40-B, 40-C
 *   blue 0            → 39-B, 38-B, 37-C
 *   blue "Blue Shelf" → NO RACK AT ALL (5 books)
 *
 * "BIN" is a generic label repeated per rack, not one crate. With a
 * position-blind name, putting away into gray BIN on 43-B and gray BIN on 41-C
 * would reuse ONE `locations` row for two physical bins — and every book in
 * either would then be stamped with the other's location. That is a worse
 * integrity failure than the half-empty row the positioned crate was added to
 * fix, so it gets its own test file rather than a line in someone else's.
 *
 * The rows below are shaped like the real ones: position-less crates named
 * "Gray #BIN" / "Blue #Shelf", because that is what every crate in the database
 * is today.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { deriveLocationName } from '@/lib/locations/rack-name';
import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('./context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./context')>();
  return { ...actual, assertPermission: vi.fn(), assertPlanLimit: vi.fn() };
});

import { LocationsService } from './locations';

const WAREHOUSE = '00000000-0000-0000-0000-000000000001';

/** A `locations` row as the DB holds it. */
function crateRow(over: Record<string, unknown>) {
  return {
    id: 'loc-existing',
    kind: 'crate',
    warehouse_id: WAREHOUSE,
    rack_number: null,
    rack_row: null,
    crate_color: null,
    crate_number: null,
    deleted_at: null,
    ...over,
  };
}

/**
 * Run the real find-or-create against a set of existing rows, driving it the
 * way every put-away surface does: the NAME comes from the shared planner, so
 * the test cannot accidentally pin a name the app would never build.
 */
async function findOrCreate(
  existing: Array<Record<string, unknown>>,
  fields: { crateColor?: string; crateNumber: string; rackNumber?: string; rackRow?: string },
) {
  const stub = makeSupabaseStub({
    'locations.select': { data: existing, error: null },
    'locations.insert': { data: { id: 'loc-new' }, error: null },
  });
  const svc = new LocationsService(makeServiceContext(stub.client));
  const name = deriveLocationName(fields);
  const row = await svc.findOrCreateRackOrCrate({
    name,
    type: 'bin',
    kind: 'crate',
    warehouseId: WAREHOUSE,
    rackNumber: fields.rackNumber ?? null,
    rackRow: fields.rackRow ?? null,
    crateColor: fields.crateColor ?? null,
    crateNumber: fields.crateNumber,
  });
  const insert = stub.chainArgs.get('locations.insert')?.[0]?.[0] as
    | Record<string, unknown>
    | undefined;
  return { name, row: row as { id: string }, insert, created: insert !== undefined };
}

beforeEach(() => vi.clearAllMocks());

describe('a crate on a rack is a DIFFERENT crate from the same number elsewhere', () => {
  it('the five real "gray BIN" bins never collapse onto one row', async () => {
    const POSITIONS = [
      ['43', 'B'],
      ['43', 'C'],
      ['42', 'B'],
      ['42', 'C'],
      ['41', 'C'],
    ] as const;

    // Each put-away sees the rows the previous ones created.
    const existing: Array<Record<string, unknown>> = [];
    const names: string[] = [];
    for (const [rackNumber, rackRow] of POSITIONS) {
      const res = await findOrCreate(existing, {
        crateColor: 'gray',
        crateNumber: 'BIN',
        rackNumber,
        rackRow,
      });
      expect(
        res.created,
        `gray BIN on ${rackNumber}-${rackRow} reused another rack's bin`,
      ).toBe(true);
      names.push(res.name);
      existing.push(crateRow({ id: `loc-${rackNumber}-${rackRow}`, name: res.name }));
    }

    expect(names).toEqual([
      'Gray #BIN on rack 43-B',
      'Gray #BIN on rack 43-C',
      'Gray #BIN on rack 42-B',
      'Gray #BIN on rack 42-C',
      'Gray #BIN on rack 41-C',
    ]);
    // The dedupe key is lower(name): five keys, so migration 0270's unique
    // index admits all five instead of rejecting four as duplicates.
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(5);
  });

  it('the SAME bin is reused on the second put-away — position included', async () => {
    const first = await findOrCreate([], {
      crateColor: 'gray',
      crateNumber: 'BIN',
      rackNumber: '43',
      rackRow: 'B',
    });
    const second = await findOrCreate([crateRow({ id: 'loc-43b', name: first.name })], {
      crateColor: 'gray',
      crateNumber: 'BIN',
      rackNumber: '43',
      rackRow: 'B',
    });
    expect(second.created).toBe(false);
    expect(second.row.id).toBe('loc-43b');
  });

  it('reuse stays CASE-INSENSITIVE, position and all (0270 keys on lower(name))', async () => {
    const res = await findOrCreate([crateRow({ id: 'loc-43b', name: 'Gray #BIN on rack 43-B' })], {
      crateColor: 'GRAY',
      crateNumber: 'bin',
      rackNumber: '43',
      rackRow: 'b',
    });
    expect(res.created).toBe(false);
    expect(res.row.id).toBe('loc-43b');
  });
});

describe('BACKWARD COMPATIBILITY — every crate already in the database', () => {
  // Shaped like the rows production actually holds: created before crates could
  // sit on racks, so position-less and named the old way.
  const LEGACY = [
    crateRow({ id: 'loc-blue-shelf', name: 'Blue #Shelf', crate_color: 'blue', crate_number: 'Shelf' }),
    crateRow({ id: 'loc-gray-bin', name: 'Gray #BIN', crate_color: 'gray', crate_number: 'BIN' }),
    crateRow({ id: 'loc-crate-42', name: 'Crate #42', crate_number: '42' }),
    crateRow({ id: 'loc-blue-0', name: 'Blue #0', crate_color: 'blue', crate_number: '0' }),
  ];

  it('a position-less put-away FINDS the legacy row and creates nothing', async () => {
    for (const [fields, id] of [
      [{ crateColor: 'blue', crateNumber: 'Shelf' }, 'loc-blue-shelf'],
      [{ crateColor: 'gray', crateNumber: 'BIN' }, 'loc-gray-bin'],
      [{ crateNumber: '42' }, 'loc-crate-42'],
      // "0" is a real crate number and truthy only as a STRING.
      [{ crateColor: 'blue', crateNumber: '0' }, 'loc-blue-0'],
    ] as const) {
      const res = await findOrCreate(LEGACY, fields);
      expect(res.created, `${JSON.stringify(fields)} minted a duplicate of ${id}`).toBe(false);
      expect(res.row.id).toBe(id);
    }
  });

  it('a legacy row is matched case-insensitively, exactly as before', async () => {
    const res = await findOrCreate(LEGACY, { crateColor: 'BLUE', crateNumber: 'shelf' });
    expect(res.created).toBe(false);
    expect(res.row.id).toBe('loc-blue-shelf');
  });

  it('a POSITION-LESS crate is stored with NULL rack columns — never backfilled', async () => {
    const res = await findOrCreate([], { crateColor: 'blue', crateNumber: 'Shelf' });
    expect(res.created).toBe(true);
    expect(res.insert!.name).toBe('Blue #Shelf');
    expect(res.insert!.rack_number).toBeNull();
    expect(res.insert!.rack_row).toBeNull();
  });

  it('a positioned crate is a NEW row beside the legacy one, not a rewrite of it', async () => {
    // The legacy "Gray #BIN" row cannot be proven to be any particular bin, so
    // the honest outcome is a new, fully-named row — never a silent adoption of
    // the old one, which would relabel whatever stock it already holds.
    const res = await findOrCreate(LEGACY, {
      crateColor: 'gray',
      crateNumber: 'BIN',
      rackNumber: '43',
      rackRow: 'B',
    });
    expect(res.created).toBe(true);
    expect(res.insert!.name).toBe('Gray #BIN on rack 43-B');
    expect(res.insert!.rack_number).toBe('43');
    expect(res.insert!.rack_row).toBe('B');
    expect(res.insert!.crate_number).toBe('BIN');
    expect(res.insert!.kind).toBe('crate');
  });

  it('the position is stored DECOMPOSED, never composite (incident 2026-07-23)', async () => {
    const res = await findOrCreate([], { crateNumber: '13', rackNumber: '38-B' });
    expect(res.insert!.rack_number).toBe('38');
    expect(res.insert!.rack_row).toBe('B');
    expect(res.insert!.name).toBe('Crate #13 on rack 38-B');
  });
});
