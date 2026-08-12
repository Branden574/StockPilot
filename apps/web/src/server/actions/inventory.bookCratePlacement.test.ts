import { beforeEach, describe, expect, it, vi } from 'vitest';

import { bookCrateFingerprint } from '@stockpilot/core';

import { makeSupabaseStub, type SupabaseStub } from '@/test/supabase-mock';

// ---------------------------------------------------------------------------
// placeStockAction / bulkPlaceStockAction — the BOOK CRATE half.
//
// Unlike the sibling suites, this one runs the REAL InventoryService gate and
// reconciliation against a stubbed Supabase client, because the properties
// under test are precisely the DB reads: the destination's crate is read from
// the `locations` row, the item's current crate is read from `inventory_items`,
// and neither is taken from anything the client sent.
//
// Only transferStock is stubbed out (it is a pure RPC wrapper covered
// elsewhere), so "did stock move?" is answerable without a database.
// ---------------------------------------------------------------------------

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: vi.fn((fn: unknown) => fn),
}));

const { ctxRef } = vi.hoisted(() => ({ ctxRef: { ctx: null as unknown } }));

vi.mock('@/server/services/context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/services/context')>();
  return {
    ...actual,
    withContext: vi.fn(async () => ctxRef.ctx),
    assertPermission: vi.fn(),
    assertPlanLimit: vi.fn(),
  };
});

// audit() writes through the admin client — silence it.
vi.mock('@/server/services/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/services/audit')>();
  return { ...actual, audit: vi.fn(async () => undefined) };
});

import { InventoryService } from '@/server/services/inventory';

import { bulkPlaceStockAction, placeStockAction, transferStockAction } from './inventory';

// Prototype spies rather than a module mock: the REAL InventoryService runs,
// with only the physical move and the rack-label stamp replaced. The crate gate
// and the reconciliation — the code under test — stay real.
//
// Re-installed per test, because the shared setup file calls
// vi.restoreAllMocks() in a global afterEach; a spy created once at module
// scope would be un-spied after the first test and silently call through the
// real implementation while recording nothing.
function installSpies() {
  return {
    transferStock: vi
      .spyOn(InventoryService.prototype, 'transferStock')
      .mockResolvedValue(undefined),
    stampPlacementBin: vi
      .spyOn(InventoryService.prototype, 'stampPlacementBin')
      .mockResolvedValue(undefined),
  };
}
let mockTransferStock: ReturnType<typeof installSpies>['transferStock'];
let mockStampPlacementBin: ReturnType<typeof installSpies>['stampPlacementBin'];

const BOOK_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BOOK_B_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaab';
const FROM_LOC = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const GREEN_CRATE = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const ORG_ID = 'org-test';

/** The Green #2 crate as it really sits in `locations`. */
const GREEN_CRATE_ROW = {
  id: GREEN_CRATE,
  warehouse_id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
  kind: 'crate',
  rack_number: null,
  rack_row: null,
  crate_color: 'green',
  crate_number: '2',
  name: 'Green #2',
};

function installContext(opts: {
  locationRow?: Record<string, unknown> | null | Array<Record<string, unknown>>;
  itemRows?: Array<Record<string, unknown>>;
  holdingRows?: Array<Record<string, unknown>>;
  setBookStorage?: { data: unknown; error: { message: string } | null };
  /** What LocationsService.create returns for an inline "+ New" destination. */
  insertedLocation?: Record<string, unknown>;
} = {}): SupabaseStub {
  const stub = makeSupabaseStub({
    'locations.select': {
      data: 'locationRow' in opts ? opts.locationRow : GREEN_CRATE_ROW,
      error: null,
    },
    'locations.insert': { data: opts.insertedLocation ?? null, error: null },
    'warehouses.select': { data: { id: GREEN_CRATE_ROW.warehouse_id }, error: null },
    'inventory_items.select': { data: opts.itemRows ?? [], error: null },
    'item_stock_levels.select': { data: opts.holdingRows ?? [], error: null },
    'rpc:inventory_set_book_storage': opts.setBookStorage ?? { data: 1, error: null },
  });
  ctxRef.ctx = {
    organizationId: ORG_ID,
    userId: 'user-test',
    role: 'admin',
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set(),
    supabase: stub.client,
  };
  return stub;
}

