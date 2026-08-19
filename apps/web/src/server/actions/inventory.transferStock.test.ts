import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, type SupabaseStub } from '@/test/supabase-mock';

// unstable_cache/revalidateTag: the actions under test import the
// inventory-list loader (cache invalidation helper), whose module graph
// builds unstable_cache wrappers at import time.
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: vi.fn((fn: unknown) => fn),
}));

// ---------------------------------------------------------------------------
// Hoisted mocks — same harness as inventory.placeStock.test.ts.
//
// transferStockAction resolves `withContext()` once, then constructs
// `new InventoryService(ctx)` / `new LocationsService(ctx)` and uses
// `ctx.supabase` directly for the newRack warehouse org-verification. So we
// mock:
//  - withContext() → a ServiceContext-shaped object whose supabase is a
//    configurable stub (controls the warehouses verification row).
//  - the InventoryService / LocationsService classes → spy constructors whose
//    instances expose transferStock / findOrCreatePlacementDestination spies — the
//    dedup-safe rack lookup (Unit A) the action actually calls for the
//    newRack destination, NOT a raw `create`. (transferStockAction never
//    calls stampPlacementBin — that's placeStock/bulkPlaceStock only.)
// ---------------------------------------------------------------------------

const {
  mockTransferStock,
  mockFindOrCreateRackOrCrate,
  mockFindRackOrCrate,
  mockAssertBookCrate,
  mockSyncBookCrate,
  ctxRef,
} = vi.hoisted(() => ({
  mockTransferStock: vi.fn(async () => undefined),
  mockFindOrCreateRackOrCrate: vi.fn(async () => ({ id: 'new-loc-99' })),
  mockFindRackOrCrate: vi.fn(async () => null as { id: string } | null),
  // The Transfer path now runs the SAME book-crate gate + reconciliation the
  // Staging put-away runs — see transferStockAction. Its own behaviour is
  // covered in inventory.bookCratePlacement.test.ts; here they only need to
  // exist so the destination-union assertions below still speak.
  mockAssertBookCrate: vi.fn(async () => new Map()),
  mockSyncBookCrate: vi.fn(async () => ({
    syncedItemIds: [] as string[],
    failedItemIds: [] as string[],
    skippedItemIds: [] as string[],
    staleItemIds: [] as string[],
    unplacedItemIds: [] as string[],
    rackPreservedItemIds: [] as string[],
    cratePreservedItemIds: [] as string[],
  })),
  ctxRef: { ctx: null as unknown },
}));

vi.mock('@/server/services/context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/services/context')>();
  return {
    ...actual,
    withContext: vi.fn(async () => ctxRef.ctx),
  };
});

vi.mock('@/server/services/inventory', () => ({
  InventoryService: class {
    transferStock = mockTransferStock;
    assertBookCratePlacementAllowed = mockAssertBookCrate;
    syncBookCratePlacement = mockSyncBookCrate;
  },
}));

vi.mock('@/server/services/locations', () => ({
  LocationsService: class {
    findOrCreatePlacementDestination = mockFindOrCreateRackOrCrate;
    // The READ half, now that the gate runs BEFORE the row is minted. Defaults
    // to "nothing to reuse", so these suites still exercise the create path and
    // `findOrCreatePlacementDestination` is still what actually mints.
    findRackOrCrate = mockFindRackOrCrate;
  },
}));

import { bookCrateFingerprint } from '@stockpilot/core';

import { ServiceError } from '@/server/services/context';
import { transferStockAction } from './inventory';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ITEM_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const FROM_LOC = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const EXISTING_LOC = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const WAREHOUSE_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const ORG_ID = 'org-test';

/**
 * Install a fresh org context whose supabase stub answers the newRack
 * warehouse verification lookup. `warehouseRow` defaults to a valid same-org
 * row; pass `null` to simulate a cross-tenant / missing warehouse.
 */
