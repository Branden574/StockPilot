import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Books page's server chain before rows: the two module checks run
 * together, the books gate still answers before any book is read, and the
 * table's reads start in the same Promise.all as the header (the racks RPC),
 * not after it. The service context (whose GoTrue factors read every later
 * read waits on) starts beside the gate, not after it: it reads no book. Same reasoning as the Items page (inventory/page.chain.test):
 * calls to Supabase stall 1-8 s on 3-5% of weekday calls (logs, 2026-09-22),
 * and a stall anywhere in a serial chain stalls the page.
 */

const events: string[] = [];

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = async () => {
  for (let i = 0; i < 25; i++) await new Promise((r) => setTimeout(r, 0));
};

const h = vi.hoisted(() => ({
  role: 'manager' as string,
  booksEnabled: true,
  booksGate: null as null | Promise<void>,
  racksGate: null as null | Promise<string[]>,
  datasetGate: null as null | Promise<void>,
  savedViewsError: null as null | Error,
}));

const m = vi.hoisted(() => ({
  checkModuleAccess: vi.fn(),
  requireOrgContext: vi.fn(),
  withContext: vi.fn(),
  listDistinctRacks: vi.fn(),
  savedViewsList: vi.fn(),
  loadInventoryList: vi.fn(),
  loadInventoryDataset: vi.fn(),
  loadInventoryLookups: vi.fn(),
  loadInventoryTrendBuckets: vi.fn(),
  resolveInventoryListImages: vi.fn(),
  inventoryList: vi.fn(),
  tableProps: vi.fn(),
  notEnabledProps: vi.fn(),
}));

vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
  };
});
vi.mock('@/lib/modules/module-gate', () => ({ checkModuleAccess: m.checkModuleAccess }));
vi.mock('@/components/dashboard/module-not-enabled', () => ({
  ModuleNotEnabled: (props: Record<string, unknown>) => {
    m.notEnabledProps(props);
    return null;
  },
}));
vi.mock('@/components/books/backfill-covers-button', () => ({ BackfillCoversButton: () => null }));
vi.mock('@/components/inventory/refresh-book-prices-button', () => ({
  RefreshBookPricesButton: () => null,
}));
vi.mock('@/components/ui/archive-view-toggle', () => ({ ArchiveViewToggle: () => null }));
vi.mock('@/components/inventory/rack-filter-dropdown', () => ({ RackFilterDropdown: () => null }));
vi.mock('@/components/ui/button', () => ({
  Button: ({ children }: { children: unknown }) => children,
}));
vi.mock('@/components/ui/empty-state', () => ({ EmptyState: () => null }));
vi.mock('@/components/perf/perf-useful', () => ({
  PerfUseful: ({ children }: { children: unknown }) => children,
}));
vi.mock('@/components/books/books-inventory-table', () => ({
  BooksInventoryTable: (props: Record<string, unknown>) => {
    m.tableProps(props);
    return null;
  },
}));

vi.mock('@/lib/auth/session', () => ({ requireOrgContext: m.requireOrgContext }));
vi.mock('@/server/services/context', () => ({ withContext: m.withContext }));
vi.mock('@/lib/nav-labels', () => ({ effectiveNavLabel: vi.fn(async () => 'Books') }));
vi.mock('@/lib/warehouse-filter', () => ({ getActiveWarehouseFilter: vi.fn(async () => null) }));

vi.mock('@/server/loaders/inventory-list', async () => {
  const core = await import('@stockpilot/core');
  return {
    ALL_WAREHOUSES_KEY: '__all__',
    // Same rule as the real gate (loaders/inventory-list.ts).
    canUseSharedInventoryCaches: (ctx: { role: string }) =>
      core.isManagerOrAbove(ctx.role as never) && core.can(ctx as never, 'items:read'),
    isDefaultInventoryView: (params: Record<string, unknown>) =>
      Object.values(params).every((v) => v === undefined),
    deriveInventoryTrends: () => new Map(),
    loadInventoryList: m.loadInventoryList,
    loadInventoryDataset: m.loadInventoryDataset,
    loadInventoryLookups: m.loadInventoryLookups,
    loadInventoryTrendBuckets: m.loadInventoryTrendBuckets,
    resolveInventoryListImages: m.resolveInventoryListImages,
  };
});

