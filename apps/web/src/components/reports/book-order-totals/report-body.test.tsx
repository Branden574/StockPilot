// Security invariant: the Book Order Totals page (0379). Every number comes
// from ONE awaited service answer; a failure never renders figures; the MFA
// refusal is a state, not an error page; the warehouse is resolved once and
// every derived URL (pages, filters, the drill-down fetch, both exports)
// carries the concrete warehouse, never "default"; export controls only for
// reports:export; the filter lists and the covers never hold back or change
// a total.
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/image', () => ({
  default: (props: Record<string, unknown>) => {
    const { src, alt } = props as { src: string; alt?: string };
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={alt ?? ''} />;
  },
}));

const nav = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  params: new URLSearchParams(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace, refresh: nav.refresh, prefetch: vi.fn() }),
  useSearchParams: () => nav.params,
  usePathname: () => '/dashboard/reports/book-order-totals',
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
}));

vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));
vi.mock('@/lib/env', () => ({ env: { NEXT_PUBLIC_SUPABASE_URL: 'https://proj.supabase.co' } }));
const view = vi.hoisted(() => ({ current: null as string | null }));
vi.mock('@/lib/warehouse-filter', () => ({
  getActiveWarehouseFilter: vi.fn(async () => view.current),
}));
vi.mock('@/lib/dashboard/request-cache', () => ({
  getOrgRowForRequest: vi.fn(async () => ({
    order_status_config: { completed: { label: 'Handed over' } },
  })),
}));
vi.mock('@/server/services/item-images', () => ({ ItemImagesService: vi.fn() }));
const svc = vi.hoisted(() => ({ page: vi.fn(), covers: vi.fn() }));
vi.mock('@/server/services/book-order-totals', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/book-order-totals')>()),
  BookOrderTotalsService: { forCurrentUser: vi.fn(async () => svc) },
}));

import { ServiceError } from '@/server/services/context';

import {
  BOOK_REPORT_CSV_MAX_ROWS,
  BOOK_REPORT_EMPTY,
  BOOK_REPORT_EMPTY_DEFAULT_STATUS,
  BOOK_REPORT_EMPTY_SEARCH,
  BOOK_REPORT_FILTERS_RESET,
  BOOK_REPORT_MFA_ENROLL,
  BOOK_REPORT_MFA_VERIFY,
  BOOK_REPORT_PDF_MAX_ROWS,
  BOOK_REPORT_RESTRICTED,
  BOOK_REPORT_TIMEOUT,
} from '@stockpilot/core';

import {
  ITEM_A,
  ITEM_B,
  ORG,
  USER,
  W1,
  W2,
  bookRow,
  optionsResponse,
  ordersJson,
  totalsResponse,
} from './__fixtures__/answers';
import { __resetBookReportOptionsForTests } from './options';
import { BookOrderTotalsBody, type BookOrderTotalsBodyProps } from './report-body';

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function optionsCalls(): number {
  return fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/options')).length;
}

