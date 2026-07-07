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
    expect(screen.getByRole('link', { name: /prev/i })).toHaveAttribute(
      'data-prefetch',
      'true',
    );
    expect(screen.getByRole('link', { name: /next/i })).toHaveAttribute(
      'data-prefetch',
      'true',
    );
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
    expect(screen.getByRole('link', { name: /prev/i })).toHaveAttribute(
      'data-prefetch',
      'false',
    );
    expect(screen.getByRole('link', { name: /next/i })).toHaveAttribute(
      'data-prefetch',
      'false',
    );
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
    expect(screen.getByRole('link', { name: /prev/i })).toHaveAttribute(
      'data-prefetch',
      'false',
    );
    expect(screen.getByRole('link', { name: /next/i })).toHaveAttribute(
      'data-prefetch',
      'false',
    );
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
    expect(screen.getByRole('link', { name: /next/i })).toHaveAttribute(
      'data-prefetch',
      'true',
    );
  });
});
