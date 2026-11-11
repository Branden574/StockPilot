import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * WHAT'S NEW IN THE ACCOUNT MENU, FOR THE GLASS PHONE BAR (stage 3 fidelity,
 * small lane, round 2, finding 1). At 760 px and under the Liquid Glass bar
 * leaves its What's New button out so the page title can be read on a touch
 * phone (styles/liquid-glass/shell.css); the account menu then carries the
 * same action. With Liquid Glass in the build the item is a glass-only
 * element (hidden in Classic by visibility.css, and from 761 px by
 * shell.css) that opens the same What's New panel the bar's button opens,
 * with the same unread count in its name. Under `off` it is not rendered:
 * the menu is origin/main's.
 */

const { openWhatsNew, updateState } = vi.hoisted(() => ({
  openWhatsNew: vi.fn(),
  updateState: { releases: null as null | { unreadCount: number } },
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useRouter: () => ({ push: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('next-themes', () => ({ useTheme: () => ({ setTheme: vi.fn(), theme: 'light' }) }));
vi.mock('@/lib/analytics', () => ({ reset: vi.fn() }));
vi.mock('@/lib/onboarding/tour-state-cache', () => ({ forgetTourState: vi.fn() }));
vi.mock('@/server/actions/auth', () => ({ signOutAction: vi.fn() }));
vi.mock('@/lib/updates/update-store', () => ({
  openWhatsNew,
  useUpdateState: () => updateState,
}));

import { UserMenu } from './user-menu';

afterEach(() => {
  vi.unstubAllEnvs();
  openWhatsNew.mockReset();
  updateState.releases = null;
});

function renderMenu() {
  return render(
    <UserMenu
      email="avery@example.test"
      fullName="Avery Example"
      avatarUrl={null}
      organizationName="Example Schools"
    />,
  );
}

describe('the account menu’s What’s New (glass phone bar)', () => {
  it.each(['default', 'opt-in'] as const)(
    '%s: a glass-only item after Support that opens the same What’s New panel',
    async (rollout) => {
      vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
      const user = userEvent.setup();
      renderMenu();
      await user.click(screen.getByRole('button', { name: /^Account menu/ }));
      const item = await screen.findByRole('menuitem', { name: 'What’s new' });
      const wrapper = item.closest('[data-glass-only]');
      expect(wrapper?.getAttribute('data-glass')).toBe('um-whats-new');
      // It sits after Help and Support, before the Design group.
      const names = screen.getAllByRole('menuitem').map((el) => el.textContent?.trim());
      expect(names.indexOf('What’s new')).toBe(names.indexOf('Support & feedback') + 1);
      await user.click(item);
      expect(openWhatsNew).toHaveBeenCalledTimes(1);
      expect(openWhatsNew).toHaveBeenCalledWith(null, 'account-menu');
    },
  );

  it('carries the unread count in its name, as the bar’s button does', async () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    updateState.releases = { unreadCount: 3 };
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByRole('button', { name: /^Account menu/ }));
    expect(
      await screen.findByRole('menuitem', { name: 'What’s new, 3 unread' }),
    ).toBeInTheDocument();
  });

  it('off: no What’s New item and nothing glass-only (origin/main’s menu)', async () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', '');
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByRole('button', { name: /^Account menu/ }));
    await screen.findByRole('menuitem', { name: 'Sign out' });
    expect(screen.queryByRole('menuitem', { name: /What’s new/u })).toBeNull();
    expect(document.querySelectorAll('[data-glass-only]')).toHaveLength(0);
  });
});
