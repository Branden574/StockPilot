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
  /** Extra fields on the live list's answer (0371: elsewhere figures). */
  liveExtra: null as null | Record<string, unknown>,
  /** listPlanRows' answer (null: the view is over the cap, fixed pages). */
  planRows: null as null | { rows: unknown[]; total: number; valueOnHand: number },
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
  listPlanRows: vi.fn(),
  forOrgAsMember: vi.fn(),
  byItemIds: vi.fn(),
  tableProps: vi.fn(),
  notEnabledProps: vi.fn(),
  toggleProps: vi.fn(),
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
vi.mock('@/components/ui/archive-view-toggle', () => ({
  ArchiveViewToggle: (props: Record<string, unknown>) => {
    m.toggleProps(props);
    return null;
  },
}));
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
      listPlanRows: m.listPlanRows,
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
vi.mock('@/server/services/lib/display-groups', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/lib/display-groups')>()),
  // As the real readers do, the client (a promise) is awaited inside a try.
  readDisplayGroupsForOrgAsMember: async (client: unknown, ...rest: unknown[]) => {
    await Promise.resolve(client).catch(() => {});
    return m.forOrgAsMember(client, ...rest);
  },
  readDisplayGroupsByItemIds: async (client: unknown, ...rest: unknown[]) => {
    await Promise.resolve(client).catch(() => {});
    return m.byItemIds(client, ...rest);
  },
}));

