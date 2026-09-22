import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Click feedback on the item page's tabs (owner report 2026-09-22: a tab
 * showed nothing for 3.6-6.6 s and he clicked about ten times).
 *
 * next/link is replaced by a stand-in that keeps the installed Link's click
 * contract (next/dist/client/app-dir/link.js, `onClick` of `childProps`): it
 * calls the page's own onClick FIRST, returns when that prevented the default,
 * leaves modified clicks to the browser, and otherwise navigates. `navigate`
 * is that navigation, so "not called" means the router was never asked.
 * `useLinkStatus` reads the nearest Link, as the real hook does, from a set of
 * hrefs the test marks pending.
 */

const nav = vi.hoisted(() => ({
  pathname: '/dashboard/inventory/abc',
  search: '',
  pending: new Set<string>(),
  navigate: vi.fn<(href: string) => void>(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
}));

vi.mock('next/link', async () => {
  const React = await import('react');
  const Status = React.createContext({ pending: false });
  function Link({
    href,
    onClick,
    children,
    scroll: _scroll,
    ...rest
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; scroll?: boolean }) {
    return React.createElement(
      Status.Provider,
      { value: { pending: nav.pending.has(href) } },
      React.createElement(
        'a',
        {
          ...rest,
          href,
          onClick: (event: React.MouseEvent<HTMLAnchorElement>) => {
            onClick?.(event);
            if (event.defaultPrevented) return;
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            nav.navigate(href);
          },
        },
        children,
      ),
    );
  }
  return { default: Link, useLinkStatus: () => React.useContext(Status) };
});

import { ItemDetailTabs } from './item-detail-tabs';

const ITEM = '/dashboard/inventory/abc';

function tab(name: 'Overview' | 'Movements' | 'Activity'): HTMLElement {
  return screen.getByRole('tab', { name });
}

function selected(): string[] {
  return screen
    .getAllByRole('tab')
    .filter((t) => t.getAttribute('aria-selected') === 'true')
    .map((t) => t.textContent ?? '');
}

function underline(el: HTMLElement): Element | null {
  return el.querySelector('span[aria-hidden]');
}

/** The router commits a new URL: the address bar and the server's tab move together. */
function land(
  rerender: (ui: React.ReactElement) => void,
  search: string,
  activeTab: 'overview' | 'movements' | 'activity',
): void {
  nav.search = search;
  nav.pending.clear();
  rerender(<ItemDetailTabs activeTab={activeTab} />);
}

beforeEach(() => {
  nav.pathname = ITEM;
  nav.search = '';
  nav.pending.clear();
  nav.navigate.mockReset();
});

describe('ItemDetailTabs click feedback', () => {
  it('shows the clicked tab selected at once, before the server has answered', () => {
    render(<ItemDetailTabs activeTab="overview" />);
    fireEvent.click(tab('Movements'));

    expect(nav.navigate).toHaveBeenCalledWith(`${ITEM}?tab=movements`);
    expect(selected()).toEqual(['Movements']);
    expect(underline(tab('Movements'))?.className).toContain('bg-foreground');
    expect(underline(tab('Overview'))?.className).toContain('bg-transparent');
  });

  it('a click on the selected tab does nothing: default prevented, router never asked', () => {
    nav.search = 'tab=movements';
    render(<ItemDetailTabs activeTab="movements" />);

    const notPrevented = fireEvent.click(tab('Movements'));

    expect(notPrevented).toBe(false);
    expect(nav.navigate).not.toHaveBeenCalled();
    expect(selected()).toEqual(['Movements']);
  });

  it('the selected tab links to the URL exactly as it is, however the URL spells the tab', () => {
    nav.search = 'tab=overview&from=search';
    render(<ItemDetailTabs activeTab="overview" />);

    expect(tab('Overview')).toHaveAttribute('href', `${ITEM}?tab=overview&from=search`);
    fireEvent.click(tab('Overview'));
    expect(nav.navigate).not.toHaveBeenCalled();
    // The other tabs still carry the rest of the query along.
    expect(tab('Activity')).toHaveAttribute('href', `${ITEM}?tab=activity&from=search`);
  });

  it('clicking the tab that is still loading again does not restart its navigation', () => {
    render(<ItemDetailTabs activeTab="overview" />);
    fireEvent.click(tab('Movements'));
    fireEvent.click(tab('Movements'));
    fireEvent.click(tab('Movements'));

    expect(nav.navigate).toHaveBeenCalledTimes(1);
    expect(selected()).toEqual(['Movements']);
  });

  it('pulses the underline while next/link reports the navigation pending, and stops when it lands', () => {
    const { rerender } = render(<ItemDetailTabs activeTab="overview" />);
    fireEvent.click(tab('Movements'));
    nav.pending.add(`${ITEM}?tab=movements`);
    rerender(<ItemDetailTabs activeTab="overview" />);
    expect(underline(tab('Movements'))?.className).toContain('animate-pulse');

    land(rerender, 'tab=movements', 'movements');
    expect(selected()).toEqual(['Movements']);
    expect(underline(tab('Movements'))?.className).not.toContain('animate-pulse');
  });

  it('leaves modified clicks (open in a new tab) to the browser, on any tab', () => {
    render(<ItemDetailTabs activeTab="overview" />);

    expect(fireEvent.click(tab('Activity'), { metaKey: true })).toBe(true);
    expect(fireEvent.click(tab('Overview'), { ctrlKey: true })).toBe(true);

    expect(nav.navigate).not.toHaveBeenCalled();
    expect(selected()).toEqual(['Overview']);
  });

  it('gives the real tab back when the navigation ends without the URL moving (another link took over)', () => {
    const { rerender } = render(<ItemDetailTabs activeTab="overview" />);
    fireEvent.click(tab('Movements'));
    nav.pending.add(`${ITEM}?tab=movements`);
    rerender(<ItemDetailTabs activeTab="overview" />);
    expect(selected()).toEqual(['Movements']);

    nav.pending.delete(`${ITEM}?tab=movements`);
    rerender(<ItemDetailTabs activeTab="overview" />);

    expect(selected()).toEqual(['Overview']);
  });

  it('a quick second click keeps its tab when the first navigation is dropped', () => {
    const { rerender } = render(<ItemDetailTabs activeTab="overview" />);
    fireEvent.click(tab('Movements'));
    nav.pending.add(`${ITEM}?tab=movements`);
    rerender(<ItemDetailTabs activeTab="overview" />);

    fireEvent.click(tab('Activity'));
    // Next moves "pending" from the first link to the second.
    nav.pending.delete(`${ITEM}?tab=movements`);
    nav.pending.add(`${ITEM}?tab=activity`);
    rerender(<ItemDetailTabs activeTab="overview" />);

    expect(nav.navigate).toHaveBeenLastCalledWith(`${ITEM}?tab=activity`);
    expect(selected()).toEqual(['Activity']);
  });

  it('once the URL moves the URL decides, so Back to the URL a tab was clicked on shows that URL`s tab', () => {
    const { rerender } = render(<ItemDetailTabs activeTab="overview" />);
    // A prefetched route can commit with no pending phase at all, so the
    // underline never sees pending go true -> false. The URL is what resets it.
    fireEvent.click(tab('Movements'));
    land(rerender, 'tab=movements', 'movements');
    expect(selected()).toEqual(['Movements']);

    land(rerender, '', 'overview');

    expect(selected()).toEqual(['Overview']);
  });

  it('clicking the real current tab while another is loading navigates, so the loading one is superseded', () => {
    render(<ItemDetailTabs activeTab="overview" />);
    fireEvent.click(tab('Movements'));
    fireEvent.click(tab('Overview'));

    expect(nav.navigate).toHaveBeenLastCalledWith(ITEM);
    expect(selected()).toEqual(['Overview']);
  });

  it('gives every tab the id its panel names in aria-labelledby', () => {
    render(<ItemDetailTabs activeTab="overview" />);
    expect(tab('Overview')).toHaveAttribute('id', 'item-detail-tab-overview');
    expect(tab('Movements')).toHaveAttribute('id', 'item-detail-tab-movements');
    expect(tab('Activity')).toHaveAttribute('id', 'item-detail-tab-activity');
  });
});
