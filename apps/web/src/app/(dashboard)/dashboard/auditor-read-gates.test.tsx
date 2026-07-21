import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Auditor-visibility read gates (Unit 2): the five surfaces that used to
// gate their pages on WRITE permissions now gate on the grantable :read
// permissions. These tests drive each server page component with a mocked
// request context and assert the pinned contract:
//   - viewer WITHOUT the grant → redirect('/dashboard') (unchanged);
//   - viewer WITH the read grant (effective-permission set) → the page
//     renders READ-ONLY (no write CTAs);
//   - staff/manager (static role defaults, mirrored in Unit 1) → unchanged,
//     write CTAs included.

const ctxHolder = vi.hoisted(() => ({
  current: {
    role: 'viewer' as 'owner' | 'admin' | 'manager' | 'staff' | 'viewer',
    permissions: undefined as ReadonlySet<string> | undefined,
  },
}));

function setCtx(
  role: 'owner' | 'admin' | 'manager' | 'staff' | 'viewer',
  permissions?: string[],
) {
  ctxHolder.current = {
    role,
    permissions: permissions ? new Set(permissions) : undefined,
  };
}

vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u1',
    role: ctxHolder.current.role,
    ...(ctxHolder.current.permissions
      ? { permissions: ctxHolder.current.permissions }
      : {}),
  })),
}));

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
  notFound: vi.fn(() => {
    throw new Error('notFound');
  }),
  // Client hooks used by embedded client components (e.g. the bundles
  // page's ArchiveViewToggle).
  usePathname: () => '/dashboard',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

// Every module gate is "on" — these tests exercise the PERMISSION gates.
vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: vi.fn(async () => ({ enabled: true, canManage: false })),
}));
vi.mock('@/components/dashboard/module-not-enabled', () => ({
  ModuleNotEnabled: () => null,
}));

// The real context.ts pulls next/headers + the server supabase client.
vi.mock('@/server/services/context', () => ({
  ServiceError: class ServiceError extends Error {
    constructor(
      public code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));

// Server supabase client (assignee lookups etc.) — empty results.
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => {
    const chain: Record<string, unknown> = {};
    const self = new Proxy(chain, {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) =>
            resolve({ data: [], error: null, count: 0 });
        }
        return () => self;
      },
    });
    return { from: () => self };
  }),
}));

// ── Per-page service + client-component mocks ──────────────────────────────

const ccList = vi.fn(async () => []);
const ccGetDetailPage = vi.fn(async () => ({
  header: {
    id: 'cc-1',
    status: 'in_progress',
    warehouse_id: null,
    notes: null,
    assigned_to: null,
    started_at: '2026-07-01T00:00:00Z',
    completed_at: null,
  },
  lines: [],
  summary: { total: 0, counted: 0, varianceCount: 0, netDelta: 0 },
  total: 0,
  pageSize: 50,
  page: 1,
}));
const ccItemsInScope = vi.fn(async () => 0);
vi.mock('@/server/services/cycle-counts', () => ({
  CycleCountsService: {
    forCurrentUser: vi.fn(async () => ({
      list: ccList,
      getDetailPage: ccGetDetailPage,
      itemsInScopeCount: ccItemsInScope,
    })),
  },
}));
const warehousesListNames = vi.fn(async () => []);
vi.mock('@/server/services/warehouses', () => ({
  WarehousesService: {
    forCurrentUser: vi.fn(async () => ({ listNames: warehousesListNames })),
  },
}));
const cycleCountDetailProps = vi.fn();
vi.mock('@/components/cycle-counts/cycle-count-detail', () => ({
  CycleCountDetail: (props: Record<string, unknown>) => {
    cycleCountDetailProps(props);
    return null;
  },
}));

const scheduleListInRange = vi.fn(async () => []);
vi.mock('@/server/services/schedule', () => ({
  ScheduleService: {
    forCurrentUser: vi.fn(async () => ({ listInRange: scheduleListInRange })),
  },
}));
const scheduleCalendarProps = vi.fn();
vi.mock('@/components/schedule/schedule-calendar', () => ({
  ScheduleCalendar: (props: Record<string, unknown>) => {
    scheduleCalendarProps(props);
    return null;
  },
}));

