import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * A cycle count's Liquid Glass summary (Cycle-Count-Detail.dc.html, the
 * "Count summary" card): five figures, "Lines that differ" between
 * Uncounted and Net variance, and one wide progress bar under them
 * ("Lines counted", the board's .prog at 8 px). Both are glass-only and
 * stateless: words and a bar drawn from the whole-count summary the page
 * already has (no new read), rendered under opt-in and default and hidden in
 * Classic by styles/liquid-glass/visibility.css, never rendered under off.
 * They sit in the figures' grid between two Classic figures, so no Classic
 * figure changes its place among its siblings (cycle-count-detail
 * .classic-dom.test.tsx); pages/counts.css draws the bar last, across the
 * card.
 */

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/dashboard/cycle-counts/cc-1',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/server/actions/cycle-counts', () => ({
  assignCycleCountAction: vi.fn(),
  cancelCycleCountAction: vi.fn(),
  clearCycleCountLineAction: vi.fn(),
  postCycleCountAction: vi.fn(),
  recordCycleCountLineAction: vi.fn(),
}));

import { cascaded } from '@/styles/liquid-glass/stage4-ops-cascade';

import { CycleCountDetail } from './cycle-count-detail';

import type {
  CycleCountLineWithItem,
  CycleCountRow,
  CycleCountSummary,
} from '@/server/services/cycle-counts';

const header = {
  id: 'cc-1',
  count_number: 42,
  status: 'in_progress',
  warehouse_id: null,
  notes: null,
  assigned_to: null,
  started_at: '2026-10-30T15:05:00Z',
  completed_at: null,
} as unknown as CycleCountRow;

const lines = [
  {
    id: 'line-1',
    counted_quantity: 72,
    expected_quantity: 75,
    item: { name: 'Example item', sku: 'EX-1', barcode: null },
  },
] as unknown as CycleCountLineWithItem[];

function view(summary: CycleCountSummary, rollout: 'off' | 'opt-in' | 'default' = 'default') {
  vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
  return render(
    <CycleCountDetail
      header={header}
      lines={lines}
      summary={summary}
      page={1}
      pageSize={50}
      total={1}
      search=""
      filter="all"
      canAdjust
      canAssign
      role="manager"
    />,
  );
}

const SUMMARY = { total: 140, counted: 96, varianceCount: 6, netDelta: -8 } as CycleCountSummary;

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The figures' grid: the strip's only child. */
const figures = (container: HTMLElement) =>
  container.querySelector('[data-slot="stat-strip"] > div') as HTMLElement;

describe('A cycle count in Liquid Glass: the board’s fifth figure and wide progress bar', () => {
  it('draws "Lines that differ" from the summary, glass-only, between Uncounted and Net variance', () => {
    const { container } = view(SUMMARY);
    const differ = container.querySelector('[data-glass="count-differ"]');
    expect(differ).not.toBeNull();
    expect(differ!.hasAttribute('data-glass-only')).toBe(true);
    expect(differ!.textContent).toBe('Lines that differ6');
    const order = [...figures(container).children].map(
      (c) => c.getAttribute('data-testid') ?? c.getAttribute('data-glass'),
    );
    expect(order).toEqual([
      'count-stat-in-scope',
      'count-stat-counted',
      'count-stat-uncounted',
      'count-differ',
      'count-progress',
      'count-stat-net-variance',
    ]);
  });

  it('draws one wide "Lines counted" progress bar, glass-only, from counted over the items in scope', () => {
    const { container } = view(SUMMARY);
    const bar = screen.getByRole('progressbar', { name: 'Lines counted' });
    expect(bar.getAttribute('data-glass')).toBe('count-progress');
    expect(bar.hasAttribute('data-glass-only')).toBe(true);
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('140');
    expect(bar.getAttribute('aria-valuenow')).toBe('96');
    const fill = bar.firstElementChild as HTMLElement;
    expect(fill.style.width).toBe(`${(96 / 140) * 100}%`);
    // Classic's own bar under Counted stays where it is (glass hides it).
    expect(
      within(
        container.querySelector('[data-testid="count-stat-counted"]') as HTMLElement,
      ).queryByText((_, el) => el?.getAttribute('data-slot') === 'count-progress'),
    ).not.toBeNull();
  });

  it('fills the bar to the end, never past it, when everything is counted', () => {
    view({ total: 3, counted: 3, varianceCount: 0, netDelta: 0 } as CycleCountSummary);
    const bar = screen.getByRole('progressbar', { name: 'Lines counted' });
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('100%');
  });

  it('draws no bar for a count with no lines (nothing to count), and still the figure', () => {
    const { container } = view({
      total: 0,
      counted: 0,
      varianceCount: 0,
      netDelta: 0,
    } as CycleCountSummary);
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(container.querySelector('[data-glass="count-differ"]')?.textContent).toBe(
      'Lines that differ0',
    );
  });

  it('draws both under opt-in too', () => {
    const { container } = view(SUMMARY, 'opt-in');
    expect(container.querySelector('[data-glass="count-differ"]')).not.toBeNull();
    expect(container.querySelector('[data-glass="count-progress"]')).not.toBeNull();
  });

  it('renders neither under the off rollout', () => {
    const { container } = view(SUMMARY, 'off');
    expect(container.querySelector('[data-glass="count-differ"]')).toBeNull();
    expect(container.querySelector('[data-glass="count-progress"]')).toBeNull();
    expect(container.querySelectorAll('[data-glass-only]')).toHaveLength(0);
  });
});

