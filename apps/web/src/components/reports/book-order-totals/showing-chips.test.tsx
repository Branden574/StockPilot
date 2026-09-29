import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The Showing chips, Clear filters and "Books ordered by charter" build their
// links from the LATEST REQUESTED query (plan trap 23), while their words come
// from the answer on screen. The router is mocked, so a pushed URL never
// lands: exactly the window in which someone removes a chip while an earlier
// change is still loading.

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

import { ALDER, CH_A, CH_B, ORG, USER, W1, optionsResponse } from './__fixtures__/answers';
import { BookReportByCharter } from './by-charter';
import { withBookReportFilter } from './hrefs';
import { __resetBookReportOptionsForTests, loadBookReportOptions } from './options';
import { BookReportNavigationProvider, useBookReportNavigation } from './report-navigation';
import { BookReportShowingBlock, type BookReportShowingEchoes } from './showing-block';

const labels = bookReportStatusLabels(null);

/** A query with a charter, custom dates, a search and a sort, on page 2. */
const RENDERED: BookReportQuery = {
  ...DEFAULT_BOOK_REPORT_QUERY,
  statusGroups: [...DEFAULT_BOOK_REPORT_QUERY.statusGroups],
  charter: CH_A,
  range: 'custom',
  from: '2026-09-01',
  to: '2026-09-30',
  warehouse: 'all',
  q: 'Outsiders',
  sort: 'title',
  page: 2,
};

const ECHOES: BookReportShowingEchoes = {
  range: { key: 'custom', from: '2026-09-01', to: '2026-09-30' },
  summary: { firstOrderDate: '2026-09-02', lastOrderDate: '2026-09-28' },
  filters: {
    warehouse: null,
    category: null,
    uncategorized: false,
    charter: ALDER,
    noCharter: false,
  },
  warehouse: { source: 'all' },
};

/** Stands for any control that asked for a new query (a charter select). */
function Ask({ next, label }: { next: BookReportQuery; label: string }) {
  const { go } = useBookReportNavigation();
  return (
    <button type="button" onClick={() => go(next)}>
      {label}
    </button>
  );
}

