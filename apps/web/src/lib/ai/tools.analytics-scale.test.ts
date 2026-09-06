import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServiceContext } from '@/server/services/context';

/**
 * SP-040 / SP-119 — the AI analytics + export tools at scale.
 *
 * Pattern #3 (reference_recurring_bug_patterns): PostgREST clamps EVERY
 * response to `[api] max_rows = 1000`, so a `.limit(50_000)` returns at most
 * 1000 rows with `error === null`. These tests model that clamp exactly — the
 * fake builder ignores the `.limit()` and honours `.range()` — so a tool that
 * issues one big `.select()` reports a truncated total and FAILS here, while a
 * `fetchAllRows`-paged tool sees the whole set.
 *
 * The movement tools have the same class of bug one layer down:
 * `MovementsService.list` does `Math.min(params.limit ?? 50, 1000)`, so
 * `limit: 10_000` silently becomes 1000. The MovementsService mock below
 * reproduces that clamp and honours `offset`.
 */

const inventoryListMock = vi.fn();
const movementsListMock = vi.fn();
const categoriesListMock = vi.fn();

vi.mock('@/server/services/inventory', () => ({
  InventoryService: class {
    list(...args: unknown[]) {
      return inventoryListMock(...args);
    }
  },
}));
vi.mock('@/server/services/movements', () => ({
  MovementsService: class {
    list(...args: unknown[]) {
      return movementsListMock(...args);
    }
  },
  getDashboardActions: vi.fn(),
  getDashboardSummary: vi.fn(),
  getLowStockItems: vi.fn(),
}));
vi.mock('@/server/services/categories', () => ({
  CategoriesService: class {
    list(...args: unknown[]) {
      return categoriesListMock(...args);
    }
  },
}));
vi.mock('@/server/services/suppliers', () => ({ SuppliersService: class {} }));
vi.mock('@/server/services/warehouses', () => ({ WarehousesService: class {} }));
vi.mock('@/server/services/order-requests', () => ({ OrderRequestsService: class {} }));
vi.mock('@/server/services/purchase-orders', () => ({ PurchaseOrdersService: class {} }));
vi.mock('@/server/services/bundles', () => ({ BundlesService: class {} }));
vi.mock('@/server/services/books-import', () => ({ BooksImportService: class {} }));
vi.mock('@/server/services/forecasting', () => ({
  getItemVelocity: vi.fn(),
  suggestReorderPoint: vi.fn(),
}));
vi.mock('@/lib/books/lookup', () => ({ lookupIsbn: vi.fn() }));
vi.mock('@/server/loaders/inventory-list', () => ({ revalidateInventoryList: vi.fn() }));
vi.mock('@/lib/env', () => ({
  env: {
    GEMINI_API_KEY: 'test-key',
    GEMINI_MODEL: 'gemini-2.0-flash',
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_MODEL: 'claude-haiku-4-5',
    NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.test',
    NEXT_PUBLIC_APP_URL: 'https://app.stockpilot.test',
  },
}));

import { TOOL_CATALOG } from './tools';

// ── A Supabase builder stub that behaves like PostgREST under max_rows ──────
//
// Every chained method returns the builder; awaiting it resolves to the rows
// the per-table `pages` function produces for the recorded `.range(from, to)`.
// When no `.range()` was called (the unpaged `.limit(50_000)` shape) the stub
// hands back the FIRST 1000-row window — which is precisely what the real API
// does, silently.
type Rows = Array<Record<string, unknown>>;
type TableSource = Rows | ((from: number, to: number) => Rows);

function makeSupabase(sources: Record<string, TableSource>) {
  const rangeCalls: Array<{ table: string; from: number; to: number }> = [];
  const from = (table: string) => {
    let range: { from: number; to: number } | null = null;
    const chain: Record<string | symbol, unknown> = {};
    const proxy: unknown = new Proxy(chain, {
      get(_t, prop) {
        if (prop === 'then') {
          const src = sources[table] ?? [];
          const win = range ?? { from: 0, to: 999 };
          const data = typeof src === 'function' ? src(win.from, win.to) : src;
          return (onFulfilled: (v: unknown) => unknown) =>
            Promise.resolve({ data, error: null }).then(onFulfilled);
        }
        return (...args: unknown[]) => {
          if (prop === 'range') {
            range = { from: args[0] as number, to: args[1] as number };
            rangeCalls.push({ table, from: range.from, to: range.to });
          }
          return proxy;
        };
      },
    });
    return proxy;
  };
  return { client: { from } as unknown as ServiceContext['supabase'], rangeCalls };
}

