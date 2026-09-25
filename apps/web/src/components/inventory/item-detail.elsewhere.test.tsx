import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ITEM PAGE FOR A MEMBER WHO CANNOT SEE EVERY WAREHOUSE (0371)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A staff member or viewer reads holdings only in their own warehouses. The
 * page's "placed + awaiting put-away = on hand" line, its placement breakdown,
 * the Rack summary row and the transfer dialog all used to be built from that
 * partial view as if it were complete. InventoryService.get({ withElsewhere })
 * now returns the rest as totals; these tests pin that the page uses them,
 * says so when they could not be read, and hands the transfer dialog only the
 * destinations the member can write (owner decision Q4).
 */

const { breakdownProps, dialogProps, currentRole, warehouseAccess } = vi.hoisted(() => ({
  breakdownProps: [] as Array<Record<string, unknown>>,
  dialogProps: [] as Array<Record<string, unknown>>,
  currentRole: { role: 'staff' as string, permissions: [] as string[] },
  warehouseAccess: vi.fn(),
}));
let locationRows: unknown[] = [];

vi.mock('@/lib/auth/warehouse', () => ({ getWarehouseAccess: warehouseAccess }));

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

// Every child except the storage rows themselves — this file asserts on the
// Details card's own DetailRows and nothing else. PlacementsBreakdown in
// particular is stubbed to null so a rack name appearing in the BREAKDOWN can
// never be mistaken for the summary row under test.
vi.mock('@/components/inventory/item-activity-panel', () => ({ ItemActivityPanel: () => null }));
vi.mock('@/components/inventory/placements-breakdown', () => ({
  PlacementsBreakdown: (props: Record<string, unknown>) => {
    breakdownProps.push(props);
    return null;
  },
}));
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
vi.mock('@/components/inventory/stock-transfer-dialog', () => ({
  StockTransferDialog: (props: Record<string, unknown>) => {
    dialogProps.push(props);
    return null;
  },
}));
vi.mock('@/components/onboarding/page-tour', () => ({ PageTour: () => null }));
vi.mock('@/components/maintenance/report-problem-button', () => ({
  ReportProblemButton: () => null,
}));

vi.mock('@/server/services/context', async (importOriginal) => {
  // The REAL module rule, so the price_tracking panel stays off exactly as a
  // core-only organization would see it.
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
      role: currentRole.role,
      permissions: new Set<string>(currentRole.permissions),
      mfaRequired: false,
      mfaSatisfied: true,
      enabledModules: new Set<string>(),
      supabase: {},
    })),
  };
});

const inventoryGet = vi.fn();
const inventoryPlacements = vi.fn(async () => [] as unknown[]);
vi.mock('@/server/services/inventory', () => ({
  InventoryService: {
    forCurrentUser: vi.fn(async () => ({
      get: inventoryGet,
      placements: inventoryPlacements,
      // Reserved feeds the On hand / Reserved / Available line. Empty map =
      // nothing reserved, which is the shape these fixtures already assume
      // and which renders no availability line at all.
      reservedQuantityByItemIds: vi.fn(async () => new Map<string, number>()),
    })),
  },
}));

vi.mock('@/server/services/activity', () => ({
  ActivityService: { forCurrentUser: vi.fn(async () => ({ forItem: vi.fn(async () => []) })) },
  auditLimitFor: (limit: number) => Math.max(1, Math.ceil(limit / 2)),
}));

vi.mock('@/server/services/item-images', () => ({
  ItemImagesService: {
    forCurrentUser: vi.fn(async () => ({
      list: vi.fn(async () => []),
      signedUrls: vi.fn(async () => new Map()),
    })),
  },
}));