function lastPush(): string {
  return String(nav.push.mock.calls.at(-1)![0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetBookReportOptionsForTests();
});

describe('Showing chips', () => {
  function showing(query: BookReportQuery = RENDERED) {
    return (
      <BookReportNavigationProvider query={query}>
        <Ask next={withBookReportFilter(query, { charter: CH_B })} label="Choose Birch" />
        <BookReportShowingBlock
          echoes={ECHOES}
          query={query}
          statusLabels={labels}
          organizationId={ORG}
          userId={USER}
        />
      </BookReportNavigationProvider>
    );
  }

  it('removing the dates while a charter change is loading keeps the NEW charter', async () => {
    render(showing());
    await userEvent.click(screen.getByRole('button', { name: 'Choose Birch' }));
    expect(lastPush()).toContain(`charter=${CH_B}`);
    // The answer has not landed: the chips still describe the answer on
    // screen (Charter Alder)...
    expect(screen.getByText('Charter: Charter Alder · CH-A')).toBeInTheDocument();
    // ...but removing one builds from what was last asked for.
    await userEvent.click(screen.getByRole('link', { name: 'Remove date filter' }));
    const href = lastPush();
    expect(href).toContain(`charter=${CH_B}`);
    expect(href).not.toContain(CH_A);
    expect(href).not.toContain('range=');
    expect(href).toContain('q=Outsiders');
    expect(href).not.toContain('page=');
  });

  it('Clear filters, while a change is loading, keeps only the sort: the NEW sort', async () => {
    render(
      <BookReportNavigationProvider query={RENDERED}>
        <Ask next={withBookReportFilter(RENDERED, { sort: 'orders' })} label="Sort by orders" />
        <BookReportShowingBlock
          echoes={ECHOES}
          query={RENDERED}
          statusLabels={labels}
          organizationId={ORG}
          userId={USER}
        />
      </BookReportNavigationProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Sort by orders' }));
    await userEvent.click(screen.getByRole('link', { name: 'Clear filters' }));
    expect(lastPush()).toBe('/dashboard/reports/book-order-totals?sort=orders');
  });

  it('each remove control is a real link at least 24 px square, named for its filter', () => {
    render(showing());
    for (const name of ['Remove charter filter', 'Remove date filter', 'Remove search filter']) {
      const link = screen.getByRole('link', { name });
      expect(link.tagName).toBe('A');
      expect(link).toHaveClass('h-6', 'w-6');
      expect(link.getAttribute('href')).toMatch(/^\/dashboard\/reports\/book-order-totals/);
    }
  });

  it('names a charter with the same label the Charter select uses once the lists are loaded', async () => {
    // Two charters named alike with no code: core tells them apart by id.
    const twin = {
      id: '0e000000-0000-4000-8000-0000000000b9',
      name: 'Charter Alder',
      code: null,
      status: 'active',
    };
    const alder = { ...ALDER, code: null };
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(optionsResponse({ charters: [alder, twin] })), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(
      <BookReportNavigationProvider query={RENDERED}>
        <BookReportShowingBlock
          echoes={{ ...ECHOES, filters: { ...ECHOES.filters, charter: alder } }}
          query={RENDERED}
          statusLabels={labels}
          organizationId={ORG}
          userId={USER}
        />
      </BookReportNavigationProvider>,
    );
    // Before the lists: the answer's own echo.
    expect(screen.getByRole('status')).toHaveTextContent('Charter Alder·, Sep 1 – Sep 30, 2026');
    await loadBookReportOptions(ORG, USER);
    // (These fixture ids share their first 8 characters, so core writes the
    // whole id.)
    expect(await screen.findByText(`Charter: Charter Alder (id ${CH_A})`)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(`Charter Alder (id ${CH_A})`);
    vi.unstubAllGlobals();
  });
});

describe('Books ordered by charter', () => {
  it('each row applies its charter from the query last asked for, on page 1', async () => {
    const all: BookReportQuery = { ...RENDERED, charter: 'all' };
    render(
      <BookReportNavigationProvider query={all}>
        <Ask next={withBookReportFilter(all, { warehouse: W1 })} label="Choose North" />
        <BookReportByCharter
          rows={[
            {
              id: CH_A,
              name: 'Charter Alder',
              code: 'CH-A',
              status: 'active',
              copies: '7',
              orders: 1,
            },
            { id: null, name: null, code: null, status: null, copies: '3', orders: 1 },
          ]}
          summary={{ copies: '10', orders: 2, unresolved: { entries: 0 } }}
          query={all}
          organizationId={ORG}
          userId={USER}
        />
      </BookReportNavigationProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Choose North' }));
    const box = document.querySelector('[data-by-charter]') as HTMLElement;
    await userEvent.click(within(box).getByText('Books ordered by charter'));
    await userEvent.click(within(box).getByRole('link', { name: /^Show only No charter/ }));
    const href = lastPush();
    expect(href).toContain('charter=none');
    expect(href).toContain(`warehouse=${W1}`);
    expect(href).not.toContain('page=');
    expect(
      within(box).getByText('All charters: 10 copies requested in 2 orders.'),
    ).toBeInTheDocument();
  });

  it('with books in other units the copies and orders are stated apart, and the note says so', () => {
    const all: BookReportQuery = { ...RENDERED, charter: 'all' };
    render(
      <BookReportNavigationProvider query={all}>
        <BookReportByCharter
          rows={[
            {
              id: CH_A,
              name: 'Charter Alder',
              code: 'CH-A',
              status: 'active',
              copies: '7',
              orders: 2,
            },
          ]}
          summary={{ copies: '7', orders: 2, unresolved: { entries: 1 } }}
          query={all}
          organizationId={ORG}
          userId={USER}
        />
      </BookReportNavigationProvider>,
    );
    const box = document.querySelector('[data-by-charter]') as HTMLElement;
    expect(within(box).getByText('7 copies · 2 orders')).toBeInTheDocument();
    expect(
      within(box).getByText('Copies in single-copy units only, as in Total books ordered.'),
    ).toBeInTheDocument();
  });
});
