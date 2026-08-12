import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub, type SupabaseStub } from '@/test/supabase-mock';

// ---------------------------------------------------------------------------
// The book-crate half of placement, at the service layer.
//
// THE RULE these tests pin (see packages/core/src/inventory/book-crate-placement.ts):
//   • physical truth is item_stock_levels -> locations; book_crate_* is a SUMMARY
//   • all placed holdings in ONE rack/crate  → synchronize the summary to it
//     (a RACK destination CLEARS the crate — a stale "Blue 4" misdirects a picker)
//   • holdings SPLIT across locations        → leave the summary ALONE
//   • overwriting a recorded crate needs acknowledgement; first assignment and
//     same-crate do not
//   • the CURRENT crate is always re-read from the DB, never taken from a caller
// ---------------------------------------------------------------------------

vi.mock('./context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./context')>();
  return { ...actual, assertPermission: vi.fn(), assertPlanLimit: vi.fn() };
});

// audit() writes through the admin client; silence it and keep a spy so the
// trail assertions below have something to read.
const { mockAudit } = vi.hoisted(() => ({
  mockAudit: vi.fn(async (_payload: Record<string, unknown>, _ctx?: unknown) => undefined),
}));
vi.mock('./audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./audit')>();
  return { ...actual, audit: mockAudit };
});

import { ServiceError } from './context';
import { InventoryService } from './inventory';

const BOOK_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const BOOK_B = 'aaaaaaaa-0000-0000-0000-000000000002';
const WIDGET = 'aaaaaaaa-0000-0000-0000-000000000003';

const CRATE_GREEN_2 = {
  kind: 'crate',
  name: 'Green #2',
  rackNumber: null,
  rackRow: null,
  crateColor: 'green',
  crateNumber: '2',
};
const RACK_22B = {
  kind: 'rack',
  name: '22-B',
  rackNumber: '22',
  rackRow: 'B',
  crateColor: null,
  crateNumber: null,
};

/** An inventory_items row as the summary reader sees it. */
function itemRow(
  id: string,
  name: string,
  itemType: string,
  customFields: Record<string, unknown> | null,
) {
  return { id, name, item_type: itemType, custom_fields: customFields };
}

/** A holding row as the reconciliation read sees it. */
function holding(
  itemId: string,
  locationId: string,
  loc: {
    kind: string | null;
    type?: string | null;
    crate_color?: string | null;
    crate_number?: string | null;
  },
) {
  return {
    item_id: itemId,
    location_id: locationId,
    quantity: 5,
    locations: {
      id: locationId,
      kind: loc.kind,
      type: loc.type ?? null,
      crate_color: loc.crate_color ?? null,
      crate_number: loc.crate_number ?? null,
    },
  };
}

function svcWith(results: Record<string, { data: unknown; error: { message: string } | null }>): {
  svc: InventoryService;
  stub: SupabaseStub;
} {
  const stub = makeSupabaseStub(results);
  return { svc: new InventoryService(makeServiceContext(stub.client)), stub };
}

beforeEach(() => vi.clearAllMocks());

// ═══════════════════════════════════════════════════════════════════════════
// THE GATE — assertBookCratePlacementAllowed
// ═══════════════════════════════════════════════════════════════════════════

