import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const h = vi.hoisted(() => ({ getOrgMembers: vi.fn() }));

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

function member(n: number) {
  return {
    userId: `u-${n}`,
    email: `user${n}@acme.test`,
    fullName: `User ${n}`,
    role: 'staff',
    joinedAt: '2026-01-01T00:00:00Z',
    disabledAt: null,
  };
}

function armMembers(over: Partial<{ members: unknown[]; total: number; page: number; pageCount: number; search: string | null }>) {
  h.getOrgMembers.mockResolvedValue({
    members: over.members ?? [member(1), member(2)],
    total: over.total ?? 150,
    page: over.page ?? 1,
    pageSize: 50,
    pageCount: over.pageCount ?? 3,
    search: over.search ?? null,
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
