import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { classicDom, classicStructure, glassOnlyCount } from '@/test/classic-dom';

/**
 * CLASSIC IS SACRED (Liquid Glass stage 4, insights lane): the overlays the
 * reports open. Each is portalled out of its page, so Liquid Glass reaches
 * it only through the inert role hooks written on it (data-glass-role, read
 * by pages/insights.css and pages/reports.css under
 * :root[data-appearance="liquid-glass"]). With those stripped, as the
 * classic proof strips them (src/test/classic-dom.ts), each overlay must
 * render exactly the DOM pinned in __classic__/ from the code BEFORE the
 * hooks were added, under the `off` rollout and under `default`, with no
 * glass-only element and no Classic element moved among its siblings:
 *   - every report's PDF menu, plain and as Book Order Totals' Export
 *     (labels and the covers note);
 *   - the charter selector on Inventory valuation, closed and open;
 *   - Book Order Totals' Orders placed range, its Status choice and the
 *     orders behind a total.
 *
 * Class tokens are sorted before comparing, as the lab comparison sorts
 * them (DECISIONS.md, CLASS-ORDER NORMALISATION).
 */

const nav = vi.hoisted(() => ({
  params: new URLSearchParams(),
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => nav.params,
  useRouter: () => ({
    push: nav.push,
    replace: nav.replace,
    refresh: nav.refresh,
    prefetch: vi.fn(),
  }),
  usePathname: () => '/dashboard/reports/book-order-totals',
}));

import {
  DEFAULT_BOOK_REPORT_QUERY,
  bookReportStatusLabels,
  type BookReportQuery,
  type BookReportRangeEcho,
} from '@stockpilot/core';

import {
  ALDER,
  BIRCH,
  CEDAR,
  ITEM_A,
  ITEM_B,
  ORG,
  USER,
  W1,
  optionsResponse,
  ordersJson,
} from './book-order-totals/__fixtures__/answers';
import { BookReportFilterBar } from './book-order-totals/filter-bar';
import { __resetBookReportOptionsForTests } from './book-order-totals/options';
import { BookOrdersDrawer } from './book-order-totals/orders-drawer';
import { OrdersPlacedControl } from './book-order-totals/orders-placed-control';
import { BookReportNavigationProvider } from './book-order-totals/report-navigation';
import { CharterFilterSelect } from './charter-filter-select';
import { PdfDownloadDropdown } from './pdf-download-dropdown';

const LABELS = bookReportStatusLabels(null);
const ALL_TIME: BookReportRangeEcho = {
  key: 'all',
  from: null,
  to: null,
  timeZone: 'America/Los_Angeles',
  timeZoneFallback: false,
};
const QUERY: BookReportQuery = {
  ...DEFAULT_BOOK_REPORT_QUERY,
  statusGroups: [...DEFAULT_BOOK_REPORT_QUERY.statusGroups],
  warehouse: 'all',
};
const CHARTERS = [
  { id: '0e000000-0000-4000-8000-00000000c0a1', name: 'Example Academy', code: 'EXA' },
  { id: '0e000000-0000-4000-8000-00000000c0a2', name: 'Sample Prep', code: null },
];

const fetchMock = vi.fn();

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetBookReportOptionsForTests();
  nav.params = new URLSearchParams();
  fetchMock.mockImplementation(async (url: unknown) =>
    String(url).endsWith('/options')
      ? json(
          optionsResponse({
            warehouses: [{ id: W1, name: 'North', status: 'active' }],
            categories: [],
            charters: [ALDER, BIRCH, CEDAR],
            noCharter: true,
          }),
        )
      : json(ordersJson()),
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** Sorts the tokens of every class attribute (see above). */
function sortClassTokens(dom: string): string {
  return dom.replace(
    /\bclass="([^"]*)"/gu,
    (_, value: string) => `class="${value.split(/\s+/u).filter(Boolean).sort().join(' ')}"`,
  );
}

type Opened = () => Promise<Element>;

const openPdfPlain: Opened = async () => {
  render(<PdfDownloadDropdown baseUrl="/api/reports/x/pdf?days=30" />);
  await userEvent.click(screen.getByRole('button', { name: 'PDF' }));
  return screen.findByRole('menu');
};

