import { describe, expect, it } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

import { fetchRackHoldingsByItem } from './rack-holdings';

function ctxFor(client: unknown) {
  return { organizationId: 'org-1', supabase: client as never };
}

describe('fetchRackHoldingsByItem', () => {
  it('returns an empty map without querying when there are no item ids', async () => {
    const { client, fromCalls } = makeSupabaseStub();
    const result = await fetchRackHoldingsByItem(ctxFor(client), []);
    expect(result.size).toBe(0);
    expect(fromCalls).toHaveLength(0);
  });

  it('groups multiple holding rows per item, keyed by item_id', async () => {
    const { client } = makeSupabaseStub({
      'item_stock_levels.select': {
        data: [
          { item_id: 'i1', quantity: 20, locations: { name: '2-C', kind: 'rack', warehouse_id: 'wh-1' } },
          { item_id: 'i1', quantity: 5, locations: { name: '5-A', kind: 'rack', warehouse_id: 'wh-1' } },
          { item_id: 'i2', quantity: 3, locations: { name: 'Crate 9', kind: 'crate', warehouse_id: 'wh-1' } },
        ],
        error: null,
      },
    });
    const result = await fetchRackHoldingsByItem(ctxFor(client), ['i1', 'i2']);
    // `kind` is carried through, not discarded: a single-label consumer needs
    // to know the stock is in a CRATE, because a put-away into a position-less
    // crate deliberately leaves the item's rack keys naming its old rack.
    expect(result.get('i1')).toEqual([
      { name: '2-C', quantity: 20, kind: 'rack' },
      { name: '5-A', quantity: 5, kind: 'rack' },
    ]);
    expect(result.get('i2')).toEqual([{ name: 'Crate 9', quantity: 3, kind: 'crate' }]);
    // An item with no rack/crate holding at all is simply absent from the
    // map — callers treat a missing key the same as an empty array.
    expect(result.has('i3')).toBe(false);
  });

  it('skips a row whose location embed resolved to null (defensive)', async () => {
    const { client } = makeSupabaseStub({
      'item_stock_levels.select': {
        data: [{ item_id: 'i1', quantity: 20, locations: null }],
        error: null,
      },
    });
    const result = await fetchRackHoldingsByItem(ctxFor(client), ['i1']);
    expect(result.has('i1')).toBe(false);
  });

  it('scopes to a warehouse when warehouseId is passed', async () => {
    const { client, chains, chainArgs } = makeSupabaseStub({
      'item_stock_levels.select': { data: [], error: null },
    });
    await fetchRackHoldingsByItem(ctxFor(client), ['i1'], 'wh-1');
    const chain = chains.get('item_stock_levels.select') ?? [];
    const args = chainArgs.get('item_stock_levels.select') ?? [];
    const eqIdx = chain
      .map((m, i) => (m === 'eq' ? i : -1))
      .filter((i) => i >= 0)
      .find((i) => args[i]?.[0] === 'locations.warehouse_id');
    expect(eqIdx).toBeDefined();
    expect(args[eqIdx!]).toEqual(['locations.warehouse_id', 'wh-1']);
  });

  it('does not filter by warehouse when none is passed', async () => {
    const { client, chainArgs } = makeSupabaseStub({
      'item_stock_levels.select': { data: [], error: null },
    });
    await fetchRackHoldingsByItem(ctxFor(client), ['i1']);
    const args = chainArgs.get('item_stock_levels.select') ?? [];
    expect(args.some((a) => a[0] === 'locations.warehouse_id')).toBe(false);
  });

  it('chunks item ids into batches of 100 and runs them in parallel', async () => {
    const { client, chainsAll } = makeSupabaseStub({
      'item_stock_levels.select': { data: [], error: null },
    });
    const ids = Array.from({ length: 150 }, (_, i) => `item-${i}`);
    await fetchRackHoldingsByItem(ctxFor(client), ids);
    const all = chainsAll.get('item_stock_levels.select') ?? [];
    expect(all).toHaveLength(2);
  });
});
