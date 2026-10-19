import { render, screen, within } from '@testing-library/react';
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
const overdueRemindersOn = vi.fn(async (): Promise<boolean | null> => true);
const orgRow = vi.fn(async (): Promise<{ timezone: string | null } | null> => ({
  timezone: 'America/New_York',
}));
const emailsCardProps = vi.fn();
const headerProps = vi.fn();
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
  RentalDetailHeader: (props: Record<string, unknown>) => {
    headerProps(props);
    return null;
  },
}));
vi.mock('@/components/rentals/rental-emails-card', () => ({
  RentalEmailsCard: (props: Record<string, unknown>) => {
    emailsCardProps(props);
    return null;
  },
}));
vi.mock('@/lib/dashboard/request-cache', () => ({
  getOrgRowForRequest: () => orgRow(),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));

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
  RentalsService: {
    forCurrentUser: vi.fn(async () => ({ get: rentalGet, overdueRemindersOn })),
  },
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
  overdueRemindersOn.mockResolvedValue(true);
  orgRow.mockResolvedValue({ timezone: 'America/New_York' });
});

describe('rentals/[id] host — ReportProblemButton gating (I1, fix wave 2)', () => {
  it('permission GRANTED + module ENABLED -> canSubmit=true, moduleEnabled=true, prefill.rentalId=this rental', async () => {
    setPermissions(true);
    checkModuleAccessMock.mockResolvedValue({ enabled: true, canManage: false });
    await renderPage();
    expect(reportProblemButtonProps).toHaveBeenCalledWith(
      expect.objectContaining({
        canSubmit: true,
        moduleEnabled: true,
        prefill: { rentalId: RENTAL_ID },
      }),
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

describe('rentals/[id] host: the borrower emails card (2026-09-25)', () => {
  // The card decides the overdue reminder's state from what the page hands it.
  // These pin that the page hands it the sweep's own switch (the explicit
  // Rentals row, RentalsService.overdueRemindersOn), the organization's zone,
  // and one render moment, and that the header prints in the same zone.
  it('passes the rental, the reminders switch, the organization zone and the render moment', async () => {
    overdueRemindersOn.mockResolvedValue(false);
    const before = Date.now();
    await renderPage();
    const after = Date.now();
    expect(overdueRemindersOn).toHaveBeenCalledTimes(1);
    const props = emailsCardProps.mock.calls.at(-1)?.[0] as {
      rental: unknown;
      remindersOn: boolean | null;
      nowMs: number;
      timeZone: string;
    };
    expect(props.rental).toEqual(rentalFixture());
    expect(props.remindersOn).toBe(false);
    expect(props.timeZone).toBe('America/New_York');
    expect(props.nowMs).toBeGreaterThanOrEqual(before);
    expect(props.nowMs).toBeLessThanOrEqual(after);
    expect(headerProps.mock.calls.at(-1)?.[0]).toMatchObject({
      timeZone: 'America/New_York',
      nowMs: props.nowMs,
    });
  });

  it('an unreadable switch reaches the card as null ("could not check"), not as on or off', async () => {
    overdueRemindersOn.mockResolvedValue(null);
    await renderPage();
    expect(emailsCardProps.mock.calls.at(-1)?.[0]).toMatchObject({ remindersOn: null });
  });

  it('an unreadable organization row falls back to the documented default zone, not a failed page', async () => {
    orgRow.mockRejectedValue(new Error('org read failed'));
    await renderPage();
    expect(emailsCardProps.mock.calls.at(-1)?.[0]).toMatchObject({
      timeZone: 'America/Los_Angeles',
    });
  });
});

// Redesign P4.D1: the page in the redesign's look. One h1, the back link and
// the items card with every column; Notes still hides below sm and its words
// then ride under the item's name (the accessible alternative), and an
// unreadable item still shows its raw id.
describe('rentals/[id]: header and items card', () => {
  it('one h1, the plain back link, and the items with SKU, Qty and Notes', async () => {
    rentalGet.mockResolvedValue({
      ...rentalFixture(),
      lines: [
        { id: 'l1', item_id: 'i1', quantity: 2, notes: 'Bring stakes' },
        { id: 'l2', item_id: 'gone', quantity: 1, notes: null },
      ],
    });
    inventoryByIds.mockResolvedValue([{ id: 'i1', name: 'Event tent', sku: 'TENT-1' }] as never);
    await renderPage();
    expect(screen.getAllByRole('heading', { level: 1 }).map((x) => x.textContent)).toEqual([
      'Rental detail',
    ]);
    expect(screen.getByRole('link', { name: '← Back to rentals' }).getAttribute('href')).toBe(
      '/dashboard/rentals',
    );
    expect(screen.getByRole('heading', { name: 'Items (2)' })).toBeTruthy();
    const headers = screen.getAllByRole('columnheader').map((x) => x.textContent);
    expect(headers).toEqual(['Item', 'SKU', 'Qty', 'Notes']);
    expect(screen.getAllByRole('columnheader')[3]!.className).toMatch(/hidden sm:table-cell/);

    const tent = screen.getByRole('link', { name: 'Event tent' });
    expect(tent.getAttribute('href')).toBe('/dashboard/rentals/items/i1');
    const row = tent.closest('tr')!;
    const narrow = within(row.querySelectorAll('td')[0]!).getByText('Notes: Bring stakes');
    expect(narrow.className).toMatch(/(^|\s)sm:hidden(\s|$)/);
    expect(row.querySelectorAll('td')[1]!.textContent).toBe('TENT-1');
    expect(row.querySelectorAll('td')[3]!.textContent).toBe('Bring stakes');

    // The unreadable line keeps its raw id and no narrow notes line.
    const gone = screen.getByText('gone').closest('tr')!;
    expect(gone.querySelectorAll('td')[0]!.textContent).toBe('gone');
  });

  it('no lines: the words stay', async () => {
    await renderPage();
    expect(screen.getByRole('heading', { name: 'Items (0)' })).toBeTruthy();
    expect(screen.getByText('No items on this rental.')).toBeTruthy();
  });
});
