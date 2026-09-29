import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The filter bar: the URL is the report's state, every change starts at page
// 1 and keeps the concrete warehouse, the status filter can deliberately add
// denied and cancelled requests, and the filter lists load once and can be
// retried without touching anything else. The Charter select is the ORDER's
// charter; Orders placed opens a calendar that requests nothing until Apply;
// and every select commits once per choice, never once per arrow key (D16).

const nav = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ ...nav, prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/dashboard/reports/book-order-totals',
}));

import {
  BOOK_REPORT_CHARTER_HINT,
  BOOK_REPORT_UI,
  DEFAULT_BOOK_REPORT_QUERY,
  bookReportStatusLabels,
  type BookReportCharterEcho,
  type BookReportQuery,
  type BookReportRangeEcho,
} from '@stockpilot/core';

import {
  ALDER,
  BIRCH,
  CEDAR,
  CH_A,
  CH_B,
  ORG,
  USER,
  W1,
  W2,
  optionsResponse,
} from './__fixtures__/answers';
import { BookReportFilterBar } from './filter-bar';
import { __resetBookReportOptionsForTests } from './options';
import { BookReportNavigationProvider, BookReportPagerLink } from './report-navigation';
import { COMMITTED_SELECT_IDLE_MS } from './use-committed-select';

const W3 = '0e000000-0000-4000-8000-0000000000d3';
const C1 = '0e000000-0000-4000-8000-0000000000c1';
const C2 = '0e000000-0000-4000-8000-0000000000c2';

const fetchMock = vi.fn();
const Q: BookReportQuery = {
  ...DEFAULT_BOOK_REPORT_QUERY,
  statusGroups: [...DEFAULT_BOOK_REPORT_QUERY.statusGroups],
  warehouse: W1,
  page: 3,
};
const ALL_TIME: BookReportRangeEcho = {
  key: 'all',
  from: null,
  to: null,
  timeZone: 'America/Los_Angeles',
  timeZoneFallback: false,
};

function lists() {
  return optionsResponse({
    warehouses: [
      { id: W1, name: 'North', status: 'active' },
      { id: W2, name: 'South', status: 'archived' },
      { id: W3, name: 'East', status: 'active' },
    ],
    categories: [
      { id: C1, name: 'Fiction', deleted: true },
      { id: C2, name: 'History', deleted: false },
    ],
    charters: [ALDER, BIRCH, CEDAR],
    noCharter: true,
  });
}

function bar(
  query: BookReportQuery = Q,
  over: {
    charterEcho?: BookReportCharterEcho | null;
    rangeEcho?: BookReportRangeEcho | null;
    today?: string | null;
  } = {},
) {
  return (
    <BookReportNavigationProvider query={query}>
      <BookReportFilterBar
        query={query}
        organizationId={ORG}
        userId={USER}
        statusLabels={bookReportStatusLabels(null)}
        warehouseEcho={{ id: W1, name: 'North', status: 'active' }}
        categoryEcho={null}
        charterEcho={over.charterEcho ?? null}
        rangeEcho={over.rangeEcho === undefined ? ALL_TIME : over.rangeEcho}
        today={over.today === undefined ? '2026-09-29' : over.today}
        viewNow={null}
      />
    </BookReportNavigationProvider>
  );
}

function reportPushes(): string[] {
  return nav.push.mock.calls.map(([href]) => String(href));
}