/** A book recorded as sitting in Blue 4. */
function blueFourBook(id = BOOK_ID, name = 'Persepolis') {
  return {
    id,
    name,
    item_type: 'book',
    custom_fields: { book_crate_color: 'blue', book_crate_number: '4', author: 'Satrapi' },
  };
}

/** That book's only positive holding, now inside the Green #2 crate. */
function greenCrateHolding(id = BOOK_ID) {
  return {
    item_id: id,
    location_id: GREEN_CRATE,
    quantity: 12,
    locations: {
      id: GREEN_CRATE,
      kind: 'crate',
      type: 'bin',
      crate_color: 'green',
      crate_number: '2',
    },
  };
}

/** The scoped acknowledgement a client that displayed "Blue 4" would send. */
const ACK_BLUE_4 = [{ itemId: BOOK_ID, currentFingerprint: bookCrateFingerprint('blue', '4') }];

function placeInGreenCrate(over: Record<string, unknown> = {}) {
  return placeStockAction({
    itemId: BOOK_ID,
    fromLocationId: FROM_LOC,
    quantity: 12,
    destination: { existingLocationId: GREEN_CRATE },
    ...over,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  ({ transferStock: mockTransferStock, stampPlacementBin: mockStampPlacementBin } =
    installSpies());
});

// ═══════════════════════════════════════════════════════════════════════════
// The destination's crate comes from the DATABASE
// ═══════════════════════════════════════════════════════════════════════════

describe('placeStockAction — destination crate metadata', () => {
  it('reads an EXISTING destination\'s crate from `locations`, not from the client', async () => {
    const stub = installContext({
      itemRows: [blueFourBook()],
      holdingRows: [greenCrateHolding()],
    });

    // The request body carries ONLY a location id. There is nowhere for a
    // caller to assert what that crate is — the columns are read server-side.
    const res = await placeInGreenCrate({ acknowledgedCrateChanges: ACK_BLUE_4 });
    expect(res.ok).toBe(true);

    const locationSelect = stub.chainArgs.get('locations.select')![0]![0] as string;
    expect(locationSelect).toContain('crate_color');
    expect(locationSelect).toContain('crate_number');

    // ...and the crate that reaches the label stamp is the DB's.
    expect(mockStampPlacementBin).toHaveBeenCalledWith([BOOK_ID], {
      kind: 'crate',
      rackNumber: null,
      rackRow: null,
      name: 'Green #2',
      crateColor: 'green',
      crateNumber: '2',
    });
  });

  it('synchronizes the item summary to the DESTINATION crate after the move', async () => {
    const stub = installContext({
      itemRows: [blueFourBook()],
      holdingRows: [greenCrateHolding()],
    });

    await placeInGreenCrate({ acknowledgedCrateChanges: ACK_BLUE_4 });

    const call = stub.rpcCalls.find((c) => c.name === 'inventory_set_book_storage')!;
    expect(call.args).toEqual({
      p_item_ids: [BOOK_ID],
      p_crate_color: 'green',
      p_crate_number: '2',
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The confirmation gate
// ═══════════════════════════════════════════════════════════════════════════

describe('placeStockAction — the crate confirmation gate', () => {
  it('ack=false + a conflicting change → structured error and NO stock moves', async () => {
    installContext({ itemRows: [blueFourBook()], holdingRows: [greenCrateHolding()] });

    const res = await placeInGreenCrate();

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('conflict');
      expect(res.error.details).toEqual({
        reason: 'BOOK_CRATE_CHANGE_REQUIRES_CONFIRMATION',
        items: [
          {
            itemId: BOOK_ID,
            itemName: 'Persepolis',
            currentLabel: 'Blue 4',
            nextLabel: 'Green 2',
            currentFingerprint: bookCrateFingerprint('blue', '4'),
          },
        ],
      });
    }
    // THE POINT: refused BEFORE anything physical happened.
    expect(mockTransferStock).not.toHaveBeenCalled();
    expect(mockStampPlacementBin).not.toHaveBeenCalled();
  });

  it('ack=true → the same request proceeds and the stock moves', async () => {
    installContext({ itemRows: [blueFourBook()], holdingRows: [greenCrateHolding()] });

    const res = await placeInGreenCrate({ acknowledgedCrateChanges: ACK_BLUE_4 });

    expect(res.ok).toBe(true);
    expect(mockTransferStock).toHaveBeenCalledOnce();
    expect(mockTransferStock).toHaveBeenCalledWith({
      itemId: BOOK_ID,
      fromLocationId: FROM_LOC,
      toLocationId: GREEN_CRATE,
      quantity: 12,
      notes: undefined,
    });
  });

  it('the client LYING about the current crate changes nothing — the DB is compared', async () => {
    // DB says GREEN 2, and the destination IS Green 2 → no conflict. The extra
    // "currentCrateColor/Number" fields are not part of the contract at all;
    // they are ignored, and the placement succeeds without acknowledgement.
    installContext({
      itemRows: [
        {
          id: BOOK_ID,
          name: 'Persepolis',
          item_type: 'book',
          custom_fields: { book_crate_color: 'green', book_crate_number: '2' },
        },
      ],
      holdingRows: [greenCrateHolding()],
    });

    const res = await placeStockAction({
      itemId: BOOK_ID,
      fromLocationId: FROM_LOC,
      quantity: 12,
      destination: { existingLocationId: GREEN_CRATE },
      // A forged claim that the book is in Blue 4.
      currentCrateColor: 'blue',
      currentCrateNumber: '4',
    } as unknown as Parameters<typeof placeStockAction>[0]);

    expect(res.ok).toBe(true);
    expect(mockTransferStock).toHaveBeenCalledOnce();
  });

  it('the reverse lie is equally powerless — DB Blue 4 still refuses', async () => {
    installContext({ itemRows: [blueFourBook()], holdingRows: [greenCrateHolding()] });

    const res = await placeStockAction({
      itemId: BOOK_ID,
      fromLocationId: FROM_LOC,
      quantity: 12,
      destination: { existingLocationId: GREEN_CRATE },
      // "It's already Green 2, nothing to confirm" — the server disagrees.
      currentCrateColor: 'green',
      currentCrateNumber: '2',
    } as unknown as Parameters<typeof placeStockAction>[0]);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.details).toMatchObject({ items: [{ currentLabel: 'Blue 4' }] });
    expect(mockTransferStock).not.toHaveBeenCalled();
  });

  it('a book with NO crate recorded places with no acknowledgement at all', async () => {
    installContext({
      itemRows: [{ id: BOOK_ID, name: 'Persepolis', item_type: 'book', custom_fields: {} }],
      holdingRows: [greenCrateHolding()],
    });

    const res = await placeInGreenCrate();

    expect(res.ok).toBe(true);
    expect(mockTransferStock).toHaveBeenCalledOnce();
  });

  it('a NON-BOOK is never gated, whatever the destination', async () => {
    installContext({
      itemRows: [
        { id: BOOK_ID, name: 'Chromebook', item_type: 'product', custom_fields: { rack_number: '9' } },
      ],
      holdingRows: [greenCrateHolding()],
    });

    const res = await placeInGreenCrate();
    expect(res.ok).toBe(true);
    expect(mockTransferStock).toHaveBeenCalledOnce();
  });

  it('a STALE acknowledgement is REFUSED and the current crate survives', async () => {
    // The end-to-end shape of the data-loss bug: staging rendered "Blue 4",
    // someone re-crated the book to Red 7, and the client's first and only
    // request already carried the acknowledgement it computed from that
    // snapshot. Nothing may move, and Red 7 must still be on the item.
    installContext({
      itemRows: [
        {
          id: BOOK_ID,
          name: 'Persepolis',
          item_type: 'book',
          custom_fields: { book_crate_color: 'red', book_crate_number: '7' },
        },
      ],
      holdingRows: [greenCrateHolding()],
    });

    const res = await placeInGreenCrate({ acknowledgedCrateChanges: ACK_BLUE_4 });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('conflict');
      // Re-asked against the row the server just read, not the client's idea.
      expect(res.error.details).toMatchObject({
        items: [
          {
            currentLabel: 'Red 7',
            currentFingerprint: bookCrateFingerprint('red', '7'),
          },
        ],
      });
    }
    // NOTHING moved and NOTHING was rewritten — Red 7 is intact.
    expect(mockTransferStock).not.toHaveBeenCalled();
    expect(mockStampPlacementBin).not.toHaveBeenCalled();
  });

  it('…and proceeds once THAT crate is acknowledged', async () => {
    const stub = installContext({
      itemRows: [
        {
          id: BOOK_ID,
          name: 'Persepolis',
          item_type: 'book',
          custom_fields: { book_crate_color: 'red', book_crate_number: '7' },
        },
      ],
      holdingRows: [greenCrateHolding()],
    });

    const res = await placeInGreenCrate({
      acknowledgedCrateChanges: [
        { itemId: BOOK_ID, currentFingerprint: bookCrateFingerprint('red', '7') },
      ],
    });

    expect(res.ok).toBe(true);
    expect(mockTransferStock).toHaveBeenCalledOnce();
    const call = stub.rpcCalls.find((c) => c.name === 'inventory_set_book_storage')!;
    expect(call.args).toMatchObject({ p_crate_color: 'green', p_crate_number: '2' });
  });

  it('does NOT ask at all when the book stays SPLIT — nothing will be rewritten', async () => {
    // The reviewer's secondary finding. This book also holds stock in another
    // crate, so syncBookCratePlacement will deliberately leave its summary
    // alone. Demanding acknowledgement for a change that cannot happen trains
    // operators to click through the prompt that matters.
    const stub = installContext({
      itemRows: [blueFourBook()],
      holdingRows: [
        greenCrateHolding(),
        {
          item_id: BOOK_ID,
          location_id: 'other-crate',
          quantity: 3,
          locations: {
            id: 'other-crate',
            kind: 'crate',
            type: 'bin',
            crate_color: 'blue',
            crate_number: '4',
          },
        },
      ],
    });

    // NO acknowledgement of any kind.
    const res = await placeInGreenCrate();

    expect(res.ok).toBe(true);
    expect(mockTransferStock).toHaveBeenCalledOnce();
    // ...and the summary really was left alone, exactly as promised.
    expect(stub.rpcCalls.some((c) => c.name === 'inventory_set_book_storage')).toBe(false);
    if (res.ok) expect(res.data.crateSyncSkipped).toBe(true);
  });

  it('OLDER CALLERS keep working: omitting the acknowledgement is a valid request', async () => {
    installContext({
      itemRows: [{ id: BOOK_ID, name: 'Persepolis', item_type: 'book', custom_fields: {} }],
      holdingRows: [greenCrateHolding()],
    });
    // No acknowledgedCrateChanges key at all — parses, and places.
    const res = await placeStockAction({
      itemId: BOOK_ID,
      fromLocationId: FROM_LOC,
      quantity: 12,
      destination: { existingLocationId: GREEN_CRATE },
    });
    expect(res.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Reconciliation seen from the action
// ═══════════════════════════════════════════════════════════════════════════

describe('placeStockAction — summary reconciliation', () => {
  it('SPLIT holdings → the summary is left alone (holdings stay authoritative)', async () => {
    const stub = installContext({
      itemRows: [blueFourBook()],
      holdingRows: [
        greenCrateHolding(),
        {
          item_id: BOOK_ID,
          location_id: 'other-crate',
          quantity: 3,
          locations: {
            id: 'other-crate',
            kind: 'crate',
            type: 'bin',
            crate_color: 'blue',
            crate_number: '4',
          },
        },
      ],
    });

    const res = await placeInGreenCrate({ acknowledgedCrateChanges: ACK_BLUE_4 });

    expect(res.ok).toBe(true);
    expect(mockTransferStock).toHaveBeenCalledOnce();
    expect(stub.rpcCalls.some((c) => c.name === 'inventory_set_book_storage')).toBe(false);
    // ...and the client is TOLD, so a placement that deliberately changed no
    // label cannot be mistaken for one that did.
    if (res.ok) expect(res.data.crateSyncSkipped).toBe(true);
  });

  it('a single-location placement does NOT report a skip', async () => {
    installContext({ itemRows: [blueFourBook()], holdingRows: [greenCrateHolding()] });
    const res = await placeInGreenCrate({ acknowledgedCrateChanges: ACK_BLUE_4 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.crateSyncSkipped).toBeUndefined();
  });

  it('a failed summary write is SURFACED, and the placement still stands', async () => {
    installContext({
      itemRows: [blueFourBook()],
      holdingRows: [greenCrateHolding()],
      setBookStorage: { data: null, error: { message: 'boom' } },
    });

    const res = await placeInGreenCrate({ acknowledgedCrateChanges: ACK_BLUE_4 });

    // The stock really moved — never hand-roll a rollback of a real movement.
    expect(mockTransferStock).toHaveBeenCalledOnce();
    // ...but the caller is told the label may be stale.
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.crateSyncFailed).toBe(true);
  });

  it('a clean placement does NOT set crateSyncFailed', async () => {
    installContext({ itemRows: [blueFourBook()], holdingRows: [greenCrateHolding()] });
    const res = await placeInGreenCrate({ acknowledgedCrateChanges: ACK_BLUE_4 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.crateSyncFailed).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Bulk
// ═══════════════════════════════════════════════════════════════════════════

describe('bulkPlaceStockAction — the crate gate applies to the whole batch', () => {
  const TWO = [
    { itemId: BOOK_ID, fromLocationId: FROM_LOC, quantity: 12 },
    { itemId: BOOK_B_ID, fromLocationId: FROM_LOC, quantity: 4 },
  ];

  it('ONE conflicting book refuses the ENTIRE batch — nothing moves', async () => {
    installContext({
      itemRows: [
        blueFourBook(),
        // Already in Green 2 — this one alone would be fine.
        {
          id: BOOK_B_ID,
          name: 'Maus I',
          item_type: 'book',
          custom_fields: { book_crate_color: 'green', book_crate_number: '2' },
        },
      ],
    });

    const res = await bulkPlaceStockAction({
      placements: TWO,
      destination: { existingLocationId: GREEN_CRATE },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('conflict');
      expect(res.error.details).toMatchObject({
        reason: 'BOOK_CRATE_CHANGE_REQUIRES_CONFIRMATION',
        // Only the genuinely conflicting book is named.
        items: [{ itemId: BOOK_ID, itemName: 'Persepolis' }],
      });
    }
    // All-or-nothing: a half-placed batch the user then confirms would
    // double-move the ones that already went.
    expect(mockTransferStock).not.toHaveBeenCalled();
  });

  it('ack=true places every item and syncs them in ONE call', async () => {
    const stub = installContext({
      itemRows: [blueFourBook(), { id: BOOK_B_ID, name: 'Maus I', item_type: 'book', custom_fields: {} }],
      holdingRows: [greenCrateHolding(BOOK_ID), greenCrateHolding(BOOK_B_ID)],
      setBookStorage: { data: 2, error: null },
    });

    const res = await bulkPlaceStockAction({
      placements: TWO,
      destination: { existingLocationId: GREEN_CRATE },
      acknowledgedCrateChanges: ACK_BLUE_4,
    });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.placed).toBe(2);
    expect(mockTransferStock).toHaveBeenCalledTimes(2);

    const calls = stub.rpcCalls.filter((c) => c.name === 'inventory_set_book_storage');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual({
      p_item_ids: [BOOK_ID, BOOK_B_ID],
      p_crate_color: 'green',
      p_crate_number: '2',
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE TRANSFER MODAL — it used to move crated stock and never touch the summary
//
// transferStockAction called transferStock and stopped. A book recorded
// "Blue 4" with all 40 units in crate Blue 4, transferred onto a rack, went on
// reading "Blue 4" in the Books list, on printed labels, in the CSV and in
// Export Builder — and a picker walked to an empty crate. Its "+ New location"
// branch could even MINT a crate and move every unit into it while the summary
// still named the old one.
//
// It now runs the SAME gate and the SAME reconciliation as the put-away, and
// the dialog grew the confirmation step to answer the gate with.
// ═══════════════════════════════════════════════════════════════════════════

const RACK_ROW_28A = {
  id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
  warehouse_id: GREEN_CRATE_ROW.warehouse_id,
  kind: 'rack',
  rack_number: '28',
  rack_row: 'A',
  crate_color: null,
  crate_number: null,
  name: '28-A',
};

/** The book's only holding, now on rack 28-A. */
function rackHolding(id = BOOK_ID) {
  return {
    item_id: id,
    location_id: RACK_ROW_28A.id,
    quantity: 40,
    locations: {
      id: RACK_ROW_28A.id,
      kind: 'rack',
      type: 'shelf',
      crate_color: null,
      crate_number: null,
    },
  };
}

function transferToRack(over: Record<string, unknown> = {}) {
  return transferStockAction({
    itemId: BOOK_ID,
    fromLocationId: FROM_LOC,
    quantity: 40,
    destination: { existingLocationId: RACK_ROW_28A.id },
    ...over,
  } as Parameters<typeof transferStockAction>[0]);
}

describe('transferStockAction — the crate summary follows the stock', () => {
  it('REFUSES an unacknowledged overwrite, and NO stock moves', async () => {
    installContext({
      locationRow: RACK_ROW_28A,
      itemRows: [blueFourBook()],
      holdingRows: [rackHolding()],
    });

    const res = await transferToRack();

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('conflict');
      expect(res.error.details).toMatchObject({
        reason: 'BOOK_CRATE_CHANGE_REQUIRES_CONFIRMATION',
        items: [{ itemId: BOOK_ID, currentLabel: 'Blue 4', nextLabel: null }],
      });
    }
    expect(mockTransferStock).not.toHaveBeenCalled();
  });

  it('once acknowledged, the move happens AND the crate summary is CLEARED', async () => {
    // The whole defect in one assertion: 40 units leave crate Blue 4 for rack
    // 28-A, so "Blue 4" must stop being what the item says.
    const stub = installContext({
      locationRow: RACK_ROW_28A,
      itemRows: [blueFourBook()],
      holdingRows: [rackHolding()],
    });

    const res = await transferToRack({ acknowledgedCrateChanges: ACK_BLUE_4 });

    expect(res.ok).toBe(true);
    expect(mockTransferStock).toHaveBeenCalledOnce();
    const call = stub.rpcCalls.find((c) => c.name === 'inventory_set_book_storage')!;
    expect(call.args).toEqual({
      p_item_ids: [BOOK_ID],
      p_crate_color: null,
      p_crate_number: null,
    });
  });

  it('a transfer INTO a crate records that crate on the book', async () => {
    const stub = installContext({
      itemRows: [blueFourBook()],
      holdingRows: [greenCrateHolding()],
    });

    const res = await transferStockAction({
      itemId: BOOK_ID,
      fromLocationId: FROM_LOC,
      quantity: 12,
      destination: { existingLocationId: GREEN_CRATE },
      acknowledgedCrateChanges: ACK_BLUE_4,
    } as Parameters<typeof transferStockAction>[0]);

    expect(res.ok).toBe(true);
    expect(stub.rpcCalls.find((c) => c.name === 'inventory_set_book_storage')!.args).toEqual({
      p_item_ids: [BOOK_ID],
      p_crate_color: 'green',
      p_crate_number: '2',
    });
  });

  it('a NON-BOOK transfer writes no crate summary and is not gated', async () => {
    const stub = installContext({
      locationRow: RACK_ROW_28A,
      itemRows: [{ id: BOOK_ID, name: 'Chromebook', item_type: 'product', custom_fields: {} }],
      holdingRows: [rackHolding()],
    });

    const res = await transferToRack();
    expect(res.ok).toBe(true);
    expect(mockTransferStock).toHaveBeenCalledOnce();
    expect(stub.rpcCalls.some((c) => c.name === 'inventory_set_book_storage')).toBe(false);
  });

  it('reports crateSyncStale when the crate is edited while the stock moves', async () => {
    // The gate reads Blue 4 and is acknowledged; the reconciliation's own read
    // comes back Red 7. The move stands, the label does not get overwritten,
    // and the caller is told rather than shown a plain success.
    const stub = installContext({
      locationRow: RACK_ROW_28A,
      holdingRows: [rackHolding()],
    });
    let read = 0;
    stub.client.from = ((table: string) => {
      // Every `inventory_items` select after the FIRST (the gate's) sees the
      // row someone else has since edited.
      const rows =
        table === 'inventory_items'
          ? read++ === 0
            ? [blueFourBook()]
            : [
                {
                  id: BOOK_ID,
                  name: 'Persepolis',
                  item_type: 'book',
                  custom_fields: { book_crate_color: 'red', book_crate_number: '7' },
                },
              ]
          : null;
      const inner = makeSupabaseStub({
        'inventory_items.select': { data: rows, error: null },
        'locations.select': { data: RACK_ROW_28A, error: null },
        'item_stock_levels.select': { data: [rackHolding()], error: null },
      });
      return inner.client.from(table);
    }) as typeof stub.client.from;

    const res = await transferToRack({ acknowledgedCrateChanges: ACK_BLUE_4 });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.crateSyncStale).toBe(true);
    expect(mockTransferStock).toHaveBeenCalledOnce();
    expect(stub.rpcCalls.some((c) => c.name === 'inventory_set_book_storage')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// RACK **XOR** CRATE — the regression, refused at the schema
// ═══════════════════════════════════════════════════════════════════════════

describe('a new destination is a rack OR a crate, never both', () => {
  const WAREHOUSE = GREEN_CRATE_ROW.warehouse_id;

  it('REPRO B: rack "A1" + row "Row 3" + crate "9" is a validation error, and nothing moves', async () => {
    // On this branch that input silently produced name "Crate #9", kind
    // 'crate', and dropped the row — where before it created rack "A1-Row 3".
    // On a surface with no confirmation at all.
    installContext({ itemRows: [blueFourBook()] });

    const res = await transferStockAction({
      itemId: BOOK_ID,
      fromLocationId: FROM_LOC,
      quantity: 40,
      destination: {
        newRack: { warehouseId: WAREHOUSE, rackNumber: 'A1', rackRow: 'Row 3', crateNumber: '9' },
      },
    } as Parameters<typeof transferStockAction>[0]);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('validation_error');
      expect(res.error.message).toMatch(/either a rack or a crate/i);
    }
    expect(mockTransferStock).not.toHaveBeenCalled();
  });

  it('the SAME refusal on the put-away action — one rule, every surface', async () => {
    installContext({ itemRows: [blueFourBook()] });

    const res = await placeStockAction({
      itemId: BOOK_ID,
      fromLocationId: FROM_LOC,
      quantity: 12,
      destination: {
        newRack: { warehouseId: WAREHOUSE, rackNumber: 'A1', crateColor: 'blue' },
      },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('validation_error');
    expect(mockTransferStock).not.toHaveBeenCalled();
  });

  it('a NUMBER-ONLY crate is accepted and created as a CRATE', async () => {
    const stub = installContext({
      // No existing rack/crate in this warehouse — findOrCreateRackOrCrate
      // falls through to create().
      locationRow: [],
      itemRows: [blueFourBook()],
      holdingRows: [greenCrateHolding()],
      insertedLocation: {
        id: GREEN_CRATE,
        kind: 'crate',
        name: 'Crate #9',
        rack_number: null,
        rack_row: null,
        crate_color: null,
        crate_number: '9',
      },
    });

    const res = await placeStockAction({
      itemId: BOOK_ID,
      fromLocationId: FROM_LOC,
      quantity: 12,
      destination: { newRack: { warehouseId: WAREHOUSE, crateNumber: '9' } },
      acknowledgedCrateChanges: ACK_BLUE_4,
    });

    expect(res.ok).toBe(true);
    const insert = stub.chainArgs.get('locations.insert')![0]![0] as Record<string, unknown>;
    expect(insert.kind).toBe('crate');
    expect(insert.type).toBe('bin');
    expect(insert.name).toBe('Crate #9');
    expect(insert.crate_number).toBe('9');
    // The rack columns stay empty — a crate is not half a rack.
    expect(insert.rack_number).toBeNull();
    expect(insert.rack_row).toBeNull();
  });

  it('a plain rack still creates a RACK, row and all', async () => {
    const stub = installContext({
      locationRow: [],
      itemRows: [{ id: BOOK_ID, name: 'Chromebook', item_type: 'product', custom_fields: {} }],
      holdingRows: [],
      insertedLocation: {
        id: RACK_ROW_28A.id,
        kind: 'rack',
        name: 'A1-Row 3',
        rack_number: 'A1',
        rack_row: 'Row 3',
        crate_color: null,
        crate_number: null,
      },
    });

    const res = await placeStockAction({
      itemId: BOOK_ID,
      fromLocationId: FROM_LOC,
      quantity: 12,
      destination: { newRack: { warehouseId: WAREHOUSE, rackNumber: 'A1', rackRow: 'Row 3' } },
    });

    expect(res.ok).toBe(true);
    const insert = stub.chainArgs.get('locations.insert')![0]![0] as Record<string, unknown>;
    expect(insert.kind).toBe('rack');
    expect(insert.name).toBe('A1-Row 3');
    expect(insert.rack_number).toBe('A1');
    expect(insert.rack_row).toBe('Row 3');
    expect(insert.crate_color).toBeNull();
    expect(insert.crate_number).toBeNull();
  });
});
