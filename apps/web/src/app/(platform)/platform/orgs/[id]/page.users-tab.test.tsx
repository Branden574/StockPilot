import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Users tab is the only surface that can disable or re-enable an account,
 * so "the operator can reach every member" is a product requirement, not a
 * list-rendering nicety — and "the operator can SEE that some are missing" is
 * the other half of it. This tab was the one detail tab that rendered no cap
 * note at all, so a 100-row slice of a 150-member org looked like the whole
 * org and 50 accounts were quietly unreachable.
 *
 * These pin the surface: an exact total, the visible range for this page, and
 * page links that actually fetch the rest.
 */

const h = vi.hoisted(() => ({
  getOrgMembers: vi.fn(),
  recordPlatformAudit: vi.fn(async () => true),
}));

vi.mock('@/lib/auth/platform-admin', () => ({
  requirePlatformAdmin: vi.fn(async () => {}),
  isPlatformAdmin: () => false,
}));
vi.mock('@/lib/auth/session', () => ({
  requireSession: vi.fn(async () => ({ userId: 'god', email: 'god@stockpilotusa.com' })),
}));
vi.mock('@/server/services/platform/audit', () => ({
  recordPlatformAudit: (...a: unknown[]) => h.recordPlatformAudit(...(a as [])),
}));
vi.mock('@/server/services/platform/orgs', () => ({
  DETAIL_PREVIEW_LIMIT: 100,
  MEMBERS_PAGE_SIZE: 50,
  getOrgMembers: (...a: unknown[]) => h.getOrgMembers(...a),
  getOrgOverview: vi.fn(async () => ({
    id: ORG,
    name: 'Acme',
    slug: 'acme',
    industry: null,
    size: null,
    timezone: null,
    currency: null,
    createdAt: '2026-01-01T00:00:00Z',
    ownerEmail: 'owner@acme.test',
    effective: { tier: 'pro', source: 'manual', trialDaysRemaining: null },
    billingArrangement: 'standard',
    counts: { members: 150, items: 0, orders: 0, warehouses: 0 },
  })),
  getOrgInventory: vi.fn(async () => []),
  getOrgOrders: vi.fn(async () => []),
  getOrgBillingState: vi.fn(async () => null),
}));
vi.mock('@/components/platform/act-as-button', () => ({ ActAsButton: () => null }));
vi.mock('@/components/platform/billing-panel', () => ({ BillingPanel: () => null }));
vi.mock('@/components/platform/remove-org-dialog', () => ({ RemoveOrgDialog: () => null }));
vi.mock('@/components/platform/user-actions-menu', () => ({
  UserActionsMenu: ({ userId }: { userId: string }) => <button>actions {userId}</button>,
}));

import PlatformOrgDetailPage from './page';

const ORG = '11111111-1111-1111-1111-111111111111';

function member(n: number, activity: Record<string, unknown> = {}) {
  return {
    userId: `u-${n}`,
    email: `user${n}@acme.test`,
    fullName: `User ${n}`,
    role: 'staff',
    joinedAt: '2026-01-01T00:00:00Z',
    disabledAt: null,
    lastSignInAt: null,
    lastSessionAt: null,
    lastActionAt: null,
    lastSeenAt: null,
    ...activity,
  };
}

function armMembers(
  over: Partial<{
    members: unknown[];
    total: number;
    page: number;
    pageCount: number;
    search: string | null;
    activityAvailable: boolean;
  }>,
) {
  h.getOrgMembers.mockResolvedValue({
    members: over.members ?? [member(1), member(2)],
    total: over.total ?? 150,
    page: over.page ?? 1,
    pageSize: 50,
    pageCount: over.pageCount ?? 3,
    search: over.search ?? null,
    activityAvailable: over.activityAvailable ?? true,
  });
}

async function renderUsersTab(query: Record<string, string | string[]> = {}) {
  const tree = await PlatformOrgDetailPage({
    params: Promise.resolve({ id: ORG }),
    searchParams: Promise.resolve({ tab: 'users', ...query }),
  });
  return render(tree);
}

