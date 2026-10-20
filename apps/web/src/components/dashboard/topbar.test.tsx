import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { setTheme, nav } = vi.hoisted(() => ({
  setTheme: vi.fn(),
  nav: { pathname: '/dashboard/inventory/new', prefetch: vi.fn() },
}));

vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), prefetch: nav.prefetch, refresh: vi.fn() }),
}));
// The real Link, with the prefetch it was given written on its anchor
// (data-prefetch), so a test can read what each link in the bar asks for.
vi.mock('next/link', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/link')>();
  const RealLink = actual.default;
  function Link(props: React.ComponentProps<typeof RealLink>) {
    return <RealLink {...props} data-prefetch={String(props.prefetch)} />;
  }
  return { ...actual, default: Link };
});
vi.mock('next-themes', () => ({ useTheme: () => ({ setTheme, theme: 'light' }) }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }));
vi.mock('@/lib/supabase/realtime-auth', () => ({ ensureRealtimeAuth: vi.fn() }));
vi.mock('@/lib/analytics', () => ({ reset: vi.fn(), identify: vi.fn() }));
vi.mock('@/server/actions/auth', () => ({ signOutAction: vi.fn() }));

import { Topbar } from './topbar';
import { UserMenu } from './user-menu';

/**
 * THE TOP BAR FITS ITS WIDTH (walk 2026-09-28/29: at 390px the account avatar
 * was cut off at the right edge, with no way to scroll to it).
 *
 * Laid out in Chromium with the built CSS (stockpilot-work/small-fixes/
 * header-check), the old bar needed ~403px at its narrowest: every icon button
 * shrank to 14px and the avatar still ended 13px past a 390px screen, 43px past
 * 360px, and wholly off screen at 768px beside the 244px sidebar. The shell
 * clips overflow, so nothing scrolled. jsdom has no layout, so these pin the
 * rules that make it fit, which that check measured at 320-1440px:
 *  - the bar is a size container and each optional control is shown only
 *    when the bar's own width has room for it (not the window's: the sidebar
 *    takes 244px of it);
 *  - buttons never shrink; only the breadcrumb and the warehouse name yield;
 *  - what a narrow bar leaves out is still in the account menu.
 */

function renderBar() {
  render(
    <Topbar
      email="demo@example.com"
      fullName="Demo User"
      avatarUrl={null}
      organizationName="Demo Co"
      userId="u1"
      organizationId="o1"
      sidebarHidden
      warehouseFilter={{
        warehouses: [{ id: 'w1', name: 'Demo Distribution Center' }],
        activeId: 'w1',
        warehouseLabel: 'Warehouse',
      }}
    />,
  );
  return screen.getByRole('banner');
}

const classesOf = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/);

beforeEach(() => {
  nav.pathname = '/dashboard/inventory/new';
  nav.prefetch.mockReset();
});

