import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * I1 (fix wave 2, security review sibling of C1's cross-org attach fix):
 * this HOST computes `canReportProblem` from `can(ctx, 'maintenance_requests
 * :submit')` and `maintenanceRequestsEnabled` from the permission AND
 * `isModuleEnabled(ctx, 'maintenance_requests')` (a module_enabled RPC through
 * `checkModuleAccess` until the 2026-09-22 item-page latency fix; see the
 * module-source block at the end of this file), then wires them into
 * `ReportProblemButton`'s `canSubmit` / `moduleEnabled` props.
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
const marketPricePanelProps = vi.fn();
vi.mock('@/components/inventory/market-price-panel', () => ({
  MarketPricePanel: (props: Record<string, unknown>) => {
    marketPricePanelProps(props);
    return null;
  },
}));
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
    // `ctx.enabledModules`: the organization's modules as withContext() resolved
    // them (the ACCESS rule: enabled rows, or the all-modules comp).
    enabledModules: new Set<string>(),
  },
}));
// The module answer used to be a module_enabled RPC per module, through this
// helper. It must not be consulted any more: the render already holds the
// answer in ctx. Kept as a spy so a regression back to it fails loudly.
const checkModuleAccessMock = vi.fn(async (..._args: unknown[]) => ({
  enabled: true,
  canManage: false,
}));

vi.mock('@/server/services/context', async (importOriginal) => {
  // The REAL `isModuleEnabled` (not a stand-in): these tests are about the
  // component handing it the right ctx and module id.
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
      role: ctxHolder.current.role,
      permissions: ctxHolder.current.permissions,
      mfaRequired: false,
      mfaSatisfied: true,
      enabledModules: ctxHolder.current.enabledModules,
      supabase: {},
    })),
  };
});

vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: (...args: unknown[]) => checkModuleAccessMock(...args),
}));

const inventoryGet = vi.fn();
const inventoryPlacements = vi.fn(async () => []);
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

const latestObservation = vi.fn(async (..._args: unknown[]) => ({ id: 'obs-1', price: 12.5 }));
vi.mock('@/server/services/price-tracking', () => ({
  PriceTrackingService: {
    forCurrentUser: vi.fn(async () => ({ getLatestObservation: latestObservation })),
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
  ctxHolder.current = { ...ctxHolder.current, role: 'staff', permissions: perms };
}

/** The organization's enabled modules, as withContext() would hand them over. */
function setModules(...ids: string[]) {
  ctxHolder.current = { ...ctxHolder.current, enabledModules: new Set(ids) };
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
  // price_tracking OFF unless a test turns it on; maintenance_requests
  // controlled per test.
  setModules('maintenance_requests');
});

describe('ItemDetail host — ReportProblemButton gating (I1, fix wave 2)', () => {
  it('permission GRANTED + module ENABLED -> canSubmit=true, moduleEnabled=true, prefill.itemId=this item', async () => {
    setPermissions(true);
    setModules('maintenance_requests');
    await renderItemDetail();
    expect(reportProblemButtonProps).toHaveBeenCalledWith(
      expect.objectContaining({ canSubmit: true, moduleEnabled: true, prefill: { itemId: ITEM_ID } }),
    );
  });

  it('permission GRANTED + module DISABLED -> canSubmit=true, moduleEnabled=false (SWAP GUARD: a props swap here would report canSubmit=false, moduleEnabled=true — the opposite of this assertion)', async () => {
    setPermissions(true);
    setModules();
    await renderItemDetail();
    expect(reportProblemButtonProps).toHaveBeenCalledWith(
      expect.objectContaining({ canSubmit: true, moduleEnabled: false }),
    );
  });

  it('permission DENIED + module ENABLED -> canSubmit=false, moduleEnabled=false — permission first: an enabled module is not reported to a viewer who cannot submit (SWAP GUARD: a swap would report canSubmit=false, moduleEnabled=true here)', async () => {
    setPermissions(false);
    setModules('maintenance_requests');
    await renderItemDetail();
    expect(reportProblemButtonProps).toHaveBeenCalledWith(
      expect.objectContaining({ canSubmit: false, moduleEnabled: false }),
    );
  });

  it('permission DENIED + module DISABLED -> canSubmit=false, moduleEnabled=false', async () => {
    setPermissions(false);
    setModules();
    await renderItemDetail();
    expect(reportProblemButtonProps).toHaveBeenCalledWith(
      expect.objectContaining({ canSubmit: false, moduleEnabled: false }),
    );
  });

  it('moduleEnabled follows the maintenance_requests MODULE, not the permission and not another module', async () => {
    setPermissions(true);
    // Another optional module on, maintenance_requests off: must read false.
    setModules('price_tracking');
    await renderItemDetail();
    expect(reportProblemButtonProps).toHaveBeenCalledWith(
      expect.objectContaining({ canSubmit: true, moduleEnabled: false }),
    );
  });
});

/**
 * The module answers come from `ctx.enabledModules`, the set withContext()
 * already resolved for this request with the ACCESS rule (lib/modules/
 * effective-modules: an enabled organization_modules row, or the all-modules
 * comp). That is what module_enabled() answers since migration 0354 for a
 * member's own organization, and it is the set the sidebar renders from. What
 * changed is the cost: production logs (2026-09-22) showed the two
 * module_enabled RPCs as two more serial levels of this page.
 */
describe('ItemDetail host — module flags come from ctx.enabledModules (no module_enabled round trip)', () => {
  const ISBN = '9780306406157';

  it('never consults checkModuleAccess (the per-module RPC), whatever the permissions and modules', async () => {
    setPermissions(true);
    setModules('maintenance_requests', 'price_tracking');
    inventoryGet.mockResolvedValue(itemFixture({ barcode: ISBN, item_type: 'book' }));
    await renderItemDetail();
    expect(checkModuleAccessMock).not.toHaveBeenCalled();
  });

  it('price_tracking ON in ctx + an ISBN barcode -> the market price panel renders with the latest observation', async () => {
    setModules('price_tracking');
    inventoryGet.mockResolvedValue(itemFixture({ barcode: ISBN, item_type: 'book' }));
    await renderItemDetail();
    expect(latestObservation).toHaveBeenCalledWith(ITEM_ID);
    expect(marketPricePanelProps).toHaveBeenCalledWith(
      expect.objectContaining({ initial: { id: 'obs-1', price: 12.5 } }),
    );
  });

  it('price_tracking OFF in ctx -> no panel and no observation read, even for an ISBN', async () => {
    setModules('maintenance_requests');
    inventoryGet.mockResolvedValue(itemFixture({ barcode: ISBN, item_type: 'book' }));
    await renderItemDetail();
    expect(latestObservation).not.toHaveBeenCalled();
    expect(marketPricePanelProps).not.toHaveBeenCalled();
  });

  it('a core-only module set (what a failed modules read resolves to) turns both optional modules off', async () => {
    setPermissions(true);
    setModules();
    inventoryGet.mockResolvedValue(itemFixture({ barcode: ISBN, item_type: 'book' }));
    await renderItemDetail();
    expect(marketPricePanelProps).not.toHaveBeenCalled();
    expect(reportProblemButtonProps).toHaveBeenCalledWith(
      expect.objectContaining({ moduleEnabled: false }),
    );
  });
});
