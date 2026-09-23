import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The cycle-count HISTORY page: 25 sessions per page from the server, the
// count reference as the primary link, a footer that states exactly which
// rows are on screen, Previous/Next that are disabled at the ends, a URL
// that always names the page actually shown, and two different empty states.

const ctxHolder = vi.hoisted(() => ({
  current: {
    role: 'manager' as 'owner' | 'admin' | 'manager' | 'staff' | 'viewer',
    permissions: undefined as Set<string> | undefined,
  },
}));

vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u-1',
    role: ctxHolder.current.role,
    permissions: ctxHolder.current.permissions,
  })),
}));

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
  usePathname: () => '/dashboard/cycle-counts',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));

vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: vi.fn(async () => ({ enabled: true, canManage: false })),
}));

vi.mock('@/lib/dashboard/request-cache', () => ({
  getOrgRowForRequest: vi.fn(async () => ({ timezone: 'America/Los_Angeles' })),
}));

const listPage = vi.fn();
vi.mock('@/server/services/cycle-counts', () => ({
  CycleCountsService: { forCurrentUser: vi.fn(async () => ({ listPage })) },
}));

import CycleCountsPage from './page';

function item(n: number, extra: Record<string, unknown> = {}) {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    countNumber: n,
    warehouseId: 'wh-a',
    warehouseName: 'North DC',
    scope: 'warehouse',
    status: 'completed',
    notes: null,
    startedBy: 'u-mgr',
    startedByName: 'Morgan Manager',
    startedAt: '2026-09-23T03:00:00Z',
    completedAt: '2026-09-23T05:00:00Z',
    canceledAt: null,
    assignedTo: null,
    assigneeName: null,
    lineTotal: 20,
    lineCounted: 20,
    ...extra,
  };
}

function pageOf(total: number, page: number, items?: ReturnType<typeof item>[]) {
  const totalPages = Math.max(1, Math.ceil(total / 25));
  const count = Math.max(0, Math.min(25, total - (page - 1) * 25));
  const rows = items ?? Array.from({ length: count }, (_, i) => item(total - (page - 1) * 25 - i));
  return {
    items: rows,
    page,
    pageSize: 25,
    total,
    totalPages,
    hasPrevious: page > 1,
    hasNext: page < totalPages,
  };
}