function reportFetches(): string[] {
  return fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => !u.endsWith('/options'));
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetBookReportOptionsForTests();
  fetchMock.mockImplementation(
    async () =>
      new Response(JSON.stringify(lists()), {
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
      new Response(JSON.stringify(lists()), {
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
    expect(screen.getByLabelText('Charter')).toBeEnabled();
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

  it('a preset pushes at once', async () => {
    render(bar());
    await userEvent.selectOptions(screen.getByLabelText('Orders placed'), '30d');
    expect(nav.push.mock.calls[0]![0]).toContain('range=30d');
  });

  it("offers Today and This week in the brief's order", () => {
    render(bar());
    const names = within(screen.getByLabelText('Orders placed'))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(names).toEqual([
      'All time',
      'Today',
      'This week',
      'This month',
      'Last 30 days',
      'Last 90 days',
      'This year',
      'Custom range',
    ]);
  });

  it('desktop layout: Charter and Orders placed lead the bar, the four refinements share one row (Sort never alone), and the two dates never wrap apart', () => {
    render(bar());
    const primary = document.querySelector('[data-filter-grid-primary]') as HTMLElement;
    expect(primary.className).toContain('lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]');
    const lead = [...primary.children] as HTMLElement[];
    expect(lead).toHaveLength(2);
    expect(within(lead[0]!).getByLabelText('Charter')).toBeInTheDocument();
    expect(within(lead[1]!).getByLabelText('Orders placed')).toBeInTheDocument();

    const grid = document.querySelector('[data-filter-grid]') as HTMLElement;
    expect(grid.className).toContain('lg:grid-cols-4');
    const controls = [...grid.children] as HTMLElement[];
    // Status, Warehouse, Category and Sort: four cells for four columns, so
    // Sort can never wrap onto a line of its own.
    expect(controls).toHaveLength(4);
    for (const el of controls) expect(el.className).not.toMatch(/col-span/);
    expect(within(controls[3]!).getByLabelText('Sort')).toBeInTheDocument();

    const pair = document.querySelector('[data-date-pair]') as HTMLElement;
    expect(pair.className).toContain('flex-nowrap');
    // The preset and the pair share a line only from lg (a half-width sm
    // column would squeeze the two dates).
    const row = document.querySelector('[data-orders-placed-row]') as HTMLElement;
    expect(row.className).toContain('flex-col');
    expect(row.className).toContain('lg:flex-row');
    expect(row.className).not.toMatch(/(^|\s)sm:flex-row/);
    expect(within(pair).getAllByRole('button')).toHaveLength(2);
  });
});

describe('Charter', () => {
  it('lists All charters first, every charter the caller may report on as Name · CODE, and No charter last', async () => {
    render(bar());
    const select = screen.getByLabelText('Charter');
    await waitFor(() => expect(select).toBeEnabled());
    const names = within(select)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(names).toEqual([
      'All charters',
      'Charter Alder · CH-A',
      'Charter Birch',
      'Charter Cedar · CH-C (archived)',
      'No charter',
    ]);
    expect(select).toHaveAccessibleDescription(BOOK_REPORT_CHARTER_HINT);
  });

  it('offers No charter only when such orders exist, or it is the current choice', async () => {
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ ...lists(), noCharter: false }), { status: 200 }),
    );
    const view = render(bar());
    const select = screen.getByLabelText('Charter');
    await waitFor(() => expect(select).toBeEnabled());
    expect(within(select).queryByRole('option', { name: 'No charter' })).toBeNull();
    view.unmount();
    render(bar({ ...Q, charter: 'none' }));
    const again = screen.getByLabelText('Charter');
    await waitFor(() => expect(again).toBeEnabled());
    expect(within(again).getByRole('option', { name: 'No charter' })).toBeInTheDocument();
    expect(again).toHaveValue('none');
  });

  it('names the current charter from the answer while the lists load, never as a bare id', () => {
    fetchMock.mockImplementationOnce(() => new Promise<Response>(() => {}));
    render(bar({ ...Q, charter: CH_A }, { charterEcho: ALDER }));
    const select = screen.getByLabelText('Charter');
    expect(select).toBeDisabled();
    expect(select).toHaveValue(CH_A);
    expect(
      within(select).getByRole('option', { name: 'Charter Alder · CH-A' }),
    ).toBeInTheDocument();
    expect(select.textContent).not.toContain(CH_A);
  });

  it('choosing a charter pushes it on page 1 and keeps the warehouse', async () => {
    render(bar());
    const select = screen.getByLabelText('Charter');
    await waitFor(() => expect(select).toBeEnabled());
    await userEvent.selectOptions(select, CH_B);
    expect(nav.push).toHaveBeenCalledTimes(1);
    const href = reportPushes()[0]!;
    expect(href).toContain(`charter=${CH_B}`);
    expect(href).toContain(`warehouse=${W1}`);
    expect(href).not.toContain('page=');
  });
});

