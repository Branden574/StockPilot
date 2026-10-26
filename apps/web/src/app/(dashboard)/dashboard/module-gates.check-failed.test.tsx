// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MODULE_REGISTRY, type ModuleId } from '@stockpilot/core';

/**
 * EVERY PAGE BEHIND A MODULE GATE tells "off" from "could not check".
 *
 * checkModuleAccess fails closed: when the organization's module set cannot
 * be read it denies, and says so (`checkFailed`). The redesign's four new
 * gates (New PO import, an import's review page, New rental, a rental's page)
 * showed the module-off panel for that, and R7 gave them "We couldn't check
 * whether this module is on" with Try again. Every gate from before the
 * redesign still showed the module-off panel on a failed read, telling an
 * admin to switch on a module that was on, and everyone else to ask for it,
 * until a reload. Each now draws its panel through ModuleUnavailable.
 *
 * This runs each page's own code with the gate's two "no" answers: off (the
 * module-off panel, its words and its Enable link) and could not check (the
 * page's only h1 says so, Try again asks the server again, no Enable link).
 * Either way the page returns before it reads anything: every service it
 * would read is out of reach here (the request's own context aside), so a
 * page that read on would throw instead of rendering the panel.
 */

const h = vi.hoisted(() => ({
  access: { enabled: false, canManage: true } as {
    enabled: boolean;
    canManage: boolean;
    checkFailed?: boolean;
  },
  asked: [] as string[],
  refresh: vi.fn(),
}));

vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: vi.fn(async (moduleId: string) => {
    h.asked.push(moduleId);
    return h.access;
  }),
}));
// The request's org context, for the pages that check a permission before
// their module (an owner holds every permission by default).
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'owner',
  })),
}));
vi.mock('@/server/services/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/context')>()),
  withContext: vi.fn(async () => ({ organizationId: 'org-1', userId: 'u-1', role: 'owner' })),
}));
// Nothing past the gate may be read: every client a page could build throws.
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => {
    throw new Error('read past the module gate');
  }),
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => {
    throw new Error('read past the module gate');
  }),
}));
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
  notFound: vi.fn(() => {
    throw new Error('notFound');
  }),
  useRouter: () => ({ refresh: h.refresh, push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/dashboard',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
  };
});

import AiPage from './ai/page';
import BooksPage from './books/page';
import BundlesPage from './bundles/page';
import CustomersPage from './customers/page';
import CycleCountsPage from './cycle-counts/page';
import InsightsPage from './insights/page';
import MaintenanceRequestPage from './maintenance/[id]/page';
import NewMaintenanceRequestPage from './maintenance/new/page';
import MaintenancePage from './maintenance/page';
import NewOrderPage from './orders/new/page';
import OrdersPage from './orders/page';
import PlanningPage from './planning/page';
import ProceduresPage from './procedures/page';
import ProductGroupLinkPage from './product-groups/link/page';
import ProductGroupsPage from './product-groups/page';
import PoImportPage from './purchase-orders/imports/[id]/page';
import NewPoImportPage from './purchase-orders/imports/new/page';
import PoImportsPage from './purchase-orders/imports/page';
import PurchaseOrdersPage from './purchase-orders/page';
import RecurringPosPage from './purchase-orders/recurring/page';
import RentalPage from './rentals/[id]/page';
import NewRentalPage from './rentals/new/page';
import RentalsPage from './rentals/page';
import BookOrderTotalsPage from './reports/book-order-totals/page';
import ReturnPage from './returns/[id]/page';
import ReturnsPage from './returns/page';
import SchedulePage from './schedule/page';
import IntegrationsPage from './settings/integrations/page';
import PublicLinkPage from './settings/public-requests/[linkId]/page';
import PublicRequestsPage from './settings/public-requests/page';
import SuppliersPage from './suppliers/page';
import ZendeskPage from './zendesk/page';

const ID = '11111111-1111-4111-8111-111111111111';
const id = { params: Promise.resolve({ id: ID }) };
const linkId = { params: Promise.resolve({ linkId: ID }) };

type Page = (props: never) => unknown;

