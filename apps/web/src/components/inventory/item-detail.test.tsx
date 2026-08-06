import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * I1 (fix wave 2, security review sibling of C1's cross-org attach fix):
 * this HOST computes `canReportProblem` from `can(ctx, 'maintenance_requests
 * :submit')` (item-detail.tsx:276) and `maintenanceRequestsEnabled` from a
 * sync-gated `checkModuleAccess('maintenance_requests')` call
 * (item-detail.tsx:330-332), then wires them into `ReportProblemButton`'s
 * `canSubmit` / `moduleEnabled` props (item-detail.tsx:446-450).
 * `ReportProblemButton`'s OWN unit tests (report-problem-button.test.tsx)
 * only prove the component obeys whatever two booleans it is handed —
 * nothing proves this HOST derives or wires them correctly. A prop SWAP
 * (`moduleEnabled={canReportProblem} canSubmit={maintenanceRequestsEnabled}`)
 * would pass every existing test in this codebase.
 *
 * ItemDetail is the single shared component behind THREE wrapping pages
 * (dashboard/inventory/[id], dashboard/books/[id], dashboard/rentals/items/
 * [id] — see the component's own doc comment on canReportProblem), so
 * testing it directly here covers all three launch points in one file.
 *
 * These tests drive the real component through all four (module x
 * permission) combinations and assert the EXACT two booleans
 * `ReportProblemButton` received — a swap fails because module-enabled and
 * permission-granted are independently toggled, never in lockstep. Every
 * OTHER permission (items:update, stock:adjust, stock:transfer, ...) and
 * every OTHER module (price_tracking) is held OFF throughout, so no other
 * gated affordance on this huge component interferes with the one under
 * test here.
 */

// next/dynamic wraps ImageUploader at module scope (item-detail.tsx:17-21).
// Replaced with a component that always renders null — this file has no
// interest in the Photos card, and the real lazy-load machinery has no
// browser to hydrate in under jsdom/happy-dom.
vi.mock('next/dynamic', () => ({
  default: () => () => null,
}));

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

// Every OTHER child component item-detail.tsx renders — stubbed to null.
// This file only cares about ReportProblemButton's props; what the rest of
// this 900+ line component renders is out of scope here.
vi.mock('@/components/inventory/item-activity-panel', () => ({ ItemActivityPanel: () => null }));
vi.mock('@/components/inventory/placements-breakdown', () => ({ PlacementsBreakdown: () => null }));
vi.mock('@/components/inventory/barcode-display', () => ({ BarcodeDisplay: () => null }));
vi.mock('@/components/inventory/duplicate-item-dialog', () => ({ DuplicateItemDialog: () => null }));
vi.mock('@/components/dashboard/charts/cost-trend-island', () => ({ CostTrendIsland: () => null }));
vi.mock('@/components/inventory/item-detail-tabs', () => ({ ItemDetailTabs: () => null }));
vi.mock('@/components/inventory/item-serials-panel', () => ({ ItemSerialsPanel: () => null }));
vi.mock('@/components/inventory/public-visibility-control', () => ({ PublicVisibilityControl: () => null }));
vi.mock('@/components/inventory/market-price-panel', () => ({ MarketPricePanel: () => null }));
vi.mock('@/components/inventory/stock-status-badge', () => ({ StockStatusBadge: () => null }));
vi.mock('@/components/inventory/stock-adjust-dialog', () => ({ StockAdjustDialog: () => null }));
vi.mock('@/components/inventory/stock-transfer-dialog', () => ({ StockTransferDialog: () => null }));
vi.mock('@/components/onboarding/page-tour', () => ({ PageTour: () => null }));

// The ONE component under test in this file — a recording spy, never the
// real implementation (that component's own render/visibility logic is
// covered by report-problem-button.test.tsx).
const reportProblemButtonProps = vi.fn();
vi.mock('@/components/maintenance/report-problem-button', () => ({
  ReportProblemButton: (props: Record<string, unknown>) => {
    reportProblemButtonProps(props);
    return null;
  },
}));

const ctxHolder = vi.hoisted(() => ({
  current: {
    role: 'staff' as 'owner' | 'admin' | 'manager' | 'staff' | 'viewer',
    permissions: new Set<string>(),
  },
}));
const checkModuleAccessMock = vi.fn();

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
    role: ctxHolder.current.role,
    permissions: ctxHolder.current.permissions,
    mfaRequired: false,
    mfaSatisfied: true,
    supabase: {},
  })),
}));

vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: (...args: unknown[]) => checkModuleAccessMock(...args),
}));

const inventoryGet = vi.fn();
const inventoryPlacements = vi.fn(async () => []);
vi.mock('@/server/services/inventory', () => ({
  InventoryService: {
    forCurrentUser: vi.fn(async () => ({ get: inventoryGet, placements: inventoryPlacements })),
  },
}));

vi.mock('@/server/services/activity', () => ({
  ActivityService: { forCurrentUser: vi.fn(async () => ({ forItem: vi.fn(async () => []) })) },
  // Real formula (activity.ts:207-209) — trivial, but kept faithful rather
  // than an arbitrary stand-in since it feeds a real comparison
  // (auditsInitialExhausted) this component computes unconditionally.
  auditLimitFor: (limit: number) => Math.max(1, Math.ceil(limit / 2)),
}));

vi.mock('@/server/services/item-images', () => ({
  ItemImagesService: {
    forCurrentUser: vi.fn(async () => ({ list: vi.fn(async () => []), signedUrls: vi.fn(async () => new Map()) })),
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
      itemCostHistory: vi.fn(async () => ({ pointCount: 0, lastUnitCost: null, avgUnitCost: null, series: [] })),
    })),
  },
}));