describe('the top bar decides what fits from its own width', () => {
  it('is a size container, so the sidebar beside it is taken into account', () => {
    expect(classesOf(renderBar())).toContain('@container');
  });

  // Mutation caught: a control shown at every width again (the old bar), or
  // one of the always-there controls hidden.
  it('shows the optional controls only when the bar is wide enough, and the rest always', () => {
    const bar = renderBar();
    const at = (el: Element) => {
      const c = classesOf(el);
      return c.includes('hidden') ? c.filter((x) => x.startsWith('@min-')) : 'always';
    };
    expect(at(within(bar).getByRole('navigation', { name: 'Breadcrumb' }))).toEqual([
      '@min-[520px]:flex',
    ]);
    for (const name of ['Keyboard shortcuts (?)', 'Help & Learning', 'Support & feedback']) {
      const el =
        within(bar).queryByRole('button', { name }) ?? within(bar).getByRole('link', { name });
      expect(at(el), name).toEqual(['@min-[680px]:grid']);
    }
    // The theme switch sits in a wrapper that carries the rule.
    expect(at(within(bar).getByRole('button', { name: 'Toggle theme' }).parentElement!)).toEqual([
      '@min-[680px]:flex',
    ]);
    // Search: an icon from 400px, the full bar from 960px; never both.
    const search = within(bar).getAllByRole('button', { name: 'Open command palette' });
    expect(search.map(at)).toEqual([
      ['@min-[400px]:grid', '@min-[960px]:hidden'],
      ['@min-[960px]:flex'],
    ]);
    const always: Array<['button' | 'link', RegExp]> = [
      ['button', /sidebar/],
      ['link', /^Notifications/],
      ['button', /^What.s new/],
      ['button', /^Account menu/],
      ['button', /^Filter by/],
    ];
    for (const [role, name] of always) {
      expect(at(within(bar).getByRole(role, { name })), String(name)).toBe('always');
    }
  });

  // Mutation caught: shrink-0 dropped from any button (it squeezes to its
  // 14px icon again), or the picker made rigid (it pushes the avatar out).
  it('never shrinks a button; only the breadcrumb and the warehouse name give way', () => {
    const bar = renderBar();
    const buttons = [
      within(bar).getByRole('button', { name: /sidebar/ }),
      within(bar).getByRole('link', { name: /^Notifications/ }),
      within(bar).getByRole('button', { name: /^What.s new/ }),
      within(bar).getByRole('button', { name: 'Keyboard shortcuts (?)' }),
      within(bar).getByRole('link', { name: 'Help & Learning' }),
      within(bar).getByRole('link', { name: 'Support & feedback' }),
      within(bar).getByRole('button', { name: 'Toggle theme' }).parentElement!,
      within(bar).getByRole('button', { name: /^Account menu/ }),
      within(bar).getAllByRole('button', { name: 'Open command palette' })[0]!,
    ];
    for (const b of buttons) expect(classesOf(b), b.outerHTML.slice(0, 80)).toContain('shrink-0');

    expect(classesOf(within(bar).getByRole('navigation', { name: 'Breadcrumb' }))).toContain(
      'min-w-0',
    );
    // The picker can still narrow to its icons (min-w-16, P68-01: its own
    // floor, so its chevron never sits outside it), and its name truncates.
    const picker = within(bar).getByRole('button', { name: /^Filter by/ });
    expect(classesOf(picker)).toEqual(expect.arrayContaining(['min-w-16', 'max-w-full']));
    expect(classesOf(picker.parentElement!)).toContain('min-w-0');
    const name = within(picker).getByText('Demo Distribution Center');
    expect(classesOf(name)).toEqual(expect.arrayContaining(['min-w-0', 'truncate']));
  });
});

/**
 * P68-01 (verified in Chromium and WebKit): on a touch tablet, where every
 * icon button is 44px, the picker gave up its width before the trail did
 * (flex-shrink 10 to 1): "Al…" on New order at 810px, 4 of 92px at 744px, and
 * on Settings > Roles at 1024px a 22px button with no name and its chevron
 * outside it, where the bar before the redesign showed "All warehouses"
 * whole. The trail now gives way first, in steps (topbar-trail-fit.ts).
 */