describe('Orders placed and the calendar', () => {
  const MONTH: BookReportRangeEcho = {
    ...ALL_TIME,
    key: 'month',
    from: '2026-09-01',
    to: '2026-09-29',
  };

  it('the two fields show the RESOLVED days of the range on screen, and "Start date" / "End date" for All time', () => {
    const view = render(bar({ ...Q, range: 'month' }, { rangeEcho: MONTH }));
    expect(screen.getByRole('button', { name: 'Start date: Sep 1, 2026' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'End date: Sep 29, 2026' })).toBeInTheDocument();
    view.unmount();
    render(bar());
    expect(screen.getByRole('button', { name: 'Start date' })).toHaveTextContent('Start date');
    expect(screen.getByRole('button', { name: 'End date' })).toHaveTextContent('End date');
  });

  it('choosing Custom range opens the calendar and requests nothing', async () => {
    render(bar());
    await userEvent.selectOptions(screen.getByLabelText('Orders placed'), 'custom');
    const dialog = await screen.findByRole('dialog', { name: 'Orders placed' });
    // Two months side by side from sm, one below it (the test window is
    // 1024 px wide).
    const wide = window.matchMedia('(min-width: 640px)').matches;
    expect(within(dialog).getAllByRole('grid')).toHaveLength(wide ? 2 : 1);
    expect(nav.push).not.toHaveBeenCalled();
    expect(reportFetches()).toEqual([]);
  });

  it('picking two days on the calendar and Apply pushes the range once, on page 1', async () => {
    render(bar());
    await userEvent.click(screen.getByRole('button', { name: 'Start date' }));
    const dialog = await screen.findByRole('dialog', { name: 'Orders placed' });
    // No range and no dates: the calendar opens on the organization's month.
    expect(within(dialog).getByRole('grid', { name: 'September 2026' })).toBeInTheDocument();
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Tuesday, September 1, 2026' }),
    );
    expect(within(dialog).getByText('Choose an end date')).toBeInTheDocument();
    const apply = within(dialog).getByRole('button', { name: 'Apply' });
    expect(apply).toBeDisabled();
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Wednesday, September 30, 2026' }),
    );
    expect(apply).toBeEnabled();
    expect(nav.push).not.toHaveBeenCalled();
    await userEvent.click(apply);
    expect(nav.push).toHaveBeenCalledTimes(1);
    const href = reportPushes()[0]!;
    expect(href).toContain('range=custom&from=2026-09-01&to=2026-09-30');
    expect(href).not.toContain('page=');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('a typed range pushes its two dates on page 1', async () => {
    render(bar());
    await userEvent.selectOptions(screen.getByLabelText('Orders placed'), 'custom');
    const dialog = await screen.findByRole('dialog', { name: 'Orders placed' });
    await userEvent.type(within(dialog).getByLabelText('Start date'), '2026-09-01');
    await userEvent.type(within(dialog).getByLabelText('End date'), '2026-09-28');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    const href = nav.push.mock.calls[0]![0] as string;
    expect(href).toContain('range=custom&from=2026-09-01&to=2026-09-28');
    expect(href).not.toContain('page=');
  });

  // Plan 13.7 step 3: the web page and the phone refuse a custom range in the
  // same core sentence (the phone's dates sheet uses it too).
  it('refuses a range whose first date is after its last in core copy, and changes nothing', async () => {
    render(bar());
    await userEvent.selectOptions(screen.getByLabelText('Orders placed'), 'custom');
    const dialog = await screen.findByRole('dialog', { name: 'Orders placed' });
    const from = within(dialog).getByLabelText('Start date');
    const to = within(dialog).getByLabelText('End date');
    await userEvent.type(from, '2026-09-28');
    await userEvent.type(to, '2026-09-01');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent(BOOK_REPORT_UI.customRangeInvalid);
    expect(BOOK_REPORT_UI.customRangeInvalid).toBe(
      'Choose two real dates between 2000 and 2100, the first on or before the second.',
    );
    expect(from).toHaveAttribute('aria-invalid', 'true');
    expect(to).toHaveAttribute('aria-invalid', 'true');
    expect(nav.push).not.toHaveBeenCalled();
  });

  it('hovering days, typing and paging months never request anything; only Apply does', async () => {
    render(bar());
    await userEvent.click(screen.getByRole('button', { name: 'Start date' }));
    const dialog = await screen.findByRole('dialog', { name: 'Orders placed' });
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Tuesday, September 1, 2026' }),
    );
    await userEvent.hover(
      within(dialog).getByRole('button', { name: 'Thursday, September 17, 2026' }),
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Next month' }));
    expect(within(dialog).getByRole('grid', { name: 'October 2026' })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Previous month' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Previous month' }));
    expect(within(dialog).getByRole('grid', { name: 'August 2026' })).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText('End date'), '2026-12-24');
    // A whole typed day moves the calendar to it.
    expect(within(dialog).getByRole('grid', { name: 'December 2026' })).toBeInTheDocument();
    expect(nav.push).not.toHaveBeenCalled();
    expect(nav.replace).not.toHaveBeenCalled();
    expect(reportFetches()).toEqual([]);
  });

  it('Cancel changes nothing and puts the select back on the range on screen', async () => {
    render(bar({ ...Q, range: 'month' }, { rangeEcho: MONTH }));
    const select = screen.getByLabelText('Orders placed');
    await userEvent.selectOptions(select, 'custom');
    const dialog = await screen.findByRole('dialog', { name: 'Orders placed' });
    // The draft opens on the range's resolved days.
    expect(within(dialog).getByLabelText('Start date')).toHaveValue('2026-09-01');
    expect(within(dialog).getByLabelText('End date')).toHaveValue('2026-09-29');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(select).toHaveValue('month');
    expect(nav.push).not.toHaveBeenCalled();
  });

  it('Escape closes the calendar, changes nothing, and returns focus to the field that opened it', async () => {
    render(bar());
    const start = screen.getByRole('button', { name: 'Start date' });
    await userEvent.click(start);
    const dialog = await screen.findByRole('dialog', { name: 'Orders placed' });
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Tuesday, September 1, 2026' }),
    );
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(start).toHaveFocus();
    expect(nav.push).not.toHaveBeenCalled();
    // Opened again, it starts from the range on screen, not the dropped pick.
    await userEvent.click(start);
    const again = await screen.findByRole('dialog', { name: 'Orders placed' });
    expect(within(again).getByLabelText('Start date')).toHaveValue('');
  });

  it('the End date field opens the calendar picking the end, with focus on that day', async () => {
    render(
      bar(
        { ...Q, range: 'custom', from: '2026-09-01', to: '2026-09-30' },
        { rangeEcho: { ...ALL_TIME, key: 'custom', from: '2026-09-01', to: '2026-09-30' } },
      ),
    );
    await userEvent.click(screen.getByRole('button', { name: 'End date: Sep 30, 2026' }));
    const dialog = await screen.findByRole('dialog', { name: 'Orders placed' });
    await waitFor(() =>
      expect(
        within(dialog).getByRole('button', { name: 'Wednesday, September 30, 2026' }),
      ).toHaveFocus(),
    );
    // Picking a day now moves the END: Sep 1 stays the start.
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Friday, September 18, 2026' }),
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    expect(reportPushes()[0]).toContain('range=custom&from=2026-09-01&to=2026-09-18');
  });

  it('Apply with the range already on screen closes without asking again', async () => {
    const custom: BookReportRangeEcho = {
      ...ALL_TIME,
      key: 'custom',
      from: '2026-09-01',
      to: '2026-09-30',
    };
    render(
      bar({ ...Q, range: 'custom', from: '2026-09-01', to: '2026-09-30' }, { rangeEcho: custom }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Start date: Sep 1, 2026' }));
    const dialog = await screen.findByRole('dialog', { name: 'Orders placed' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(nav.push).not.toHaveBeenCalled();
  });

  it("states the organization's zone in the calendar, and marks the organization's today", async () => {
    render(bar());
    await userEvent.click(screen.getByRole('button', { name: 'Start date' }));
    const dialog = await screen.findByRole('dialog', { name: 'Orders placed' });
    expect(within(dialog).getByText('Times are in America/Los_Angeles.')).toBeInTheDocument();
    expect(
      within(dialog).getByRole('button', { name: 'Tuesday, September 29, 2026' }),
    ).toHaveAttribute('aria-current', 'date');
  });
});

describe('one request per choice: every select in the bar (plan D16)', () => {
  // Each select, the URL key it writes, and the values to arrow through (three
  // values, none of them the committed one).
  const SWEEP: Record<string, { key: string; values: string[] }> = {
    Charter: { key: 'charter', values: [CH_A, CH_B, 'none'] },
    'Orders placed': { key: 'range', values: ['today', 'week', 'month'] },
    Warehouse: { key: 'warehouse', values: [W2, W3, 'all'] },
    Category: { key: 'category', values: [C1, C2, 'none'] },
    Sort: { key: 'sort', values: ['title', 'orders', 'latest'] },
  };

  async function ready() {
    render(bar());
    await waitFor(() => expect(screen.getByLabelText('Warehouse')).toBeEnabled());
  }

  function arrow(select: HTMLElement, values: string[]) {
    for (const value of values) {
      fireEvent.keyDown(select, { key: 'ArrowDown' });
      fireEvent.change(select, { target: { value } });
    }
  }

  it('the sweep covers every select the bar renders (a new select must join it)', async () => {
    await ready();
    const labels = screen
      .getAllByRole('combobox')
      .map((el) => (el as HTMLSelectElement).labels?.[0]?.textContent);
    expect(labels.sort()).toEqual(Object.keys(SWEEP).sort());
  });

  describe.each(Object.entries(SWEEP))('%s', (label, { key, values }) => {
    const last = values[values.length - 1]!;

    it('three arrow keys then leaving the select: one push, with the last value', async () => {
      await ready();
      const select = screen.getByLabelText(label);
      arrow(select, values);
      expect(nav.push).not.toHaveBeenCalled();
      expect(select).toHaveValue(last);
      fireEvent.blur(select);
      expect(nav.push).toHaveBeenCalledTimes(1);
      expect(reportPushes()[0]).toContain(`${key}=${encodeURIComponent(last)}`);
      expect(reportPushes()[0]).not.toContain('page=');
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('three arrow keys then Enter: one push, with the last value', async () => {
      await ready();
      const select = screen.getByLabelText(label);
      arrow(select, values);
      fireEvent.keyDown(select, { key: 'Enter' });
      expect(nav.push).toHaveBeenCalledTimes(1);
      expect(reportPushes()[0]).toContain(`${key}=${encodeURIComponent(last)}`);
      fireEvent.blur(select);
      expect(nav.push).toHaveBeenCalledTimes(1);
    });

    it(`three arrow keys then ${COMMITTED_SELECT_IDLE_MS} ms without a key: one push`, async () => {
      await ready();
      const select = screen.getByLabelText(label);
      arrow(select, values);
      expect(nav.push).not.toHaveBeenCalled();
      await waitFor(() => expect(nav.push).toHaveBeenCalledTimes(1), { timeout: 3000 });
      expect(reportPushes()[0]).toContain(`${key}=${encodeURIComponent(last)}`);
      // Nothing more arrives later.
      await new Promise((r) => setTimeout(r, COMMITTED_SELECT_IDLE_MS + 100));
      expect(nav.push).toHaveBeenCalledTimes(1);
    }, 15000);

    it('arrowing away and back to the committed value pushes nothing', async () => {
      await ready();
      const select = screen.getByLabelText(label) as HTMLSelectElement;
      const committed = select.value;
      arrow(select, [values[0]!, committed]);
      fireEvent.blur(select);
      expect(nav.push).not.toHaveBeenCalled();
    });

    it('a pointer choice pushes at once', async () => {
      await ready();
      const select = screen.getByLabelText(label);
      fireEvent.pointerDown(select);
      fireEvent.change(select, { target: { value: values[0] } });
      expect(nav.push).toHaveBeenCalledTimes(1);
      expect(reportPushes()[0]).toContain(`${key}=${encodeURIComponent(values[0]!)}`);
    });
  });

  it('arrowing past Custom range on the date select opens no calendar', async () => {
    await ready();
    const select = screen.getByLabelText('Orders placed');
    arrow(select, ['custom', 'year']);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.blur(select);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(reportPushes()).toHaveLength(1);
    expect(reportPushes()[0]).toContain('range=year');
  });

  it('Custom range chosen from the keyboard (Enter) opens the calendar and pushes nothing', async () => {
    await ready();
    const select = screen.getByLabelText('Orders placed');
    arrow(select, ['custom']);
    fireEvent.keyDown(select, { key: 'Enter' });
    expect(await screen.findByRole('dialog', { name: 'Orders placed' })).toBeInTheDocument();
    expect(nav.push).not.toHaveBeenCalled();
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
          charterEcho={null}
          rangeEcho={ALL_TIME}
          today="2026-09-29"
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

  it('a chosen charter, then a date Apply: both are in the URL', async () => {
    render(page());
    const charter = screen.getByLabelText('Charter');
    await waitFor(() => expect(charter).toBeEnabled());
    await userEvent.selectOptions(charter, CH_A);
    expect(charter).toHaveValue(CH_A);
    await userEvent.selectOptions(screen.getByLabelText('Orders placed'), 'custom');
    const dialog = await screen.findByRole('dialog', { name: 'Orders placed' });
    await userEvent.type(within(dialog).getByLabelText('Start date'), '2026-09-01');
    await userEvent.type(within(dialog).getByLabelText('End date'), '2026-09-30');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    const href = nav.push.mock.calls.at(-1)![0] as string;
    expect(href).toContain(`charter=${CH_A}`);
    expect(href).toContain('range=custom&from=2026-09-01&to=2026-09-30');
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