beforeEach(() => {
  vi.clearAllMocks();
  armMembers({});
});

describe('platform org detail — Users tab reachability', () => {
  it('shows the exact total and which slice of it is on screen', async () => {
    armMembers({ members: [member(1), member(2)], total: 150, page: 1 });
    await renderUsersTab();

    // The number that matters is the one the table is NOT showing.
    expect(screen.getByText(/of 150/i)).toBeInTheDocument();
  });

  it('links to the next page, so members past the first page are reachable', async () => {
    armMembers({ total: 150, page: 1, pageCount: 3 });
    await renderUsersTab();

    const next = screen.getByRole('link', { name: /next/i });
    expect(next.getAttribute('href')).toContain('tab=users');
    expect(next.getAttribute('href')).toContain('page=2');
  });

  it('passes the requested page down to the service', async () => {
    armMembers({ total: 150, page: 2, pageCount: 3 });
    await renderUsersTab({ page: '2' });

    expect(h.getOrgMembers).toHaveBeenCalledWith(ORG, expect.objectContaining({ page: 2 }));
    const prev = screen.getByRole('link', { name: /previous/i });
    expect(prev.getAttribute('href')).toContain('tab=users');
  });

  it('offers a search that targets this tab and reaches any single member', async () => {
    await renderUsersTab();
    const box = screen.getByPlaceholderText(/search by name or email/i);
    expect(box).toHaveAttribute('name', 'q');
    // The GET form must keep the operator on the Users tab.
    const form = box.closest('form')!;
    expect(form.querySelector('input[name="tab"]')).toHaveAttribute('value', 'users');
  });

  it('carries the search term through the pager', async () => {
    armMembers({ total: 60, page: 1, pageCount: 2, search: 'ada' });
    await renderUsersTab({ q: 'ada' });

    expect(h.getOrgMembers).toHaveBeenCalledWith(ORG, expect.objectContaining({ search: 'ada' }));
    expect(screen.getByRole('link', { name: /next/i }).getAttribute('href')).toContain('q=ada');
  });

  it('says so when a search matches nobody, instead of looking like an empty org', async () => {
    armMembers({ members: [], total: 0, page: 1, pageCount: 1, search: 'zzz' });
    await renderUsersTab({ q: 'zzz' });

    expect(screen.getByText(/no members match/i)).toBeInTheDocument();
  });

  it('still offers a way back when the requested page comes back empty (dead-end URL guard)', async () => {
    // getOrgMembers clamps a genuinely out-of-range page server-side, but
    // PostgREST returns 200/empty (not an error) at exactly offset ===
    // total — a legitimate empty LAST page. The tab used to render only
    // "No members." in that branch, with the pager (including Previous)
    // nested inside the non-empty branch — a dead end with no link back to
    // page 1.
    armMembers({ members: [], total: 120, page: 3, pageCount: 3, search: null });
    await renderUsersTab({ page: '3' });

    expect(screen.getByText(/no members\./i)).toBeInTheDocument();
    const prev = screen.getByRole('link', { name: /previous/i });
    expect(prev.getAttribute('href')).toContain('tab=users');
  });

  it('does not throw on a repeated ?q=, which Next.js hands back as a string[]', async () => {
    armMembers({ total: 60, page: 1, pageCount: 2, search: 'ada' });

    await expect(renderUsersTab({ q: ['ada', 'again'] })).resolves.toBeTruthy();

    // Only the first value reaches the service — same "take the first
    // element" contract as the other firstParam call sites in the app.
    expect(h.getOrgMembers).toHaveBeenCalledWith(ORG, expect.objectContaining({ search: 'ada' }));
  });
});

/**
 * LAST ACTIVE. An operator may read this column when deciding that an account
 * is dormant, on the one screen that can disable it. So what is pinned is not
 * "a date renders" but the three ways the column could mislead: presenting a
 * failed lookup as "Never", presenting a stale sign-in as a measurement, and
 * taking the whole tab down over a cosmetic value.
 */