vi.mock('@/server/services/locations', () => ({
  LocationsService: {
    forCurrentUser: vi.fn(async () => ({ list: vi.fn(async () => locationRows) })),
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
      itemCostHistory: vi.fn(async () => ({
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
    forCurrentUser: vi.fn(async () => ({ listDefinitions: vi.fn(async () => []) })),
  },
}));

vi.mock('@/server/services/serials', () => ({
  SerialsService: class SerialsService {
    async list() {
      return { rows: [], total: 0 };
    }
  },
}));

vi.mock('@/server/services/warehouses', () => ({
  WarehousesService: class WarehousesService {
    async listNames() {
      return [];
    }
  },
}));

import { ItemDetail } from './item-detail';

const ITEM_ID = '11111111-1111-1111-1111-111111111111';

/** QA-CHROME as get({ withElsewhere }) returns it: staged/unplaced already fold
 *  the hidden buckets (5 hidden staged, 20 visible unplaced). */
function chrome(overrides: Record<string, unknown> = {}) {
  return {
    id: ITEM_ID,
    name: 'QA Chrome',
    sku: 'QA-CHROME',
    barcode: null,
    model_number: null,
    item_type: 'product',
    category_id: null,
    supplier_id: null,
    primary_location_id: null,
    quantity_on_hand: 32,
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
    staged_quantity: 5,
    unplaced_quantity: 20,
    elsewhere: {
      status: 'some',
      staged: 5,
      unplaced: 0,
      placed: 7,
      placedLocationIds: ['loc-annex-rack'],
      rackLocationCount: 1,
    },
    updated_by: null,
    updated_at: null,
    ...overrides,
  };
}

const MAIN_UNPLACED = {
  locationId: 'loc-main-unp',
  name: 'Unplaced',
  kind: 'unplaced',
  warehouseId: 'wh-main',
  quantity: 20,
};

async function renderPage(item: Record<string, unknown>, holdings: unknown[] = [MAIN_UNPLACED]) {
  inventoryGet.mockResolvedValue(item);
  inventoryPlacements.mockResolvedValue(holdings);
  return render(
    await ItemDetail({ id: ITEM_ID, backHref: '/dashboard/inventory', backLabel: 'Back' }),
  );
}

/** The whole "… = on hand" sentence, whitespace-normalised. */
function placementLine(): string | null {
  const el = screen.queryByText((_, node) =>
    node?.tagName === 'P' && /on hand$/.test((node.textContent ?? '').trim()),
  );
  return el?.textContent?.replace(/\s+/g, ' ').trim() ?? null;
}

beforeEach(() => {
  vi.clearAllMocks();
  breakdownProps.length = 0;
  dialogProps.length = 0;
  currentRole.role = 'staff';
  currentRole.permissions = [];
  locationRows = [];
  warehouseAccess.mockResolvedValue({
    readableIds: ['wh-main'],
    writableIds: ['wh-main'],
    hasAllAccess: false,
    primaryWarehouseId: 'wh-main',
  });
});

describe('the "= on hand" line', () => {
  it('asks get() for the stock elsewhere', async () => {
    await renderPage(chrome());
    expect(inventoryGet).toHaveBeenCalledWith(ITEM_ID, { withUpdater: true, withElsewhere: true });
  });

  it("QA-CHROME: '0 placed + 20 awaiting put-away + 12 in other warehouses = 32 on hand'", async () => {
    await renderPage(chrome());
    // Before: "12 placed + 20 awaiting put-away = 32 on hand" — 12 "placed"
    // units that were in fact 5 in another warehouse's Staging and 7 on its rack.
    expect(placementLine()).toBe(
      '0 placed + 20 awaiting put-away + 12 in other warehouses = 32 on hand',
    );
  });

  it('when the stock elsewhere could not be read: says so, and prints NO sum', async () => {
    await renderPage(chrome({ staged_quantity: 0, elsewhere: { status: 'unavailable' } }));
    expect(placementLine()).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Could not load stock in other warehouses, so it may not be shown here.',
    );
  });

  it('a manager (nothing elsewhere) reads exactly as before', async () => {
    currentRole.role = 'manager';
    await renderPage(chrome({ staged_quantity: 0, elsewhere: { status: 'none' } }));
    expect(placementLine()).toBe('12 placed + 20 awaiting put-away = 32 on hand');
  });
});

describe('the placement breakdown', () => {
  it('gets the hidden PLACED stock as one count with its number of places', async () => {
    await renderPage(chrome());
    expect(breakdownProps.at(-1)?.elsewhere).toEqual({ quantity: 7, locationCount: 1 });
  });

  it('gets nothing when nothing placed is elsewhere', async () => {
    await renderPage(
      chrome({ elsewhere: { status: 'some', staged: 5, unplaced: 0, placed: 0, placedLocationIds: [], rackLocationCount: 0 } }),
    );
    expect(breakdownProps.at(-1)?.elsewhere).toBeNull();
  });
});

describe('the Rack summary row', () => {
  const book = (elsewhere: unknown) =>
    chrome({
      item_type: 'book',
      custom_fields: { book_rack_number: '39', book_rack_row: 'B' },
      staged_quantity: 0,
      unplaced_quantity: 0,
      quantity_on_hand: 9,
      elsewhere,
    });
  const mainRack = { locationId: 'loc-5a', name: '5-A', kind: 'rack', warehouseId: 'wh-main', quantity: 4 };
  const rackRow = () => {
    const heading = screen.queryAllByText('Rack', { selector: 'p' })[0];
    return heading?.nextElementSibling?.textContent ?? null;
  };

  it('a rack in ANOTHER warehouse that matches the label keeps the row (evidence for it)', async () => {
    locationRows = [{ id: 'loc-39b', name: '39-B', kind: 'rack', warehouse_id: 'wh-annex' }];
    await renderPage(
      book({ status: 'some', staged: 0, unplaced: 0, placed: 5, placedLocationIds: ['loc-39b'], rackLocationCount: 1 }),
      [mainRack],
    );
    expect(rackRow()).toBe('39-B');
  });

  it('with nothing elsewhere, a refuted label still stands down (unchanged)', async () => {
    await renderPage(book({ status: 'none' }), [mainRack]);
    expect(rackRow()).toBeNull();
  });

  it('when the stock elsewhere is unknown, the label is never called false', async () => {
    await renderPage(book({ status: 'unavailable' }), [mainRack]);
    expect(rackRow()).toBe('39-B');
  });
});

describe('the transfer dialog', () => {
  it('a staff member: the stock elsewhere, and destinations narrowed to their warehouses (Q4)', async () => {
    currentRole.permissions = ['stock:transfer'];
    locationRows = [
      { id: 'a', name: 'A', kind: 'rack', warehouse_id: 'wh-main' },
      { id: 'b', name: 'B', kind: 'rack', warehouse_id: 'wh-annex' },
    ];
    await renderPage(chrome());
    const props = dialogProps.at(-1)!;
    expect(props.writableWarehouseIds).toEqual(['wh-main']);
    expect(props.elsewhere).toMatchObject({ status: 'some', placed: 7 });
  });

  it('an all-warehouses member is unrestricted', async () => {
    currentRole.permissions = ['stock:transfer'];
    warehouseAccess.mockResolvedValue({
      readableIds: ['wh-main', 'wh-annex'],
      writableIds: ['wh-main', 'wh-annex'],
      hasAllAccess: true,
      primaryWarehouseId: 'wh-main',
    });
    locationRows = [
      { id: 'a', name: 'A', kind: 'rack', warehouse_id: 'wh-main' },
      { id: 'b', name: 'B', kind: 'rack', warehouse_id: 'wh-annex' },
    ];
    await renderPage(chrome());
    expect(dialogProps.at(-1)!.writableWarehouseIds).toBeNull();
  });

  it('a failed access read narrows to locations with no warehouse (fail closed)', async () => {
    currentRole.permissions = ['stock:transfer'];
    warehouseAccess.mockRejectedValue(new Error('boom'));
    locationRows = [
      { id: 'a', name: 'A', kind: 'rack', warehouse_id: 'wh-main' },
      { id: 'b', name: 'B', kind: 'rack', warehouse_id: 'wh-annex' },
    ];
    await renderPage(chrome());
    expect(dialogProps.at(-1)!.writableWarehouseIds).toEqual([]);
  });

  it('a manager: no access read at all, unrestricted', async () => {
    currentRole.role = 'manager';
    currentRole.permissions = ['stock:transfer'];
    locationRows = [
      { id: 'a', name: 'A', kind: 'rack', warehouse_id: 'wh-main' },
      { id: 'b', name: 'B', kind: 'rack', warehouse_id: 'wh-annex' },
    ];
    await renderPage(chrome({ elsewhere: { status: 'none' } }));
    expect(warehouseAccess).not.toHaveBeenCalled();
    expect(dialogProps.at(-1)!.writableWarehouseIds).toBeNull();
  });
});