import { ELSEWHERE_UNAVAILABLE_NOTE } from '@stockpilot/core';

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
  h.liveExtra = null;

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
  h.planRows = null;
  m.listPlanRows.mockImplementation(() => logged('planRows', async () => h.planRows));
  m.forOrgAsMember.mockResolvedValue(new Map());
  m.byItemIds.mockResolvedValue(new Map());
  m.inventoryList.mockImplementation(() =>
    logged('liveList', async () => ({
      items: [BOOK],
      total: 1,
      valueOnHand: 3,
      ...(h.liveExtra ?? {}),
    })),
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

  // STOCK IN OTHER WAREHOUSES (0371), as the page wires it.
  it('staff: the live list asks for the stock in other warehouses (withElsewhere)', async () => {
    h.role = 'staff';
    render(await callPage());
    expect(m.inventoryList).toHaveBeenCalledTimes(1);
    expect(m.inventoryList.mock.calls[0]![0]).toMatchObject({ withElsewhere: true });
  });

  it('staff: a failed elsewhere read is SAID above the table, never left as complete figures', async () => {
    h.role = 'staff';
    h.liveExtra = { elsewhereUnavailable: true };
    const { container } = render(await callPage());
    expect(m.tableProps).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      ELSEWHERE_UNAVAILABLE_NOTE,
    );
  });

  it('staff: nothing is added when the elsewhere read succeeded', async () => {
    h.role = 'staff';
    h.liveExtra = { elsewhereUnavailable: false };
    const { container } = render(await callPage());
    expect(container.querySelector('[role="status"]')).toBeNull();
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

/**
 * The Archived view's "Auto-archived only" chip (?auto=1) narrows the list to
 * books the zero-stock job archived, and no active book is one (review
 * 2026-10-05). Active must not keep it, and a view it leaves empty is the
 * table's own "No items match your filters." row, as when the chip is switched
 * on in the app, never "No books yet" with an offer to add a first book.
 */
describe('Books page: the Auto-archived only parameter', () => {
  it('the Active toggle drops ?auto= (it only means something on Archived)', async () => {
    render(await callPage({ status: 'archived', auto: '1' }));
    expect(m.toggleProps).toHaveBeenCalledWith(
      expect.objectContaining({ paramName: 'status', archivedOnlyParams: ['auto'] }),
    );
  });

  it.each<Record<string, string>>([{ status: 'archived', auto: '1' }, { auto: '1' }])(
    '%o with no auto-archived book renders the table with nothing in it, not an empty state',
    async (params) => {
      render(await callPage(params));
      expect(m.tableProps).toHaveBeenCalledTimes(1);
      expect(m.tableProps.mock.calls[0]![0]).toMatchObject({ total: 0 });
    },
  );
});

// Phase 2 of the grouping brief: a staff member's or viewer's Books page is
// planned group-aware too, so a title on more than one rack (one SKU, a
// record per rack) or a display group is never split across their pages.
// Books build no size runs, so two titles that merely share a name are not
// pulled together.
describe('Books page: a staff page is planned group-aware', () => {
  const book = (id: string, minutes: number, over: Record<string, unknown> = {}) => ({
    id,
    sku: `BK-${id}`,
    name: `Book ${id}`,
    group_id: null,
    quantity_on_hand: 1,
    unit_cost: 1,
    reorder_point: 0,
    category_id: null,
    status: 'active',
    created_at: '2026-09-01T00:00:00Z',
    updated_at: new Date(Date.UTC(2026, 9, 1) - minutes * 60_000).toISOString(),
    ...over,
  });

  it('staff: a title on two racks is read on one page, with the planned totals, and the plan reaches the table', async () => {
    h.role = 'staff';
    const rows: unknown[] = [];
    for (let i = 1; i <= 50; i++) rows.push(book(`b${String(i).padStart(3, '0')}`, i * 2 + 1));
    rows.push(book('dune-a', 4, { sku: 'DUNE' }), book('dune-b', 90, { sku: 'DUNE' }));
    rows.push(book('tee-s', 6, { name: 'Tee - S' }), book('tee-m', 92, { name: 'Tee - M' }));
    h.planRows = { rows, total: rows.length, valueOnHand: 54 };
    m.inventoryList.mockImplementation((filters: { ids?: string[] }) =>
      logged('liveList', async () => ({
        items: (filters.ids ?? []).map((id) => ({ ...BOOK, id })),
        total: 1,
        valueOnHand: 0,
      })),
    );
    render(await callPage());
    const filters = m.inventoryList.mock.calls[0]![0] as {
      ids: string[];
      itemType: string;
      plannedTotals: unknown;
      withElsewhere: boolean;
    };
    expect(filters.ids).toEqual(expect.arrayContaining(['dune-a', 'dune-b']));
    // No size runs on Books: the second "Tee" is not pulled up.
    expect(filters.ids).not.toContain('tee-m');
    expect(filters).toMatchObject({
      itemType: 'book',
      plannedTotals: { total: 54, valueOnHand: 54 },
      withElsewhere: true,
    });
    const props = m.tableProps.mock.calls[0]![0] as {
      plannedPage: { page: number };
      total: number;
    };
    expect(props.plannedPage.page).toBe(1);
    expect(props.total).toBe(54);
  });

  it("over the cap, in an organization with more memberships than one request, the page reads its own records' groups", async () => {
    h.role = 'staff';
    h.planRows = null;
    m.forOrgAsMember.mockResolvedValue(null);
    m.byItemIds.mockResolvedValue(new Map([[BOOK.id, { id: 'grp-1', name: 'Pair', version: 2 }]]));
    render(await callPage());
    expect(m.byItemIds).toHaveBeenCalledTimes(1);
    expect(m.byItemIds.mock.calls[0]!.slice(1)).toEqual(['org-1', [BOOK.id]]);
    const props = m.tableProps.mock.calls[0]![0] as {
      items: Array<{ id: string; display_group_id: string | null }>;
    };
    expect(props.items.find((r) => r.id === BOOK.id)!.display_group_id).toBe('grp-1');
  });

  it("with the organization's memberships in hand, the page reads no more of them", async () => {
    h.role = 'staff';
    h.planRows = null;
    m.forOrgAsMember.mockResolvedValue(
      new Map([[BOOK.id, { id: 'grp-1', name: 'Pair', version: 2 }]]),
    );
    render(await callPage());
    expect(m.byItemIds).not.toHaveBeenCalled();
    const props = m.tableProps.mock.calls[0]![0] as {
      items: Array<{ id: string; display_group_id: string | null }>;
    };
    expect(props.items.find((r) => r.id === BOOK.id)!.display_group_id).toBe('grp-1');
  });

  it('staff over the cap keeps fixed pages, as before', async () => {
    h.role = 'staff';
    h.planRows = null;
    render(await callPage({ page: '2' }));
    expect(m.inventoryList.mock.calls[0]![0]).toMatchObject({ limit: 30, offset: 30 });
    expect(
      (m.tableProps.mock.calls[0]![0] as { plannedPage?: unknown }).plannedPage ?? null,
    ).toBeNull();
  });
});
