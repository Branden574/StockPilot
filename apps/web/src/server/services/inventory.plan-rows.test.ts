import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub, type MockCall } from '@/test/supabase-mock';

// Phase 2 of the grouping brief (owner 2026-10-11, go to start 2026-10-12):
// staff and viewers' Items and Books pages are planned group-aware over the
// WHOLE filtered view (planGroupAwarePage), so a size run, a SKU family or a
// display group is never split across their pages. listPlanRows reads that
// view as light rows, with list()'s own filters and scope, in 1000-row
// windows, and gives up (null) past the instant-mode cap so a big view keeps
// today's fixed pages. list() then reads exactly the planned page's ids and
// takes the planned totals instead of scanning the view again.

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
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    userId: 'user-test',
    organizationId: 'org-test',
    role: 'admin',
  })),
}));
const grants = vi.hoisted(() => ({ value: null as Set<string> | null }));
vi.mock('./user-categories', () => ({
  UserCategoriesService: class {
    async getGrantedCategoryIdsForViewer() {
      return grants.value;
    }
  },
}));

import { getWarehouseAccess } from '@/lib/auth/warehouse';

import { InventoryService } from './inventory';

const arg = (call: MockCall, method: string, col?: string) => {
  const i = call.methods.findIndex(
    (m, k) => m === method && (col === undefined || call.args[k]![0] === col),
  );
  return i >= 0 ? call.args[i] : undefined;
};

function lightRow(n: number, over: Record<string, unknown> = {}) {
  return {
    id: `id-${String(n).padStart(5, '0')}`,
    sku: `SKU-${n}`,
    name: `Item ${n}`,
    group_id: null,
    quantity_on_hand: 2,
    unit_cost: 3,
    reorder_point: 0,
    category_id: 'cat-1',
    status: 'active',
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    ...over,
  };
}

/** A view of `size` rows served in the windows the scan asks for. */
function viewStub(size: number, make = lightRow) {
  const windows: Array<[number, number]> = [];
  const stub = makeSupabaseStub({
    'inventory_items.select': (call) => {
      const r = arg(call, 'range') as [number, number] | undefined;
      const [from, to] = r ?? [0, 999];
      windows.push([from, to]);
      const out = [];
      for (let i = from; i <= Math.min(to, size - 1); i++) out.push(make(i));
      return { data: out, error: null };
    },
  });
  return { stub, windows };
}

beforeEach(() => {
  vi.clearAllMocks();
  grants.value = null;
  vi.mocked(getWarehouseAccess).mockResolvedValue({
    readableIds: ['wh-a'],
    writableIds: ['wh-a'],
    hasAllAccess: false,
    primaryWarehouseId: 'wh-a',
  });
});

