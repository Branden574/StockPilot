import { render, screen, within } from '@testing-library/react';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The count page's record header (redesign M6): the way back to the
// remembered list, the reference as the one h1 with its copy button (or
// "Reference unavailable"), what the count covers and when it started, the
// count sheet or variance report, and the linked exceptions streamed into the
// count's side rail. The count itself (entry, review, posting) is
// cycle-count-detail.test.tsx's; here it is a stub that records its props.

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
  notFound: vi.fn(() => {
    throw new Error('notFound');
  }),
  usePathname: () => '/dashboard/cycle-counts/5eed0000-0000-4000-8000-0000000000c1',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));

vi.mock('@/lib/dashboard/request-cache', () => ({
  getOrgRowForRequest: vi.fn(async () => ({ timezone: 'America/Los_Angeles' })),
}));

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

const detailHolder = vi.hoisted(() => ({ header: {} as Record<string, unknown> }));
const getDetailPage = vi.fn(async () => ({
  header: detailHolder.header,
  lines: [],
  summary: { total: 2, counted: 1, varianceCount: 1, netDelta: -1 },
  total: 2,
  pageSize: 50,
  page: 1,
}));
vi.mock('@/server/services/cycle-counts', () => ({
  CycleCountsService: {
    forCurrentUser: vi.fn(async () => ({ getDetailPage, itemsInScopeCount: vi.fn(async () => 2) })),
  },
}));
vi.mock('@/server/services/warehouses', () => ({
  WarehousesService: {
    forCurrentUser: vi.fn(async () => ({
      listNames: vi.fn(async () => [{ id: 'wh-north', name: 'North DC' }]),
    })),
  },
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => {
    const chain: Record<string, unknown> = {};
    const self = new Proxy(chain, {
      get(_t, prop) {
        if (prop === 'maybeSingle') {
          return async () => ({
            data: { full_name: 'Leo Fairbanks', email: 'leo@x' },
            error: null,
          });
        }
        return () => self;
      },
    });
    return { from: () => self };
  }),
}));
const fetchCountAssignees = vi.fn(async () => [
  { id: 'u-leo', name: 'Leo Fairbanks', email: 'leo@x' },
]);
vi.mock('@/server/lib/count-assignees', () => ({
  fetchCountAssignees: (...a: unknown[]) => fetchCountAssignees(...(a as [])),
}));

vi.mock('@/components/exceptions/linked-exceptions-block', () => ({
  LinkedExceptionsBlock: ({ cycleCountId }: { cycleCountId: string }) => (
    <p data-testid="linked-exceptions-stub">{cycleCountId}</p>
  ),
}));
const detailProps = vi.fn();
vi.mock('@/components/cycle-counts/cycle-count-detail', () => ({
  CycleCountDetail: (props: { linkedExceptions?: React.ReactNode }) => {
    detailProps(props);
    return <div data-testid="count-detail-stub">{props.linkedExceptions}</div>;
  },
}));

import { notFound } from 'next/navigation';

import { ServiceError } from '@/server/services/context';

import CycleCountDetailPage from './page';

const CC_ID = '5eed0000-0000-4000-8000-0000000000c1';

const HEADER = {
  id: CC_ID,
  count_number: 42,
  status: 'in_progress',
  warehouse_id: 'wh-north',
  scope: 'warehouse',
  notes: 'Monthly count: North DC',
  assigned_to: null,
  started_at: '2026-09-23T03:00:00Z',
  completed_at: null,
};

