import { beforeEach, describe, expect, it, vi } from 'vitest';

import { bookCrateFingerprint, type ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { ServiceError } from '@/server/services/context';
import { makeSupabaseStub, type SupabaseStub } from '@/test/supabase-mock';

import { POST } from './route';

// ---------------------------------------------------------------------------
// POST /api/v1/items/<id>/transfer — the NATIVE put-away / move.
//
// This route used to run neither the book-crate gate nor the reconciliation,
// on the grounds that its client had no confirmation UI. The consequence was
// worse than the one it avoided: `inventory_set_rack` (migration 0068) writes
// only the RACK keys, so a book put away from the phone got NO book_crate_*
// written AT ALL — not even on a FIRST assignment, where there is provably
// nothing to confirm. Web's "until the next put-away reconciles it" was simply
// false for a mobile-first warehouse.
//
// It now gates and reconciles like web, and forwards the structured refusal so
// the sheet can answer it.
// ---------------------------------------------------------------------------

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, resetAt: 0 })),
}));
vi.mock('@/server/loaders/inventory-list', () => ({ revalidateInventoryList: vi.fn() }));
vi.mock('@/server/services/context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/services/context')>();
  // The permission gates (`assertPermission`, `assertAnyPermission`) are REAL
  // here and run against the static role, so the D1 pins below mean what they
  // say: a staff put-away really passes stock:transfer, a viewer really is
  // refused. (They used to be mocked; a mutation that re-gated the mint on
  // locations:manage slipped straight past the staff pin while they were.)
  return { ...actual, assertPlanLimit: vi.fn() };
});
vi.mock('@/server/services/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/services/audit')>();
  return { ...actual, audit: vi.fn(async () => undefined) };
});

import { InventoryService } from '@/server/services/inventory';

const ITEM = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const STAGING = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const CRATE = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const WAREHOUSE = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

/** The Green #2 crate, as `locations` really holds it. */
const GREEN_CRATE_ROW = {
  id: CRATE,
  warehouse_id: WAREHOUSE,
  kind: 'crate',
  rack_number: null,
  rack_row: null,
  crate_color: 'green',
  crate_number: '2',
  name: 'Green #2',
};

/**
 * The book's only holding, now inside Green #2 — which, like every crate in
 * production, states no rack position. `rack_number` / `rack_row` are on the
 * embed because the reconciliation derives the item's rack pair from them too;
 * null here means "this crate sits on no rack", and the pair therefore CLEARS.
 */
const GREEN_HOLDING = {
  item_id: ITEM,
  location_id: CRATE,
  quantity: 12,
  locations: {
    id: CRATE,
    kind: 'crate',
    type: 'bin',
    crate_color: 'green',
    crate_number: '2',
    rack_number: null,
    rack_row: null,
  },
};

function installSpies() {
  return {
    transferStock: vi
      .spyOn(InventoryService.prototype, 'transferStock')
      .mockResolvedValue(undefined),
    stamp: vi
      .spyOn(InventoryService.prototype, 'stampPlacementBin')
      .mockResolvedValue(undefined),
  };
}
let mockTransferStock: ReturnType<typeof installSpies>['transferStock'];
let mockStamp: ReturnType<typeof installSpies>['stamp'];