async function renderPage(sp: Record<string, string> = {}) {
  render(await CycleCountsPage({ searchParams: Promise.resolve(sp) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  ctxHolder.current = { role: 'manager', permissions: undefined };
});

describe('cycle counts history page', () => {
  it('asks the server for the URL state and shows page 2 of 137 honestly', async () => {
    listPage.mockResolvedValue(pageOf(137, 2));
    await renderPage({ q: 'north', status: 'completed', page: '2' });

    expect(listPage).toHaveBeenCalledWith({ q: 'north', status: 'completed', page: 2 });
    expect(screen.getByText('Showing 26–50 of 137 cycle counts · Page 2 of 6')).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(26); // header + 25 sessions

    const prev = screen.getByRole('link', { name: 'Previous' });
    const next = screen.getByRole('link', { name: 'Next' });
    expect(prev).toHaveAttribute('href', '/dashboard/cycle-counts?q=north&status=completed');
    expect(next).toHaveAttribute('href', '/dashboard/cycle-counts?q=north&status=completed&page=3');
  });

  it('makes the reference the primary link, by uuid, with the exact start time', async () => {
    listPage.mockResolvedValue(pageOf(1, 1, [item(42)]));
    await renderPage();

    const link = screen.getByRole('link', { name: 'CC-000042' });
    expect(link).toHaveAttribute('href', '/dashboard/cycle-counts/00000000-0000-4000-8000-000000000042');
    expect(screen.getByRole('columnheader', { name: 'Count #' })).toBeInTheDocument();
    // 03:00 UTC on Sep 23 is 8:00 PM on Sep 22 in the workspace (Los Angeles).
    expect(screen.getByText(/Sep 22, 2026, 8:00\s?PM/)).toBeInTheDocument();
  });

  it('never shows a made-up reference for a count without a number', async () => {
    listPage.mockResolvedValue(pageOf(1, 1, [item(7, { countNumber: null })]));
    await renderPage();
    expect(screen.getByText('Reference unavailable')).toBeInTheDocument();
    expect(screen.queryByText(/CC-0/)).not.toBeInTheDocument();
  });

  it('labels a mixed selection honestly and an org-wide count as all warehouses', async () => {
    listPage.mockResolvedValue(
      pageOf(2, 1, [
        item(2, { warehouseId: null, warehouseName: null, scope: 'selection' }),
        item(1, { warehouseId: null, warehouseName: null, scope: 'warehouse' }),
      ]),
    );
    await renderPage();
    expect(screen.getByText('Selected items')).toBeInTheDocument();
    expect(screen.getByText('All warehouses')).toBeInTheDocument();
  });

  it('shows progress for an open count from the server aggregate', async () => {
    listPage.mockResolvedValue(
      pageOf(1, 1, [item(3, { status: 'in_progress', lineTotal: 443, lineCounted: 301, completedAt: null })]),
    );
    await renderPage();
    expect(screen.getByText('301 / 443 counted')).toBeInTheDocument();
  });

  it.each([
    [1, 1, false, false],
    [24, 1, false, false],
    [25, 1, false, false],
    [26, 1, false, true],
    [26, 2, true, false],
    [50, 2, true, false],
    [51, 2, true, true],
    [51, 3, true, false],
    [137, 6, true, false],
  ])('total %i on page %i: Previous enabled %s, Next enabled %s', async (total, page, prevOn, nextOn) => {
    listPage.mockResolvedValue(pageOf(total, page));
    await renderPage(page > 1 ? { page: String(page) } : {});
    const nav = screen.getByRole('navigation', { name: 'Cycle count pages' });
    if (prevOn) expect(within(nav).getByRole('link', { name: 'Previous' })).toBeInTheDocument();
    else expect(within(nav).getByRole('button', { name: 'Previous' })).toBeDisabled();
    if (nextOn) expect(within(nav).getByRole('link', { name: 'Next' })).toBeInTheDocument();
    else expect(within(nav).getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('keeps the 26th count on page 2', async () => {
    listPage.mockResolvedValue(pageOf(26, 2));
    await renderPage({ page: '2' });
    expect(screen.getByText('Showing 26–26 of 26 cycle counts · Page 2 of 2')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'CC-000001' })).toBeInTheDocument();
  });
});

describe('cycle counts history page: the URL names the page shown', () => {
  it('replaces a page past the end with the last real page', async () => {
    listPage.mockResolvedValue(pageOf(137, 6));
    await expect(CycleCountsPage({ searchParams: Promise.resolve({ page: '99', q: 'CC-42' }) })).rejects.toThrow(
      'redirect:/dashboard/cycle-counts?q=CC-42&page=6',
    );
  });

  it('replaces an unreadable page with page 1', async () => {
    listPage.mockResolvedValue(pageOf(137, 1));
    await expect(CycleCountsPage({ searchParams: Promise.resolve({ page: 'abc' }) })).rejects.toThrow(
      'redirect:/dashboard/cycle-counts',
    );
    expect(listPage).toHaveBeenCalledWith({ q: '', status: null, page: 1 });
  });

  it('spells page 1 without a page parameter', async () => {
    listPage.mockResolvedValue(pageOf(137, 1));
    await expect(CycleCountsPage({ searchParams: Promise.resolve({ page: '1' }) })).rejects.toThrow(
      'redirect:/dashboard/cycle-counts',
    );
  });

  it('does not redirect when the URL already matches', async () => {
    listPage.mockResolvedValue(pageOf(137, 3));
    await renderPage({ page: '3' });
    expect(screen.getByText('Showing 51–75 of 137 cycle counts · Page 3 of 6')).toBeInTheDocument();
  });
});

describe('cycle counts history page: empty states and controls', () => {
  it('an empty history says so and offers the first count', async () => {
    listPage.mockResolvedValue(pageOf(0, 1, []));
    await renderPage();
    expect(screen.getByText('No cycle counts yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Start your first count' })).toBeInTheDocument();
    expect(screen.getByText('Showing 0 cycle counts')).toBeInTheDocument();
    expect(screen.queryByText(/1–0/)).not.toBeInTheDocument();
  });

  it('an empty SEARCH says nothing matched and keeps the search box', async () => {
    listPage.mockResolvedValue(pageOf(0, 1, []));
    await renderPage({ q: 'CC-999999' });
    expect(screen.getByText('No counts match your search.')).toBeInTheDocument();
    expect(screen.queryByText('No cycle counts yet')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Search cycle counts')).toHaveValue('CC-999999');
    expect(screen.getByRole('link', { name: 'Clear search and filters' })).toHaveAttribute(
      'href',
      '/dashboard/cycle-counts',
    );
  });

  it('labels the search field and advertises only the fields it searches', async () => {
    listPage.mockResolvedValue(pageOf(1, 1, [item(1)]));
    await renderPage();
    const input = screen.getByLabelText('Search cycle counts');
    expect(input).toHaveAttribute('placeholder', 'Search count #, warehouse, or notes…');
  });

  it('status filters keep the search and drop the page', async () => {
    listPage.mockResolvedValue(pageOf(137, 2));
    await renderPage({ q: 'north', page: '2' });
    const nav = screen.getByRole('navigation', { name: 'Filter by status' });
    expect(within(nav).getByRole('link', { name: 'Canceled' })).toHaveAttribute(
      'href',
      '/dashboard/cycle-counts?q=north&status=canceled',
    );
    expect(within(nav).getByRole('link', { name: 'All statuses' })).toHaveAttribute('aria-current', 'page');
  });

  it('a read-only viewer gets no start affordances', async () => {
    ctxHolder.current = { role: 'viewer', permissions: new Set(['cycle_counts:read']) };
    listPage.mockResolvedValue(pageOf(0, 1, []));
    await renderPage();
    expect(screen.queryByText('+ Start a count')).not.toBeInTheDocument();
    expect(screen.queryByText('Start your first count')).not.toBeInTheDocument();
  });

  it('a member without the read permission is sent away before any read', async () => {
    ctxHolder.current = { role: 'viewer', permissions: new Set(['items:read']) };
    await expect(CycleCountsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow('redirect:/dashboard');
    expect(listPage).not.toHaveBeenCalled();
  });
});
