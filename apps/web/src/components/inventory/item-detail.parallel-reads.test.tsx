import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The item page waits on THREE levels of reads, not ten.
 *
 * Production logs (2026-09-22, Movements/Activity renders of this page) showed
 * a serial chain: request context, item row, warehouse access, holdings, a
 * fan-out, the activity feed's actor lookup, the updated-by profile, then two
 * module_enabled RPCs. 3-5% of calls from Vercel stall 1-8 s at Supabase's
 * gateway, and renders that met one took 6.6 s and 3.6 s against 0.53-0.65 s.
 *
 * This file records WHEN each read starts, against an item row that has not
 * answered yet, and pins:
 *   1. every read that needs only the item id is already running before the
 *      row answers;
 *   2. the reads that need a field off the row (category, supplier, signed
 *      photo URLs) start only after it answers, and start together with the
 *      rest rather than after them; the updated-by profile comes WITH the row;
 *   2b. a Movements or Activity tab (a query-only navigation that re-renders
 *      this whole page) makes none of the reads only the Overview panel shows,
 *      so none of them can slow or fail the tab;
 *   3. a not-found (which is also what a forbidden warehouse becomes, inside
 *      InventoryService.get) is still notFound(), nothing read early is used,
 *      no dependent read is made, and no early read can surface as an
 *      unhandled rejection. Any other error still propagates as itself.
 */

vi.mock('next/dynamic', () => ({ default: () => () => null }));

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('notFound');
  }),
}));

vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
  };
});

vi.mock('@/components/inventory/item-activity-panel', () => ({ ItemActivityPanel: () => null }));
vi.mock('@/components/inventory/placements-breakdown', () => ({ PlacementsBreakdown: () => null }));
vi.mock('@/components/inventory/barcode-display', () => ({ BarcodeDisplay: () => null }));
vi.mock('@/components/inventory/duplicate-item-dialog', () => ({ DuplicateItemDialog: () => null }));
vi.mock('@/components/dashboard/charts/cost-trend-island', () => ({ CostTrendIsland: () => null }));
vi.mock('@/components/inventory/item-detail-tabs', () => ({ ItemDetailTabs: () => null }));
vi.mock('@/components/inventory/item-serials-panel', () => ({ ItemSerialsPanel: () => null }));
vi.mock('@/components/inventory/public-visibility-control', () => ({
  PublicVisibilityControl: () => null,
}));
vi.mock('@/components/inventory/market-price-panel', () => ({ MarketPricePanel: () => null }));
vi.mock('@/components/inventory/stock-status-badge', () => ({ StockStatusBadge: () => null }));
vi.mock('@/components/inventory/stock-adjust-dialog', () => ({ StockAdjustDialog: () => null }));
vi.mock('@/components/inventory/stock-transfer-dialog', () => ({ StockTransferDialog: () => null }));
vi.mock('@/components/onboarding/page-tour', () => ({ PageTour: () => null }));
vi.mock('@/components/maintenance/report-problem-button', () => ({
  ReportProblemButton: () => null,
}));

/** Every read, in the order it STARTED. */
const started: string[] = [];
const rec =
  <T,>(label: string, impl: (...args: unknown[]) => Promise<T>) =>
  (...args: unknown[]) => {
    started.push(label);
    return impl(...args);
  };

/**
 * ctx.supabase, lazy like postgrest-js: a read starts when `.then` is called.
 * Answers by table; the category / supplier / updated-by reads go through here.
 */
const tableAnswers: Record<string, unknown> = {};
const supabaseClient = {
  from(table: string) {
    const builder: Record<string, unknown> = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === 'then') {
            return (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) => {
              started.push(`table:${table}`);
              return Promise.resolve({ data: tableAnswers[table] ?? null, error: null }).then(
                onFulfilled,
                onRejected,
              );
            };
          }
          return () => builder;
        },
      },
    );
    return builder;
  },
};

const checkModuleAccess = vi.fn();
vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: (...args: unknown[]) => checkModuleAccess(...args),
}));