function install(opts: {
  /** Sequenced answers for `locations.select`: the SOURCE row, then the
   *  destination (or the findOrCreate candidate list). */
  locationRows?: unknown[];
  itemRows?: Array<Record<string, unknown>>;
  holdingRows?: unknown[];
  /**
   * The row `mint_placement_location` (0340) answers with when the route mints
   * a new rack/crate — the SECURITY DEFINER resolve-or-create the placement
   * path uses instead of a direct `locations` insert (owner decision D1: a
   * put-away may mint the crate it places into under stock:transfer).
   * `returns setof … rows 1`, so PostgREST hands back a one-element array.
   */
  insertedLocation?: Record<string, unknown>;
  /** What the mint RPC ERRORS with, if it should (the function's own 42501). */
  mintError?: { message: string; code?: string };
  /** The caller's role — defaults to manager; the D1 pins use staff/viewer. */
  role?: 'owner' | 'admin' | 'manager' | 'staff' | 'viewer';
}): SupabaseStub {
  const queue = [...(opts.locationRows ?? [])];
  const stub = makeSupabaseStub({
    // The route reads `locations` twice: once for the source holding's
    // warehouse/kind, once for the destination (or the dedupe candidates).
    'locations.select': () => ({
      data: (queue.length > 1 ? queue.shift() : queue[0]) as never,
      error: null,
    }),
    // Deliberately NO 'locations.insert' answer: the placement path must never
    // reach the table directly (RLS refuses staff there); a regression that
    // did would get `data: null` and fail below on the missing row.
    'rpc:mint_placement_location': opts.mintError
      ? { data: null, error: opts.mintError }
      : { data: opts.insertedLocation ? [opts.insertedLocation] : null, error: null },
    'inventory_items.select': { data: opts.itemRows ?? [], error: null },
    'item_stock_levels.select': { data: opts.holdingRows ?? [], error: null },
    'rpc:inventory_set_book_placement': { data: 1, error: null },
    'rpc:inventory_set_rack': { data: 1, error: null },
  });
  vi.mocked(withApiContext).mockResolvedValue({
    organizationId: 'org-1',
    userId: 'u-1',
    role: (opts.role ?? 'manager') as never,
    supabase: stub.client as never,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>(),
  } as never);
  return stub;
}

/** The arguments the route handed `mint_placement_location` — the ONE mint. */
function mintArgs(stub: SupabaseStub): Record<string, unknown> {
  const calls = stub.rpcCalls.filter((c) => c.name === 'mint_placement_location');
  expect(calls).toHaveLength(1);
  return calls[0]!.args as Record<string, unknown>;
}

