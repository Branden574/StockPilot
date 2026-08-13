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
//
// "THE SUMMARY" IS BOTH PAIRS. book_rack_number / book_rack_row are derived from
// the SAME single location as book_crate_color / book_crate_number and written by
// the same statement (inventory_set_book_placement, migration 0336) — they are two
// projections of one fact, "which single location does this book's live stock
// resolve to". The four derived cases are pinned in their own describe block near
// the bottom of this file ("THE RACK PAIR IS DERIVED, TOO"); every reconciliation
// test in between therefore asserts the whole five-argument RPC, not a crate-only
// subset. Before this, the sync called inventory_set_book_storage (0334, crate
// keys only) and the rack pair was preserved unconditionally — right for a partial
// put-away, wrong for a full one, which left the pair naming a rack the stock had
// entirely left.
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

/**
 * A holding row as the reconciliation read sees it.
 *
 * `rack_number` / `rack_row` are the LOCATION's own position — a rack row carries
 * its own, a CRATE row carries the position it sits on, a Site carries neither.
 * Omitting them means "this location states no rack position", which is the shape
 * of every crate in production today.
 */
function holding(
  itemId: string,
  locationId: string,
  loc: {
    kind: string | null;
    type?: string | null;
    crate_color?: string | null;
    crate_number?: string | null;
    rack_number?: string | null;
    rack_row?: string | null;
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
      rack_number: loc.rack_number ?? null,
      rack_row: loc.rack_row ?? null,
    },
  };
}

/**
 * The five-argument RPC payload, spelled once. Every reconciliation write is
 * asserted against this so a crate-only expectation can never silently pass while
 * the rack half goes unpinned — the exact gap that let the pair be preserved
 * unconditionally. Defaults are the CLEARED pair, because a position-less crate
 * (every crate in production) clears it.
 */