describe('platform org detail — Users tab last active', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-18T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const rowOf = (email: string) => within(screen.getByText(email).closest('tr')!);
  const HEDGE = 'may have kept using the product after it';

  it('adds the column between Joined and Actions', async () => {
    await renderUsersTab();
    expect(screen.getAllByRole('columnheader').map((n) => n.textContent)).toEqual([
      'User',
      'Role',
      'Joined',
      'Last active',
      'Actions',
    ]);
  });

  it('a MEASURED value is a plain coarse age, with every exact instant behind it in the title', async () => {
    armMembers({
      members: [
        member(1, {
          lastSignInAt: '2026-07-22T08:00:00+00:00',
          lastSessionAt: '2026-09-18T09:00:00+00:00',
          lastActionAt: '2026-09-17T23:30:00+00:00',
        }),
      ],
    });
    await renderUsersTab();

    const row = rowOf('user1@acme.test');
    const cell = row.getByText('3 hours ago');
    expect(cell.getAttribute('title')).toBe(
      'Sign-in last renewed 18 Sep 2026, 09:00 UTC (any device, any organization; accurate to about an hour). ' +
        'Last recorded action in this organization 17 Sep 2026, 23:30 UTC. ' +
        'Last signed in 22 Jul 2026, 08:00 UTC.',
    );
    expect(row.queryByText(/signed in|last action/i)).toBeNull();
  });

  it('a bare sign-in is marked as evidence, not stated as activity', async () => {
    armMembers({ members: [member(1, { lastSignInAt: '2026-08-12T15:00:00+00:00' })] });
    await renderUsersTab();

    const cell = rowOf('user1@acme.test').getByText('Signed in 12 Aug 2026');
    expect(cell.getAttribute('title')).toContain('No open sign-ins on any device');
    expect(cell.getAttribute('title')).toContain(HEDGE);
  });

  it('an ACTION with no open sign-in behind it is marked the same way', async () => {
    // Signed in on 22 Jul, read daily, then signed out or was disabled: the
    // newest evidence is an eight-week-old audit row. Stated plainly it would
    // read as eight weeks of absence.
    armMembers({
      members: [
        member(1, {
          lastSignInAt: '2026-07-22T08:00:00+00:00',
          lastActionAt: '2026-07-22T15:00:00+00:00',
        }),
      ],
    });
    await renderUsersTab();

    const cell = rowOf('user1@acme.test').getByText('Last action 22 Jul 2026');
    expect(cell.getAttribute('title')).toContain(HEDGE);
    expect(rowOf('user1@acme.test').queryByText('22 Jul 2026')).toBeNull();
  });

  it('reads naturally when the evidence is recent', async () => {
    armMembers({
      members: [
        member(1, { lastSignInAt: '2026-09-18T11:30:00+00:00' }),
        member(2, {
          lastSignInAt: '2026-09-15T00:00:00+00:00',
          lastActionAt: '2026-09-15T12:00:00+00:00',
        }),
      ],
    });
    await renderUsersTab();

    expect(
      rowOf('user1@acme.test').getByText('Signed in within the last hour'),
    ).toBeInTheDocument();
    expect(rowOf('user2@acme.test').getByText('Last action 3 days ago')).toBeInTheDocument();
  });

  it('someone who only read and then signed out is shown plainly, from the app’s own report', async () => {
    // The blind spot 0352 closes. No session, no audit row, a two-month-old
    // sign-in: before, this rendered as a hedged "Signed in 22 Jul 2026".
    armMembers({
      members: [
        member(1, {
          lastSignInAt: '2026-07-22T08:00:00+00:00',
          lastSeenAt: '2026-09-17T12:00:00+00:00',
        }),
      ],
    });
    await renderUsersTab();

    const row = rowOf('user1@acme.test');
    const cell = row.getByText('1 day ago');
    expect(cell.getAttribute('title')).toContain(
      'Last had StockPilot open in this organization 17 Sep 2026, 12:00 UTC.',
    );
    expect(cell.getAttribute('title')).not.toContain(HEDGE);
    expect(row.queryByText(/signed in|last action/i)).toBeNull();
  });

  it('an action newer than the last hourly renewal is still measured: the sign-in is open', async () => {
    armMembers({
      members: [
        member(1, {
          lastSessionAt: '2026-09-18T09:00:00+00:00',
          lastActionAt: '2026-09-18T09:40:00+00:00',
        }),
      ],
    });
    await renderUsersTab();

    const cell = rowOf('user1@acme.test').getByText('2 hours ago');
    expect(cell.getAttribute('title')).not.toContain(HEDGE);
  });

  it('says Never only for the member with no activity', async () => {
    armMembers({
      members: [member(1), member(2, { lastSessionAt: '2026-09-18T11:30:00+00:00' })],
    });
    await renderUsersTab();

    expect(rowOf('user1@acme.test').getByText('Never').getAttribute('title')).toBe(
      'This person has never signed in and has no recorded activity in this organization.',
    );
    expect(rowOf('user2@acme.test').queryByText('Never')).toBeNull();
    expect(rowOf('user2@acme.test').getByText('Within the last hour')).toBeInTheDocument();
  });

  it('when the lookup failed it says so, never says Never, and every row keeps its actions', async () => {
    armMembers({ activityAvailable: false });
    await renderUsersTab();

    expect(screen.queryByText('Never')).toBeNull();
    expect(screen.getByText(/activity could not be loaded/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'actions u-1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'actions u-2' })).toBeInTheDocument();
    expect(screen.getByText(/of 150/i)).toBeInTheDocument();
  });

  it('a member with the keys absent, or unparseable values, cannot take the tab down', async () => {
    const bare = {
      userId: 'u-1',
      email: 'user1@acme.test',
      fullName: 'User 1',
      role: 'staff',
      joinedAt: '2026-01-01T00:00:00Z',
      disabledAt: null,
    };
    armMembers({
      members: [
        bare,
        member(2, { lastSessionAt: 'not-a-date', lastActionAt: 12345, lastSignInAt: '' }),
      ],
    });
    await renderUsersTab();

    expect(rowOf('user1@acme.test').getByText('Never')).toBeInTheDocument();
    expect(rowOf('user2@acme.test').getByText('Never')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'actions u-2' })).toBeInTheDocument();
  });

  it('explains on the page what the number is, and that it is per person, not per organization', async () => {
    await renderUsersTab();
    expect(screen.getByText(/accurate to\s+about an hour/i)).toBeInTheDocument();
    expect(screen.getByText(/every organization\s+they belong to/i)).toBeInTheDocument();
  });
});