const openPdfExport: Opened = async () => {
  render(
    <PdfDownloadDropdown
      baseUrl="/api/v1/reports/book-order-totals/export?format=pdf&warehouse=all"
      labels={{ withImages: 'PDF with covers', withoutImages: 'PDF without covers' }}
      note="Covers for the first 500 books; every row and total is included."
    />,
  );
  await userEvent.click(screen.getByRole('button', { name: 'PDF' }));
  return screen.findByRole('menu');
};

const openCharterClosed: Opened = async () => {
  render(<CharterFilterSelect charters={CHARTERS} current={null} />);
  return screen.getByRole('combobox', { name: 'Filter by charter' });
};

const openCharterOpen: Opened = async () => {
  render(<CharterFilterSelect charters={CHARTERS} current={null} />);
  const trigger = screen.getByRole('combobox', { name: 'Filter by charter' });
  trigger.focus();
  await userEvent.keyboard('{Enter}');
  return screen.findByRole('listbox');
};

const openDateRange: Opened = async () => {
  render(
    <OrdersPlacedControl
      query={QUERY}
      rangeEcho={ALL_TIME}
      today="2026-09-29"
      onChange={vi.fn()}
    />,
  );
  await userEvent.click(screen.getByRole('button', { name: 'Start date' }));
  return screen.findByRole('dialog', { name: 'Orders placed' });
};

const openStatus: Opened = async () => {
  const query: BookReportQuery = { ...QUERY, warehouse: W1 };
  render(
    <BookReportNavigationProvider query={query}>
      <BookReportFilterBar
        query={query}
        organizationId={ORG}
        userId={USER}
        statusLabels={LABELS}
        warehouseEcho={{ id: W1, name: 'North', status: 'active' }}
        categoryEcho={null}
        charterEcho={null}
        rangeEcho={ALL_TIME}
        today="2026-09-29"
        viewNow={null}
      />
    </BookReportNavigationProvider>,
  );
  await userEvent.click(screen.getByRole('button', { name: /^Status/ }));
  const group = await screen.findByRole('group', { name: 'Status' });
  return group.closest('[data-radix-popper-content-wrapper] > *') ?? group.parentElement!;
};

const openDrawer: Opened = async () => {
  nav.params = new URLSearchParams(`view=${ITEM_A}`);
  render(
    <BookOrdersDrawer
      organizationId={ORG}
      userId={USER}
      query={QUERY}
      rangeEcho={{ key: QUERY.range, from: QUERY.from, to: QUERY.to }}
      statusLabels={LABELS}
      titles={{ [ITEM_A]: 'Book A', [ITEM_B]: 'Book B' }}
    />,
  );
  const dialog = await screen.findByRole('dialog');
  await waitFor(() =>
    expect(within(dialog).getAllByRole('columnheader').length).toBeGreaterThan(0),
  );
  return dialog;
};

const OVERLAYS: Array<[name: string, open: Opened]> = [
  ['pdf-menu', openPdfPlain],
  ['pdf-menu-export', openPdfExport],
  ['charter-select', openCharterClosed],
  ['charter-select-open', openCharterOpen],
  ['bot-date-range', openDateRange],
  ['bot-status', openStatus],
  ['bot-orders-drawer', openDrawer],
];

/** The whole document body (the page and its portalled overlay), normalised. */
async function classicOf(rollout: 'off' | 'default', open: Opened) {
  vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
  await open();
  const out = {
    dom: sortClassTokens(classicDom(document.body)),
    structure: classicStructure(document.body),
    glassOnly: glassOnlyCount(document.body),
  };
  cleanup();
  __resetBookReportOptionsForTests();
  return out;
}

describe('report overlays: the Classic DOM is the pinned one', () => {
  for (const [name, open] of OVERLAYS) {
    it(`${name}: off and default normalise to the pinned DOM`, async () => {
      const off = await classicOf('off', open);
      const glassBuild = await classicOf('default', open);
      expect(off.glassOnly, 'no glass-only part under off').toBe(0);
      expect(glassBuild.dom, 'default normalises to the off DOM').toBe(off.dom);
      expect(glassBuild.structure, 'default moves no Classic element').toBe(off.structure);
      await expect(off.dom).toMatchFileSnapshot(`./__classic__/overlays.${name}.txt`);
    });
  }
});