describe('the trail gives way before the warehouse picker', () => {
  // Mutation caught: the picker allowed to shrink again where a trail can be
  // shown, or made rigid on a phone (a long name would push the avatar out).
  it('from a 520px bar the picker never shrinks; under 520px, with no trail, it is the one that yields', () => {
    const bar = renderBar();
    const wrapper = within(bar).getByRole('button', { name: /^Filter by/ }).parentElement!;
    expect(classesOf(wrapper)).toEqual(
      expect.arrayContaining(['@min-[520px]:shrink-0', 'min-w-0', 'ml-auto']),
    );
    expect(classesOf(wrapper).filter((c) => /^shrink/.test(c))).toEqual([]);
    // The trail is shown from the same 520px.
    expect(classesOf(within(bar).getByRole('navigation', { name: 'Breadcrumb' }))).toContain(
      '@min-[520px]:flex',
    );
  });

  // Mutation caught: the min-width dropped (the chevron overflows a squeezed
  // button again) or set above the picker's own icons and padding.
  it("the picker's floor is exactly its icons and padding, so its chevron is always inside it", () => {
    const picker = within(renderBar()).getByRole('button', { name: /^Filter by/ });
    expect(classesOf(picker)).toEqual(
      expect.arrayContaining(['min-w-16', 'px-2.5', 'gap-2', 'border']),
    );
    // 1px border + 10px padding a side + 14px icon + two 8px gaps + 12px
    // chevron = 64px = min-w-16 (4rem): the parts that floor is made of.
    const [icon, chevron] = Array.from(picker.querySelectorAll('svg'));
    expect(classesOf(icon!)).toEqual(expect.arrayContaining(['size-3.5', 'shrink-0']));
    expect(classesOf(chevron!)).toEqual(expect.arrayContaining(['size-3', 'shrink-0']));
  });

  // Mutation caught: the accessible name back to "Filter by warehouse" alone,
  // which a truncated name leaves no way to read, or the title dropped.
  it('names the whole warehouse in its accessible name and its title, however much of it shows', () => {
    const picker = within(renderBar()).getByRole('button', {
      name: 'Filter by warehouse: Demo Distribution Center',
    });
    expect(picker).toHaveAttribute('title', 'Filter by warehouse: Demo Distribution Center');
  });
});

/**
 * The steps themselves, in a bar whose widths are stubbed (happy-dom has no
 * layout): a ResizeObserver the test fires, the bar's inside width, the
 * picker's width and the measuring copy's widths.
 */
