import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MovementsBreakdownWidget } from './movements-breakdown';
import { NeedsAttentionWidget } from './needs-attention';
import { RecentActivityWidget } from './recent-activity';
import { ShiftCommandWidget } from './shift-command';
import { StatRowWidget } from './stat-row';
import { TrendsHeaderWidget } from './trends-header';
import type { DashboardWidgetProps, RecentMovement } from './types';

/**
 * The Overview widgets after the redesign (P3.1): every word, link, figure and
 * state they had, in the reference's look. The look-only details are left to
 * the shared patterns' own tests; these pin what the widgets say and do, and
 * the two contrast fixes handed to P3.1 (HANDOFFS P3.1, from P2.1).
 */

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: any) => (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  ),
}));

// Records the tone each status pill asks the shared Badge for, and renders the
// real Badge, so the pills are checked by their tone and their words, never by
// the Badge's own class names.
const badgeCalls = vi.hoisted(() => [] as Array<{ variant?: string | null; text: string }>);
vi.mock('@/components/ui/badge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/badge')>();
  return {
    ...actual,
    Badge: (props: React.ComponentProps<typeof actual.Badge>) => {
      badgeCalls.push({ variant: props.variant, text: String(props.children) });
      return actual.Badge(props);
    },
  };
});

beforeEach(() => {
  badgeCalls.length = 0;
});

function makeProps(overrides: Partial<DashboardWidgetProps> = {}): DashboardWidgetProps {
  return {
    checklistSteps: [],
    checklistComplete: true,
    attentionItems: [],
    briefingSentence: 'Everything looks healthy.',
    healthRate: 90,
    attentionStockCount: 3,
    outOfStockCount: 1,
    valuePerSku: 532.24,
    movements7d: 52,
    itemCount: 293,
    lowStockCount: 2,
    openPoCount: 12,
    openCycleCount: 0,
    inventoryValue: 156087.72,
    inventoryValueSeries: Array(30).fill(100),
    inventoryValueDelta: { label: '+0.4%', direction: 'up' },
    itemCountSeries: Array(30).fill(5),
    itemCountDelta: { label: '+2.8%', direction: 'up' },
    lowOutSeries: Array(30).fill(0),
    lowOutDelta: { label: '+2', direction: 'down' },
    dailyCounts: Array(30).fill(1),
    movementsToday: 0,
    movementsDelta: { label: '-7', direction: 'down' },
    warehouseFilter: null,
    valueSeries: [],
    warehouses: [],
    barValues: [],
    breakdownRows: [],
    analytics: { valueSeries: {}, byCategory: [], byWarehouse: [], movementBars: [] },
    lowStock: [],
    lowStockTrends: new Map(),
    recentMovements: [],
    ...overrides,
  };
}

function movement(over: Partial<RecentMovement>): RecentMovement {
  return {
    id: 'm1',
    movement_type: 'adjust',
    quantity_change: 0,
    moved_quantity: null,
    created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    reason: null,
    item: { name: 'Index Cards' },
    actor: { fullName: 'Dana Whitcombe' },
    user_id: 'u1',
    ...over,
  };
}