vi.mock('@/server/services/inventory', () => ({
  InventoryService: {
    forCurrentUser: vi.fn(async () => ({
      listDistinctRacks: m.listDistinctRacks,
      list: m.inventoryList,
      countExpected: vi.fn(async () => 0),
    })),
  },
}));
vi.mock('@/server/services/item-images', () => ({
  ItemImagesService: {
    forCurrentUser: vi.fn(async () => ({
      primaryImagesWithThumbsForItems: vi.fn(async () => new Map()),
    })),
  },
}));
vi.mock('@/server/services/movements', () => ({ getItemTrends: vi.fn(async () => new Map()) }));
vi.mock('@/server/services/saved-views', () => ({
  SavedViewsService: { forCurrentUser: vi.fn(async () => ({ list: m.savedViewsList })) },
}));
const lookupSvc = vi.hoisted(() => (method: string) => ({
  forCurrentUser: async () => ({ [method]: async () => [] }),
}));
vi.mock('@/server/services/categories', () => ({ CategoriesService: lookupSvc('list') }));
vi.mock('@/server/services/locations', () => ({ LocationsService: lookupSvc('list') }));
vi.mock('@/server/services/suppliers', () => ({
  SuppliersService: lookupSvc('listForLookups'),
}));
vi.mock('@/server/services/tags', () => ({ TagsService: lookupSvc('list') }));
vi.mock('@/server/services/charters', () => ({ ChartersService: lookupSvc('list') }));

import BooksPage from './page';

const BOOK = {
  id: 'book-1',
  name: 'Dune',
  sku: 'BK-1',
  status: 'active',
  quantity_on_hand: 3,
  awaiting_first_receipt: false,
};
const LOOKUPS = { categories: [], locations: [], suppliers: [], tags: [], charters: [] };

function logged<T>(name: string, fn: () => Promise<T>): Promise<T> {
  events.push(`${name}:start`);
  return fn().then(
    (v) => {
      events.push(`${name}:end`);
      return v;
    },
    (e: unknown) => {
      events.push(`${name}:error`);
      throw e;
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  events.length = 0;
  h.role = 'manager';
  h.booksEnabled = true;
  h.booksGate = null;
  h.racksGate = null;
  h.datasetGate = null;
  h.savedViewsError = null;

  m.checkModuleAccess.mockImplementation((id: string) =>
    logged(`module:${id}`, async () => {
      if (id === 'books' && h.booksGate) await h.booksGate;
      return { enabled: id === 'books' ? h.booksEnabled : true, canManage: true };
    }),
  );
  m.requireOrgContext.mockImplementation(() =>
    logged('ctx', async () => ({ organizationId: 'org-1', userId: 'u-1', role: h.role })),
  );
  m.withContext.mockImplementation(() =>
    logged('withContext', async () => ({ organizationId: 'org-1', userId: 'u-1', role: h.role })),
  );
  m.listDistinctRacks.mockImplementation(() =>
    logged('racks', async () => (h.racksGate ? h.racksGate : ['B-1'])),
  );
  m.savedViewsList.mockImplementation(() =>
    logged('savedViews', async () => {
      if (h.savedViewsError) throw h.savedViewsError;
      return [{ id: 'v1' }];
    }),
  );
  m.loadInventoryDataset.mockImplementation(() =>
    logged('dataset', async () => {
      if (h.datasetGate) await h.datasetGate;
      return { items: [BOOK], placement: {} };
    }),
  );
  m.loadInventoryList.mockImplementation(() => logged('list', async () => null));
  m.loadInventoryLookups.mockImplementation(async () => LOOKUPS);
  m.loadInventoryTrendBuckets.mockImplementation(async () => ({}));
  m.resolveInventoryListImages.mockImplementation((_org: string, items: unknown[]) =>
    logged('images', async () => items),
  );
  m.inventoryList.mockImplementation(() =>
    logged('liveList', async () => ({ items: [BOOK], total: 1, valueOnHand: 3 })),
  );
});

let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};
beforeEach(() => {
  unhandled = [];
  process.on('unhandledRejection', onUnhandled);
});
afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
});

function callPage(params: Record<string, string> = {}) {
  return BooksPage({ searchParams: Promise.resolve(params) });
}

