import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * next/link is a stand-in that records the options a tab hands it (prefetch,
 * scroll, replace) on data attributes, and keeps the installed Link's click
 * contract: the page's own onClick runs first and a prevented default stops
 * the navigation.
 */
const navigate = vi.hoisted(() => vi.fn<(href: string) => void>());

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    prefetch,
    scroll,
    replace,
    onClick,
    ...rest
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    href: string;
    prefetch?: boolean | null;
    scroll?: boolean;
    replace?: boolean;
  }) => (
    <a
      href={href}
      data-prefetch={String(prefetch)}
      data-scroll={String(scroll)}
      data-replace={String(replace)}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        event.preventDefault();
        navigate(href);
      }}
      {...rest}
    >
      {children}
    </a>
  ),
}));

import { SegmentedTabs, type SegmentedTabItem } from './segmented-tabs';

beforeEach(() => {
  navigate.mockReset();
});

const VIEWS: SegmentedTabItem[] = [
  { id: 'all', label: 'All items', href: '/dashboard/inventory' },
  { id: 'low', label: 'Low + critical', href: '/dashboard/inventory?stock=low' },
  { id: 'out', label: 'Out of stock', href: '/dashboard/inventory?stock=out' },
];

describe('SegmentedTabs (tablist semantics)', () => {
  it('is a named tablist of link tabs, only the current one selected, hrefs kept exactly', () => {
    render(<SegmentedTabs aria-label="Stock view" items={VIEWS} activeId="low" />);
    const list = screen.getByRole('tablist', { name: 'Stock view' });
    const tabs = within(list).getAllByRole('tab');
    expect(tabs.map((t) => t.getAttribute('href'))).toEqual([
      '/dashboard/inventory',
      '/dashboard/inventory?stock=low',
      '/dashboard/inventory?stock=out',
    ]);
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
    expect(screen.getByRole('tab', { name: 'Low + critical' })).toHaveAttribute(
      'data-state',
      'active',
    );
  });

  it('shows no tab selected for an unknown or null active id', () => {
    render(<SegmentedTabs aria-label="Stock view" items={VIEWS} activeId={null} />);
    expect(
      screen.getAllByRole('tab').filter((t) => t.getAttribute('aria-selected') === 'true'),
    ).toHaveLength(0);
  });

  it('keeps every tab in the Tab order (no roving focus)', () => {
    render(<SegmentedTabs aria-label="Stock view" items={VIEWS} activeId="all" />);
    for (const tab of screen.getAllByRole('tab')) expect(tab).not.toHaveAttribute('tabindex');
  });

  it('prints a count only where the page passes one (0 included), and nothing otherwise', () => {
    const { container } = render(
      <SegmentedTabs
        aria-label="Stock view"
        items={[
          { id: 'all', label: 'All items', href: '/a', count: 487 },
          { id: 'low', label: 'Low + critical', href: '/b' },
          { id: 'exp', label: 'Expected', href: '/c', count: 0 },
        ]}
        activeId="all"
      />,
    );
    const counts = container.querySelectorAll('[data-slot="segmented-tab-count"]');
    expect([...counts].map((c) => c.textContent)).toEqual(['487', '0']);
    expect(screen.getByRole('tab', { name: 'Low + critical' }).textContent).toBe('Low + critical');
  });

  it('passes each tab`s link options and onClick through, so an intercepted click stays intercepted', () => {
    const shallowPush = vi.fn((event: React.MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
    });
    render(
      <SegmentedTabs
        aria-label="Stock view"
        items={VIEWS.map((v) => ({ ...v, prefetch: false, scroll: false, onClick: shallowPush }))}
        activeId="all"
      />,
    );
    const low = screen.getByRole('tab', { name: 'Low + critical' });
    expect(low).toHaveAttribute('data-prefetch', 'false');
    expect(low).toHaveAttribute('data-scroll', 'false');
    fireEvent.click(low);
    expect(shallowPush).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('draws the focus ring inside each tab, so the scrolling track cannot clip it', () => {
    const { container, rerender } = render(
      <SegmentedTabs aria-label="Stock view" items={VIEWS} activeId="all" />,
    );
    // The track scrolls sideways (overflow-x-auto), which clips the global
    // ring drawn 4 px outside a control; an inset ring with no offset stays whole.
    expect(container.querySelector('[data-slot="segmented-tabs"]')).toHaveClass('overflow-x-auto');
    for (const tab of screen.getAllByRole('tab')) {
      expect(tab).toHaveClass('focus-visible:ring-inset', 'focus-visible:ring-offset-0');
    }
    rerender(
      <SegmentedTabs
        aria-label="Layout"
        size="sm"
        items={[
          { id: 'table', label: 'List' },
          { id: 'grid', label: 'Grid' },
        ]}
        activeId="table"
      />,
    );
    for (const tab of screen.getAllByRole('tab')) {
      expect(tab).toHaveClass('focus-visible:ring-inset', 'focus-visible:ring-offset-0');
    }
  });

  it('keeps its desktop size on a coarse pointer above sm, and taps reach the whole track height', () => {
    const { container, rerender } = render(
      <SegmentedTabs aria-label="Stock view" items={VIEWS} activeId="all" />,
    );
    const track = () => container.querySelector('[data-slot="segmented-tabs"]')!;
    // md: a 36 px track (3 px padding) holding 28 px segments, 44 px below sm.
    expect(track()).toHaveClass('p-[3px]');
    for (const tab of screen.getAllByRole('tab')) {
      expect(tab).toHaveClass('h-7', 'max-sm:min-h-11');
      // A visibly 44 px segment on every coarse pointer made a 52 px track
      // beside the 32 px search field on a touch tablet.
      expect(tab).not.toHaveClass('pointer-coarse:min-h-11');
      // The tap area spans the track padding above and below the segment and
      // stops at the track's edge (the track scrolls, so it clips the rest).
      expect(tab).toHaveClass(
        'relative',
        'before:absolute',
        'before:inset-x-0',
        'before:-inset-y-[3px]',
        "before:content-['']",
      );
    }
    rerender(
      <SegmentedTabs
        aria-label="Layout"
        size="sm"
        items={[
          { id: 'table', label: 'List' },
          { id: 'grid', label: 'Grid' },
        ]}
        activeId="table"
      />,
    );
    expect(track()).toHaveClass('p-0.5');
    for (const tab of screen.getAllByRole('tab')) {
      expect(tab).toHaveClass('h-[26px]', 'max-sm:min-h-11', 'before:-inset-y-0.5');
      expect(tab).not.toHaveClass('pointer-coarse:min-h-11');
    }
  });

  // FX7 (DESIGN-SPEC 4 "Range toggle track / chip 28 / 22", 6.5's 30d / 90d
  // row): the chart toggles drew the List / Grid look (a 32 px sunk track,
  // 26 px segments at 12.5/500, a ringed card-colour active segment). `xs` is
  // the range toggle: a transparent 28 px track with the --line hairline,
  // 22 px chips at 12/400, the chosen one on the hover fill with no ring. It
  // keeps weight 500 on the chosen chip, so the choice is not shown by colour
  // alone, and the 44 px segments below sm.
  it('xs draws the range toggle: a transparent track, 22 px chips, the chosen one filled without a ring', () => {
    const { container } = render(
      <SegmentedTabs
        semantics="nav"
        size="xs"
        aria-label="Range"
        activeId="30"
        onSelect={() => {}}
        items={[
          { id: '30', label: '30d' },
          { id: '90', label: '90d' },
        ]}
      />,
    );
    const track = container.querySelector('[data-slot="segmented-tabs"]')!;
    expect(track).toHaveClass('border', 'border-border', 'rounded-md', 'p-0.5', 'bg-transparent');
    expect(track).not.toHaveClass('bg-sunk');
    const active = screen.getByRole('button', { name: '30d' });
    const idle = screen.getByRole('button', { name: '90d' });
    for (const chip of [active, idle]) {
      expect(chip).toHaveClass(
        'h-[22px]',
        'rounded',
        'px-2',
        'text-[12px]',
        'max-sm:min-h-11',
        'before:-inset-y-0.5',
      );
    }
    expect(active).toHaveAttribute('aria-pressed', 'true');
    expect(active).toHaveClass('bg-muted', 'text-foreground', 'font-medium');
    expect(active.className).not.toContain('shadow-[0_0_0_1px');
    expect(active).not.toHaveClass('bg-card');
    expect(idle).toHaveAttribute('aria-pressed', 'false');
    expect(idle).toHaveClass('font-normal', 'text-muted-foreground');
    expect(idle).not.toHaveClass('bg-muted', 'font-medium');
  });

  it('passes data attributes, a title and an aria-label through to the tab', () => {
    render(
      <SegmentedTabs
        aria-label="View"
        items={[
          {
            id: 'grid',
            label: 'Grid',
            href: '/g',
            title: 'Photo grid',
            ariaLabel: 'Show the photo grid',
            'data-testid': 'view-grid',
          },
        ]}
        activeId="grid"
      />,
    );
    const tab = screen.getByTestId('view-grid');
    expect(tab).toHaveAttribute('title', 'Photo grid');
    expect(tab).toHaveAccessibleName('Show the photo grid');
  });
});

describe('SegmentedTabs (nav semantics)', () => {
  it('is a named navigation of links with aria-current on the current one, and no tab roles', () => {
    render(
      <SegmentedTabs
        semantics="nav"
        aria-label="Filter by status"
        items={[
          { id: 'all', label: 'All statuses', href: '/dashboard/cycle-counts?q=north' },
          {
            id: 'canceled',
            label: 'Canceled',
            href: '/dashboard/cycle-counts?q=north&status=canceled',
          },
        ]}
        activeId="all"
      />,
    );
    const nav = screen.getByRole('navigation', { name: 'Filter by status' });
    expect(within(nav).getByRole('link', { name: 'All statuses' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'Canceled' })).not.toHaveAttribute('aria-current');
    expect(within(nav).getByRole('link', { name: 'Canceled' })).toHaveAttribute(
      'href',
      '/dashboard/cycle-counts?q=north&status=canceled',
    );
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('tab')).toBeNull();
  });

  it('keeps a tour selector on the strip working (nav[aria-label="Status"])', () => {
    const { container } = render(
      <SegmentedTabs semantics="nav" aria-label="Status" items={VIEWS} activeId="all" />,
    );
    expect(container.querySelector('nav[aria-label="Status"]')).not.toBeNull();
  });
});

describe('SegmentedTabs (button mode)', () => {
  it('renders tabs without an href as buttons that report their id', () => {
    const onSelect = vi.fn();
    render(
      <SegmentedTabs
        aria-label="Layout"
        size="sm"
        items={[
          { id: 'table', label: 'List' },
          { id: 'grid', label: 'Grid' },
        ]}
        activeId="table"
        onSelect={onSelect}
      />,
    );
    const grid = screen.getByRole('tab', { name: 'Grid' });
    expect(grid.tagName).toBe('BUTTON');
    expect(grid).toHaveAttribute('type', 'button');
    expect(grid).toHaveAttribute('aria-selected', 'false');
    fireEvent.click(grid);
    expect(onSelect).toHaveBeenCalledWith('grid', expect.anything());
  });

  it('uses aria-pressed toggles in a named group, not a navigation landmark, when no tab is a link', () => {
    const onSelect = vi.fn();
    render(
      <SegmentedTabs
        semantics="nav"
        aria-label="On hand"
        items={[
          { id: 'total', label: 'Total' },
          { id: 'placed', label: 'Placed only' },
        ]}
        activeId="placed"
        onSelect={onSelect}
      />,
    );
    const group = screen.getByRole('group', { name: 'On hand' });
    expect(group).toHaveAttribute('data-slot', 'segmented-tabs');
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(within(group).getByRole('button', { name: 'Placed only' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(group).getByRole('button', { name: 'Total' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    fireEvent.click(within(group).getByRole('button', { name: 'Total' }));
    expect(onSelect).toHaveBeenCalledWith('total', expect.anything());
  });

  it('stays a navigation landmark when any tab is a link', () => {
    render(
      <SegmentedTabs
        semantics="nav"
        aria-label="Status"
        items={[
          { id: 'all', label: 'All', href: '/dashboard/orders' },
          { id: 'mine', label: 'Mine' },
        ]}
        activeId="all"
      />,
    );
    expect(screen.getByRole('navigation', { name: 'Status' })).toBeInTheDocument();
    expect(screen.queryByRole('group')).toBeNull();
  });
});
