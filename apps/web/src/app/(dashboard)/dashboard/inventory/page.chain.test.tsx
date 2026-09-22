import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Items page starts its table's reads in the SAME Promise.all as the
 * header, not after it.
 *
 * The table used to be a child Server Component, which React only renders
 * once the page function has returned, i.e. after the racks RPC: every row
 * read queued behind one more Supabase round trip on each Dashboard ->
 * Inventory click, while calls to Supabase stall 1-8 s on 3-5% of weekday
 * calls (logs, 2026-09-22). These tests hold the header's racks read open and
 * check that the table's reads have already started; they also pin what must
 * NOT move: shared-cache reads wait for the org context and the role gate,
 * the instant dataset stays an unawaited promise created after the rows, and
 * every early promise's rejection is observed.
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
  ctxGate: null as null | Promise<void>,
  racksGate: null as null | Promise<string[]>,
  datasetGate: null as null | Promise<unknown>,
  listGate: null as null | Promise<void>,
  filter: null as string | null,
  savedViewsError: null as null | Error,
  listTotal: 2,
  /** Overrides the staff/viewer access answer (null: the default one). */
  access: null as null | Record<string, unknown>,
  /** Makes the request-cached warehouse NAME read report a failure. */
  namesFailed: false,
}));

const m = vi.hoisted(() => ({
  requireOrgContext: vi.fn(),
  listDistinctRacks: vi.fn(),
  savedViewsList: vi.fn(),
  loadInventoryList: vi.fn(),
  loadInventoryDataset: vi.fn(),
  loadInventoryLookups: vi.fn(),
  loadInventoryTrendBuckets: vi.fn(),
  resolveInventoryListImages: vi.fn(),
  inventoryList: vi.fn(),
  getWarehouseAccess: vi.fn(),
  getWarehousesForRequest: vi.fn(),
  loadCountingUnitsForOrg: vi.fn(),
  tableProps: vi.fn(),
  emptyStateProps: vi.fn(),
}));

vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
  };
});

vi.mock('@/components/ui/archive-view-toggle', () => ({ ArchiveViewToggle: () => null }));
vi.mock('@/components/inventory/rack-filter-dropdown', () => ({ RackFilterDropdown: () => null }));
vi.mock('@/components/ui/button', () => ({
  Button: ({ children }: { children: unknown }) => children,
}));
vi.mock('@/components/dashboard/scoped-warehouse-notice', () => ({
  ScopedWarehouseNotice: () => null,
}));
vi.mock('@/components/inventory/clear-warehouse-filter-button', () => ({
  ClearWarehouseFilterButton: () => null,
}));
vi.mock('@/components/onboarding/page-tour', () => ({ PageTour: () => null }));
vi.mock('@/components/onboarding/tour-sample-item', () => ({ TourSampleItem: () => null }));
vi.mock('@/components/perf/perf-useful', () => ({
  PerfUseful: ({ children }: { children: unknown }) => children,
}));
vi.mock('@/components/ui/empty-state', () => ({
  EmptyState: (props: Record<string, unknown>) => {
    m.emptyStateProps(props);
    return null;
  },
}));
vi.mock('@/components/inventory/inventory-table', () => ({
  InventoryTable: (props: Record<string, unknown>) => {
    m.tableProps(props);
    return null;
  },
}));

vi.mock('@/lib/auth/session', () => ({ requireOrgContext: m.requireOrgContext }));
vi.mock('@/lib/nav-labels', () => ({ effectiveNavLabel: vi.fn(async () => 'Inventory') }));
vi.mock('@/lib/warehouse-filter', () => ({
  getActiveWarehouseFilter: vi.fn(async () => h.filter),
}));
vi.mock('@/lib/auth/warehouse', () => ({ getWarehouseAccess: m.getWarehouseAccess }));
vi.mock('@/lib/dashboard/request-cache', () => ({
  getWarehousesForRequest: m.getWarehousesForRequest,
  // The same cached read with its outcome kept; answered from the list mock
  // so every assertion on that mock still holds.
  readWarehousesForRequest: async (organizationId: string) =>
    h.namesFailed
      ? { rows: [], failed: true }
      : { rows: await m.getWarehousesForRequest(organizationId), failed: false },
  getModulesForRequest: vi.fn(async () => new Set(['orders'])),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }));