describe('Needs attention', () => {
  const items: DashboardWidgetProps['attentionItems'] = [
    {
      id: 'low-stock',
      title: '28 items at or below reorder point',
      detail: '10 critical · 18 below par. Draft POs before they hit zero.',
      href: '/dashboard/inventory?stock=low&type=all',
      rank: 1,
      tone: 'danger',
    },
    {
      id: 'po-overdue',
      title: '5 overdue purchase orders',
      detail: 'Expected receipt date has passed. Chase your suppliers or update the ETA.',
      href: '/dashboard/purchase-orders?status=overdue',
      rank: 2,
      tone: 'warn',
    },
    {
      id: 'cycle-counts',
      title: '2 cycle counts in progress',
      detail: 'Lines are still open. Post counts to reconcile, or cancel if abandoned.',
      href: '/dashboard/cycle-counts',
      rank: 4,
      tone: 'neutral',
    },
  ];

  it('keeps the briefing sentence and one "Take a look" link per item, in order', () => {
    render(
      <NeedsAttentionWidget
        {...makeProps({
          attentionItems: items,
          briefingSentence: '3 things need attention today.',
        })}
      />,
    );
    expect(screen.getByText('3 things need attention today.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Needs attention' })).toBeInTheDocument();
    const links = screen.getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual(items.map((i) => i.href));
    for (const [i, link] of links.entries()) {
      expect(link).toHaveTextContent(items[i]!.title);
      expect(link).toHaveTextContent(items[i]!.detail);
      expect(link).toHaveTextContent('Take a look');
    }
  });

  // HANDOFFS P3.1 (from P2.1): the warn marker put the on-fill
  // --warning-foreground over a warning tint, 1.48:1 in dark. The row marker is
  // now the reference's 8 px dot in the item's own tone, on the card.
  it('marks each row with a dot in its tone, never text on a tint', () => {
    const { container } = render(
      <NeedsAttentionWidget {...makeProps({ attentionItems: items })} />,
    );
    const dots = Array.from(container.querySelectorAll('[data-slot="attention-dot"]'));
    expect(dots.map((d) => d.closest('a')!.getAttribute('data-tone'))).toEqual([
      'danger',
      'warn',
      'neutral',
    ]);
    expect(dots[0]).toHaveClass('bg-destructive');
    expect(dots[1]).toHaveClass('bg-warning');
    expect(dots[2]).toHaveClass('bg-muted-foreground');
    expect(container.innerHTML).not.toContain('warning-foreground');
    expect(container.innerHTML).not.toMatch(/--warning\)\s*\/\s*0\.18/);
  });

  it('shows the All clear card, with its words, when nothing needs attention', () => {
    const { container } = render(<NeedsAttentionWidget {...makeProps()} />);
    expect(screen.getByText('All clear — nothing needs attention today.')).toBeInTheDocument();
    expect(
      screen.getByText(
        'No low stock, no overdue POs, no pending approvals, no open counts, no orders awaiting signature. The numbers below are just context.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('Most urgent first')).toBeNull();
    // The check is accent page text on the wash, not --accent-foreground.
    expect(container.innerHTML).not.toContain('accent-foreground');
  });
});