describe('Books page: server chain before rows', () => {
  it('the price_tracking check runs alongside the books gate, not after it', async () => {
    const books = deferred<void>();
    h.booksGate = books.promise;

    const page = callPage();
    await flush();
    expect(events).toContain('module:price_tracking:start');
    expect(events).not.toContain('module:books:end');

    books.resolve();
    render(await page);
    expect(m.tableProps).toHaveBeenCalledTimes(1);
  });

  it('the service context starts beside the books gate, before it answers', async () => {
    const books = deferred<void>();
    h.booksGate = books.promise;

    const page = callPage();
    await flush();
    // Started while the gate is still open: GoTrue's factors read no longer
    // waits for the gate's own round trip.
    expect(events).toContain('withContext:start');
    expect(events).not.toContain('module:books:end');

    books.resolve();
    render(await page);
    expect(m.tableProps).toHaveBeenCalledTimes(1);
  });

  it('a context that fails while the gate says no is observed, and the page is the not-enabled screen', async () => {
    h.booksEnabled = false;
    m.withContext.mockImplementation(() => logged('withContext', async () => {
      throw new Error('context read failed');
    }));

    render(await callPage());
    await flush();
    expect(m.notEnabledProps).toHaveBeenCalledWith(expect.objectContaining({ moduleId: 'books' }));
    expect(unhandled).toEqual([]);
  });

  it('nothing is read until the books gate answers, and nothing at all when it says no', async () => {
    const books = deferred<void>();
    h.booksGate = books.promise;
    h.booksEnabled = false;

    const page = callPage();
    await flush();
    expect(m.requireOrgContext).not.toHaveBeenCalled();
    expect(m.savedViewsList).not.toHaveBeenCalled();
    expect(m.loadInventoryDataset).not.toHaveBeenCalled();
    expect(m.listDistinctRacks).not.toHaveBeenCalled();

    books.resolve();
    render(await page);
    expect(m.notEnabledProps).toHaveBeenCalledWith(
      expect.objectContaining({ moduleId: 'books', canManage: true }),
    );
    expect(m.savedViewsList).not.toHaveBeenCalled();
    expect(m.loadInventoryDataset).not.toHaveBeenCalled();
    expect(m.inventoryList).not.toHaveBeenCalled();
    expect(m.listDistinctRacks).not.toHaveBeenCalled();
    expect(m.tableProps).not.toHaveBeenCalled();
  });

  it('manager: saved views and the dataset start while the racks read is still open', async () => {
    const racks = deferred<string[]>();
    h.racksGate = racks.promise;

    const page = callPage();
    await flush();
    expect(events).toContain('racks:start');
    expect(events).not.toContain('racks:end');
    expect(events).toEqual(expect.arrayContaining(['savedViews:start', 'dataset:start']));

    racks.resolve(['B-1']);
    render(await page);
    expect(events.indexOf('dataset:start')).toBeLessThan(events.indexOf('racks:end'));
    expect(m.tableProps.mock.calls[0]![0]).toMatchObject({
      savedViews: [{ id: 'v1' }],
      currentUserId: 'u-1',
    });
  });

  it('staff: the RLS-scoped list starts while the racks read is open; no shared cache is read', async () => {
    h.role = 'staff';
    const racks = deferred<string[]>();
    h.racksGate = racks.promise;

    const page = callPage();
    await flush();
    expect(events).not.toContain('racks:end');
    expect(events).toEqual(expect.arrayContaining(['savedViews:start', 'liveList:start']));

    racks.resolve([]);
    render(await page);
    expect(m.loadInventoryDataset).not.toHaveBeenCalled();
    expect(m.loadInventoryList).not.toHaveBeenCalled();
    expect(m.loadInventoryLookups).not.toHaveBeenCalled();
    expect(m.loadInventoryTrendBuckets).not.toHaveBeenCalled();
  });

  it('every early rejection is observed: racks and saved views both failing leave nothing unhandled', async () => {
    const racks = deferred<string[]>();
    const dataset = deferred<void>();
    h.racksGate = racks.promise;
    h.datasetGate = dataset.promise;
    h.savedViewsError = new Error('saved views down');

    const page = callPage();
    page.catch(() => {});
    await flush();
    expect(events).toContain('savedViews:error');
    racks.reject(new Error('racks down'));
    await expect(page).rejects.toThrow('racks down');

    dataset.resolve();
    await flush();
    expect(unhandled).toEqual([]);
  });
});