async function body(
  sp: Record<string, string> = {},
  over: Partial<BookOrderTotalsBodyProps> = {},
) {
  return BookOrderTotalsBody({
    searchParams: Promise.resolve(sp),
    organizationId: ORG,
    userId: USER,
    canExport: true,
    hasWarehouseView: true,
    ...over,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetBookReportOptionsForTests();
  nav.params = new URLSearchParams();
  view.current = null;
  svc.page.mockImplementation(async (_q: unknown, w: { id: string | null; source: string }) =>
    totalsResponse({}, w as never),
  );
  svc.covers.mockResolvedValue({});
  fetchMock.mockImplementation(async (url: string) => {
    if (url.endsWith('/options')) return jsonResponse(optionsResponse());
    return jsonResponse(ordersJson());
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Book Order Totals page body', () => {
  it('shows the three totals for the WHOLE filtered result, each with its definition, and an honest footer', async () => {
    svc.page.mockResolvedValue(
      totalsResponse({
        totalCount: 32,
        summary: {
          ...totalsResponse().summary,
          copies: '642',
          entries: 32,
          orders: 26,
        },
      }),
    );
    render(await body());

    const copies = screen.getByRole('group', { name: 'Total books ordered' });
    expect(within(copies).getByText('642')).toBeInTheDocument();
    expect(within(copies).getByText('copies requested')).toBeInTheDocument();
    expect(
      within(copies).getByText('Copies requested through Orders; not copies purchased or current stock.'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('group', { name: 'Distinct book entries' })).getByText('32'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('group', { name: 'Orders containing books' })).getByText('26'),
    ).toBeInTheDocument();

    expect(screen.getByText('Showing 1–2 of 32 book entries · Page 1 of 2')).toBeInTheDocument();
    expect(
      screen.getByText('Grand total for all 2 pages: 642 copies requested in 26 orders.'),
    ).toBeInTheDocument();
    // Scope: dates from SQL's own local strings, the org's status labels,
    // the warehouse, the generated time and the zone.
    expect(
      screen.getByText('Orders placed during: All time (May 12, 2026 – Sep 20, 2026)'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Status: Pending, In progress, Backordered, Handed over. Denied, cancelled and unconfirmed requests are left out.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Warehouse: All warehouses you can see')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Generated Sep 28, 2026, 10:42 AM. Orders can change after this time. Times are in America/Los_Angeles.',
      ),
    ).toBeInTheDocument();
  });

  it('renders an image-led table with column headers, row headers and a View orders action per book', async () => {
    render(await body());
    for (const name of ['Cover', 'Book', 'Copies requested', 'Orders', 'Latest order']) {
      expect(screen.getByRole('columnheader', { name })).toBeInTheDocument();
    }
    const rowA = screen.getByRole('row', { name: /Book A/ });
    expect(within(rowA).getByRole('rowheader')).toHaveTextContent('Book A');
    expect(
      within(rowA).getByText('SKU BK-A · ISBN 9780140449136 · North · Rack 12-B'),
    ).toBeInTheDocument();
    expect(within(rowA).getByText('30')).toBeInTheDocument();
    expect(within(rowA).getByText('Sep 20, 2026')).toBeInTheDocument();
    expect(within(rowA).getByRole('button', { name: 'View orders for Book A' })).toBeInTheDocument();
  });

  it('heads the quantity column "Quantity requested" when any book is in another unit', async () => {
    svc.page.mockImplementation(async () =>
      totalsResponse({
        summary: { ...totalsResponse().summary, unresolved: { entries: 1, quantity: '3' } },
      }),
    );
    render(await body());
    expect(screen.getByRole('columnheader', { name: 'Quantity requested' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Copies requested' })).toBeNull();
  });

  it('with no warehouse in the URL, applies the warehouse view ONCE and carries it into every link and the drill-down fetch', async () => {
    view.current = W1;
    nav.params = new URLSearchParams(`view=${ITEM_A}`);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/options')) return jsonResponse(optionsResponse());
      return jsonResponse(
        ordersJson({
          warehouse: { id: W1, source: 'view' },
          filters: { warehouse: { id: W1, name: 'North', status: 'active' } },
        }),
      );
    });
    svc.page.mockResolvedValue(
      totalsResponse({ totalCount: 30 }, { id: W1, source: 'view' }),
    );
    render(await body());

    expect(svc.page).toHaveBeenCalledTimes(1);
    expect(svc.page.mock.calls[0]![1]).toEqual({ id: W1, source: 'view' });
    expect(screen.getByText('Warehouse: North (your warehouse view)')).toBeInTheDocument();

    const carried = `warehouse=${W1}&wview=1`;
    // The drill-down sheet is open (view= in the URL), so the page behind it
    // is aria-hidden: query it with hidden: true.
    const next = screen.getByRole('link', { name: 'Next', hidden: true });
    expect(next.getAttribute('href')).toContain(carried);
    expect(next.getAttribute('href')).toContain('page=2');
    const csv = screen.getByRole('link', { name: /CSV \(data only, no covers\)/, hidden: true });
    expect(csv.getAttribute('href')).toContain(carried);
    expect(csv.getAttribute('href')).toContain('format=csv');

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes(`/items/${ITEM_A}/orders?`))).toBe(true),
    );
    const drill = String(fetchMock.mock.calls.find(([u]) => String(u).includes('/orders?'))![0]);
    expect(drill).toContain(carried);
    expect(drill).not.toContain('warehouse=default');
  });

  it('warehouse=all beats the warehouse view, and the links say all', async () => {
    view.current = W1;
    svc.page.mockResolvedValue(totalsResponse({ totalCount: 30 }));
    render(await body({ warehouse: 'all' }));
    expect(svc.page.mock.calls[0]![1]).toEqual({ id: null, source: 'all' });
    const next = screen.getByRole('link', { name: 'Next' }).getAttribute('href')!;
    expect(next).toContain('warehouse=all');
    expect(next).not.toContain('wview');
  });

  it('a failed read goes to the error boundary: no card, no zero, no empty table', async () => {
    svc.page.mockRejectedValue(new ServiceError('internal_error', 'rpc failed (XX000)'));
    await expect(body()).rejects.toBeInstanceOf(ServiceError);
  });

  it('an unenrolled admin sees the enroll state, not an error page', async () => {
    svc.page.mockRejectedValue(
      new ServiceError('forbidden', 'enroll', { reason: 'mfa_required' }),
    );
    render(await body());
    expect(screen.getByRole('alert')).toHaveTextContent(BOOK_REPORT_MFA_ENROLL);
    expect(screen.getByRole('link', { name: 'Set up two-step verification' })).toHaveAttribute(
      'href',
      '/dashboard/settings/security?enroll=1',
    );
    expect(screen.queryByText('Total books ordered')).not.toBeInTheDocument();
  });

  it('an enrolled session at AAL1 sees the verify state, back to this report', async () => {
    svc.page.mockRejectedValue(
      new ServiceError('forbidden', 'step up', { reason: 'aal2_required' }),
    );
    render(await body({ sort: 'title' }));
    expect(screen.getByRole('alert')).toHaveTextContent(BOOK_REPORT_MFA_VERIFY);
    expect(screen.getByRole('link', { name: 'Verify now' })).toHaveAttribute(
      'href',
      `/signin/mfa?redirect=${encodeURIComponent('/dashboard/reports/book-order-totals?sort=title')}`,
    );
  });

  it('a statement timeout says so, keeps the filters on screen, and shows no figures', async () => {
    svc.page.mockRejectedValue(
      new ServiceError('internal_error', BOOK_REPORT_TIMEOUT, { reason: 'timeout' }),
    );
    render(await body());
    expect(screen.getByRole('alert')).toHaveTextContent(BOOK_REPORT_TIMEOUT);
    expect(screen.getByRole('region', { name: 'Filters' })).toBeInTheDocument();
    expect(screen.queryByText('Total books ordered')).not.toBeInTheDocument();
  });

  it('a warehouse in the link the caller cannot see is dropped, read again once, and said', async () => {
    svc.page
      .mockRejectedValueOnce(
        new ServiceError('validation_error', 'x', { reason: 'invalid_warehouse' }),
      )
      .mockResolvedValueOnce(totalsResponse());
    render(await body({ warehouse: W2 }));
    expect(svc.page).toHaveBeenCalledTimes(2);
    expect(svc.page.mock.calls[0]![1]).toEqual({ id: W2, source: 'explicit' });
    expect(svc.page.mock.calls[1]![1]).toEqual({ id: null, source: 'all' });
    expect(screen.getByText(BOOK_REPORT_FILTERS_RESET)).toBeInTheDocument();
  });

  it('an invalid key in the link is reset and said', async () => {
    render(await body({ range: 'forever' }));
    expect(screen.getByText(BOOK_REPORT_FILTERS_RESET)).toBeInTheDocument();
  });

  it('the filter lists never hold back the numbers: a failed load disables only Warehouse and Category, with Retry', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ error: 'internal_error' }, 500));
    render(await body());
    expect(screen.getByRole('group', { name: 'Total books ordered' })).toHaveTextContent('34');
    expect(screen.getByRole('row', { name: /Book A/ })).toBeInTheDocument();
    expect(
      await screen.findByText(/Couldn't load the warehouse and category lists\./),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByLabelText('Warehouse')).toBeDisabled();
    expect(screen.getByLabelText('Category')).toBeDisabled();
    expect(screen.getByLabelText('Orders placed')).toBeEnabled();
    expect(screen.getByLabelText('Sort')).toBeEnabled();
    expect(screen.getByRole('searchbox', { name: 'Search books' })).toBeEnabled();
  });

  it('loads the filter lists once for three searches and two page changes', async () => {
    const view1 = render(await body());
    await waitFor(() => expect(screen.getByLabelText('Warehouse')).toBeEnabled());
    const later: Array<Record<string, string>> = [
      { q: 'a' },
      { q: 'ab' },
      { q: 'abc' },
      { q: 'abc', page: '2' },
      { page: '3' },
    ];
    for (const sp of later) {
      view1.rerender(await body(sp));
    }
    await waitFor(() => expect(screen.getByLabelText('Warehouse')).toBeEnabled());
    expect(optionsCalls()).toBe(1);
  });

  it('a filter change pushes a new URL with the page reset and the warehouse kept', async () => {
    svc.page.mockResolvedValue(totalsResponse({ totalCount: 60, page: 2 }, { id: W1, source: 'explicit' }));
    render(await body({ warehouse: W1, page: '2' }));
    await userEvent.selectOptions(screen.getByLabelText('Sort'), 'title');
    expect(nav.push).toHaveBeenCalledTimes(1);
    const href = nav.push.mock.calls[0]![0] as string;
    expect(href).toContain('sort=title');
    expect(href).toContain(`warehouse=${W1}`);
    expect(href).not.toContain('page=');
  });

  it('typing a search replaces the URL once it settles (no history flood)', async () => {
    render(await body());
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search books' }), 'hobbit');
    await waitFor(() => expect(nav.replace).toHaveBeenCalled(), { timeout: 2000 });
    expect(nav.push).not.toHaveBeenCalled();
    const href = nav.replace.mock.calls.at(-1)![0] as string;
    expect(href).toContain('q=hobbit');
    expect(href).toContain('warehouse=all');
  });

  it('a custom range with the first date after the second is refused in place', async () => {
    render(await body());
    await userEvent.selectOptions(screen.getByLabelText('Orders placed'), 'custom');
    const from = screen.getByLabelText('From');
    const to = screen.getByLabelText('To');
    await userEvent.type(from, '2026-09-28');
    await userEvent.type(to, '2026-09-01');
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(screen.getByRole('alert')).toHaveTextContent('first on or before the second');
    expect(nav.push).not.toHaveBeenCalled();
  });

  it('a real empty answer says so and why, for the default status, a restricted scope and a search', async () => {
    svc.page.mockResolvedValue(
      totalsResponse({
        rows: [],
        totalCount: 0,
        scope: { restricted: true },
        summary: { ...totalsResponse().summary, copies: '0', entries: 0, orders: 0 },
      }),
    );
    render(await body({ q: 'zzz' }));
    expect(screen.getByText(BOOK_REPORT_EMPTY)).toBeInTheDocument();
    expect(
      screen.getByText(
        `${BOOK_REPORT_EMPTY_DEFAULT_STATUS} ${BOOK_REPORT_RESTRICTED} ${BOOK_REPORT_EMPTY_SEARCH}`,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Showing 0 book entries')).toBeInTheDocument();
  });

  it('shows no export control without reports:export', async () => {
    render(await body({}, { canExport: false }));
    expect(screen.queryByRole('link', { name: /CSV/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /PDF/ })).not.toBeInTheDocument();
  });

  it('disables a format above its ceiling, with the reason, before any request', async () => {
    svc.page.mockResolvedValue(totalsResponse({ totalCount: BOOK_REPORT_CSV_MAX_ROWS + 1 }));
    render(await body());
    expect(screen.getByRole('button', { name: /CSV/ })).toBeDisabled();
    expect(
      screen.getByText('Too many books for one file (20,001; the limit is 20,000). Narrow the filters.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /PDF/ })).toBeDisabled();
    expect(
      screen.getByText(
        `Too many books for one file (20,001; the limit is ${BOOK_REPORT_PDF_MAX_ROWS.toLocaleString('en-US')}). Narrow the filters.`,
      ),
    ).toBeInTheDocument();
  });

  it('says when the warehouse view moved away from the warehouse this report still shows', async () => {
    view.current = W2;
    svc.page.mockResolvedValue(totalsResponse({}, { id: W1, source: 'view' }));
    render(await body({ warehouse: W1, wview: '1' }));
    expect(
      await screen.findByText(/Your warehouse view is now South\. This report still shows North\./),
    ).toBeInTheDocument();
    const show = screen.getByRole('link', { name: 'Show South' });
    expect(show.getAttribute('href')).not.toContain('warehouse=');
  });

  it('covers arrive after the numbers; a missing or failed cover is a placeholder and never changes a total', async () => {
    let release!: (v: Record<string, string>) => void;
    svc.covers.mockReturnValue(new Promise((r) => (release = r)));
    render(await body());
    // Numbers first, covers still pending.
    expect(screen.getByRole('group', { name: 'Total books ordered' })).toHaveTextContent('34');
    expect(document.querySelectorAll('[data-cover-state="loading"]').length).toBe(2);
    await act(async () => {
      release({
        [ITEM_A]: 'https://proj.supabase.co/storage/v1/object/sign/item-images/a.jpg?token=t',
      });
    });
    expect(await screen.findByAltText('Cover of Book A')).toBeInTheDocument();
    const rowB = screen.getByRole('row', { name: /Book B/ });
    expect(within(rowB).getByText('No cover')).toBeInTheDocument();
    expect(svc.covers).toHaveBeenCalledWith([ITEM_A, ITEM_B]);
    expect(screen.getByRole('group', { name: 'Total books ordered' })).toHaveTextContent('34');
  });

  it('covers that fail to resolve at all leave every row and total in place', async () => {
    svc.covers.mockRejectedValue(new Error('sign failed'));
    render(await body());
    await waitFor(() => expect(screen.getAllByText('No cover')).toHaveLength(2));
    expect(screen.getByRole('group', { name: 'Total books ordered' })).toHaveTextContent('34');
    expect(screen.getAllByRole('row')).toHaveLength(3);
  });

  it('marks a row in another unit and leaves it out of the copy total with a disclosure', async () => {
    svc.page.mockResolvedValue(
      totalsResponse({
        rows: [bookRow(ITEM_A), bookRow(ITEM_B, { countsAsCopies: false, unit: 'pack of 10', copies: '12' })],
        summary: {
          ...totalsResponse().summary,
          copies: '30',
          unresolved: { entries: 1, quantity: '12' },
        },
      }),
    );
    render(await body());
    const rowB = screen.getByRole('row', { name: /Book B/ });
    expect(within(rowB).getByText('12 (pack of 10)')).toBeInTheDocument();
    expect(within(rowB).getByText('Other unit: pack of 10')).toBeInTheDocument();
    expect(
      screen.getAllByText('Leaves out 1 book entry ordered in another unit (12 pack of 10).').length,
    ).toBeGreaterThan(0);
  });
});
