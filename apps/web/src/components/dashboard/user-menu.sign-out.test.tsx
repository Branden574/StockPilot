import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  blockSessionStorage,
  interruptedRunKeys,
  seedInterruptedRuns,
  UNRELATED_KEY,
} from '@/test/interrupted-run-fixtures';

/**
 * The account menu's Sign out ends the session on purpose, so it removes what
 * an interrupted run kept in this tab (lib/interrupted-run: a new procedure's
 * id, a Sage 50 import's summary with rows of its errors) BEFORE the sign-out
 * request leaves. The request answers with a redirect, so nothing after it
 * runs.
 */

const h = vi.hoisted(() => ({
  signOutAction: vi.fn(),
  /** The interrupted-run keys in the tab when the sign-out request left. */
  keysAtSignOut: null as string[] | null,
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useRouter: () => ({ push: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('next-themes', () => ({ useTheme: () => ({ setTheme: vi.fn(), theme: 'light' }) }));
vi.mock('@/lib/analytics', () => ({ reset: vi.fn() }));
vi.mock('@/lib/onboarding/tour-state-cache', () => ({ forgetTourState: vi.fn() }));
vi.mock('@/server/actions/auth', () => ({
  signOutAction: (...a: unknown[]) => h.signOutAction(...a),
}));

import { UserMenu } from './user-menu';

function renderMenu() {
  render(
    <UserMenu
      email="demo@example.com"
      fullName="Demo User"
      avatarUrl={null}
      organizationName="Demo Co"
    />,
  );
}

async function signOut() {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: /^Account menu/ }));
  await user.click(await screen.findByRole('menuitem', { name: 'Sign out' }));
  await waitFor(() => expect(h.signOutAction).toHaveBeenCalledTimes(1));
}

beforeEach(() => {
  sessionStorage.clear();
  h.keysAtSignOut = null;
  h.signOutAction.mockReset();
  h.signOutAction.mockImplementation(async () => {
    h.keysAtSignOut = interruptedRunKeys();
  });
});

afterEach(() => {
  sessionStorage.clear();
});

describe('the account menu: Sign out', () => {
  it('removes every interrupted-run record in this tab before the sign-out request leaves', async () => {
    seedInterruptedRuns();
    expect(interruptedRunKeys()).toHaveLength(2);
    renderMenu();

    await signOut();

    expect(h.keysAtSignOut).toEqual([]);
    // Only those records: the tab's other keys stay.
    expect(sessionStorage.getItem(UNRELATED_KEY)).toBe('kept');
  });

  it('still signs out when the browser refuses storage', async () => {
    h.signOutAction.mockImplementation(async () => {});
    renderMenu();
    const restore = blockSessionStorage();
    try {
      await signOut();
    } finally {
      restore();
    }
  });
});
