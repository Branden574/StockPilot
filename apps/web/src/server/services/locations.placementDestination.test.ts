/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PLACEMENT PATH MINTS UNDER stock:transfer — AND ONLY THE PLACEMENT PATH
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Owner decision D1 (2026-08-17). The book put-away's default destination is
 * the crate the book's own label names ("Yellow #6 on rack 38-B"); for 113 of
 * L4L's 124 books that crate has NO `locations` row, so placing into it means
 * minting the row first. Through `LocationsService.create` that mint asserted
 * `locations:manage`, the Staff preset holds `stock:transfer` only, and staff
 * were pushed onto the bare rack — the crate-erasing path (Maus I).
 *
 * The rule: putting stock into a crate the label (or the operator's four
 * fields) names is a STOCK operation. `findOrCreatePlacementDestination`
 * proceeds under `stock:transfer` (or `locations:manage`) and, because RLS
 * (`locations_insert`, 0212) refuses a staff insert, mints through the
 * SECURITY DEFINER `mint_placement_location` (0340) which re-checks org and
 * permission inside. `create` — and every other caller of
 * `findOrCreateRackOrCrate` — keeps `locations:manage`, byte-untouched.
 *
 * NOTHING in `./context` is mocked here: `assertPermission` and
 * `assertAnyPermission` run for real against the static role, so a staff
 * context IS a staff context and a viewer IS refused. That is what makes the
 * two-sided pin honest:
 *   • staff CAN mint via the placement path (once; a second call reuses);
 *   • staff still CANNOT create a location through `create`.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { makeServiceContext, makeSupabaseStub, type SupabaseStub } from '@/test/supabase-mock';

import { ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY } from '@stockpilot/core';

import { ServiceError } from './context';
import { TRANSFER_WAREHOUSE_WRITE_REFUSED } from './inventory';
import {
  LocationsService,
  PLACEMENT_WAREHOUSE_WRITE_REFUSED,
  type CreateLocationInput,
} from './locations';

const ORG = 'org-test';
const WAREHOUSE = '00000000-0000-0000-0000-000000000001';
const MINTED_ID = '00000000-0000-0000-0000-00000000c0de';

/** The four fields of Maus I's label, as `planNewLocation` hands them in. */
const YELLOW_6_ON_38B: CreateLocationInput = {
  name: 'Yellow #6 on rack 38-B',
  type: 'bin',
  kind: 'crate',
  warehouseId: WAREHOUSE,
  rackNumber: '38',
  rackRow: 'B',
  crateColor: 'yellow',
  crateNumber: '6',
  parentId: null,
};

const YELLOW_ROW = {
  id: MINTED_ID,
  organization_id: ORG,
  warehouse_id: WAREHOUSE,
  name: 'Yellow #6 on rack 38-B',
  type: 'bin',
  kind: 'crate',
  rack_number: '38',
  rack_row: 'B',
  crate_color: 'yellow',
  crate_number: '6',
  deleted_at: null,
};

function stubWith(opts: {
  /** The dedupe candidate list `findRackOrCrate` reads. */
  existing?: Array<Record<string, unknown>>;
  /** What the mint RPC answers (a one-element array, `returns setof … rows 1`). */
  minted?: Record<string, unknown> | null;
  mintError?: { message: string; code?: string };
  /** What a DIRECT `create` insert would answer, for the "still refused" pins. */
  inserted?: Record<string, unknown>;
  /**
   * The warehouses a STAFF caller is assigned to (B38: below manager, the mint
   * needs write access to its warehouse). Defaults to the crate's warehouse, so
   * a staff put-away works where they work; `'unreadable'` fails the read.
   */
  assigned?: string[] | 'unreadable';
}): SupabaseStub {
  const assigned = opts.assigned ?? [WAREHOUSE];
  return makeSupabaseStub({
    'locations.select': { data: opts.existing ?? [], error: null },
    'locations.insert': { data: opts.inserted ?? { id: 'loc-direct' }, error: null },
    'user_warehouse_assignments.select':
      assigned === 'unreadable'
        ? { data: null, error: { message: 'boom' } }
        : {
            data: assigned.map((w, i) => ({ warehouse_id: w, is_primary: i === 0 })),
            error: null,
          },
    'organization_members.select': { data: { all_warehouses: false }, error: null },
    'rpc:mint_placement_location': opts.mintError
      ? { data: null, error: opts.mintError }
      : { data: opts.minted === null ? null : [opts.minted ?? YELLOW_ROW], error: null },
  });
}

