import { bookCrateFingerprint } from '@stockpilot/core';
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

/**
 * The gate's pre-move read, in the shape `syncBookCratePlacement` REQUIRES.
 *
 * It is the freshness proof: the reconciliation re-reads the same rows after
 * the stock has moved and writes only where the two agree. Unless a test is
 * specifically about a row CHANGING mid-flight (see the "concurrent edit"
 * describe below), this mirrors the fixture — nobody edited anything.
 */
function verified(
  entries: Array<
    [string, { name?: string; crateColor?: string | null; crateNumber?: string | null }]
  >,
) {
  return new Map(
    entries.map(([id, v]) => [
      id,
      {
        name: v.name ?? '',
        crateColor: v.crateColor ?? null,
        crateNumber: v.crateNumber ?? null,
      },
    ]),
  );
}

const BLUE_4 = { crateColor: 'blue', crateNumber: '4' };
const NO_CRATE = {};

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
          // The payload names the crate it is refusing over, so the client's
          // acknowledgement can be about THAT crate and nothing else.
          currentFingerprint: bookCrateFingerprint('blue', '4'),
        },
      ],
    });
  });

  it('PASSES once the caller acknowledges THAT SPECIFIC change', async () => {
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
        acknowledged: [
          { itemId: BOOK_A, currentFingerprint: bookCrateFingerprint('blue', '4') },
        ],
      }),
    ).resolves.toBeInstanceOf(Map);
  });

  it('a STALE acknowledgement is refused, and the refusal names the CURRENT crate', async () => {
    // THE DATA-LOSS BUG. The staging tab rendered "Blue 4"; someone re-crated
    // the book to Red 7 from the item screen; the operator places onto a rack.
    // The client's first and only request already carried an acknowledgement —
    // and the gate used to return before comparing anything, so Red 7 was
    // destroyed by a confirmation that named Blue 4.
    const { svc } = svcWith({
      'inventory_items.select': {
        data: [
          itemRow(BOOK_A, 'Persepolis', 'book', {
            book_crate_color: 'red',
            book_crate_number: '7',
          }),
        ],
        error: null,
      },
    });

    const err = (await svc
      .assertBookCratePlacementAllowed([BOOK_A], RACK_22B, {
        acknowledged: [
          { itemId: BOOK_A, currentFingerprint: bookCrateFingerprint('blue', '4') },
        ],
      })
      .catch((e: unknown) => e)) as ServiceError;

    expect(err).toBeInstanceOf(ServiceError);
    expect(err.code).toBe('conflict');
    // Re-asked against CURRENT truth, not the snapshot the client sent.
    expect(err.details).toMatchObject({
      items: [{ currentLabel: 'Red 7', currentFingerprint: bookCrateFingerprint('red', '7') }],
    });
    expect(err.message).toContain('Red 7');
  });

  it('acknowledging one book does not waive ANOTHER book in the same batch', async () => {
    const { svc } = svcWith({
      'inventory_items.select': {
        data: [
          itemRow(BOOK_A, 'Persepolis', 'book', {
            book_crate_color: 'blue',
            book_crate_number: '4',
          }),
          itemRow(BOOK_B, 'Maus I', 'book', {
            book_crate_color: 'red',
            book_crate_number: '7',
          }),
        ],
        error: null,
      },
    });

    const err = (await svc
      .assertBookCratePlacementAllowed([BOOK_A, BOOK_B], CRATE_GREEN_2, {
        acknowledged: [
          { itemId: BOOK_A, currentFingerprint: bookCrateFingerprint('blue', '4') },
        ],
      })
      .catch((e: unknown) => e)) as ServiceError;

    expect(err.code).toBe('conflict');
    // The payload carries EVERY real conflict, not just the unanswered one —
    // the client rebuilds its acknowledgement from this list, so dropping the
    // already-answered line would refuse the retry forever.
    const detail = err.details as { items: Array<{ itemId: string }> };
    expect(detail.items.map((i) => i.itemId)).toEqual([BOOK_A, BOOK_B]);
  });

  it('a fingerprint matching a DIFFERENT spelling of the same crate still waives', async () => {
    // "Bin" and "BIN" are one crate, and a client that rendered either has seen
    // the same value. Normalisation lives in the fingerprint, not at the seam.
    const { svc } = svcWith({
      'inventory_items.select': {
        data: [
          itemRow(BOOK_A, 'Persepolis', 'book', {
            book_crate_color: 'BLUE',
            book_crate_number: ' Bin ',
          }),
        ],
        error: null,
      },
    });

    await expect(
      svc.assertBookCratePlacementAllowed([BOOK_A], CRATE_GREEN_2, {
        acknowledged: [
          { itemId: BOOK_A, currentFingerprint: bookCrateFingerprint('blue', 'BIN') },
        ],
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

  // ─────────────────────────────────────────────────────────────────────────
  // …and never ASK about a change that provably will not happen.
  //
  // syncBookCratePlacement deliberately SKIPS a book whose stock is split
  // across two placements. For this org that is the common outcome, not the
  // rare one (405 units sit directly on Site DC4 — migration 0292), so the
  // gate used to raise a destructive-edit prompt and then change nothing.
  // ─────────────────────────────────────────────────────────────────────────
  const CRATE_GREEN_2_ID = 'loc-green-2';
  const blueFourItems = {
    'inventory_items.select': {
      data: [
        itemRow(BOOK_A, 'Persepolis', 'book', {
          book_crate_color: 'blue',
          book_crate_number: '4',
        }),
      ],
      error: null,
    },
  };

  it('does NOT ask when the book stays SPLIT — the summary will be left alone', async () => {
    const { svc } = svcWith({
      ...blueFourItems,
      'item_stock_levels.select': {
        // Also sitting on a NULL-kind Site. Not a system bucket, so it counts.
        data: [holding(BOOK_A, 'loc-dc4', { kind: null, type: 'warehouse' })],
        error: null,
      },
    });

    await expect(
      svc.assertBookCratePlacementAllowed([BOOK_A], CRATE_GREEN_2, {
        toLocationId: CRATE_GREEN_2_ID,
        moves: new Map([[BOOK_A, { fromLocationId: 'loc-staging', quantity: 5 }]]),
      }),
    ).resolves.toBeInstanceOf(Map);
  });

  it('STILL asks when the destination becomes the only placement', async () => {
    const { svc } = svcWith({
      ...blueFourItems,
      'item_stock_levels.select': {
        // Everything is in staging — a system bucket, so nothing rivals the
        // destination and the sync will genuinely rewrite the summary.
        data: [holding(BOOK_A, 'loc-staging', { kind: 'staging' })],
        error: null,
      },
    });

    const err = (await svc
      .assertBookCratePlacementAllowed([BOOK_A], CRATE_GREEN_2, {
        toLocationId: CRATE_GREEN_2_ID,
        moves: new Map([[BOOK_A, { fromLocationId: 'loc-staging', quantity: 5 }]]),
      })
      .catch((e: unknown) => e)) as ServiceError;
    expect(err.code).toBe('conflict');
  });

  it('FAILS CLOSED: a holdings read error keeps the confirmation', async () => {
    const { svc } = svcWith({
      ...blueFourItems,
      'item_stock_levels.select': { data: null, error: { message: 'connection reset' } },
    });

    const err = (await svc
      .assertBookCratePlacementAllowed([BOOK_A], CRATE_GREEN_2, {
        toLocationId: CRATE_GREEN_2_ID,
        moves: new Map([[BOOK_A, { fromLocationId: 'loc-staging', quantity: 5 }]]),
      })
      .catch((e: unknown) => e)) as ServiceError;
    expect(err.code).toBe('conflict');
  });

  it('costs NO holdings read when nothing conflicts — the fast path stays fast', async () => {
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

    await svc.assertBookCratePlacementAllowed([BOOK_A], CRATE_GREEN_2, {
      toLocationId: CRATE_GREEN_2_ID,
      moves: new Map([[BOOK_A, { fromLocationId: 'loc-staging', quantity: 5 }]]),
    });
    expect(stub.fromCalls).not.toContain('item_stock_levels');
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

    const res = await svc.syncBookCratePlacement([BOOK_A], {
      verified: verified([[BOOK_A, BLUE_4]]),
    });

    expect(res.failedItemIds).toEqual([]);
    expect(res.syncedItemIds).toEqual([BOOK_A]);
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

    const res = await svc.syncBookCratePlacement([BOOK_A], {
      verified: verified([[BOOK_A, BLUE_4]]),
    });

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

    await svc.syncBookCratePlacement([BOOK_A], {
      verified: verified([[BOOK_A, { crateNumber: '4' }]]),
    });
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

    await svc.syncBookCratePlacement([BOOK_A], { verified: verified([[BOOK_A, NO_CRATE]]) });
    const call = stub.rpcCalls.find((c) => c.name === 'inventory_set_book_storage')!;
    expect(call.args).toMatchObject({ p_crate_color: 'green', p_crate_number: '2' });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // NO PLACED HOLDING AT ALL — reported, never a bare `continue`
  //
  // The same classification that makes the test above correct (staging is not
  // a placement) means a book whose stock is ONLY in those buckets has no
  // placement to synchronize to. The loop used to `continue` with no bucket at
  // all: not synced, not skipped, not failed, not stale. The caller got
  // `{ ok: true }` with every flag absent and showed a plain success — while
  // the item went on naming a crate that now holds none of it.
  //
  // The reviewer reproduced exactly this by transferring all 40 units of a
  // book recorded "Blue 4" into Staging, after acknowledging the gate's
  // promise that Blue 4 would be CLEARED. It was not cleared and nothing said
  // so. The transfer destination guard closes that particular door; this
  // bucket closes the class, for every entry point that shares this loop.
  // ═════════════════════════════════════════════════════════════════════════
  it('ONLY staging/unplaced stock left → REPORTED as unplaced, and nothing is written', async () => {
    const { svc, stub } = svcWith({
      'inventory_items.select': {
        data: [
          itemRow(BOOK_A, 'The Outsiders', 'book', {
            book_crate_color: 'blue',
            book_crate_number: '4',
          }),
        ],
        error: null,
      },
      'item_stock_levels.select': {
        data: [
          holding(BOOK_A, 'loc-stg', { kind: 'staging' }),
          holding(BOOK_A, 'loc-unp', { kind: 'unplaced' }),
        ],
        error: null,
      },
    });

    const res = await svc.syncBookCratePlacement([BOOK_A], {
      verified: verified([[BOOK_A, BLUE_4]]),
    });

    expect(res).toEqual({
      syncedItemIds: [],
      failedItemIds: [],
      skippedItemIds: [],
      staleItemIds: [],
      unplacedItemIds: [BOOK_A],
    });
    // The summary is LEFT ALONE, not cleared: a book with no placed stock is a
    // book whose recorded crate is a human's restocking intent, and wiping it
    // on a read that came back empty would be data loss dressed as tidy-up.
    expect(stub.rpcCalls.some((c) => c.name === 'inventory_set_book_storage')).toBe(false);
  });

  it('NO positive holding anywhere → unplaced, not a silent all-clear', async () => {
    // Everything picked/removed between the gate and the write. Same honest
    // answer: nothing to synchronize to, and the caller is told.
    const { svc, stub } = svcWith({
      'inventory_items.select': {
        data: [
          itemRow(BOOK_A, 'The Outsiders', 'book', {
            book_crate_color: 'blue',
            book_crate_number: '4',
          }),
        ],
        error: null,
      },
      'item_stock_levels.select': { data: [], error: null },
    });

    const res = await svc.syncBookCratePlacement([BOOK_A], {
      verified: verified([[BOOK_A, BLUE_4]]),
    });

    expect(res.unplacedItemIds).toEqual([BOOK_A]);
    expect(res.syncedItemIds).toEqual([]);
    expect(stub.rpcCalls.some((c) => c.name === 'inventory_set_book_storage')).toBe(false);
  });

  it('an unplaced book does not stop its BATCH-MATE from synchronizing', async () => {
    // Per-item buckets, not an all-or-nothing verdict: BOOK_B really did land
    // in Green #2 and its summary must follow, while BOOK_A is reported.
    const { svc, stub } = svcWith({
      'inventory_items.select': {
        data: [
          itemRow(BOOK_A, 'The Outsiders', 'book', {
            book_crate_color: 'blue',
            book_crate_number: '4',
          }),
          itemRow(BOOK_B, 'Maus I', 'book', null),
        ],
        error: null,
      },
      'item_stock_levels.select': {
        data: [
          holding(BOOK_A, 'loc-stg', { kind: 'staging' }),
          holding(BOOK_B, 'loc-green', { kind: 'crate', crate_color: 'green', crate_number: '2' }),
        ],
        error: null,
      },
      'rpc:inventory_set_book_storage': { data: 1, error: null },
    });

    const res = await svc.syncBookCratePlacement([BOOK_A, BOOK_B], {
      verified: verified([
        [BOOK_A, BLUE_4],
        [BOOK_B, NO_CRATE],
      ]),
    });

    expect(res.unplacedItemIds).toEqual([BOOK_A]);
    expect(res.syncedItemIds).toEqual([BOOK_B]);
    const call = stub.rpcCalls.find((c) => c.name === 'inventory_set_book_storage')!;
    // ...and only BOOK_B is in the write.
    expect(call.args).toEqual({
      p_item_ids: [BOOK_B],
      p_crate_color: 'green',
      p_crate_number: '2',
    });
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

    await svc.syncBookCratePlacement([BOOK_A], { verified: verified([[BOOK_A, BLUE_4]]) });

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

    // A non-book was never in the gate's map, so `verified` is empty — and that
    // must NOT read as "stale": there is no book here to reconcile at all.
    const res = await svc.syncBookCratePlacement([WIDGET], { verified: new Map() });
    expect(res.failedItemIds).toEqual([]);
    expect(res.staleItemIds).toEqual([]);
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

    await expect(
      svc.syncBookCratePlacement([BOOK_A], { verified: verified([[BOOK_A, NO_CRATE]]) }),
    ).resolves.toEqual({
      syncedItemIds: [],
      failedItemIds: [BOOK_A],
      skippedItemIds: [],
      staleItemIds: [],
      unplacedItemIds: [],
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

    await svc.syncBookCratePlacement([BOOK_A, BOOK_B], {
      verified: verified([
        [BOOK_A, NO_CRATE],
        [BOOK_B, NO_CRATE],
      ]),
    });

    const calls = stub.rpcCalls.filter((c) => c.name === 'inventory_set_book_storage');
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.args)).toEqual([
      // 'Blue' canonicalises to the registry slug on the way onto the item
      // summary; 'Blue Shelf' is not a registry color, so it keeps the only
      // spelling anyone has of it. Neither batch merges into the other.
      { p_item_ids: [BOOK_A], p_crate_color: 'blue', p_crate_number: 'Shelf 2' },
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

    await svc.syncBookCratePlacement([BOOK_A, BOOK_B], {
      verified: verified([
        [BOOK_A, NO_CRATE],
        [BOOK_B, NO_CRATE],
      ]),
    });

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
    await expect(
      svc.syncBookCratePlacement([BOOK_A], { verified: verified([[BOOK_A, NO_CRATE]]) }),
    ).resolves.toEqual({
      syncedItemIds: [],
      failedItemIds: [BOOK_A],
      skippedItemIds: [],
      staleItemIds: [],
      unplacedItemIds: [],
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

    await expect(
      svc.syncBookCratePlacement([BOOK_A], { verified: verified([[BOOK_A, NO_CRATE]]) }),
    ).resolves.toEqual({
      syncedItemIds: [],
      failedItemIds: [BOOK_A],
      skippedItemIds: [],
      staleItemIds: [],
      unplacedItemIds: [],
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
      verified: verified([[BOOK_A, BLUE_4]]),
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
    await expect(svc.syncBookCratePlacement([], { verified: new Map() })).resolves.toEqual({
      syncedItemIds: [],
      failedItemIds: [],
      skippedItemIds: [],
      staleItemIds: [],
      unplacedItemIds: [],
    });
    expect(stub.fromCalls).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE DOUBLE READ — a concurrent edit is not something to overwrite
//
// The gate reads the row at T0 and refuses (or is acknowledged) against THAT
// crate. The stock then moves. The reconciliation re-reads at T2 — and used to
// use the fresh row for nothing but the item-type filter and the audit
// `before`, stamping the destination over whatever it found. A crate edited in
// between was destroyed with no confirmation at all: the exact silent overwrite
// the gate in front of it exists to refuse, arriving through the back door.
//
// `verified` (what the gate returned) is now REQUIRED, and the write only
// happens where the two reads agree.
// ═══════════════════════════════════════════════════════════════════════════

describe('syncBookCratePlacement — the freshness check', () => {
  const intoGreen2 = {
    'item_stock_levels.select': {
      data: [
        holding(BOOK_A, 'loc-green', { kind: 'crate', crate_color: 'green', crate_number: '2' }),
      ],
      error: null,
    },
    'rpc:inventory_set_book_storage': { data: 1, error: null },
  };

  it('a crate edited BETWEEN the two reads is left alone, not overwritten', async () => {
    // The gate cleared "Blue 4" (that is what the operator was shown and
    // agreed to). While the stock moved, someone re-crated the book to Red 7
    // from the item screen. Writing Green 2 now would destroy Red 7 on the
    // strength of an answer about Blue 4.
    const { svc, stub } = svcWith({
      'inventory_items.select': {
        data: [
          itemRow(BOOK_A, 'Persepolis', 'book', {
            book_crate_color: 'red',
            book_crate_number: '7',
          }),
        ],
        error: null,
      },
      ...intoGreen2,
    });

    const res = await svc.syncBookCratePlacement([BOOK_A], {
      verified: verified([[BOOK_A, BLUE_4]]),
    });

    expect(stub.rpcCalls.some((c) => c.name === 'inventory_set_book_storage')).toBe(false);
    expect(res.staleItemIds).toEqual([BOOK_A]);
    expect(res.syncedItemIds).toEqual([]);
    // Not a FAILURE — nothing broke. The stock moved and someone else's edit
    // stands; the caller has to say so either way.
    expect(res.failedItemIds).toEqual([]);
  });

  it('an unchanged row still writes — the check is staleness, not paranoia', async () => {
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
      ...intoGreen2,
    });

    const res = await svc.syncBookCratePlacement([BOOK_A], {
      verified: verified([[BOOK_A, BLUE_4]]),
    });
    expect(res.syncedItemIds).toEqual([BOOK_A]);
    expect(res.staleItemIds).toEqual([]);
    expect(stub.rpcCalls.find((c) => c.name === 'inventory_set_book_storage')!.args).toMatchObject({
      p_crate_color: 'green',
      p_crate_number: '2',
    });
  });

  it('a RESPELLING is not an edit — "BLUE"/" 4 " fingerprints as Blue 4', async () => {
    const { svc } = svcWith({
      'inventory_items.select': {
        data: [
          itemRow(BOOK_A, 'Persepolis', 'book', {
            book_crate_color: 'BLUE',
            book_crate_number: ' 4 ',
          }),
        ],
        error: null,
      },
      ...intoGreen2,
    });
    const res = await svc.syncBookCratePlacement([BOOK_A], {
      verified: verified([[BOOK_A, BLUE_4]]),
    });
    expect(res.syncedItemIds).toEqual([BOOK_A]);
    expect(res.staleItemIds).toEqual([]);
  });

  it('a concurrent edit that AGREES with the destination is not reported stale', async () => {
    // Someone else set the book to Green 2 — the very crate its stock now sits
    // in. Nothing is being overwritten, so crying "stale" would be a false
    // alarm on a write that changes nothing.
    const { svc } = svcWith({
      'inventory_items.select': {
        data: [
          itemRow(BOOK_A, 'Persepolis', 'book', {
            book_crate_color: 'green',
            book_crate_number: '2',
          }),
        ],
        error: null,
      },
      ...intoGreen2,
    });
    const res = await svc.syncBookCratePlacement([BOOK_A], {
      verified: verified([[BOOK_A, BLUE_4]]),
    });
    expect(res.syncedItemIds).toEqual([BOOK_A]);
    expect(res.staleItemIds).toEqual([]);
  });

  it('a book NOT in the gate-cleared set is never written over a recorded crate', async () => {
    // FAIL CLOSED. An id the gate never saw (it became a book after T0, or a
    // caller skipped the gate) has no acknowledgement behind it, so an
    // overwrite of a recorded crate is refused rather than assumed.
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
      ...intoGreen2,
    });
    const res = await svc.syncBookCratePlacement([BOOK_A], { verified: new Map() });
    expect(stub.rpcCalls.some((c) => c.name === 'inventory_set_book_storage')).toBe(false);
    expect(res.staleItemIds).toEqual([BOOK_A]);
  });

  it('an ungated FIRST assignment still writes — filling a blank destroys nothing', async () => {
    const { svc } = svcWith({
      'inventory_items.select': {
        data: [itemRow(BOOK_A, 'Persepolis', 'book', null)],
        error: null,
      },
      ...intoGreen2,
    });
    const res = await svc.syncBookCratePlacement([BOOK_A], { verified: new Map() });
    expect(res.syncedItemIds).toEqual([BOOK_A]);
    expect(res.staleItemIds).toEqual([]);
  });

  it('a book DELETED (or no longer a book) between the reads is reported, not silently OK', async () => {
    // The narrow case: readBookCrateSummaries filters on deleted_at IS NULL and
    // item_type = 'book', so the item simply vanishes from the second read.
    // bookIds went empty and the method returned an all-clear — a silent no-op
    // reported to the operator as a fully synchronized placement.
    const { svc, stub } = svcWith({
      'inventory_items.select': { data: [], error: null },
    });

    const res = await svc.syncBookCratePlacement([BOOK_A], {
      verified: verified([[BOOK_A, BLUE_4]]),
    });

    expect(res).toEqual({
      syncedItemIds: [],
      failedItemIds: [],
      skippedItemIds: [],
      staleItemIds: [BOOK_A],
      unplacedItemIds: [],
    });
    // No holdings read either — there was nothing left to reconcile.
    expect(stub.fromCalls).not.toContain('item_stock_levels');
  });

  it('a NON-BOOK vanishing from the second read is NOT stale — it never was a book', async () => {
    const { svc } = svcWith({ 'inventory_items.select': { data: [], error: null } });
    await expect(
      svc.syncBookCratePlacement([WIDGET], { verified: new Map() }),
    ).resolves.toEqual({
      syncedItemIds: [],
      failedItemIds: [],
      skippedItemIds: [],
      staleItemIds: [],
      unplacedItemIds: [],
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BULK "SET RACK" — the fourth write path
//
// `inventory_set_rack` (migration 0068) writes only the RACK keys, and this op
// then PHYSICALLY RELOCATES every selected item's stock onto that rack. A book
// recorded "Blue 4" carried on reading "Blue 4" while crate Blue 4 held zero of
// its units. This path carried no comment acknowledging that at all.
//
// It is deliberately NOT gated (the toolbar has no per-book confirmation
// channel for a 500-item all-or-nothing op, and refusing would break a shipped
// flow for the 114 books carrying book_crate_*) — so instead it reads the
// summaries BEFORE the move as its freshness proof, reconciles after, and
// reports how many labels changed. See the comment at the call site.
// ═══════════════════════════════════════════════════════════════════════════

describe('bulkUpdate set_rack — the crate summary follows the stock', () => {
  const RACK_28A = 'loc-rack-28a';

  function setRackStub(itemRows: Array<Record<string, unknown>>, holdings: unknown[]) {
    return svcWith({
      'inventory_items.select': { data: itemRows, error: null },
      'item_stock_levels.select': { data: holdings, error: null },
      // findOrCreateRackOrCrate resolves the existing rack 28-A.
      'locations.select': {
        data: [{ id: RACK_28A, name: '28-A', kind: 'rack' }],
        error: null,
      },
      'rpc:inventory_set_rack': { data: 1, error: null },
      'rpc:inventory_set_book_storage': { data: 1, error: null },
    });
  }

  it('CLEARS a crated book’s summary once its stock sits on the rack', async () => {
    const { svc, stub } = setRackStub(
      [
        {
          id: BOOK_A,
          name: 'Persepolis',
          item_type: 'book',
          warehouse_id: 'wh-1',
          bin_location: null,
          custom_fields: { book_crate_color: 'blue', book_crate_number: '4' },
        },
      ],
      [holding(BOOK_A, RACK_28A, { kind: 'rack', type: 'shelf' })],
    );

    const res = await svc.bulkUpdate({
      ids: [BOOK_A],
      op: { kind: 'set_rack', rackNumber: '28', rackRow: 'A' },
    });

    const call = stub.rpcCalls.find((c) => c.name === 'inventory_set_book_storage');
    expect(call, 'bulk Set rack never reconciled the crate summary at all').toBeDefined();
    expect(call!.args).toEqual({
      p_item_ids: [BOOK_A],
      p_crate_color: null,
      p_crate_number: null,
    });
    // …and it is REPORTED, so the toast can say a label changed.
    expect(res.crateCleared).toBe(1);
  });

  it('leaves a SPLIT book alone and says so', async () => {
    const { svc, stub } = setRackStub(
      [
        {
          id: BOOK_A,
          name: 'Persepolis',
          item_type: 'book',
          warehouse_id: 'wh-1',
          bin_location: null,
          custom_fields: { book_crate_color: 'blue', book_crate_number: '4' },
        },
      ],
      [
        holding(BOOK_A, RACK_28A, { kind: 'rack', type: 'shelf' }),
        // Also on a NULL-kind Site — a real second placement (migration 0292).
        holding(BOOK_A, 'loc-dc4', { kind: null, type: 'warehouse' }),
      ],
    );

    const res = await svc.bulkUpdate({
      ids: [BOOK_A],
      op: { kind: 'set_rack', rackNumber: '28', rackRow: 'A' },
    });

    expect(stub.rpcCalls.some((c) => c.name === 'inventory_set_book_storage')).toBe(false);
    expect(res.crateCleared).toBeUndefined();
    expect(res.crateUnchanged).toBe(1);
  });

  it('CLEARING the rack (no number) touches no crate summary', async () => {
    const { svc, stub } = setRackStub(
      [
        {
          id: BOOK_A,
          name: 'Persepolis',
          item_type: 'book',
          warehouse_id: 'wh-1',
          bin_location: '28-A',
          custom_fields: { book_crate_color: 'blue', book_crate_number: '4' },
        },
      ],
      [holding(BOOK_A, RACK_28A, { kind: 'rack', type: 'shelf' })],
    );

    await svc.bulkUpdate({ ids: [BOOK_A], op: { kind: 'set_rack', rackNumber: null, rackRow: null } });

    // Nothing was placed, so nothing about the crate changed.
    expect(stub.rpcCalls.some((c) => c.name === 'inventory_set_book_storage')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// REMOVE FROM RACK / CRATE — the write-off path
//
// removeStockFromLocation → adjustStock never touched `book_crate_*` at all.
// Draining crate Blue 4 of every copy of a title left that title reading
// "Blue 4" in the Books list, on printed labels, in the CSV and in Export
// Builder, with no flag of any kind — the picker walks to an empty crate. Same
// failure class as the placement paths; out of scope there only because a
// write-off shares none of their code.
//
// It reconciles ONLY when the draw-down empties the holding: a partial removal
// leaves the same set of locations holding the item, so the correct summary is
// unchanged by construction and a write then could only rewrite a label from
// state that predates the operation.
// ═══════════════════════════════════════════════════════════════════════════

describe('removeStockFromLocation — the crate summary follows the stock OUT', () => {
  const CRATE_BLUE_4 = 'loc-crate-blue4';
  const RACK_22B_ID = 'loc-rack-22b';

  const crateLoc = { kind: 'crate', type: 'bin', crate_color: 'blue', crate_number: '4' };
  const rackLoc = { kind: 'rack', type: 'shelf' };

  /**
   * A small stateful world, because this flow reads the SAME two tables on both
   * sides of the mutation and the whole point is that the two reads differ:
   *   • adjust_stock flips the holdings from `before` to `after`
   *   • inventory_set_book_storage writes the summary the next read returns
   * The set-storage fake takes its values from the call the stub just recorded
   * (rpcCalls is pushed before the result is resolved), so the "did the label
   * actually move" check is exercised against a real written value rather than
   * a hardcoded one.
   */
  function removeWorld(opts: {
    itemType?: string;
    crate?: { color: string | null; number: string | null };
    before: unknown[];
    after: unknown[];
  }) {
    let removed = false;
    let storage = opts.crate ?? { color: 'blue', number: '4' };
    let stub!: SupabaseStub;
    stub = makeSupabaseStub({
      'inventory_items.select': () => ({
        data: [
          {
            id: BOOK_A,
            name: 'Persepolis',
            item_type: opts.itemType ?? 'book',
            status: 'active',
            // No warehouse: this test is about the crate summary, not the
            // warehouse-access gate adjustStock applies on top of it.
            warehouse_id: null,
            quantity_on_hand: removed ? 0 : 5,
            reorder_point: 0,
            custom_fields: {
              book_crate_color: storage.color,
              book_crate_number: storage.number,
            },
          },
        ],
        error: null,
      }),
      // The pre-read takes .maybeSingle() → the FIRST row, whose quantity (5,
      // from `holding`) is what the draw-down is measured against.
      'item_stock_levels.select': () => ({ data: removed ? opts.after : opts.before, error: null }),
      'rpc:adjust_stock': () => {
        removed = true;
        return { data: { quantity_on_hand: 0, reorder_point: 0 }, error: null };
      },
      'rpc:inventory_set_book_storage': () => {
        const last = stub.rpcCalls[stub.rpcCalls.length - 1]!.args as {
          p_crate_color: string | null;
          p_crate_number: string | null;
        };
        storage = { color: last.p_crate_color, number: last.p_crate_number };
        return { data: 1, error: null };
      },
    });
    return { svc: new InventoryService(makeServiceContext(stub.client)), stub };
  }

  it('REPORTS the drained crate: nothing placed left, so the label is untouched and never silent', async () => {
    const { svc, stub } = removeWorld({
      before: [holding(BOOK_A, CRATE_BLUE_4, crateLoc)],
      after: [],
    });

    const res = await svc.removeStockFromLocation({
      itemId: BOOK_A,
      locationId: CRATE_BLUE_4,
      quantity: 5,
      reason: 'Water damage on the bottom row',
    });

    // The summary is NOT wiped — a book with no placed stock has no
    // authoritative location, and clearing it is data loss in a tidy-up
    // costume (see BookCrateSyncResult.unplacedItemIds).
    expect(stub.rpcCalls.some((c) => c.name === 'inventory_set_book_storage')).toBe(false);
    // …but the operator is TOLD, which is the whole fix. Before this, the
    // response carried no crate information at all.
    expect(res.crateSync).not.toBeNull();
    expect(res.crateSync!.unplacedItemIds).toEqual([BOOK_A]);
    expect(res.crateSyncUpdated).toBe(false);
  });

  it('FOLLOWS the stock: draining one of two holdings re-points the summary at the one left', async () => {
    const { svc, stub } = removeWorld({
      // Recorded Blue 4, and physically in Blue 4 + rack 22-B.
      before: [holding(BOOK_A, CRATE_BLUE_4, crateLoc), holding(BOOK_A, RACK_22B_ID, rackLoc)],
      // Blue 4 emptied; only the rack is left, and a rack CLEARS the crate.
      after: [holding(BOOK_A, RACK_22B_ID, rackLoc)],
    });

    const res = await svc.removeStockFromLocation({
      itemId: BOOK_A,
      locationId: CRATE_BLUE_4,
      quantity: 5,
      reason: 'Consolidated onto 22-B',
    });

    const call = stub.rpcCalls.find((c) => c.name === 'inventory_set_book_storage');
    expect(call, 'the write-off never reconciled the crate summary').toBeDefined();
    expect(call!.args).toEqual({
      p_item_ids: [BOOK_A],
      p_crate_color: null,
      p_crate_number: null,
    });
    expect(res.crateSync!.syncedItemIds).toEqual([BOOK_A]);
    // Blue 4 → no crate is a REAL change, so the operator is told.
    expect(res.crateSyncUpdated).toBe(true);
  });

  it('does NOT claim the label moved when the reconciliation rewrote the same crate', async () => {
    const { svc, stub } = removeWorld({
      // Recorded Blue 4, physically in Blue 4 + rack 22-B — and it is the RACK
      // being written off, so Blue 4 survives as the only placement.
      before: [holding(BOOK_A, RACK_22B_ID, rackLoc), holding(BOOK_A, CRATE_BLUE_4, crateLoc)],
      after: [holding(BOOK_A, CRATE_BLUE_4, crateLoc)],
    });

    const res = await svc.removeStockFromLocation({
      itemId: BOOK_A,
      locationId: RACK_22B_ID,
      quantity: 5,
      reason: 'Cleared 22-B',
    });

    // It still writes (the summary is derived; writing the value it already
    // holds is harmless)…
    expect(stub.rpcCalls.find((c) => c.name === 'inventory_set_book_storage')!.args).toEqual({
      p_item_ids: [BOOK_A],
      p_crate_color: 'blue',
      p_crate_number: '4',
    });
    // …but "your crate label changed" would be a lie, so it is not reported.
    expect(res.crateSyncUpdated).toBe(false);
  });

  it('leaves a still-SPLIT book alone and says so', async () => {
    const { svc, stub } = removeWorld({
      before: [
        holding(BOOK_A, CRATE_BLUE_4, crateLoc),
        holding(BOOK_A, RACK_22B_ID, rackLoc),
        // A NULL-kind Site holding — a real third placement (migration 0292),
        // and the row a `.in('locations.kind', …)` filter would silently drop.
        holding(BOOK_A, 'loc-dc4', { kind: null, type: 'warehouse' }),
      ],
      after: [holding(BOOK_A, RACK_22B_ID, rackLoc), holding(BOOK_A, 'loc-dc4', { kind: null, type: 'warehouse' })],
    });

    const res = await svc.removeStockFromLocation({
      itemId: BOOK_A,
      locationId: CRATE_BLUE_4,
      quantity: 5,
      reason: 'Damaged',
    });

    expect(stub.rpcCalls.some((c) => c.name === 'inventory_set_book_storage')).toBe(false);
    expect(res.crateSync!.skippedItemIds).toEqual([BOOK_A]);
    expect(res.crateSyncUpdated).toBe(false);
  });

  it('a PARTIAL draw-down reconciles nothing — the holdings set is unchanged', async () => {
    const { svc, stub } = removeWorld({
      before: [holding(BOOK_A, CRATE_BLUE_4, crateLoc)],
      after: [holding(BOOK_A, CRATE_BLUE_4, crateLoc)],
    });

    const res = await svc.removeStockFromLocation({
      itemId: BOOK_A,
      locationId: CRATE_BLUE_4,
      quantity: 2, // of 5
      reason: 'Two copies chewed by the dog',
    });

    expect(stub.rpcCalls.some((c) => c.name === 'inventory_set_book_storage')).toBe(false);
    // Not "reconciled and found nothing" — not attempted at all, so the common
    // path pays for none of this.
    expect(res.crateSync).toBeNull();
    expect(res.crateSyncUpdated).toBe(false);
  });

  it('a NON-BOOK write-off attempts no reconciliation', async () => {
    const { svc, stub } = removeWorld({
      itemType: 'asset',
      crate: { color: null, number: null },
      before: [holding(BOOK_A, RACK_22B_ID, rackLoc)],
      after: [],
    });

    const res = await svc.removeStockFromLocation({
      itemId: BOOK_A,
      locationId: RACK_22B_ID,
      quantity: 5,
      reason: 'Scrapped',
    });

    expect(stub.rpcCalls.some((c) => c.name === 'inventory_set_book_storage')).toBe(false);
    expect(res.crateSync).toBeNull();
  });
});
