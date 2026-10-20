import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Item cost history: the picker, the not-found line, a failed item read, and
 * the selected item's exports, figures and source labels after the redesign.
 */

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard/reports/item-cost-history',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/reports/report-page-gate', () => ({ reportPageGate: vi.fn(async () => null) }));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'manager',
  })),
}));
const itemsRead = vi.hoisted(() => ({
  result: { data: [] as unknown[] | null, error: null as unknown },
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => {
    const chain = {
      from: () => chain,
      select: () => chain,
      eq: () => chain,
      is: () => chain,
      order: () => chain,
      limit: async () => itemsRead.result,
    };
    return chain;
  }),
}));
vi.mock('@/components/reports/item-cost-history-search', () => ({
  ItemCostHistorySearch: ({ items }: { items: unknown[] }) => (
    <div data-testid="picker" data-count={items.length} />
  ),
}));
vi.mock('@/components/reports/pdf-download-dropdown', () => ({
  PdfDownloadDropdown: ({ baseUrl }: { baseUrl: string }) => (
    <span data-testid="pdf" data-base-url={baseUrl} />
  ),
}));
vi.mock('@/components/dashboard/charts/cost-trend-island', () => ({
  CostTrendIsland: () => <div data-testid="cost-trend" />,
}));
const itemCostHistoryReport = vi.hoisted(() => vi.fn());
vi.mock('@/server/services/reports', () => ({
  ReportsService: { forCurrentUser: vi.fn(async () => ({ itemCostHistoryReport })) },
}));

import ItemCostHistoryPage from './page';

const ITEM = { id: 'item-1', sku: 'PPR-LTR-01', name: 'Copy Paper 8.5 x 11, Ream' };

async function renderPage(params: Record<string, string>) {
  render(await ItemCostHistoryPage({ searchParams: Promise.resolve(params) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  itemsRead.result = { data: [ITEM], error: null };
  itemCostHistoryReport.mockResolvedValue({
    lastUnitCost: 3.7,
    avgUnitCost: 3.83,
    pointCount: 2,
    series: [
      {
        supplierId: 's1',
        supplierName: 'Fernwood Paper Works',
        points: [
          { date: '2026-07-01T00:00:00Z', unitCost: 3.85, source: 'purchase_order' },
          { date: '2026-08-01T00:00:00Z', unitCost: 3.7, source: 'receipt' },
        ],
      },
    ],
  });
});

describe('Item cost history', () => {
  it('shows the picker with its explanation when no item is chosen', async () => {
    await renderPage({});
    expect(
      screen.getByRole('heading', { level: 1, name: 'Item cost history' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Select an item to see its unit cost over time, sourced from PO orders and posted receipts.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId('picker')).toHaveAttribute('data-count', '1');
  });

  it('keeps the not-found line for an item outside the organisation', async () => {
    await renderPage({ itemId: 'someone-elses' });
    expect(
      screen.getByText(
        'Item not found or does not belong to your organisation. Select a different item.',
      ),
    ).toBeInTheDocument();
    expect(itemCostHistoryReport).not.toHaveBeenCalled();
  });

  // The read failing used to leave an empty picker and, with an itemId in
  // the URL, the "Item not found" line: no visible reason either way.
  it.each([[{}], [{ itemId: 'item-1' }]])(
    'says the item list failed to load, never an empty picker (%j)',
    async (params) => {
      itemsRead.result = { data: null, error: { code: '42703', message: 'column does not exist' } };
      await renderPage(params);
      expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load your items");
      expect(screen.queryByTestId('picker')).toBeNull();
      expect(screen.queryByText(/Item not found/)).toBeNull();
      expect(itemCostHistoryReport).not.toHaveBeenCalled();
    },
  );

  it('keeps the three exports with the item and date window', async () => {
    await renderPage({ itemId: 'item-1', since: '2026-07-01', until: '2026-09-01' });
    const qs = 'itemId=item-1&since=2026-07-01&until=2026-09-01';
    expect(screen.getByRole('link', { name: 'CSV' })).toHaveAttribute(
      'href',
      `/api/reports/item-cost-history/csv?${qs}`,
    );
    expect(screen.getByRole('link', { name: 'Excel' })).toHaveAttribute(
      'href',
      `/api/reports/item-cost-history/xlsx?${qs}`,
    );
    expect(screen.getByTestId('pdf')).toHaveAttribute(
      'data-base-url',
      `/api/reports/item-cost-history/pdf?${qs}`,
    );
    expect(screen.getByRole('link', { name: 'Clear' })).toHaveAttribute(
      'href',
      '/dashboard/reports/item-cost-history?itemId=item-1',
    );
  });

  it('keeps the date form, the figures, the chart and the observations', async () => {
    await renderPage({ itemId: 'item-1' });
    expect(screen.getByLabelText('From')).toHaveAttribute('name', 'since');
    expect(screen.getByLabelText('To')).toHaveAttribute('name', 'until');
    expect(screen.getByRole('button', { name: 'Apply' })).toHaveAttribute('type', 'submit');
    expect(screen.queryByRole('link', { name: 'Clear' })).toBeNull();
    expect(screen.getByText('2 across 1 supplier')).toBeInTheDocument();
    expect(screen.getByTestId('cost-trend')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'All observations (2)' })).toBeInTheDocument();
    expect(screen.getByText('Receipt')).toBeInTheDocument();
    expect(screen.getByText('PO')).toBeInTheDocument();
  });
});
