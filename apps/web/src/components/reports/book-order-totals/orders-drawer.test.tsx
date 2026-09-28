// Security invariant: the Book Order Totals drill-down (0379). An order
// number is a link only where the API says `openable` (orders:approve, or the
// caller's own request), so a report reader without approval rights never
// gets a one-click route to other requesters' orders; no requester data is
// shown. A late or mismatched answer (another book, organization or
// warehouse) is dropped, never shown; the header is the book's FULL total;
// a refusal is worded, never an empty list.
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({ params: new URLSearchParams() }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => nav.params,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/dashboard/reports/book-order-totals',
}));

import {
  BOOK_REPORT_MFA_VERIFY,
  BOOK_REPORT_NOT_IN_SCOPE,
  BOOK_REPORT_ORDER_LINK_HINT,
  BOOK_REPORT_ORDERS_LOAD_ERROR,
  BOOK_REPORT_TIMEOUT,
  DEFAULT_BOOK_REPORT_QUERY,
  bookReportStatusLabels,
  type BookReportQuery,
} from '@stockpilot/core';

import { ITEM_A, ITEM_B, O1, O2, O3, ORG, OTHER_ORG, W1, ordersJson, orderRow } from './__fixtures__/answers';
import { BookOrdersDrawer, ViewOrdersButton, bookOrdersErrorFor } from './orders-drawer';