function ctxWith(supabase: ServiceContext['supabase']): ServiceContext {
  return {
    organizationId: 'org-x',
    userId: 'user-x',
    role: 'admin',
    supabase,
  } as ServiceContext;
}

/** 1,500 active items: 1,000 in w1 then 500 in w2 — one unit at $1 each. */
function itemPages(from: number, to: number): Rows {
  const rows: Rows = [];
  for (let i = from; i <= Math.min(to, 1499); i += 1) {
    rows.push({
      id: `item-${String(i).padStart(5, '0')}`,
      warehouse_id: i < 1000 ? 'w1' : 'w2',
      category_id: i < 1000 ? 'c1' : 'c2',
      quantity_on_hand: 1,
      unit_cost: 1,
    });
  }
  return rows;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SP-040: inventory aggregation tools page past the 1000-row clamp', () => {
  it('inventoryByWarehouse counts all 1,500 rows, not the first 1,000', async () => {
    const { client, rangeCalls } = makeSupabase({
      inventory_items: itemPages,
      warehouses: [
        { id: 'w1', name: 'DC4' },
        { id: 'w2', name: 'North' },
      ],
    });

    const res = (await TOOL_CATALOG.inventoryByWarehouse!.execute({}, ctxWith(client))) as {
      totals: { itemCount: number; totalUnits: number; totalValue: number };
      rows: Array<{ warehouseId: string | null; itemCount: number }>;
      truncated: boolean;
    };

    expect(res.totals.itemCount).toBe(1500);
    expect(res.totals.totalUnits).toBe(1500);
    expect(res.totals.totalValue).toBe(1500);
    // Both warehouses must be represented — the w2 rows live entirely past
    // the clamp, so the pre-fix code reported a single-warehouse split.
    expect(res.rows.map((r) => r.warehouseId).sort()).toEqual(['w1', 'w2']);
    expect(res.truncated).toBe(false);
    // Proof the fix is paging, not a bigger .limit(): more than one window.
    expect(rangeCalls.filter((r) => r.table === 'inventory_items').length).toBeGreaterThan(1);
  });

  it('inventoryByCategory counts all 1,500 rows across both categories', async () => {
    const { client } = makeSupabase({
      inventory_items: itemPages,
      categories: [
        { id: 'c1', name: 'Swag' },
        { id: 'c2', name: 'Books' },
      ],
    });

    const res = (await TOOL_CATALOG.inventoryByCategory!.execute({}, ctxWith(client))) as {
      totals: { itemCount: number };
      rows: Array<{ categoryId: string | null }>;
      truncated: boolean;
    };

    expect(res.totals.itemCount).toBe(1500);
    expect(res.rows.map((r) => r.categoryId).sort()).toEqual(['c1', 'c2']);
    expect(res.truncated).toBe(false);
  });

  it('listCategories counts items past the clamp (its comment claimed "≤500 rows max")', async () => {
    categoriesListMock.mockResolvedValue([
      { id: 'c1', name: 'Swag' },
      { id: 'c2', name: 'Books' },
    ]);
    const { client } = makeSupabase({ inventory_items: itemPages });

    const res = (await TOOL_CATALOG.listCategories!.execute({}, ctxWith(client))) as {
      categories: Array<{ id: string; itemCount: number }>;
      itemCountsTruncated: boolean;
    };

    const byId = new Map(res.categories.map((c) => [c.id, c.itemCount]));
    expect(byId.get('c1')).toBe(1000);
    // c2's 500 items live entirely past the 1000-row clamp — pre-fix this was 0,
    // and the model would have called "Books" an empty category.
    expect(byId.get('c2')).toBe(500);
    expect(res.itemCountsTruncated).toBe(false);
  });
});