describe('the trail steps down: whole, then the current page alone, then none', () => {
  const FULL = 180; // "Fulfillment / Orders / New"
  const CURRENT = 28.8; // "New"
  const PICKER = 156.5;
  let inside = 1000;
  let fire: () => void = () => {};
  const restore: Array<() => void> = [];

  beforeEach(() => {
    nav.pathname = '/dashboard/orders/new';
    inside = 1000;
    const RealRO = globalThis.ResizeObserver;
    class FiringResizeObserver {
      constructor(cb: () => void) {
        fire = () => cb();
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    globalThis.ResizeObserver = FiringResizeObserver as unknown as typeof ResizeObserver;
    const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return this.tagName === 'HEADER' ? inside : 0;
      },
    });
    const rect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const measure = document.querySelector('[data-slot="topbar-trail-measure"] > div');
      const width =
        this === measure
          ? FULL
          : this === measure?.lastElementChild
            ? CURRENT
            : this.querySelector(':scope > button[aria-label^="Filter by"]')
              ? PICKER
              : 0;
      return { width, height: 0, top: 0, left: 0, right: width, bottom: 0, x: 0, y: 0 } as DOMRect;
    };
    restore.push(() => {
      globalThis.ResizeObserver = RealRO;
      if (clientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidth);
      else delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
      Element.prototype.getBoundingClientRect = rect;
    });
  });
  afterEach(() => {
    while (restore.length) restore.pop()!();
  });

  const crumbsShown = (bar: HTMLElement) => {
    const trail = within(bar).queryByRole('navigation', { name: 'Breadcrumb' });
    return trail
      ? within(trail)
          .getAllByRole('listitem')
          .map((li) => li.textContent)
      : null;
  };

  // Mutation caught: the parents dropped one at a time instead (no such step
  // was asked for), a slash left before the lone current page, the landmark
  // kept with nothing in it, or the step not measured again on a resize.
  it('picks the step from the room left beside the picker, and again when the bar resizes', () => {
    const bar = renderBar();
    // Room 1000 - 156.5: the whole trail (each later crumb after its slash).
    expect(crumbsShown(bar)).toEqual(['Fulfillment', '/Orders', '/New']);

    // Room 120: the current page alone, as the current page, with no slash.
    inside = PICKER + 120;
    act(() => fire());
    expect(crumbsShown(bar)).toEqual(['New']);
    const trail = within(bar).getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(trail).getByText('New')).toHaveAttribute('aria-current', 'page');
    expect(within(trail).queryByText('/')).toBeNull();
    expect(within(trail).queryByRole('link')).toBeNull();

    // Room 20: no trail, and no empty landmark.
    inside = PICKER + 20;
    act(() => fire());
    expect(crumbsShown(bar)).toBeNull();

    // Wider again: back to the whole trail, with its link.
    inside = 1000;
    act(() => fire());
    expect(crumbsShown(bar)).toHaveLength(3);
    expect(within(bar).getByRole('link', { name: 'Orders' })).toHaveAttribute(
      'href',
      '/dashboard/orders',
    );
  });

  // The picker is the same button at every step: the step only ever takes
  // from the trail.
  it('never changes the picker or any other control', () => {
    const bar = renderBar();
    const before = within(bar)
      .getAllByRole('button')
      .map((b) => [b.getAttribute('aria-label'), b.className]);
    inside = PICKER + 20;
    act(() => fire());
    expect(
      within(bar)
        .getAllByRole('button')
        .map((b) => [b.getAttribute('aria-label'), b.className]),
    ).toEqual(before);
  });

  // The copy that gives the widths is never read out, never clicked and never
  // in the flow: hidden from the accessibility tree, out of the flex row.
  it('measures from an invisible copy that no reader, pointer or layout sees', () => {
    const bar = renderBar();
    const copy = bar.querySelector('[data-slot="topbar-trail-measure"]')!;
    expect(copy).toHaveAttribute('aria-hidden', 'true');
    expect(classesOf(copy)).toEqual(
      expect.arrayContaining([
        'invisible',
        'pointer-events-none',
        'absolute',
        'h-0',
        'overflow-hidden',
      ]),
    );
    expect(copy.querySelector('a, button, [tabindex]')).toBeNull();
    expect(copy.textContent).toBe('Fulfillment/Orders/New');
  });
});

/**
 * The narrowest bar that ever showed search before this change: the old bar
 * showed it from the md breakpoint (768px), and from there the 244px sidebar
 * can sit beside the bar, which is then 768 - 244 = 524px, less its 20px
 * padding each side (sm:px-5) = 484px of content. Search must be in the bar at
 * every width from there up, so no window that had search loses it (review of
 * 2026-09-29: at 680px the iPad portrait widths 768-834px beside the sidebar
 * had lost it, and touch has no ⌘K).
 */
const OLD_SEARCH_MIN_BAR_WIDTH = 768 - 244 - 2 * 20;

const minWidthOf = (el: Element) => {
  const shown = classesOf(el).find((c) => /^@min-\[\d+px\]:(grid|flex)$/.test(c));
  return shown ? Number(/\d+/.exec(shown)![0]) : 0;
};