const ALL: BookReportQuery = { ...DEFAULT_BOOK_REPORT_QUERY, warehouse: 'all', q: 'hobbit' };
const labels = bookReportStatusLabels(null);
const fetchMock = vi.fn();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function drawer(query: BookReportQuery = ALL) {
  return (
    <BookOrdersDrawer
      organizationId={ORG}
      query={query}
      statusLabels={labels}
      titles={{ [ITEM_A]: 'Book A', [ITEM_B]: 'Book B' }}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  nav.params = new URLSearchParams(`view=${ITEM_A}`);
  fetchMock.mockImplementation(async () => json(ordersJson()));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('View orders drawer', () => {
  it("asks for this book's orders with the range, statuses and concrete warehouse, not the search", async () => {
    render(drawer({ ...ALL, warehouse: W1, warehouseFromView: true }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain(`/api/v1/reports/book-order-totals/items/${ITEM_A}/orders?`);
    expect(url).toContain(`warehouse=${W1}&wview=1`);
    expect(url).toContain('page=1');
    expect(url).not.toContain('q=');
  });

  it("shows the book's FULL totals in the header, never the visible page's, and the five columns", async () => {
    render(drawer());
    const dialog = await screen.findByRole('dialog');
    await waitFor(() =>
      expect(dialog).toHaveAccessibleDescription('Copies of this book requested: 30 in 3 orders'),
    );
    for (const name of ['Order #', 'Order date', 'Warehouse', 'Status', 'Copies of this book requested']) {
      expect(within(dialog).getByRole('columnheader', { name })).toBeInTheDocument();
    }
    expect(within(dialog).getByText('Recorded as fulfilled: 8 · Returned: 2')).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        'As of 10:42 AM. An order opens as it is now, so its lines may differ if it changed after this time.',
      ),
    ).toBeInTheDocument();
    // Two lines of this book on one order are one row, with their ids kept.
    const combined = within(dialog).getByText('(2 lines)');
    expect(combined).toHaveAttribute('data-line-ids', 'l2a,l2b');
    expect(within(dialog).getByText('Showing 1–3 of 3 orders · Page 1 of 1')).toBeInTheDocument();
  });

  it('links an order only when the API says it may be opened; every other number is plain text', async () => {
    render(drawer());
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('SO-000003');
    const links = within(dialog)
      .queryAllByRole('link')
      .map((a) => a.getAttribute('href'));
    expect(links).toEqual([`/dashboard/orders/${O3}`]);
    expect(document.querySelector(`a[href="/dashboard/orders/${O1}"]`)).toBeNull();
    expect(document.querySelector(`a[href="/dashboard/orders/${O2}"]`)).toBeNull();
    const plain = within(dialog).getByText('SO-000001');
    expect(plain.closest('a')).toBeNull();
    expect(plain).toHaveAttribute('title', BOOK_REPORT_ORDER_LINK_HINT);
    // No requester data of any kind.
    expect(dialog.textContent).not.toMatch(/@|requester/i);
  });

  it('drops an answer for another organization', async () => {
    fetchMock.mockImplementation(async () => json(ordersJson({ organizationId: OTHER_ORG })));
    render(drawer());
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(BOOK_REPORT_ORDERS_LOAD_ERROR);
    expect(within(dialog).queryByText('SO-000003')).not.toBeInTheDocument();
  });

  it('drops an answer for another warehouse', async () => {
    fetchMock.mockImplementation(async () =>
      json(
        ordersJson({
          warehouse: { id: W1, source: 'explicit' },
          filters: { warehouse: { id: W1, name: 'North', status: 'active' } },
        }),
      ),
    );
    render(drawer()); // the page asked for all warehouses
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(BOOK_REPORT_ORDERS_LOAD_ERROR);
  });

  it('drops a late answer for the book that was open before', async () => {
    let releaseA!: (r: Response) => void;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes(ITEM_A)) return new Promise<Response>((r) => (releaseA = r));
      return json(
        ordersJson({
          book: { ...(ordersJson().book as Record<string, unknown>), itemId: ITEM_B, name: 'Book B' },
          totals: { copies: '4', orders: 1, lines: 1, fulfilled: '0', returned: '0' },
        }, [orderRow(O1, 1, { copies: '4' })]),
      );
    });
    const view = render(drawer());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    nav.params = new URLSearchParams(`view=${ITEM_B}`);
    view.rerender(drawer());
    const dialog = await screen.findByRole('dialog');
    await waitFor(() =>
      expect(dialog).toHaveAccessibleDescription('Copies of this book requested: 4 in 1 order'),
    );
    await act(async () => {
      releaseA(json(ordersJson()));
    });
    expect(dialog).toHaveAccessibleDescription('Copies of this book requested: 4 in 1 order');
    expect(within(dialog).queryAllByText('Copies of this book requested: 30 in 3 orders')).toEqual([]);
  });

  it('a hidden, non-book or missing book reads as out of scope, never an empty list', async () => {
    fetchMock.mockImplementation(async () =>
      json({ error: 'not_found', message: BOOK_REPORT_NOT_IN_SCOPE }, 404),
    );
    render(drawer());
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(BOOK_REPORT_NOT_IN_SCOPE);
    expect(within(dialog).queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('a failure offers Try again and asks again', async () => {
    fetchMock.mockImplementationOnce(async () => json({ error: 'internal_error' }, 500));
    render(drawer());
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(BOOK_REPORT_ORDERS_LOAD_ERROR);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Try again' }));
    expect(await within(dialog).findByText('SO-000003')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('words each refusal', () => {
    expect(bookOrdersErrorFor(503, { details: { reason: 'timeout' } }).message).toBe(BOOK_REPORT_TIMEOUT);
    expect(bookOrdersErrorFor(403, { details: { reason: 'aal2_required' } }).message).toBe(
      BOOK_REPORT_MFA_VERIFY,
    );
    expect(bookOrdersErrorFor(500, null)).toEqual({ message: BOOK_REPORT_ORDERS_LOAD_ERROR, retry: true });
  });

  it('is closed with no book in the URL and fetches nothing', () => {
    nav.params = new URLSearchParams('');
    render(drawer());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('View orders adds the book to the URL as a new history entry, keeping every report filter', async () => {
    window.history.replaceState(null, '', '/dashboard/reports/book-order-totals?warehouse=all&q=x&vpage=4');
    const push = vi.spyOn(window.history, 'pushState');
    render(<ViewOrdersButton itemId={ITEM_A} title="Book A" />);
    await userEvent.click(screen.getByRole('button', { name: 'View orders for Book A' }));
    expect(push).toHaveBeenCalledWith(
      { bookReportDrawer: true },
      '',
      `/dashboard/reports/book-order-totals?warehouse=all&q=x&view=${ITEM_A}`,
    );
    push.mockRestore();
  });
});
