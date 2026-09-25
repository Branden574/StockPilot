import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub, type MockCall } from '@/test/supabase-mock';
import { placementSummary } from '@/lib/placements';

// ═══════════════════════════════════════════════════════════════════════════
// STOCK IN WAREHOUSES THE CALLER CANNOT SEE (0371)
// ═══════════════════════════════════════════════════════════════════════════
//
// Since 0371 a member below manager reads item_stock_levels only in their own
// warehouses (plus locations with no warehouse). quantity_on_hand is still the
// org-wide total. The RPC item_holdings_elsewhere returns what is hidden, as
// totals. Every reader that adds up holdings, and every guard that decides
// from them, folds it in; managers never make the call; a failed call is
// "unavailable", never "nothing elsewhere".
//
// The fixture is the design's QA-CHROME: on hand 32; the staff member (Main
// DC) sees Main Unplaced 20; hidden are 7 on an Annex rack and 5 in Annex
// Staging.

vi.mock('./context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./context')>();
  return { ...actual, assertPermission: vi.fn(), assertPlanLimit: vi.fn() };
});
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({
    readableIds: ['wh-main'],
    writableIds: ['wh-main'],
    hasAllAccess: false,
    primaryWarehouseId: 'wh-main',
  })),
  assertWarehouseAccess: vi.fn(async () => undefined),
  forcedWarehouseId: vi.fn(async () => 'wh-main'),
  ForbiddenError: class extends Error {},
}));
vi.mock('./audit', () => ({
  audit: vi.fn(async () => undefined),
  auditMany: vi.fn(async (payloads: readonly unknown[]) => ({ written: payloads.length, lost: 0 })),
}));

import { ServiceError } from './context';
import { InventoryService } from './inventory';

beforeEach(() => vi.clearAllMocks());

const ITEM = '11111111-1111-1111-1111-111111111111';
const RACK_ANNEX = 'loc-rack-annex';

/** The RPC's literal answer for QA-CHROME: 5 in Annex Staging, 7 on an Annex rack. */
const CHROME_HIDDEN = {
  item_id: ITEM,
  staged: 5,
  unplaced: 0,
  placed: 7,
  placed_location_ids: [RACK_ANNEX],
};

/** An rpc result that answers only for the ids it was asked about, like the RPC. */
function elsewhereAnswer(rows: Array<{ item_id: string } & Record<string, unknown>>) {
  return (call: MockCall) => {
    const asked = new Set((call.args[0]?.[0] as { p_item_ids: string[] }).p_item_ids);
    return { data: rows.filter((r) => asked.has(r.item_id)), error: null };
  };
}

function svcFor(
  results: Parameters<typeof makeSupabaseStub>[0],
  role: 'owner' | 'admin' | 'manager' | 'staff' | 'viewer' = 'staff',
) {
  const stub = makeSupabaseStub(results);
  return { svc: new InventoryService(makeServiceContext(stub.client, { role }) as never), stub };
}

const elsewhereCalls = (stub: ReturnType<typeof makeSupabaseStub>) =>
  stub.rpcCalls.filter((c) => c.name === 'item_holdings_elsewhere');

