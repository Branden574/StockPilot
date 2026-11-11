import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The header appearance menu (plans/REVISION-DEFAULT.md R1, R5, R13; section 9
 * items 17, 18, 40): with Liquid Glass in the build, the Design group (Liquid
 * Glass, Classic; the Design in use announced as checked) in front of
 * origin/main's three Theme items, which keep their words and markup and go
 * through the provider (R13, round 2 finding 9). The Design group is the
 * menu's only difference from today (R5, item 46a), so a Classic chooser's
 * menu is origin/main's apart from it. Operable from the keyboard. Under
 * `off`: origin/main's three items, byte for byte.
 *
 * The trigger (DECISIONS.md F6): once mounted, and only while <html> carries
 * data-appearance="liquid-glass", its name and tooltip are "Appearance:
 * design and theme". In Classic, in every rollout, it is origin/main's
 * "Toggle theme" trigger byte for byte; the server render and the first
 * client render are classic too, so hydration never sees a difference.
 */

const { nav } = vi.hoisted(() => ({ nav: { pathname: '/dashboard' } }));
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock('@/server/actions/appearance', () => ({
  setMyAppearanceAction: vi.fn(),
}));

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { hydrateAcrossClockShift } from '@/test/hydration';

import { appearanceStatusText, DESIGN_OPTIONS, THEME_OPTIONS } from './appearance-select';
import { AppearanceProvider } from './appearance-provider';
import { ThemeProvider } from './theme-provider';
import { ThemeToggle } from './theme-toggle';

/** origin/main cde5089de apps/web/src/components/theme/theme-toggle.tsx, verbatim. */
function OriginThemeToggle({ className }: { className?: string } = {}) {
  const { setTheme } = useTheme();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          id="theme-toggle-trigger"
          variant="ghost"
          size="icon"
          aria-label="Toggle theme"
          className={className}
        >
          <Sun className="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
          <Moon className="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => setTheme('light')}>
          <Sun className="mr-2 h-4 w-4" />
          Light
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('dark')}>
          <Moon className="mr-2 h-4 w-4" />
          Dark
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('system')}>
          <Monitor className="mr-2 h-4 w-4" />
          System
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Header({ children = <ThemeToggle /> }: { children?: React.ReactNode }) {
  return (
    <ThemeProvider>
      <AppearanceProvider>{children}</AppearanceProvider>
    </ThemeProvider>
  );
}

/** The trigger's name in Classic: origin/main's words. */
const CLASSIC_NAME = 'Toggle theme';
/** Its name and tooltip while <html> shows Liquid Glass (DECISIONS.md F6). */
const GLASS_NAME = 'Appearance: design and theme';
/** Either name: how a walker finds the trigger in both designs. */
const EITHER_NAME = /^(Toggle theme|Appearance: design and theme)$/u;

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
  nav.pathname = '/dashboard';
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 204 })),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  localStorage.clear();
  document.cookie = 'sp_style=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
  document.documentElement.removeAttribute('data-appearance');
  document.documentElement.removeAttribute('class');
  document.documentElement.removeAttribute('style');
});

const radios = (group: HTMLElement) =>
  within(group)
    .getAllByRole('menuitemradio')
    .map((i) => [i.textContent, i.getAttribute('aria-checked')]);

describe('the options', () => {
  it('Design: Liquid Glass then Classic, with their one-line descriptions; Theme: Light, Dark, System', () => {
    expect(DESIGN_OPTIONS.map((o) => [o.value, o.label, o.description])).toEqual([
      [
        'liquid-glass',
        'Liquid Glass',
        'The standard StockPilot look. Day or Night follows your Theme.',
      ],
      ['classic', 'Classic', 'The previous StockPilot design, unchanged.'],
    ]);
    expect(THEME_OPTIONS.map((o) => [o.value, o.label])).toEqual([
      ['light', 'Light'],
      ['dark', 'Dark'],
      ['system', 'System'],
    ]);
  });
});