describe('InventoryService.listPlanRows', () => {
  it("reads the whole filtered view as light rows in 1000-row windows, with list()'s filters and a staff member's own warehouses", async () => {
    const { stub, windows } = viewStub(3);
    const svc = new InventoryService(makeServiceContext(stub.client, { role: 'staff' }));
    const out = await svc.listPlanRows({ q: 'tee' });
    expect(out).not.toBeNull();
    expect(out!.rows.map((r) => r.id)).toEqual(['id-00000', 'id-00001', 'id-00002']);
    expect(out!.total).toBe(3);
    expect(out!.valueOnHand).toBe(18);
    expect(windows[0]).toEqual([0, 999]);
    const call = stub.chainArgsAll.get('inventory_items.select')![0]!;
    const methods = stub.chainsAll.get('inventory_items.select')![0]!;
    const cols = String(call[methods.indexOf('select')]![0]);
    for (const c of [
      'id',
      'sku',
      'name',
      'group_id',
      'quantity_on_hand',
      'unit_cost',
      'reorder_point',
      'category_id',
      'created_at',
      'updated_at',
    ]) {
      expect(cols.split(',').map((x) => x.trim())).toContain(c);
    }
    const find = (m: string, c: string) => call.find((a, k) => methods[k] === m && a[0] === c);
    expect(find('in', 'warehouse_id')).toEqual(['warehouse_id', ['wh-a']]);
    expect(find('eq', 'status')).toEqual(['status', 'active']);
    expect(find('eq', 'item_type')).toEqual(['item_type', 'product']);
    expect(find('eq', 'is_rental')).toEqual(['is_rental', false]);
    expect(methods).toContain('or'); // the search clause
  });

  it('plans a view of exactly 2000 records, and gives up on 2001 so a big view keeps fixed pages', async () => {
    const at = viewStub(2000);
    const svcAt = new InventoryService(makeServiceContext(at.stub.client, { role: 'staff' }));
    expect((await svcAt.listPlanRows({}))!.rows).toHaveLength(2000);
    const over = viewStub(2001);
    const svcOver = new InventoryService(makeServiceContext(over.stub.client, { role: 'staff' }));
    expect(await svcOver.listPlanRows({})).toBeNull();
  });

  it('applies the low-stock filter to the rows as list() does', async () => {
    const { stub } = viewStub(4, (n) => lightRow(n, { quantity_on_hand: n, reorder_point: 1 }));
    const svc = new InventoryService(makeServiceContext(stub.client, { role: 'staff' }));
    const out = await svc.listPlanRows({ lowStock: true });
    expect(out!.rows.map((r) => r.quantity_on_hand)).toEqual([0, 1]);
    expect(out!.total).toBe(2);
  });

  it('a staff member with no warehouse reads nothing', async () => {
    vi.mocked(getWarehouseAccess).mockResolvedValueOnce({
      readableIds: [],
      writableIds: [],
      hasAllAccess: false,
      primaryWarehouseId: null,
    });
    const { stub, windows } = viewStub(3);
    const svc = new InventoryService(makeServiceContext(stub.client, { role: 'staff' }));
    expect(await svc.listPlanRows({})).toEqual({ rows: [], total: 0, valueOnHand: 0 });
    expect(windows).toEqual([]);
  });

  it('keeps a viewer to their categories: none granted reads nothing, granted ones narrow the scan', async () => {
    grants.value = new Set();
    const none = viewStub(3);
    const svcNone = new InventoryService(makeServiceContext(none.stub.client, { role: 'viewer' }));
    expect(await svcNone.listPlanRows({})).toEqual({ rows: [], total: 0, valueOnHand: 0 });
    grants.value = new Set(['cat-1']);
    const some = viewStub(2, (n) => lightRow(n, { category_id: n === 0 ? 'cat-1' : 'cat-2' }));
    const svcSome = new InventoryService(makeServiceContext(some.stub.client, { role: 'viewer' }));
    const out = await svcSome.listPlanRows({});
    const call = some.stub.chainArgsAll.get('inventory_items.select')![0]!;
    const methods = some.stub.chainsAll.get('inventory_items.select')![0]!;
    expect(call.find((a, k) => methods[k] === 'in' && a[0] === 'category_id')).toEqual([
      'category_id',
      ['cat-1'],
    ]);
    // Whatever the scan returns, a record outside the grants never plans a page.
    expect(out!.rows.map((r) => r.category_id)).toEqual(['cat-1']);
  });
});

describe('InventoryService.list with planned totals', () => {
  it("reads exactly the planned page's ids, scans nothing else, and answers the planned totals", async () => {
    const calls: MockCall[] = [];
    const stub = makeSupabaseStub({
      'inventory_items.select': (call) => {
        calls.push(call);
        return { data: [], error: null, count: 0 };
      },
    });
    const svc = new InventoryService(makeServiceContext(stub.client, { role: 'staff' }));
    const out = await svc.list({
      ids: ['id-b', 'id-a'],
      limit: 2,
      offset: 0,
      plannedTotals: { total: 485, valueOnHand: 1234.5 },
    });
    // One read of inventory_items (the page), no value scan of the view.
    expect(calls).toHaveLength(1);
    expect(arg(calls[0]!, 'in', 'id')).toEqual(['id', ['id-b', 'id-a']]);
    expect(out.total).toBe(485);
    expect(out.valueOnHand).toBe(1234.5);
  });
});