/** [the page, its gated module, the props it is opened with] */
const PAGES: Array<[string, Page, ModuleId, () => Record<string, unknown>]> = [
  ['AI assistant', AiPage, 'ai', () => ({})],
  ['Books', BooksPage, 'books', () => ({ searchParams: Promise.resolve({}) })],
  ['Bundles', BundlesPage, 'bundles', () => ({ searchParams: Promise.resolve({}) })],
  ['Customers', CustomersPage, 'b2b_portal', () => ({})],
  ['Cycle counts', CycleCountsPage, 'cycle_counts', () => ({ searchParams: Promise.resolve({}) })],
  ['Insights', InsightsPage, 'ai', () => ({})],
  [
    'A maintenance request',
    MaintenanceRequestPage,
    'maintenance_requests',
    () => ({ ...id, searchParams: Promise.resolve({}) }),
  ],
  [
    'New maintenance request',
    NewMaintenanceRequestPage,
    'maintenance_requests',
    () => ({ searchParams: Promise.resolve({}) }),
  ],
  [
    'Maintenance requests',
    MaintenancePage,
    'maintenance_requests',
    () => ({ searchParams: Promise.resolve({}) }),
  ],
  ['New order', NewOrderPage, 'orders', () => ({ searchParams: Promise.resolve({}) })],
  ['Orders', OrdersPage, 'orders', () => ({ searchParams: Promise.resolve({}) })],
  ['Planning', PlanningPage, 'planning', () => ({})],
  ['Procedures', ProceduresPage, 'procedures', () => ({ searchParams: Promise.resolve({}) })],
  ['Link products into groups', ProductGroupLinkPage, 'sports', () => ({})],
  ['Product groups', ProductGroupsPage, 'sports', () => ({ searchParams: Promise.resolve({}) })],
  ['A PO import', PoImportPage, 'po_imports', () => id],
  ['New PO import', NewPoImportPage, 'po_imports', () => ({})],
  ['PO imports', PoImportsPage, 'po_imports', () => ({ searchParams: Promise.resolve({}) })],
  [
    'Purchase orders',
    PurchaseOrdersPage,
    'purchase_orders',
    () => ({ searchParams: Promise.resolve({}) }),
  ],
  [
    'Recurring purchase orders',
    RecurringPosPage,
    'purchase_orders',
    () => ({ searchParams: Promise.resolve({}) }),
  ],
  ['A rental', RentalPage, 'rentals', () => id],
  ['New rental', NewRentalPage, 'rentals', () => ({ searchParams: Promise.resolve({}) })],
  ['Rentals', RentalsPage, 'rentals', () => ({ searchParams: Promise.resolve({}) })],
  [
    'Book order totals',
    BookOrderTotalsPage,
    'orders',
    () => ({ searchParams: Promise.resolve({}) }),
  ],
  ['A return', ReturnPage, 'returns', () => id],
  ['Returns', ReturnsPage, 'returns', () => ({ searchParams: Promise.resolve({}) })],
  ['Schedule', SchedulePage, 'schedule', () => ({ searchParams: Promise.resolve({}) })],
  ['Integrations', IntegrationsPage, 'integrations', () => ({})],
  ['A public request link', PublicLinkPage, 'public_requests', () => linkId],
  ['Public requests', PublicRequestsPage, 'public_requests', () => ({})],
  ['Suppliers', SuppliersPage, 'suppliers', () => ({ searchParams: Promise.resolve({}) })],
  ['Zendesk', ZendeskPage, 'zendesk', () => ({})],
];

async function open(page: Page, props: Record<string, unknown>) {
  render((await page(props as never)) as React.ReactElement);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.asked = [];
});

describe('a gated page whose module set could not be read', () => {
  it.each(PAGES)(
    '%s says it could not check, offers Try again, and reads nothing',
    async (_name, page, moduleId, props) => {
      h.access = { enabled: false, canManage: true, checkFailed: true };
      await open(page, props());
      const title = MODULE_REGISTRY[moduleId].title;

      expect(h.asked).toContain(moduleId);
      expect(
        screen.getByRole('heading', {
          level: 1,
          name: `We couldn't check whether ${title} is on`,
        }),
      ).toBeInTheDocument();
      expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
      // Not "off": no module-off words, and no Enable link for a module
      // that may well be on.
      expect(screen.queryByText(/isn.t enabled/)).toBeNull();
      expect(screen.queryByRole('link', { name: /Enable in Settings/ })).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(h.refresh).toHaveBeenCalledTimes(1);
    },
  );
});

describe('a gated page whose module is off', () => {
  it.each(PAGES)(
    '%s shows the module-off panel, as before, and reads nothing',
    async (_name, page, moduleId, props) => {
      h.access = { enabled: false, canManage: true };
      await open(page, props());
      const title = MODULE_REGISTRY[moduleId].title;

      expect(
        screen.getByRole('heading', { level: 1, name: `${title} isn't enabled` }),
      ).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Enable in Settings → Modules' })).toHaveAttribute(
        'href',
        '/dashboard/settings/modules',
      );
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    },
  );
});

/**
 * No page draws the module-off panel itself any more: ModuleUnavailable is
 * the one way to it, so a new gate cannot forget the "could not check" state.
 * (Tests may still mock the panel; they are not pages.)
 */
describe('the module-off panel is drawn only through ModuleUnavailable', () => {
  it('no other source file imports ModuleNotEnabled', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const SRC = path.resolve(__dirname, '../../..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules') walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
        const rel = path.relative(SRC, full);
        if (rel === path.join('components', 'dashboard', 'module-unavailable.tsx')) continue;
        const text = fs.readFileSync(full, 'utf8');
        if (
          /from '@\/components\/dashboard\/module-not-enabled'|from '\.\/module-not-enabled'/.test(
            text,
          )
        )
          offenders.push(rel);
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
    // And the page list above is every page that gates on a module.
    const gated: string[] = [];
    const walkPages = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walkPages(full);
        else if (
          entry.name === 'page.tsx' &&
          /<ModuleUnavailable\b/.test(fs.readFileSync(full, 'utf8'))
        )
          gated.push(full);
      }
    };
    walkPages(path.resolve(__dirname));
    expect(gated).toHaveLength(PAGES.length);
  });
});
