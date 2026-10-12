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

import { buildRackFilterClause, InventoryService, type ItemListFilters } from './inventory';

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

describe("list()'s page, its value scan and the plan scan take one set of filters", () => {
  // PR #364 review: the scans kept their own copy of list()'s filters and
  // missed `?rack=` (and unit cost, and ids), so a staff member's rack view was
  // planned over the WHOLE view: "Page 1 of 17", the whole view's total and
  // value, and pages with nothing on them. Every filter now comes from one
  // place (applyContentFilters); these cases pin that the three queries agree.
  const UUID_A = '11111111-1111-4111-8111-111111111111';
  const UUID_B = '22222222-2222-4222-8222-222222222222';
  const CASES: Array<[string, ItemListFilters]> = [
    ['the default view', {}],
    ['a search', { q: 'tee' }],
    ['a search with ISBN variants', { q: '9780306406157', isbnVariants: ['0306406152'] }],
    ['a barcode', { barcode: '0123' }],
    ['a rack', { rack: '17-B' }],
    ['a rack number', { rack: '17' }],
    ['a Books rack', { rack: '17-B', itemType: 'book' }],
    ['a rack over every type', { rack: '17-B', itemType: 'all' }],
    ['a status', { status: 'archived' }],
    ['every status', { status: 'all' }],
    ['auto-archived', { status: 'archived', autoArchived: true }],
    ['expected items', { expected: true }],
    ['expected or not', { expected: 'any' }],
    ['categories', { categoryIds: [UUID_A, UUID_B] }],
    ['one category', { categoryId: UUID_A }],
    ['locations', { locationIds: [UUID_A] }],
    ['one location', { locationId: UUID_A }],
    ['suppliers', { supplierIds: [UUID_A] }],
    ['one supplier', { supplierId: UUID_A }],
    ['charters and Generic', { charterIds: ['generic', UUID_A] }],
    ['Generic only', { charterIds: ['generic'] }],
    ['charters', { charterIds: [UUID_A, UUID_B] }],
    ['out of stock', { outOfStock: true }],
    ['low stock', { lowStock: true }],
    ['with a unit cost', { hasUnitCost: true }],
    ['item types', { itemTypes: ['product', 'asset'] }],
    ['every type', { itemType: 'all' }],
    ['no bundles', { excludeBundles: true }],
    ['rentals', { rentalsOnly: true }],
    [
      'dates',
      {
        createdSince: '2026-01-01',
        createdUntil: '2026-02-01',
        updatedSince: '2026-03-01',
        updatedUntil: '2026-04-01',
      },
    ],
    ['ids', { ids: [UUID_A, UUID_B] }],
    ['a warehouse', { warehouseId: 'wh-a' }],
    [
      'everything at once',
      {
        q: 'tee',
        barcode: '0123',
        rack: '17-B',
        status: 'all',
        categoryIds: [UUID_A],
        locationIds: [UUID_B],
        supplierIds: [UUID_A],
        charterIds: ['generic', UUID_B],
        warehouseId: 'wh-a',
        outOfStock: true,
        lowStock: true,
        hasUnitCost: true,
        itemType: 'book',
        excludeBundles: true,
        createdSince: '2026-01-01',
        updatedUntil: '2026-04-01',
        expected: 'any',
        ids: [UUID_A],
      },
    ],
  ];

  const SHAPE = new Set(['select', 'order', 'range', 'limit']);
  const filtersOf = (methods: string[], args: unknown[][]) =>
    methods
      .map((m, k) => (SHAPE.has(m) ? null : `${m}:${JSON.stringify(args[k])}`))
      .filter((x): x is string => x !== null)
      .sort();

  const ACCESS = {
    staff: { readableIds: ['wh-a'], writableIds: ['wh-a'], hasAllAccess: false },
    manager: { readableIds: ['wh-a', 'wh-b'], writableIds: ['wh-a', 'wh-b'], hasAllAccess: true },
  } as const;

  for (const role of ['staff', 'manager'] as const) {
    it.each(CASES)(`%s: one set of filters (${role})`, async (_name, filters) => {
      vi.mocked(getWarehouseAccess).mockResolvedValue({
        ...ACCESS[role],
        readableIds: [...ACCESS[role].readableIds],
        writableIds: [...ACCESS[role].writableIds],
        primaryWarehouseId: 'wh-a',
      });
      const stub = makeSupabaseStub({
        'inventory_items.select': { data: [], error: null, count: 0 },
      });
      const svc = new InventoryService(makeServiceContext(stub.client, { role }));
      await svc.list({ ...filters, limit: 30, offset: 0 });
      await svc.listPlanRows(filters);
      const methods = stub.chainsAll.get('inventory_items.select')!;
      const args = stub.chainArgsAll.get('inventory_items.select')!;
      const isPage = (k: number) =>
        args[k]!.some(
          (a, i) => methods[k]![i] === 'select' && JSON.stringify(a).includes('"count":"exact"'),
        );
      const page = methods.findIndex((_m, k) => isPage(k));
      const scans = methods.map((_m, k) => k).filter((k) => !isPage(k));
      // One value-scan window (an empty view) and one plan window.
      expect(page).toBeGreaterThanOrEqual(0);
      expect(scans).toHaveLength(2);
      const want = filtersOf(methods[page]!, args[page]!);
      for (const k of scans) expect(filtersOf(methods[k]!, args[k]!)).toEqual(want);
    });
  }

  it("a rack view plans that rack's records, not the whole view", async () => {
    const clause = buildRackFilterClause('17-B', undefined);
    expect(clause.kind).toBe('or');
    const stub = makeSupabaseStub({
      'inventory_items.select': (call) => {
        // The database: three records on rack 17-B in a view of forty.
        const onRack = call.methods.some(
          (m, k) => clause.kind === 'or' && m === 'or' && call.args[k]![0] === clause.expr,
        );
        const n = onRack ? 3 : 40;
        return { data: Array.from({ length: n }, (_x, i) => lightRow(i)), error: null };
      },
    });
    const svc = new InventoryService(makeServiceContext(stub.client, { role: 'staff' }));
    const out = await svc.listPlanRows({ rack: '17-B' });
    expect(out!.total).toBe(3);
    expect(out!.rows).toHaveLength(3);
  });

  it('refuses more ids than one request carries, as list() does', async () => {
    const { stub } = viewStub(3);
    const svc = new InventoryService(makeServiceContext(stub.client, { role: 'staff' }));
    const ids = Array.from({ length: 101 }, (_x, i) => `id-${i}`);
    await expect(svc.listPlanRows({ ids })).rejects.toMatchObject({ code: 'validation_error' });
  });
});
