import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The account menu's appearance (plans/REVISION-DEFAULT.md R1, R13 round 2
 * finding 9; section 9 item 19). With Liquid Glass in the build: the Design
 * group first, then origin/main's Theme radio (its label, words and order)
 * whose value is the provider's Theme and whose change goes through
 * chooseTheme, so the Theme is the person's own and is saved. Under `off`:
 * origin/main's block verbatim, next-themes direct (topbar.test.tsx holds the
 * origin/main expectations unchanged).
 */

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useRouter: () => ({ push: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/lib/analytics', () => ({ reset: vi.fn() }));
vi.mock('@/lib/onboarding/tour-state-cache', () => ({ forgetTourState: vi.fn() }));
vi.mock('@/server/actions/auth', () => ({ signOutAction: vi.fn() }));
vi.mock('@/server/actions/appearance', () => ({
  setMyAppearanceAction: vi.fn(),
}));

import { AppearanceProvider } from '@/components/theme/appearance-provider';
import { ThemeProvider } from '@/components/theme/theme-provider';

import { UserMenu } from './user-menu';

function Menu() {
  return (
    <ThemeProvider>
      <AppearanceProvider>
        <UserMenu
          email="demo@example.com"
          fullName="Demo User"
          avatarUrl={null}
          organizationName="Demo Co"
        />
      </AppearanceProvider>
    </ThemeProvider>
  );
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 204 })),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
  document.cookie = 'sp_style=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
  document.documentElement.removeAttribute('data-appearance');
  document.documentElement.removeAttribute('class');
  document.documentElement.removeAttribute('style');
});

const items = (group: HTMLElement) =>
  within(group)
    .getAllByRole('menuitemradio')
    .map((i) => [i.textContent, i.getAttribute('aria-checked')]);

describe('the account menu with Liquid Glass in the build', () => {
  it.each(['default', 'opt-in'] as const)(
    '%s: Design first, then origin/main’s Theme radio',
    async (rollout) => {
      vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
      localStorage.setItem('theme', 'light');
      const user = userEvent.setup();
      render(<Menu />);
      await user.click(screen.getByRole('button', { name: /^Account menu/ }));
      const design = await screen.findByRole('group', { name: 'Design' });
      const theme = screen.getByRole('group', { name: 'Theme' });
      expect(items(design)).toEqual([
        ['Liquid Glass', rollout === 'default' ? 'true' : 'false'],
        ['Classic', rollout === 'default' ? 'false' : 'true'],
      ]);
      expect(items(theme)).toEqual([
        ['Light', 'true'],
        ['Dark', 'false'],
        ['System', 'false'],
      ]);
      // Design comes before Theme in the menu.
      expect(design.compareDocumentPosition(theme) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    },
  );

  it('a Theme picked here goes through the provider: next-themes changes AND it is the person’s own choice', async () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    localStorage.setItem('theme', 'light');
    const user = userEvent.setup();
    render(<Menu />);
    await user.click(screen.getByRole('button', { name: /^Account menu/ }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Dark' }));
    await waitFor(() => expect(localStorage.getItem('theme')).toBe('dark'));
    expect(JSON.parse(localStorage.getItem('sp-appearance')!)).toMatchObject({
      v: 2,
      theme: 'dark',
    });
  });

  it('Classic picked here applies at once and keeps the Theme', async () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    localStorage.setItem('theme', 'dark');
    const user = userEvent.setup();
    render(<Menu />);
    await waitFor(() =>
      expect(document.documentElement.getAttribute('data-appearance')).toBe('liquid-glass'),
    );
    await user.click(screen.getByRole('button', { name: /^Account menu/ }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Classic' }));
    await waitFor(() =>
      expect(document.documentElement.hasAttribute('data-appearance')).toBe(false),
    );
    expect(localStorage.getItem('theme')).toBe('dark');
  });
});

describe('the account menu under off', () => {
  it('has no Design group, and a Theme picked here goes to next-themes only (origin/main)', async () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', '');
    localStorage.setItem('theme', 'light');
    const user = userEvent.setup();
    render(<Menu />);
    await user.click(screen.getByRole('button', { name: /^Account menu/ }));
    expect(await screen.findByRole('group', { name: 'Theme' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Design' })).toBeNull();
    expect(screen.queryByText('Design')).toBeNull();
    await user.click(screen.getByRole('menuitemradio', { name: 'Dark' }));
    await waitFor(() => expect(localStorage.getItem('theme')).toBe('dark'));
    expect(localStorage.getItem('sp-appearance')).toBeNull();
  });
});