vi.mock('@/server/services/context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/services/context')>();
  return {
    ServiceError: class ServiceError extends Error {
      constructor(
        public code: string,
        message: string,
      ) {
        super(message);
        this.name = 'ServiceError';
      }
    },
    isModuleEnabled: actual.isModuleEnabled,
    withContext: vi.fn(async () => ({
      organizationId: 'org-1',
      userId: 'u1',
      role: 'manager' as const,
      permissions: new Set<string>(['items:update']),
      mfaRequired: false,
      mfaSatisfied: true,
      enabledModules: new Set<string>(),
      supabase: supabaseClient,
    })),
  };
});

// Per-test controls: the item row, and any early read that should fail.
const control: {
  get: () => Promise<unknown>;
  reserved: () => Promise<Map<string, number>>;
  locations: () => Promise<unknown[]>;
} = {
  get: async () => ({}),
  reserved: async () => new Map(),
  locations: async () => [],
};

/** Arguments `InventoryService.get` was called with, per call. */
const getCalls: unknown[][] = [];

const signedUrls = vi.fn(async (paths: unknown) => {
  started.push('signedUrls');
  return new Map((paths as string[]).map((p) => [p, `https://signed/${p}`]));
});

vi.mock('@/server/services/inventory', () => ({
  InventoryService: {
    forCurrentUser: vi.fn(async () => ({
      get: rec('get', (...args: unknown[]) => {
        getCalls.push(args);
        return control.get();
      }),
      placements: rec('placements', async () => []),
      reservedQuantityByItemIds: rec('reserved', () => control.reserved()),
    })),
  },
}));

vi.mock('@/server/services/activity', () => ({
  ActivityService: {
    forCurrentUser: vi.fn(async () => ({ forItem: rec('activity', async () => []) })),
  },
  auditLimitFor: (limit: number) => Math.max(1, Math.ceil(limit / 2)),
}));

vi.mock('@/server/services/item-images', () => ({
  ItemImagesService: {
    forCurrentUser: vi.fn(async () => ({
      list: rec('images', async () => [
        { id: 'img-1', storage_path: 'org-1/item-1/a.jpg', is_primary: true },
      ]),
      signedUrls,
    })),
  },
}));

vi.mock('@/server/services/locations', () => ({
  LocationsService: {
    forCurrentUser: vi.fn(async () => ({ list: rec('locations', () => control.locations()) })),
  },
}));

vi.mock('@/server/services/price-tracking', () => ({
  PriceTrackingService: {
    forCurrentUser: vi.fn(async () => ({ getLatestObservation: vi.fn(async () => null) })),
  },
}));

vi.mock('@/server/services/reports', () => ({
  ReportsService: {
    forCurrentUser: vi.fn(async () => ({
      itemCostHistory: rec('costHistory', async () => ({
        pointCount: 0,
        lastUnitCost: null,
        avgUnitCost: null,
        series: [],
      })),
    })),
  },
}));

vi.mock('@/server/services/custom-fields', () => ({
  CustomFieldsService: {
    forCurrentUser: vi.fn(async () => ({ listDefinitions: rec('customFields', async () => []) })),
  },
}));

vi.mock('@/server/services/serials', () => ({
  SerialsService: class SerialsService {
    async list() {
      started.push('serials');
      return { rows: [], total: 0 };
    }
  },
}));

vi.mock('@/server/services/warehouses', () => ({
  WarehousesService: class WarehousesService {
    async listNames() {
      started.push('warehouseNames');
      return [];
    }
  },
}));

import { ServiceError } from '@/server/services/context';

import { ItemDetail } from './item-detail';

const ITEM_ID = '11111111-1111-1111-1111-111111111111';

function itemRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ITEM_ID,
    name: 'Wall-mounted HVAC unit',
    sku: 'HVAC-WALL-204',
    barcode: null,
    model_number: null,
    item_type: 'product',
    category_id: 'cat-1',
    supplier_id: 'sup-1',
    primary_location_id: null,
    quantity_on_hand: 10,
    reorder_point: 2,
    reorder_quantity: 5,
    retail_price: 100,
    unit_cost: 40,
    unit_of_measure: 'each',
    status: 'active',
    description: null,
    bin_location: null,
    custom_fields: {},
    tracking_type: 'none',
    public_visibility: 'internal_only',
    public_display_name: null,
    awaiting_first_receipt: false,
    staged_quantity: 0,
    unplaced_quantity: 0,
    updated_by: 'u-editor',
    updated_at: '2026-09-20T12:00:00.000Z',
    // What InventoryService.get(id, { withUpdater: true }) embeds.
    updater: { full_name: 'Dana Editor', email: 'dana@example.com' },
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Reads only the Overview panel shows. A Movements or Activity render makes none of them. */
const OVERVIEW_ONLY_READS = ['reserved', 'images', 'costHistory', 'customFields', 'serials'];
/** The reads that need nothing but the item id, on a Movements or Activity tab. */
const TAB_ID_ONLY_READS = ['placements', 'activity', 'locations'];
/** The reads that need nothing but the item id, on Overview. */
const OVERVIEW_ID_ONLY_READS = ['placements', 'locations', ...OVERVIEW_ONLY_READS];
/** The reads that need a field off the item row (Overview only). */
const ROW_KEYED_READS = ['table:categories', 'table:suppliers', 'signedUrls'];

let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};

beforeEach(() => {
  vi.clearAllMocks();
  started.length = 0;
  getCalls.length = 0;
  unhandled = [];
  process.on('unhandledRejection', onUnhandled);
  control.get = async () => itemRow();
  control.reserved = async () => new Map();
  control.locations = async () => [];
  for (const k of Object.keys(tableAnswers)) delete tableAnswers[k];
  tableAnswers.categories = { id: 'cat-1', name: 'HVAC', color: null, public_visibility: 'public' };
  tableAnswers.suppliers = { id: 'sup-1', name: 'Acme Supply' };
});

afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
});