/** The lines card's toolbar: the search, then the views (the card's second row). */
const toolbar = (container: HTMLElement) =>
  container.querySelector('[role="group"][aria-label="Filter lines"]')!.parentElement!;

describe('A cycle count in Liquid Glass: the lines toolbar and the net variance', () => {
  it('draws the board’s note on Expected, glass-only, between the search and the views', () => {
    const { container } = view(SUMMARY);
    const bar = toolbar(container);
    const parts = [...bar.children].map(
      (c) => c.getAttribute('data-glass') ?? c.getAttribute('role') ?? c.tagName.toLowerCase(),
    );
    expect(parts).toEqual(['div', 'count-lines-note', 'group']);
    const note = bar.querySelector('[data-glass="count-lines-note"]')!;
    expect(note.hasAttribute('data-glass-only')).toBe(true);
    expect(note.textContent).toBe('Expected is the system quantity when the line was counted.');
    expect(note.querySelector('a, button, input, select, textarea')).toBeNull();
  });

  it('draws the note under opt-in too, and none under the off rollout', () => {
    const optIn = view(SUMMARY, 'opt-in');
    expect(optIn.container.querySelector('[data-glass="count-lines-note"]')).not.toBeNull();
    optIn.unmount();
    const off = view(SUMMARY, 'off');
    expect(off.container.querySelector('[data-glass="count-lines-note"]')).toBeNull();
  });

  it.each([
    [-8, 'down'],
    [3, 'up'],
    [0, 'none'],
  ])('tells glass which way a net variance of %i goes (%s), an inert hook', (netDelta, tone) => {
    const { container } = view({ ...SUMMARY, netDelta } as CycleCountSummary);
    expect(
      container
        .querySelector('[data-testid="count-stat-net-variance"]')
        ?.getAttribute('data-glass-tone'),
    ).toBe(tone);
  });
});

/**
 * The count's two dialogs as Cycle-Count-Detail.dc.html draws them, on the
 * cascade of the page's glass files (styles/liquid-glass/stage4-ops-cascade.ts):
 * the title in ink (.h2; Classic inks a destructive confirmation's title
 * red), and Post this count?'s Post adjustments as the accent primary
 * (.btn-primary, as Review & post), Cancel count's confirm the danger one.
 */
describe('A cycle count in Liquid Glass: its post and cancel dialogs', () => {
  const FILES = ['pages/ops.css', 'pages/counts.css'];

  function page() {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    document.documentElement.setAttribute('data-appearance', 'liquid-glass');
    return render(
      <div data-glass-page="ops" data-glass-view="cycle-count">
        <CycleCountDetail
          header={header}
          lines={lines}
          summary={SUMMARY}
          page={1}
          pageSize={50}
          total={1}
          search=""
          filter="all"
          canAdjust
          canAssign
          role="manager"
        />
      </div>,
    );
  }

  afterEach(() => {
    document.documentElement.removeAttribute('data-appearance');
  });

  it('draws Post this count? with an ink title and Post adjustments as the accent primary', () => {
    page();
    fireEvent.click(screen.getByRole('button', { name: 'Review & post' }));
    const dialog = screen.getByRole('dialog', { name: 'Post this count?' });
    const title = within(dialog).getByRole('heading', { name: 'Post this count?' });
    expect(cascaded(title, 'color', FILES)?.value).toBe('var(--lg-ink)');
    const post = within(dialog).getByRole('button', { name: 'Post adjustments' });
    expect(cascaded(post, 'background-color', FILES)?.value).toBe('var(--lg-accent)');
    expect(cascaded(post, 'color', FILES)?.value).toBe('var(--lg-on-accent)');
  });

  it('draws Cancel this cycle count? with an ink title and leaves its confirm the danger button', () => {
    page();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel count' }));
    const dialog = screen.getByRole('dialog', { name: 'Cancel this cycle count?' });
    const title = within(dialog).getByRole('heading', { name: 'Cancel this cycle count?' });
    expect(cascaded(title, 'color', FILES)?.value).toBe('var(--lg-ink)');
    const confirm = within(dialog).getByRole('button', { name: 'Cancel count' });
    expect(confirm.getAttribute('data-glass-variant')).toBe('destructive');
    expect(cascaded(confirm, 'background-color', FILES)?.value).not.toBe('var(--lg-accent)');
  });
});
