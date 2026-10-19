import { render, screen, within } from '@testing-library/react';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Velocity classes after the redesign: the days picker keeps its own options
 * (30 / 60 / 90 / 180 / 365) while the URL still accepts and clamps 7..365
 * (default 90); the class chips keep their letters and the class lines; the
 * Item cell is the one real drill-down, an IntentLink (no viewport prefetch
 * for a table of rows).
 */

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard/reports/velocity-class',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
const linkProps = vi.hoisted(() => [] as Array<{ href: string; prefetch: unknown }>);
vi.mock('next/link', () => ({
  default: ({
    href,
    prefetch,
    scroll: _scroll,
    children,
    ...rest
  }: { href: string; prefetch?: unknown; scroll?: unknown; children: React.ReactNode } & Record<
    string,
    unknown
  >) => {
    linkProps.push({ href, prefetch });
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  },
}));
vi.mock('@/lib/reports/report-page-gate', () => ({ reportPageGate: vi.fn(async () => null) }));
vi.mock('@/components/reports/pdf-download-dropdown', () => ({
  PdfDownloadDropdown: ({ baseUrl }: { baseUrl: string }) => (
    <span data-testid="pdf" data-base-url={baseUrl} />
  ),
}));
const velocityClass = vi.hoisted(() => vi.fn());
vi.mock('@/server/services/reports', () => ({
  ReportsService: { forCurrentUser: vi.fn(async () => ({ velocityClass })) },
}));

import VelocityClassPage from './page';

async function renderPage(days?: string) {
  const el = (await VelocityClassPage({
    searchParams: Promise.resolve(days === undefined ? {} : { days }),
  })) as React.ReactElement;
  render(el);
}

beforeEach(() => {
  vi.clearAllMocks();
  linkProps.length = 0;
  velocityClass.mockResolvedValue({
    rangeDays: 90,
    totalValueOut: 1234.5,
    summary: { A: 1, B: 0, C: 0, D: 1 },
    rows: [
      {
        itemId: 'item-a',
        sku: 'SKU-A',
        name: 'Hand Sanitizer',
        warehouseName: 'North',
        categoryName: null,
        quantityOnHand: 12,
        unitCost: 2,
        unitsOut: 40,
        valueOut: 80,
        lastOutAt: null,
        velocityClass: 'A',
      },
      {
        itemId: 'item-d',
        sku: 'SKU-D',
        name: 'Old Poster',
        warehouseName: null,
        categoryName: 'Print',
        quantityOnHand: 3,
        unitCost: 1,
        unitsOut: 0,
        valueOut: 0,
        lastOutAt: null,
        velocityClass: 'D',
      },
    ],
  });
});

describe('Velocity classes: days picker and URL rule', () => {
  it('offers the five options with 90 days the default', async () => {
    await renderPage();
    const range = screen.getByRole('navigation', { name: 'Date range' });
    expect(
      within(range)
        .getAllByRole('link')
        .map((a) => a.getAttribute('href')),
    ).toEqual([
      '/dashboard/reports/velocity-class?days=30',
      '/dashboard/reports/velocity-class?days=60',
      '/dashboard/reports/velocity-class?days=90',
      '/dashboard/reports/velocity-class?days=180',
      '/dashboard/reports/velocity-class?days=365',
    ]);
    expect(within(range).getByRole('link', { name: '90d' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(velocityClass).toHaveBeenCalledWith(90);
  });

  it('still clamps the URL to 7..365, with no option shown as current off the list', async () => {
    await renderPage('3');
    expect(velocityClass).toHaveBeenCalledWith(7);
    expect(screen.getByRole('link', { name: 'CSV' })).toHaveAttribute(
      'href',
      '/api/reports/velocity-class/csv?days=7',
    );
    const range = screen.getByRole('navigation', { name: 'Date range' });
    for (const link of within(range).getAllByRole('link')) {
      expect(link).not.toHaveAttribute('aria-current');
    }
  });

  it('clamps a long window to 365', async () => {
    await renderPage('9999');
    expect(velocityClass).toHaveBeenCalledWith(365);
    expect(screen.getByTestId('pdf')).toHaveAttribute(
      'data-base-url',
      '/api/reports/velocity-class/pdf?days=365',
    );
  });
});

describe('Velocity classes: figures and rows', () => {
  it('keeps the class figures with their lines and the value-out line', async () => {
    await renderPage();
    for (const line of [
      'A · top 80% of value',
      'B · next 15%',
      'C · bottom 5%',
      'D · dead stock',
    ]) {
      expect(screen.getByText(line)).toBeInTheDocument();
    }
    for (const label of ['A items', 'B items', 'C items', 'Dead (D)']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByText('Total value moved out · last 90 days:')).toBeInTheDocument();
  });

  it('prints each row class as its letter', async () => {
    await renderPage();
    const rowA = screen.getByRole('row', { name: /Hand Sanitizer/ });
    expect(within(rowA).getByText('A')).toHaveAttribute('data-velocity-class', 'A');
    const rowD = screen.getByRole('row', { name: /Old Poster/ });
    expect(within(rowD).getByText('D')).toHaveAttribute('data-velocity-class', 'D');
    expect(within(rowA).getByText('Uncategorized')).toBeInTheDocument();
  });

  it('links each item to its own page without prefetching every row', async () => {
    await renderPage();
    expect(screen.getByRole('link', { name: /Hand Sanitizer/ })).toHaveAttribute(
      'href',
      '/dashboard/inventory/item-a',
    );
    const rows = linkProps.filter((l) => l.href.startsWith('/dashboard/inventory/'));
    expect(rows.map((l) => l.href)).toEqual([
      '/dashboard/inventory/item-a',
      '/dashboard/inventory/item-d',
    ]);
    for (const row of rows) expect(row.prefetch).toBe(false);
  });

  it('keeps the empty sentence', async () => {
    velocityClass.mockResolvedValue({
      rangeDays: 90,
      totalValueOut: 0,
      summary: { A: 0, B: 0, C: 0, D: 0 },
      rows: [],
    });
    await renderPage();
    expect(screen.getByText('No items in this org yet.')).toBeInTheDocument();
  });
});
