import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

// Mock the warehouse helpers — services call them directly. The default mock
// gives full access; individual tests override via mockResolvedValue.
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({
    readableIds: ['wh-a'],
    writableIds: ['wh-a'],
    hasAllAccess: true,
    primaryWarehouseId: 'wh-a',
  })),
  assertWarehouseAccess: vi.fn(),
  forcedWarehouseId: vi.fn(async () => null),
  ForbiddenError: class ForbiddenError extends Error {
    readonly code = 'forbidden' as const;
  },
}));

import { getWarehouseAccess } from '@/lib/auth/warehouse';
import { PAGE_SIZE } from './lib/paginate';
import { InventoryService } from './inventory';

const LEAN_COLUMNS = 'id, sku, name, quantity_on_hand, created_at';

function matchRow(i: number) {
  return {
    id: `item-${String(i).padStart(5, '0')}`,
    sku: `SKU-${i}`,
    name: `Item ${i}`,
    quantity_on_hand: i,
    created_at: '2026-01-01T00:00:00Z',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getWarehouseAccess).mockResolvedValue({
    readableIds: ['wh-a'],
    writableIds: ['wh-a'],
    hasAllAccess: true,
    primaryWarehouseId: 'wh-a',
  });
});

describe('InventoryService.listForMatching', () => {
  it('paginates past one 1000-row window instead of silently capping (recurring pattern #3)', async () => {
    // Page 1 is FULL (PAGE_SIZE rows) so the loop must fetch page 2; page 2
    // is short, ending the loop. A capped implementation would return 1000.
    const page1 = Array.from({ length: PAGE_SIZE }, (_, i) => matchRow(i));
    const page2 = [matchRow(PAGE_SIZE)];
    let call = 0;
    const stub = makeSupabaseStub({
      'inventory_items.select': () => ({
        data: call++ === 0 ? page1 : page2,
        error: null,
      }),
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    const rows = await svc.listForMatching();

    expect(rows).toHaveLength(PAGE_SIZE + 1);
    expect(rows[0]).toEqual(matchRow(0));
    expect(rows[PAGE_SIZE]).toEqual(matchRow(PAGE_SIZE));

    // Two windowed queries were issued with stable id ordering.
    const allChains = stub.chainsAll.get('inventory_items.select') ?? [];
    const allArgs = stub.chainArgsAll.get('inventory_items.select') ?? [];
    expect(allChains).toHaveLength(2);
    for (const chain of allChains) expect(chain).toContain('order');
    const ranges = allArgs.map((args, q) => {
      const idx = allChains[q]?.indexOf('range') ?? -1;
      return args[idx];
    });
    expect(ranges).toEqual([
      [0, PAGE_SIZE - 1],
      [PAGE_SIZE, 2 * PAGE_SIZE - 1],
    ]);
  });

  it('selects ONLY the lean matcher columns and applies the org/active/non-deleted posture', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [matchRow(1)], error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await svc.listForMatching();

    const chain = stub.chainsAll.get('inventory_items.select')?.[0] ?? [];
    const args = stub.chainArgsAll.get('inventory_items.select')?.[0] ?? [];
    expect(args[chain.indexOf('select')]?.[0]).toBe(LEAN_COLUMNS);

    const eqCalls = chain
      .map((m, i) => ({ m, args: args[i] }))
      .filter((c) => c.m === 'eq');
    const eqMap = new Map(eqCalls.map((c) => [c.args![0] as string, c.args![1]]));
    expect(eqMap.get('organization_id')).toBe('org-test');
    expect(eqMap.get('status')).toBe('active');
    expect(eqMap.get('is_rental')).toBe(false);
    // ALL item types offered for matching — no item_type filter.
    expect(eqMap.has('item_type')).toBe(false);
    expect(args[chain.indexOf('is')]).toEqual(['deleted_at', null]);
  });

  it('fails closed for a warehouse-scoped user with zero assignments (no query issued)', async () => {
    vi.mocked(getWarehouseAccess).mockResolvedValue({
      readableIds: [],
      writableIds: [],
      hasAllAccess: false,
      primaryWarehouseId: null,
    });
    const stub = makeSupabaseStub();
    const svc = new InventoryService(makeServiceContext(stub.client, { role: 'staff' }));

    await expect(svc.listForMatching()).resolves.toEqual([]);
    expect(stub.chainsAll.get('inventory_items.select')).toBeUndefined();
  });

  it('scopes warehouse-restricted users to their readable warehouses', async () => {
    vi.mocked(getWarehouseAccess).mockResolvedValue({
      readableIds: ['wh-1', 'wh-2'],
      writableIds: ['wh-1', 'wh-2'],
      hasAllAccess: false,
      primaryWarehouseId: 'wh-1',
    });
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [], error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client, { role: 'staff' }));

    await svc.listForMatching();

    const chain = stub.chainsAll.get('inventory_items.select')?.[0] ?? [];
    const args = stub.chainArgsAll.get('inventory_items.select')?.[0] ?? [];
    const inCalls = chain
      .map((m, i) => ({ m, args: args[i] }))
      .filter((c) => c.m === 'in');
    expect(inCalls).toEqual([
      { m: 'in', args: ['warehouse_id', ['wh-1', 'wh-2']] },
    ]);
  });
});
