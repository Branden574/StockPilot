import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { classicMarkup } from '@/test/classic-parity';

/**
 * THE MENUS' DESIGN GROUP SITS IN ONE INERT WRAPPER (L4 triage BF3).
 *
 * In a build with Liquid Glass the header appearance menu and the account
 * menu gain the Design group: a "Design" label, the Liquid Glass / Classic
 * radio group and, in the header menu, a separator. It is the menus' one
 * approved difference from origin/main in Classic. The lab's parity run takes
 * that group out of the open menu by ONE selector, `[data-appearance-design]`
 * (stockpilot-work/liquid-glass/verify/allowances.json: menu-design-account-
 * menu, menu-design-appearance-switcher, menu-design-signin-switcher), and
 * then requires the rest of the menu to equal the baseline exactly. So the
 * group's parts are wrapped in one `<div data-appearance-design=""
 * class="contents">`, like Settings > Profile's `data-appearance-panel`.
 *
 * The wrapper must change nothing a person can perceive: it draws no box
 * (display: contents), has no role, the group keeps its role and name, the
 * separator stays a separator, and the arrow keys still reach every item of
 * the menu in order, in Classic and in Liquid Glass. With the wrapper taken
 * out, the menu is the `off` rollout's menu. Under `off` neither the wrapper
 * nor the group exists.
 */

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useRouter: () => ({ push: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/lib/analytics', () => ({ reset: vi.fn() }));
vi.mock('@/lib/onboarding/tour-state-cache', () => ({ forgetTourState: vi.fn() }));
vi.mock('@/server/actions/auth', () => ({ signOutAction: vi.fn() }));
vi.mock('@/server/actions/appearance', () => ({
  getMyAppearanceAction: vi.fn(),
  setMyAppearanceAction: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: vi.fn() }));

import { UserMenu } from '@/components/dashboard/user-menu';

import { AppearanceProvider } from './appearance-provider';
import { ThemeProvider } from './theme-provider';
import { ThemeToggle } from './theme-toggle';

const HOOK = '[data-appearance-design]';

interface MenuCase {
  name: string;
  trigger: RegExp;
  ui: () => React.ReactElement;
  /** The wrapper's children, in order, by role (a label has none). */
  parts: (string | null)[];
}

const MENUS: MenuCase[] = [
  {
    name: 'the header appearance menu',
    trigger: /^(Toggle theme|Appearance: design and theme)$/,
    ui: () => <ThemeToggle />,
    parts: [null, 'group', 'separator'],
  },
  {
    name: 'the account menu',
    trigger: /^Account menu/,
    ui: () => (
      <UserMenu
        email="demo@example.test"
        fullName="Demo User"
        avatarUrl={null}
        organizationName="Demo Co"
        density="comfortable"
        onDensityChange={() => {}}
      />
    ),
    parts: [null, 'group'],
  },
];

/** What is on screen: Classic chosen, or the rollout's Liquid Glass. */
const APPEARANCES = [
  { label: 'Classic', rollout: 'default', stored: 'classic', glass: false },
  { label: 'Liquid Glass', rollout: 'default', stored: null, glass: true },
  { label: 'Classic (opt-in)', rollout: 'opt-in', stored: null, glass: false },
] as const;

function App({ menu }: { menu: MenuCase }) {
  return (
    <ThemeProvider>
      <AppearanceProvider>{menu.ui()}</AppearanceProvider>
    </ThemeProvider>
  );
}

async function open(menu: MenuCase) {
  const user = userEvent.setup();
  render(<App menu={menu} />);
  await user.click(screen.getByRole('button', { name: menu.trigger }));
  const content = await screen.findByRole('menu');
  return { user, content };
}

const itemsOf = (content: HTMLElement) =>
  Array.from(
    content.querySelectorAll<HTMLElement>(
      '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]',
    ),
  );

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 204 })),
  );
  localStorage.setItem('theme', 'light');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
  document.cookie = 'sp_style=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
  for (const name of ['data-appearance', 'data-lg-material', 'class', 'style']) {
    document.documentElement.removeAttribute(name);
  }
});

