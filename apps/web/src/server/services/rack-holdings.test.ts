import { describe, expect, it, vi } from 'vitest';

const reportError = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/error-reporter', () => ({ reportError }));

import { callArgs, inFilters, makeSupabaseStub } from '@/test/supabase-mock';

import { fetchPlacementHoldingsByItem, fetchRackHoldingsByItem } from './rack-holdings';

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
          {
            item_id: 'i1',
            quantity: 20,
            locations: { name: '2-C', kind: 'rack', warehouse_id: 'wh-1' },
          },
          {
            item_id: 'i1',
            quantity: 5,
            locations: { name: '5-A', kind: 'rack', warehouse_id: 'wh-1' },
          },
          {
            item_id: 'i2',
            quantity: 3,
            locations: { name: 'Crate 9', kind: 'crate', warehouse_id: 'wh-1' },
          },
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

  it('pages each batch past the 1000-row cap, so split stock on row 1001 is not hidden', async () => {
    const rows = Array.from({ length: 1200 }, (_, n) => ({
      item_id: 'item-0',
      quantity: 1,
      locations: { name: `Rack ${n}`, kind: 'rack', warehouse_id: 'wh-1' },
    }));
    const { client } = makeSupabaseStub({
      'item_stock_levels.select': (call) => {
        const [from, to] = (callArgs(call, 'range') ?? [0, 999]) as [number, number];
        return { data: rows.slice(from, to + 1), error: null };
      },
    });
    const out = await fetchRackHoldingsByItem(ctxFor(client), ['item-0']);
    expect(out.get('item-0')).toHaveLength(1200);
  });

  it('a failed batch costs only its own items, and is reported', async () => {
    reportError.mockClear();
    let n = 0;
    const { client } = makeSupabaseStub({
      'item_stock_levels.select': (call) => {
        n += 1;
        const ids = (inFilters(call).find(([c]) => c === 'item_id')?.[1] ?? []) as string[];
        if (n === 2) return { data: null, error: { message: 'URI too long' } };
        return {
          data: ids.map((item_id) => ({
            item_id,
            quantity: 1,
            locations: { name: 'Rack 1', kind: 'rack', warehouse_id: 'wh-1' },
          })),
          error: null,
        };
      },
    });
    const ids = Array.from({ length: 250 }, (_, i) => `item-${i}`);
    const out = await fetchRackHoldingsByItem(ctxFor(client), ids);
    expect(out.size).toBe(150);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect((reportError.mock.calls[0] as unknown as [Error, { tag: string }])[1].tag).toBe(
      'rack-holdings.fetch',
    );
  });
});

