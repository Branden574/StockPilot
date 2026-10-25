import { render, screen, within } from '@testing-library/react';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * One organization seen from the console, redesigned (P5.3). The audit and
 * Users-tab rules live in page.users-tab.test.tsx; this file pins what the
 * restyle could break: the header (back link, name, slug · industry · owner,
 * billing summary, Act as), the five ?tab= links as a real tab strip with
 * prefetch OFF (rendering Overview or Users writes a viewed_org audit row, so
 * no tab may be fetched before it is opened), the danger zone on every tab,
 * the preview tables in keyboard-reachable scroll regions, their cap note and
 * empty words, and the Users table's Actions column, which must stay
 * reachable on a phone (it is the only way to disable an account).
 */

const h = vi.hoisted(() => ({
  overview: null as Record<string, unknown> | null,
  inventory: [] as unknown[],
  orders: [] as unknown[],
  members: [] as unknown[],
}));

vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({
      href,
      prefetch,
      children,
      ...rest
    }: {
      href: string;
      prefetch?: boolean | null;
      children?: ReactNode;
    } & AnchorHTMLAttributes<HTMLAnchorElement>) =>
      React.createElement('a', { href, 'data-prefetch': String(prefetch), ...rest }, children),
    useLinkStatus: () => ({ pending: false }),
  };
});
vi.mock('next/navigation', () => ({
  usePathname: () => null,
  useSearchParams: () => null,
}));
vi.mock('@/lib/auth/platform-admin', () => ({
  requirePlatformAdmin: vi.fn(async () => {}),
  isPlatformAdmin: () => false,
}));
vi.mock('@/lib/auth/session', () => ({
  requireSession: vi.fn(async () => ({ userId: 'god', email: 'god@stockpilotusa.com' })),
}));
vi.mock('@/server/services/platform/audit', () => ({
  recordPlatformAudit: vi.fn(async () => true),
}));
vi.mock('@/server/services/platform/orgs', () => ({
  DETAIL_PREVIEW_LIMIT: 2,
  getOrgOverview: vi.fn(async () => h.overview),
  getOrgInventory: vi.fn(async () => h.inventory),
  getOrgOrders: vi.fn(async () => h.orders),
  getOrgMembers: vi.fn(async () => ({
    members: h.members,
    total: h.members.length,
    page: 1,
    pageSize: 50,
    pageCount: 1,
    search: null,
    activityAvailable: true,
  })),
  getOrgBillingState: vi.fn(async () => null),
}));
vi.mock('@/components/platform/act-as-button', () => ({
  ActAsButton: ({ orgName }: { orgName: string }) => <button>Act as this org ({orgName})</button>,
}));
vi.mock('@/components/platform/billing-panel', () => ({ BillingPanel: () => null }));
vi.mock('@/components/platform/remove-org-dialog', () => ({
  RemoveOrgDialog: () => <button>Remove organization</button>,
}));
vi.mock('@/components/platform/user-actions-menu', () => ({
  UserActionsMenu: ({ userId }: { userId: string }) => <button>actions {userId}</button>,
}));

import PlatformOrgDetailPage from './page';

const ORG = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  h.overview = {
    id: ORG,
    name: 'Acme',
    slug: 'acme',
    industry: 'Education',
    size: '11-50',
    timezone: 'America/Los_Angeles',
    currency: 'USD',
    createdAt: '2026-01-01T00:00:00Z',
    ownerEmail: 'owner@acme.test',
    effective: { tier: 'business', source: 'trial', trialDaysRemaining: 6 },
    billingArrangement: 'trial',
    counts: { members: 4, items: 12, orders: 3, warehouses: 2 },
  };
  h.inventory = [];
  h.orders = [];
  h.members = [];
});

async function renderTab(tab?: string) {
  const tree = await PlatformOrgDetailPage({
    params: Promise.resolve({ id: ORG }),
    searchParams: Promise.resolve(tab ? { tab } : {}),
  });
  return render(tree);
}