describe('Trends header', () => {
  it('keeps the heading and the four readouts with their real figures', () => {
    render(<TrendsHeaderWidget {...makeProps()} />);
    expect(screen.getByRole('heading', { name: '30-day trends' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'Inventory value, on-hand counts, and movement velocity over the last month.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Health').nextElementSibling).toHaveTextContent('90%');
    expect(screen.getByText('Critical').nextElementSibling).toHaveTextContent('1');
    expect(screen.getByText('Avg value / SKU').nextElementSibling).toHaveTextContent('$532.24');
    expect(screen.getByText('Activity (7d)').nextElementSibling).toHaveTextContent('52');
  });
});

describe('Shift command', () => {
  it('keeps the Live pill, the readouts and the five fast paths with their counts', () => {
    render(<ShiftCommandWidget {...makeProps()} />);
    expect(screen.getByRole('complementary')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Shift command' })).toBeInTheDocument();
    expect(screen.getByText('Live')).toBeInTheDocument();
    expect(screen.getByText('Fast paths for the next inventory action.')).toBeInTheDocument();
    expect(screen.getByText('SKUs').nextElementSibling).toHaveTextContent('293');
    expect(screen.getByText('Low').nextElementSibling).toHaveTextContent('2');
    expect(screen.getByText('Out').nextElementSibling).toHaveTextContent('1');
    const hrefs = Object.fromEntries(
      screen.getAllByRole('link').map((a) => [a.textContent, a.getAttribute('href')]),
    );
    expect(hrefs).toEqual({
      'Review low stock3': '/dashboard/inventory?stock=low&type=all',
      'Open purchase orders12': '/dashboard/purchase-orders',
      'Cycle counts in progress': '/dashboard/cycle-counts',
      'Create receiving run': '/dashboard/purchase-orders/new',
      'Open reports': '/dashboard/reports',
    });
  });
});

describe('Key stats', () => {
  it('keeps the four figures, their feet and their deltas', () => {
    const { container } = render(<StatRowWidget {...makeProps()} />);
    const cell = (label: string) =>
      container.querySelector(`[data-key-stat="${label}"]`) as HTMLElement;
    expect(cell('Inventory value')).toHaveTextContent('$156,087.72');
    expect(cell('Inventory value')).toHaveTextContent('vs. 30 days ago');
    expect(cell('Inventory value')).toHaveTextContent('+0.4%');
    expect(cell('Items on hand')).toHaveTextContent('293 active SKUs');
    expect(cell('Low / out of stock')).toHaveTextContent('3');
    expect(cell('Low / out of stock')).toHaveTextContent('1 critical · 2 below par');
    expect(cell('Movements today')).toHaveTextContent('across all locations · last 24h');
    // Each figure keeps its 14-day sparkline.
    expect(container.querySelectorAll('svg path').length).toBeGreaterThanOrEqual(8);
    // Low / out: more is worse, so a rise reads in the destructive direction.
    expect(
      within(cell('Low / out of stock')).getByText('+2').closest('[data-slot="trend-delta"]'),
    ).toHaveAttribute('data-direction', 'down');
  });

  it('names the selected warehouse in the movements foot when the topbar filter is set', () => {
    render(<StatRowWidget {...makeProps({ warehouseFilter: 'wh-1' })} />);
    expect(screen.getByText('in selected warehouse · last 24h')).toBeInTheDocument();
  });
});

describe('Recent activity: low-stock detail', () => {
  const lowStock = [
    {
      id: 'i1',
      name: 'Index Cards 3 x 5',
      sku: 'IDX-3X5-01',
      quantity_on_hand: 0,
      reorder_point: 50,
    },
    {
      id: 'i2',
      name: 'Three-Ring Binder',
      sku: 'BND-1IN-01',
      quantity_on_hand: 83,
      reorder_point: 120,
    },
  ];

  it('keeps the real columns, the item links and View all', () => {
    render(<RecentActivityWidget {...makeProps({ lowStock })} />);
    expect(screen.getByRole('heading', { name: 'Recent activity' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Low-stock detail' })).toBeInTheDocument();
    expect(screen.getByText('Items below reorder point')).toBeInTheDocument();
    expect(screen.getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
      'Item',
      'On hand',
      'Reorder',
      'Coverage',
      '14-day',
      '',
    ]);
    expect(screen.getByRole('link', { name: 'Index Cards 3 x 5' })).toHaveAttribute(
      'href',
      '/dashboard/inventory/i1',
    );
    expect(screen.getByRole('link', { name: 'View all' })).toHaveAttribute(
      'href',
      '/dashboard/inventory?stock=low&type=all',
    );
    const rows = screen.getAllByRole('row').slice(1);
    expect(within(rows[0]!).getByText('IDX-3X5-01')).toBeInTheDocument();
    expect(rows[1]).toHaveTextContent('83');
    expect(rows[1]).toHaveTextContent('120');
    // No photos are read: the swatch is the missing-photo hatch.
    expect(screen.queryAllByRole('img')).toHaveLength(0);
  });

  // HANDOFFS P3.1 (from P2.1): the Low pill painted the on-fill
  // --warning-foreground on a warning tint (1.48:1 in dark). It is now the
  // caution tone of the shared status label (caution text on its wash), and
  // Out the danger tone; the words are unchanged.
  it('draws Low and Out as the caution and danger status labels', () => {
    const { container } = render(<RecentActivityWidget {...makeProps({ lowStock })} />);
    expect(badgeCalls).toEqual([
      { variant: 'destructive', text: 'Out' },
      { variant: 'warning', text: 'Low' },
    ]);
    expect(screen.getByText('Low')).toBeInTheDocument();
    expect(screen.getByText('Out')).toBeInTheDocument();
    expect(container.innerHTML).not.toContain('warning-foreground');
  });

  it('keeps the empty catalog state with its way out, and the quiet line when nothing is low', () => {
    const { rerender } = render(<RecentActivityWidget {...makeProps({ itemCount: 0 })} />);
    expect(screen.getByRole('heading', { name: 'No inventory yet' })).toBeInTheDocument();
    expect(
      screen.getByText('Add your first item to start tracking stock, locations, and movements.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add your first item' })).toHaveAttribute(
      'href',
      '/dashboard/inventory/new',
    );
    rerender(<RecentActivityWidget {...makeProps()} />);
    expect(screen.getByText('Nothing below reorder point. Quiet shift.')).toBeInTheDocument();
  });
});

describe("Recent activity: today's activity", () => {
  it('keeps the type, item, actor, reason, time and the signed change', () => {
    render(
      <RecentActivityWidget
        {...makeProps({
          recentMovements: [
            movement({
              id: 'a',
              movement_type: 'return',
              quantity_change: 5,
              reason: 'Return restock',
            }),
            movement({ id: 'b', movement_type: 'damage', quantity_change: -2, item: null }),
          ],
        })}
      />,
    );
    expect(screen.getByRole('heading', { name: "Today's activity" })).toBeInTheDocument();
    expect(screen.getByText('Live · across all locations')).toBeInTheDocument();
    const [first, second] = screen.getAllByRole('listitem');
    // FX5 (DESIGN-SPEC 6.16 and 6.10): the type prints in the Movements
    // page's words ("Return", "Damage"), no longer the raw code ("return").
    expect(first).toHaveTextContent('Return · Index Cards');
    expect(first).toHaveTextContent('Dana Whitcombe · Return restock · 5 m');
    expect(first).toHaveTextContent('+5');
    expect(second).toHaveTextContent('Damage · Unknown');
    expect(second).toHaveTextContent('-2');
  });

  // FX5 (DESIGN-SPEC 6.16 "the type in its tone at 500", 6.10 movement type
  // tones and words): the type took its colour from the sign of the change
  // and printed the raw code, so Correction read in the accent here and in
  // caution on Movements, and Loss and Damage read grey here and red there.
  it('names and colours each type as the Movements page does, whatever the sign of the change', () => {
    const cases: Array<[type: string, change: number, words: string, tone: string]> = [
      ['receive_po', 10, 'Receive PO', 'text-accent'],
      ['correction', 0.5, 'Correction', 'text-warning'],
      ['adjust', -1, 'Adjust', 'text-warning'],
      ['loss', -5, 'Loss', 'text-destructive'],
      ['damage', -2, 'Damage', 'text-destructive'],
      ['return', 3, 'Return', 'text-accent'],
      ['remove', -4, 'Remove', 'text-[var(--ed-ink-2)]'],
      ['bundle_assembly', 6, 'Bundle assembly', 'text-[var(--ed-ink-2)]'],
    ];
    render(
      <RecentActivityWidget
        {...makeProps({
          recentMovements: cases.map(([type, change], i) =>
            movement({ id: `t${i}`, movement_type: type, quantity_change: change }),
          ),
        })}
      />,
    );
    const rows = screen.getAllByRole('listitem');
    cases.forEach(([type, , words, tone], i) => {
      expect(rows[i]).toHaveAttribute('data-movement-type', type);
      const label = within(rows[i]!).getByText(words);
      expect(label).toHaveClass('font-medium', tone);
      expect(label.className).not.toContain('first-letter:uppercase');
    });
  });

  // FX1 (DESIGN-SPEC 6.16, the activity row's second line: name · time): a
  // movement from a day ago printed "yesterd", because the unit shortening
  // /days?/ also matched inside "yesterday". Units are shortened as whole
  // words only, so the relative words print in full.
  it('prints yesterday, last week and now in full, and shortens only whole unit words', () => {
    const HOUR = 3_600_000;
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
    render(
      <RecentActivityWidget
        {...makeProps({
          recentMovements: [
            movement({ id: 'yesterday', created_at: ago(24 * HOUR) }),
            movement({ id: 'two-days', created_at: ago(48 * HOUR) }),
            movement({ id: 'three-hours', created_at: ago(3 * HOUR) }),
            movement({ id: 'last-week', created_at: ago(7 * 24 * HOUR) }),
            movement({ id: 'now', created_at: ago(0) }),
          ],
        })}
      />,
    );
    const times = screen
      .getAllByRole('listitem')
      .map((li) => within(li).getByText(/Dana Whitcombe/).lastElementChild?.textContent);
    expect(times).toEqual(['yesterday', '2 d', '3 h', 'last week', 'now']);
    expect(screen.queryByText(/yesterd(?!ay)/)).toBeNull();
  });

  it('shows a transfer by the quantity moved, and nothing (never 0) before migration 0231', () => {
    render(
      <RecentActivityWidget
        {...makeProps({
          recentMovements: [
            movement({
              id: 't1',
              movement_type: 'transfer',
              quantity_change: 0,
              moved_quantity: 12,
            }),
            movement({
              id: 't2',
              movement_type: 'transfer',
              quantity_change: 0,
              moved_quantity: null,
            }),
          ],
        })}
      />,
    );
    const [moved, old] = screen.getAllByRole('listitem');
    expect(moved!.lastElementChild).toHaveTextContent(/^12$/);
    expect(old!.textContent).not.toMatch(/\b0\b/);
  });

  it('keeps the empty feed words', () => {
    render(<RecentActivityWidget {...makeProps()} />);
    expect(
      screen.getByText('No movements yet. Adjust stock from any item to see entries here.'),
    ).toBeInTheDocument();
  });
});

describe('Movements breakdown', () => {
  // FX5 (DESIGN-SPEC 6.10, the movement type words): the page now hands the
  // card the Movements page's words ("Bundle assembly", "Receive PO"), not the
  // raw codes ("Bundle_assembly", "Receive_po") that needed a <wbr> after the
  // underscore. The words wrap between words, never inside one; the page's
  // mapping is pinned in dashboard/page.test.tsx.
  it('prints each type in its words, whole, wrapping only between words', () => {
    render(
      <MovementsBreakdownWidget
        {...makeProps({
          barValues: [1, 2, 3],
          breakdownRows: [
            { label: 'Bundle assembly', share: 0.5, val: 10 },
            { label: 'Receive PO', share: 0.5, val: 10 },
          ],
        })}
      />,
    );
    for (const words of ['Bundle assembly', 'Receive PO']) {
      const label = screen.getByText(words);
      expect(label.innerHTML).toBe(words);
      expect(label.querySelector('wbr')).toBeNull();
      expect(label.className).not.toContain('overflow-wrap:anywhere');
    }
    expect(screen.queryByText(/_/)).toBeNull();
  });
});

describe('the redesigned widgets never print informational text in ink 4', () => {
  it('has no --ed-ink-4 text and no heavy shadows', () => {
    const props = makeProps({
      attentionItems: [],
      lowStock: [{ id: 'i1', name: 'A', sku: 'A-1', quantity_on_hand: 1, reorder_point: 5 }],
      recentMovements: [movement({})],
    });
    const { container } = render(
      <>
        <NeedsAttentionWidget {...props} />
        <TrendsHeaderWidget {...props} />
        <ShiftCommandWidget {...props} />
        <StatRowWidget {...props} />
        <RecentActivityWidget {...props} />
      </>,
    );
    expect(container.innerHTML).not.toContain('--ed-ink-4');
    expect(container.innerHTML).not.toMatch(/shadow-\[0_1[04]px/);
  });
});