vi.mock('@/server/loaders/inventory-list', async () => {
  const core = await import('@stockpilot/core');
  return {
    ALL_WAREHOUSES_KEY: '__all__',
    // Same rule as the real gate (loaders/inventory-list.ts).
    canUseSharedInventoryCaches: (ctx: { role: string }) =>
      core.isManagerOrAbove(ctx.role as never) && core.can(ctx as never, 'items:read'),
    // The tests use {} (the default view) and { sort } (a deep link).
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
      placementBreakdown: vi.fn(async () => new Map()),
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
  SavedViewsService: {
    forCurrentUser: vi.fn(async () => ({ list: m.savedViewsList })),
  },
}));
vi.mock('@/server/services/size-run-display', () => ({
  loadCountingUnits: vi.fn(async () => ({})),
  loadCountingUnitsForOrg: m.loadCountingUnitsForOrg,
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

import InventoryPage from './page';

const ROW = {
  id: 'item-1',
  name: 'Chromebook',
  sku: 'CB-1',
  status: 'active',
  quantity_on_hand: 5,
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
  h.ctxGate = null;
  h.racksGate = null;
  h.datasetGate = null;
  h.listGate = null;
  h.filter = null;
  h.savedViewsError = null;
  h.listTotal = 2;
  h.access = null;
  h.namesFailed = false;

  m.requireOrgContext.mockImplementation(() =>
    logged('ctx', async () => {
      if (h.ctxGate) await h.ctxGate;
      return { organizationId: 'org-1', userId: 'u-1', role: h.role };
    }),
  );
  m.listDistinctRacks.mockImplementation(() =>
    logged('racks', async () => (h.racksGate ? h.racksGate : ['1-A'])),
  );
  m.savedViewsList.mockImplementation(() =>
    logged('savedViews', async () => {
      if (h.savedViewsError) throw h.savedViewsError;
      return [{ id: 'v1' }];
    }),
  );
  m.loadInventoryList.mockImplementation(() =>
    logged('list', async () => {
      if (h.listGate) await h.listGate;
      return {
        items: h.listTotal ? [ROW] : [],
        total: h.listTotal,
        valueOnHand: 10,
        ...LOOKUPS,
        trends: {},
        placement: {},
        expectedCount: 0,
      };
    }),
  );
  m.resolveInventoryListImages.mockImplementation((_org: string, items: unknown[]) =>
    logged('images', async () => items),
  );
  m.loadInventoryDataset.mockImplementation(() =>
    logged('dataset', async () => (h.datasetGate ? h.datasetGate : null)),
  );
  m.loadInventoryLookups.mockImplementation(async () => LOOKUPS);
  m.loadInventoryTrendBuckets.mockImplementation(async () => ({}));
  m.inventoryList.mockImplementation(() =>
    logged('liveList', async () => ({
      items: h.listTotal ? [ROW] : [],
      total: h.listTotal,
      valueOnHand: 10,
    })),
  );
  m.getWarehouseAccess.mockImplementation(() =>
    logged(
      'access',
      async () =>
        h.access ?? {
          hasAllAccess: ['owner', 'admin', 'manager'].includes(h.role),
          readableIds: ['wh-1'],
          writableIds: ['wh-1'],
          primaryWarehouseId: 'wh-1',
        },
    ),
  );
  m.getWarehousesForRequest.mockImplementation(() =>
    logged('warehouses', async () => [{ id: 'wh-1', name: 'North' }]),
  );
  m.loadCountingUnitsForOrg.mockImplementation(() => logged('units', async () => ({})));
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
  return InventoryPage({ searchParams: Promise.resolve(params) });
}

describe('Items page: the table starts with the header, not after it', () => {
  it('manager, default view: saved views, the cached list and image signing start while the racks read is still open', async () => {
    const racks = deferred<string[]>();
    h.racksGate = racks.promise;

    const page = callPage();
    await flush();

    expect(events).toContain('racks:start');
    expect(events).not.toContain('racks:end');
    expect(events).toEqual(
      expect.arrayContaining(['savedViews:start', 'list:start', 'list:end', 'images:start']),
    );

    racks.resolve(['1-A']);
    render(await page);
    expect(events.indexOf('list:start')).toBeLessThan(events.indexOf('racks:end'));
    // The org's counting units (the server-mode render's last read) overlap
    // the rows instead of following them.
    expect(events.indexOf('units:start')).toBeLessThan(events.indexOf('list:end'));
    expect(m.tableProps).toHaveBeenCalledTimes(1);
    expect(m.tableProps.mock.calls[0]![0]).toMatchObject({
      savedViews: [{ id: 'v1' }],
      total: 2,
      currentUserId: 'u-1',
      canStartOrder: true,
    });
  });

  it('staff, live path: the RLS-scoped list starts while the racks read is open; no shared cache is read', async () => {
    h.role = 'staff';
    const racks = deferred<string[]>();
    h.racksGate = racks.promise;

    const page = callPage();
    await flush();

    expect(events).not.toContain('racks:end');
    expect(events).toEqual(expect.arrayContaining(['savedViews:start', 'liveList:start']));

    racks.resolve([]);
    render(await page);
    expect(m.loadInventoryList).not.toHaveBeenCalled();
    expect(m.loadInventoryDataset).not.toHaveBeenCalled();
    expect(m.loadInventoryLookups).not.toHaveBeenCalled();
    expect(m.loadInventoryTrendBuckets).not.toHaveBeenCalled();
    expect(m.tableProps).toHaveBeenCalledTimes(1);
  });

  it('shared-cache reads wait for the org context (and its role gate)', async () => {
    const ctx = deferred<void>();
    h.ctxGate = ctx.promise;

    const page = callPage();
    await flush();
    expect(m.loadInventoryList).not.toHaveBeenCalled();
    expect(m.loadInventoryDataset).not.toHaveBeenCalled();

    ctx.resolve();
    render(await page);
    expect(events.indexOf('list:start')).toBeGreaterThan(events.indexOf('ctx:end'));
  });

  it('manager: the section awaits no warehouse read (no cookie filter)', async () => {
    render(await callPage());
    expect(m.getWarehouseAccess).not.toHaveBeenCalled();
    expect(m.getWarehousesForRequest).not.toHaveBeenCalled();
  });

  it('manager with a warehouse filter: the loader is keyed by it and the table is told', async () => {
    h.filter = 'wh-1';
    render(await callPage());
    expect(m.loadInventoryList).toHaveBeenCalledWith('org-1', 'wh-1', 'items');
    expect(m.tableProps.mock.calls[0]![0]).toMatchObject({ activeWarehouseId: 'wh-1' });
  });

  it('staff: the scoped-warehouse note still reaches the empty state', async () => {
    h.role = 'staff';
    h.listTotal = 0;
    render(await callPage());
    expect(m.getWarehouseAccess).toHaveBeenCalled();
    expect(m.emptyStateProps).toHaveBeenCalledTimes(1);
    expect(m.emptyStateProps.mock.calls[0]![0].description).toContain("You're viewing North only.");
  });

  describe('staff empty state: a lookup that FAILED is never "no assigned warehouses"', () => {
    const emptyState = () =>
      m.emptyStateProps.mock.calls[0]![0] as { title: string; description: string };

    it('unreadable access: says it could not load, and a reload retries', async () => {
      h.role = 'staff';
      h.listTotal = 0;
      h.access = {
        readableIds: [],
        writableIds: [],
        hasAllAccess: false,
        primaryWarehouseId: null,
        unreadable: true,
      };
      render(await callPage());
      expect(m.emptyStateProps).toHaveBeenCalledTimes(1);
      expect(emptyState().title).toBe("Couldn't load your warehouse access");
      expect(emptyState().description).toBe(
        "Your items can't be listed without it. Refresh the page to try again.",
      );
      expect(emptyState().description).not.toContain('no assigned warehouses');
    });

    it('a lookup that succeeded and found none still says "no assigned warehouses"', async () => {
      h.role = 'staff';
      h.listTotal = 0;
      h.access = {
        readableIds: [],
        writableIds: [],
        hasAllAccess: false,
        primaryWarehouseId: null,
      };
      render(await callPage());
      expect(emptyState().title).toBe('No items yet');
      expect(emptyState().description).toContain('You have no assigned warehouses.');
    });

    it('a failed NAME read, for a staffer who has a warehouse, names none and claims none', async () => {
      h.role = 'staff';
      h.listTotal = 0;
      h.namesFailed = true;
      render(await callPage());
      expect(emptyState().description).toContain(
        "You're viewing only the warehouses assigned to you.",
      );
      expect(emptyState().description).not.toContain('no assigned warehouses');
    });
  });

  it('first rows first: the page resolves while the instant dataset is still loading, and the dataset starts after the rows', async () => {
    h.datasetGate = new Promise(() => {}); // never settles
    render(await callPage());

    const props = m.tableProps.mock.calls[0]![0] as { instantPromise?: unknown };
    expect(props.instantPromise).toBeInstanceOf(Promise);
    expect(events.indexOf('dataset:start')).toBeGreaterThan(events.indexOf('list:end'));
    expect(events.indexOf('dataset:start')).toBeGreaterThan(events.indexOf('images:end'));
    expect(events).not.toContain('dataset:end');
  });

  it('a deep link takes the awaited instant branch and starts no org-wide counting-units read', async () => {
    h.datasetGate = Promise.resolve({ items: [ROW], placement: {} });
    // A sort deep link: not the default view, and it filters nothing out.
    render(await callPage({ sort: 'name_asc' }));
    expect(m.loadCountingUnitsForOrg).not.toHaveBeenCalled();
    expect(m.tableProps.mock.calls[0]![0]).toHaveProperty('instant');
  });

  it('every early rejection is observed: racks and saved views both failing leave nothing unhandled', async () => {
    const racks = deferred<string[]>();
    const list = deferred<void>();
    h.racksGate = racks.promise;
    h.listGate = list.promise;
    h.savedViewsError = new Error('saved views down');

    const page = callPage();
    page.catch(() => {});
    // Saved views have failed and nothing awaits them yet: the section is
    // still waiting on the rows. Macrotasks pass here, so an unobserved
    // rejection would be reported.
    await flush();
    expect(events).toContain('savedViews:error');
    racks.reject(new Error('racks down'));
    await expect(page).rejects.toThrow('racks down');

    // The section finishes after the page has already failed, and throws on
    // its saved views: Promise.all observed it from the start.
    list.resolve();
    await flush();
    expect(unhandled).toEqual([]);
  });

  it('a saved-views failure alone still fails the page, as before', async () => {
    h.savedViewsError = new Error('saved views down');
    await expect(callPage()).rejects.toThrow('saved views down');
    await flush();
    expect(unhandled).toEqual([]);
  });
});
