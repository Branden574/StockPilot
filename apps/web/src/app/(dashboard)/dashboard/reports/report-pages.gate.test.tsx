import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

/**
 * Security invariant (2026-09-28): every report page checks reports:read and
 * the modules its report reads ITSELF, before it reads anything.
 *
 * The reports layout checks reports:read too, but a layout's check does not
 * stop its page from rendering (Next renders the page's server tree
 * alongside the layout), so each page used to rely on the layout alone, and
 * the lot pages checked only their module. Now: no reports:read redirects to
 * the dashboard before any service or client is built; a module that is off
 * shows the module-not-enabled card; the MFA step-up the data path would
 * refuse with shows a state instead of an error page.
 */

const ctxBox = vi.hoisted(() => ({ ctx: null as unknown }));
// What the page gate says of a module the context does not hold: off, or
// (checkFailed) its state could not be read. Read from the same
// request-cached module set as the context, so it costs no read here.
const gateBox = vi.hoisted(() => ({
  access: { enabled: false, canManage: false } as {
    enabled: boolean;
    canManage: boolean;
    checkFailed?: boolean;
  },
}));
vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: vi.fn(async () => gateBox.access),
}));
vi.mock('@/server/services/context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/services/context')>();
  return { ...actual, withContext: vi.fn(async () => ctxBox.ctx) };
});
const { routerRefresh } = vi.hoisted(() => ({ routerRefresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
  notFound: vi.fn(() => {
    throw new Error('notFound');
  }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: routerRefresh }),
  usePathname: () => '/dashboard/reports',
  useSearchParams: () => new URLSearchParams(),
}));
const reads = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('@/server/services/reports', () => ({
  ReportsService: {
    forCurrentUser: vi.fn(async () => {
      reads.calls.push('ReportsService');
      throw new Error('ReportsService read');
    }),
  },
}));
vi.mock('@/server/services/lots', () => ({
  LotsService: {
    forCurrentUser: vi.fn(async () => {
      reads.calls.push('LotsService');
      throw new Error('LotsService read');
    }),
  },
}));
vi.mock('@/server/services/charters', () => ({
  ChartersService: {
    forCurrentUser: vi.fn(async () => {
      reads.calls.push('ChartersService');
      throw new Error('ChartersService read');
    }),
  },
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => {
    reads.calls.push('createClient');
    throw new Error('createClient');
  }),
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => {
    reads.calls.push('requireOrgContext');
    throw new Error('requireOrgContext');
  }),
}));

import BundleActivityPage from './bundle-activity/page';
import BundleShortagesPage from './bundle-shortages/page';
import DeadStockPage from './dead-stock/page';
import InventoryValuationPage from './inventory-valuation/page';
import ItemCostHistoryPage from './item-cost-history/page';
import LotExpiryReportPage from './lot-expiry/page';
import LotTraceReportPage from './lot-trace/page';
import ReorderForecastPage from './reorder-forecast/page';
import ShrinkagePage from './shrinkage/page';
import StockMovementsReportPage from './stock-movements/page';
import SupplierScorecardPage from './supplier-scorecard/page';
import VelocityClassPage from './velocity-class/page';

type PageFn = (props: { searchParams: Promise<Record<string, string>> }) => unknown;
const PAGES: Array<[string, PageFn, readonly ModuleId[]]> = [
  ['inventory-valuation', InventoryValuationPage as PageFn, []],
  ['stock-movements', StockMovementsReportPage as PageFn, []],
  ['reorder-forecast', ReorderForecastPage as PageFn, []],
  ['shrinkage', ShrinkagePage as PageFn, []],
  ['supplier-scorecard', SupplierScorecardPage as PageFn, ['purchase_orders']],
  ['velocity-class', VelocityClassPage as PageFn, []],
  ['dead-stock', DeadStockPage as PageFn, []],
  ['bundle-activity', BundleActivityPage as PageFn, ['bundles']],
  ['bundle-shortages', BundleShortagesPage as PageFn, ['bundles']],
  ['item-cost-history', ItemCostHistoryPage as PageFn, ['purchase_orders']],
  ['lot-expiry', LotExpiryReportPage as PageFn, ['lot_serial']],
  ['lot-trace', LotTraceReportPage as PageFn, ['lot_serial']],
];

