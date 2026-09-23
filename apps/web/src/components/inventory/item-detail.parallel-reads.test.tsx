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
 *   2. the reads that need a field off the row (category, supplier, updated-by
 *      profile, signed photo URLs) start only after it answers, and start
 *      together with the rest rather than after them;
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

// A marker, so a test can tell the feed rendered from the could-not-load state.
vi.mock('@/components/inventory/item-activity-panel', async () => {
  const React = await import('react');
  return {
    ItemActivityPanel: () => React.createElement('div', { 'data-testid': 'activity-panel' }),
  };
});
const reportError = vi.fn();
vi.mock('@/lib/error-reporter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/error-reporter')>()),
  reportError: (...args: unknown[]) => reportError(...args),
}));
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
  activity: () => Promise<unknown[]>;
} = {
  get: async () => ({}),
  reserved: async () => new Map(),
  locations: async () => [],
  activity: async () => [],
};

const signedUrls = vi.fn(async (paths: unknown) => {
  started.push('signedUrls');
  return new Map((paths as string[]).map((p) => [p, `https://signed/${p}`]));
});

vi.mock('@/server/services/inventory', () => ({
  InventoryService: {
    forCurrentUser: vi.fn(async () => ({
      get: rec('get', () => control.get()),
      placements: rec('placements', async () => []),
      reservedQuantityByItemIds: rec('reserved', () => control.reserved()),
    })),
  },
}));

vi.mock('@/server/services/activity', () => ({
  ActivityService: {
    forCurrentUser: vi.fn(async () => ({ forItem: rec('activity', () => control.activity()) })),
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

/** The reads that need nothing but the item id (Movements tab open). */
const ID_ONLY_READS = [
  'placements',
  'reserved',
  'activity',
  'images',
  'locations',
  'costHistory',
  'customFields',
  'serials',
];
/** The reads that need a field off the item row. */
const ROW_KEYED_READS = ['table:categories', 'table:suppliers', 'table:user_profiles', 'signedUrls'];

let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};

beforeEach(() => {
  vi.clearAllMocks();
  started.length = 0;
  unhandled = [];
  process.on('unhandledRejection', onUnhandled);
  control.get = async () => itemRow();
  control.reserved = async () => new Map();
  control.locations = async () => [];
  control.activity = async () => [];
  for (const k of Object.keys(tableAnswers)) delete tableAnswers[k];
  tableAnswers.categories = { id: 'cat-1', name: 'HVAC', color: null, public_visibility: 'public' };
  tableAnswers.suppliers = { id: 'sup-1', name: 'Acme Supply' };
  tableAnswers.user_profiles = { full_name: 'Dana Editor', email: 'dana@example.com' };
});

afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
});

describe('ItemDetail: reads start by what they need, not one after another', () => {
  it('every id-only read is already running before the item row answers; no row-keyed read is', async () => {
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
    for (const read of ID_ONLY_READS) expect(started).toContain(read);
    for (const read of ROW_KEYED_READS) expect(started).not.toContain(read);

    row.resolve(itemRow());
    render(await rendering);

    for (const read of ROW_KEYED_READS) expect(started).toContain(read);
    expect(screen.getByText(/Last updated by Dana Editor/)).toBeTruthy();
    // One module answer source, and it is not a round trip.
    expect(checkModuleAccess).not.toHaveBeenCalled();
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
    // The location list is the slow one this time. The updated-by profile used
    // to be read only after EVERYTHING had arrived; it must not wait for it.
    const slowLocations = deferred<unknown[]>();
    control.locations = () => slowLocations.promise;

    const rendering = ItemDetail({
      id: ITEM_ID,
      backHref: '/dashboard/inventory',
      backLabel: 'Back',
      tab: 'activity',
    });
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

  it('an early read that fails AFTER the row is found still fails the page, as it always did', async () => {
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

/**
 * The activity feed is the one early read whose failure is the TAB's, not the
 * page's. ActivityService.forItem now throws on a failed read (it used to
 * return [] for it, which the tabs showed as "no history"); the page must turn
 * that into a could-not-load state with a retry, and keep everything else.
 */
describe('ItemDetail: a failed activity feed is a could-not-load state on its tab', () => {
  const failFeed = () => {
    control.activity = async () => {
      throw new ServiceError('internal_error', 'upstream timeout');
    };
  };

  it('Movements tab: says it could not load, offers a retry to the same tab, and the page still renders', async () => {
    failFeed();
    render(
      await ItemDetail({
        id: ITEM_ID,
        backHref: '/dashboard/inventory',
        backLabel: 'Back',
        tab: 'movements',
      }),
    );

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/Could not load this item.s stock movements/);
    expect(screen.getByRole('link', { name: 'Try again' }).getAttribute('href')).toBe('?tab=movements');
    expect(screen.queryByTestId('activity-panel')).toBeNull();
    // The rest of the page is there.
    expect(screen.getByText(/Last updated by Dana Editor/)).toBeTruthy();
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'internal_error' }),
      expect.objectContaining({ tag: 'item-detail.activity' }),
    );
    await flush();
    expect(unhandled).toEqual([]);
  });

  it('Activity tab: the same, and the retry keeps the validated return target', async () => {
    failFeed();
    render(
      await ItemDetail({
        id: ITEM_ID,
        backHref: '/dashboard/inventory?q=hvac',
        backLabel: 'Back',
        tab: 'activity',
        returnParam: '/dashboard/inventory?q=hvac',
      }),
    );

    expect(screen.getByRole('alert').textContent).toMatch(/Could not load this item.s activity/);
    const retry = new URLSearchParams(
      (screen.getByRole('link', { name: 'Try again' }).getAttribute('href') ?? '').slice(1),
    );
    expect(retry.get('tab')).toBe('activity');
    expect(retry.get('return')).toBe('/dashboard/inventory?q=hvac');
    expect(screen.queryByTestId('activity-panel')).toBeNull();
  });

  it('a feed that loads renders the panel, with no could-not-load state', async () => {
    render(
      await ItemDetail({ id: ITEM_ID, backHref: '/dashboard/inventory', backLabel: 'Back', tab: 'activity' }),
    );
    expect(screen.getByTestId('activity-panel')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('the Overview tab is untouched: it never reads the feed, so a broken feed cannot affect it', async () => {
    failFeed();
    render(await ItemDetail({ id: ITEM_ID, backHref: '/dashboard/inventory', backLabel: 'Back' }));
    expect(started).not.toContain('activity');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('HVAC')).toBeTruthy();
    expect(reportError).not.toHaveBeenCalled();
  });
});
