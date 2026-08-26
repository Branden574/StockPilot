import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ORDER_PREFILL_KEY,
  partitionPrefillAgainstCatalog,
  resolveStartOrder,
  takeOrderPrefill,
  writeOrderPrefill,
  type StartOrderRow,
} from './start-order-prefill';

const row = (id: string, warehouse_id: string | null, status = 'active'): StartOrderRow => ({
  id,
  warehouse_id,
  status,
});

describe('resolveStartOrder — target warehouse + orderable ids', () => {
  it('uses the active warehouse filter when it holds a pick', () => {
    const r = resolveStartOrder([row('a', 'wh1'), row('b', 'wh1'), row('c', 'wh2')], 'wh1');
    expect(r).toEqual({
      warehouseId: 'wh1',
      itemIds: ['a', 'b'],
      totalSelected: 3,
      droppedOtherWarehouse: 1, // c
      droppedNotOrderable: 0,
    });
  });

  it('falls back to the MAJORITY warehouse when no filter is active', () => {
    // wh2 has 2 picks, wh1 has 1 → wh2 wins.
    const r = resolveStartOrder([row('a', 'wh1'), row('b', 'wh2'), row('c', 'wh2')], null);
    expect(r?.warehouseId).toBe('wh2');
    expect(r?.itemIds).toEqual(['b', 'c']);
    expect(r?.droppedOtherWarehouse).toBe(1);
  });

  it('breaks a tie toward the earliest-selected warehouse', () => {
    const r = resolveStartOrder([row('a', 'wh1'), row('b', 'wh2')], null);
    expect(r?.warehouseId).toBe('wh1');
  });

  it('ignores an active filter that holds none of the picks', () => {
    // Filter says wh9, but nothing selected is in wh9 → majority instead.
    const r = resolveStartOrder([row('a', 'wh1'), row('b', 'wh1')], 'wh9');
    expect(r?.warehouseId).toBe('wh1');
    expect(r?.itemIds).toEqual(['a', 'b']);
  });

  it('drops archived rows and rows with no warehouse, and counts them', () => {
    const r = resolveStartOrder(
      [row('a', 'wh1'), row('b', 'wh1', 'archived'), row('c', null)],
      'wh1',
    );
    expect(r?.itemIds).toEqual(['a']);
    expect(r?.droppedNotOrderable).toBe(2);
  });

  it('returns null when nothing is orderable', () => {
    expect(resolveStartOrder([row('a', null), row('b', 'wh1', 'archived')], null)).toBeNull();
    expect(resolveStartOrder([], 'wh1')).toBeNull();
  });

  it('dedupes item ids within the target warehouse', () => {
    const r = resolveStartOrder([row('a', 'wh1'), row('a', 'wh1')], 'wh1');
    expect(r?.itemIds).toEqual(['a']);
  });
});

describe('partitionPrefillAgainstCatalog — the storefront gate', () => {
  const cat = [
    { id: 'a', quantityOnHand: 10, reservedQuantity: 2 }, // 8 available
    { id: 'b', quantityOnHand: 3, reservedQuantity: 3 }, // 0 available
    { id: 'c', quantityOnHand: 5, reservedQuantity: 0 }, // 5 available
  ];

  it('keeps only ids present in the catalog with stock available', () => {
    // d is not in the catalog (wrong warehouse / bundle / rental) → skipped.
    const { addable, skipped } = partitionPrefillAgainstCatalog(['a', 'b', 'c', 'd'], cat);
    expect(addable).toEqual(['a', 'c']);
    expect(skipped).toBe(2); // b (no stock) + d (not orderable here)
  });

  it('dedupes before counting', () => {
    const { addable, skipped } = partitionPrefillAgainstCatalog(['a', 'a', 'c'], cat);
    expect(addable).toEqual(['a', 'c']);
    expect(skipped).toBe(0);
  });
});

describe('sessionStorage handoff', () => {
  const store = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });

  afterEach(() => store.clear());

  it('writes, then reads-and-clears exactly once for the matching warehouse', () => {
    writeOrderPrefill({ warehouseId: 'wh1', itemIds: ['a', 'b'] });
    expect(store.has(ORDER_PREFILL_KEY)).toBe(true);

    const got = takeOrderPrefill('wh1');
    expect(got).toEqual({ warehouseId: 'wh1', itemIds: ['a', 'b'] });
    // consumed
    expect(store.has(ORDER_PREFILL_KEY)).toBe(false);
    expect(takeOrderPrefill('wh1')).toBeNull();
  });

  it('LEAVES the blob in place when it targets a different warehouse', () => {
    writeOrderPrefill({ warehouseId: 'wh2', itemIds: ['x'] });
    expect(takeOrderPrefill('wh1')).toBeNull(); // mismatch
    expect(store.has(ORDER_PREFILL_KEY)).toBe(true); // still there
    expect(takeOrderPrefill('wh2')).toEqual({ warehouseId: 'wh2', itemIds: ['x'] });
  });

  it('clears a corrupt blob and returns null', () => {
    store.set(ORDER_PREFILL_KEY, '{not json');
    expect(takeOrderPrefill('wh1')).toBeNull();
    expect(store.has(ORDER_PREFILL_KEY)).toBe(false);
  });
});