describe.each(MENUS)('$name', (menu) => {
  describe.each(APPEARANCES)('in $label', ({ rollout, stored, glass }) => {
    beforeEach(() => {
      vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
      if (stored) {
        localStorage.setItem('sp-appearance', JSON.stringify({ v: 2, style: stored }));
        document.cookie = `sp_style=${stored}; path=/`;
      }
    });

    it('one wrapper holds the Design label, the radio group and (header menu) the separator, and nothing else', async () => {
      const { content } = await open(menu);
      expect(document.documentElement.getAttribute('data-appearance') === 'liquid-glass').toBe(
        glass,
      );
      const hooks = document.querySelectorAll(HOOK);
      expect(hooks).toHaveLength(1);
      const hook = hooks[0] as HTMLElement;
      // The exact element the lab's allowances and the README name.
      expect(hook.tagName).toBe('DIV');
      expect(hook.getAttribute('data-appearance-design')).toBe('');
      expect(hook.className).toBe('contents');
      expect(hook.getAttributeNames().sort()).toEqual(['class', 'data-appearance-design']);
      expect(content.contains(hook)).toBe(true);

      const children = Array.from(hook.children);
      expect(children.map((el) => el.getAttribute('role'))).toEqual(menu.parts);
      expect(children[0]!.textContent).toBe('Design');
      const group = children[1] as HTMLElement;
      expect(group.getAttribute('aria-label')).toBe('Design');
      expect(
        within(group)
          .getAllByRole('menuitemradio')
          .map((item) => [item.textContent, item.getAttribute('aria-checked')]),
      ).toEqual([
        ['Liquid Glass', String(glass)],
        ['Classic', String(!glass)],
      ]);
      // Every "Design" thing of the menu is inside the wrapper.
      expect(within(content).getByRole('group', { name: 'Design' })).toBe(group);
      expect(within(content).getAllByText('Design')).toEqual([children[0]]);
    });

    it('the wrapper has no role and no name; the group and the separator keep theirs', async () => {
      const { content } = await open(menu);
      const hook = content.querySelector(HOOK)!;
      expect(hook.hasAttribute('role')).toBe(false);
      expect(hook.hasAttribute('aria-label')).toBe(false);
      expect(hook.hasAttribute('tabindex')).toBe(false);
      const group = within(content).getByRole('group', { name: 'Design' });
      expect(group.parentElement).toBe(hook);
      expect(within(group).getAllByRole('menuitemradio')).toHaveLength(2);
      const separators = Array.from(hook.querySelectorAll('[role="separator"]'));
      expect(separators).toHaveLength(menu.parts.includes('separator') ? 1 : 0);
      for (const separator of separators) {
        expect(separator.getAttribute('aria-orientation')).toBe('horizontal');
        // Still between the Design group and the item after it, in the menu's order.
        expect(separator.previousElementSibling).toBe(group);
        expect(hook.nextElementSibling?.getAttribute('role')).toBe('menuitem');
      }
    });

    it('the arrow keys reach every item of the menu, in order, both ways, and wrap as before', async () => {
      const { user, content } = await open(menu);
      const items = itemsOf(content);
      const names = items.map((item) => item.textContent);
      expect(names).toEqual(expect.arrayContaining(['Liquid Glass', 'Classic']));
      const visited: (string | null)[] = [];
      for (let i = 0; i < items.length; i += 1) {
        await user.keyboard('{ArrowDown}');
        expect(items).toContain(document.activeElement);
        visited.push(document.activeElement!.textContent);
      }
      expect(visited).toEqual(names);
      // Past the last item nothing moves (Radix menus do not loop).
      await user.keyboard('{ArrowDown}');
      expect(document.activeElement).toBe(items.at(-1));
      const back: (string | null)[] = [];
      for (let i = 0; i < items.length - 1; i += 1) {
        await user.keyboard('{ArrowUp}');
        back.push(document.activeElement!.textContent);
      }
      expect(back).toEqual(names.slice(0, -1).reverse());
      await user.keyboard('{End}');
      expect(document.activeElement).toBe(items.at(-1));
      await user.keyboard('{Home}');
      expect(document.activeElement).toBe(items[0]);
    });

    it('a Design is chosen from the keyboard inside the wrapper', async () => {
      const { user, content } = await open(menu);
      const target = glass ? 'Classic' : 'Liquid Glass';
      const item = within(content).getByRole('menuitemradio', { name: target });
      item.focus();
      expect(document.activeElement).toBe(item);
      await user.keyboard('{Enter}');
      await waitFor(() =>
        expect(document.documentElement.getAttribute('data-appearance') === 'liquid-glass').toBe(
          !glass,
        ),
      );
    });
  });

  it('with the wrapper taken out, the Classic menu is the `off` rollout’s menu', async () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'off');
    const off = await open(menu);
    const baseline = classicMarkup(off.content);
    cleanup();
    // The open menu locked the page behind it (Radix); a real load starts free.
    document.body.removeAttribute('style');

    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    localStorage.setItem('sp-appearance', JSON.stringify({ v: 2, style: 'classic' }));
    document.cookie = 'sp_style=classic; path=/';
    const { content } = await open(menu);
    const clone = content.cloneNode(true) as HTMLElement;
    const hooks = clone.querySelectorAll(HOOK);
    expect(hooks).toHaveLength(1);
    hooks[0]!.remove();
    expect(classicMarkup(clone)).toBe(baseline);
  });

  it('under `off`: no wrapper and no Design group, as before', async () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'off');
    const { content } = await open(menu);
    expect(document.querySelector(HOOK)).toBeNull();
    expect(within(content).queryByRole('group', { name: 'Design' })).toBeNull();
    expect(within(content).queryByText('Design')).toBeNull();
    expect(within(content).queryByRole('menuitemradio', { name: 'Liquid Glass' })).toBeNull();
  });
});