describe('what a narrow bar leaves out can still be reached', () => {
  // Mutation caught: an item removed from the menu (on a phone the page it
  // opens would be unreachable), or pointed somewhere else.
  it('Help & Learning, Support & feedback and the theme are in the account menu at every width', async () => {
    const user = userEvent.setup();
    render(
      <UserMenu
        email="demo@example.com"
        fullName="Demo User"
        avatarUrl={null}
        organizationName="Demo Co"
      />,
    );
    await user.click(screen.getByRole('button', { name: /^Account menu/ }));

    const help = await screen.findByRole('menuitem', { name: 'Help & Learning' });
    expect(help.getAttribute('href')).toBe('/dashboard/help');
    expect(screen.getByRole('menuitem', { name: 'Support & feedback' }).getAttribute('href')).toBe(
      '/dashboard/support',
    );
    // The menu's items are not hidden at any width (only the bar's are).
    for (const item of [
      ...screen.getAllByRole('menuitem'),
      ...screen.getAllByRole('menuitemradio'),
    ]) {
      expect(classesOf(item).some((c) => c === 'hidden' || c.includes('hidden'))).toBe(false);
    }

    await user.click(screen.getByRole('menuitemradio', { name: 'Dark' }));
    expect(setTheme).toHaveBeenCalledWith('dark');
  });

  // Mutation caught: the search icon's width raised back above what a 768px
  // window with the sidebar gives the bar.
  it('search stays in the bar at every width that showed it before', () => {
    const bar = renderBar();
    const [icon, full] = within(bar).getAllByRole('button', { name: 'Open command palette' });
    expect(minWidthOf(icon!)).toBeGreaterThan(0);
    expect(minWidthOf(icon!)).toBeLessThanOrEqual(OLD_SEARCH_MIN_BAR_WIDTH);
    // The icon hands over to the full bar exactly where the full bar appears.
    expect(classesOf(icon!)).toContain(`@min-[${minWidthOf(full!)}px]:hidden`);
  });

  // Every control the bar can leave out, and where it is found instead. A new
  // optional control fails here until it has somewhere else to be.
  it('every control the bar can leave out is reached another way', () => {
    const bar = renderBar();
    // The breadcrumb is left out whole under 520px: the page's own heading
    // names the page, and its links are pages the sidebar opens.
    const crumbs = within(bar).getByRole('navigation', { name: 'Breadcrumb' });
    const optional = [...within(bar).getAllByRole('button'), ...within(bar).getAllByRole('link')]
      .filter((el) => !crumbs.contains(el))
      .filter(
        (el) => classesOf(el).includes('hidden') || classesOf(el.parentElement!).includes('hidden'),
      )
      .map((el) => el.getAttribute('aria-label'));
    expect(optional.sort()).toEqual(
      [
        // In the account menu (the test above).
        'Help & Learning',
        'Support & feedback',
        'Toggle theme',
        // The "?" key opens it (keyboard-shortcuts.tsx); touch screens have no
        // use for a list of keyboard shortcuts.
        'Keyboard shortcuts (?)',
        // The icon and the full bar: one of them from 400px (the test above);
        // under that, as before this change, ⌘K.
        'Open command palette',
        'Open command palette',
      ].sort(),
    );
  });

  it('every link the bar can leave out has the same destination in the menu', async () => {
    const bar = renderBar();
    const leftOut = within(bar)
      .getAllByRole('link')
      .filter((a) => classesOf(a).includes('hidden'))
      .map((a) => a.getAttribute('href'));
    expect(leftOut).toEqual(['/dashboard/help', '/dashboard/support']);

    const user = userEvent.setup();
    await user.click(within(bar).getByRole('button', { name: /^Account menu/ }));
    await screen.findByRole('menu');
    const inMenu = screen.getAllByRole('menuitem').map((m) => m.getAttribute('href'));
    for (const href of leftOut) expect(inMenu).toContain(href);
  });
});