const bundlesList = vi.fn(async () => []);
vi.mock('@/server/services/bundles', () => ({
  BundlesService: {
    forCurrentUser: vi.fn(async () => ({ list: bundlesList })),
  },
}));

const rentalsList = vi.fn(async () => ({ rentals: [] }));
vi.mock('@/server/services/rentals', () => ({
  RentalsService: {
    forCurrentUser: vi.fn(async () => ({ list: rentalsList })),
  },
}));
const inventoryByIds = vi.fn(async () => []);
vi.mock('@/server/services/inventory', () => ({
  InventoryService: {
    forCurrentUser: vi.fn(async () => ({ byIds: inventoryByIds })),
  },
}));
vi.mock('@/components/rentals/rentals-list-table', () => ({
  RentalsListTable: () => null,
}));
vi.mock('@/components/rentals/rentals-tabs', () => ({
  RentalsTabs: () => null,
}));

const returnsList = vi.fn(async () => []);
vi.mock('@/server/services/returns', () => ({
  RMAService: {
    forCurrentUser: vi.fn(async () => ({ list: returnsList })),
  },
}));

vi.mock('@/components/reports/pdf-download-dropdown', () => ({
  PdfDownloadDropdown: () => null,
}));
vi.mock('@/components/onboarding/page-tour', () => ({
  PageTour: () => null,
}));

import CycleCountsPage from './cycle-counts/page';
import CycleCountDetailPage from './cycle-counts/[id]/page';
import SchedulePage from './schedule/page';
import BundlesListPage from './bundles/page';
import RentalsPage from './rentals/page';
import ReturnsPage from './returns/page';
import ReportsPage from './reports/page';

beforeEach(() => {
  vi.clearAllMocks();
  setCtx('viewer');
});

const emptySearchParams = Promise.resolve({});

describe('cycle counts list (/dashboard/cycle-counts)', () => {
  it('viewer without the grant is redirected', async () => {
    setCtx('viewer', ['items:read']);
    await expect(CycleCountsPage()).rejects.toThrow('redirect:/dashboard');
  });
  it('viewer WITH cycle_counts:read renders read-only (no Start-a-count CTA)', async () => {
    setCtx('viewer', ['cycle_counts:read']);
    render(await CycleCountsPage());
    expect(screen.getByRole('heading', { name: 'Cycle counts' })).toBeInTheDocument();
    expect(screen.queryByText('+ Start a count')).not.toBeInTheDocument();
    // Empty-state CTA is a write affordance too.
    expect(screen.queryByText('Start your first count')).not.toBeInTheDocument();
  });
  it('staff (static defaults) is unchanged: page renders WITH the CTA', async () => {
    setCtx('staff');
    render(await CycleCountsPage());
    expect(screen.getByText('+ Start a count')).toBeInTheDocument();
  });
});

describe('cycle count detail (/dashboard/cycle-counts/[id])', () => {
  const args = {
    params: Promise.resolve({ id: 'cc-1' }),
    searchParams: emptySearchParams,
  };
  it('viewer without the grant is redirected (page used to be UNGATED)', async () => {
    setCtx('viewer', ['items:read']);
    await expect(CycleCountDetailPage(args)).rejects.toThrow('redirect:/dashboard');
  });
  it('viewer WITH cycle_counts:read renders with canAdjust=false (read-only detail)', async () => {
    setCtx('viewer', ['cycle_counts:read']);
    render(await CycleCountDetailPage(args));
    expect(cycleCountDetailProps).toHaveBeenCalledWith(
      expect.objectContaining({ canAdjust: false, canAssign: false }),
    );
  });
  it('staff keeps canAdjust=true', async () => {
    setCtx('staff');
    render(await CycleCountDetailPage(args));
    expect(cycleCountDetailProps).toHaveBeenCalledWith(
      expect.objectContaining({ canAdjust: true }),
    );
  });
});