describe('ItemDetail: reads start by what they need, not one after another', () => {
  it('a tab: every read it needs is running before the row answers, and no Overview-only read ever starts', async () => {
    const row = deferred<unknown>();
    control.get = () => row.promise;

    const rendering = ItemDetail({
      id: ITEM_ID,
      backHref: '/dashboard/inventory',
      backLabel: 'Back',
      tab: 'movements',
    });
    await flush();

    expect(started).toContain('get');
    for (const read of TAB_ID_ONLY_READS) expect(started).toContain(read);

    row.resolve(itemRow());
    render(await rendering);

    for (const read of [...OVERVIEW_ONLY_READS, ...ROW_KEYED_READS]) {
      expect(started).not.toContain(read);
    }
    // The footer's editor came with the row: no read of its own.
    expect(getCalls).toEqual([[ITEM_ID, { withUpdater: true }]]);
    expect(started).not.toContain('table:user_profiles');
    expect(screen.getByText(/Last updated by Dana Editor/)).toBeTruthy();
    // One module answer source, and it is not a round trip.
    expect(checkModuleAccess).not.toHaveBeenCalled();
  });

  it('Overview: every id-only read is running before the row answers; no row-keyed read is', async () => {
    const row = deferred<unknown>();
    control.get = () => row.promise;

    const rendering = ItemDetail({ id: ITEM_ID, backHref: '/dashboard/inventory', backLabel: 'Back' });
    await flush();

    expect(started).toContain('get');
    for (const read of OVERVIEW_ID_ONLY_READS) expect(started).toContain(read);
    for (const read of ROW_KEYED_READS) expect(started).not.toContain(read);

    row.resolve(itemRow());
    render(await rendering);

    for (const read of ROW_KEYED_READS) expect(started).toContain(read);
    expect(started).not.toContain('table:user_profiles');
    expect(screen.getByText(/Last updated by Dana Editor/)).toBeTruthy();
  });

  it('a tab cannot be failed by a read only Overview shows, because it never makes one', async () => {
    control.reserved = async () => {
      throw new Error('reservations read failed');
    };
    render(
      await ItemDetail({
        id: ITEM_ID,
        backHref: '/dashboard/inventory',
        backLabel: 'Back',
        tab: 'activity',
      }),
    );
    expect(screen.getByText(/Last updated by Dana Editor/)).toBeTruthy();
    await flush();
    expect(unhandled).toEqual([]);
  });

  it('an editor profile the caller may not see (embed null) leaves the footer without a name', async () => {
    control.get = async () => itemRow({ updater: null });
    render(
      await ItemDetail({
        id: ITEM_ID,
        backHref: '/dashboard/inventory',
        backLabel: 'Back',
        tab: 'movements',
      }),
    );
    expect(screen.queryByText(/Last updated by/)).toBeNull();
  });

  it('the Overview tab renders what the row-keyed reads returned (category, supplier, editor)', async () => {
    render(await ItemDetail({ id: ITEM_ID, backHref: '/dashboard/inventory', backLabel: 'Back' }));
    expect(screen.getByText('HVAC')).toBeTruthy();
    expect(screen.getByText('Acme Supply')).toBeTruthy();
    expect(screen.getByText(/Last updated by Dana Editor/)).toBeTruthy();
    // The Overview tab never pays for the activity feed.
    expect(started).not.toContain('activity');
  });

  it('the row-keyed reads start as soon as the row answers, while slower id-only reads are still in flight', async () => {
    // The location list is the slow one this time. The row-keyed reads used
    // to start only after EVERYTHING had arrived; they must not wait for it.
    const slowLocations = deferred<unknown[]>();
    control.locations = () => slowLocations.promise;

    const rendering = ItemDetail({ id: ITEM_ID, backHref: '/dashboard/inventory', backLabel: 'Back' });
    await flush();
    await flush();

    for (const read of ROW_KEYED_READS) expect(started).toContain(read);

    slowLocations.resolve([]);
    render(await rendering);
    expect(screen.getByText(/Last updated by Dana Editor/)).toBeTruthy();
  });

  it('not_found (which a forbidden warehouse also becomes) is still notFound(): no row-keyed read, no signed URL, no unhandled rejection from the early reads', async () => {
    control.get = async () => {
      throw new ServiceError('not_found', 'Item not found');
    };
    // An early read that fails in the window before notFound() throws.
    control.reserved = async () => {
      throw new Error('reservations read failed');
    };

    await expect(
      ItemDetail({ id: ITEM_ID, backHref: '/dashboard/inventory', backLabel: 'Back', tab: 'activity' }),
    ).rejects.toThrow('notFound');
    await flush();
    await flush();

    for (const read of ROW_KEYED_READS) expect(started).not.toContain(read);
    expect(signedUrls).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
  });

  it('any other error from the item read propagates as itself (not notFound), with the same guarantee', async () => {
    const boom = new ServiceError('internal_error', 'relation exploded');
    control.get = async () => {
      throw boom;
    };
    control.locations = async () => {
      throw new Error('locations read failed');
    };

    await expect(
      ItemDetail({ id: ITEM_ID, backHref: '/dashboard/inventory', backLabel: 'Back' }),
    ).rejects.toBe(boom);
    await flush();
    await flush();

    for (const read of ROW_KEYED_READS) expect(started).not.toContain(read);
    expect(unhandled).toEqual([]);
  });

  it('on Overview, an early read that fails AFTER the row is found still fails the page, as it always did', async () => {
    control.reserved = async () => {
      throw new Error('reservations read failed');
    };
    await expect(
      ItemDetail({ id: ITEM_ID, backHref: '/dashboard/inventory', backLabel: 'Back' }),
    ).rejects.toThrow('reservations read failed');
    await flush();
    expect(unhandled).toEqual([]);
  });
});
