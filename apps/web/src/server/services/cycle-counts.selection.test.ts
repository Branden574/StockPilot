import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

// Services call the warehouse helpers directly. Default mock = full access;
// individual tests override per-call.
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({
    readableIds: ['wh-a', 'wh-b'],
    writableIds: ['wh-a', 'wh-b'],
    hasAllAccess: true,
    primaryWarehouseId: 'wh-a',
  })),
  assertWarehouseAccess: vi.fn(),
  forcedWarehouseId: vi.fn(async () => null),
  ForbiddenError: class ForbiddenError extends Error {
    readonly code = 'forbidden' as const;
  },
}));

vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    userId: 'user-test',
    organizationId: 'org-test',
    role: 'admin',
  })),
}));

import { assertWarehouseAccess, getWarehouseAccess } from '@/lib/auth/warehouse';
import { CycleCountsService } from './cycle-counts';
import { ServiceError } from './context';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getWarehouseAccess).mockResolvedValue({
    readableIds: ['wh-a', 'wh-b'],
    writableIds: ['wh-a', 'wh-b'],
    hasAllAccess: true,
    primaryWarehouseId: 'wh-a',
  });
});

describe('CycleCountsService.start (selection scope)', () => {
  it('snapshots only the selected active items into a scope=selection count', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': {
        data: [
          { id: 'i1', quantity_on_hand: 5, warehouse_id: 'wh-a' },
          { id: 'i2', quantity_on_hand: 3, warehouse_id: 'wh-a' },
        ],
        error: null,
      },
      'cycle_counts.insert': { data: [{ id: 'cc-1' }], error: null },
      'cycle_count_lines.insert': { data: null, error: null },
    });
    const svc = new CycleCountsService(makeServiceContext(stub.client));

    const result = await svc.start({
      scope: 'selection',
      warehouseId: null,
      itemIds: ['i1', 'i2'],
    });

    expect(result).toEqual({ id: 'cc-1', lineCount: 2, skipped: 0 });

    // Header insert: scope=selection, warehouse_id forced null.
    const ccInsertArgs = stub.chainArgsAll.get('cycle_counts.insert')?.[0]?.[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(ccInsertArgs.scope).toBe('selection');
    expect(ccInsertArgs.warehouse_id).toBeNull();

    // Line insert: one per item, each carrying its own warehouse + qty snapshot.
    const lineArgs = stub.chainArgsAll.get('cycle_count_lines.insert')?.[0]?.[0]?.[0] as Array<
      Record<string, unknown>
    >;
    expect(lineArgs).toHaveLength(2);
    expect(lineArgs[0]).toMatchObject({ item_id: 'i1', warehouse_id: 'wh-a', expected_quantity: 5 });
    expect(lineArgs[1]).toMatchObject({ item_id: 'i2', warehouse_id: 'wh-a', expected_quantity: 3 });
  });

  it('reports skipped items when some picks are no longer active', async () => {
    const stub = makeSupabaseStub({
      // Only one of the two requested ids comes back active.
      'inventory_items.select': {
        data: [{ id: 'i1', quantity_on_hand: 5, warehouse_id: 'wh-a' }],
        error: null,
      },
      'cycle_counts.insert': { data: [{ id: 'cc-1' }], error: null },
    });
    const svc = new CycleCountsService(makeServiceContext(stub.client));

    const result = await svc.start({
      scope: 'selection',
      warehouseId: null,
      itemIds: ['i1', 'i2-archived'],
    });

    expect(result).toEqual({ id: 'cc-1', lineCount: 1, skipped: 1 });
  });

  it('throws validation_error when no selected item is still active', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [], error: null },
    });
    const svc = new CycleCountsService(makeServiceContext(stub.client));

    await expect(
      svc.start({ scope: 'selection', warehouseId: null, itemIds: ['gone'] }),
    ).rejects.toBeInstanceOf(ServiceError);
  });

  it('asserts WRITE access to every distinct warehouse in the selection', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': {
        data: [
          { id: 'i1', quantity_on_hand: 5, warehouse_id: 'wh-a' },
          { id: 'i2', quantity_on_hand: 3, warehouse_id: 'wh-b' },
          { id: 'i3', quantity_on_hand: 1, warehouse_id: 'wh-a' },
        ],
        error: null,
      },
      'cycle_counts.insert': { data: [{ id: 'cc-1' }], error: null },
    });
    const svc = new CycleCountsService(makeServiceContext(stub.client));

    await svc.start({ scope: 'selection', warehouseId: null, itemIds: ['i1', 'i2', 'i3'] });

    const whCalls = vi.mocked(assertWarehouseAccess).mock.calls.map((c) => [c[0], c[1]]);
    expect(whCalls).toEqual(expect.arrayContaining([['wh-a', 'write'], ['wh-b', 'write']]));
    // Distinct only — wh-a appears once despite two items.
    expect(whCalls.filter((c) => c[0] === 'wh-a')).toHaveLength(1);
  });

  it('delegates to assign() when assignedTo is provided (fires notify trigger)', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': {
        data: [{ id: 'i1', quantity_on_hand: 5, warehouse_id: 'wh-a' }],
        error: null,
      },
      'cycle_counts.insert': { data: [{ id: 'cc-1' }], error: null },
    });
    const svc = new CycleCountsService(makeServiceContext(stub.client));
    const assignSpy = vi
      .spyOn(svc, 'assign')
      .mockResolvedValue({ id: 'cc-1', assigned_to: 'user-9' } as never);

    await svc.start({
      scope: 'selection',
      warehouseId: null,
      itemIds: ['i1'],
      assignedTo: 'user-9',
    });

    expect(assignSpy).toHaveBeenCalledWith('cc-1', 'user-9');
  });
});

describe('CycleCountsService.itemsInScopeCount', () => {
  it('returns 0 for a selection-scoped count (no "new items" concept)', async () => {
    const stub = makeSupabaseStub({
      'cycle_counts.select': {
        data: [{ warehouse_id: null, status: 'in_progress', scope: 'selection' }],
        error: null,
      },
    });
    const svc = new CycleCountsService(makeServiceContext(stub.client));

    const n = await svc.itemsInScopeCount('cc-1');
    expect(n).toBe(0);
    // It must not even query inventory_items for a selection count.
    expect(stub.fromCalls).not.toContain('inventory_items');
  });
});
