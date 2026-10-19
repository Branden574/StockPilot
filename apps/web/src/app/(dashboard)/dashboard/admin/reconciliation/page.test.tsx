import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Reconciliation in the redesign (W-AD-07): the status filter stays in the
 * URL, the totals stay the service's sums over every matching PO, both
 * tables keep their columns and empty words, and each PO keeps its link and
 * a worded status label.
 */

const summary = vi.hoisted(() => vi.fn());
vi.mock('@/server/services/reconciliation', () => ({
  ReconciliationService: { forCurrentUser: async () => ({ summary }) },
}));
const navLabel = vi.hoisted(() => ({ override: null as string | null }));
vi.mock('@/lib/nav-labels', () => ({
  effectiveNavLabel: vi.fn(
    async (_href: string, fallback: string) => navLabel.override ?? fallback,
  ),
}));

import { PoStatusBadge } from '@/components/po/po-status-badge';
import { badgeVariants } from '@/components/ui/badge';

import ReconciliationPage from './page';

// The tone is read from the live Badge recipe (classes all six tones share are
// ignored), as the PO status badge's own test does, so a restyle of the
// recipe cannot break the check.
const TONES = ['default', 'secondary', 'destructive', 'success', 'warning', 'outline'] as const;
function toneOf(el: Element): string {
  const own = new Set(el.className.split(/\s+/));
  const recipes = TONES.map((t) => badgeVariants({ variant: t }).split(/\s+/));
  const shared = recipes.reduce((a, r) => a.filter((c) => r.includes(c)));
  return TONES.filter((_, i) => recipes[i]!.every((c) => shared.includes(c) || own.has(c))).join(
    '|',
  );
}

const DATA = {
  totals: { qtyOrdered: 1200, qtyReceived: 700, qtyOpen: 500 },
  byVendor: [
    {
      supplier_id: 's1',
      supplier_name: 'Acme Paper',
      po_count: 3,
      qty_ordered: 1200,
      qty_received: 700,
      fill_rate_pct: 58,
    },
  ],
  rows: [
    {
      purchase_order_id: 'po-1',
      po_number: 'PO-2038',
      status: 'partially_received',
      supplier_name: 'Acme Paper',
      qty_ordered_total: 1200,
      qty_received_total: 700,
      qty_open_total: 500,
      cost_ordered_total: 2400,
      updated_at: new Date().toISOString(),
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  navLabel.override = null;
  summary.mockResolvedValue(DATA);
});

describe('/dashboard/admin/reconciliation', () => {
  it('reads Open by default, keeps ?vendor= for the service, and marks the current status chip', async () => {
    render(await ReconciliationPage({ searchParams: Promise.resolve({ vendor: 's1' }) }));
    expect(summary).toHaveBeenCalledWith({ status: 'open', vendorId: 's1' });
    expect(screen.getByRole('heading', { level: 1, name: 'Reconciliation' })).toBeInTheDocument();
    const open = screen.getByRole('link', { name: 'Open' });
    expect(open).toHaveAttribute('href', '/dashboard/admin/reconciliation?status=open');
    expect(open).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Closed' })).toHaveAttribute(
      'href',
      '/dashboard/admin/reconciliation?status=closed',
    );
    expect(screen.getByRole('link', { name: 'All' })).not.toHaveAttribute('aria-current');
  });

  it('shows the three totals from the service, the vendor table and the PO table with its link and worded status', async () => {
    render(await ReconciliationPage({ searchParams: Promise.resolve({ status: 'all' }) }));
    expect(summary).toHaveBeenCalledWith({ status: 'all', vendorId: null });
    for (const [label, value] of [
      ['Qty ordered', (1200).toLocaleString()],
      ['Qty received', (700).toLocaleString()],
      ['Qty open', (500).toLocaleString()],
    ] as const) {
      expect(screen.getByText(label)).toBeInTheDocument();
      expect(screen.getAllByText(value).length).toBeGreaterThan(0);
    }
    const [vendors, pos] = screen.getAllByRole('table');
    expect(
      within(vendors!)
        .getAllByRole('columnheader')
        .map((th) => th.textContent),
    ).toEqual(['Vendor', 'POs', 'Ordered', 'Received', 'Fill rate']);
    expect(within(vendors!).getByText('58%')).toBeInTheDocument();
    expect(
      within(pos!)
        .getAllByRole('columnheader')
        .map((th) => th.textContent),
    ).toEqual([
      'PO #',
      'Status',
      'Vendor',
      'Ordered',
      'Received',
      'Open',
      'Cost ordered',
      'Updated',
    ]);
    expect(within(pos!).getByRole('link', { name: 'PO-2038' })).toHaveAttribute(
      'href',
      '/dashboard/purchase-orders/po-1',
    );
    expect(within(pos!).getByText('partially received')).toBeInTheDocument();
    expect(screen.getByText('Purchase orders (all)')).toBeInTheDocument();
  });

  // Look-only expectation (review 1b): each status label takes the tone the PO
  // pages give the same status, so Cancelled reads red here as it does there.
  // The words stay this page's own (the status with its underscores turned
  // into spaces).
  it('draws each PO status on the PO pages’ tone, Cancelled on the destructive tone', async () => {
    const statuses = [
      'draft',
      'expected_inbound',
      'ordered',
      'partially_received',
      'received',
      'cancelled',
    ];
    summary.mockResolvedValueOnce({
      ...DATA,
      rows: statuses.map((status, i) => ({
        ...DATA.rows[0]!,
        purchase_order_id: `po-${i}`,
        po_number: `PO-${i}`,
        status,
      })),
    });
    render(await ReconciliationPage({ searchParams: Promise.resolve({ status: 'all' }) }));
    const pos = screen.getAllByRole('table')[1]!;
    for (const status of statuses) {
      const pill = within(pos).getByText(status.replace(/_/g, ' '));
      const po = render(<PoStatusBadge status={status} />);
      const poPagesTone = toneOf(po.container.firstElementChild!);
      po.unmount();
      expect(toneOf(pill)).toBe(poPagesTone);
    }
    expect(toneOf(within(pos).getByText('cancelled'))).toBe('destructive');
  });

  it('keeps both empty words', async () => {
    summary.mockResolvedValueOnce({
      totals: { qtyOrdered: 0, qtyReceived: 0, qtyOpen: 0 },
      byVendor: [],
      rows: [],
    });
    render(await ReconciliationPage({ searchParams: Promise.resolve({ status: 'closed' }) }));
    expect(screen.getByText('No vendor data yet.')).toBeInTheDocument();
    expect(screen.getByText('No POs in this filter.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Closed' })).toHaveAttribute('aria-current', 'page');
  });

  it('a Settings > Navigation rename reaches the heading', async () => {
    navLabel.override = 'PO balance';
    render(await ReconciliationPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole('heading', { level: 1, name: 'PO balance' })).toBeInTheDocument();
  });
});
