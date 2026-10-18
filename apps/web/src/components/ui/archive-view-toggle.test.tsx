import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Active / Archived pill links. Every manager page uses it; Items and
 * Books also hand it the parameters that only mean something on Archived
 * (`archivedOnlyParams`): the "Auto-archived only" chip's ?auto=1 narrows the
 * list to rows the zero-stock job archived, and no active row is one, so an
 * Active link that kept it opened an empty list (review 2026-10-05).
 */

const nav = vi.hoisted(() => ({ search: '' }));

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard/inventory',
  useSearchParams: () => new URLSearchParams(nav.search),
}));

// The stand-in records the link options a tab hands next/link (prefetch,
// scroll, replace) on data attributes, so a test can see that none is set.
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    prefetch,
    scroll,
    replace,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    prefetch?: boolean | null;
    scroll?: boolean;
    replace?: boolean;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a
      href={href}
      data-prefetch={String(prefetch)}
      data-scroll={String(scroll)}
      data-replace={String(replace)}
      {...rest}
    >
      {children}
    </a>
  ),
}));

import { ArchiveViewToggle } from './archive-view-toggle';

const hrefOf = (name: string) => screen.getByRole('tab', { name }).getAttribute('href');

beforeEach(() => {
  nav.search = '';
});

describe('ArchiveViewToggle', () => {
  it('Active drops the parameters that only mean something on Archived, and the page', () => {
    nav.search = 'status=archived&auto=1&q=tee&page=3';
    render(<ArchiveViewToggle paramName="status" archivedOnlyParams={['auto']} />);
    expect(hrefOf('Active')).toBe('/dashboard/inventory?q=tee');
  });

  it('Archived keeps them (the chip stays on when you are already there)', () => {
    nav.search = 'status=archived&auto=1&q=tee&page=3';
    render(<ArchiveViewToggle paramName="status" archivedOnlyParams={['auto']} />);
    expect(hrefOf('Archived')).toBe('/dashboard/inventory?auto=1&q=tee&status=archived');
  });

  it('Active from the Auto-archived only view is the plain list', () => {
    nav.search = 'status=archived&auto=1';
    render(<ArchiveViewToggle paramName="status" archivedOnlyParams={['auto']} />);
    expect(hrefOf('Active')).toBe('/dashboard/inventory');
  });

  it('without archivedOnlyParams every other parameter is carried, as before', () => {
    nav.search = 'view=archived&auto=1&wh=w1';
    render(<ArchiveViewToggle />);
    expect(hrefOf('Active')).toBe('/dashboard/inventory?auto=1&wh=w1');
    expect(hrefOf('Archived')).toBe('/dashboard/inventory?auto=1&wh=w1&view=archived');
  });
});

/**
 * Redesign P2.6c (PLAN P2.2 "One look per pattern"): the toggle is drawn by
 * P2.6's SegmentedTabs and keeps its props, words, tablist semantics, hrefs
 * and link behaviour.
 */
describe('ArchiveViewToggle through the SegmentedTabs pattern', () => {
  it('is the "View filter" tablist of two link tabs, the URL`s view selected', () => {
    nav.search = 'view=archived';
    render(<ArchiveViewToggle />);
    const list = screen.getByRole('tablist', { name: 'View filter' });
    const tabs = within(list).getAllByRole('tab');
    expect(tabs.map((t) => [t.tagName, t.textContent, t.getAttribute('aria-selected')])).toEqual([
      ['A', 'Active', 'false'],
      ['A', 'Archived', 'true'],
    ]);
    // Every tab stays in the Tab order, as before (no roving focus).
    for (const tab of tabs) expect(tab).not.toHaveAttribute('tabindex');
  });

  it('lets an explicit view win over the URL, and Active is the default', () => {
    nav.search = 'view=archived';
    const { rerender } = render(<ArchiveViewToggle view="active" />);
    expect(screen.getByRole('tab', { name: 'Active' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Archived' })).toHaveAttribute('aria-selected', 'false');
    nav.search = 'view=something-else';
    rerender(<ArchiveViewToggle />);
    expect(screen.getByRole('tab', { name: 'Active' })).toHaveAttribute('aria-selected', 'true');
  });

  it('keeps the page`s own words, param, archived value and base path', () => {
    nav.search = 'state=old&q=tent&page=2';
    render(
      <ArchiveViewToggle
        basePath="/dashboard/rentals/items"
        paramName="state"
        archivedValue="old"
        activeLabel="Current"
        archivedLabel="Retired"
      />,
    );
    expect(screen.getByRole('tab', { name: 'Retired' })).toHaveAttribute('aria-selected', 'true');
    expect(hrefOf('Current')).toBe('/dashboard/rentals/items?q=tent');
    expect(hrefOf('Retired')).toBe('/dashboard/rentals/items?q=tent&state=old');
  });

  it('hands next/link no prefetch, scroll or replace option, so both keep Next`s defaults', () => {
    render(<ArchiveViewToggle />);
    for (const tab of screen.getAllByRole('tab')) {
      expect(tab).toHaveAttribute('data-prefetch', 'undefined');
      expect(tab).toHaveAttribute('data-scroll', 'undefined');
      expect(tab).toHaveAttribute('data-replace', 'undefined');
    }
  });

  it('draws the view-toggle segmented control, with the caller`s classes on the track', () => {
    nav.search = 'view=archived';
    render(<ArchiveViewToggle className="ml-auto" />);
    const track = screen.getByRole('tablist', { name: 'View filter' });
    expect(track).toHaveAttribute('data-slot', 'segmented-tabs');
    // DESIGN-SPEC 6.5 view toggle: a 32 px sunk track holding 26 px segments.
    expect(track).toHaveClass('bg-sunk', 'p-0.5', 'ml-auto');
    expect(screen.getByRole('tab', { name: 'Archived' })).toHaveAttribute('data-state', 'active');
    expect(screen.getByRole('tab', { name: 'Active' })).toHaveAttribute('data-state', 'inactive');
    for (const tab of screen.getAllByRole('tab')) expect(tab).toHaveClass('h-[26px]');
  });
});
