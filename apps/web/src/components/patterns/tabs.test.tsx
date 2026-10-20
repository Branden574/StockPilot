import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The shared in-page tab strip. Its link mode carries the item page's tested
 * click feedback (item-detail-tabs.feedback.test.tsx; owner report
 * 2026-09-22), so the same cases run here against the generic strip.
 *
 * next/link is a stand-in with the installed Link's click contract: the
 * page's onClick runs FIRST, a prevented default stops it, modified clicks
 * are left to the browser, otherwise it navigates (`navigate`).
 * `useLinkStatus` reads the nearest Link, from a set of hrefs the test marks
 * pending.
 */

const nav = vi.hoisted(() => ({
  pathname: '/dashboard/rentals/items/r1',
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
    scroll,
    prefetch,
    ...rest
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    href: string;
    scroll?: boolean;
    prefetch?: boolean | null;
  }) {
    return React.createElement(
      Status.Provider,
      { value: { pending: nav.pending.has(href) } },
      React.createElement(
        'a',
        {
          ...rest,
          href,
          'data-scroll': String(scroll),
          'data-prefetch': String(prefetch),
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

import { Tabs, type TabItem } from './tabs';

const BASE = '/dashboard/rentals/items/r1';

/**
 * What a page passes: every tab's own canonical href, the rest of the query
 * carried along. Nothing special for the tab the server rendered: linking it
 * to the URL exactly as it is is the strip's job (pinned below).
 */
function items(search: string): TabItem[] {
  const href = (id: string) => {
    const params = new URLSearchParams(search);
    if (id === 'overview') params.delete('tab');
    else params.set('tab', id);
    const qs = params.toString();
    return qs ? `${BASE}?${qs}` : BASE;
  };
  return [
    { id: 'overview', label: 'Overview', href: href('overview') },
    { id: 'movements', label: 'Movements', href: href('movements') },
    { id: 'activity', label: 'Activity', href: href('activity') },
  ];
}

function Strip({ active }: { active: string }) {
  return (
    <Tabs
      aria-label="Item detail sections"
      idPrefix="item-detail"
      items={items(nav.search)}
      activeId={active}
      scroll={false}
    />
  );
}

function tab(name: string): HTMLElement {
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
function land(rerender: (ui: React.ReactElement) => void, search: string, active: string): void {
  nav.search = search;
  nav.pending.clear();
  rerender(<Strip active={active} />);
}

beforeEach(() => {
  nav.pathname = BASE;
  nav.search = '';
  nav.pending.clear();
  nav.navigate.mockReset();
});

describe('Tabs: semantics', () => {
  it('is a named tablist; the current tab is selected; hrefs are the page`s own', () => {
    render(<Strip active="movements" />);
    expect(screen.getByRole('tablist', { name: 'Item detail sections' })).toBeInTheDocument();
    expect(selected()).toEqual(['Movements']);
    expect(tab('Overview')).toHaveAttribute('href', BASE);
    expect(tab('Activity')).toHaveAttribute('href', `${BASE}?tab=activity`);
  });

  it('gives every tab the id its panel names, and aria-controls for the panel', () => {
    render(<Strip active="overview" />);
    expect(tab('Movements')).toHaveAttribute('id', 'item-detail-tab-movements');
    expect(tab('Movements')).toHaveAttribute('aria-controls', 'item-detail-panel-movements');
  });

  it('passes the page`s scroll and prefetch choices to every link', () => {
    render(<Strip active="overview" />);
    expect(tab('Activity')).toHaveAttribute('data-scroll', 'false');
  });

  it('draws the focus ring inside each tab, so the scrolling strip cannot clip it', () => {
    const { container, rerender } = render(<Strip active="overview" />);
    // The strip scrolls sideways (overflow-x-auto) and each tab fills its
    // height, which clips the global ring drawn 4 px outside a control.
    expect(container.querySelector('.overflow-x-auto')).not.toBeNull();
    for (const t of screen.getAllByRole('tab')) {
      expect(t).toHaveClass('focus-visible:ring-inset', 'focus-visible:ring-offset-0');
    }
    rerender(
      <Tabs
        aria-label="Settings sections"
        activeId="general"
        items={[
          { id: 'general', label: 'General' },
          { id: 'access', label: 'Access' },
        ]}
      />,
    );
    for (const t of screen.getAllByRole('tab')) {
      expect(t).toHaveClass('focus-visible:ring-inset', 'focus-visible:ring-offset-0');
    }
  });

  it('prints a count only where the page passes one', () => {
    const { container } = render(
      <Tabs
        aria-label="Rentals section"
        activeId="items"
        items={[
          { id: 'activity', label: 'Activity', href: '/dashboard/rentals' },
          { id: 'items', label: 'Items', href: '/dashboard/rentals/items', count: 12 },
        ]}
      />,
    );
    const counts = container.querySelectorAll('[data-slot="tab-count"]');
    expect([...counts].map((c) => c.textContent)).toEqual(['12']);
    expect(tab('Activity').textContent).toBe('Activity');
  });
});

describe('Tabs: link mode click feedback', () => {
  it('shows the clicked tab selected at once, before the server has answered', () => {
    render(<Strip active="overview" />);
    fireEvent.click(tab('Movements'));

    expect(nav.navigate).toHaveBeenCalledWith(`${BASE}?tab=movements`);
    expect(selected()).toEqual(['Movements']);
    expect(underline(tab('Movements'))?.className).toContain('bg-foreground');
    expect(underline(tab('Overview'))?.className).toContain('bg-transparent');
  });

  it('a click on the selected tab does nothing: default prevented, router never asked', () => {
    nav.search = 'tab=movements';
    render(<Strip active="movements" />);

    const notPrevented = fireEvent.click(tab('Movements'));

    expect(notPrevented).toBe(false);
    expect(nav.navigate).not.toHaveBeenCalled();
    expect(selected()).toEqual(['Movements']);
  });

  it('the selected tab links to the URL exactly as it is, however the URL spells the tab', () => {
    // NavProgressBar compares a link's href with the address bar: a canonical
    // href here (no ?tab=) would start a bar for a click the strip cancels.
    nav.search = 'tab=overview&from=search';
    render(<Strip active="overview" />);

    expect(tab('Overview')).toHaveAttribute('href', `${BASE}?tab=overview&from=search`);
    expect(fireEvent.click(tab('Overview'))).toBe(false);
    expect(nav.navigate).not.toHaveBeenCalled();
    expect(selected()).toEqual(['Overview']);
    // The other tabs keep the page's own hrefs, the rest of the query carried along.
    expect(tab('Activity')).toHaveAttribute('href', `${BASE}?tab=activity&from=search`);
    expect(tab('Movements')).toHaveAttribute('href', `${BASE}?tab=movements&from=search`);
  });

  it('an unknown ?tab= value: the tab the server fell back to links to that URL too', () => {
    nav.search = 'tab=bogus';
    render(<Strip active="overview" />);

    expect(tab('Overview')).toHaveAttribute('href', `${BASE}?tab=bogus`);
    fireEvent.click(tab('Overview'));
    expect(nav.navigate).not.toHaveBeenCalled();
  });

  it('keeps the page`s href for the selected tab when the current path is unknown', () => {
    nav.pathname = '';
    render(<Strip active="overview" />);

    expect(tab('Overview')).toHaveAttribute('href', BASE);
  });

  it('clicking the tab that is still loading again does not restart its navigation', () => {
    render(<Strip active="overview" />);
    fireEvent.click(tab('Movements'));
    fireEvent.click(tab('Movements'));
    fireEvent.click(tab('Movements'));

    expect(nav.navigate).toHaveBeenCalledTimes(1);
    expect(selected()).toEqual(['Movements']);
  });

  it('pulses the underline while next/link reports the navigation pending, and stops when it lands', () => {
    const { rerender } = render(<Strip active="overview" />);
    fireEvent.click(tab('Movements'));
    nav.pending.add(`${BASE}?tab=movements`);
    rerender(<Strip active="overview" />);
    expect(underline(tab('Movements'))?.className).toContain('animate-pulse');

    land(rerender, 'tab=movements', 'movements');
    expect(selected()).toEqual(['Movements']);
    expect(underline(tab('Movements'))?.className).not.toContain('animate-pulse');
  });

  it('leaves modified clicks (open in a new tab) to the browser, on any tab', () => {
    render(<Strip active="overview" />);

    expect(fireEvent.click(tab('Activity'), { metaKey: true })).toBe(true);
    expect(fireEvent.click(tab('Overview'), { ctrlKey: true })).toBe(true);

    expect(nav.navigate).not.toHaveBeenCalled();
    expect(selected()).toEqual(['Overview']);
  });

  it('gives the real tab back when the navigation ends without the URL moving', () => {
    const { rerender } = render(<Strip active="overview" />);
    fireEvent.click(tab('Movements'));
    nav.pending.add(`${BASE}?tab=movements`);
    rerender(<Strip active="overview" />);
    expect(selected()).toEqual(['Movements']);

    nav.pending.delete(`${BASE}?tab=movements`);
    rerender(<Strip active="overview" />);

    expect(selected()).toEqual(['Overview']);
  });

  it('a quick second click keeps its tab when the first navigation is dropped', () => {
    const { rerender } = render(<Strip active="overview" />);
    fireEvent.click(tab('Movements'));
    nav.pending.add(`${BASE}?tab=movements`);
    rerender(<Strip active="overview" />);

    fireEvent.click(tab('Activity'));
    nav.pending.delete(`${BASE}?tab=movements`);
    nav.pending.add(`${BASE}?tab=activity`);
    rerender(<Strip active="overview" />);

    expect(nav.navigate).toHaveBeenLastCalledWith(`${BASE}?tab=activity`);
    expect(selected()).toEqual(['Activity']);
  });

  it('once the URL moves the URL decides, so Back shows that URL`s tab', () => {
    const { rerender } = render(<Strip active="overview" />);
    fireEvent.click(tab('Movements'));
    land(rerender, 'tab=movements', 'movements');
    expect(selected()).toEqual(['Movements']);

    land(rerender, '', 'overview');

    expect(selected()).toEqual(['Overview']);
  });

  it('clicking the real current tab while another is loading navigates, superseding it', () => {
    render(<Strip active="overview" />);
    fireEvent.click(tab('Movements'));
    fireEvent.click(tab('Overview'));

    expect(nav.navigate).toHaveBeenLastCalledWith(BASE);
    expect(selected()).toEqual(['Overview']);
  });
});

describe('Tabs: activeLinksToHref (a section strip whose current tab resets the view)', () => {
  const SECTION: TabItem[] = [
    { id: 'activity', label: 'Activity', href: '/dashboard/rentals' },
    { id: 'items', label: 'Items', href: '/dashboard/rentals/items' },
  ];
  function Section({ active, opt = true }: { active: string; opt?: boolean }) {
    return (
      <Tabs
        aria-label="Rentals section"
        items={SECTION}
        activeId={active}
        activeLinksToHref={opt}
      />
    );
  }

  it('the current tab keeps its own href, and a click on a filtered URL navigates to it', () => {
    nav.pathname = '/dashboard/rentals/items';
    nav.search = 'q=tent&page=2';
    render(<Section active="items" />);

    expect(tab('Items')).toHaveAttribute('href', '/dashboard/rentals/items');
    fireEvent.click(tab('Items'));
    expect(nav.navigate).toHaveBeenCalledWith('/dashboard/rentals/items');
    expect(selected()).toEqual(['Items']);
  });

  it('on the plain URL a click on the current tab still does nothing', () => {
    nav.pathname = '/dashboard/rentals/items';
    nav.search = '';
    render(<Section active="items" />);

    expect(fireEvent.click(tab('Items'))).toBe(false);
    expect(nav.navigate).not.toHaveBeenCalled();
  });

  it('a tab still loading from a click keeps ignoring further clicks', () => {
    nav.pathname = '/dashboard/rentals';
    nav.search = 'status=returned';
    render(<Section active="activity" />);
    fireEvent.click(tab('Items'));
    fireEvent.click(tab('Items'));

    expect(nav.navigate).toHaveBeenCalledTimes(1);
    expect(selected()).toEqual(['Items']);
  });

  it('without the prop the current tab links to the address bar as it is (default unchanged)', () => {
    nav.pathname = '/dashboard/rentals/items';
    nav.search = 'q=tent';
    render(<Section active="items" opt={false} />);

    expect(tab('Items')).toHaveAttribute('href', '/dashboard/rentals/items?q=tent');
    expect(fireEvent.click(tab('Items'))).toBe(false);
  });
});

describe('Tabs: button mode', () => {
  it('reports the clicked id and follows activeId', () => {
    const onSelect = vi.fn();
    const strip = (active: string) => (
      <Tabs
        aria-label="Settings sections"
        activeId={active}
        onSelect={onSelect}
        items={[
          { id: 'general', label: 'General' },
          { id: 'access', label: 'Access' },
        ]}
      />
    );
    const { rerender } = render(strip('general'));
    expect(tab('Access').tagName).toBe('BUTTON');
    fireEvent.click(tab('Access'));
    expect(onSelect).toHaveBeenCalledWith('access');
    expect(selected()).toEqual(['General']);
    rerender(strip('access'));
    expect(selected()).toEqual(['Access']);
    expect(nav.navigate).not.toHaveBeenCalled();
  });
});
