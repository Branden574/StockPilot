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

const LEAN_COLUMNS = 'id, sku, name, unit_cost, group_id, variant_size';

function variantRow(i: number, groupId = 'g1') {
  return {
    id: `item-${String(i).padStart(5, '0')}`,
    sku: `SKU-${i}`,
    name: `Variant ${i}`,
    unit_cost: 10,
    group_id: groupId,
    variant_size: String(i),
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

describe('InventoryService.listGroupVariants', () => {
  it('paginates past one 1000-row window instead of silently capping — the 1001st variant appears (Task 16 review fix)', async () => {
    // Page 1 is FULL (PAGE_SIZE rows) so the loop must fetch page 2, which
    // carries the 1001st variant. A capped implementation (list({limit:1000}))
    // would never surface this row at all.
    const page1 = Array.from({ length: PAGE_SIZE }, (_, i) => variantRow(i));
    const the1001st = variantRow(PAGE_SIZE);
    const page2 = [the1001st];
    let call = 0;
    const stub = makeSupabaseStub({
      'inventory_items.select': () => ({
        data: call++ === 0 ? page1 : page2,
        error: null,
      }),
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    const rows = await svc.listGroupVariants(['g1']);

    expect(rows).toHaveLength(PAGE_SIZE + 1);
    expect(rows).toContainEqual(the1001st);
  });

  it('short-circuits on an empty group id list without touching the DB', async () => {
    const stub = makeSupabaseStub({});
    const svc = new InventoryService(makeServiceContext(stub.client));
    expect(await svc.listGroupVariants([])).toEqual([]);
    expect(stub.fromCalls).toEqual([]);
  });

  it('selects only the size-run picker columns and scopes to org/active/non-deleted/non-rental', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [variantRow(1)], error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await svc.listGroupVariants(['g1']);

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
    expect(args[chain.indexOf('is')]).toEqual(['deleted_at', null]);

    const inCalls = chain
      .map((m, i) => ({ m, args: args[i] }))
      .filter((c) => c.m === 'in');
    expect(inCalls).toContainEqual({ m: 'in', args: ['group_id', ['g1']] });
  });

  it('chunks the group-id filter into batches instead of one unbounded `.in()`', async () => {
    const manyGroupIds = Array.from({ length: 1200 }, (_, i) => `grp-${i}`);
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [], error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await svc.listGroupVariants(manyGroupIds);

    // 1200 ids at 500/batch = 3 batches, each its own query.
    const chains = stub.chainsAll.get('inventory_items.select') ?? [];
    const argsAll = stub.chainArgsAll.get('inventory_items.select') ?? [];
    expect(chains).toHaveLength(3);
    const batchSizes = chains.map((chain, q) => {
      const idx = chain.indexOf('in');
      const args = argsAll[q]?.[idx] as [string, string[]];
      return args[1].length;
    });
    expect(batchSizes).toEqual([500, 500, 200]);
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

    await expect(svc.listGroupVariants(['g1'])).resolves.toEqual([]);
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

    await svc.listGroupVariants(['g1']);

    const chain = stub.chainsAll.get('inventory_items.select')?.[0] ?? [];
    const args = stub.chainArgsAll.get('inventory_items.select')?.[0] ?? [];
    const inCalls = chain
      .map((m, i) => ({ m, args: args[i] }))
      .filter((c) => c.m === 'in');
    expect(inCalls).toContainEqual({ m: 'in', args: ['warehouse_id', ['wh-1', 'wh-2']] });
  });
});
