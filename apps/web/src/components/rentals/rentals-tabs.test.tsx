import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/**
 * The Rentals section tabs (redesign P4.D1), drawn by the shared in-page tab
 * strip: the same two links and words, a tablist named "Rentals section",
 * and aria-selected on the current tab.
 */

const nav = { pathname: '/dashboard/rentals', search: '' };
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock('next/link', async () => {
  const React = await import('react');
  function Link({
    href,
    children,
    scroll: _scroll,
    prefetch: _prefetch,
    ...rest
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    href: string;
    scroll?: boolean;
    prefetch?: boolean | null;
  }) {
    return React.createElement('a', { href, ...rest }, children);
  }
  return { default: Link, useLinkStatus: () => ({ pending: false }) };
});

import { RentalsTabs } from './rentals-tabs';

describe('RentalsTabs', () => {
  it('Activity selected on the checkouts page, Items linking to the catalog', () => {
    nav.pathname = '/dashboard/rentals';
    nav.search = 'status=overdue';
    render(<RentalsTabs activeTab="activity" />);
    const list = screen.getByRole('tablist', { name: 'Rentals section' });
    const tabs = Array.from(list.querySelectorAll('[role="tab"]'));
    expect(tabs.map((t) => t.textContent)).toEqual(['Activity', 'Items']);
    const [activity, items] = tabs as HTMLAnchorElement[];
    expect(activity!.getAttribute('aria-selected')).toBe('true');
    expect(items!.getAttribute('aria-selected')).toBe('false');
    expect(items!.getAttribute('href')).toBe('/dashboard/rentals/items');
  });

  it('Items selected on the catalog, Activity linking back to the checkouts', () => {
    nav.pathname = '/dashboard/rentals/items';
    nav.search = '';
    render(<RentalsTabs activeTab="items" />);
    const activity = screen.getByRole('tab', { name: 'Activity' });
    const items = screen.getByRole('tab', { name: 'Items' });
    expect(items.getAttribute('aria-selected')).toBe('true');
    expect(activity.getAttribute('aria-selected')).toBe('false');
    expect(activity.getAttribute('href')).toBe('/dashboard/rentals');
  });

  // Review finding (P4.D1, LOW), fixed with the shared strip's
  // activeLinksToHref: as before the redesign, the current tab links to its
  // fixed URL, so a click on a filtered or paged list resets it; on the plain
  // URL itself the click does nothing.
  it('the current tab links to its fixed URL and resets a filtered or paged view', () => {
    nav.pathname = '/dashboard/rentals/items';
    nav.search = 'q=tent&page=2';
    render(<RentalsTabs activeTab="items" />);
    const items = screen.getByRole('tab', { name: 'Items' });
    const activity = screen.getByRole('tab', { name: 'Activity' });
    expect(items.getAttribute('href')).toBe('/dashboard/rentals/items');
    expect(activity.getAttribute('href')).toBe('/dashboard/rentals');
    // fireEvent returns false when the handler prevented the default.
    expect(fireEvent.click(items)).toBe(true);
    expect(fireEvent.click(activity)).toBe(true);
  });

  it('on its plain URL a click on the current tab does nothing', () => {
    nav.pathname = '/dashboard/rentals';
    nav.search = '';
    render(<RentalsTabs activeTab="activity" />);
    const activity = screen.getByRole('tab', { name: 'Activity' });
    expect(activity.getAttribute('href')).toBe('/dashboard/rentals');
    expect(fireEvent.click(activity)).toBe(false);
  });
});
