import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Pagination } from './inventory-table';

// Next.js Link does navigation gymnastics — stub to a plain anchor
// so we can assert href values directly.
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    // Next-Link-only props must not reach the DOM <a> (React "unknown
    // DOM prop" warning) — but `prefetch` IS behavior under test
    // (adjacent-page full prefetch in server mode), so surface it as a
    // data attribute the assertions can read.
    prefetch,
    scroll: _scroll,
    replace: _replace,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    prefetch?: boolean;
    scroll?: boolean;
    replace?: boolean;
  }) => (
    <a
      href={typeof href === 'string' ? href : '#'}
      data-prefetch={prefetch === undefined ? 'default' : String(prefetch)}
      {...rest}
    >
      {children}
    </a>
  ),
}));

describe('Pagination jump-to-page popover', () => {
  it('renders a Jump to page trigger with current state', () => {
    render(
      <Pagination
        page={2}
        pageSize={50}
        total={210}
        buildHref={(p) => `/dashboard/inventory?page=${p}`}
      />,
    );
    const trigger = screen.getByRole('button', { name: /jump to page/i });
    expect(trigger).toHaveTextContent('Page 2 of 5');
  });

  it('opens a popover with one link per page when the trigger is clicked', async () => {
    const user = userEvent.setup();
    render(
      <Pagination
        page={1}
        pageSize={50}
        total={150}
        buildHref={(p) => `/dashboard/inventory?page=${p}`}
      />,
    );
    await user.click(screen.getByRole('button', { name: /jump to page/i }));
    const pageLinks = await screen.findAllByRole('link', { name: /^[0-9]+$/ });
    expect(pageLinks).toHaveLength(3);
    expect(pageLinks[0]).toHaveAttribute('href', '/dashboard/inventory?page=1');
    expect(pageLinks[1]).toHaveAttribute('href', '/dashboard/inventory?page=2');
    expect(pageLinks[2]).toHaveAttribute('href', '/dashboard/inventory?page=3');
  });

  it('marks the current page link with aria-current="page"', async () => {
    const user = userEvent.setup();
    render(
      <Pagination
        page={2}
        pageSize={50}
        total={150}
        buildHref={(p) => `/dashboard/inventory?page=${p}`}
      />,
    );
    await user.click(screen.getByRole('button', { name: /jump to page/i }));
    const activeLink = await screen.findByRole('link', { current: 'page' });
    expect(activeLink).toHaveTextContent('2');
  });
});

// B9: the pager printed its figures raw ("Showing 1201–1250 of 52345") right
// under the summary line, which formats the same total ("52,345 items").
describe('Pagination figures', () => {
  it('prints the row range, the total and the page count with thousands separators', () => {
    render(
      <Pagination
        page={25}
        pageSize={50}
        total={52345}
        buildHref={(p) => `/dashboard/inventory?page=${p}`}
      />,
    );
    expect(screen.getByText(/^Showing/)).toHaveTextContent('Showing 1,201–1,250 of 52,345');
    expect(screen.getByRole('button', { name: /jump to page/i })).toHaveTextContent(
      'Page 25 of 1,047',
    );
  });

  it('labels a jump-grid page past 999 the way the trigger prints it', async () => {
    const user = userEvent.setup();
    render(
      <Pagination
        page={1000}
        pageSize={50}
        total={50_050}
        buildHref={(p) => `/dashboard/inventory?page=${p}`}
      />,
    );
    const trigger = screen.getByRole('button', { name: /jump to page/i });
    expect(trigger).toHaveTextContent('Page 1,000 of 1,001');
    await user.click(trigger);
    const current = await screen.findByRole('link', { current: 'page' });
    expect(current).toHaveTextContent('1,000');
    expect(current).toHaveAttribute('href', '/dashboard/inventory?page=1000');
  });
});

