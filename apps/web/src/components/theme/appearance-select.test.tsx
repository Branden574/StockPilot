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
 */

vi.mock('@/server/actions/appearance', () => ({
  getMyAppearanceAction: vi.fn(),
  setMyAppearanceAction: vi.fn(),
}));

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

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

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
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

/** Open the menu of `node` and return its trigger and menu, Radix ids normalised. */
async function openMenu(node: React.ReactNode) {
  const user = userEvent.setup();
  const view = render(<Header>{node}</Header>);
  const trigger = screen.getByRole('button', { name: 'Toggle theme' });
  await user.click(trigger);
  const menu = (await screen.findByRole('menu')).cloneNode(true) as HTMLElement;
  const triggerHtml = trigger.outerHTML.replace(/radix-[^"\s]+/gu, 'radix-id');
  view.unmount();
  return { trigger: triggerHtml, menu };
}
const markup = (el: Element) => el.outerHTML.replace(/radix-[^"\s]+/gu, 'radix-id');

describe('the header appearance menu', () => {
  it('keeps its trigger; lists the Design group, as words with the one in use checked, then the three Theme items', async () => {
    localStorage.setItem('theme', 'dark');
    const user = userEvent.setup();
    render(<Header />);
    await user.click(screen.getByRole('button', { name: 'Toggle theme' }));
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
      expect(current.trigger).toBe(origin.trigger);
      const [label, group, separator] = Array.from(current.menu.children);
      expect(label?.textContent).toBe('Design');
      expect(group?.getAttribute('role')).toBe('group');
      expect(group?.getAttribute('aria-label')).toBe('Design');
      expect(separator?.getAttribute('role')).toBe('separator');
      for (const el of [label, group, separator]) el?.remove();
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
    screen.getByRole('button', { name: 'Toggle theme' }).focus();
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
  });

  it('a Theme picked here goes through the provider (the person’s own choice), not next-themes alone', async () => {
    localStorage.setItem('theme', 'dark');
    const user = userEvent.setup();
    render(<Header />);
    await user.click(screen.getByRole('button', { name: 'Toggle theme' }));
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