function installContext(
  opts: {
    warehouseRow?: Record<string, unknown> | null;
    destinationRow?: Record<string, unknown> | null;
  } = {},
): SupabaseStub {
  const warehouseRow = 'warehouseRow' in opts ? opts.warehouseRow : { id: WAREHOUSE_ID };
  // The existing-destination branch now re-reads the destination row for its
  // CRATE columns (the gate has to know what the book's summary would become)
  // and pins it to the caller's org while it is there.
  const destinationRow =
    'destinationRow' in opts
      ? opts.destinationRow
      : {
          id: EXISTING_LOC,
          warehouse_id: WAREHOUSE_ID,
          kind: 'rack',
          rack_number: '22',
          rack_row: 'B',
          crate_color: null,
          crate_number: null,
          name: '22-B',
        };
  const stub = makeSupabaseStub({
    'warehouses.select': { data: warehouseRow ?? null, error: null },
    'locations.select': { data: destinationRow ?? null, error: null },
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

beforeEach(() => {
  vi.clearAllMocks();
  mockTransferStock.mockResolvedValue(undefined);
  mockFindOrCreateRackOrCrate.mockResolvedValue({ id: 'new-loc-99' });
  mockAssertBookCrate.mockResolvedValue(new Map());
  mockSyncBookCrate.mockResolvedValue({
    syncedItemIds: [],
    failedItemIds: [],
    skippedItemIds: [],
    staleItemIds: [],
    unplacedItemIds: [],
    rackPreservedItemIds: [],
    cratePreservedItemIds: [],
  });
  installContext();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('transferStockAction (destination union)', () => {
  it('1. transfers to an existing destination without creating a location', async () => {
    const result = await transferStockAction({
      itemId: ITEM_ID,
      fromLocationId: FROM_LOC,
      quantity: 5,
      notes: 'moving stock',
      destination: { existingLocationId: EXISTING_LOC },
    });

    expect(mockFindOrCreateRackOrCrate).not.toHaveBeenCalled();
    expect(mockTransferStock).toHaveBeenCalledOnce();
    expect(mockTransferStock).toHaveBeenCalledWith({
      itemId: ITEM_ID,
      fromLocationId: FROM_LOC,
      toLocationId: EXISTING_LOC,
      quantity: 5,
      notes: 'moving stock',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.toLocationId).toBe(EXISTING_LOC);
  });

  it('2. creates the new rack (org-verified warehouse) then transfers to it', async () => {
    const newLocId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
    const callOrder: string[] = [];
    mockFindOrCreateRackOrCrate.mockImplementation(async () => {
      callOrder.push('create');
      return { id: newLocId };
    });
    mockTransferStock.mockImplementation(async () => {
      callOrder.push('transfer');
    });

    const result = await transferStockAction({
      itemId: ITEM_ID,
      fromLocationId: FROM_LOC,
      quantity: 3,
      destination: {
        newRack: { warehouseId: WAREHOUSE_ID, rackNumber: 'R-7', rackRow: 'C' },
      },
    });

    expect(mockFindOrCreateRackOrCrate).toHaveBeenCalledOnce();
    const createArg = (mockFindOrCreateRackOrCrate.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(createArg.kind).toBe('rack');
    expect(createArg.type).toBe('shelf');
    expect(createArg.warehouseId).toBe(WAREHOUSE_ID);
    expect(createArg.rackNumber).toBe('R-7');
    expect(createArg.name).toBe('R-7-C');

    expect(mockTransferStock).toHaveBeenCalledWith({
      itemId: ITEM_ID,
      fromLocationId: FROM_LOC,
      toLocationId: newLocId,
      quantity: 3,
      notes: undefined,
    });
    expect(callOrder).toEqual(['create', 'transfer']);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.toLocationId).toBe(newLocId);
  });

  it('3. rejects a newRack under a warehouse NOT in the caller org — no create/transfer', async () => {
    installContext({ warehouseRow: null });

    const result = await transferStockAction({
      itemId: ITEM_ID,
      fromLocationId: FROM_LOC,
      quantity: 3,
      destination: { newRack: { warehouseId: WAREHOUSE_ID, rackNumber: 'R-7' } },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('validation_error');
      expect(result.error.message).toMatch(/warehouse not found in your organization/i);
    }
    expect(mockFindOrCreateRackOrCrate).not.toHaveBeenCalled();
    expect(mockTransferStock).not.toHaveBeenCalled();
  });

  it('4. permission branch: a forbidden LocationsService.findOrCreatePlacementDestination (no stock:transfer / locations:manage) blocks the transfer', async () => {
    // findOrCreatePlacementDestination falls through to the placement mint
    // (stock:transfer OR locations:manage, re-checked inside
    // mint_placement_location) when no matching rack/crate already exists —
    // when that throws, the action must surface the error and NEVER run the
    // transfer against a half-created destination.
    mockFindOrCreateRackOrCrate.mockRejectedValueOnce(new ServiceError('forbidden', 'Permission denied'));

    const result = await transferStockAction({
      itemId: ITEM_ID,
      fromLocationId: FROM_LOC,
      quantity: 3,
      destination: { newRack: { warehouseId: WAREHOUSE_ID, rackNumber: 'R-7' } },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('forbidden');
    expect(mockTransferStock).not.toHaveBeenCalled();
  });

  it('5. rejects same source/destination and non-positive quantity via schema', async () => {
    const same = await transferStockAction({
      itemId: ITEM_ID,
      fromLocationId: FROM_LOC,
      quantity: 5,
      destination: { existingLocationId: FROM_LOC },
    });
    expect(same.ok).toBe(false);
    if (!same.ok) expect(same.error.code).toBe('validation_error');

    const zero = await transferStockAction({
      itemId: ITEM_ID,
      fromLocationId: FROM_LOC,
      quantity: 0,
      destination: { existingLocationId: EXISTING_LOC },
    });
    expect(zero.ok).toBe(false);
    if (!zero.ok) expect(zero.error.code).toBe('validation_error');

    expect(mockTransferStock).not.toHaveBeenCalled();
    expect(mockFindOrCreateRackOrCrate).not.toHaveBeenCalled();
  });

  it('6. maps an insufficient_stock RPC error to a friendly message', async () => {
    mockTransferStock.mockRejectedValueOnce(
      new ServiceError('internal_error', 'insufficient_stock: cannot move 100 of 5'),
    );

    const result = await transferStockAction({
      itemId: ITEM_ID,
      fromLocationId: FROM_LOC,
      quantity: 100,
      destination: { existingLocationId: EXISTING_LOC },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('validation_error');
      expect(result.error.message).toBe("Can't transfer more than is available.");
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // STAGING IS NOT A DESTINATION. UNPLACED IS — rack 100-A, 2026-07-23
  //
  // These two buckets were refused together, and lumping them cost 220 books.
  // Andrew created a test rack, moved 242 units onto it, and then had to get
  // them off. The dialog offered exactly two ways: transfer to another REAL
  // rack, or "Remove from rack" — which is a WRITE-OFF. There was no way to
  // say "this stock is on hand but on no rack", because `unplaced` was
  // filtered out of every destination list. He wrote off four lots (Persepolis
  // -140, Maus I -40, Hunger Games -20, The distance between us -20) two hours
  // after a physical cycle count had verified those very balances. The books
  // were real PO receipts. Nothing brought them back.
  //
  // So the two buckets are now separated, because they were never the same:
  //
  //   STAGING is the RECEIVING workflow's inbox. Moving stock back into it
  //   would forge the appearance of an un-processed receipt, and the dialog
  //   already says as much when the SOURCE is staged ("placement is handled in
  //   the staging workflow"). Still refused.
  //
  //   UNPLACED is simply "on hand, on no rack" — the exact inverse of a
  //   put-away, and the honest home for stock leaving a rack that should never
  //   have existed. It is non-destructive and fully reversible, which is
  //   precisely what the write-off it replaces is not.
  //
  // The blanket refusal was justified by SILENCE, not by the destination: the
  // reconciliation classifies both buckets out of the placement set, found
  // nothing to synchronize to, and wrote nothing while the item went on
  // reading "Blue 4". That silence is over — `crateSyncUnplaced` is reported
  // by this action and surfaced as a warning by both clients (test 9 below).
  // The operator is now TOLD the label may be stale instead of the move being
  // forbidden to protect them from a message that did not exist yet.
  // ─────────────────────────────────────────────────────────────────────────
  it('7. rejects transferring INTO the staging bucket — no gate, no move', async () => {
    installContext({
      destinationRow: {
        id: EXISTING_LOC,
        warehouse_id: WAREHOUSE_ID,
        kind: 'staging',
        rack_number: null,
        rack_row: null,
        crate_color: null,
        crate_number: null,
        name: 'Staging',
      },
    });

    const result = await transferStockAction({
      itemId: ITEM_ID,
      fromLocationId: FROM_LOC,
      quantity: 40,
      destination: { existingLocationId: EXISTING_LOC },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('validation_error');
      expect(result.error.message).toBe(
        'Staging is the receiving workflow — pick a rack, a crate, or Unplaced.',
      );
    }
    // Refused BEFORE the book-crate gate can promise a clearing it cannot
    // deliver, and before anything physical happens.
    expect(mockAssertBookCrate).not.toHaveBeenCalled();
    expect(mockTransferStock).not.toHaveBeenCalled();
    expect(mockSyncBookCrate).not.toHaveBeenCalled();
  });

  it('7b. ALLOWS transferring INTO the unplaced bucket — the un-place that replaces a write-off', async () => {
    installContext({
      destinationRow: {
        id: EXISTING_LOC,
        warehouse_id: WAREHOUSE_ID,
        kind: 'unplaced',
        rack_number: null,
        rack_row: null,
        crate_color: null,
        crate_number: null,
        name: 'Unplaced',
      },
    });
    // Taking a book off its last rack leaves it in no placement at all, which
    // is the reconciliation's `placed.size === 0` branch — the flag, not a
    // refusal, is what the operator gets.
    mockSyncBookCrate.mockResolvedValueOnce({
      syncedItemIds: [],
      failedItemIds: [],
      skippedItemIds: [],
      staleItemIds: [],
      unplacedItemIds: [ITEM_ID],
      rackPreservedItemIds: [],
      cratePreservedItemIds: [],
    });

    const result = await transferStockAction({
      itemId: ITEM_ID,
      fromLocationId: FROM_LOC,
      quantity: 40,
      destination: { existingLocationId: EXISTING_LOC },
    });

    expect(result.ok).toBe(true);
    // The stock genuinely moved — this is a MOVE, and the quantity is
    // untouched. That is the entire point: 22 units are still stranded on
    // 100-A today precisely because the only alternative destroyed stock.
    expect(mockTransferStock).toHaveBeenCalledOnce();
    expect(mockTransferStock).toHaveBeenCalledWith(
      expect.objectContaining({ toLocationId: EXISTING_LOC, quantity: 40 }),
    );
    // The gate still runs — un-placing is not a bypass of the crate rules.
    expect(mockAssertBookCrate).toHaveBeenCalled();
    // ...and the operator is TOLD the label may now be stale.
    if (result.ok) expect(result.data.crateSyncUnplaced).toBe(true);
  });

  it('8. an ACKNOWLEDGED transfer into staging is refused too — the acknowledgement is not a bypass', async () => {
    // The exact request the reviewer ran: the client answered the gate's
    // "Blue 4 will be cleared" prompt and retried. Answering a prompt does not
    // turn a system bucket into a destination.
    installContext({
      destinationRow: {
        id: EXISTING_LOC,
        warehouse_id: WAREHOUSE_ID,
        kind: 'staging',
        rack_number: null,
        rack_row: null,
        crate_color: null,
        crate_number: null,
        name: 'Staging',
      },
    });

    const result = await transferStockAction({
      itemId: ITEM_ID,
      fromLocationId: FROM_LOC,
      quantity: 40,
      destination: { existingLocationId: EXISTING_LOC },
      acknowledgedCrateChanges: [
        { itemId: ITEM_ID, currentFingerprint: bookCrateFingerprint('blue', '4') },
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe(
        'Staging is the receiving workflow — pick a rack, a crate, or Unplaced.',
      );
    }
    expect(mockTransferStock).not.toHaveBeenCalled();
  });

  it('9. surfaces crateSyncUnplaced — a reconciliation that found nothing to follow is never silent', async () => {
    // The reconciliation's `placed.size === 0` branch used to be a bare
    // `continue`: no sync, no skip, no failure, no flag. The action must now
    // carry it, or a move that left the crate label describing an empty crate
    // still looks identical to one that relabelled correctly.
    mockSyncBookCrate.mockResolvedValueOnce({
      syncedItemIds: [],
      failedItemIds: [],
      skippedItemIds: [],
      staleItemIds: [],
      unplacedItemIds: [ITEM_ID],
      rackPreservedItemIds: [],
      cratePreservedItemIds: [],
    });

    const result = await transferStockAction({
      itemId: ITEM_ID,
      fromLocationId: FROM_LOC,
      quantity: 40,
      destination: { existingLocationId: EXISTING_LOC },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.crateSyncUnplaced).toBe(true);
      // ...and it is not misreported as one of the other three.
      expect(result.data.crateSyncFailed).toBeUndefined();
      expect(result.data.crateSyncSkipped).toBeUndefined();
      expect(result.data.crateSyncStale).toBeUndefined();
    }
    // The stock really moved — the flag is about the LABEL, never a rollback.
    expect(mockTransferStock).toHaveBeenCalledOnce();
  });

  it('10. a clean transfer does NOT set crateSyncUnplaced', async () => {
    const result = await transferStockAction({
      itemId: ITEM_ID,
      fromLocationId: FROM_LOC,
      quantity: 40,
      destination: { existingLocationId: EXISTING_LOC },
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.crateSyncUnplaced).toBeUndefined();
  });
});