const markup = (el: Element) => el.outerHTML.replace(/radix-[^"\s]+/gu, 'radix-id');

/** Open the menu of `node` and return its trigger and menu, Radix ids normalised. */
async function openMenu(node: React.ReactNode) {
  const user = userEvent.setup();
  const view = render(<Header>{node}</Header>);
  const trigger = screen.getByRole('button', { name: EITHER_NAME });
  await user.click(trigger);
  const menu = (await screen.findByRole('menu')).cloneNode(true) as HTMLElement;
  const triggerHtml = markup(trigger);
  view.unmount();
  return { trigger: triggerHtml, menu };
}

/** The mounted trigger of `node` (menu closed), Radix ids normalised. */
function triggerOf(node: React.ReactNode): string {
  const view = render(<Header>{node}</Header>);
  const html = markup(screen.getByRole('button', { name: EITHER_NAME }));
  view.unmount();
  return html;
}

/** An element's attributes (in any order) and its children's markup. */
function shapeOf(html: string) {
  const template = document.createElement('template');
  template.innerHTML = html;
  const el = template.content.firstElementChild!;
  return {
    tag: el.tagName,
    attributes: Object.fromEntries(Array.from(el.attributes, (a) => [a.name, a.value])),
    children: el.innerHTML,
  };
}

describe('the header appearance menu', () => {
  it('keeps its trigger; lists the Design group, as words with the one in use checked, then the three Theme items', async () => {
    localStorage.setItem('theme', 'dark');
    const user = userEvent.setup();
    render(<Header />);
    await user.click(screen.getByRole('button', { name: GLASS_NAME }));
    const design = await screen.findByRole('group', { name: 'Design' });
    expect(radios(design)).toEqual([
      ['Liquid Glass', 'true'],
      ['Classic', 'false'],
    ]);
    const themes = screen.getAllByRole('menuitem').map((i) => i.textContent);
    expect(themes).toEqual(['Light', 'Dark', 'System']);
    const light = screen.getByRole('menuitem', { name: 'Light' });
    expect(design.compareDocumentPosition(light) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it.each(['default', 'opt-in'])(
    '%s: the open menu is origin/main’s, with only the Design group (its label, its two radios, a separator) in front (R5, R13)',
    async (rollout) => {
      vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
      const current = await openMenu(<ThemeToggle />);
      const origin = await openMenu(<OriginThemeToggle />);
      // The trigger: origin/main's in Classic (opt-in, never chose); in glass
      // (default, never chose) only its name and tooltip differ (F6, below).
      expect(shapeOf(current.trigger)).toEqual(
        rollout === 'opt-in'
          ? shapeOf(origin.trigger)
          : {
              ...shapeOf(origin.trigger),
              attributes: {
                ...shapeOf(origin.trigger).attributes,
                'aria-label': GLASS_NAME,
                title: GLASS_NAME,
              },
            },
      );
      // The group's three parts sit in one inert wrapper, the menu's first
      // child (L4 triage BF3; appearance-design-hook.test.tsx): taken out, the
      // menu is origin/main's.
      const wrapper = current.menu.firstElementChild;
      expect(
        wrapper?.outerHTML.startsWith('<div data-appearance-design="" class="contents">'),
      ).toBe(true);
      const [label, group, separator, ...more] = Array.from(wrapper?.children ?? []);
      expect(more).toEqual([]);
      expect(label?.textContent).toBe('Design');
      expect(group?.getAttribute('role')).toBe('group');
      expect(group?.getAttribute('aria-label')).toBe('Design');
      expect(separator?.getAttribute('role')).toBe('separator');
      wrapper?.remove();
      expect(markup(current.menu)).toBe(markup(origin.menu));
    },
  );

  it('chooses Classic from the keyboard, and the Theme stays', async () => {
    localStorage.setItem('theme', 'dark');
    const user = userEvent.setup();
    render(<Header />);
    await waitFor(() =>
      expect(document.documentElement.getAttribute('data-appearance')).toBe('liquid-glass'),
    );
    const trigger = screen.getByRole('button', { name: GLASS_NAME });
    trigger.focus();
    await user.keyboard('{Enter}');
    await screen.findAllByRole('menuitemradio');
    await user.keyboard('{ArrowDown}');
    await waitFor(() =>
      expect(screen.getByRole('menuitemradio', { name: 'Classic' })).toHaveFocus(),
    );
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(document.documentElement.hasAttribute('data-appearance')).toBe(false),
    );
    expect(localStorage.getItem('theme')).toBe('dark');
    // Focus comes back to the same trigger, now under its classic name.
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(trigger).toHaveAccessibleName(CLASSIC_NAME);
  });

  it('a Theme picked here goes through the provider (the person’s own choice), not next-themes alone', async () => {
    localStorage.setItem('theme', 'dark');
    const user = userEvent.setup();
    render(<Header />);
    await user.click(screen.getByRole('button', { name: GLASS_NAME }));
    await user.click(await screen.findByRole('menuitem', { name: 'Light' }));
    await waitFor(() => expect(localStorage.getItem('theme')).toBe('light'));
    expect(JSON.parse(localStorage.getItem('sp-appearance')!)).toMatchObject({ theme: 'light' });
  });

  it('off: the open menu is origin/main’s markup, byte for byte', async () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', '');
    const user = userEvent.setup();
    const open = async (node: React.ReactNode) => {
      const view = render(<Header>{node}</Header>);
      const trigger = screen.getByRole('button', { name: 'Toggle theme' });
      await user.click(trigger);
      const menu = await screen.findByRole('menu');
      const markup = {
        trigger: trigger.outerHTML.replace(/radix-[^"\s]+/gu, 'radix-id'),
        menu: menu.outerHTML.replace(/radix-[^"\s]+/gu, 'radix-id'),
      };
      view.unmount();
      return markup;
    };
    const current = await open(<ThemeToggle />);
    const origin = await open(<OriginThemeToggle />);
    expect(current).toEqual(origin);
    expect(current.menu).not.toContain('Design');
    expect(current.menu).not.toContain('Liquid Glass');
  });
});

describe('the trigger’s name follows the Design on <html> (DECISIONS.md F6)', () => {
  const glassOnHtml = () =>
    document.documentElement.getAttribute('data-appearance') === 'liquid-glass';

  it.each([
    ['default', 'never chose', null],
    ['default', 'chose Liquid Glass', 'liquid-glass'],
    ['opt-in', 'chose Liquid Glass', 'liquid-glass'],
  ])(
    '%s, %s: once mounted, "Appearance: design and theme" is its name and its tooltip, and nothing else differs',
    (rollout, _who, stored) => {
      vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
      if (stored) {
        localStorage.setItem('sp-appearance', JSON.stringify({ v: 2, style: stored }));
        document.cookie = `sp_style=${stored}; path=/`;
      }
      const view = render(<Header />);
      expect(glassOnHtml()).toBe(true);
      const trigger = screen.getByRole('button', { name: GLASS_NAME });
      expect(trigger).toHaveAttribute('title', GLASS_NAME);
      expect(screen.queryByRole('button', { name: CLASSIC_NAME })).toBeNull();
      view.unmount();

      const glass = shapeOf(triggerOf(<ThemeToggle />));
      const origin = shapeOf(triggerOf(<OriginThemeToggle />));
      expect(glass).toEqual({
        ...origin,
        attributes: { ...origin.attributes, 'aria-label': GLASS_NAME, title: GLASS_NAME },
      });
    },
  );

  it.each([
    ['default', 'chose Classic', 'classic'],
    ['opt-in', 'never chose', null],
    ['opt-in', 'chose Classic', 'classic'],
  ])(
    '%s, %s: "Toggle theme" with no tooltip, origin/main’s trigger byte for byte',
    (rollout, _who, stored) => {
      vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
      if (stored) {
        localStorage.setItem('sp-appearance', JSON.stringify({ v: 2, style: stored }));
        document.cookie = `sp_style=${stored}; path=/`;
      }
      const current = triggerOf(<ThemeToggle />);
      expect(glassOnHtml()).toBe(false);
      expect(current).toBe(triggerOf(<OriginThemeToggle />));
      expect(current).toContain(`aria-label="${CLASSIC_NAME}"`);
      expect(current).not.toContain('title=');
    },
  );

  it('off: "Toggle theme" with no tooltip even with Liquid Glass stored and on <html>, origin/main’s trigger byte for byte', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', '');
    localStorage.setItem('sp-appearance', JSON.stringify({ v: 2, style: 'liquid-glass' }));
    document.cookie = 'sp_style=liquid-glass; path=/';
    document.documentElement.setAttribute('data-appearance', 'liquid-glass');
    const current = triggerOf(<ThemeToggle />);
    expect(current).toBe(triggerOf(<OriginThemeToggle />));
    expect(current).toContain(`aria-label="${CLASSIC_NAME}"`);
    expect(current).not.toContain('title=');
  });

  it('follows every switch on the same node: Classic gives back "Toggle theme" and no tooltip, Liquid Glass the glass name', async () => {
    const user = userEvent.setup();
    render(<Header />);
    const trigger = screen.getByRole('button', { name: GLASS_NAME });

    await user.click(trigger);
    await user.click(await screen.findByRole('menuitemradio', { name: 'Classic' }));
    await waitFor(() => expect(glassOnHtml()).toBe(false));
    await waitFor(() => expect(screen.getByRole('button', { name: CLASSIC_NAME })).toBe(trigger));
    expect(trigger).not.toHaveAttribute('title');

    await user.click(trigger);
    await user.click(await screen.findByRole('menuitemradio', { name: 'Liquid Glass' }));
    await waitFor(() => expect(glassOnHtml()).toBe(true));
    await waitFor(() => expect(screen.getByRole('button', { name: GLASS_NAME })).toBe(trigger));
    expect(trigger).toHaveAttribute('title', GLASS_NAME);
  });

  it('the print route is never glass, so there it stays "Toggle theme"; leaving it gives the glass name', () => {
    nav.pathname = '/dashboard/orders/abc/print';
    const { rerender } = render(<Header />);
    expect(glassOnHtml()).toBe(false);
    const trigger = screen.getByRole('button', { name: CLASSIC_NAME });
    expect(trigger).not.toHaveAttribute('title');

    nav.pathname = '/dashboard/orders/abc';
    rerender(<Header />);
    expect(glassOnHtml()).toBe(true);
    expect(screen.getByRole('button', { name: GLASS_NAME })).toBe(trigger);
  });

  const AT = Date.parse('2026-11-03T08:00:00.000Z');

  /**
   * A real server render, then a real hydration in a browser whose head
   * script already put Liquid Glass on <html> (the cookie said so).
   */
  function hydrateWithGlassOnHtml(node: () => React.ReactNode) {
    let renders = 0;
    return hydrateAcrossClockShift(
      () => {
        renders += 1;
        if (renders === 2) document.documentElement.setAttribute('data-appearance', 'liquid-glass');
        return node();
      },
      { serverNow: AT, browserNow: AT },
    );
  }

  it('no hydration mismatch: the server and the first client render say "Toggle theme"; the glass name comes after mount', async () => {
    const run = await hydrateWithGlassOnHtml(() => <Header />);
    try {
      expect(run.html).toContain(`aria-label="${CLASSIC_NAME}"`);
      expect(run.html).not.toContain(GLASS_NAME);
      expect(run.errors).toEqual([]);
      const trigger = within(run.container).getByRole('button', { name: GLASS_NAME });
      expect(trigger).toHaveAttribute('title', GLASS_NAME);
    } finally {
      run.unmount();
    }
  });

  it('the check above sees a mismatch: a name read from <html> during render is reported', async () => {
    function ReadsHtmlInRender() {
      const glass = document.documentElement.getAttribute('data-appearance') === 'liquid-glass';
      return <button type="button" aria-label={glass ? GLASS_NAME : CLASSIC_NAME} />;
    }
    const run = await hydrateWithGlassOnHtml(() => <ReadsHtmlInRender />);
    try {
      expect(run.errors).not.toEqual([]);
    } finally {
      run.unmount();
    }
  });

  it('is on the 8.5 allowlist with its classic twin "Toggle theme", so walkers find it by either name', () => {
    const allowlist = JSON.parse(
      readFileSync(
        join(
          __dirname,
          '..',
          '..',
          '..',
          'tests',
          'e2e',
          'appearance',
          'glass-only-allowlist.json',
        ),
        'utf8',
      ),
    ) as {
      kinds: Record<string, string>;
      entries: { name?: string; kind: string; routes: string[]; [key: string]: unknown }[];
    };
    const entry = allowlist.entries.find((e) => e.name === GLASS_NAME);
    expect(entry).toMatchObject({
      source: 'apps/web/src/components/theme/theme-toggle.tsx',
      selector: '#theme-toggle-trigger',
      role: 'button',
      classicTwin: CLASSIC_NAME,
      gate: null,
    });
    expect(Object.keys(allowlist.kinds)).toContain(entry!.kind);
    // Every page whose classic header holds the menu: the marketing, sign-in,
    // invite and onboarding headers and the dashboard's top bar.
    expect(entry!.routes).toEqual(
      expect.arrayContaining([
        '/',
        '/pricing',
        '/signin',
        '/invite/[token]',
        '/onboarding',
        '/dashboard',
        '/dashboard/**',
      ]),
    );
  });
});

describe('the account line', () => {
  it('never claims the account holds the choice unless the server said so', () => {
    expect(appearanceStatusText('synced')).toBe('Saved to your account.');
    for (const status of ['saving', 'failed', 'unavailable', 'signed-out'] as const) {
      expect(appearanceStatusText(status)).not.toMatch(/Saved to your account\./u);
    }
    expect(appearanceStatusText('idle')).toBeNull();
    expect(appearanceStatusText(null)).toBeNull();
  });
});