describe('the account menu fits a short screen, and shows the theme in use', () => {
  // Review of 2026-09-29: with Help, Support and the theme added, the menu is
  // about 390px tall. On a phone held sideways (about 330-370px of page) it ran
  // past the bottom with no way to scroll to Sign out: the menu clipped its
  // overflow and the page behind it is locked while it is open.
  // Mutation caught: the height cap or the scroll dropped.
  it('is never taller than the room Radix measures below the button, and scrolls inside', async () => {
    const user = userEvent.setup();
    render(
      <UserMenu
        email="demo@example.com"
        fullName="Demo User"
        avatarUrl={null}
        organizationName="Demo Co"
      />,
    );
    await user.click(screen.getByRole('button', { name: /^Account menu/ }));
    const menu = await screen.findByRole('menu');
    expect(classesOf(menu)).toEqual(
      expect.arrayContaining([
        'max-h-[var(--radix-dropdown-menu-content-available-height)]',
        'overflow-y-auto',
      ]),
    );
    // The shared menu's overflow-hidden stays in the list; Tailwind writes
    // overflow-y after overflow, so auto wins (computed overflow-y measured in
    // Chromium: stockpilot-work/small-fixes/menu-check).
  });

  // Mutation caught: the theme back to three plain items, which do not say
  // which one is in use.
  it('marks the theme in use, and switches with one tap', async () => {
    const user = userEvent.setup();
    render(
      <UserMenu
        email="demo@example.com"
        fullName="Demo User"
        avatarUrl={null}
        organizationName="Demo Co"
      />,
    );
    await user.click(screen.getByRole('button', { name: /^Account menu/ }));
    const themes = await screen.findAllByRole('menuitemradio');
    expect(themes.map((t) => [t.textContent, t.getAttribute('aria-checked')])).toEqual([
      ['Light', 'true'],
      ['Dark', 'false'],
      ['System', 'false'],
    ]);
    await user.click(screen.getByRole('menuitemradio', { name: 'System' }));
    expect(setTheme).toHaveBeenCalledWith('system');
  });
});

describe('the redesigned bar (DESIGN-SPEC 5.2)', () => {
  // Mutation caught: the old translucent bar back (blur costs a repaint per
  // scroll frame), or a height change the storefront's --sf-topbar-h: 56px
  // would not follow.
  it('is a solid 56px bar on the page colour, with no blur', () => {
    const bar = renderBar();
    expect(bar.style.height).toBe('56px');
    expect(classesOf(bar)).toContain('bg-background');
    expect(classesOf(bar).some((c) => c.includes('backdrop-blur') || c.includes('color-mix'))).toBe(
      false,
    );
  });

  it('the breadcrumb is a list whose last crumb is the current page; the slashes are not read out', () => {
    const bar = renderBar();
    const crumbs = within(bar).getByRole('navigation', { name: 'Breadcrumb' });
    const items = within(crumbs).getAllByRole('listitem');
    // /dashboard/inventory/new: Inventory / Items / New.
    expect(items.map((li) => li.textContent?.replace('/', '').trim())).toEqual([
      'Inventory',
      'Items',
      'New',
    ]);
    expect(within(crumbs).getByText('New')).toHaveAttribute('aria-current', 'page');
    expect(within(crumbs).getByRole('link', { name: 'Items' })).toHaveAttribute(
      'href',
      '/dashboard/inventory',
    );
    for (const slash of within(crumbs).getAllByText('/')) {
      expect(slash).toHaveAttribute('aria-hidden');
    }
  });

  it('every icon button is the 32px size', () => {
    const bar = renderBar();
    for (const name of [/sidebar/, 'Keyboard shortcuts (?)', 'Toggle theme']) {
      expect(classesOf(within(bar).getByRole('button', { name })), String(name)).toContain(
        'size-8',
      );
    }
    for (const name of [/^Notifications/, 'Help & Learning', 'Support & feedback']) {
      expect(classesOf(within(bar).getByRole('link', { name })), String(name)).toContain('size-8');
    }
  });

  it('the warehouse picker says the org\'s own plural for "All"', () => {
    render(
      <Topbar
        email="demo@example.com"
        fullName="Demo User"
        avatarUrl={null}
        organizationName="Demo Co"
        userId="u1"
        organizationId="o1"
        warehouseFilter={{
          warehouses: [{ id: 'w1', name: 'North campus' }],
          activeId: null,
          warehouseLabel: 'Campus',
          warehousePluralLabel: 'Campuses',
        }}
      />,
    );
    // The accessible name holds the name it shows (P68-01).
    expect(
      screen.getByRole('button', { name: 'Filter by campus: All campuses' }),
    ).toHaveTextContent('All campuses');
  });
});

