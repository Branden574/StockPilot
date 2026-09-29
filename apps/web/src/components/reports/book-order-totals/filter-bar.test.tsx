import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The filter bar: the URL is the report's state, every change starts at page
// 1 and keeps the concrete warehouse, the status filter can deliberately add
// denied and cancelled requests, and the filter lists load once and can be
// retried without touching anything else.

const nav = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ ...nav, prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/dashboard/reports/book-order-totals',
}));

import {
  BOOK_REPORT_UI,
  DEFAULT_BOOK_REPORT_QUERY,
  bookReportStatusLabels,
  type BookReportQuery,
} from '@stockpilot/core';

import { ORG, USER, W1, W2, optionsResponse } from './__fixtures__/answers';
import { BookReportFilterBar } from './filter-bar';
import { __resetBookReportOptionsForTests } from './options';
import { BookReportNavigationProvider, BookReportPagerLink } from './report-navigation';

const fetchMock = vi.fn();
const Q: BookReportQuery = {
  ...DEFAULT_BOOK_REPORT_QUERY,
  statusGroups: [...DEFAULT_BOOK_REPORT_QUERY.statusGroups],
  warehouse: W1,
  page: 3,
};

function bar(query: BookReportQuery = Q) {
  return (
    <BookReportNavigationProvider query={query}>
      <BookReportFilterBar
        query={query}
        organizationId={ORG}
        userId={USER}
        statusLabels={bookReportStatusLabels(null)}
        warehouseEcho={{ id: W1, name: 'North', status: 'active' }}
        categoryEcho={null}
        viewNow={null}
      />
    </BookReportNavigationProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetBookReportOptionsForTests();
  fetchMock.mockImplementation(
    async () =>
      new Response(JSON.stringify(optionsResponse()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Book Order Totals filter bar', () => {
  it('names the current warehouse while the lists load, then offers every warehouse the lines use, archived ones included', async () => {
    let release!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => (release = r)));
    render(bar());
    const select = screen.getByLabelText('Warehouse');
    expect(select).toBeDisabled();
    expect(within(select).getByRole('option', { name: 'North' })).toBeInTheDocument();
    release(
      new Response(JSON.stringify(optionsResponse()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await waitFor(() => expect(select).toBeEnabled());
    expect(within(select).getByRole('option', { name: 'South (archived)' })).toBeInTheDocument();
    const category = screen.getByLabelText('Category');
    expect(within(category).getByRole('option', { name: 'Fiction (deleted)' })).toBeInTheDocument();
    expect(within(category).getByRole('option', { name: 'No category' })).toBeInTheDocument();
  });

  it('choosing a warehouse pushes it as an explicit choice on page 1', async () => {
    render(bar({ ...Q, warehouseFromView: true }));
    const select = screen.getByLabelText('Warehouse');
    await waitFor(() => expect(select).toBeEnabled());
    await userEvent.selectOptions(select, W2);
    const href = nav.push.mock.calls[0]![0] as string;
    expect(href).toContain(`warehouse=${W2}`);
    expect(href).not.toContain('wview');
    expect(href).not.toContain('page=');
  });

  it('Retry loads the lists again after a failure', async () => {
    fetchMock.mockImplementationOnce(async () => new Response('{}', { status: 500 }));
    render(bar());
    await userEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByLabelText('Warehouse')).toBeEnabled());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('status can deliberately include denied and cancelled requests, and needs at least one', async () => {
    render(bar());
    await userEvent.click(screen.getByRole('button', { name: /Status/ }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Denied' }));
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Cancelled' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    const href = nav.push.mock.calls[0]![0] as string;
    expect(href).toContain('status=awaiting%2Cin_progress%2Cbackordered%2Ccompleted%2Cdenied%2Ccancelled');
    expect(href).toContain(`warehouse=${W1}`);
    expect(href).not.toContain('page=');
  });

  it('refuses to apply an empty status set', async () => {
    render(bar({ ...Q, statusGroups: ['completed'] }));
    await userEvent.click(screen.getByRole('button', { name: /Status/ }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Delivered' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Choose at least one status.');
    expect(within(dialog).getByRole('button', { name: 'Apply' })).toBeDisabled();
  });

  it('a real custom range pushes its two dates on page 1', async () => {
    render(bar());
    await userEvent.selectOptions(screen.getByLabelText('Orders placed'), 'custom');
    await userEvent.type(screen.getByLabelText('From'), '2026-09-01');
    await userEvent.type(screen.getByLabelText('To'), '2026-09-28');
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
    const href = nav.push.mock.calls[0]![0] as string;
    expect(href).toContain('range=custom&from=2026-09-01&to=2026-09-28');
    expect(href).not.toContain('page=');
  });

  // Plan 13.7 step 3: the web page and the phone refuse a custom range in the
  // same core sentence (the phone's filters sheet uses it too).
  it('refuses a custom range whose first date is after its last in core copy, and changes nothing', async () => {
    render(bar());
    await userEvent.selectOptions(screen.getByLabelText('Orders placed'), 'custom');
    await userEvent.type(screen.getByLabelText('From'), '2026-09-28');
    await userEvent.type(screen.getByLabelText('To'), '2026-09-01');
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(screen.getByRole('alert')).toHaveTextContent(BOOK_REPORT_UI.customRangeInvalid);
    expect(BOOK_REPORT_UI.customRangeInvalid).toBe(
      'Choose two real dates between 2000 and 2100, the first on or before the second.',
    );
    expect(screen.getByLabelText('From')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('To')).toHaveAttribute('aria-invalid', 'true');
    expect(nav.push).not.toHaveBeenCalled();
  });

  it('desktop layout: the warehouse column is the widest, and a custom range takes its own row instead of pushing Sort onto a second one', async () => {
    render(bar());
    const grid = document.querySelector('[data-filter-grid]') as HTMLElement;
    // "All warehouses you can see" needs about 230 px; five equal columns in
    // max-w-6xl give each about 211 px, which cut it off.
    expect(grid.className).toContain(
      'lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)]',
    );
    await userEvent.selectOptions(screen.getByLabelText('Orders placed'), 'custom');
    const items = [...grid.children] as HTMLElement[];
    // No control widens itself at lg (a 2-column span made six cells for five
    // columns, so Sort wrapped alone).
    expect(
      items.filter(
        (el) =>
          /(^|\s)(sm:)?col-span-2(\s|$)/.test(el.className) && !/lg:col-span-/.test(el.className),
      ),
    ).toEqual([]);
    const custom = screen.getByLabelText('From').closest('[data-custom-range]') as HTMLElement;
    expect(items).toContain(custom);
    expect(custom.className).toContain('lg:col-span-5');
    expect(custom.className).toContain('lg:order-last');
    const controls = items.filter((el) => el !== custom);
    expect(controls).toHaveLength(5);
    for (const el of controls) expect(el.className).not.toMatch(/col-span/);
  });

  it('a preset pushes at once', async () => {
    render(bar());
    await userEvent.selectOptions(screen.getByLabelText('Orders placed'), '30d');
    expect(nav.push.mock.calls[0]![0]).toContain('range=30d');
  });
});

describe('changes made while an answer is still loading', () => {
  // The router is mocked, so a pushed URL never lands: exactly the window in
  // which a person makes a second change before the first answer arrives.
  function page(query: BookReportQuery = Q) {
    return (
      <BookReportNavigationProvider query={query}>
        <BookReportFilterBar
          query={query}
          organizationId={ORG}
          userId={USER}
          statusLabels={bookReportStatusLabels(null)}
          warehouseEcho={{ id: W1, name: 'North', status: 'active' }}
          categoryEcho={null}
          viewNow={null}
        />
        <BookReportPagerLink query={query} step={1} enabled rel="next">
          Next
        </BookReportPagerLink>
      </BookReportNavigationProvider>
    );
  }

  it('a settled search, then Sort before the answer lands: the pushed URL keeps the search', async () => {
    render(page());
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search books' }), 'odyssey');
    await waitFor(() => expect(nav.replace).toHaveBeenCalled());
    expect(nav.replace.mock.calls.at(-1)![0]).toContain('q=odyssey');
    await userEvent.selectOptions(screen.getByLabelText('Sort'), 'title');
    const href = nav.push.mock.calls.at(-1)![0] as string;
    expect(href).toContain('q=odyssey');
    expect(href).toContain('sort=title');
    // The box was not cleared by the second change.
    expect(screen.getByRole('searchbox', { name: 'Search books' })).toHaveValue('odyssey');
  });

  it('a chosen warehouse, then a status Apply: both are in the URL, and the select shows the choice while it loads', async () => {
    render(page());
    const select = screen.getByLabelText('Warehouse');
    await waitFor(() => expect(select).toBeEnabled());
    await userEvent.selectOptions(select, W2);
    expect(select).toHaveValue(W2);
    await userEvent.click(screen.getByRole('button', { name: /Status/ }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Denied' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    const href = nav.push.mock.calls.at(-1)![0] as string;
    expect(href).toContain(`warehouse=${W2}`);
    expect(href).toContain('denied');
  });

  it('Next during a pending search pages the searched report, never the old one', async () => {
    render(page({ ...Q, page: 1 }));
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search books' }), 'odyssey');
    await waitFor(() => expect(nav.replace).toHaveBeenCalled());
    await userEvent.click(screen.getByRole('link', { name: 'Next' }));
    const href = nav.push.mock.calls.at(-1)![0] as string;
    expect(href).toContain('q=odyssey');
    expect(href).toContain('page=2');
  });

  it('once an answer lands (a new query from the server, or Back), the page shows it', async () => {
    const { rerender } = render(page());
    const select = screen.getByLabelText('Sort');
    await userEvent.selectOptions(select, 'title');
    expect(select).toHaveValue('title');
    // Back to an earlier state: the server renders a different query.
    rerender(page({ ...Q, sort: 'orders' }));
    expect(screen.getByLabelText('Sort')).toHaveValue('orders');
  });
});
