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
//    instances expose transferStock / findOrCreateRackOrCrate spies — the
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
    findOrCreateRackOrCrate = mockFindOrCreateRackOrCrate;
    // The READ half, now that the gate runs BEFORE the row is minted. Defaults
    // to "nothing to reuse", so these suites still exercise the create path and
    // `findOrCreateRackOrCrate` is still what actually mints.
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

  it('4. permission branch: a forbidden LocationsService.findOrCreateRackOrCrate (locations:manage) blocks the transfer', async () => {
    // findOrCreateRackOrCrate falls through to create() (which asserts
    // 'locations:manage' + the locations plan limit) when no matching
    // rack/crate already exists — when that throws, the action must surface
    // the error and NEVER run the transfer against a half-created destination.
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
  // A STAGING/UNPLACED BUCKET IS NOT A DESTINATION — the fourth surface
  //
  // placeStockAction, bulkPlaceStockAction and POST /api/v1/items/[id]/transfer
  // all refused this already; Transfer did not, and the gap was not merely
  // untidy. All 40 units of a book recorded "Blue 4" could be transferred into
  // Staging: the gate refused first and PROMISED "Placing it here will change
  // that to no crate", the operator acknowledged exactly that, the stock left
  // Blue 4 — and the reconciliation, which classifies staging out of the
  // placement set, found nothing to synchronize to and wrote nothing. Plain
  // success, item still reads "Blue 4", picker walks to an empty crate.
  //
  // Neither shipped client can produce this: the web dialog filters
  // `kind !== 'staging' && kind !== 'unplaced'` out of its destination list and
  // the phone's Move stock sheet queries `.in('kind', ['rack','crate'])`. So
  // nothing legitimate is being blocked here — only a forged or future caller.
  // ─────────────────────────────────────────────────────────────────────────
  for (const kind of ['staging', 'unplaced'] as const) {
    it(`7. rejects transferring INTO a ${kind} bucket — no gate, no move`, async () => {
      installContext({
        destinationRow: {
          id: EXISTING_LOC,
          warehouse_id: WAREHOUSE_ID,
          kind,
          rack_number: null,
          rack_row: null,
          crate_color: null,
          crate_number: null,
          name: kind === 'staging' ? 'Staging' : 'Unplaced',
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
        // The SAME sentence the three siblings answer with — one rule, one
        // wording, every surface.
        expect(result.error.message).toBe('Pick a rack or crate as the destination.');
      }
      // Refused BEFORE the book-crate gate can promise a clearing it cannot
      // deliver, and before anything physical happens.
      expect(mockAssertBookCrate).not.toHaveBeenCalled();
      expect(mockTransferStock).not.toHaveBeenCalled();
      expect(mockSyncBookCrate).not.toHaveBeenCalled();
    });
  }

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
      expect(result.error.message).toBe('Pick a rack or crate as the destination.');
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