describe('platform org detail — header, tabs and danger zone', () => {
  it('keeps the back link, the name and the slug · industry · owner line', async () => {
    await renderTab();
    expect(screen.getByRole('link', { name: '← Organizations' })).toHaveAttribute(
      'href',
      '/platform',
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Acme' })).toBeInTheDocument();
    expect(screen.getByText('acme', { selector: 'span' }).parentElement).toHaveTextContent(
      'acme · Education · owner owner@acme.test',
    );
  });

  it('keeps the billing summary and the Act as button', async () => {
    await renderTab();
    const summary = document.querySelector('[data-slot="org-billing-summary"]')!;
    expect(summary).toHaveTextContent('Billing');
    expect(summary).toHaveTextContent('Business · trial');
    expect(summary).toHaveTextContent('Trial — 6d left');
    expect(screen.getByRole('button', { name: 'Act as this org (Acme)' })).toBeInTheDocument();
  });

  it('puts Act as with the secondary actions, after the billing summary', async () => {
    await renderTab('billing');
    // Act as enters a mode; it is not the work in front of you, so it is not
    // the header's ink primary and the Billing tab's Save billing is the only
    // one (P5.3 review). Its own outline look is pinned in act-as-button.test.
    const actions = document.querySelector('[data-slot="page-header-actions"]')!;
    const summary = actions.querySelector('[data-slot="org-billing-summary"]')!;
    const actAs = within(actions as HTMLElement).getByRole('button', {
      name: 'Act as this org (Acme)',
    });
    expect(summary.compareDocumentPosition(actAs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(actions.lastElementChild).toBe(actAs);
  });

  it('draws the five ?tab= links as a tab strip, none of them prefetched', async () => {
    await renderTab('inventory');
    const strip = screen.getByRole('tablist', { name: 'Organization' });
    const tabs = within(strip).getAllByRole('tab');
    expect(tabs.map((t) => [t.textContent, t.getAttribute('href')])).toEqual([
      ['Overview', `/platform/orgs/${ORG}?tab=overview`],
      ['Inventory', `/platform/orgs/${ORG}?tab=inventory`],
      ['Users', `/platform/orgs/${ORG}?tab=users`],
      ['Orders', `/platform/orgs/${ORG}?tab=orders`],
      ['Billing', `/platform/orgs/${ORG}?tab=billing`],
    ]);
    for (const t of tabs) expect(t).toHaveAttribute('data-prefetch', 'false');
    expect(tabs.filter((t) => t.getAttribute('aria-selected') === 'true')).toHaveLength(1);
    expect(within(strip).getByRole('tab', { name: 'Inventory' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it.each(['overview', 'inventory', 'users', 'orders', 'billing'])(
    'keeps the danger zone on the %s tab',
    async (tab) => {
      await renderTab(tab);
      expect(screen.getByRole('heading', { name: 'Danger zone' })).toBeInTheDocument();
      expect(
        screen.getByText(/Permanently delete this organization and everything in it\./),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Remove organization' })).toBeInTheDocument();
    },
  );

  it('keeps the overview figures, facts and the audit trail link', async () => {
    await renderTab('overview');
    const strip = screen.getByLabelText('Organization totals');
    // A named group, since a name on a bare div is dropped (aria-prohibited-attr).
    expect(screen.getByRole('group', { name: 'Organization totals' })).toBe(strip);
    for (const [label, value] of [
      ['Members', '4'],
      ['Items', '12'],
      ['Orders', '3'],
      ['Warehouses', '2'],
    ] as const) {
      expect(within(strip).getByText(label).parentElement).toHaveTextContent(value);
    }
    for (const [term, value] of [
      ['Timezone', 'America/Los_Angeles'],
      ['Currency', 'USD'],
      ['Size', '11-50'],
      ['Plan source', 'trial'],
    ] as const) {
      expect(screen.getByText(term, { selector: 'dt' }).nextElementSibling).toHaveTextContent(
        value,
      );
    }
    expect(screen.getByText('Created', { selector: 'dt' })).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: "View this org's platform-admin audit trail →" }),
    ).toHaveAttribute('href', `/platform/audit?org=${ORG}`);
  });
});

describe('platform org detail — preview tables', () => {
  it('keeps the inventory empty words', async () => {
    await renderTab('inventory');
    expect(screen.getByText('No items in this organization.')).toBeInTheDocument();
  });

  it('shows the inventory preview in a scroll region with the cap note at the limit', async () => {
    h.inventory = [
      { name: 'Cones', sku: 'C-1', quantityOnHand: 5, unitCost: 1.5, status: 'active' },
      { name: 'Mouse', sku: null, quantityOnHand: 0, unitCost: null, status: null },
    ];
    await renderTab('inventory');
    const region = screen.getByRole('region', { name: 'Inventory' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(
      within(region)
        .getAllByRole('columnheader')
        .map((n) => n.textContent),
    ).toEqual(['Item', 'SKU', 'On hand', 'Unit cost', 'Status']);
    expect(within(region).getByText('Cones').closest('tr')).toHaveTextContent(
      'ConesC-15$1.50active',
    );
    expect(within(region).getByText('Mouse').closest('tr')).toHaveTextContent('Mouse—0——');
    expect(screen.getByText(/Showing the first 2 \(preview\)\./)).toHaveTextContent(
      'Showing the first 2 (preview). Use “Act as this org” to see everything.',
    );
  });

  it('keeps the orders preview columns, the short id and the empty words', async () => {
    const { unmount } = await renderTab('orders');
    expect(screen.getByText('No orders.')).toBeInTheDocument();
    unmount();

    h.orders = [
      {
        id: 'abcdef12-3456',
        status: 'pending',
        requester: 'Ada',
        createdAt: '2026-02-01T00:00:00Z',
      },
    ];
    await renderTab('orders');
    const region = screen.getByRole('region', { name: 'Orders' });
    expect(
      within(region)
        .getAllByRole('columnheader')
        .map((n) => n.textContent),
    ).toEqual(['Order', 'Status', 'Requester', 'Created']);
    expect(within(region).getByText('abcdef12')).toBeInTheDocument();
    expect(screen.queryByText(/Showing the first/)).toBeNull();
  });

  it('keeps the Users table in a scroll region with its Actions column pinned in view', async () => {
    h.members = [
      {
        userId: 'u-1',
        email: 'ada@acme.test',
        fullName: 'Ada',
        role: 'staff',
        joinedAt: '2026-01-01T00:00:00Z',
        disabledAt: '2026-02-01T00:00:00Z',
      },
    ];
    await renderTab('users');
    const region = screen.getByRole('region', { name: 'Members' });
    expect(region.className).not.toMatch(/overflow-hidden/);
    const actionsHead = within(region).getByRole('columnheader', { name: 'Actions' });
    const actionsCell = within(region).getByRole('button', { name: 'actions u-1' }).closest('td')!;
    for (const cell of [actionsHead, actionsCell]) {
      expect(cell.className).toMatch(/\bsticky\b/);
      expect(cell.className).toMatch(/\bright-0\b/);
    }
    const pill = within(region).getByText('Disabled');
    expect(pill.getAttribute('title')).toMatch(/^Disabled /);
  });
});

/**
 * B9: these tabs render on the server (UTC on Vercel), and each date below was
 * a bare toLocaleDateString() or toLocaleString(): the server's day, with no
 * zone named. An organization's dates are now its own zone's.
 */
describe("platform org detail — dates in the organization's zone", () => {
  // 6:30 PM Pacific on 24 Oct is 01:30 UTC on 25 Oct.
  const EVENING = '2026-10-25T01:30:00Z';
  const originalTz = process.env.TZ;
  beforeEach(() => {
    process.env.TZ = 'UTC';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-12-15T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('Overview: Created is the day it was created there', async () => {
    h.overview = { ...h.overview!, createdAt: EVENING };
    await renderTab('overview');
    expect(screen.getByText('Created', { selector: 'dt' }).nextElementSibling).toHaveTextContent(
      /^24 Oct 2026$/,
    );
  });

  it("Users: Joined and a month-old Last active are the organization's days, and Disabled names its zone", async () => {
    h.members = [
      {
        userId: 'u-1',
        email: 'ada@acme.test',
        fullName: 'Ada',
        role: 'staff',
        joinedAt: EVENING,
        disabledAt: EVENING,
        lastSignInAt: EVENING,
        lastSessionAt: null,
        lastActionAt: null,
        lastSeenAt: null,
      },
    ];
    await renderTab('users');
    const region = screen.getByRole('region', { name: 'Members' });
    const row = within(region).getByText('ada@acme.test').closest('tr')!;
    expect(row.querySelectorAll('td')[2]).toHaveTextContent(/^24 Oct 2026$/);
    expect(within(row).getByText('Signed in 24 Oct 2026')).toBeInTheDocument();
    expect(within(row).getByText('Disabled')).toHaveAttribute(
      'title',
      'Disabled 24 Oct 2026, 18:30 PDT',
    );
    expect(within(region).getByRole('columnheader', { name: 'Joined' })).toHaveAttribute(
      'title',
      "In this organization's time zone (America/Los_Angeles).",
    );
  });

  it('Orders: Created is the day the order was placed there', async () => {
    h.orders = [{ id: 'abcdef12-3456', status: 'pending', requester: 'Ada', createdAt: EVENING }];
    await renderTab('orders');
    const region = screen.getByRole('region', { name: 'Orders' });
    expect(within(region).getByText('abcdef12').closest('tr')!.lastElementChild).toHaveTextContent(
      /^24 Oct 2026$/,
    );
  });
});
