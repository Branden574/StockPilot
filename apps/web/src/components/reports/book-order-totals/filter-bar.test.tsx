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
  DEFAULT_BOOK_REPORT_QUERY,
  bookReportStatusLabels,
  type BookReportQuery,
} from '@stockpilot/core';

import { ORG, USER, W1, W2, optionsResponse } from './__fixtures__/answers';
import { BookReportFilterBar } from './filter-bar';
import { __resetBookReportOptionsForTests } from './options';
import { BookReportNavigationProvider } from './report-navigation';

const fetchMock = vi.fn();
const Q: BookReportQuery = {
  ...DEFAULT_BOOK_REPORT_QUERY,
  statusGroups: [...DEFAULT_BOOK_REPORT_QUERY.statusGroups],
  warehouse: W1,
  page: 3,
};

function bar(query: BookReportQuery = Q) {
  return (
    <BookReportNavigationProvider>
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

  it('a preset pushes at once', async () => {
    render(bar());
    await userEvent.selectOptions(screen.getByLabelText('Orders placed'), '30d');
    expect(nav.push.mock.calls[0]![0]).toContain('range=30d');
  });
});
