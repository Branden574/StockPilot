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

  // Review finding (P4.D1, LOW): pinned as the shared strip draws it today, a
  // pattern-imposed change recorded for the owner's review (see the component's
  // note). The current tab links to the address bar as it is and a click on it
  // is cancelled, so it no longer resets the status view or the filters; the
  // other tab still links to its fixed URL and its click is left to the link.
  it('the current tab keeps the URL as it is; the other tab links to its fixed URL', () => {
    nav.pathname = '/dashboard/rentals/items';
    nav.search = 'q=tent&page=2';
    render(<RentalsTabs activeTab="items" />);
    const items = screen.getByRole('tab', { name: 'Items' });
    const activity = screen.getByRole('tab', { name: 'Activity' });
    expect(items.getAttribute('href')).toBe('/dashboard/rentals/items?q=tent&page=2');
    expect(activity.getAttribute('href')).toBe('/dashboard/rentals');
    // fireEvent returns false when the handler prevented the default.
    expect(fireEvent.click(items)).toBe(false);
    expect(fireEvent.click(activity)).toBe(true);
  });
});
