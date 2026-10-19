import { render, screen, within } from '@testing-library/react';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The stock movement summary after the redesign: the range is a segmented
 * control in the header, with the report's own strict list (7 / 30 / 90,
 * default 30, any other value read as 30), the exports carry the range, and
 * the By movement type table prints the raw movement_type codes the CSV and
 * PDF print (CONFLICTS RP9).
 */

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard/reports/stock-movements',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/reports/report-page-gate', () => ({ reportPageGate: vi.fn(async () => null) }));
vi.mock('@/components/reports/pdf-download-dropdown', () => ({
  PdfDownloadDropdown: ({ baseUrl }: { baseUrl: string }) => (
    <span data-testid="pdf" data-base-url={baseUrl} />
  ),
}));
const movementSummary = vi.hoisted(() => vi.fn());
vi.mock('@/server/services/reports', () => ({
  ReportsService: { forCurrentUser: vi.fn(async () => ({ movementSummary })) },
}));

import StockMovementsReportPage from './page';

/** Render a server tree: await every async component in it, then hand the rest to React. */
async function resolveServer(node: React.ReactNode): Promise<React.ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveServer));
  if (!React.isValidElement(node)) return node;
  const el = node as React.ReactElement<Record<string, unknown>>;
  if (typeof el.type === 'function' && el.type.constructor.name === 'AsyncFunction') {
    return resolveServer(await (el.type as (p: unknown) => Promise<React.ReactNode>)(el.props));
  }
  const props: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(el.props)) {
    props[key] =
      React.isValidElement(value) || Array.isArray(value)
        ? await resolveServer(value as React.ReactNode)
        : value;
  }
  return React.cloneElement(el, props);
}

async function renderPage(days?: string) {
  const el = await StockMovementsReportPage({
    searchParams: Promise.resolve(days === undefined ? {} : { days }),
  });
  render(<>{await resolveServer(el)}</>);
}

beforeEach(() => {
  vi.clearAllMocks();
  movementSummary.mockResolvedValue({
    rangeDays: 30,
    totalMovements: 5,
    byType: [
      { movementType: 'receive_po', count: 3, totalQty: 40 },
      { movementType: 'adjust', count: 2, totalQty: 4 },
    ],
    topMovers: [
      {
        itemId: 'i1',
        sku: 'SKU-1',
        name: 'Hand Sanitizer',
        totalIn: 40,
        totalOut: 4,
        netChange: 36,
        movementCount: 5,
      },
    ],
  });
});

describe('Stock movement summary: range control', () => {
  it('offers 7d, 30d and 90d as links, with 30 the default', async () => {
    await renderPage();
    const range = screen.getByRole('navigation', { name: 'Date range' });
    const links = within(range).getAllByRole('link');
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['7d', '/dashboard/reports/stock-movements?days=7'],
      ['30d', '/dashboard/reports/stock-movements?days=30'],
      ['90d', '/dashboard/reports/stock-movements?days=90'],
    ]);
    expect(within(range).getByRole('link', { name: '30d' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(movementSummary).toHaveBeenCalledWith(30);
    expect(screen.getByText('All stock movements over the last 30 days.')).toBeInTheDocument();
  });

  it('reads a value outside the list as the default', async () => {
    await renderPage('45');
    expect(movementSummary).toHaveBeenCalledWith(30);
    expect(screen.getByRole('link', { name: '30d' })).toHaveAttribute('aria-current', 'page');
  });

  it('marks the chosen range and carries it into both exports', async () => {
    await renderPage('90');
    expect(movementSummary).toHaveBeenCalledWith(90);
    expect(screen.getByRole('link', { name: '90d' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: '7d' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: 'CSV' })).toHaveAttribute(
      'href',
      '/api/reports/stock-movements/csv?days=90',
    );
    expect(screen.getByTestId('pdf')).toHaveAttribute(
      'data-base-url',
      '/api/reports/stock-movements/pdf?days=90',
    );
  });
});

describe('Stock movement summary: figures and tables', () => {
  it('keeps the back link, the title, the three figures and both tables', async () => {
    await renderPage();
    expect(screen.getByRole('link', { name: '← Back to reports' })).toHaveAttribute(
      'href',
      '/dashboard/reports',
    );
    expect(
      screen.getByRole('heading', { level: 1, name: 'Stock movement summary' }),
    ).toBeInTheDocument();
    for (const label of ['Total movements', 'Movement types', 'Items affected']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByRole('heading', { name: 'By movement type' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Top movers' })).toBeInTheDocument();
  });

  it('prints the raw movement type codes, as the exports do', async () => {
    await renderPage();
    expect(screen.getByText('receive_po')).toHaveAttribute('data-movement-type', 'receive_po');
    expect(screen.getByText('adjust')).toBeInTheDocument();
  });

  it('keeps the empty sentences', async () => {
    movementSummary.mockResolvedValue({
      rangeDays: 30,
      totalMovements: 0,
      byType: [],
      topMovers: [],
    });
    await renderPage();
    expect(screen.getByText('No movements in this range.')).toBeInTheDocument();
    expect(screen.getByText('No items moved in this range.')).toBeInTheDocument();
  });
});
