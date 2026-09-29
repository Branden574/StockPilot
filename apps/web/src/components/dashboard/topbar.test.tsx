import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

const { setTheme } = vi.hoisted(() => ({ setTheme: vi.fn() }));

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard/inventory/new',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
}));
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
    expect(at(within(bar).getByRole('navigation', { name: 'Breadcrumb' }))).toEqual(['@min-[520px]:flex']);
    for (const name of ['Keyboard shortcuts (?)', 'Help & Learning', 'Support & feedback']) {
      const el = within(bar).queryByRole('button', { name }) ?? within(bar).getByRole('link', { name });
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

    expect(classesOf(within(bar).getByRole('navigation', { name: 'Breadcrumb' }))).toContain('min-w-0');
    const picker = within(bar).getByRole('button', { name: /^Filter by/ });
    expect(classesOf(picker)).toEqual(expect.arrayContaining(['min-w-0', 'max-w-full']));
    expect(classesOf(picker.parentElement!)).toContain('min-w-0');
    const name = within(picker).getByText('Demo Distribution Center');
    expect(classesOf(name)).toEqual(expect.arrayContaining(['min-w-0', 'truncate']));
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
    render(<UserMenu email="demo@example.com" fullName="Demo User" avatarUrl={null} organizationName="Demo Co" />);
    await user.click(screen.getByRole('button', { name: /^Account menu/ }));

    const help = await screen.findByRole('menuitem', { name: 'Help & Learning' });
    expect(help.getAttribute('href')).toBe('/dashboard/help');
    expect(screen.getByRole('menuitem', { name: 'Support & feedback' }).getAttribute('href')).toBe(
      '/dashboard/support',
    );
    // The menu's items are not hidden at any width (only the bar's are).
    for (const item of [...screen.getAllByRole('menuitem'), ...screen.getAllByRole('menuitemradio')]) {
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
      .filter((el) => classesOf(el).includes('hidden') || classesOf(el.parentElement!).includes('hidden'))
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
    render(<UserMenu email="demo@example.com" fullName="Demo User" avatarUrl={null} organizationName="Demo Co" />);
    await user.click(screen.getByRole('button', { name: /^Account menu/ }));
    const menu = await screen.findByRole('menu');
    expect(classesOf(menu)).toEqual(
      expect.arrayContaining(['max-h-[var(--radix-dropdown-menu-content-available-height)]', 'overflow-y-auto']),
    );
    // The shared menu's overflow-hidden stays in the list; Tailwind writes
    // overflow-y after overflow, so auto wins (computed overflow-y measured in
    // Chromium: stockpilot-work/small-fixes/menu-check).
  });

  // Mutation caught: the theme back to three plain items, which do not say
  // which one is in use.
  it('marks the theme in use, and switches with one tap', async () => {
    const user = userEvent.setup();
    render(<UserMenu email="demo@example.com" fullName="Demo User" avatarUrl={null} organizationName="Demo Co" />);
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