function ctx(over: Record<string, unknown> = {}) {
  return {
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'manager',
    mfaRequired: false,
    mfaSatisfied: true,
    mfaEnrolled: false,
    enabledModules: new Set<ModuleId>([...DEFAULT_MODULE_IDS, 'lot_serial']),
    supabase: {},
    ...over,
  };
}
const props = { searchParams: Promise.resolve({ days: '30' }) };

beforeEach(() => {
  vi.clearAllMocks();
  reads.calls = [];
  ctxBox.ctx = ctx();
  gateBox.access = { enabled: false, canManage: false };
});

describe('report pages: reports:read is checked by the page itself', () => {
  it.each(PAGES)('%s: a member without reports:read is sent to the dashboard before any read', async (_s, Page) => {
    ctxBox.ctx = ctx({ role: 'viewer', permissions: new Set(['items:read']) });
    await expect(Promise.resolve().then(() => Page(props))).rejects.toThrow('redirect:/dashboard');
    expect(reads.calls).toEqual([]);
  });

  it.each(PAGES)('%s: staff (reports:read by default) is let through to the report', async (_s, Page) => {
    ctxBox.ctx = ctx({ role: 'staff' });
    // The page goes on to its data (the mocked services throw when read), or
    // returns its shell; either way it is not sent away.
    const outcome = await Promise.resolve()
      .then(() => Page(props))
      .catch((e: unknown) => e);
    expect(outcome instanceof Error ? outcome.message : 'rendered').not.toMatch(/^redirect:/);
  });
});

describe('report pages: the modules each report reads', () => {
  it.each(PAGES.filter(([, , m]) => m.length > 0))(
    '%s: its module off shows the module-not-enabled card, nothing read',
    async (_s, Page, modules) => {
      ctxBox.ctx = ctx({
        enabledModules: new Set<ModuleId>(
          [...DEFAULT_MODULE_IDS, 'lot_serial' as ModuleId].filter((m) => m !== modules[0]),
        ),
      });
      const el = (await Page(props)) as React.ReactElement;
      render(el);
      expect(screen.getByText(/isn.t enabled/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
      expect(reads.calls).toEqual([]);
    },
  );

  // A module set that could not be read is not "off": the report says it
  // could not check, with Try again, and is still closed. It used to show
  // the module-off card, which sent an admin to switch on a module that was
  // on.
  it.each(PAGES.filter(([, , m]) => m.length > 0))(
    '%s: its module state unread says it could not check, with Try again, nothing read',
    async (_s, Page, modules) => {
      ctxBox.ctx = ctx({
        role: 'admin',
        enabledModules: new Set<ModuleId>(
          [...DEFAULT_MODULE_IDS, 'lot_serial' as ModuleId].filter((m) => m !== modules[0]),
        ),
      });
      gateBox.access = { enabled: false, canManage: true, checkFailed: true };
      render((await Page(props)) as React.ReactElement);
      expect(
        screen.getByRole('heading', { level: 1, name: /^We couldn.t check whether .+ is on$/ }),
      ).toBeInTheDocument();
      expect(screen.queryByText(/isn.t enabled/)).toBeNull();
      expect(screen.queryByRole('link', { name: /Enable in Settings/ })).toBeNull();
      screen.getByRole('button', { name: 'Try again' }).click();
      expect(routerRefresh).toHaveBeenCalledTimes(1);
      expect(reads.calls).toEqual([]);
    },
  );
});

describe('report pages: the MFA step-up is a state, not an error page', () => {
  it.each(PAGES)('%s: an admin who must enroll sees how, nothing read', async (_s, Page) => {
    ctxBox.ctx = ctx({ role: 'admin', mfaRequired: true, mfaSatisfied: false, mfaEnrolled: false });
    const el = (await Page(props)) as React.ReactElement;
    render(el);
    expect(screen.getByRole('alert')).toHaveTextContent('Set up two-step verification to open this report.');
    expect(screen.getByRole('link', { name: 'Set up two-step verification' })).toHaveAttribute(
      'href',
      '/dashboard/settings/security?enroll=1',
    );
    expect(reads.calls).toEqual([]);
  });

  it('an enrolled AAL1 session is sent to verify, back to the report', async () => {
    ctxBox.ctx = ctx({ role: 'owner', mfaRequired: true, mfaSatisfied: false, mfaEnrolled: true });
    render((await ShrinkagePage(props)) as React.ReactElement);
    expect(screen.getByRole('link', { name: 'Verify now' })).toHaveAttribute(
      'href',
      '/signin/mfa?redirect=%2Fdashboard%2Freports%2Fshrinkage',
    );
  });
});
