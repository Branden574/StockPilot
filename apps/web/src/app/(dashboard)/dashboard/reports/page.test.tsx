import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The Reports hub lists Book Order Totals only where both modules it reads
// (Orders and Books) are on; its page checks both again.

const modules = vi.hoisted(() => ({ on: new Set<string>(['orders', 'books']) }));

vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'manager',
    permissions: undefined,
  })),
}));
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
}));
vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: vi.fn(async (id: string) => ({ enabled: modules.on.has(id), canManage: false })),
}));
vi.mock('@/components/onboarding/page-tour', () => ({ PageTour: () => null }));
vi.mock('@/components/reports/pdf-download-dropdown', () => ({ PdfDownloadDropdown: () => null }));

import ReportsPage from './page';

beforeEach(() => {
  vi.clearAllMocks();
  modules.on = new Set(['orders', 'books']);
});

describe('Reports hub: Book Order Totals card', () => {
  it('is listed with its description where Orders and Books are both on', async () => {
    render(await ReportsPage());
    const card = screen.getByRole('link', { name: /Book Order Totals/ });
    expect(card).toHaveAttribute('href', '/dashboard/reports/book-order-totals');
    expect(card).toHaveTextContent(
      'Book covers, quantities requested, and the orders behind each total.',
    );
  });

  it.each([[['orders']], [['books']], [[]]])('is not listed with only %j on', async (on) => {
    modules.on = new Set(on);
    render(await ReportsPage());
    expect(screen.queryByRole('link', { name: /Book Order Totals/ })).toBeNull();
  });

  it('no longer claims every report exports to CSV', async () => {
    render(await ReportsPage());
    expect(screen.queryByText(/exportable to CSV/)).toBeNull();
  });
});

describe('Reports hub: every card follows the modules its report reads', () => {
  const ALL = ['orders', 'books', 'bundles', 'purchase_orders', 'lot_serial'];

  it('lists every report where every module is on', async () => {
    modules.on = new Set(ALL);
    render(await ReportsPage());
    for (const name of [
      /Bundle activity/,
      /Bundle shortages/,
      /Supplier scorecard/,
      /Item cost history/,
      /Aging & expiry/,
      /Recall \/ lot trace/,
      /Inventory valuation/,
    ]) {
      expect(screen.getByRole('link', { name })).toBeInTheDocument();
    }
  });

  it('hides the two bundle reports when Bundles is off (their pages and data paths refuse too)', async () => {
    modules.on = new Set(ALL.filter((m) => m !== 'bundles'));
    render(await ReportsPage());
    expect(screen.queryByRole('link', { name: /Bundle activity/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /Bundle shortages/ })).toBeNull();
    expect(screen.getByRole('link', { name: /Supplier scorecard/ })).toBeInTheDocument();
  });

  it('hides the supplier scorecard and item cost history when Purchase orders is off', async () => {
    modules.on = new Set(ALL.filter((m) => m !== 'purchase_orders'));
    render(await ReportsPage());
    expect(screen.queryByRole('link', { name: /Supplier scorecard/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /Item cost history/ })).toBeNull();
    expect(screen.getByRole('link', { name: /Bundle activity/ })).toBeInTheDocument();
  });

  it('keeps the core reports whatever is off', async () => {
    modules.on = new Set();
    render(await ReportsPage());
    for (const name of [
      /Inventory valuation/,
      /Stock movement summary/,
      /Reorder forecast/,
      /Shrinkage/,
      /Velocity classes/,
      /Dead stock/,
    ]) {
      expect(screen.getByRole('link', { name })).toBeInTheDocument();
    }
  });
});