describe('schedule (/dashboard/schedule)', () => {
  const args = { searchParams: emptySearchParams };
  it('viewer without the grant is redirected', async () => {
    setCtx('viewer', ['items:read']);
    await expect(SchedulePage(args)).rejects.toThrow('redirect:/dashboard');
  });
  it('viewer WITH schedule:read renders the calendar with canManage=false', async () => {
    setCtx('viewer', ['schedule:read']);
    render(await SchedulePage(args));
    expect(scheduleCalendarProps).toHaveBeenCalledWith(
      expect.objectContaining({ canManage: false }),
    );
  });
  it('manager (static defaults) is unchanged: canManage=true', async () => {
    setCtx('manager');
    render(await SchedulePage(args));
    expect(scheduleCalendarProps).toHaveBeenCalledWith(
      expect.objectContaining({ canManage: true }),
    );
  });
  it('staff (no schedule:read by default) stays redirected — schedule was manager+', async () => {
    setCtx('staff');
    await expect(SchedulePage(args)).rejects.toThrow('redirect:/dashboard');
  });
});

describe('bundles (/dashboard/bundles)', () => {
  const args = { searchParams: emptySearchParams };
  it('viewer without the grant is redirected', async () => {
    setCtx('viewer', ['items:read']);
    await expect(BundlesListPage(args)).rejects.toThrow('redirect:/dashboard');
  });
  it('viewer WITH bundles:read renders read-only (no New-bundle CTA)', async () => {
    setCtx('viewer', ['bundles:read']);
    render(await BundlesListPage(args));
    expect(screen.getByRole('heading', { name: 'Bundles' })).toBeInTheDocument();
    expect(screen.queryByText('+ New bundle')).not.toBeInTheDocument();
  });
  it('staff (static defaults) still sees the list', async () => {
    setCtx('staff');
    render(await BundlesListPage(args));
    expect(screen.getByRole('heading', { name: 'Bundles' })).toBeInTheDocument();
  });
});

describe('rentals (/dashboard/rentals)', () => {
  const args = { searchParams: emptySearchParams };
  it('viewer without the grant is redirected (page gains an explicit gate)', async () => {
    setCtx('viewer', ['items:read']);
    await expect(RentalsPage(args)).rejects.toThrow('redirect:/dashboard');
  });
  it('viewer WITH rentals:read renders read-only (no New-rental CTA)', async () => {
    setCtx('viewer', ['rentals:read']);
    render(await RentalsPage(args));
    expect(screen.getByRole('heading', { name: 'Rentals' })).toBeInTheDocument();
    expect(screen.queryByText('+ New rental')).not.toBeInTheDocument();
  });
  it('staff (static defaults) is unchanged: CTA renders', async () => {
    setCtx('staff');
    render(await RentalsPage(args));
    expect(screen.getByText('+ New rental')).toBeInTheDocument();
  });
});

describe('returns (/dashboard/returns)', () => {
  const args = { searchParams: emptySearchParams };
  it('viewer without the grant is redirected', async () => {
    setCtx('viewer', ['items:read']);
    await expect(ReturnsPage(args)).rejects.toThrow('redirect:/dashboard');
  });
  it('viewer WITH returns:read renders the list', async () => {
    setCtx('viewer', ['returns:read']);
    render(await ReturnsPage(args));
    expect(screen.getByRole('heading', { name: 'Returns' })).toBeInTheDocument();
    expect(returnsList).toHaveBeenCalled();
  });
  it('manager (static defaults) is unchanged', async () => {
    setCtx('manager');
    render(await ReturnsPage(args));
    expect(screen.getByRole('heading', { name: 'Returns' })).toBeInTheDocument();
  });
  it('staff (no returns:read by default) stays redirected — returns was manager+', async () => {
    setCtx('staff');
    await expect(ReturnsPage(args)).rejects.toThrow('redirect:/dashboard');
  });
});

describe('reports (/dashboard/reports)', () => {
  it('viewer without reports:read is redirected (page used to be nav-gated only)', async () => {
    setCtx('viewer', ['items:read']);
    await expect(ReportsPage()).rejects.toThrow('redirect:/dashboard');
  });
  it('viewer WITH reports:read renders the hub', async () => {
    setCtx('viewer', ['reports:read']);
    render(await ReportsPage());
    expect(screen.getByRole('heading', { name: 'Reports' })).toBeInTheDocument();
  });
  it('staff (static defaults include reports:read) is unchanged', async () => {
    setCtx('staff');
    render(await ReportsPage());
    expect(screen.getByRole('heading', { name: 'Reports' })).toBeInTheDocument();
  });
});