function request(body: unknown) {
  return new Request(`https://test.local/api/v1/items/${ITEM}/transfer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

const params = Promise.resolve({ id: ITEM });

/** The staging bucket the phone puts away FROM. */
const STAGING_ROW = { warehouse_id: WAREHOUSE, kind: 'staging' };

function book(custom: Record<string, unknown>) {
  return { id: ITEM, name: 'Persepolis', item_type: 'book', custom_fields: custom };
}

beforeEach(() => {
  vi.clearAllMocks();
  ({ transferStock: mockTransferStock, stamp: mockStamp } = installSpies());
});

describe('POST /api/v1/items/[id]/transfer — the book-crate summary', () => {
  it('FIRST ASSIGNMENT: a put-away into a crate now records it, with no confirmation', async () => {
    // The headline bug. Nothing is being destroyed here — the book has no crate
    // — yet mobile wrote no book_crate_* at all, ever.
    const stub = install({
      locationRows: [STAGING_ROW, GREEN_CRATE_ROW],
      itemRows: [book({ author: 'Satrapi' })],
      holdingRows: [GREEN_HOLDING],
    });

    const res = await POST(
      request({ fromLocationId: STAGING, quantity: 12, toLocationId: CRATE }),
      { params },
    );

    expect(res.status).toBe(200);
    expect(mockTransferStock).toHaveBeenCalledOnce();
    expect(mockStamp).toHaveBeenCalledOnce();
    const call = stub.rpcCalls.find((c) => c.name === 'inventory_set_book_placement');
    expect(call, 'mobile put-away wrote no crate summary at all').toBeDefined();
    // The WHOLE summary, in one statement: Green #2 states no rack position and
    // the book's every copy is now inside it, so the rack pair is cleared rather
    // than left naming a rack the stock has left. The mobile scan sheet reads
    // these keys, and it printed "Bin/shelf: Blue Shelf" above "Rack: 38-A".
    expect(call!.args).toEqual({
      p_item_ids: [ITEM],
      p_crate_color: 'green',
      p_crate_number: '2',
      p_rack_number: null,
      p_rack_row: null,
    });
  });

  it('REFUSES an unacknowledged overwrite with the structured payload — and NO stock moves', async () => {
    install({
      locationRows: [STAGING_ROW, GREEN_CRATE_ROW],
      itemRows: [book({ book_crate_color: 'blue', book_crate_number: '4' })],
      holdingRows: [GREEN_HOLDING],
    });

    const res = await POST(
      request({ fromLocationId: STAGING, quantity: 12, toLocationId: CRATE }),
      { params },
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { details?: { reason?: string; items?: unknown[] } };
    // The `details` blob is what lets the phone ASK. Forwarding it is the whole
    // reason gating this route is safe.
    expect(body.details).toMatchObject({
      reason: 'BOOK_CRATE_CHANGE_REQUIRES_CONFIRMATION',
      items: [
        {
          itemId: ITEM,
          currentLabel: 'Blue 4',
          nextLabel: 'Green 2',
          currentFingerprint: bookCrateFingerprint('blue', '4'),
        },
      ],
    });
    expect(mockTransferStock).not.toHaveBeenCalled();
  });

  it('a SCOPED acknowledgement lets the same request through', async () => {
    const stub = install({
      locationRows: [STAGING_ROW, GREEN_CRATE_ROW],
      itemRows: [book({ book_crate_color: 'blue', book_crate_number: '4' })],
      holdingRows: [GREEN_HOLDING],
    });

    const res = await POST(
      request({
        fromLocationId: STAGING,
        quantity: 12,
        toLocationId: CRATE,
        acknowledgedCrateChanges: [
          { itemId: ITEM, currentFingerprint: bookCrateFingerprint('blue', '4') },
        ],
      }),
      { params },
    );

    expect(res.status).toBe(200);
    expect(mockTransferStock).toHaveBeenCalledOnce();
    expect(
      stub.rpcCalls.find((c) => c.name === 'inventory_set_book_placement')!.args,
    ).toMatchObject({ p_crate_color: 'green', p_crate_number: '2' });
  });

  // ═══ MAUS I, 2026-08-17 — a plain-RACK put-away for a crated book ═══
  const RACK_38B = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
  const RACK_38B_ROW = {
    id: RACK_38B,
    warehouse_id: WAREHOUSE,
    kind: 'rack',
    rack_number: '38',
    rack_row: 'B',
    crate_color: null,
    crate_number: null,
    name: '38-B',
  };
  const RACK_38B_HOLDING = {
    item_id: ITEM,
    location_id: RACK_38B,
    quantity: 10,
    locations: {
      id: RACK_38B,
      kind: 'rack',
      type: 'shelf',
      crate_color: null,
      crate_number: null,
      rack_number: '38',
      rack_row: 'B',
    },
  };
  const MAUS = { book_crate_color: 'yellow', book_crate_number: '6', book_rack_number: '38', book_rack_row: 'B' };

  it('the phone answering "Continue" on a crate CLEAR still clears — that is the operator choosing no crate', async () => {
    const stub = install({
      locationRows: [STAGING_ROW, RACK_38B_ROW],
      itemRows: [book(MAUS)],
      holdingRows: [RACK_38B_HOLDING],
    });
    const res = await POST(
      request({
        fromLocationId: STAGING,
        quantity: 10,
        toLocationId: RACK_38B,
        // The OLD-STYLE fingerprint, spelled as a literal: every shipped OTA
        // computes exactly this from the crate pair. Unchanged by this fix.
        acknowledgedCrateChanges: [{ itemId: ITEM, currentFingerprint: '["yellow","6"]' }],
      }),
      { params },
    );
    expect(res.status).toBe(200);
    expect(stub.rpcCalls.find((c) => c.name === 'inventory_set_book_placement')!.args).toEqual({
      p_item_ids: [ITEM],
      p_crate_color: null,
      p_crate_number: null,
      p_rack_number: '38',
      p_rack_row: 'B',
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('crateSyncCratePreserved');
  });

  it('a clear the gate never SHOWED keeps the crate label and reports crateSyncCratePreserved', async () => {
    // The race: at gate time a rival crate holding makes the sync look like a
    // no-op (split → nothing asked); by the sync's read the rival is gone. On
    // main this wrote NULL over yellow 6 — the Maus row in prod audit_logs.
    let reads = 0;
    const queue: unknown[] = [STAGING_ROW, RACK_38B_ROW];
    const stub = makeSupabaseStub({
      'locations.select': () => ({
        data: (queue.length > 1 ? queue.shift() : queue[0]) as never,
        error: null,
      }),
      'inventory_items.select': { data: [book(MAUS)], error: null },
      'item_stock_levels.select': () => {
        reads += 1;
        return {
          data:
            reads === 1
              ? [
                  RACK_38B_HOLDING,
                  {
                    item_id: ITEM,
                    location_id: 'rival',
                    quantity: 2,
                    locations: {
                      id: 'rival',
                      kind: 'crate',
                      type: 'bin',
                      crate_color: 'yellow',
                      crate_number: '6',
                      rack_number: null,
                      rack_row: null,
                    },
                  },
                ]
              : [RACK_38B_HOLDING],
          error: null,
        };
      },
      'rpc:inventory_set_book_placement': { data: 1, error: null },
      'rpc:inventory_set_rack': { data: 1, error: null },
    });
    vi.mocked(withApiContext).mockResolvedValue({
      organizationId: 'org-1',
      userId: 'u-1',
      role: 'manager' as const,
      supabase: stub.client as never,
      mfaRequired: false,
      mfaSatisfied: true,
      enabledModules: new Set<ModuleId>(),
    } as never);

    const res = await POST(
      request({ fromLocationId: STAGING, quantity: 10, toLocationId: RACK_38B }),
      { params },
    );
    expect(res.status).toBe(200);
    expect(stub.rpcCalls.find((c) => c.name === 'inventory_set_book_placement')!.args).toEqual({
      p_item_ids: [ITEM],
      p_crate_color: 'yellow',
      p_crate_number: '6',
      p_rack_number: '38',
      p_rack_row: 'B',
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.crateSyncCratePreserved).toBe(true);
    expect(body).not.toHaveProperty('crateSyncRackPreserved');
  });

  it('a STALE acknowledgement is refused and the refusal names the CURRENT crate', async () => {
    install({
      locationRows: [STAGING_ROW, GREEN_CRATE_ROW],
      itemRows: [book({ book_crate_color: 'red', book_crate_number: '7' })],
      holdingRows: [GREEN_HOLDING],
    });

    const res = await POST(
      request({
        fromLocationId: STAGING,
        quantity: 12,
        toLocationId: CRATE,
        acknowledgedCrateChanges: [
          { itemId: ITEM, currentFingerprint: bookCrateFingerprint('blue', '4') },
        ],
      }),
      { params },
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { details?: { items?: Array<{ currentLabel: string }> } };
    expect(body.details!.items![0]!.currentLabel).toBe('Red 7');
    expect(mockTransferStock).not.toHaveBeenCalled();
  });

  it('a NON-BOOK is never gated and never gets a crate summary', async () => {
    const stub = install({
      locationRows: [STAGING_ROW, GREEN_CRATE_ROW],
      itemRows: [{ id: ITEM, name: 'Chromebook', item_type: 'product', custom_fields: {} }],
      holdingRows: [GREEN_HOLDING],
    });

    const res = await POST(
      request({ fromLocationId: STAGING, quantity: 12, toLocationId: CRATE }),
      { params },
    );

    expect(res.status).toBe(200);
    expect(stub.rpcCalls.some((c) => c.name === 'inventory_set_book_placement')).toBe(false);
  });

  it('an internal_error NEVER leaks its details to the client (S13)', async () => {
    install({
      locationRows: [STAGING_ROW, GREEN_CRATE_ROW],
      itemRows: [book({})],
      holdingRows: [GREEN_HOLDING],
    });
    mockTransferStock.mockRejectedValueOnce(
      new ServiceError('internal_error', 'relation "x" does not exist'),
    );

    const res = await POST(
      request({ fromLocationId: STAGING, quantity: 12, toLocationId: CRATE }),
      { params },
    );

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.details).toBeUndefined();
  });
});

describe('POST /api/v1/items/[id]/transfer — a new destination may be a crate ON a rack', () => {
  it('REPRO A: rack "A1" + crate "9" creates ONE crate at that position, and says so', async () => {
    // The sheet asked "Create new rack A1?" and the server minted "Crate #9" —
    // two different strings for one action. The first fix refused the input;
    // this pins the corrected model instead: the input is CRATE 9 ON RACK A1,
    // the name states both facts, and the typed rack is kept, not dropped.
    const stub = install({
      locationRows: [STAGING_ROW, []],
      itemRows: [book({})],
      holdingRows: [GREEN_HOLDING],
      insertedLocation: {
        id: CRATE,
        kind: 'crate',
        name: 'Crate #9 on rack A1',
        rack_number: 'A1',
        rack_row: null,
        crate_color: null,
        crate_number: '9',
      },
    });

    const res = await POST(
      request({
        fromLocationId: STAGING,
        quantity: 12,
        newRack: { rackNumber: 'A1', crateNumber: '9' },
      }),
      { params },
    );

    expect(res.status).toBe(200);
    const insert = mintArgs(stub);
    expect(insert.p_kind).toBe('crate');
    expect(insert.p_name).toBe('Crate #9 on rack A1');
    expect(insert.p_crate_number).toBe('9');
    expect(insert.p_rack_number).toBe('A1');
    // No direct table insert: the mint went through the placement function.
    expect(stub.chainArgs.get('locations.insert')).toBeUndefined();
    expect(mockTransferStock).toHaveBeenCalledOnce();
  });

  it('a rack→crate move stamps the RACK too when the crate sits on one', async () => {
    // A transfer is not a put-away and normally writes no placement label. A
    // POSITIONED crate is the one exception: its crate summary and its rack
    // summary describe the same physical place, so writing one without the
    // other publishes "recorded in Blue 13, on no rack" — the owner-reported
    // half-empty row.
    const RACK_SOURCE = { warehouse_id: WAREHOUSE, kind: 'rack' };
    const POSITIONED = {
      id: CRATE,
      warehouse_id: WAREHOUSE,
      kind: 'crate',
      rack_number: '38',
      rack_row: 'B',
      crate_color: 'blue',
      crate_number: '13',
      name: 'Blue #13 on rack 38-B',
    };
    install({
      locationRows: [RACK_SOURCE, POSITIONED],
      itemRows: [book({})],
      holdingRows: [GREEN_HOLDING],
    });

    const res = await POST(
      request({ fromLocationId: STAGING, quantity: 12, toLocationId: CRATE }),
      { params },
    );

    expect(res.status).toBe(200);
    expect(mockStamp).toHaveBeenCalledWith(
      [ITEM],
      expect.objectContaining({ kind: 'crate', rackNumber: '38', rackRow: 'B' }),
    );
  });

  it('a rack→rack move still stamps NOTHING — the old asymmetry is untouched', async () => {
    const RACK_SOURCE = { warehouse_id: WAREHOUSE, kind: 'rack' };
    const RACK_DEST = {
      id: CRATE,
      warehouse_id: WAREHOUSE,
      kind: 'rack',
      rack_number: '40',
      rack_row: 'B',
      crate_color: null,
      crate_number: null,
      name: '40-B',
    };
    install({
      locationRows: [RACK_SOURCE, RACK_DEST],
      itemRows: [book({})],
      holdingRows: [GREEN_HOLDING],
    });

    const res = await POST(
      request({ fromLocationId: STAGING, quantity: 12, toLocationId: CRATE }),
      { params },
    );

    expect(res.status).toBe(200);
    expect(mockStamp).not.toHaveBeenCalled();
  });

  it('a NUMBER-ONLY crate is reachable and created as a CRATE', async () => {
    const stub = install({
      locationRows: [STAGING_ROW, []],
      itemRows: [book({})],
      holdingRows: [GREEN_HOLDING],
      insertedLocation: {
        id: CRATE,
        kind: 'crate',
        name: 'Crate #9',
        rack_number: null,
        rack_row: null,
        crate_color: null,
        crate_number: '9',
      },
    });

    const res = await POST(
      request({ fromLocationId: STAGING, quantity: 12, newRack: { crateNumber: '9' } }),
      { params },
    );

    expect(res.status).toBe(200);
    const insert = mintArgs(stub);
    expect(insert.p_kind).toBe('crate');
    expect(insert.p_type).toBe('bin');
    expect(insert.p_name).toBe('Crate #9');
    expect(insert.p_rack_number).toBeNull();
  });

  it('a plain rack still creates a RACK with a decomposed pair', async () => {
    const stub = install({
      locationRows: [STAGING_ROW, []],
      itemRows: [book({})],
      insertedLocation: {
        id: 'loc-rack',
        kind: 'rack',
        name: 'A1-Row 3',
        rack_number: 'A1',
        rack_row: 'Row 3',
        crate_color: null,
        crate_number: null,
      },
    });

    const res = await POST(
      request({
        fromLocationId: STAGING,
        quantity: 12,
        newRack: { rackNumber: 'A1', rackRow: 'Row 3' },
      }),
      { params },
    );

    expect(res.status).toBe(200);
    const insert = mintArgs(stub);
    expect(insert.p_kind).toBe('rack');
    expect(insert.p_name).toBe('A1-Row 3');
    expect(insert.p_rack_number).toBe('A1');
    expect(insert.p_rack_row).toBe('Row 3');
  });
});

// ---------------------------------------------------------------------------
// D1 (owner decision, 2026-08-17): STAFF put-away may resolve-or-create the
// labelled crate under stock:transfer.
//
// The Staff preset holds stock:transfer and NOT locations:manage. Before this,
// the mint went through LocationsService.create (asserts locations:manage), so
// staff saw "needs the Manage locations permission" on every label-only crated
// book (113 of L4L's 124) and could only place onto the bare rack — the
// crate-erasing path. Now the mint is the placement path's own
// findOrCreatePlacementDestination -> mint_placement_location (0340), gated on
// stock:transfer OR locations:manage, and the function re-checks org +
// permission inside. `assertAnyPermission` is NOT mocked in this file (only
// assertPermission is), so these run the real gate against the static role.
// ---------------------------------------------------------------------------

describe('POST /api/v1/items/[id]/transfer — D1: staff mints the labelled crate under stock:transfer', () => {
  const YELLOW_HOLDING = {
    item_id: ITEM,
    location_id: CRATE,
    quantity: 10,
    locations: {
      id: CRATE,
      kind: 'crate',
      type: 'bin',
      crate_color: 'yellow',
      crate_number: '6',
      rack_number: '38',
      rack_row: 'B',
    },
  };
  const YELLOW_LABEL = {
    book_crate_color: 'yellow',
    book_crate_number: '6',
    book_rack_number: '38',
    book_rack_row: 'B',
  };
  const YELLOW_FIELDS = { crateColor: 'yellow', crateNumber: '6', rackNumber: '38', rackRow: 'B' };

  it('a STAFF put-away into a label-only crate SUCCEEDS end to end: minted through the placement function, no gate, label kept', async () => {
    const stub = install({
      role: 'staff',
      // The book records yellow 6 on 38-B; no such row exists yet.
      locationRows: [STAGING_ROW, []],
      itemRows: [book(YELLOW_LABEL)],
      holdingRows: [YELLOW_HOLDING],
      insertedLocation: {
        id: CRATE,
        kind: 'crate',
        name: 'Yellow #6 on rack 38-B',
        rack_number: '38',
        rack_row: 'B',
        crate_color: 'yellow',
        crate_number: '6',
      },
    });

    const res = await POST(
      request({
        fromLocationId: STAGING,
        quantity: 10,
        newRack: YELLOW_FIELDS,
        acknowledgedCrateChanges: [],
        acknowledgedRackChanges: [],
      }),
      { params },
    );

    // Not a 403: staff got through.
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.toLocationId).toBe(CRATE);
    // Minted ONCE, through the function, with the label's own four fields.
    expect(mintArgs(stub)).toMatchObject({
      p_org: 'org-1',
      p_warehouse_id: WAREHOUSE,
      p_kind: 'crate',
      p_name: 'Yellow #6 on rack 38-B',
      p_crate_color: 'yellow',
      p_crate_number: '6',
      p_rack_number: '38',
      p_rack_row: 'B',
    });
    expect(stub.chainArgs.get('locations.insert')).toBeUndefined();
    // The stock moved into the minted row.
    expect(mockTransferStock).toHaveBeenCalledOnce();
    expect(mockTransferStock.mock.calls[0]![0]).toMatchObject({ toLocationId: CRATE });
    // The label was KEPT: the reconciliation derived yellow 6 / 38-B from the
    // holding, so no clear happened and nothing was preserved-under-protest.
    expect(body.crateSyncCratePreserved).toBeUndefined();
    expect(body.crateSyncRackPreserved).toBeUndefined();
    expect(body.crateSyncFailed).toBeUndefined();
  });

  it('a second STAFF put-away into the same crate REUSES the row (find, no mint)', async () => {
    const YELLOW_ROW = {
      id: CRATE,
      warehouse_id: WAREHOUSE,
      kind: 'crate',
      name: 'Yellow #6 on rack 38-B',
      rack_number: '38',
      rack_row: 'B',
      crate_color: 'yellow',
      crate_number: '6',
    };
    const stub = install({
      role: 'staff',
      // The dedupe candidate list now holds the row the first put-away minted.
      locationRows: [STAGING_ROW, [YELLOW_ROW]],
      itemRows: [book(YELLOW_LABEL)],
      holdingRows: [YELLOW_HOLDING],
    });

    const res = await POST(
      request({
        fromLocationId: STAGING,
        quantity: 4,
        newRack: YELLOW_FIELDS,
        acknowledgedCrateChanges: [],
        acknowledgedRackChanges: [],
      }),
      { params },
    );

    expect(res.status).toBe(200);
    expect(((await res.json()) as { toLocationId: string }).toLocationId).toBe(CRATE);
    // Found, not minted.
    expect(stub.rpcCalls.filter((c) => c.name === 'mint_placement_location')).toHaveLength(0);
    expect(mockTransferStock).toHaveBeenCalledOnce();
  });

  it('a VIEWER (no stock:transfer, no locations:manage) is still refused before any mint', async () => {
    const stub = install({
      role: 'viewer',
      locationRows: [STAGING_ROW, []],
      itemRows: [book({})],
      insertedLocation: { id: CRATE, kind: 'crate', name: 'Yellow #6 on rack 38-B' },
    });

    const res = await POST(
      request({ fromLocationId: STAGING, quantity: 1, newRack: YELLOW_FIELDS }),
      { params },
    );

    expect(res.status).toBe(403);
    expect(stub.rpcCalls.filter((c) => c.name === 'mint_placement_location')).toHaveLength(0);
    expect(mockTransferStock).not.toHaveBeenCalled();
  });

  it("the function's OWN gate (42501) is surfaced as forbidden, and nothing moves", async () => {
    // Belt and braces: the app-layer gate passed (staff has stock:transfer) but
    // the SECURITY DEFINER function refused (the membership it re-checks inside
    // is not accepted, or the warehouse is not this org's). The route must say
    // "permission", not "internal error", and must not transfer.
    const stub = install({
      role: 'staff',
      locationRows: [STAGING_ROW, []],
      itemRows: [book({})],
      mintError: { message: 'insufficient_privilege', code: '42501' },
    });

    const res = await POST(
      request({ fromLocationId: STAGING, quantity: 1, newRack: YELLOW_FIELDS }),
      { params },
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('forbidden');
    expect(String(body.message)).toMatch(/Transfer stock permission/);
    expect(stub.rpcCalls.filter((c) => c.name === 'mint_placement_location')).toHaveLength(1);
    expect(mockTransferStock).not.toHaveBeenCalled();
  });
});