describe('SP-040: movement analytics tools page past MovementsService clamp', () => {
  /** 1,300 movements. Rows 0-1199 belong to `item-hot`; row 1200 is the ONLY
   *  movement `item-late` ever had — it lives past the 1000-row clamp. */
  const ALL_MOVEMENTS = Array.from({ length: 1300 }, (_, i) => ({
    id: `mv-${String(i).padStart(5, '0')}`,
    item_id: i === 1200 ? 'item-late' : 'item-hot',
    quantity_change: -1,
    created_at: i < 1000 ? '2026-09-01T10:00:00.000Z' : '2026-08-01T10:00:00.000Z',
    item: { id: i === 1200 ? 'item-late' : 'item-hot', name: 'Thing', sku: 'SKU-1' },
  }));

  function programMovementsClamp() {
    // Mirrors movements.ts:126 `Math.min(params.limit ?? 50, 1000)` + the
    // `.range(offset, offset + limit - 1)` window.
    movementsListMock.mockImplementation(async (params: { limit?: number; offset?: number }) => {
      const limit = Math.min(params?.limit ?? 50, 1000);
      const offset = Math.max(0, params?.offset ?? 0);
      return ALL_MOVEMENTS.slice(offset, offset + limit);
    });
  }

  it('getDailyMovementCounts totals all 1,300 movements', async () => {
    programMovementsClamp();
    const { client } = makeSupabase({});
    const res = (await TOOL_CATALOG.getDailyMovementCounts!.execute(
      { days: 90 },
      ctxWith(client),
    )) as { total: number; truncated: boolean };

    expect(res.total).toBe(1300);
    expect(res.truncated).toBe(false);
  });

  it('getTopMovers sees the item whose only movement is past row 1,000', async () => {
    programMovementsClamp();
    const { client } = makeSupabase({});
    const res = (await TOOL_CATALOG.getTopMovers!.execute(
      { days: 90, order: 'least', limit: 50 },
      ctxWith(client),
    )) as { items: Array<{ itemId: string; movementCount: number }>; truncated: boolean };

    expect(res.items.map((i) => i.itemId)).toContain('item-late');
    expect(res.truncated).toBe(false);
  });

  it('getStaleItems does not call an item dead when its movement is past row 1,000', async () => {
    programMovementsClamp();
    inventoryListMock.mockResolvedValue({
      total: 2,
      items: [
        { id: 'item-late', name: 'Late mover', sku: 'L-1', quantity_on_hand: 5, unit_cost: 2 },
        { id: 'item-never', name: 'Never moved', sku: 'N-1', quantity_on_hand: 1, unit_cost: 1 },
      ],
    });
    const { client } = makeSupabase({});
    const res = (await TOOL_CATALOG.getStaleItems!.execute(
      { days: 90 },
      ctxWith(client),
    )) as { items: Array<{ id: string }>; truncated: boolean };

    const ids = res.items.map((i) => i.id);
    expect(ids).toContain('item-never');
    // The whole point: item-late DID move inside the window, just not in the
    // newest 1,000 rows. Reporting it as dead stock is the production failure.
    expect(ids).not.toContain('item-late');
    expect(res.truncated).toBe(false);
  });
});

describe('SP-119: exportInventory advertises a count the CSV can actually match', () => {
  it('does not scope the count probe to a warehouse the export URL cannot carry', async () => {
    inventoryListMock.mockResolvedValue({ total: 413, items: [] });
    const { client } = makeSupabase({});

    const res = (await TOOL_CATALOG.exportInventory!.execute(
      { warehouseId: 'wh-dc4' },
      ctxWith(client),
    )) as { count: number; url: string; warning?: string };

    // The route (api/inventory/export.csv) reads its warehouse from the
    // cookie-backed getActiveWarehouseFilterFor, never from a query param —
    // so a warehouse-scoped probe count labels a file that ignores it.
    expect(inventoryListMock).toHaveBeenCalledWith(
      expect.objectContaining({ warehouseId: null }),
    );
    expect(res.url).not.toContain('wh-dc4');
    expect(typeof res.warning).toBe('string');
    expect(res.warning).toMatch(/warehouse/i);
  });

  it('carries no warning when the caller asked for no warehouse', async () => {
    inventoryListMock.mockResolvedValue({ total: 10, items: [] });
    const { client } = makeSupabase({});

    const res = (await TOOL_CATALOG.exportInventory!.execute({}, ctxWith(client))) as {
      count: number;
      warning?: string;
    };

    expect(res.count).toBe(10);
    expect(res.warning).toBeUndefined();
  });
});