function svcFor(stub: SupabaseStub, role: 'owner' | 'admin' | 'manager' | 'staff' | 'viewer') {
  return new LocationsService(makeServiceContext(stub.client, { role, organizationId: ORG }));
}

function mints(stub: SupabaseStub) {
  return stub.rpcCalls.filter((c) => c.name === 'mint_placement_location');
}

async function outcome<T>(p: Promise<T>) {
  return p
    .then((data) => ({ ok: true as const, data }))
    .catch((error: unknown) => ({ ok: false as const, error }));
}

describe('findOrCreatePlacementDestination — STAFF mints the labelled crate under stock:transfer', () => {
  let stub: SupabaseStub;
  beforeEach(() => {
    stub = stubWith({});
  });

  it('a staff put-away into a label-only crate mints it ONCE, through the placement function, with the label as columns', async () => {
    const svc = svcFor(stub, 'staff');
    const row = (await svc.findOrCreatePlacementDestination(YELLOW_6_ON_38B)) as { id: string };

    expect(row.id).toBe(MINTED_ID);
    // Exactly one mint, and it is the RPC — not the table.
    expect(mints(stub)).toHaveLength(1);
    expect(stub.chainArgs.get('locations.insert')).toBeUndefined();
    // The row it asked for is the label, byte for byte, with the SAME
    // normalisation `create` applies (rack pair decomposed, colour slug).
    expect(mints(stub)[0]!.args).toEqual({
      p_org: ORG,
      p_warehouse_id: WAREHOUSE,
      p_kind: 'crate',
      p_name: 'Yellow #6 on rack 38-B',
      p_type: 'bin',
      p_parent_id: null,
      p_notes: null,
      p_rack_number: '38',
      p_rack_row: 'B',
      p_crate_color: 'yellow',
      p_crate_number: '6',
    });
  });

  it('a second staff put-away into the same crate REUSES the row: found by name, no mint', async () => {
    stub = stubWith({ existing: [YELLOW_ROW] });
    const svc = svcFor(stub, 'staff');
    const row = (await svc.findOrCreatePlacementDestination(YELLOW_6_ON_38B)) as { id: string };

    expect(row.id).toBe(MINTED_ID);
    expect(mints(stub)).toHaveLength(0);
    expect(stub.chainArgs.get('locations.insert')).toBeUndefined();
  });

  it('the reuse is case-insensitive, like 0270 (a "yellow #6 ON RACK 38-b" put-away finds the row)', async () => {
    stub = stubWith({ existing: [YELLOW_ROW] });
    const svc = svcFor(stub, 'staff');
    const row = (await svc.findOrCreatePlacementDestination({
      ...YELLOW_6_ON_38B,
      name: 'yellow #6 ON RACK 38-b',
    })) as { id: string };
    expect(row.id).toBe(MINTED_ID);
    expect(mints(stub)).toHaveLength(0);
  });

  it('a positioned crate handed an UNCOMPOSED name is minted under the composed one (the name IS the dedupe key)', async () => {
    const svc = svcFor(stub, 'staff');
    await svc.findOrCreatePlacementDestination({ ...YELLOW_6_ON_38B, name: 'Yellow #6' });
    expect(mints(stub)[0]!.args).toMatchObject({ p_name: 'Yellow #6 on rack 38-B' });
  });

  it('a "22-B" typed into the rack-number box is decomposed before it reaches the function', async () => {
    const svc = svcFor(stub, 'staff');
    await svc.findOrCreatePlacementDestination({
      name: '22-B',
      type: 'shelf',
      kind: 'rack',
      warehouseId: WAREHOUSE,
      rackNumber: '22-B',
      rackRow: null,
    });
    expect(mints(stub)[0]!.args).toMatchObject({
      p_kind: 'rack',
      p_name: '22-B',
      p_rack_number: '22',
      p_rack_row: 'B',
      p_crate_color: null,
      p_crate_number: null,
    });
  });

  it('a manager takes the SAME path (one placement path, one behaviour)', async () => {
    const svc = svcFor(stub, 'manager');
    const row = (await svc.findOrCreatePlacementDestination(YELLOW_6_ON_38B)) as { id: string };
    expect(row.id).toBe(MINTED_ID);
    expect(mints(stub)).toHaveLength(1);
    expect(stub.chainArgs.get('locations.insert')).toBeUndefined();
  });
});

