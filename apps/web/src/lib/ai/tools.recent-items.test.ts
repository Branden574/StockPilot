import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * getRecentItems names who created and updated each item. Up to 100 items
 * with two actors each is up to 200 ids, past what one `.in()` carries once
 * the rest of the URL is added (the local gateway refuses ~215 uuids). The
 * names now go 100 ids per request; a failed batch leaves them unnamed and is
 * reported, where it used to vanish silently.
 */

const { listMock, reportError } = vi.hoisted(() => ({
  listMock: vi.fn(),
  reportError: vi.fn(async () => {}),
}));

vi.mock('@/lib/error-reporter', () => ({ reportError }));
vi.mock('@/server/services/inventory', () => ({
  InventoryService: class {
    list(...args: unknown[]) {
      return listMock(...args);
    }
  },
}));
vi.mock('@/server/services/movements', () => ({
  MovementsService: class {},
  getDashboardActions: vi.fn(),
  getDashboardSummary: vi.fn(),
  getLowStockItems: vi.fn(),
}));
vi.mock('@/server/services/categories', () => ({ CategoriesService: class {} }));
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

import { inFilters, makeServiceContext, makeSupabaseStub, type MockCall } from '@/test/supabase-mock';

import { TOOL_CATALOG } from './tools';

const userId = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
// 100 items, each created by one user and updated by another: 200 actors.
const items = Array.from({ length: 100 }, (_, i) => ({
  id: `item-${i}`,
  name: `Item ${i}`,
  sku: `S-${i}`,
  quantity_on_hand: 1,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-02T00:00:00Z',
  created_by: userId(i),
  updated_by: userId(100 + i),
}));
const inList = (call: MockCall) =>
  (inFilters(call).find(([c]) => c === 'id')?.[1] ?? []) as string[];

beforeEach(() => {
  vi.clearAllMocks();
  listMock.mockResolvedValue({ total: 100, items });
});

describe('getRecentItems actor names', () => {
  it('reads 200 actors in batches of 100 and names the last one', async () => {
    const lists: string[][] = [];
    const stub = makeSupabaseStub({
      'user_profiles.select': (call) => {
        const ids = inList(call);
        lists.push(ids);
        return { data: ids.map((id) => ({ id, full_name: `User ${id.slice(-3)}`, email: null })), error: null };
      },
    });
    const out = (await TOOL_CATALOG.getRecentItems!.execute(
      { limit: 100 },
      makeServiceContext(stub.client) as never,
    )) as { items: Array<{ id: string; updatedBy: string }> };
    expect(lists.map((l) => l.length)).toEqual([100, 100]);
    expect(out.items.find((i) => i.id === 'item-99')?.updatedBy).toContain('User 199');
  });

  it('a failed batch leaves the names unknown and is reported, the tool still answers', async () => {
    let n = 0;
    const stub = makeSupabaseStub({
      'user_profiles.select': () =>
        ++n === 2 ? { data: null, error: { message: 'fetch failed' } } : { data: [], error: null },
    });
    const out = (await TOOL_CATALOG.getRecentItems!.execute(
      { limit: 100 },
      makeServiceContext(stub.client) as never,
    )) as { items: Array<{ createdBy: string }> };
    expect(out.items).toHaveLength(100);
    expect(out.items[0]!.createdBy).toContain('Unknown user');
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tag: 'ai.tools.recent_items.actors', level: 'warning' }),
    );
  });
});