// ─────────────────────────────────────────────────────────────────────────────
describe('InventoryService.hiddenHoldingsFor', () => {
  it.each(['owner', 'admin', 'manager'] as const)(
    'a %s makes NO call: they see every holding already (perf guard)',
    async (role) => {
      const { svc, stub } = svcFor({ 'rpc:item_holdings_elsewhere': elsewhereAnswer([CHROME_HIDDEN]) }, role);
      const res = await svc.hiddenHoldingsFor([ITEM]);
      expect(res).toEqual({ ok: true, byItem: new Map() });
      expect(elsewhereCalls(stub)).toHaveLength(0);
    },
  );

  it.each(['staff', 'viewer'] as const)('a %s asks, and reads the literal answer', async (role) => {
    const { svc, stub } = svcFor({ 'rpc:item_holdings_elsewhere': elsewhereAnswer([CHROME_HIDDEN]) }, role);
    const res = await svc.hiddenHoldingsFor([ITEM]);
    expect(res.ok).toBe(true);
    expect(res.ok && res.byItem.get(ITEM)).toEqual({
      staged: 5,
      unplaced: 0,
      placed: 7,
      placedLocationIds: [RACK_ANNEX],
    });
    // The ids travel as the RPC's body argument, never a URL filter.
    expect(elsewhereCalls(stub)).toEqual([
      { name: 'item_holdings_elsewhere', args: { p_item_ids: [ITEM] } },
    ]);
  });

  it('asks in batches of at most 500 ids, all started together', async () => {
    const ids = Array.from({ length: 1001 }, (_, i) => `item-${i}`);
    const stub = makeSupabaseStub({});
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    stub.client.rpc = vi.fn(async (name: string, args: unknown) => {
      stub.rpcCalls.push({ name, args });
      await held;
      return { data: [], error: null };
    });
    const svc = new InventoryService(makeServiceContext(stub.client, { role: 'staff' }) as never);
    const pending = svc.hiddenHoldingsFor(ids);
    await new Promise((r) => setTimeout(r, 0));
    // All three requests are out before the first one has answered.
    expect(stub.rpcCalls.map((c) => (c.args as { p_item_ids: string[] }).p_item_ids.length)).toEqual([
      500, 500, 1,
    ]);
    release();
    await expect(pending).resolves.toEqual({ ok: true, byItem: new Map() });
  });

  it.each([
    ['the function is missing (web deployed before the migration)', { data: null, error: { message: 'Could not find the function', code: 'PGRST202' } }],
    ['the RPC refuses', { data: null, error: { message: 'too_many_items', code: '22023' } }],
    ['the answer is malformed', { data: [{ staged: 1 }], error: null }],
  ])('%s: UNAVAILABLE, never an empty answer', async (_label, answer) => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { svc } = svcFor({ 'rpc:item_holdings_elsewhere': answer as never });
    await expect(svc.hiddenHoldingsFor([ITEM])).resolves.toEqual({ ok: false });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('a client that throws is UNAVAILABLE too, and the helper never rejects', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const stub = makeSupabaseStub({});
    stub.client.rpc = vi.fn(() => {
      throw new TypeError('fetch failed');
    });
    const svc = new InventoryService(makeServiceContext(stub.client, { role: 'staff' }) as never);
    await expect(svc.hiddenHoldingsFor([ITEM])).resolves.toEqual({ ok: false });
    errorSpy.mockRestore();
  });

  it('asks nothing for no ids', async () => {
    const { svc, stub } = svcFor({});
    await expect(svc.hiddenHoldingsFor([])).resolves.toEqual({ ok: true, byItem: new Map() });
    expect(elsewhereCalls(stub)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('InventoryService.get({ withElsewhere }) — the item page', () => {
  // A fresh row per read: get() assigns its placement fields onto the row it
  // was handed, so a shared object would carry one test's fields into the next.
  const chromeRow = () => ({ data: { id: ITEM, warehouse_id: 'wh-main', quantity_on_hand: 32, name: 'QA Chrome' }, error: null });
  const mainUnplaced = { data: [{ quantity: 20, locations: { kind: 'unplaced' } }], error: null };

  it('folds the hidden buckets in: 7 placed, 25 awaiting, 12 of them in other warehouses', async () => {
    const { svc } = svcFor({
      'inventory_items.select': chromeRow,
      'item_stock_levels.select': mainUnplaced,
      'rpc:item_holdings_elsewhere': elsewhereAnswer([CHROME_HIDDEN]),
    });
    const item = await svc.get(ITEM, { withElsewhere: true });
    // Before 0371's app change: staged 0, unplaced 20, placed 12 — "12 placed"
    // for an item with nothing placed that the caller can see.
    expect(item).toMatchObject({ staged_quantity: 5, unplaced_quantity: 20, placed_quantity: 7 });
    expect(item.elsewhere).toEqual({
      status: 'some',
      staged: 5,
      unplaced: 0,
      placed: 7,
      placedLocationIds: [RACK_ANNEX],
    });
    // And the page's line, literally: 0 placed + 20 awaiting + 12 in other
    // warehouses = 32 on hand.
    expect(
      placementSummary({
        onHand: item.quantity_on_hand,
        stagedAll: item.staged_quantity,
        unplacedAll: item.unplaced_quantity,
        elsewhere: item.elsewhere,
      }),
    ).toEqual({ kind: 'line', placed: 0, awaiting: 20, elsewhere: 12, onHand: 32 });
  });

  it('asks for the hidden stock BEFORE the item row has answered (no serial chain)', async () => {
    const { svc, stub } = svcFor({
      'inventory_items.select': chromeRow,
      'item_stock_levels.select': mainUnplaced,
      'rpc:item_holdings_elsewhere': elsewhereAnswer([CHROME_HIDDEN]),
    });
    const pending = svc.get(ITEM, { withElsewhere: true });
    // Synchronously, before a single await inside get() has resolved.
    expect(elsewhereCalls(stub)).toHaveLength(1);
    await pending;
  });

  it('a manager makes no call and has nothing elsewhere', async () => {
    const { svc, stub } = svcFor(
      {
        'inventory_items.select': chromeRow,
        'item_stock_levels.select': mainUnplaced,
      },
      'manager',
    );
    const item = await svc.get(ITEM, { withElsewhere: true });
    expect(elsewhereCalls(stub)).toHaveLength(0);
    expect(item.elsewhere).toEqual({ status: 'none' });
  });

  it('a failed read is UNAVAILABLE, and the page then prints no sum', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { svc } = svcFor({
      'inventory_items.select': chromeRow,
      'item_stock_levels.select': mainUnplaced,
      'rpc:item_holdings_elsewhere': { data: null, error: { message: 'boom' } },
    });
    const item = await svc.get(ITEM, { withElsewhere: true });
    expect(item.elsewhere).toEqual({ status: 'unavailable' });
    expect(
      placementSummary({
        onHand: item.quantity_on_hand,
        stagedAll: item.staged_quantity,
        unplacedAll: item.unplaced_quantity,
        elsewhere: item.elsewhere,
      }).kind,
    ).toBe('unavailable');
    errorSpy.mockRestore();
  });

  it('without the option (every other caller of get): no call, no field', async () => {
    const { svc, stub } = svcFor({
      'inventory_items.select': chromeRow,
      'item_stock_levels.select': mainUnplaced,
      'rpc:item_holdings_elsewhere': elsewhereAnswer([CHROME_HIDDEN]),
    });
    const item = await svc.get(ITEM);
    expect(elsewhereCalls(stub)).toHaveLength(0);
    expect('elsewhere' in item).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('InventoryService.list — the staff and viewer list path', () => {
  const listFixture = {
    'inventory_items.select': {
      data: [{ id: ITEM, warehouse_id: 'wh-main', quantity_on_hand: 32 }],
      error: null,
      count: 1,
    },
    'item_stock_levels.select': {
      data: [
        {
          item_id: ITEM,
          location_id: 'loc-unplaced-main',
          quantity: 20,
          locations: { name: 'Unplaced', kind: 'unplaced' },
        },
      ],
      error: null,
    },
  };

  it('placed_quantity is not overstated, the split count includes hidden racks, and the rest is carried', async () => {
    const { svc, stub } = svcFor({
      ...listFixture,
      'rpc:item_holdings_elsewhere': elsewhereAnswer([CHROME_HIDDEN]),
    });
    const res = await svc.list({ limit: 50 });
    expect(res.items[0]).toMatchObject({
      staged_quantity: 5,
      unplaced_quantity: 20,
      // Was 12: every hidden unit counted as placed.
      placed_quantity: 7,
      // The Annex rack is a holding the bulk Set-rack split warning must count.
      rackHoldingsCount: 1,
      elsewhere_quantity: 12,
      placed_racks: [],
    });
    expect(res.elsewhereUnavailable).toBe(false);
    expect(elsewhereCalls(stub)).toEqual([
      { name: 'item_holdings_elsewhere', args: { p_item_ids: [ITEM] } },
    ]);
  });

  it('a failed read keeps the visible figures and SAYS so', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { svc } = svcFor({
      ...listFixture,
      'rpc:item_holdings_elsewhere': { data: null, error: { message: 'boom' } },
    });
    const res = await svc.list({ limit: 50 });
    expect(res.elsewhereUnavailable).toBe(true);
    expect(res.items[0]).toMatchObject({ unplaced_quantity: 20, elsewhere_quantity: 0 });
    errorSpy.mockRestore();
  });

  it('a manager makes no call', async () => {
    const { svc, stub } = svcFor(listFixture, 'manager');
    const res = await svc.list({ limit: 50 });
    expect(elsewhereCalls(stub)).toHaveLength(0);
    expect(res.elsewhereUnavailable).toBe(false);
    expect(res.items[0]).toMatchObject({ elsewhere_quantity: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the archive stock guards', () => {
  it('BULK: an item whose stock is all in another warehouse is NOT archived', async () => {
    // The caller sees no holding at all. The old guard decided from holdings
    // alone and returned early ("byItem.size === 0"), archiving it silently.
    const { svc, stub } = svcFor({
      'inventory_items.select': {
        data: [{ id: ITEM, warehouse_id: 'wh-main', quantity_on_hand: 12 }],
        error: null,
      },
      'item_stock_levels.select': { data: [], error: null },
      'rpc:item_holdings_elsewhere': elsewhereAnswer([{ ...CHROME_HIDDEN, staged: 5, placed: 7 }]),
    });
    await expect(svc.bulkUpdate({ ids: [ITEM], op: { kind: 'archive' } })).rejects.toMatchObject({
      code: 'validation_error',
      message:
        "Cannot archive: 12 units still on hand (12 in warehouses you can't see). " +
        'Remove or move the stock first, or archive it anyway to write it off.',
    });
    expect(stub.chains.has('inventory_items.update')).toBe(false);
  });

  it('BULK: the hidden stock alone blocks, even with quantity_on_hand at 0', async () => {
    const { svc } = svcFor({
      'inventory_items.select': {
        data: [{ id: ITEM, warehouse_id: 'wh-main', quantity_on_hand: 0 }],
        error: null,
      },
      'item_stock_levels.select': { data: [], error: null },
      'rpc:item_holdings_elsewhere': elsewhereAnswer([CHROME_HIDDEN]),
    });
    await expect(svc.bulkUpdate({ ids: [ITEM], op: { kind: 'archive' } })).rejects.toMatchObject({
      code: 'validation_error',
    });
  });

  it('BULK: a failed hidden read FAILS CLOSED', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { svc, stub } = svcFor({
      'inventory_items.select': {
        data: [{ id: ITEM, warehouse_id: 'wh-main', quantity_on_hand: 0 }],
        error: null,
      },
      'item_stock_levels.select': { data: [], error: null },
      'rpc:item_holdings_elsewhere': { data: null, error: { message: 'boom', code: 'PGRST202' } },
    });
    const err = await svc
      .bulkUpdate({ ids: [ITEM], op: { kind: 'archive' } })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('internal_error');
    expect((err as ServiceError).internalDetail).toContain('Could not verify these items');
    expect(stub.chains.has('inventory_items.update')).toBe(false);
    errorSpy.mockRestore();
  });

  it('BULK: a manager makes no hidden call and is still blocked by what they see', async () => {
    const { svc, stub } = svcFor(
      {
        'inventory_items.select': {
          data: [{ id: ITEM, warehouse_id: 'wh-main', quantity_on_hand: 5 }],
          error: null,
        },
        'item_stock_levels.select': {
          data: [
            {
              item_id: ITEM,
              location_id: 'l',
              quantity: 5,
              locations: { id: 'l', name: '38-B', kind: 'rack' },
            },
          ],
          error: null,
        },
      },
      'manager',
    );
    await expect(svc.bulkUpdate({ ids: [ITEM], op: { kind: 'archive' } })).rejects.toMatchObject({
      message: expect.stringContaining('5 units still on hand (5 in 38-B)'),
    });
    expect(elsewhereCalls(stub)).toHaveLength(0);
  });

  it('SINGLE: the message names the hidden units, so its parts add up to its total', async () => {
    const { svc } = svcFor({
      'inventory_items.select': {
        data: { id: ITEM, warehouse_id: 'wh-main', quantity_on_hand: 32, status: 'active' },
        error: null,
      },
      'item_stock_levels.select': {
        data: [
          {
            location_id: 'loc-unplaced-main',
            quantity: 20,
            locations: { id: 'loc-unplaced-main', name: 'Unplaced', kind: 'unplaced' },
          },
        ],
        error: null,
      },
      'rpc:item_holdings_elsewhere': elsewhereAnswer([CHROME_HIDDEN]),
    });
    await expect(svc.archive(ITEM)).rejects.toMatchObject({
      code: 'validation_error',
      message:
        "Cannot archive: 32 units still on hand (20 in Unplaced, 12 in warehouses you can't see). " +
        'Remove or move the stock first, or archive it anyway to write it off.',
    });
  });

  it('SINGLE: a failed hidden read FAILS CLOSED', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { svc, stub } = svcFor({
      'inventory_items.select': {
        data: { id: ITEM, warehouse_id: 'wh-main', quantity_on_hand: 0, status: 'active' },
        error: null,
      },
      'item_stock_levels.select': { data: [], error: null },
      'rpc:item_holdings_elsewhere': { data: null, error: { message: 'boom' } },
    });
    await expect(svc.archive(ITEM)).rejects.toMatchObject({ code: 'internal_error' });
    expect(stub.chains.has('inventory_items.update')).toBe(false);
    errorSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('bulk Set rack — hidden holdings count toward the split rule', () => {
  function setRackFixture(visible: unknown[], hidden: unknown) {
    return svcFor({
      'inventory_items.select': {
        data: [{ id: ITEM, warehouse_id: 'wh-main', quantity_on_hand: 10 }],
        error: null,
      },
      'rpc:inventory_set_rack': { data: 1, error: null },
      'item_stock_levels.select': { data: visible, error: null },
      'locations.select': { data: [{ id: 'rack-new', name: '1-A' }], error: null },
      'rpc:transfer_stock': { data: null, error: null },
      'rpc:item_holdings_elsewhere': hidden as never,
    });
  }
  const mainRack = {
    item_id: ITEM,
    location_id: 'rack-main',
    quantity: 3,
    locations: { kind: 'rack', type: null, warehouse_id: 'wh-main' },
  };

  it('one rack here + one in another warehouse IS a split: label only, nothing moved, reported', async () => {
    const { svc, stub } = setRackFixture([mainRack], elsewhereAnswer([CHROME_HIDDEN]));
    const res = await svc.bulkUpdate({
      ids: [ITEM],
      op: { kind: 'set_rack', rackNumber: '1', rackRow: 'A' },
    });
    // Seen from the visible rows alone this looked single and was moved.
    expect(stub.rpcCalls.some((c) => c.name === 'transfer_stock')).toBe(false);
    expect(res).toMatchObject({ ok: 1, placed: 0, placeElsewhere: 1 });
    expect(res.placeFailed).toBeUndefined();
  });

  it('the only placed holding is in another warehouse: never attempted, reported as elsewhere', async () => {
    const { svc, stub } = setRackFixture([], elsewhereAnswer([{ ...CHROME_HIDDEN, staged: 0 }]));
    const res = await svc.bulkUpdate({
      ids: [ITEM],
      op: { kind: 'set_rack', rackNumber: '1', rackRow: 'A' },
    });
    expect(stub.rpcCalls.some((c) => c.name === 'transfer_stock')).toBe(false);
    expect(res).toMatchObject({ placeElsewhere: 1 });
    expect(res.placeFailed).toBeUndefined();
  });

  it('a single visible rack with nothing elsewhere still MOVES (the rule is unchanged)', async () => {
    const { svc, stub } = setRackFixture([mainRack], elsewhereAnswer([]));
    const res = await svc.bulkUpdate({
      ids: [ITEM],
      op: { kind: 'set_rack', rackNumber: '1', rackRow: 'A' },
    });
    expect(stub.rpcCalls.find((c) => c.name === 'transfer_stock')?.args).toMatchObject({
      p_from_location_id: 'rack-main',
      p_to_location_id: 'rack-new',
    });
    expect(res.placeElsewhere).toBeUndefined();
  });

  it('a failed hidden read claims nothing: every item reported failed, nothing moved', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { svc, stub } = setRackFixture([mainRack], { data: null, error: { message: 'boom' } });
    const res = await svc.bulkUpdate({
      ids: [ITEM],
      op: { kind: 'set_rack', rackNumber: '1', rackRow: 'A' },
    });
    expect(stub.rpcCalls.some((c) => c.name === 'transfer_stock')).toBe(false);
    expect(res).toMatchObject({ placeFailed: 1 });
    errorSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the book crate split rule sees every warehouse', () => {
  const BOOK = ITEM;
  const MAIN_CRATE = 'loc-crate-main';
  const ANNEX_CRATE = 'loc-crate-annex';
  const annexCrateRow = {
    id: ANNEX_CRATE,
    kind: 'crate',
    type: null,
    crate_color: 'red',
    crate_number: '9',
    rack_number: null,
    rack_row: null,
  };
  const mainCrateHolding = {
    item_id: BOOK,
    location_id: MAIN_CRATE,
    quantity: 5,
    locations: {
      id: MAIN_CRATE,
      kind: 'crate',
      type: null,
      crate_color: 'green',
      crate_number: '2',
      rack_number: null,
      rack_row: null,
    },
  };
  const bookRow = {
    id: BOOK,
    name: 'Persepolis',
    item_type: 'book',
    custom_fields: { book_crate_color: 'blue', book_crate_number: '4' },
  };
  const annexHidden = {
    item_id: BOOK,
    staged: 0,
    unplaced: 0,
    placed: 3,
    placed_location_ids: [ANNEX_CRATE],
  };
  const verified = new Map([[BOOK, { name: 'Persepolis', crateColor: 'blue', crateNumber: '4' }]]);

  it('SYNC: a Main crate plus an Annex crate is a split — the summary is left alone and reported', async () => {
    const { svc, stub } = svcFor({
      'inventory_items.select': { data: [bookRow], error: null },
      'item_stock_levels.select': { data: [mainCrateHolding], error: null },
      'rpc:item_holdings_elsewhere': elsewhereAnswer([annexHidden]),
      'locations.select': { data: [annexCrateRow], error: null },
      'rpc:inventory_set_book_placement': { data: 1, error: null },
    });
    const res = await svc.syncBookCratePlacement([BOOK], { verified });
    expect(res.skippedItemIds).toEqual([BOOK]);
    expect(stub.rpcCalls.some((c) => c.name === 'inventory_set_book_placement')).toBe(false);
  });

  it('SYNC: draining the Main crate re-syncs the summary to the Annex crate, as for a manager', async () => {
    const { svc, stub } = svcFor({
      'inventory_items.select': { data: [bookRow], error: null },
      'item_stock_levels.select': { data: [], error: null },
      'rpc:item_holdings_elsewhere': elsewhereAnswer([annexHidden]),
      'locations.select': { data: [annexCrateRow], error: null },
      'rpc:inventory_set_book_placement': { data: 1, error: null },
    });
    const res = await svc.syncBookCratePlacement([BOOK], { verified });
    // Seen from the visible rows alone: "unplaced", and the label went stale.
    expect(res.unplacedItemIds).toEqual([]);
    expect(res.syncedItemIds).toEqual([BOOK]);
    expect(stub.rpcCalls.find((c) => c.name === 'inventory_set_book_placement')?.args).toEqual({
      p_item_ids: [BOOK],
      p_crate_color: 'red',
      p_crate_number: '9',
      p_rack_number: null,
      p_rack_row: null,
    });
  });

  it('SYNC: a failed hidden read writes nothing and reports the book failed', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { svc, stub } = svcFor({
      'inventory_items.select': { data: [bookRow], error: null },
      'item_stock_levels.select': { data: [mainCrateHolding], error: null },
      'rpc:item_holdings_elsewhere': { data: null, error: { message: 'boom' } },
      'rpc:inventory_set_book_placement': { data: 1, error: null },
    });
    const res = await svc.syncBookCratePlacement([BOOK], { verified });
    expect(res.failedItemIds).toEqual([BOOK]);
    expect(stub.rpcCalls.some((c) => c.name === 'inventory_set_book_placement')).toBe(false);
    errorSpy.mockRestore();
  });

  it('SYNC: a hidden location that cannot be read makes the split undecidable: failed, not written', async () => {
    const { svc, stub } = svcFor({
      'inventory_items.select': { data: [bookRow], error: null },
      'item_stock_levels.select': { data: [], error: null },
      'rpc:item_holdings_elsewhere': elsewhereAnswer([annexHidden]),
      'locations.select': { data: [], error: null },
      'rpc:inventory_set_book_placement': { data: 1, error: null },
    });
    const res = await svc.syncBookCratePlacement([BOOK], { verified });
    expect(res.failedItemIds).toEqual([BOOK]);
    expect(stub.rpcCalls.some((c) => c.name === 'inventory_set_book_placement')).toBe(false);
  });

  // THE PROMPT AND THE WRITE AGREE: the same fixture, through the gate.
  const gateArgs = [
    [BOOK],
    {
      kind: 'crate',
      name: 'Green #2',
      rackNumber: null,
      rackRow: null,
      crateColor: 'green',
      crateNumber: '2',
    },
    {
      toLocationId: MAIN_CRATE,
      moves: new Map([[BOOK, { fromLocationId: 'loc-staging-main', quantity: 5 }]]),
    },
  ] as const;

  it('PREDICTION: the hidden Annex crate keeps the book split, so the gate does NOT ask (the sync will skip)', async () => {
    const { svc } = svcFor({
      'inventory_items.select': { data: [bookRow], error: null },
      'item_stock_levels.select': {
        data: [
          {
            item_id: BOOK,
            location_id: 'loc-staging-main',
            quantity: 5,
            locations: { id: 'loc-staging-main', kind: 'staging', type: null },
          },
        ],
        error: null,
      },
      'rpc:item_holdings_elsewhere': elsewhereAnswer([annexHidden]),
      'locations.select': { data: [annexCrateRow], error: null },
    });
    await expect(
      svc.assertBookCratePlacementAllowed(gateArgs[0] as unknown as string[], gateArgs[1] as never, gateArgs[2] as never),
    ).resolves.toBeInstanceOf(Map);
  });

  it('PREDICTION: with nothing elsewhere the destination becomes the only placement, so it ASKS', async () => {
    const { svc } = svcFor({
      'inventory_items.select': { data: [bookRow], error: null },
      'item_stock_levels.select': {
        data: [
          {
            item_id: BOOK,
            location_id: 'loc-staging-main',
            quantity: 5,
            locations: { id: 'loc-staging-main', kind: 'staging', type: null },
          },
        ],
        error: null,
      },
      'rpc:item_holdings_elsewhere': elsewhereAnswer([]),
    });
    const err = (await svc
      .assertBookCratePlacementAllowed(gateArgs[0] as unknown as string[], gateArgs[1] as never, gateArgs[2] as never)
      .catch((e: unknown) => e)) as ServiceError;
    expect(err.code).toBe('conflict');
  });

  it('PREDICTION: a failed hidden read keeps the confirmation (fail closed)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { svc } = svcFor({
      'inventory_items.select': { data: [bookRow], error: null },
      'item_stock_levels.select': { data: [], error: null },
      'rpc:item_holdings_elsewhere': { data: null, error: { message: 'boom' } },
    });
    const err = (await svc
      .assertBookCratePlacementAllowed(gateArgs[0] as unknown as string[], gateArgs[1] as never, gateArgs[2] as never)
      .catch((e: unknown) => e)) as ServiceError;
    expect(err.code).toBe('conflict');
    errorSpy.mockRestore();
  });
});