describe('fetchPlacementHoldingsByItem (B37: the Site rule needs the Site rows)', () => {
  it('reads every location kind with its type, in ONE query, so the rack and Site rows succeed or fail together', async () => {
    const { client, chainArgs, chains } = makeSupabaseStub({
      'item_stock_levels.select': { data: [], error: null },
    });
    await fetchPlacementHoldingsByItem(ctxFor(client), ['i1'], 'wh-1');
    const chain = chains.get('item_stock_levels.select') ?? [];
    const args = chainArgs.get('item_stock_levels.select') ?? [];
    expect(args[chain.indexOf('select')]).toEqual([
      'item_id, quantity, locations!inner(name, kind, type, warehouse_id)',
    ]);
    // No kind filter in SQL: a Site's kind IS NULL, and a NOT IN filter would
    // drop it (the 0292 trap). The buckets are dropped by the core partition.
    const inColumns = chain.flatMap((m, i) => (m === 'in' ? [args[i]?.[0]] : []));
    expect(inColumns).toEqual(['item_id']);
    expect(chain.includes('not')).toBe(false);
    expect(args.some((a) => a[0] === 'locations.warehouse_id' && a[1] === 'wh-1')).toBe(true);
    expect(args.some((a) => a[0] === 'quantity' && a[1] === 0)).toBe(true);
  });

  it('splits each item into rack/crate rows and every other placed row, and drops Staging and Unplaced', async () => {
    const { client } = makeSupabaseStub({
      'item_stock_levels.select': {
        data: [
          {
            item_id: 'site-only',
            quantity: 12,
            locations: { name: 'DC4', kind: null, type: 'warehouse', warehouse_id: 'wh-1' },
          },
          {
            item_id: 'site-only',
            quantity: 2,
            locations: { name: 'Unplaced', kind: 'unplaced', type: 'other', warehouse_id: 'wh-1' },
          },
          {
            item_id: 'mixed',
            quantity: 8,
            locations: { name: '38-A', kind: 'rack', type: null, warehouse_id: 'wh-1' },
          },
          {
            item_id: 'mixed',
            quantity: 4,
            locations: { name: 'DC4', kind: null, type: 'warehouse', warehouse_id: 'wh-1' },
          },
          {
            item_id: 'staged',
            quantity: 3,
            locations: { name: 'Staging', kind: 'staging', type: 'other', warehouse_id: 'wh-1' },
          },
        ],
        error: null,
      },
    });
    const { rack, other } = await fetchPlacementHoldingsByItem(ctxFor(client), [
      'site-only',
      'mixed',
      'staged',
    ]);
    expect(rack.has('site-only')).toBe(false);
    expect(other.get('site-only')).toEqual([
      { name: 'DC4', quantity: 12, kind: null, type: 'warehouse' },
    ]);
    // The rack half is byte-identical to fetchRackHoldingsByItem's rows (no type).
    expect(rack.get('mixed')).toEqual([{ name: '38-A', quantity: 8, kind: 'rack' }]);
    expect(other.get('mixed')).toEqual([
      { name: 'DC4', quantity: 4, kind: null, type: 'warehouse' },
    ]);
    // Stock awaiting put-away is no place to send a picker.
    expect(rack.has('staged')).toBe(false);
    expect(other.has('staged')).toBe(false);
  });

  it('a failed batch answers NOTHING for its items, never "on the Site" for stock whose rack read was lost', async () => {
    reportError.mockClear();
    let n = 0;
    const { client } = makeSupabaseStub({
      'item_stock_levels.select': (call) => {
        n += 1;
        const ids = (inFilters(call).find(([c]) => c === 'item_id')?.[1] ?? []) as string[];
        if (n === 2) return { data: null, error: { message: 'fetch failed' } };
        return {
          data: ids.flatMap((item_id) => [
            {
              item_id,
              quantity: 1,
              locations: { name: '5-A', kind: 'rack', type: null, warehouse_id: 'wh-1' },
            },
            {
              item_id,
              quantity: 1,
              locations: { name: 'DC4', kind: null, type: 'warehouse', warehouse_id: 'wh-1' },
            },
          ]),
          error: null,
        };
      },
    });
    const ids = Array.from({ length: 150 }, (_, i) => `item-${i}`);
    const { rack, other } = await fetchPlacementHoldingsByItem(ctxFor(client), ids);
    expect(rack.size).toBe(100);
    expect(other.size).toBe(100);
    // Every item of the failed batch is absent from BOTH maps.
    for (const id of ids.slice(100)) {
      expect(rack.has(id), id).toBe(false);
      expect(other.has(id), id).toBe(false);
    }
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it('fetchRackHoldingsByItem is its rack half: a Site, area or bucket row never reaches the scanner lookup or the returns workbench', async () => {
    const { client } = makeSupabaseStub({
      'item_stock_levels.select': {
        data: [
          {
            item_id: 'i1',
            quantity: 12,
            locations: { name: 'DC4', kind: null, type: 'warehouse', warehouse_id: 'wh-1' },
          },
          {
            item_id: 'i1',
            quantity: 2,
            locations: { name: 'Overflow', kind: 'area', type: 'other', warehouse_id: 'wh-1' },
          },
          {
            item_id: 'i1',
            quantity: 1,
            locations: { name: 'Unplaced', kind: 'unplaced', type: 'other', warehouse_id: 'wh-1' },
          },
          {
            item_id: 'i2',
            quantity: 3,
            locations: { name: 'Crate 9', kind: 'crate', type: 'bin', warehouse_id: 'wh-1' },
          },
        ],
        error: null,
      },
    });
    const result = await fetchRackHoldingsByItem(ctxFor(client), ['i1', 'i2']);
    expect(result.has('i1')).toBe(false);
    expect(result.get('i2')).toEqual([{ name: 'Crate 9', quantity: 3, kind: 'crate' }]);
  });
});
