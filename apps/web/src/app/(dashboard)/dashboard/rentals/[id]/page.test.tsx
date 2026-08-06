import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * I1 (fix wave 2, security review sibling of C1's cross-org attach fix):
 * this HOST computes `canReportProblem` from `can(ctx, 'maintenance_requests
 * :submit')` and `maintenanceModuleEnabled` from `checkModuleAccess(
 * 'maintenance_requests')`, then wires them into `ReportProblemButton`'s
 * `canSubmit` / `moduleEnabled` props (page.tsx:52-57,69-73).
 * `ReportProblemButton`'s OWN unit tests (report-problem-button.test.tsx)
 * only prove the component obeys whatever two booleans it is handed —
 * nothing proves this HOST derives or wires them correctly. A prop SWAP
 * (`moduleEnabled={canReportProblem} canSubmit={maintenanceModuleEnabled}`)
 * would pass every existing test in this codebase.
 *
 * These tests drive the real page through all four (module x permission)
 * combinations and assert the EXACT two booleans `ReportProblemButton`
 * received, sourced from a mocked `checkModuleAccess` and a controlled
 * `permissions` set respectively — a swap fails because module-enabled and
 * permission-granted are independently toggled, never in lockstep.
 */

const rentalGet = vi.fn();
const inventoryByIds = vi.fn(async () => []);
const warehousesListNames = vi.fn(async () => []);
const checkModuleAccessMock = vi.fn();
const reportProblemButtonProps = vi.fn();

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('notFound');
  }),
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
}));

vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
  };
});

vi.mock('@/components/rentals/rental-actions-panel', () => ({
  RentalActionsPanel: () => null,
}));
vi.mock('@/components/rentals/rental-detail-header', () => ({
  RentalDetailHeader: () => null,
}));

// The ONE component under test in this file — a recording spy, never the
// real implementation (that component's own render/visibility logic is
// covered by report-problem-button.test.tsx). Renders a marker so a test
// could also assert presence/absence via the DOM if ever needed.
vi.mock('@/components/maintenance/report-problem-button', () => ({
  ReportProblemButton: (props: Record<string, unknown>) => {
    reportProblemButtonProps(props);
    return null;
  },
}));

const ctxHolder = vi.hoisted(() => ({
  current: {
    role: 'staff' as 'owner' | 'admin' | 'manager' | 'staff' | 'viewer',
    permissions: new Set<string>(['rentals:read']),
  },
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u1',
    role: ctxHolder.current.role,
    permissions: ctxHolder.current.permissions,
  })),
}));

vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: (...args: unknown[]) => checkModuleAccessMock(...args),
}));

vi.mock('@/server/services/inventory', () => ({
  InventoryService: { forCurrentUser: vi.fn(async () => ({ byIds: inventoryByIds })) },
}));
vi.mock('@/server/services/rentals', () => ({
  RentalsService: { forCurrentUser: vi.fn(async () => ({ get: rentalGet })) },
}));
vi.mock('@/server/services/warehouses', () => ({
  WarehousesService: { forCurrentUser: vi.fn(async () => ({ listNames: warehousesListNames })) },
}));

import RentalDetailPage from './page';

const RENTAL_ID = '11111111-1111-1111-1111-111111111111';

function rentalFixture() {
  return {
    id: RENTAL_ID,
    warehouse_id: 'wh-1',
    status: 'checked_out',
    lines: [],
  };
}

/** Sets the permission side of the matrix. `rentals:read` is always kept —
 *  it is this page's OWN unrelated visibility gate (line 25); losing it
 *  would redirect before ReportProblemButton is ever reached, which is a
 *  different code path than the one these tests target. */
function setPermissions(hasSubmit: boolean) {
  const perms = new Set<string>(['rentals:read']);
  if (hasSubmit) perms.add('maintenance_requests:submit');
  ctxHolder.current = { role: 'staff', permissions: perms };
}

async function renderPage() {
  return render(await RentalDetailPage({ params: Promise.resolve({ id: RENTAL_ID }) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  rentalGet.mockResolvedValue(rentalFixture());
  warehousesListNames.mockResolvedValue([]);
  inventoryByIds.mockResolvedValue([]);
  setPermissions(true);
  checkModuleAccessMock.mockResolvedValue({ enabled: true, canManage: false });
});

describe('rentals/[id] host — ReportProblemButton gating (I1, fix wave 2)', () => {
  it('permission GRANTED + module ENABLED -> canSubmit=true, moduleEnabled=true, prefill.rentalId=this rental', async () => {
    setPermissions(true);
    checkModuleAccessMock.mockResolvedValue({ enabled: true, canManage: false });
    await renderPage();
    expect(reportProblemButtonProps).toHaveBeenCalledWith(
      expect.objectContaining({ canSubmit: true, moduleEnabled: true, prefill: { rentalId: RENTAL_ID } }),
    );
  });

  it('permission GRANTED + module DISABLED -> canSubmit=true, moduleEnabled=false (SWAP GUARD: a props swap here would report canSubmit=false, moduleEnabled=true — the opposite of this assertion)', async () => {
    setPermissions(true);
    checkModuleAccessMock.mockResolvedValue({ enabled: false, canManage: false });
    await renderPage();
    expect(reportProblemButtonProps).toHaveBeenCalledWith(
      expect.objectContaining({ canSubmit: true, moduleEnabled: false }),
    );
  });

  it('permission DENIED + module ENABLED -> canSubmit=false, moduleEnabled=false — the sync-gate-first short circuit never even calls checkModuleAccess (SWAP GUARD: a swap would report canSubmit=false, moduleEnabled=true here)', async () => {
    setPermissions(false);
    checkModuleAccessMock.mockResolvedValue({ enabled: true, canManage: false });
    await renderPage();
    expect(reportProblemButtonProps).toHaveBeenCalledWith(
      expect.objectContaining({ canSubmit: false, moduleEnabled: false }),
    );
    // Page-level cost-avoidance behavior (page.tsx:55-57): the module RPC is
    // only paid for a viewer who could actually use the button.
    expect(checkModuleAccessMock).not.toHaveBeenCalled();
  });

  it('permission DENIED + module DISABLED -> canSubmit=false, moduleEnabled=false', async () => {
    setPermissions(false);
    checkModuleAccessMock.mockResolvedValue({ enabled: false, canManage: false });
    await renderPage();
    expect(reportProblemButtonProps).toHaveBeenCalledWith(
      expect.objectContaining({ canSubmit: false, moduleEnabled: false }),
    );
  });

  it('queries checkModuleAccess with the maintenance_requests module id — proves moduleEnabled is sourced from the MODULE check, not reused from the permission check', async () => {
    setPermissions(true);
    checkModuleAccessMock.mockResolvedValue({ enabled: true, canManage: false });
    await renderPage();
    expect(checkModuleAccessMock).toHaveBeenCalledWith('maintenance_requests');
  });
});
