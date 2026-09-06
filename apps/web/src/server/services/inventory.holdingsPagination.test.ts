import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

/**
 * PostgREST clamps EVERY response to `[api] max_rows = 1000`
 * (supabase/config.toml) with no error — pattern #3 in
 * reference_recurring_bug_patterns. Three `item_stock_levels` reads in
 * InventoryService took the whole page of item ids in one un-ranged
 * `.in('item_id', …)`:
 *
 *   • list()                      → placement columns silently 0 (SP-139)
 *   • assertBulkArchivableOrThrow → items with stock archive anyway (SP-085)
 *   • placeItemsOntoRackByName    → label written, stock never moved (SP-088)
 *
 * These tests drive the un-ranged shape straight into the cap: the stubbed
 * `item_stock_levels.select` answers the FIRST call with a full 1000-row page
 * and the item under test only on the SECOND. Code that never calls
 * `.range()` never sees page two.
 */
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({
    readableIds: ['wh-1'],
    writableIds: ['wh-1'],
    hasAllAccess: true,
    primaryWarehouseId: 'wh-1',
  })),
  assertWarehouseAccess: vi.fn(async () => undefined),
  forcedWarehouseId: vi.fn(async () => null),
  ForbiddenError: class extends Error {},
}));
vi.mock('./audit', () => ({ audit: vi.fn(async () => undefined) }));

import { InventoryService } from './inventory';

beforeEach(() => vi.clearAllMocks());

/** A full PostgREST page — 1000 holdings that belong to OTHER items. */
function fillerPage(kind: string) {
  return Array.from({ length: 1000 }, (_, i) => ({
    id: `lvl-${i}`,
    item_id: `filler-${i}`,
    location_id: `loc-${i}`,
    quantity: 1,
    locations: { id: `loc-${i}`, name: 'Staging', kind, warehouse_id: 'wh-1', type: null },
  }));
}

/** Page 1 = the cap; page 2 = the rows the old code could never reach. */
function pagedHoldings(pageTwo: unknown[], kind = 'staging') {
  let call = 0;
  return () => {
    call += 1;
    return call === 1
      ? { data: fillerPage(kind), error: null }
      : { data: pageTwo, error: null };
  };
}

describe('InventoryService.list — placement holdings past the 1000-row cap', () => {
  it('reads the SECOND page of item_stock_levels, so a page item keeps its staged quantity', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': {
        data: [{ id: 'itm-target', quantity_on_hand: 5 }],
        error: null,
        count: 1,
      },
      'item_stock_levels.select': pagedHoldings([
        {
          id: 'lvl-target',
          item_id: 'itm-target',
          location_id: 'stg',
          quantity: 5,
          locations: { name: 'Staging', kind: 'staging' },
        },
      ]),
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    const res = await svc.list({ limit: 300 });

    expect(res.items[0]).toMatchObject({ id: 'itm-target', staged_quantity: 5 });
    // Proof the read actually paged rather than getting lucky.
    expect((stub.chainsAll.get('item_stock_levels.select') ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('LOGS a placement-read failure instead of silently reporting every row as unplaced', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const stub = makeSupabaseStub({
      'inventory_items.select': {
        data: [{ id: 'itm-target', quantity_on_hand: 5 }],
        error: null,
        count: 1,
      },
      'item_stock_levels.select': { data: null, error: { message: 'fetch failed' } },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    // Fail CLOSED (pattern #1): the list still renders, degraded — but the
    // failure is no longer invisible.
    const res = await svc.list({ limit: 50 });
    expect(res.items).toHaveLength(1);
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls.flat().join(' ')).toContain('placement');
    spy.mockRestore();
  });
});

describe('InventoryService.bulkUpdate — archive stock guard past the 1000-row cap', () => {
  it('counts holdings from EVERY page, so an item whose stock lands on page 2 still blocks the batch', async () => {
    const ids = Array.from({ length: 3 }, (_, i) => `itm-${i}`);
    const stub = makeSupabaseStub({
      'inventory_items.select': {
        data: ids.map((id) => ({ id, warehouse_id: 'wh-1' })),
        error: null,
      },
      'item_stock_levels.select': pagedHoldings([
        {
          id: 'lvl-1001',
          item_id: 'itm-1001',
          location_id: 'l',
          quantity: 7,
          locations: { id: 'l', name: '100-A', kind: 'rack' },
        },
      ]),
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await expect(svc.bulkUpdate({ ids, op: { kind: 'archive' } })).rejects.toMatchObject({
      code: 'validation_error',
      // 1000 (page 1) + 1 (page 2). Un-paginated it says 1000 and, worse,
      // lets the page-2 item through when it is the ONLY one holding stock.
      message: expect.stringContaining('1001 selected items'),
    });
  });

  it('still FAILS CLOSED when the holdings read errors (unchanged)', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [{ id: 'itm-1', warehouse_id: 'wh-1' }], error: null },
      'item_stock_levels.select': { data: null, error: { message: 'fetch failed' } },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await expect(
      svc.bulkUpdate({ ids: ['itm-1'], op: { kind: 'archive' } }),
    ).rejects.toMatchObject({ code: 'internal_error' });
    expect(stub.chains.has('inventory_items.update')).toBe(false);
  });
});

describe('bulkUpdate set_rack — placement holdings past the 1000-row cap', () => {
  it('places an item whose only holding is on page 2 (today the label lies and the stock never moves)', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [{ id: 'item-1', warehouse_id: 'wh-1' }], error: null },
      'rpc:inventory_set_rack': { data: 1, error: null },
      'locations.select': { data: [{ id: 'rack-1', name: '1-A' }], error: null },
      'rpc:transfer_stock': { data: null, error: null },
      'item_stock_levels.select': pagedHoldings([
        {
          id: 'lvl-target',
          item_id: 'item-1',
          location_id: 'stg-1',
          quantity: 8,
          locations: { kind: 'staging', type: null, warehouse_id: 'wh-1' },
        },
      ]),
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    const res = await svc.bulkUpdate({
      ids: ['item-1'],
      op: { kind: 'set_rack', rackNumber: '1', rackRow: 'A' },
    });

    const transfer = stub.rpcCalls.find(
      (c) => c.name === 'transfer_stock' && (c.args as { p_item_id?: string }).p_item_id === 'item-1',
    );
    expect(transfer).toBeDefined();
    expect(transfer!.args).toMatchObject({ p_from_location_id: 'stg-1', p_to_location_id: 'rack-1' });
    expect(res.placed).toBeGreaterThanOrEqual(1);
  });

  it('reports EVERY item as failed when the holdings read errors, instead of "0 failed"', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [{ id: 'item-1', warehouse_id: 'wh-1' }], error: null },
      'rpc:inventory_set_rack': { data: 1, error: null },
      'locations.select': { data: [{ id: 'rack-1', name: '1-A' }], error: null },
      'item_stock_levels.select': { data: null, error: { message: 'fetch failed' } },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    const res = await svc.bulkUpdate({
      ids: ['item-1'],
      op: { kind: 'set_rack', rackNumber: '1', rackRow: 'A' },
    });

    // The label RPC still ran (unchanged), but the operator is TOLD the stock
    // did not follow it — the `label_mismatch` the Exception Center flags.
    expect(res.placeFailed).toBe(1);
  });
});
