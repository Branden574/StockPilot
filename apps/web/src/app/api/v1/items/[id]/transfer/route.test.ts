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
  return { ...actual, assertPermission: vi.fn(), assertPlanLimit: vi.fn() };
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
  insertedLocation?: Record<string, unknown>;
}): SupabaseStub {
  const queue = [...(opts.locationRows ?? [])];
  const stub = makeSupabaseStub({
    // The route reads `locations` twice: once for the source holding's
    // warehouse/kind, once for the destination (or the dedupe candidates).
    'locations.select': () => ({
      data: (queue.length > 1 ? queue.shift() : queue[0]) as never,
      error: null,
    }),
    'locations.insert': { data: opts.insertedLocation ?? null, error: null },
    'inventory_items.select': { data: opts.itemRows ?? [], error: null },
    'item_stock_levels.select': { data: opts.holdingRows ?? [], error: null },
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
  return stub;
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
    const insert = stub.chainArgs.get('locations.insert')![0]![0] as Record<string, unknown>;
    expect(insert.kind).toBe('crate');
    expect(insert.name).toBe('Crate #9 on rack A1');
    expect(insert.crate_number).toBe('9');
    expect(insert.rack_number).toBe('A1');
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
    const insert = stub.chainArgs.get('locations.insert')![0]![0] as Record<string, unknown>;
    expect(insert.kind).toBe('crate');
    expect(insert.type).toBe('bin');
    expect(insert.name).toBe('Crate #9');
    expect(insert.rack_number).toBeNull();
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
    const insert = stub.chainArgs.get('locations.insert')![0]![0] as Record<string, unknown>;
    expect(insert.kind).toBe('rack');
    expect(insert.name).toBe('A1-Row 3');
    expect(insert.rack_number).toBe('A1');
    expect(insert.rack_row).toBe('Row 3');
  });
});
