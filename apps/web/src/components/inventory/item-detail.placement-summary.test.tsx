import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE STORAGE CARD'S Rack AND Crate ROWS — hidden only when actually FALSE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * These two rows read `custom_fields` (`readBookStorage`), which is a SUMMARY,
 * not where the stock is. Migration 0335 made a put-away into a position-less
 * crate PRESERVE the rack pair on purpose, so the Rack row can name a rack the
 * stock has entirely left — while the live PlacementsBreakdown a few rows above
 * shows the truth. The card contradicted itself.
 *
 * The first fix hid BOTH rows whenever `resolvePlacement` called the holdings
 * authoritative — which is true for SPLIT stock as well as for the crate case.
 * A book split across two racks therefore lost its Rack row AND its crate
 * summary ("Red 5") entirely, rows main had always rendered, for stock whose
 * label was perfectly true. This suite pins the narrowed rule:
 *
 *   • the Rack row stands down only when NO holding puts stock on that rack;
 *   • the Crate row is refuted by nothing here and always renders.
 *
 * The refutation predicate itself is unit-tested in @stockpilot/core
 * (holdings-contradict-rack.test.ts). What is only testable HERE is the wiring:
 * that this card feeds it the right label and the right holdings, and gates the
 * right row on the answer. Reverting the component to `source !== 'holdings'`
 * fails the split cases below; reverting it to no gate at all fails the crate
 * case.
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

// Every child except the storage rows themselves — this file asserts on the
// Details card's own DetailRows and nothing else. PlacementsBreakdown in
// particular is stubbed to null so a rack name appearing in the BREAKDOWN can
// never be mistaken for the summary row under test.
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

vi.mock('@/server/services/context', () => ({
  ServiceError: class ServiceError extends Error {
    constructor(
      public code: string,
      message: string,
    ) {
      super(message);
      this.name = 'ServiceError';
    }
  },
  withContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u1',
    role: 'staff' as const,
    permissions: new Set<string>(),
    mfaRequired: false,
    mfaSatisfied: true,
    supabase: {},
  })),
}));

vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: vi.fn(async () => ({ enabled: false, canManage: false })),
}));

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
  LocationsService: { forCurrentUser: vi.fn(async () => ({ list: vi.fn(async () => []) })) },
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

/** A BOOK carrying both summaries: rack 39-B, crate Red 5. */
function bookFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: ITEM_ID,
    name: 'Into Algebra 1',
    sku: 'sp-8n8lr-8nd',
    barcode: '9780358118480',
    model_number: null,
    item_type: 'book',
    category_id: null,
    supplier_id: null,
    primary_location_id: null,
    quantity_on_hand: 9,
    reorder_point: 2,
    reorder_quantity: 5,
    retail_price: 100,
    unit_cost: 40,
    unit_of_measure: 'each',
    status: 'active',
    description: null,
    bin_location: null,
    custom_fields: {
      book_rack_number: '39',
      book_rack_row: 'B',
      book_crate_color: 'red',
      book_crate_number: '5',
    },
    tracking_type: 'none',
    public_visibility: 'internal_only',
    public_display_name: null,
    awaiting_first_receipt: false,
    staged_quantity: 0,
    unplaced_quantity: 0,
    updated_by: null,
    updated_at: null,
    ...overrides,
  };
}

/** An `InventoryService.placements()` row — name + kind is what the card reads. */
const holding = (name: string, kind: string | null, quantity: number) => ({
  locationId: `loc-${name}`,
  name,
  kind,
  warehouseId: null,
  quantity,
});

/** The rendered value of a DetailRow, or null when the row is absent. The row
 *  is a LABEL paragraph followed by its value container — find the label, read
 *  its sibling, so a rack number appearing elsewhere on the page cannot pass. */
function detailRow(label: string): string | null {
  const heading = screen.queryAllByText(label, { selector: 'p' })[0];
  return heading?.nextElementSibling?.textContent ?? null;
}

async function renderCard(item: Record<string, unknown>, holdings: unknown[]) {
  inventoryGet.mockResolvedValue(item);
  inventoryPlacements.mockResolvedValue(holdings);
  return render(
    await ItemDetail({ id: ITEM_ID, backHref: '/dashboard/books', backLabel: 'Back to books' }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('storage card — a SPLIT is not a contradiction (the a0ab90d4 regression)', () => {
  it('split across two RACKS keeps BOTH summary rows', async () => {
    await renderCard(bookFixture(), [
      holding('39-B', 'rack', 4),
      holding('5-A', 'rack', 5),
    ]);
    expect(detailRow('Rack')).toBe('39-B');
    expect(detailRow('Crate')).toContain('Red 5');
  });

  it('a split whose racks do NOT include the label drops only the Rack row', async () => {
    await renderCard(bookFixture(), [
      holding('5-A', 'rack', 4),
      holding('2-C', 'rack', 5),
    ]);
    expect(detailRow('Rack')).toBeNull();
    expect(detailRow('Crate')).toContain('Red 5');
  });
});

describe('storage card — the 0335 stale rack still stands down', () => {
  it('stock entirely in a POSITION-LESS crate hides the Rack row, keeps the Crate row', async () => {
    await renderCard(bookFixture(), [holding('Gray #BIN', 'crate', 9)]);
    expect(detailRow('Rack')).toBeNull();
    expect(detailRow('Crate')).toContain('Red 5');
  });

  it('a POSITIONED crate keeps the rack it sits on — no over-correction', async () => {
    await renderCard(
      bookFixture({ custom_fields: { book_rack_number: '43', book_rack_row: 'B' } }),
      [holding('Gray #BIN on rack 43-B', 'crate', 9)],
    );
    expect(detailRow('Rack')).toBe('43-B');
  });
});

describe('storage card — absence of evidence keeps the label', () => {
  it('no holdings at all renders both rows unchanged', async () => {
    await renderCard(bookFixture(), []);
    expect(detailRow('Rack')).toBe('39-B');
    expect(detailRow('Crate')).toContain('Red 5');
  });

  it('a single holding ON the labelled rack renders both rows', async () => {
    await renderCard(bookFixture(), [holding('39-B', 'rack', 9)]);
    expect(detailRow('Rack')).toBe('39-B');
    expect(detailRow('Crate')).toContain('Red 5');
  });

  it('SITE holdings are not rack evidence — a NULL-kind holding leaves the label alone', async () => {
    // `locations.kind` is NULL for a SITE (never backfill it), and the card
    // narrows to rack/crate rows before asking. Dropping that filter would make
    // "DC4" refute rack 39-B and blank a true row.
    await renderCard(bookFixture(), [holding('DC4', null, 9)]);
    expect(detailRow('Rack')).toBe('39-B');
  });
});