describe('Pagination adjacent-page prefetch', () => {
  it('settled SERVER mode (no onNavigate, no pending instant): Prev and Next fully prefetch — the two adjacent pages only', async () => {
    const user = userEvent.setup();
    render(
      // No onNavigate and pendingInstant explicitly false = the settled
      // server-mode fixture: an over-cap org whose instant promise has
      // already resolved null (or no instant pipeline at all).
      <Pagination
        page={2}
        pageSize={50}
        total={210}
        buildHref={(p) => `/dashboard/inventory?page=${p}`}
        pendingInstant={false}
      />,
    );
    // Adjacent links: full RSC prefetch so the page-turn click swaps in
    // already-fetched data instead of a server round trip.
    expect(screen.getByRole('link', { name: /prev/i })).toHaveAttribute('data-prefetch', 'true');
    expect(screen.getByRole('link', { name: /next/i })).toHaveAttribute('data-prefetch', 'true');
    // The numbered popover grid must NEVER join in (no link herd —
    // intent-scoped warming only).
    await user.click(screen.getByRole('button', { name: /jump to page/i }));
    const numbered = await screen.findAllByRole('link', { name: /^[0-9]+$/ });
    expect(numbered.length).toBeGreaterThan(2);
    for (const link of numbered) {
      expect(link).toHaveAttribute('data-prefetch', 'false');
    }
  });

  it('PENDING instant upgrade (server mode, streamed dataset unresolved): adjacent prefetch is suspended — the ?page=2 payload would never be consumed', () => {
    render(
      // Server mode (no onNavigate) but the under-cap default view's
      // instant dataset is still streaming in: the table flips to
      // instant moments later, so warming adjacent RSC pages now is
      // pure waste.
      <Pagination
        page={2}
        pageSize={50}
        total={210}
        buildHref={(p) => `/dashboard/inventory?page=${p}`}
        pendingInstant
      />,
    );
    expect(screen.getByRole('link', { name: /prev/i })).toHaveAttribute('data-prefetch', 'false');
    expect(screen.getByRole('link', { name: /next/i })).toHaveAttribute('data-prefetch', 'false');
  });

  it('INSTANT mode (onNavigate set): no prefetch anywhere — pagination is a shallow push, not a navigation', () => {
    render(
      <Pagination
        page={2}
        pageSize={50}
        total={210}
        buildHref={(p) => `/dashboard/inventory?page=${p}`}
        onNavigate={vi.fn()}
      />,
    );
    expect(screen.getByRole('link', { name: /prev/i })).toHaveAttribute('data-prefetch', 'false');
    expect(screen.getByRole('link', { name: /next/i })).toHaveAttribute('data-prefetch', 'false');
  });

  it('does not render a prefetching link for a disabled edge (page 1 has no Prev anchor)', () => {
    render(
      <Pagination
        page={1}
        pageSize={50}
        total={210}
        buildHref={(p) => `/dashboard/inventory?page=${p}`}
      />,
    );
    // Prev is a disabled <span>, not a link — nothing to prefetch.
    expect(screen.queryByRole('link', { name: /prev/i })).toBeNull();
    expect(screen.getByRole('link', { name: /next/i })).toHaveAttribute('data-prefetch', 'true');
  });
});

// FX8 (DESIGN-SPEC 6.9 pagination footer, 6.2 pager rows): Items and Books
// draw this pager, not components/ui/pagination.tsx. The reference pager is
// 12.5/400 with the range figures in --ink at 400; here the figures carried
// font-medium and Prev / Next took the Button's weight 500.
describe('Pagination weight', () => {
  it('prints the range figures in ink at weight 400, and Prev and Next at 400, enabled or not', () => {
    render(
      <Pagination
        page={1}
        pageSize={30}
        total={216}
        buildHref={(p) => `/dashboard/inventory?page=${p}`}
      />,
    );
    for (const figure of ['1', '30', '216']) {
      const el = screen.getByText(figure);
      expect(el).toHaveClass('text-foreground');
      expect(el).not.toHaveClass('font-medium');
    }
    // Page 1: Prev is the disabled span, Next a link.
    const prev = screen.getByText('← Prev');
    expect(prev).toHaveAttribute('aria-disabled');
    expect(prev).toHaveClass('font-normal');
    expect(prev).not.toHaveClass('font-medium');
    const next = screen.getByRole('link', { name: /next/i });
    expect(next).toHaveClass('font-normal');
    expect(next).not.toHaveClass('font-medium');
  });
});