describe('assertBookCratePlacementAllowed', () => {
  it('REFUSES an unacknowledged overwrite with the structured payload', async () => {
    const { svc } = svcWith({
      'inventory_items.select': {
        data: [
          itemRow(BOOK_A, 'Persepolis', 'book', {
            book_crate_color: 'blue',
            book_crate_number: '4',
          }),
        ],
        error: null,
      },
    });

    const thrown = await svc
      .assertBookCratePlacementAllowed([BOOK_A], CRATE_GREEN_2)
      .then(() => null)
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(ServiceError);
    const err = thrown as ServiceError;
    expect(err.code).toBe('conflict');
    expect(err.details).toEqual({
      reason: 'BOOK_CRATE_CHANGE_REQUIRES_CONFIRMATION',
      items: [
        {
          itemId: BOOK_A,
          itemName: 'Persepolis',
          currentLabel: 'Blue 4',
          nextLabel: 'Green 2',
        },
      ],
    });
  });

  it('PASSES the identical placement once acknowledgeCrateChange is true', async () => {
    const { svc } = svcWith({
      'inventory_items.select': {
        data: [
          itemRow(BOOK_A, 'Persepolis', 'book', {
            book_crate_color: 'blue',
            book_crate_number: '4',
          }),
        ],
        error: null,
      },
    });

    await expect(
      svc.assertBookCratePlacementAllowed([BOOK_A], CRATE_GREEN_2, {
        acknowledgeCrateChange: true,
      }),
    ).resolves.toBeInstanceOf(Map);
  });

  it('FIRST ASSIGNMENT needs no confirmation', async () => {
    const { svc } = svcWith({
      'inventory_items.select': {
        data: [itemRow(BOOK_A, 'Persepolis', 'book', { author: 'Satrapi' })],
        error: null,
      },
    });
    await expect(
      svc.assertBookCratePlacementAllowed([BOOK_A], CRATE_GREEN_2),
    ).resolves.toBeInstanceOf(Map);
  });

  it('the SAME crate needs no confirmation, even spelled differently', async () => {
    const { svc } = svcWith({
      'inventory_items.select': {
        data: [
          itemRow(BOOK_A, 'Persepolis', 'book', {
            book_crate_color: 'GREEN',
            book_crate_number: ' 2 ',
          }),
        ],
        error: null,
      },
    });
    await expect(
      svc.assertBookCratePlacementAllowed([BOOK_A], CRATE_GREEN_2),
    ).resolves.toBeInstanceOf(Map);
  });

  it('a RACK destination on a crated book IS an overwrite — the crate is being erased', async () => {
    const { svc } = svcWith({
      'inventory_items.select': {
        data: [
          itemRow(BOOK_A, 'Persepolis', 'book', {
            book_crate_color: 'blue',
            book_crate_number: '4',
          }),
        ],
        error: null,
      },
    });

    const err = (await svc
      .assertBookCratePlacementAllowed([BOOK_A], RACK_22B)
      .catch((e: unknown) => e)) as ServiceError;

    expect(err.code).toBe('conflict');
    expect(err.details).toMatchObject({
      items: [{ currentLabel: 'Blue 4', nextLabel: null }],
    });
  });

  it('NON-BOOKS never reach the gate', async () => {
    const { svc } = svcWith({
      'inventory_items.select': {
        // A product carrying book_crate_* keys it should never have had.
        data: [
          itemRow(WIDGET, 'Chromebook', 'product', {
            book_crate_color: 'blue',
            book_crate_number: '4',
          }),
        ],
        error: null,
      },
    });
    await expect(svc.assertBookCratePlacementAllowed([WIDGET], CRATE_GREEN_2)).resolves.toEqual(
      new Map(),
    );
  });

  it('names EVERY conflicting book in a batch, not just the first', async () => {
    const { svc } = svcWith({
      'inventory_items.select': {
        data: [
          itemRow(BOOK_A, 'Persepolis', 'book', {
            book_crate_color: 'blue',
            book_crate_number: '4',
          }),
          itemRow(BOOK_B, 'Maus I', 'book', {
            book_crate_color: 'red',
            book_crate_number: 'Bin',
          }),
        ],
        error: null,
      },
    });

    const err = (await svc
      .assertBookCratePlacementAllowed([BOOK_A, BOOK_B], CRATE_GREEN_2)
      .catch((e: unknown) => e)) as ServiceError;

    const detail = err.details as { items: Array<{ itemName: string; currentLabel: string }> };
    expect(detail.items.map((i) => i.itemName)).toEqual(['Persepolis', 'Maus I']);
    expect(detail.items.map((i) => i.currentLabel)).toEqual(['Blue 4', 'Red Bin']);
    expect(err.message).toContain('2 books');
  });

  it('reads the CURRENT crate from the DB — a caller cannot pre-empt the comparison', async () => {
    // The DB says Green 2 and the destination IS Green 2, so there is nothing
    // to confirm. A caller insisting the book is in "Blue 4" changes nothing,
    // because the method takes no such argument: it re-reads.
    const { svc, stub } = svcWith({
      'inventory_items.select': {
        data: [
          itemRow(BOOK_A, 'Persepolis', 'book', {
            book_crate_color: 'green',
            book_crate_number: '2',
          }),
        ],
        error: null,
      },
    });

    await expect(
      svc.assertBookCratePlacementAllowed([BOOK_A], CRATE_GREEN_2),
    ).resolves.toBeInstanceOf(Map);
    expect(stub.fromCalls).toContain('inventory_items');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// RECONCILIATION — syncBookCratePlacement
// ═══════════════════════════════════════════════════════════════════════════

describe('syncBookCratePlacement', () => {
  it('ONE placed location → synchronizes the summary to THAT location\'s crate columns', async () => {
    const { svc, stub } = svcWith({
      'inventory_items.select': {
        data: [
          itemRow(BOOK_A, 'Persepolis', 'book', {
            book_crate_color: 'blue',
            book_crate_number: '4',
          }),
        ],
        error: null,
      },
      'item_stock_levels.select': {
        data: [holding(BOOK_A, 'loc-green', { kind: 'crate', crate_color: 'green', crate_number: '2' })],
        error: null,
      },
      'rpc:inventory_set_book_storage': { data: 1, error: null },
    });

    const res = await svc.syncBookCratePlacement([BOOK_A]);

    expect(res.failedItemIds).toEqual([]);
    const call = stub.rpcCalls.find((c) => c.name === 'inventory_set_book_storage')!;
    expect(call.args).toEqual({
      p_item_ids: [BOOK_A],
      p_crate_color: 'green',
      p_crate_number: '2',
    });
  });

  it('SPLIT holdings → the summary is NOT overwritten (no RPC at all)', async () => {
    // Stock in two different crates. Stamping the newest one would assert
    // something false about the other half; holdings stay authoritative.
    const { svc, stub } = svcWith({
      'inventory_items.select': {
        data: [
          itemRow(BOOK_A, 'Persepolis', 'book', {
            book_crate_color: 'blue',
            book_crate_number: '4',
          }),
        ],
        error: null,
      },
      'item_stock_levels.select': {
        data: [
          holding(BOOK_A, 'loc-green', { kind: 'crate', crate_color: 'green', crate_number: '2' }),
          holding(BOOK_A, 'loc-blue', { kind: 'crate', crate_color: 'blue', crate_number: '4' }),
        ],
        error: null,
      },
      'rpc:inventory_set_book_storage': { data: 1, error: null },
    });

    const res = await svc.syncBookCratePlacement([BOOK_A]);

    expect(res.failedItemIds).toEqual([]);
    // REPORTED, not silent. A skip that says nothing is indistinguishable from
    // a success, and for an org whose books also sit on a Site (migration
    // 0292: 405 units on DC4 alone) the skip is the COMMON outcome — the whole
    // feature would look like it worked and changed nothing.
    expect(res.skippedItemIds).toEqual([BOOK_A]);
    expect(stub.rpcCalls.some((c) => c.name === 'inventory_set_book_storage')).toBe(false);
  });

  it('a split across a crate AND a NULL-kind site holding still counts as split', async () => {
    // Recurring pattern #23: `.in('locations.kind', [...])` drops NULL-kind
    // rows, so a book half-sitting on a plain site would look single-located
    // and get stamped. The read carries no kind filter for exactly this reason.
    const { svc, stub } = svcWith({
      'inventory_items.select': {
        data: [itemRow(BOOK_A, 'Persepolis', 'book', { book_crate_number: '4' })],
        error: null,
      },
      'item_stock_levels.select': {
        data: [
          holding(BOOK_A, 'loc-green', { kind: 'crate', crate_color: 'green', crate_number: '2' }),
          holding(BOOK_A, 'loc-dc4', { kind: null, type: 'warehouse' }),
        ],
        error: null,
      },
      'rpc:inventory_set_book_storage': { data: 1, error: null },
    });

    await svc.syncBookCratePlacement([BOOK_A]);
    expect(stub.rpcCalls.some((c) => c.name === 'inventory_set_book_storage')).toBe(false);
  });

  it('leftover STAGING/UNPLACED stock does not make a placement look split', async () => {
    // Those buckets are stock waiting to be put away, not a location the book
    // "is in" — a partial put-away must still synchronize.
    const { svc, stub } = svcWith({
      'inventory_items.select': {
        data: [itemRow(BOOK_A, 'Persepolis', 'book', null)],
        error: null,
      },
      'item_stock_levels.select': {
        data: [
          holding(BOOK_A, 'loc-green', { kind: 'crate', crate_color: 'green', crate_number: '2' }),
          holding(BOOK_A, 'loc-stg', { kind: 'staging' }),
          holding(BOOK_A, 'loc-unp', { kind: 'unplaced' }),
        ],
        error: null,
      },
      'rpc:inventory_set_book_storage': { data: 1, error: null },
    });

    await svc.syncBookCratePlacement([BOOK_A]);
    const call = stub.rpcCalls.find((c) => c.name === 'inventory_set_book_storage')!;
    expect(call.args).toMatchObject({ p_crate_color: 'green', p_crate_number: '2' });
  });

  it('a RACK-only destination CLEARS the crate summary (both args null)', async () => {
    const { svc, stub } = svcWith({
      'inventory_items.select': {
        data: [
          itemRow(BOOK_A, 'Persepolis', 'book', {
            book_crate_color: 'blue',
            book_crate_number: '4',
          }),
        ],
        error: null,
      },
      'item_stock_levels.select': {
        data: [holding(BOOK_A, 'loc-rack', { kind: 'rack' })],
        error: null,
      },
      'rpc:inventory_set_book_storage': { data: 1, error: null },
    });

    await svc.syncBookCratePlacement([BOOK_A]);

    const call = stub.rpcCalls.find((c) => c.name === 'inventory_set_book_storage')!;
    expect(call.args).toEqual({
      p_item_ids: [BOOK_A],
      p_crate_color: null,
      p_crate_number: null,
    });
  });

  it('NON-BOOKS are never written', async () => {
    const { svc, stub } = svcWith({
      'inventory_items.select': {
        data: [itemRow(WIDGET, 'Chromebook', 'product', null)],
        error: null,
      },
      'item_stock_levels.select': {
        data: [holding(WIDGET, 'loc-green', { kind: 'crate', crate_color: 'green', crate_number: '2' })],
        error: null,
      },
    });

    const res = await svc.syncBookCratePlacement([WIDGET]);
    expect(res.failedItemIds).toEqual([]);
    expect(stub.rpcCalls.some((c) => c.name === 'inventory_set_book_storage')).toBe(false);
    // Not even a holdings read — there was no book to reconcile.
    expect(stub.fromCalls).not.toContain('item_stock_levels');
  });

  it('NEVER throws when the summary read fails — the stock already moved', async () => {
    // readBookCrateSummaries throws ServiceError on a query error. Every caller
    // runs this AFTER transferStock has committed, so an escaping exception
    // reads as "placement failed" for a placement that succeeded — and the
    // operator retries and moves the stock a second time.
    const { svc } = svcWith({
      'inventory_items.select': { data: null, error: { message: 'connection reset' } },
    });

    await expect(svc.syncBookCratePlacement([BOOK_A])).resolves.toEqual({
      failedItemIds: [BOOK_A],
      skippedItemIds: [],
    });
  });

  it('does not merge two DIFFERENT crates that share a space-joined key', async () => {
    // crate_number is free text and production holds "Blue Shelf", so
    // ('Blue','Shelf 2') and ('Blue Shelf','2') keyed identically once — and
    // the first pair to claim the key was written onto both batches' books.
    const { svc, stub } = svcWith({
      'inventory_items.select': {
        data: [
          itemRow(BOOK_A, 'Persepolis', 'book', null),
          itemRow(BOOK_B, 'Maus I', 'book', null),
        ],
        error: null,
      },
      'item_stock_levels.select': {
        data: [
          holding(BOOK_A, 'loc-a', { kind: 'crate', crate_color: 'Blue', crate_number: 'Shelf 2' }),
          holding(BOOK_B, 'loc-b', { kind: 'crate', crate_color: 'Blue Shelf', crate_number: '2' }),
        ],
        error: null,
      },
      'rpc:inventory_set_book_storage': { data: 1, error: null },
    });

    await svc.syncBookCratePlacement([BOOK_A, BOOK_B]);

    const calls = stub.rpcCalls.filter((c) => c.name === 'inventory_set_book_storage');
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.args)).toEqual([
      { p_item_ids: [BOOK_A], p_crate_color: 'Blue', p_crate_number: 'Shelf 2' },
      { p_item_ids: [BOOK_B], p_crate_color: 'Blue Shelf', p_crate_number: '2' },
    ]);
  });

  it('books landing in the SAME crate share ONE RPC call', async () => {
    const { svc, stub } = svcWith({
      'inventory_items.select': {
        data: [
          itemRow(BOOK_A, 'Persepolis', 'book', null),
          itemRow(BOOK_B, 'Maus I', 'book', null),
        ],
        error: null,
      },
      'item_stock_levels.select': {
        data: [
          holding(BOOK_A, 'loc-green', { kind: 'crate', crate_color: 'green', crate_number: '2' }),
          holding(BOOK_B, 'loc-green', { kind: 'crate', crate_color: 'green', crate_number: '2' }),
        ],
        error: null,
      },
      'rpc:inventory_set_book_storage': { data: 2, error: null },
    });

    await svc.syncBookCratePlacement([BOOK_A, BOOK_B]);

    const calls = stub.rpcCalls.filter((c) => c.name === 'inventory_set_book_storage');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toMatchObject({ p_item_ids: [BOOK_A, BOOK_B] });
  });

  it('REPORTS a failed write instead of swallowing it — the label may now be stale', async () => {
    const { svc } = svcWith({
      'inventory_items.select': {
        data: [itemRow(BOOK_A, 'Persepolis', 'book', null)],
        error: null,
      },
      'item_stock_levels.select': {
        data: [holding(BOOK_A, 'loc-green', { kind: 'crate', crate_color: 'green', crate_number: '2' })],
        error: null,
      },
      'rpc:inventory_set_book_storage': { data: null, error: { message: 'boom' } },
    });

    // NEVER throws: the stock really moved and hand-rolling a rollback of a
    // real movement is worse than a stale label. It reports instead.
    await expect(svc.syncBookCratePlacement([BOOK_A])).resolves.toEqual({
      failedItemIds: [BOOK_A],
      skippedItemIds: [],
    });
  });

  it('treats a 0-row write as a FAILURE (never fail open on affected rows)', async () => {
    // Recurring pattern #2: an .update()/RPC whose row count is not checked
    // reports success while having changed nothing (RLS filtered the rows).
    const { svc } = svcWith({
      'inventory_items.select': {
        data: [itemRow(BOOK_A, 'Persepolis', 'book', null)],
        error: null,
      },
      'item_stock_levels.select': {
        data: [holding(BOOK_A, 'loc-green', { kind: 'crate', crate_color: 'green', crate_number: '2' })],
        error: null,
      },
      'rpc:inventory_set_book_storage': { data: 0, error: null },
    });

    await expect(svc.syncBookCratePlacement([BOOK_A])).resolves.toEqual({
      failedItemIds: [BOOK_A],
      skippedItemIds: [],
    });
  });

  it('audits the crate change on the EXISTING inventory.item.updated event', async () => {
    const { svc } = svcWith({
      'inventory_items.select': {
        data: [
          itemRow(BOOK_A, 'Persepolis', 'book', {
            book_crate_color: 'blue',
            book_crate_number: '4',
          }),
        ],
        error: null,
      },
      'item_stock_levels.select': {
        data: [holding(BOOK_A, 'loc-green', { kind: 'crate', crate_color: 'green', crate_number: '2' })],
        error: null,
      },
      'rpc:inventory_set_book_storage': { data: 1, error: null },
    });

    await svc.syncBookCratePlacement([BOOK_A], {
      audit: { toLocationId: 'loc-green', quantityByItemId: new Map([[BOOK_A, 12]]) },
    });

    expect(mockAudit).toHaveBeenCalledTimes(1);
    const payload = mockAudit.mock.calls[0]![0];
    // No parallel event name — the same one every other custom_fields write uses.
    expect(payload.event).toBe('inventory.item.updated');
    expect(payload.entityId).toBe(BOOK_A);
    expect(payload.before).toEqual({ book_crate_color: 'blue', book_crate_number: '4' });
    expect(payload.after).toEqual({ book_crate_color: 'green', book_crate_number: '2' });
    expect(payload.extra).toMatchObject({
      placement: 'book_crate',
      to_location_id: 'loc-green',
      quantity: 12,
    });
  });

  it('writes nothing for an empty id list — no round trip', async () => {
    const { svc, stub } = svcWith({});
    await expect(svc.syncBookCratePlacement([])).resolves.toEqual({
      failedItemIds: [],
      skippedItemIds: [],
    });
    expect(stub.fromCalls).toEqual([]);
  });
});