async function renderPage(header: Record<string, unknown> = HEADER) {
  detailHolder.header = header;
  render(
    await CycleCountDetailPage({
      params: Promise.resolve({ id: CC_ID }),
      searchParams: Promise.resolve({}),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  ctxHolder.current = { role: 'manager', permissions: undefined };
});

describe('cycle count page header', () => {
  it('links back to the list beside the reference, which is the page heading', async () => {
    await renderPage();
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByRole('link', { name: '← Back to cycle counts' })).toHaveAttribute(
      'href',
      '/dashboard/cycle-counts',
    );
    expect(within(crumbs).getByText('CC-000042')).toHaveAttribute('aria-current', 'page');
    expect(
      screen.getByRole('heading', { level: 1, name: 'Cycle count CC-000042' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy reference CC-000042' })).toBeInTheDocument();
  });

  it('says what the count covers and when it started, in the workspace time zone', async () => {
    await renderPage();
    expect(screen.getByText('North DC · Monthly count: North DC')).toBeInTheDocument();
    // 03:00 UTC on Sep 23 is 8:00 PM on Sep 22 in Los Angeles.
    expect(screen.getByText(/Sep 22, 2026, 8:00\s?PM/)).toHaveAttribute(
      'datetime',
      '2026-09-23T03:00:00Z',
    );
    expect(screen.getByText(/^Started /)).toBeInTheDocument();
  });

  it('prints the count sheet while open, in a new tab', async () => {
    await renderPage();
    const sheet = screen.getByRole('link', { name: 'Print count sheet' });
    expect(sheet).toHaveAttribute('href', `/api/cycle-counts/${CC_ID}/pdf`);
    expect(sheet).toHaveAttribute('target', '_blank');
    expect(sheet).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it.each(['completed', 'canceled'])(
    'a %s count offers the variance report instead',
    async (status) => {
      await renderPage({ ...HEADER, status, completed_at: '2026-09-24T03:00:00Z' });
      expect(screen.getByRole('link', { name: 'Variance report PDF' })).toHaveAttribute(
        'href',
        `/api/cycle-counts/${CC_ID}/pdf`,
      );
      expect(screen.queryByRole('link', { name: 'Print count sheet' })).not.toBeInTheDocument();
    },
  );

  it('never makes up a reference for a count without a number', async () => {
    await renderPage({ ...HEADER, count_number: null });
    expect(screen.getByRole('heading', { level: 1, name: 'Cycle count' })).toBeInTheDocument();
    expect(screen.getByText('Reference unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Copy reference/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/CC-0/)).not.toBeInTheDocument();
  });

  it('streams the linked exceptions into the count, for this count', async () => {
    await renderPage();
    expect(
      within(screen.getByTestId('count-detail-stub')).getByTestId('linked-exceptions-stub'),
    ).toHaveTextContent(CC_ID);
  });

  it('hands the count its gates: a manager assigns from the member list, staff only read the name', async () => {
    await renderPage({ ...HEADER, assigned_to: 'u-leo' });
    expect(detailProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ canAssign: true, canAdjust: true, assigneeName: 'Leo Fairbanks' }),
    );
    expect(fetchCountAssignees).toHaveBeenCalledTimes(1);

    ctxHolder.current = { role: 'staff', permissions: undefined };
    detailProps.mockClear();
    fetchCountAssignees.mockClear();
    await renderPage({ ...HEADER, assigned_to: 'u-leo' });
    expect(detailProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ canAssign: false, canAdjust: true, assigneeName: 'Leo Fairbanks' }),
    );
    expect(fetchCountAssignees).not.toHaveBeenCalled();
  });

  it('an unknown count is a 404', async () => {
    getDetailPage.mockRejectedValueOnce(new ServiceError('not_found', 'no such count'));
    await expect(
      CycleCountDetailPage({
        // A well-formed id the service does not find.
        params: Promise.resolve({ id: '5eed0000-0000-4000-8000-0000000000c2' }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow('notFound');
    expect(notFound).toHaveBeenCalled();
  });

  // B63: a mistyped or cut-off link is Page not found before the count is
  // read (its invalid-uuid error reached the error boundary), and ahead of
  // the visibility redirect.
  it('a count id that is not a uuid is a 404 with nothing read', async () => {
    const { requireOrgContext } = await import('@/lib/auth/session');
    ctxHolder.current = { role: 'viewer', permissions: new Set<string>() };
    for (const id of ['not-a-uuid', CC_ID.slice(0, -1)]) {
      await expect(
        CycleCountDetailPage({
          params: Promise.resolve({ id }),
          searchParams: Promise.resolve({}),
        }),
        id,
      ).rejects.toThrow('notFound');
    }
    expect(getDetailPage).not.toHaveBeenCalled();
    expect(requireOrgContext).not.toHaveBeenCalled();
  });
});