describe('Density in the account menu', () => {
  // A new per-viewer choice beside Theme (PLAN P2.3): Comfortable or Compact,
  // the one in use marked, one tap to switch.
  it('offers Comfortable and Compact, marks the one in use, and reports a change', async () => {
    const onDensityChange = vi.fn();
    const user = userEvent.setup();
    render(
      <UserMenu
        email="demo@example.com"
        fullName="Demo User"
        avatarUrl={null}
        organizationName="Demo Co"
        density="comfortable"
        onDensityChange={onDensityChange}
      />,
    );
    await user.click(screen.getByRole('button', { name: /^Account menu/ }));
    const density = await screen.findByRole('group', { name: 'Density' });
    const radios = within(density).getAllByRole('menuitemradio');
    expect(radios.map((r) => [r.textContent, r.getAttribute('aria-checked')])).toEqual([
      ['Comfortable', 'true'],
      ['Compact', 'false'],
    ]);
    await user.click(screen.getByRole('menuitemradio', { name: 'Compact' }));
    expect(onDensityChange).toHaveBeenCalledWith('compact');
  });

  it('the theme choice is still there, beside it', async () => {
    const user = userEvent.setup();
    render(
      <UserMenu
        email="demo@example.com"
        fullName="Demo User"
        avatarUrl={null}
        organizationName="Demo Co"
        density="compact"
        onDensityChange={() => {}}
      />,
    );
    await user.click(screen.getByRole('button', { name: /^Account menu/ }));
    const radios = await screen.findAllByRole('menuitemradio');
    expect(radios.map((r) => r.textContent)).toEqual([
      'Light',
      'Dark',
      'System',
      'Comfortable',
      'Compact',
    ]);
    expect(screen.getByRole('menuitemradio', { name: 'Compact' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });
});

/**
 * NO LINK IN THE BAR PREFETCHES ITS PAGE ON SIGHT (PLAN 0.6; review of
 * 2026-10-18). The bar is on every dashboard page, and in a production build
 * a default <Link> prefetches its page as soon as it is in view: two requests,
 * each a full dynamic render of the dashboard layout, on every page view.
 * Measured on the frozen 36cb9b619 build: every page fired them for
 * Notifications, Help and Support, and /dashboard/settings/billing fired them
 * for /dashboard/settings from the Settings crumb alone. Each link is warmed
 * when a person comes to it instead, as the sidebar's links are.
 */
describe('the bar warms its pages when a person comes to a link, never on sight', () => {
  // A trail with two parent links: Purchasing / Purchase orders / PO imports / New.
  const PATH = '/dashboard/purchase-orders/imports/new';
  const LINKS = [
    '/dashboard/purchase-orders',
    '/dashboard/purchase-orders/imports',
    '/dashboard/notifications',
    '/dashboard/help',
    '/dashboard/support',
  ];

  /** A spy's calls with every non-string reduced to its type, safe to print. */
  const callsOf = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.map((args) => args.map((a) => (typeof a === 'string' ? a : `<${typeof a}>`)));

  // Mutation caught: prefetch={false} dropped from any crumb, the bell, Help
  // or Support, or a new link added to the bar without it.
  it('every link in the bar is rendered with prefetch={false}', () => {
    nav.pathname = PATH;
    const bar = renderBar();
    const links = within(bar).getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href')).sort()).toEqual([...LINKS].sort());
    for (const a of links) {
      expect(a, a.getAttribute('href') ?? '').toHaveAttribute('data-prefetch', 'false');
    }
    expect(callsOf(nav.prefetch)).toEqual([]);
  });

  // Mutation caught: a link left with no warm-up (its click then waits for the
  // whole page), or a handler that hands the warm-up the event, not the href.
  it.each([
    ['hover', (el: Element) => fireEvent.pointerEnter(el)],
    ['keyboard focus', (el: Element) => fireEvent.focus(el)],
    ['pointer-down', (el: Element) => fireEvent.pointerDown(el)],
  ])('%s on a crumb, the bell, Help or Support warms that page', (_label, approach) => {
    nav.pathname = PATH;
    const bar = renderBar();
    for (const href of LINKS) {
      nav.prefetch.mockClear();
      const link = within(bar)
        .getAllByRole('link')
        .find((a) => a.getAttribute('href') === href)!;
      approach(link);
      expect(callsOf(nav.prefetch), href).toEqual([[href]]);
    }
  });
});

/**
 * THE ACCOUNT MENU WARMS A PAGE WHEN A PERSON COMES TO ITS ITEM, NEVER WHEN IT
 * OPENS (PLAN 0.6; P2.3 review follow-up). A default <Link> prefetches as soon
 * as it is on screen, so opening the menu fetched Profile, Settings, Help,
 * Support and Platform at once: two requests each, every one a full dynamic
 * render. Each item now warms its page on hover, keyboard focus (the arrows
 * move focus through the menu) or pointer-down, as the bar's links do.
 */
describe('the account menu warms its pages on approach, never when it opens', () => {
  const MENU_LINKS = [
    '/dashboard/settings/profile',
    '/dashboard/settings',
    '/dashboard/help',
    '/dashboard/support',
    '/platform',
  ];

  const callsOf = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.map((args) => args.map((a) => (typeof a === 'string' ? a : `<${typeof a}>`)));

  async function openMenu() {
    const user = userEvent.setup();
    render(
      <UserMenu
        email="demo@example.com"
        fullName="Demo User"
        avatarUrl={null}
        organizationName="Demo Co"
        isPlatformAdmin
      />,
    );
    await user.click(screen.getByRole('button', { name: /^Account menu/ }));
    const menu = await screen.findByRole('menu');
    return within(menu)
      .getAllByRole('menuitem')
      .filter((item) => item.tagName === 'A');
  }

  // Mutation caught: prefetch={false} dropped from any item, or a new link
  // added to the menu without it.
  it('every link in the menu is rendered with prefetch={false}, and opening it warms nothing', async () => {
    const links = await openMenu();
    expect(links.map((a) => a.getAttribute('href'))).toEqual(MENU_LINKS);
    for (const a of links) {
      expect(a, a.getAttribute('href') ?? '').toHaveAttribute('data-prefetch', 'false');
    }
    expect(callsOf(nav.prefetch)).toEqual([]);
  });

  // Mutation caught: an item left with no warm-up (its click then waits for
  // the whole page), or a handler that hands the warm-up the event.
  it.each([
    ['hover', (el: Element) => fireEvent.pointerEnter(el)],
    ['keyboard focus', (el: Element) => fireEvent.focus(el)],
    ['pointer-down', (el: Element) => fireEvent.pointerDown(el)],
  ])('%s on an item warms exactly that page', async (_label, approach) => {
    const links = await openMenu();
    for (const link of links) {
      const href = link.getAttribute('href')!;
      nav.prefetch.mockClear();
      approach(link);
      expect(callsOf(nav.prefetch), href).toEqual([[href]]);
    }
  });

  // P2.2's DropdownMenuLabel writes its content uppercase (the group labels
  // Theme and Density want that). Mutation caught: the identity block's
  // normal-case override dropped, which would shout the person's name, email
  // and organization.
  it("keeps the person's name, email and organization in their own case", async () => {
    await openMenu();
    // The label holds the avatar and a column of name, email and organization.
    const identity = screen.getByText('demo@example.com').parentElement!.parentElement!;
    expect(identity).toHaveTextContent(/Demo User\s*demo@example\.com\s*Demo Co/);
    expect(classesOf(identity)).toContain('normal-case');
    expect(classesOf(identity)).not.toContain('uppercase');
  });
});