/**
 * The view is audited because this tab is reachable by deep link without ever
 * passing the overview, and it now shows per-person activity across a tenant
 * boundary. The other tabs are pinned too: a condition loosened to "any tab"
 * would write a row for every inventory and billing render.
 */
describe('platform org detail — which views are audited', () => {
  async function renderTab(tab: string) {
    const tree = await PlatformOrgDetailPage({
      params: Promise.resolve({ id: ORG }),
      searchParams: Promise.resolve({ tab }),
    });
    return render(tree);
  }

  it('audits the Users tab, naming the tab', async () => {
    await renderTab('users');
    expect(h.recordPlatformAudit).toHaveBeenCalledTimes(1);
    expect(h.recordPlatformAudit).toHaveBeenCalledWith({
      actorUserId: 'god',
      actorEmail: 'god@stockpilotusa.com',
      action: 'viewed_org',
      targetOrganizationId: ORG,
      detail: { name: 'Acme', tab: 'users' },
    });
  });

  it('still audits the overview exactly as before', async () => {
    await renderTab('overview');
    expect(h.recordPlatformAudit).toHaveBeenCalledTimes(1);
    expect(h.recordPlatformAudit).toHaveBeenCalledWith({
      actorUserId: 'god',
      actorEmail: 'god@stockpilotusa.com',
      action: 'viewed_org',
      targetOrganizationId: ORG,
      detail: { name: 'Acme' },
    });
  });

  it.each(['inventory', 'orders', 'billing'])('does not audit the %s tab', async (tab) => {
    await renderTab(tab);
    expect(h.recordPlatformAudit).not.toHaveBeenCalled();
  });
});