describe('findOrCreatePlacementDestination — what it still refuses', () => {
  it('a VIEWER (neither stock:transfer nor locations:manage) is refused before the round trip', async () => {
    const stub = stubWith({});
    const res = await outcome(
      svcFor(stub, 'viewer').findOrCreatePlacementDestination(YELLOW_6_ON_38B),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBeInstanceOf(ServiceError);
      expect((res.error as ServiceError).code).toBe('forbidden');
    }
    expect(mints(stub)).toHaveLength(0);
    expect(stub.chainArgs.get('locations.insert')).toBeUndefined();
  });

  it("the function's own 42501 (membership / warehouse / parent re-checked inside) is forbidden, in the operator's words", async () => {
    const stub = stubWith({ mintError: { message: 'insufficient_privilege', code: '42501' } });
    const res = await outcome(
      svcFor(stub, 'staff').findOrCreatePlacementDestination(YELLOW_6_ON_38B),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect((res.error as ServiceError).code).toBe('forbidden');
      expect((res.error as ServiceError).message).toMatch(/Transfer stock permission/);
    }
  });

  it('is NOT a site back door: a non-rack/crate kind is refused with no round trip', async () => {
    const stub = stubWith({});
    const res = await outcome(
      svcFor(stub, 'staff').findOrCreatePlacementDestination({
        name: 'Back Room',
        type: 'room',
        kind: 'area',
        warehouseId: WAREHOUSE,
      }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect((res.error as ServiceError).code).toBe('validation_error');
    expect(mints(stub)).toHaveLength(0);
    expect(stub.chainArgs.get('locations.insert')).toBeUndefined();
  });

  it('a rack/crate with no warehouse is refused (the function needs the scope; so does the dedupe)', async () => {
    const stub = stubWith({});
    const res = await outcome(
      svcFor(stub, 'staff').findOrCreatePlacementDestination({
        ...YELLOW_6_ON_38B,
        warehouseId: null,
      }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect((res.error as ServiceError).code).toBe('validation_error');
    expect(mints(stub)).toHaveLength(0);
  });

  it('an empty answer from the function is an internal error, never a silent null destination', async () => {
    const stub = stubWith({ minted: null });
    const res = await outcome(
      svcFor(stub, 'staff').findOrCreatePlacementDestination(YELLOW_6_ON_38B),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect((res.error as ServiceError).code).toBe('internal_error');
  });
});

describe('the exception is SCOPED: ordinary location creation still needs locations:manage', () => {
  it('staff `create` of the very same crate is refused, and nothing is inserted or minted', async () => {
    const stub = stubWith({});
    const res = await outcome(svcFor(stub, 'staff').create(YELLOW_6_ON_38B));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect((res.error as ServiceError).code).toBe('forbidden');
      expect((res.error as ServiceError).message).toMatch(/locations:manage/);
    }
    expect(stub.chainArgs.get('locations.insert')).toBeUndefined();
    expect(mints(stub)).toHaveLength(0);
  });

  it('staff `findOrCreateRackOrCrate` (bulk Set rack, manual create) still falls through to the gated create', async () => {
    const stub = stubWith({});
    const res = await outcome(svcFor(stub, 'staff').findOrCreateRackOrCrate(YELLOW_6_ON_38B));
    expect(res.ok).toBe(false);
    if (!res.ok) expect((res.error as ServiceError).code).toBe('forbidden');
    expect(mints(stub)).toHaveLength(0);
    expect(stub.chainArgs.get('locations.insert')).toBeUndefined();
  });

  it('a manager `create` is unchanged: a direct insert, never the placement function', async () => {
    const stub = stubWith({ inserted: YELLOW_ROW });
    const res = await outcome(svcFor(stub, 'manager').create(YELLOW_6_ON_38B));
    expect(res.ok).toBe(true);
    expect(stub.chainArgs.get('locations.insert')).toBeDefined();
    expect(mints(stub)).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B38: THE MINT ASKS ABOUT THE WAREHOUSE BEFORE IT CREATES ANYTHING
//
// mint_placement_location (0340) checks that the warehouse is the org's, not
// that the caller may put stock there. Below manager, transfer_stock (0365)
// refuses a move into a warehouse the caller does not work in, but only AFTER
// the placement path has minted the destination, so the refusal left an empty
// rack or crate behind. The phone's transfer route got there with a source in
// another warehouse (stale or hand-made: it takes a new rack's warehouse from
// the source, and locations are readable org-wide), and the web with a viewer
// granted stock:transfer. Staff on the web are refused earlier, by the place
// actions' own read of the warehouse under their access. The mint now checks
// first, in the transfer's own words.
// ═══════════════════════════════════════════════════════════════════════════

describe('findOrCreatePlacementDestination: the warehouse, before the mint (B38)', () => {
  it("staff cannot mint in a warehouse they do not work in: refused in the transfer's words, nothing minted", async () => {
    const stub = stubWith({ assigned: ['00000000-0000-0000-0000-0000000000ff'] });
    const res = await outcome(
      svcFor(stub, 'staff').findOrCreatePlacementDestination(YELLOW_6_ON_38B),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect((res.error as ServiceError).code).toBe('forbidden');
      expect((res.error as ServiceError).message).toBe(PLACEMENT_WAREHOUSE_WRITE_REFUSED);
    }
    expect(mints(stub)).toHaveLength(0);
    expect(stub.chainArgs.get('locations.insert')).toBeUndefined();
  });

  it('staff whose access cannot be read are refused as retryable, and nothing is minted', async () => {
    const stub = stubWith({ assigned: 'unreadable' });
    const res = await outcome(
      svcFor(stub, 'staff').findOrCreatePlacementDestination(YELLOW_6_ON_38B),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect((res.error as ServiceError).code).toBe('conflict');
      expect((res.error as ServiceError).message).toBe(ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY);
    }
    expect(mints(stub)).toHaveLength(0);
  });

  it('a viewer granted stock:transfer still writes no warehouse: refused, nothing minted', async () => {
    const stub = stubWith({});
    const svc = new LocationsService(
      makeServiceContext(stub.client, {
        role: 'viewer',
        organizationId: ORG,
        permissions: new Set(['stock:transfer', 'items:read']),
      }),
    );
    const res = await outcome(svc.findOrCreatePlacementDestination(YELLOW_6_ON_38B));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect((res.error as ServiceError).code).toBe('forbidden');
      expect((res.error as ServiceError).message).toBe('Permission denied');
    }
    expect(mints(stub)).toHaveLength(0);
  });

  it('a manager writes every warehouse: no access read at all, and the mint runs', async () => {
    const stub = stubWith({ assigned: [] });
    const row = (await svcFor(stub, 'manager').findOrCreatePlacementDestination(
      YELLOW_6_ON_38B,
    )) as {
      id: string;
    };
    expect(row.id).toBe(MINTED_ID);
    expect(stub.fromCalls).not.toContain('user_warehouse_assignments');
    expect(mints(stub)).toHaveLength(1);
  });

  it('reusing a row that already exists mints nothing, so it asks nothing (the transfer rules on the move)', async () => {
    const stub = stubWith({ existing: [YELLOW_ROW], assigned: [] });
    const row = (await svcFor(stub, 'staff').findOrCreatePlacementDestination(YELLOW_6_ON_38B)) as {
      id: string;
    };
    expect(row.id).toBe(MINTED_ID);
    expect(stub.fromCalls).not.toContain('user_warehouse_assignments');
    expect(mints(stub)).toHaveLength(0);
  });

  it("the refusal is transferStock's own sentence, word for word (one rule, two places it is checked)", () => {
    expect(PLACEMENT_WAREHOUSE_WRITE_REFUSED).toBe(TRANSFER_WAREHOUSE_WRITE_REFUSED);
  });
});