vi.mock('@/server/services/custom-fields', () => ({
  CustomFieldsService: { forCurrentUser: vi.fn(async () => ({ listDefinitions: vi.fn(async () => []) })) },
}));

// Constructed via `new SerialsService(ctx)` (item-detail.tsx:127), not
// .forCurrentUser() — a REAL class (not `vi.fn().mockImplementation()`,
// which proved unreliable across `new` call sites once `vi.clearAllMocks()`
// ran between tests) so `new` semantics are never in question.
vi.mock('@/server/services/serials', () => ({
  SerialsService: class SerialsService {
    async list() {
      return { rows: [], total: 0 };
    }
  },
}));

// Constructed via `new WarehousesService(ctx)` only when showSerialsPanel &&
// canEditItem — both false throughout this file (tracking_type: 'none',
// serialsPage.total: 0, items:update never granted) — never actually
// invoked, but the module import must still resolve.
vi.mock('@/server/services/warehouses', () => ({
  WarehousesService: class WarehousesService {
    async listNames() {
      return [];
    }
  },
}));

import { ItemDetail } from './item-detail';

const ITEM_ID = '11111111-1111-1111-1111-111111111111';

/** Every field item-detail.tsx reads off `item` (see the file's own `item.`
 *  access sites) — a full, realistic row so no unrelated read throws. */
function itemFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: ITEM_ID,
    name: 'Wall-mounted HVAC unit',
    sku: 'HVAC-WALL-204',
    barcode: null,
    model_number: null,
    item_type: 'product',
    category_id: null,
    supplier_id: null,
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
    updated_by: null,
    updated_at: null,
    ...overrides,
  };
}

/** Grants NONE of the write permissions this component gates on except the
 *  ones each test explicitly sets — keeps every OTHER affordance
 *  (Edit/Duplicate/Adjust/Transfer/PublicVisibility) off so nothing but
 *  ReportProblemButton is exercised. */
function setPermissions(hasMaintenanceSubmit: boolean) {
  const perms = new Set<string>();
  if (hasMaintenanceSubmit) perms.add('maintenance_requests:submit');
  ctxHolder.current = { role: 'staff', permissions: perms };
}

async function renderItemDetail() {
  return render(
    await ItemDetail({ id: ITEM_ID, backHref: '/dashboard/inventory', backLabel: 'Back to inventory' }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  inventoryGet.mockResolvedValue(itemFixture());
  inventoryPlacements.mockResolvedValue([]);
  setPermissions(true);
  // price_tracking OFF throughout (irrelevant to this file, and would add a
  // second checkModuleAccess call this file doesn't need to reason about);
  // maintenance_requests controlled per test.
  checkModuleAccessMock.mockImplementation(async (moduleId: string) =>
    moduleId === 'maintenance_requests' ? { enabled: true, canManage: false } : { enabled: false, canManage: false },
  );
});

describe('ItemDetail host — ReportProblemButton gating (I1, fix wave 2)', () => {
  it('permission GRANTED + module ENABLED -> canSubmit=true, moduleEnabled=true, prefill.itemId=this item', async () => {
    setPermissions(true);
    checkModuleAccessMock.mockImplementation(async (moduleId: string) =>
      moduleId === 'maintenance_requests' ? { enabled: true, canManage: false } : { enabled: false, canManage: false },
    );
    await renderItemDetail();
    expect(reportProblemButtonProps).toHaveBeenCalledWith(
      expect.objectContaining({ canSubmit: true, moduleEnabled: true, prefill: { itemId: ITEM_ID } }),
    );
  });

  it('permission GRANTED + module DISABLED -> canSubmit=true, moduleEnabled=false (SWAP GUARD: a props swap here would report canSubmit=false, moduleEnabled=true — the opposite of this assertion)', async () => {
    setPermissions(true);
    checkModuleAccessMock.mockImplementation(async () => ({ enabled: false, canManage: false }));
    await renderItemDetail();
    expect(reportProblemButtonProps).toHaveBeenCalledWith(
      expect.objectContaining({ canSubmit: true, moduleEnabled: false }),
    );
  });

  it('permission DENIED + module ENABLED -> canSubmit=false, moduleEnabled=false — the sync-gate-first short circuit never calls checkModuleAccess for maintenance_requests at all (SWAP GUARD: a swap would report canSubmit=false, moduleEnabled=true here)', async () => {
    setPermissions(false);
    checkModuleAccessMock.mockImplementation(async (moduleId: string) =>
      moduleId === 'maintenance_requests' ? { enabled: true, canManage: false } : { enabled: false, canManage: false },
    );
    await renderItemDetail();
    expect(reportProblemButtonProps).toHaveBeenCalledWith(
      expect.objectContaining({ canSubmit: false, moduleEnabled: false }),
    );
    expect(checkModuleAccessMock).not.toHaveBeenCalledWith('maintenance_requests');
  });

  it('permission DENIED + module DISABLED -> canSubmit=false, moduleEnabled=false', async () => {
    setPermissions(false);
    checkModuleAccessMock.mockImplementation(async () => ({ enabled: false, canManage: false }));
    await renderItemDetail();
    expect(reportProblemButtonProps).toHaveBeenCalledWith(
      expect.objectContaining({ canSubmit: false, moduleEnabled: false }),
    );
  });

  it('queries checkModuleAccess with the maintenance_requests module id — proves moduleEnabled is sourced from the MODULE check, not reused from the permission check', async () => {
    setPermissions(true);
    checkModuleAccessMock.mockImplementation(async (moduleId: string) =>
      moduleId === 'maintenance_requests' ? { enabled: true, canManage: false } : { enabled: false, canManage: false },
    );
    await renderItemDetail();
    expect(checkModuleAccessMock).toHaveBeenCalledWith('maintenance_requests');
  });
});