function placementArgs(
  ids: string[],
  summary: {
    color?: string | null;
    number?: string | null;
    rackNumber?: string | null;
    rackRow?: string | null;
  },
) {
  return {
    p_item_ids: ids,
    p_crate_color: summary.color ?? null,
    p_crate_number: summary.number ?? null,
    p_rack_number: summary.rackNumber ?? null,
    p_rack_row: summary.rackRow ?? null,
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

  it('the refusal NAMES THE RACK on both sides — "gray BIN" is five bins', async () => {
    // A crate number does not locate a bin here: production has "gray BIN" on
    // FIVE racks and "yellow 5" on two. A sentence that stops at the crate
    // asks the operator to approve a move it has not fully described.
    //
    // The rack is LABEL context only: `changed` is still the crate comparison,
    // and the fingerprint is still the crate pair, so a shipped client's
    // acknowledgement keeps matching.
    const { svc } = svcWith({
      'inventory_items.select': {
        data: [
          itemRow(BOOK_A, 'Persepolis', 'book', {
            book_crate_color: 'gray',
            book_crate_number: 'BIN',
            book_rack_number: '43',
            book_rack_row: 'B',
          }),
        ],
        error: null,
      },
    });

    const thrown = await svc
      .assertBookCratePlacementAllowed([BOOK_A], {
        kind: 'crate',
        name: 'Blue #13 on rack 38-B',
        rackNumber: '38',
        rackRow: 'B',
        crateColor: 'blue',
        crateNumber: '13',
      })
      .then(() => null)
      .catch((e: unknown) => e);

    const err = thrown as ServiceError;
    expect(err.code).toBe('conflict');
    // REWRITTEN: the trailing rack sentence is new. This expectation used to end
    // at "on rack 38-B.", which named the rack on both sides but never said what
    // was HAPPENING to the pair — the operator had to infer it from two labels.
    // The destination is a POSITIONED crate, so the writer sets the pair to that
    // crate's own position, and the confirmation now says so outright.
    //
    // Note this sentence appears with NO holdings prediction available (this call
    // passes no `moves`/`toLocationId`). That asymmetry is deliberate and is
    // pinned below: a MOVE names the rack the destination itself states, which no
    // holdings read is needed to know, while a CLEAR is a claim about the absence
    // of stock elsewhere and may only be made on a prediction.
    expect(err.message).toBe(
      'Persepolis is recorded in Gray BIN on rack 43-B. Placing it here will change that to Blue 13 on rack 38-B. Rack will change from 43-B to 38-B.',
    );
    // UNCHANGED, and load-bearing: the rack rides on the payload as disclosure,
    // so the fingerprint is still the crate pair alone and every already-shipped
    // client's acknowledgement keeps matching.
    expect((err.details as { items: Array<{ currentFingerprint: string }> }).items[0]!
      .currentFingerprint).toBe(bookCrateFingerprint('gray', 'BIN'));
  });

  it('a rack-only move is NOT a crate conflict — the gate stays silent', async () => {
    // Same crate, different rack. Folding the rack into `changed` would
    // interrogate an operator every time a bin is re-shelved.
    const { svc } = svcWith({
      'inventory_items.select': {
        data: [
          itemRow(BOOK_A, 'Persepolis', 'book', {
            book_crate_color: 'gray',
            book_crate_number: 'BIN',
            book_rack_number: '43',
            book_rack_row: 'B',
          }),
        ],
        error: null,
      },
    });

    await expect(
      svc.assertBookCratePlacementAllowed([BOOK_A], {
        kind: 'crate',
        name: 'Gray #BIN on rack 41-C',
        rackNumber: '41',
        rackRow: 'C',
        crateColor: 'gray',
        crateNumber: 'BIN',
      }),
    ).resolves.toBeInstanceOf(Map);
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
      'rpc:inventory_set_book_placement': { data: 1, error: null },
    });

    const res = await svc.syncBookCratePlacement([BOOK_A], {
      verified: verified([[BOOK_A, BLUE_4]]),
    });

    expect(res.failedItemIds).toEqual([]);
    expect(res.syncedItemIds).toEqual([BOOK_A]);
    const call = stub.rpcCalls.find((c) => c.name === 'inventory_set_book_placement')!;
    // Green #2 states no rack position, and this book's every copy is now inside
    // it — so the rack pair CLEARS in the same statement. See the derived-cases
    // block below for why that is the whole point.
    expect(call.args).toEqual(placementArgs([BOOK_A], { color: 'green', number: '2' }));
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
      'rpc:inventory_set_book_placement': { data: 1, error: null },
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
    expect(stub.rpcCalls.some((c) => c.name === 'inventory_set_book_placement')).toBe(false);
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
      'rpc:inventory_set_book_placement': { data: 1, error: null },
    });

    await svc.syncBookCratePlacement([BOOK_A], {
      verified: verified([[BOOK_A, { crateNumber: '4' }]]),
    });
    expect(stub.rpcCalls.some((c) => c.name === 'inventory_set_book_placement')).toBe(false);
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
      'rpc:inventory_set_book_placement': { data: 1, error: null },
    });

    await svc.syncBookCratePlacement([BOOK_A], { verified: verified([[BOOK_A, NO_CRATE]]) });
    const call = stub.rpcCalls.find((c) => c.name === 'inventory_set_book_placement')!;
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
    expect(stub.rpcCalls.some((c) => c.name === 'inventory_set_book_placement')).toBe(false);
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
    expect(stub.rpcCalls.some((c) => c.name === 'inventory_set_book_placement')).toBe(false);
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
      'rpc:inventory_set_book_placement': { data: 1, error: null },
    });

    const res = await svc.syncBookCratePlacement([BOOK_A, BOOK_B], {
      verified: verified([
        [BOOK_A, BLUE_4],
        [BOOK_B, NO_CRATE],
      ]),
    });

    expect(res.unplacedItemIds).toEqual([BOOK_A]);
    expect(res.syncedItemIds).toEqual([BOOK_B]);
    const call = stub.rpcCalls.find((c) => c.name === 'inventory_set_book_placement')!;
    // ...and only BOOK_B is in the write.
    expect(call.args).toEqual(placementArgs([BOOK_B], { color: 'green', number: '2' }));
  });

  it('a RACK-only destination CLEARS the crate and RECORDS that rack', async () => {
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
        data: [holding(BOOK_A, 'loc-rack', { kind: 'rack', rack_number: '22', rack_row: 'B' })],
        error: null,
      },
      'rpc:inventory_set_book_placement': { data: 1, error: null },
    });

    await svc.syncBookCratePlacement([BOOK_A], { verified: verified([[BOOK_A, BLUE_4]]) });

    const call = stub.rpcCalls.find((c) => c.name === 'inventory_set_book_placement')!;
    // A book on a rack is in no crate — a stale "Blue 4" walks a picker to a
    // bin that holds none of it. And the rack it IS on is recorded, from the
    // same location row, in the same statement: the pair is not left to whatever
    // a previous placement happened to write.
    expect(call.args).toEqual(placementArgs([BOOK_A], { rackNumber: '22', rackRow: 'B' }));
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
    expect(stub.rpcCalls.some((c) => c.name === 'inventory_set_book_placement')).toBe(false);
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
      'rpc:inventory_set_book_placement': { data: 1, error: null },
    });

    await svc.syncBookCratePlacement([BOOK_A, BOOK_B], {
      verified: verified([
        [BOOK_A, NO_CRATE],
        [BOOK_B, NO_CRATE],
      ]),
    });

    const calls = stub.rpcCalls.filter((c) => c.name === 'inventory_set_book_placement');
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.args)).toEqual([
      // 'Blue' canonicalises to the registry slug on the way onto the item
      // summary; 'Blue Shelf' is not a registry color, so it keeps the only
      // spelling anyone has of it. Neither batch merges into the other.
      placementArgs([BOOK_A], { color: 'blue', number: 'Shelf 2' }),
      placementArgs([BOOK_B], { color: 'Blue Shelf', number: '2' }),
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
      'rpc:inventory_set_book_placement': { data: 2, error: null },
    });

    await svc.syncBookCratePlacement([BOOK_A, BOOK_B], {
      verified: verified([
        [BOOK_A, NO_CRATE],
        [BOOK_B, NO_CRATE],
      ]),
    });

    const calls = stub.rpcCalls.filter((c) => c.name === 'inventory_set_book_placement');
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
      'rpc:inventory_set_book_placement': { data: null, error: { message: 'boom' } },
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
      'rpc:inventory_set_book_placement': { data: 0, error: null },
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

  // REWRITTEN, deliberately: this test used to pin `before`/`after` as the CRATE
  // PAIR ONLY, which was complete when the sync wrote only the crate pair. It now
  // writes all four keys in one statement, so a two-key trail would show the
  // crate moving and stay SILENT about a rack pair the same statement cleared —
  // and "who cleared 38-A, and when" is precisely the question this trail is read
  // to answer. The fixture is the full-move-into-a-position-less-crate case for
  // the same reason: it is the case where the pair changes.
  it('audits the WHOLE summary on the EXISTING inventory.item.updated event', async () => {
    const { svc } = svcWith({
      'inventory_items.select': {
        data: [
          itemRow(BOOK_A, 'Persepolis', 'book', {
            book_crate_color: 'blue',
            book_crate_number: '4',
            book_rack_number: '38',
            book_rack_row: 'A',
          }),
        ],
        error: null,
      },
      'item_stock_levels.select': {
        data: [holding(BOOK_A, 'loc-green', { kind: 'crate', crate_color: 'green', crate_number: '2' })],
        error: null,
      },
      'rpc:inventory_set_book_placement': { data: 1, error: null },
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
    expect(payload.before).toEqual({
      book_crate_color: 'blue',
      book_crate_number: '4',
      book_rack_number: '38',
      book_rack_row: 'A',
    });
    // The clear is IN the trail, not implied by its absence.
    expect(payload.after).toEqual({
      book_crate_color: 'green',
      book_crate_number: '2',
      book_rack_number: null,
      book_rack_row: null,
    });
    expect(payload.extra).toMatchObject({
      placement: 'book_crate',
      to_location_id: 'loc-green',
      quantity: 12,
      changed_keys: [
        'book_crate_color',
        'book_crate_number',
        'book_rack_number',
        'book_rack_row',
      ],
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
    'rpc:inventory_set_book_placement': { data: 1, error: null },
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

    expect(stub.rpcCalls.some((c) => c.name === 'inventory_set_book_placement')).toBe(false);
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
    expect(stub.rpcCalls.find((c) => c.name === 'inventory_set_book_placement')!.args).toMatchObject({
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
    expect(stub.rpcCalls.some((c) => c.name === 'inventory_set_book_placement')).toBe(false);
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
// THE RACK PAIR IS DERIVED, TOO — the four cases, at the seam that decides them
//
// The item's book_rack_number / book_rack_row are not an independent fact; they
// are the other projection of the fact the reconciliation already establishes —
// WHICH SINGLE LOCATION the book's live stock resolves to. Two rules preceded
// this, each an UNCONDITIONAL answer to a conditional question:
//
//   main CLEARED the pair on every put-away into a position-less crate
//   (inventory_set_rack deletes it when both rack arguments are null, 0068):
//   right for a FULL move, wrong for a PARTIAL one, which erased a rack the
//   remaining copies really were on.
//
//   Migration 0335 then PRESERVED it always: right for the partial move, wrong
//   for the full one — the pair went on naming a rack the stock had entirely
//   left, and nine surfaces reprinted it, including the pick slip and the
//   warehouse packing slip a picker physically carries and the mobile scan sheet,
//   which printed "Bin/shelf: Blue Shelf" directly above "Rack: 38-A".
//
// These tests drive the REAL service through all four outcomes. Each asserts the
// FULL five-argument RPC payload (or that no RPC happened at all), because a
// crate-only assertion is exactly what let the rack half go unpinned in both
// directions.
// ═══════════════════════════════════════════════════════════════════════════

describe('syncBookCratePlacement — the rack pair follows the holdings', () => {
  /** A book recorded in Blue 4 on rack 38-A: the production shape at issue. */
  const ON_38A = {
    book_crate_color: 'blue',
    book_crate_number: '4',
    book_rack_number: '38',
    book_rack_row: 'A',
  };

  function world(holdings: unknown[], rpc: { data: unknown } = { data: 1 }) {
    return svcWith({
      'inventory_items.select': {
        data: [itemRow(BOOK_A, 'Persepolis', 'book', ON_38A)],
        error: null,
      },
      'item_stock_levels.select': { data: holdings, error: null },
      'rpc:inventory_set_book_placement': { data: rpc.data, error: null },
    });
  }

  // ── CASE 1 — all stock in a POSITION-LESS crate: the pair CLEARS ──────────
  it('a FULL move into a POSITION-LESS crate CLEARS the rack pair', async () => {
    // Every crate in production today is position-less. The book's every copy is
    // now inside Gray #BIN, so it is on NO rack, and 38-A is no longer a fact
    // about it — keeping it is how the pick slip came to send a picker to 38-A
    // for a book that is entirely in a crate.
    const { svc, stub } = world([
      holding(BOOK_A, 'loc-gray', { kind: 'crate', crate_color: 'gray', crate_number: 'BIN' }),
    ]);

    const res = await svc.syncBookCratePlacement([BOOK_A], {
      verified: verified([[BOOK_A, BLUE_4]]),
    });

    expect(stub.rpcCalls.find((c) => c.name === 'inventory_set_book_placement')!.args).toEqual(
      placementArgs([BOOK_A], { color: 'gray', number: 'BIN' }),
    );
    // AND THE OPERATOR IS NOT TOLD SOMETHING FALSE. This is reported as SYNCED —
    // not skipped, which would claim the summary was deliberately left describing
    // another location, and not unplaced, which would claim there was nothing to
    // synchronize to.
    expect(res.syncedItemIds).toEqual([BOOK_A]);
    expect(res.skippedItemIds).toEqual([]);
    expect(res.unplacedItemIds).toEqual([]);
    expect(res.failedItemIds).toEqual([]);
    expect(res.staleItemIds).toEqual([]);
  });

  it('and the gate SAID SO before the stock moved — the refusal names the rack it loses', async () => {
    // ═══ THE OWNER'S WALK, AT THE SURFACE HE READ ═══
    //
    // REWRITTEN: this expectation used to stop at "…will change that to Gray
    // BIN." and the test claimed, in its own title, to name "the rack it loses"
    // — but all it named was 40-B inside the CURRENT label. It never said the
    // pair was being erased. That was the defect: the owner placed a book from
    // staging into position-less "Blue #Shelf", approved a crate change, and
    // lost the rack 38-A he had typed by hand, silently.
    //
    // The old silence had a reason and the reason went stale. It was true when
    // the writer left the rack keys alone; since the holdings-derivation and
    // migration 0336 the writer DOES clear the pair on a full move into a
    // position-less crate — which is exactly the case fixtured here, and is
    // asserted three tests above as `p_rack_number: null`.
    //
    // The claim is only safe because of what this call passes: `toLocationId`
    // plus a per-item `moves` entry, and a holdings fixture whose only row is
    // the source. That is what makes `bookCratePlacementWillSync` answer TRUE,
    // and only an explicit true earns the sentence.
    const { svc } = svcWith({
      'inventory_items.select': {
        data: [
          itemRow(BOOK_A, 'Persepolis', 'book', {
            book_crate_color: 'blue',
            book_crate_number: '4',
            book_rack_number: '40',
            book_rack_row: 'B',
          }),
        ],
        error: null,
      },
      // The book's ONLY holding is the source, so this placement leaves the
      // destination as its only placement: the sync will write.
      'item_stock_levels.select': {
        data: [holding(BOOK_A, 'loc-40b', { kind: 'rack', rack_number: '40', rack_row: 'B' })],
        error: null,
      },
    });

    const thrown = await svc
      .assertBookCratePlacementAllowed(
        [BOOK_A],
        {
          kind: 'crate',
          name: 'Gray #BIN',
          rackNumber: null,
          rackRow: null,
          crateColor: 'gray',
          crateNumber: 'BIN',
        },
        { toLocationId: 'loc-gray', moves: new Map([[BOOK_A, { fromLocationId: 'loc-40b', quantity: 5 }]]) },
      )
      .then(() => null)
      .catch((e: unknown) => e);

    expect((thrown as ServiceError).code).toBe('conflict');
    expect((thrown as ServiceError).message).toBe(
      'Persepolis is recorded in Blue 4 on rack 40-B. Placing it here will change that to Gray BIN. Rack 40-B will be cleared.',
    );
    // And on the structured payload, per book, for the surfaces that render
    // lines rather than the message — while the fingerprint stays crate-only.
    const detail = (thrown as ServiceError).details as {
      items: Array<{ rackLine?: string | null; currentFingerprint: string }>;
    };
    expect(detail.items[0]!.rackLine).toBe('Rack 40-B will be cleared.');
    expect(detail.items[0]!.currentFingerprint).toBe(bookCrateFingerprint('blue', '4'));
  });

  it('NEVER promises a clear it cannot support: no prediction, no rack sentence', async () => {
    // The same book and the same position-less destination as above, but the
    // caller supplies no `moves`/`toLocationId`, so `readBookCrateSyncPrediction`
    // returns nothing for this item. The gate still ASKS — absent is fail-closed
    // for asking — but it must not convert "we could not tell" into "38-A will
    // be cleared". Whether the pair clears depends on stock this call never read.
    const { svc } = svcWith({
      'inventory_items.select': {
        data: [
          itemRow(BOOK_A, 'Persepolis', 'book', {
            book_crate_color: 'blue',
            book_crate_number: '4',
            book_rack_number: '40',
            book_rack_row: 'B',
          }),
        ],
        error: null,
      },
    });

    const thrown = await svc
      .assertBookCratePlacementAllowed([BOOK_A], {
        kind: 'crate',
        name: 'Gray #BIN',
        rackNumber: null,
        rackRow: null,
        crateColor: 'gray',
        crateNumber: 'BIN',
      })
      .then(() => null)
      .catch((e: unknown) => e);

    expect((thrown as ServiceError).code).toBe('conflict');
    expect((thrown as ServiceError).message).toBe(
      'Persepolis is recorded in Blue 4 on rack 40-B. Placing it here will change that to Gray BIN.',
    );
    const detail = (thrown as ServiceError).details as { items: Array<{ rackLine?: string | null }> };
    expect(detail.items[0]!.rackLine ?? null).toBeNull();
  });

  it('a SPLIT that still conflicts says nothing about the rack', async () => {
    // The book keeps a rival placement (rack 41-C survives this move), so the
    // reconciliation will SKIP its summary entirely — neither pair is written.
    // The conflict itself is dropped by step 2 in that case, so the way to
    // observe the rule is a batch: BOOK_B resolves and speaks, BOOK_A splits and
    // is not asked about at all.
    const { svc } = svcWith({
      'inventory_items.select': {
        data: [
          itemRow(BOOK_A, 'Persepolis', 'book', {
            book_crate_color: 'blue',
            book_crate_number: '4',
            book_rack_number: '40',
            book_rack_row: 'B',
          }),
          itemRow(BOOK_B, 'Maus I', 'book', {
            book_crate_color: 'red',
            book_crate_number: '7',
            book_rack_number: '38',
            book_rack_row: 'A',
          }),
        ],
        error: null,
      },
      'item_stock_levels.select': {
        data: [
          holding(BOOK_A, 'loc-40b', { kind: 'rack', rack_number: '40', rack_row: 'B' }),
          // The rival placement that makes BOOK_A a split.
          holding(BOOK_A, 'loc-41c', { kind: 'rack', rack_number: '41', rack_row: 'C' }),
          holding(BOOK_B, 'loc-38a', { kind: 'rack', rack_number: '38', rack_row: 'A' }),
        ],
        error: null,
      },
    });

    const thrown = await svc
      .assertBookCratePlacementAllowed(
        [BOOK_A, BOOK_B],
        {
          kind: 'crate',
          name: 'Gray #BIN',
          rackNumber: null,
          rackRow: null,
          crateColor: 'gray',
          crateNumber: 'BIN',
        },
        {
          toLocationId: 'loc-gray',
          moves: new Map([
            [BOOK_A, { fromLocationId: 'loc-40b', quantity: 5 }],
            [BOOK_B, { fromLocationId: 'loc-38a', quantity: 5 }],
          ]),
        },
      )
      .then(() => null)
      .catch((e: unknown) => e);

    const detail = (thrown as ServiceError).details as {
      items: Array<{ itemId: string; rackLine?: string | null }>;
    };
    // BOOK_A is not asked about at all — its summary provably will not be
    // written, so neither its crate nor its rack is at risk.
    expect(detail.items.map((i) => i.itemId)).toEqual([BOOK_B]);
    expect(detail.items[0]!.rackLine).toBe('Rack 38-A will be cleared.');
  });

  // ── CASE 2 — all stock in a POSITIONED crate: the pair IS that position ───
  it('a FULL move into a POSITIONED crate makes the pair the CRATE’s position', async () => {
    // A crate SITS ON a rack: one physical place, two item keys. Clearing the
    // pair here would publish "in Gray BIN, on no rack" about a crate that is
    // demonstrably on 43-B — and "gray BIN" alone names five different bins in
    // this warehouse.
    const { svc, stub } = world([
      holding(BOOK_A, 'loc-gray', {
        kind: 'crate',
        crate_color: 'gray',
        crate_number: 'BIN',
        rack_number: '43',
        rack_row: 'B',
      }),
    ]);

    const res = await svc.syncBookCratePlacement([BOOK_A], {
      verified: verified([[BOOK_A, BLUE_4]]),
    });

    expect(stub.rpcCalls.find((c) => c.name === 'inventory_set_book_placement')!.args).toEqual(
      placementArgs([BOOK_A], {
        color: 'gray',
        number: 'BIN',
        rackNumber: '43',
        rackRow: 'B',
      }),
    );
    expect(res.syncedItemIds).toEqual([BOOK_A]);
  });

  // ── CASE 3 — all stock on a plain RACK: the pair is that rack ─────────────
  it('a FULL move onto a plain RACK records that rack and clears the crate', async () => {
    const { svc, stub } = world([
      holding(BOOK_A, 'loc-22b', { kind: 'rack', rack_number: '22', rack_row: 'b' }),
    ]);

    const res = await svc.syncBookCratePlacement([BOOK_A], {
      verified: verified([[BOOK_A, BLUE_4]]),
    });

    // The row is UPPER-CASED, exactly as stampPlacementBin upper-cases it. Both
    // writers must produce the same item-side value for the same location, or the
    // books rack filter — which matches number AND row with an exact eq — sees two
    // spellings of one rack and one of them finds nothing.
    expect(stub.rpcCalls.find((c) => c.name === 'inventory_set_book_placement')!.args).toEqual(
      placementArgs([BOOK_A], { rackNumber: '22', rackRow: 'B' }),
    );
    expect(res.syncedItemIds).toEqual([BOOK_A]);
  });

  it('DECOMPOSES a legacy composite rack number off the location row', async () => {
    // Incident 2026-07-23: a rack created as ("22-B", null). Copying that pair
    // verbatim onto the item makes it invisible to its own rack filter, which
    // requires number="22" AND row="B". Every writer of these keys decomposes
    // through the shared parser, and this derivation is now one of them.
    const { svc, stub } = world([
      holding(BOOK_A, 'loc-legacy', { kind: 'rack', rack_number: '22-B', rack_row: null }),
    ]);

    await svc.syncBookCratePlacement([BOOK_A], { verified: verified([[BOOK_A, BLUE_4]]) });

    expect(stub.rpcCalls.find((c) => c.name === 'inventory_set_book_placement')!.args).toEqual(
      placementArgs([BOOK_A], { rackNumber: '22', rackRow: 'B' }),
    );
  });

  // ── CASE 4 — SPLIT: the pair is PRESERVED, and the operator is TOLD ───────
  it('a PARTIAL move leaves the rack pair ALONE and reports the skip', async () => {
    // Half the copies moved into Gray #BIN; the rest are still on 38-A. Clearing
    // the pair here would erase a true fact — this is the case 0335 was right
    // about — and stamping the crate would assert something false about the half
    // that stayed. So NOTHING is written…
    const { svc, stub } = world([
      holding(BOOK_A, 'loc-gray', { kind: 'crate', crate_color: 'gray', crate_number: 'BIN' }),
      holding(BOOK_A, 'loc-38a', { kind: 'rack', rack_number: '38', rack_row: 'A' }),
    ]);

    const res = await svc.syncBookCratePlacement([BOOK_A], {
      verified: verified([[BOOK_A, BLUE_4]]),
    });

    expect(stub.rpcCalls.some((c) => c.name === 'inventory_set_book_placement')).toBe(false);
    // …and the skip is REPORTED through the existing vocabulary, so the caller
    // can say the label was deliberately left alone instead of showing a plain
    // success toast for a sync that changed nothing. For this org the split is
    // the COMMON outcome (405 units sit on Site DC4 per migration 0292).
    expect(res.skippedItemIds).toEqual([BOOK_A]);
    expect(res.syncedItemIds).toEqual([]);
    expect(res.failedItemIds).toEqual([]);
    expect(res.unplacedItemIds).toEqual([]);
  });

  it('a NULL-kind SITE holding is a REAL placement — it clears both pairs, and is never dropped', async () => {
    // Recurring pattern #23. `.in('locations.kind', [...])` is never true for a
    // NULL column, so a kind filter in the holdings read would drop this row —
    // the bug migration 0292 fixed for the placed draw-down, in this exact area.
    // Dropped, this book would look UNPLACED and keep naming Blue 4 on 38-A.
    // Kept, it is the single placement: on no rack and in no crate.
    const { svc, stub } = world([holding(BOOK_A, 'loc-dc4', { kind: null, type: 'warehouse' })]);

    const res = await svc.syncBookCratePlacement([BOOK_A], {
      verified: verified([[BOOK_A, BLUE_4]]),
    });

    expect(stub.rpcCalls.find((c) => c.name === 'inventory_set_book_placement')!.args).toEqual(
      placementArgs([BOOK_A], {}),
    );
    expect(res.syncedItemIds).toEqual([BOOK_A]);
    expect(res.unplacedItemIds).toEqual([]);
  });

  it('two books in the SAME crate on DIFFERENT racks are two batches, never one', async () => {
    // The batching key carries all four values because one statement writes all
    // four. Keying on the crate alone would put both books in one call and stamp
    // the first book's rack onto the second — a silent wrong rack on a picker's
    // slip, which is the whole failure class this module exists to prevent.
    const { svc, stub } = svcWith({
      'inventory_items.select': {
        data: [
          itemRow(BOOK_A, 'Persepolis', 'book', ON_38A),
          itemRow(BOOK_B, 'Maus I', 'book', ON_38A),
        ],
        error: null,
      },
      'item_stock_levels.select': {
        data: [
          holding(BOOK_A, 'loc-gray-43b', {
            kind: 'crate',
            crate_color: 'gray',
            crate_number: 'BIN',
            rack_number: '43',
            rack_row: 'B',
          }),
          holding(BOOK_B, 'loc-gray-41c', {
            kind: 'crate',
            crate_color: 'gray',
            crate_number: 'BIN',
            rack_number: '41',
            rack_row: 'C',
          }),
        ],
        error: null,
      },
      'rpc:inventory_set_book_placement': { data: 1, error: null },
    });

    await svc.syncBookCratePlacement([BOOK_A, BOOK_B], {
      verified: verified([
        [BOOK_A, BLUE_4],
        [BOOK_B, BLUE_4],
      ]),
    });

    const calls = stub.rpcCalls.filter((c) => c.name === 'inventory_set_book_placement');
    expect(calls.map((c) => c.args)).toEqual([
      placementArgs([BOOK_A], {
        color: 'gray',
        number: 'BIN',
        rackNumber: '43',
        rackRow: 'B',
      }),
      placementArgs([BOOK_B], {
        color: 'gray',
        number: 'BIN',
        rackNumber: '41',
        rackRow: 'C',
      }),
    ]);
  });

  it('a stale crate skips BOTH halves — the pair never rides in behind a refused write', async () => {
    // Someone re-crated the book to Red 7 between the gate and the write, so the
    // acknowledgement we hold is not an answer to this question. The crate is left
    // alone — and because both pairs travel in ONE statement, the rack pair is
    // left alone with it rather than being written on the strength of an
    // acknowledgement that named a different crate.
    const { svc, stub } = svcWith({
      'inventory_items.select': {
        data: [
          itemRow(BOOK_A, 'Persepolis', 'book', {
            book_crate_color: 'red',
            book_crate_number: '7',
            book_rack_number: '38',
            book_rack_row: 'A',
          }),
        ],
        error: null,
      },
      'item_stock_levels.select': {
        data: [
          holding(BOOK_A, 'loc-gray', { kind: 'crate', crate_color: 'gray', crate_number: 'BIN' }),
        ],
        error: null,
      },
      'rpc:inventory_set_book_placement': { data: 1, error: null },
    });

    const res = await svc.syncBookCratePlacement([BOOK_A], {
      verified: verified([[BOOK_A, BLUE_4]]),
    });

    expect(stub.rpcCalls.some((c) => c.name === 'inventory_set_book_placement')).toBe(false);
    expect(res.staleItemIds).toEqual([BOOK_A]);
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

  /**
   * A small stateful world, for the same reason `removeWorld` below is one: the
   * crate COUNTS are proved by re-reading the row after the sync wrote it, so a
   * fixture that returns its opening value forever cannot tell a real clear
   * from a rewrite of the crate the book already named. The set-storage fake
   * takes its values from the call the stub just recorded (rpcCalls is pushed
   * before the result resolves), so reads after the write see what was actually
   * written rather than anything this fixture decided in advance.
   */
  function setRackStub(
    itemRows: Array<Record<string, unknown>>,
    holdings: unknown[],
    extra: Record<string, { data: unknown; error: { message: string } | null }> = {},
  ) {
    const written = new Map<string, { color: string | null; number: string | null }>();
    let stub!: SupabaseStub;
    stub = makeSupabaseStub({
      'inventory_items.select': () => ({
        data: itemRows.map((r) => {
          const w = written.get(r.id as string);
          if (!w) return r;
          return {
            ...r,
            custom_fields: {
              ...((r.custom_fields as Record<string, unknown> | null) ?? {}),
              book_crate_color: w.color,
              book_crate_number: w.number,
            },
          };
        }),
        error: null,
      }),
      'item_stock_levels.select': { data: holdings, error: null },
      // findOrCreateRackOrCrate resolves the existing rack 28-A.
      'locations.select': {
        data: [{ id: RACK_28A, name: '28-A', kind: 'rack' }],
        error: null,
      },
      'rpc:inventory_set_rack': { data: 1, error: null },
      'rpc:inventory_set_book_placement': () => {
        const last = stub.rpcCalls[stub.rpcCalls.length - 1]!.args as {
          p_item_ids: string[];
          p_crate_color: string | null;
          p_crate_number: string | null;
        };
        for (const id of last.p_item_ids) {
          written.set(id, { color: last.p_crate_color, number: last.p_crate_number });
        }
        // The real RPC returns its row count, and the sync FAILS the batch on
        // anything short of it.
        return { data: last.p_item_ids.length, error: null };
      },
      ...extra,
    });
    return { svc: new InventoryService(makeServiceContext(stub.client)), stub };
  }

  /** A book row as bulkUpdate's several reads see it. */
  function bookRow(crate: { color: string | null; number: string | null }) {
    return {
      id: BOOK_A,
      name: 'Persepolis',
      item_type: 'book',
      warehouse_id: 'wh-1',
      bin_location: null,
      custom_fields: { book_crate_color: crate.color, book_crate_number: crate.number },
    };
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
      [holding(BOOK_A, RACK_28A, { kind: 'rack', type: 'shelf', rack_number: '28', rack_row: 'A' })],
    );

    const res = await svc.bulkUpdate({
      ids: [BOOK_A],
      op: { kind: 'set_rack', rackNumber: '28', rackRow: 'A' },
    });

    const call = stub.rpcCalls.find((c) => c.name === 'inventory_set_book_placement');
    expect(call, 'bulk Set rack never reconciled the crate summary at all').toBeDefined();
    // THE TWO WRITERS AGREE. `inventory_set_rack` already stamped 28-A from the
    // typed destination; the reconciliation derives the pair from where the stock
    // now IS and arrives at the same 28-A. That agreement is the point — if the
    // derivation disagreed with the destination writer on the common path, one of
    // the two would be overwriting the other on every bulk place.
    expect(call!.args).toEqual(placementArgs([BOOK_A], { rackNumber: '28', rackRow: 'A' }));
    // …and it is REPORTED, so the toast can say a label changed.
    expect(res.crateCleared).toBe(1);
    // The stock reached the rack, so there is nothing to warn about. This is
    // the count that separates "everything moved" from "nothing moved" —
    // `placed` alone reads 0 for both "already there" and "all refused".
    expect(res.placeFailed).toBeUndefined();
  });

  // ═══ THE OPERATOR TYPED THE RACK, AND THE APP MAY NOT UN-TYPE IT ═════════
  //
  // TESTS REWRITTEN, WITH THE REASON. The two cases below used to assert
  // `p_rack_number: null` — that the holdings-derivation CLEARS the pair on the
  // swallowed-placement-failure path. That expectation pinned the defect, so it
  // is replaced rather than weakened: what is asserted here is strictly more
  // than before (the same crate half, plus the rack half, plus the new
  // `placeFailed` report), and the crate-side counts they were written for are
  // untouched.
  //
  // THE DEFECT. `inventory_set_rack` writes {28, A, bin_location '28-A'} — the
  // operator's typed intent. `placeItemsOntoRackByName` is per-holding
  // best-effort, so a refused transfer left the book in position-less crate
  // Blue 4; the derivation then read THAT holding and wrote
  // {p_rack_number: null, p_rack_row: null}, reverting the pair the same
  // operation had just written. The book dropped straight out of the "28-A"
  // filter the operator had just set, `bin_location` still read "28-A" — the
  // "labelled 28-A, on no rack" row migration 0336's header exists to make
  // unreachable — and the toast said "Updated 1".
  //
  // THE RULE. The derivation is authoritative about the CRATE, which nobody
  // typed; the rack pair on this path is a direct human instruction and stands.
  // What is wrong is not the label, it is the world — so the failure to place
  // is REPORTED (`placeFailed`) instead of being expressed as a silent revert.

  it('does NOT count a clear when the sync rewrote the crate the book already named', async () => {
    const { svc, stub } = setRackStub(
      [bookRow({ color: 'blue', number: '4' })],
      [holding(BOOK_A, 'loc-crate-blue4', { kind: 'crate', type: 'bin', crate_color: 'blue', crate_number: '4' })],
      // The one thing that has to go wrong for this to be reachable: the
      // physical move onto rack 28-A fails, so Blue 4 is still the only
      // holding when the reconciliation reads it back.
      { 'rpc:transfer_stock': { data: null, error: { message: 'permission denied' } } },
    );

    const res = await svc.bulkUpdate({
      ids: [BOOK_A],
      op: { kind: 'set_rack', rackNumber: '28', rackRow: 'A' },
    });

    // It DID write — the summary is derived, and writing the value it already
    // holds is harmless. The CRATE half comes off the holding (Blue 4, where the
    // stock actually is); the RACK half is the pair the operator typed and
    // `inventory_set_rack` already wrote, carried through unchanged so the two
    // writers agree and the row cannot end up labelled "28-A" on no rack.
    expect(stub.rpcCalls.find((c) => c.name === 'inventory_set_book_placement')!.args).toEqual(
      placementArgs([BOOK_A], { color: 'blue', number: '4', rackNumber: '28', rackRow: 'A' }),
    );
    // …but nothing was cleared. The truthful line is the warning one: the label
    // is exactly what it was.
    expect(res.crateCleared).toBeUndefined();
    expect(res.crateChanged).toBeUndefined();
    expect(res.crateUnchanged).toBe(1);
    // AND the operator hears the thing that actually went wrong. Without this
    // the whole event is invisible: `placed` is 0, which is also what a batch
    // already sitting on the rack returns.
    expect(res.placeFailed).toBe(1);
    expect(res.placed).toBe(0);
  });

  it('reports a label rewritten to a DIFFERENT crate as changed — not cleared, not unchanged', async () => {
    const { svc, stub } = setRackStub(
      // Recorded Blue 4 (a human typed it), physically in Red 7.
      [bookRow({ color: 'blue', number: '4' })],
      [holding(BOOK_A, 'loc-crate-red7', { kind: 'crate', type: 'bin', crate_color: 'red', crate_number: '7' })],
      { 'rpc:transfer_stock': { data: null, error: { message: 'permission denied' } } },
    );

    const res = await svc.bulkUpdate({
      ids: [BOOK_A],
      op: { kind: 'set_rack', rackNumber: '28', rackRow: 'A' },
    });

    expect(stub.rpcCalls.find((c) => c.name === 'inventory_set_book_placement')!.args).toEqual(
      placementArgs([BOOK_A], { color: 'red', number: '7', rackNumber: '28', rackRow: 'A' }),
    );
    // "Cleared" would be false (the label names a crate), "unchanged" would be
    // false (Blue 4 is gone), and silence would be the worst of the three — the
    // operator typed a rack number and a value a human recorded was replaced.
    expect(res.crateCleared).toBeUndefined();
    expect(res.crateUnchanged).toBeUndefined();
    expect(res.crateChanged).toBe(1);
    expect(res.placeFailed).toBe(1);
  });

  it('keeps the typed pair even when the book’s crate is POSITIONED on a different rack', async () => {
    // The derivation's sharpest case: crate "Gray #BIN on rack 43-B" states a
    // real rack position, so deriving would write 43-B — not null — straight
    // over the 28-A the operator typed. A plausible-looking value is a WORSE
    // silent revert than a null one, because nothing about the row looks wrong.
    const { svc, stub } = setRackStub(
      [bookRow({ color: 'gray', number: 'BIN' })],
      [
        holding(BOOK_A, 'loc-crate-gray-bin', {
          kind: 'crate',
          type: 'bin',
          crate_color: 'gray',
          crate_number: 'BIN',
          rack_number: '43',
          rack_row: 'B',
        }),
      ],
      { 'rpc:transfer_stock': { data: null, error: { message: 'permission denied' } } },
    );

    const res = await svc.bulkUpdate({
      ids: [BOOK_A],
      op: { kind: 'set_rack', rackNumber: '28', rackRow: 'A' },
    });

    expect(stub.rpcCalls.find((c) => c.name === 'inventory_set_book_placement')!.args).toEqual(
      placementArgs([BOOK_A], { color: 'gray', number: 'BIN', rackNumber: '28', rackRow: 'A' }),
    );
    expect(res.placeFailed).toBe(1);
  });

  it('reports placeFailed for a NON-BOOK too — the crate counts can never speak for it', async () => {
    // Every existing warning on this path is a BOOK crate count, and a widget
    // has no crate summary at all: `syncBookCratePlacement` returns an empty map
    // for it and every crate bucket stays 0. So a widget whose transfer was
    // refused produced a bare "Updated 1 item." with nothing anywhere — the
    // silence this count exists to break.
    const { svc, stub } = setRackStub(
      [
        {
          id: WIDGET,
          name: 'Blue Widget',
          item_type: 'part',
          warehouse_id: 'wh-1',
          bin_location: null,
          custom_fields: {},
        },
      ],
      [holding(WIDGET, 'loc-unplaced', { kind: 'unplaced', type: 'unplaced' })],
      { 'rpc:transfer_stock': { data: null, error: { message: 'permission denied' } } },
    );

    const res = await svc.bulkUpdate({
      ids: [WIDGET],
      op: { kind: 'set_rack', rackNumber: '28', rackRow: 'A' },
    });

    // No book, so no crate reconciliation at all…
    expect(stub.rpcCalls.some((c) => c.name === 'inventory_set_book_placement')).toBe(false);
    expect(res.crateCleared).toBeUndefined();
    expect(res.crateUnchanged).toBeUndefined();
    expect(res.crateChanged).toBeUndefined();
    // …and the failure is still reported.
    expect(res.placeFailed).toBe(1);
  });

  it('does NOT report placeFailed when the stock was ALREADY on the typed rack', async () => {
    // The other half of the count's meaning: `placed` is 0 here too, and this is
    // the case a warning must never fire for. Nothing moved because nothing
    // needed to.
    const { svc } = setRackStub(
      [bookRow({ color: null, number: null })],
      [holding(BOOK_A, RACK_28A, { kind: 'rack', type: 'shelf', rack_number: '28', rack_row: 'A' })],
    );

    const res = await svc.bulkUpdate({
      ids: [BOOK_A],
      op: { kind: 'set_rack', rackNumber: '28', rackRow: 'A' },
    });

    expect(res.placed).toBe(0);
    expect(res.placeFailed).toBeUndefined();
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
        holding(BOOK_A, RACK_28A, { kind: 'rack', type: 'shelf', rack_number: '28', rack_row: 'A' }),
        // Also on a NULL-kind Site — a real second placement (migration 0292).
        holding(BOOK_A, 'loc-dc4', { kind: null, type: 'warehouse' }),
      ],
    );

    const res = await svc.bulkUpdate({
      ids: [BOOK_A],
      op: { kind: 'set_rack', rackNumber: '28', rackRow: 'A' },
    });

    expect(stub.rpcCalls.some((c) => c.name === 'inventory_set_book_placement')).toBe(false);
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
      [holding(BOOK_A, RACK_28A, { kind: 'rack', type: 'shelf', rack_number: '28', rack_row: 'A' })],
    );

    await svc.bulkUpdate({ ids: [BOOK_A], op: { kind: 'set_rack', rackNumber: null, rackRow: null } });

    // Nothing was placed, so nothing about the crate changed.
    expect(stub.rpcCalls.some((c) => c.name === 'inventory_set_book_placement')).toBe(false);
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
  // A real rack row carries its own position (LocationsService.create /
  // findOrCreateRackOrCrate always write it), and the reconciliation derives the
  // item's pair from exactly these columns — so a fixture that omitted them
  // would pin the sync CLEARING a pair it should be setting.
  const rackLoc = { kind: 'rack', type: 'shelf', rack_number: '22', rack_row: 'B' };

  /**
   * A small stateful world, because this flow reads the SAME two tables on both
   * sides of the mutation and the whole point is that the two reads differ:
   *   • adjust_stock flips the holdings from `before` to `after`
   *   • inventory_set_book_placement writes the summary the next read returns
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
      'rpc:inventory_set_book_placement': () => {
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
    expect(stub.rpcCalls.some((c) => c.name === 'inventory_set_book_placement')).toBe(false);
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

    const call = stub.rpcCalls.find((c) => c.name === 'inventory_set_book_placement');
    expect(call, 'the write-off never reconciled the crate summary').toBeDefined();
    // Crate cleared AND rack 22-B recorded: the write-off left the book on that
    // rack and only that rack, so both halves of the summary follow.
    expect(call!.args).toEqual(placementArgs([BOOK_A], { rackNumber: '22', rackRow: 'B' }));
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
    // holds is harmless)… and the rack pair clears, because writing off 22-B is
    // exactly what stopped the book being on a rack at all.
    expect(stub.rpcCalls.find((c) => c.name === 'inventory_set_book_placement')!.args).toEqual(
      placementArgs([BOOK_A], { color: 'blue', number: '4' }),
    );
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

    expect(stub.rpcCalls.some((c) => c.name === 'inventory_set_book_placement')).toBe(false);
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

    expect(stub.rpcCalls.some((c) => c.name === 'inventory_set_book_placement')).toBe(false);
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

    expect(stub.rpcCalls.some((c) => c.name === 'inventory_set_book_placement')).toBe(false);
    expect(res.crateSync).toBeNull();
  });
});
