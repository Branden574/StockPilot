// @vitest-environment happy-dom
import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The PO imports list in the redesign (P4.C1, matrix W-PU-05):
 *
 * - CONFLICTS D11: the Source column names the source in words (PDF, CSV,
 *   Scan) instead of the stored key.
 * - The status tabs stay a "Filter by status" navigation of links that keep
 *   the search, with aria-current on the tab shown and each tab's unfiltered
 *   count.
 * - The tour's three targets stay: the page's h1, the "+ New import" anchor
 *   with its exact href, and a table.
 * - The heading follows a Settings > Navigation rename of the sidebar entry
 *   (PLAN rule 10), and a failed lookup keeps the page's own words.
 * - Every state keeps its words: the failed read, the empty org and the
 *   no-match search.
 */

const { svc, org } = vi.hoisted(() => ({
  svc: {
    list: vi.fn(),
    count: vi.fn(),
    searchCapped: vi.fn(),
    uploaderProfiles: vi.fn(),
  },
  org: {
    row: { timezone: 'America/Los_Angeles', nav_overrides: null } as Record<string, unknown> | null,
  },
}));

vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({
      href,
      children,
      prefetch: _prefetch,
      scroll: _scroll,
      replace: _replace,
      ...rest
    }: {
      href: string;
      children: React.ReactNode;
      prefetch?: unknown;
      scroll?: unknown;
      replace?: unknown;
    }) => React.createElement('a', { href, ...rest }, children),
  };
});
vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: vi.fn(async () => ({ enabled: true, canManage: true })),
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({ organizationId: 'org-1' })),
}));
vi.mock('@/lib/dashboard/request-cache', () => ({
  getOrgRowForRequest: vi.fn(async () => org.row),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/server/services/po-imports', () => ({
  PoImportsService: { forCurrentUser: vi.fn(async () => svc) },
}));
vi.mock('@/components/po-imports/po-import-search', () => ({ PoImportSearch: () => null }));
vi.mock('@/components/onboarding/page-tour', () => ({ PageTour: () => null }));
vi.mock('@/components/ui/pagination', () => ({ Pagination: () => null }));

import PoImportsPage from './page';

function row(id: string, source_type: string) {
  return {
    id,
    display_name: null,
    file_name: `${id}.${source_type === 'scan' ? 'jpg' : source_type}`,
    source_type,
    status: 'parsed',
    superseded_at: null,
    reimported_from_id: null,
    created_at: '2026-09-10T17:30:00Z',
    uploaded_by: null,
    deleted_users: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  org.row = { timezone: 'America/Los_Angeles', nav_overrides: null };
  svc.list.mockResolvedValue([row('a', 'pdf'), row('b', 'csv'), row('c', 'scan')]);
  // Active (the current tab's filtered total), then Active, Approved, Cancelled.
  svc.count
    .mockResolvedValueOnce(3)
    .mockResolvedValueOnce(3)
    .mockResolvedValueOnce(7)
    .mockResolvedValueOnce(2);
  svc.searchCapped.mockResolvedValue(false);
  svc.uploaderProfiles.mockResolvedValue(new Map());
});

describe('PO imports list (redesign)', () => {
  it('names each source in words, not the stored key (CONFLICTS D11)', async () => {
    render(await PoImportsPage({ searchParams: Promise.resolve({}) }));
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getAllByRole('cell')[1]!.textContent)).toEqual([
      'PDF',
      'CSV',
      'Scan',
    ]);
  });

  it('keeps the status tabs as a "Filter by status" navigation with unfiltered counts and the search', async () => {
    svc.count.mockReset();
    svc.count
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(7)
      .mockResolvedValueOnce(2);
    svc.searchCapped.mockResolvedValue(false);
    render(
      await PoImportsPage({ searchParams: Promise.resolve({ q: 'acme', status: 'approved' }) }),
    );
    const nav = screen.getByRole('navigation', { name: 'Filter by status' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual(['Active3', 'Approved7', 'Cancelled2']);
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      '/dashboard/purchase-orders/imports?status=active&q=acme',
      '/dashboard/purchase-orders/imports?status=approved&q=acme',
      '/dashboard/purchase-orders/imports?status=cancelled&q=acme',
    ]);
    expect(links.map((l) => l.getAttribute('aria-current'))).toEqual([null, 'page', null]);
  });

  it("keeps the tour's targets: the h1, the exact New import anchor and a table", async () => {
    const { container } = render(await PoImportsPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole('heading', { level: 1, name: 'PO imports' })).toBeInTheDocument();
    expect(
      container.querySelector('a[href="/dashboard/purchase-orders/imports/new"]'),
    ).toHaveTextContent('+ New import');
    expect(container.querySelector('table')).not.toBeNull();
    // The page title names the table's scroll region.
    expect(screen.getByRole('region', { name: 'PO imports' })).toContainElement(
      container.querySelector('table'),
    );
    expect(
      screen.getByText(
        'Upload a vendor PO PDF or CSV to stage expected inbound. Inventory is not changed until you receive the items.',
      ),
    ).toBeInTheDocument();
  });

  it('titles the page with a Settings > Navigation rename of its sidebar entry', async () => {
    org.row = {
      timezone: 'America/Los_Angeles',
      nav_overrides: { v: 1, labels: { '/dashboard/purchase-orders/imports': 'Vendor uploads' } },
    };
    render(await PoImportsPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^Vendor uploads$/);
  });

  it('keeps the failed-read, empty and no-match words', async () => {
    svc.list.mockRejectedValueOnce(new Error('boom'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failed = render(await PoImportsPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole('heading', { name: "We couldn't load imports" })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Try again' })).toHaveAttribute(
      'href',
      '/dashboard/purchase-orders/imports',
    );
    failed.unmount();
    errorSpy.mockRestore();

    svc.list.mockResolvedValue([]);
    svc.count.mockReset();
    svc.count.mockResolvedValue(0);
    const empty = render(await PoImportsPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole('heading', { name: 'No imports yet' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Upload your first import' })).toHaveAttribute(
      'href',
      '/dashboard/purchase-orders/imports/new',
    );
    empty.unmount();

    svc.count.mockReset();
    svc.count
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);
    const { container } = render(
      await PoImportsPage({ searchParams: Promise.resolve({ q: 'zzz' }) }),
    );
    expect(screen.getByRole('heading', { name: 'No imports match "zzz"' })).toBeInTheDocument();
    expect(container.querySelector('[data-state-kind="no-match"]')).not.toBeNull();
  });
});
