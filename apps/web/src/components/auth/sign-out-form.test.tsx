import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  blockSessionStorage,
  interruptedRunKeys,
  seedInterruptedRuns,
  UNRELATED_KEY,
} from '@/test/interrupted-run-fixtures';

/**
 * The account-disabled screen's Sign out (a server-rendered page) used to be a
 * bare <form action={signOutAction}>. A server component cannot run browser
 * code, so it could not remove what an interrupted run kept in this tab
 * (lib/interrupted-run) before signing out. SignOutForm is the same form as a
 * client component: React runs its onSubmit, which purges the records, and
 * then the form's action.
 */

const h = vi.hoisted(() => ({
  signOutAction: vi.fn(),
  keysAtSignOut: null as string[] | null,
}));

vi.mock('@/server/actions/auth', () => ({
  signOutAction: (...a: unknown[]) => h.signOutAction(...a),
}));

import { SignOutForm } from './sign-out-form';

beforeEach(() => {
  sessionStorage.clear();
  h.keysAtSignOut = null;
  h.signOutAction.mockReset();
  h.signOutAction.mockImplementation(async () => {
    h.keysAtSignOut = interruptedRunKeys();
  });
});

afterEach(() => sessionStorage.clear());

describe('SignOutForm (the account-disabled screen)', () => {
  it('removes every interrupted-run record in this tab before the form sends the sign-out', async () => {
    seedInterruptedRuns();
    render(<SignOutForm />);

    const button = screen.getByRole('button', { name: 'Sign out' });
    // Still a form that posts the sign-out, as it was on the server page.
    expect(button).toHaveAttribute('type', 'submit');
    expect(button.closest('form')).not.toBeNull();

    fireEvent.click(button);

    await waitFor(() => expect(h.signOutAction).toHaveBeenCalledTimes(1));
    expect(h.keysAtSignOut).toEqual([]);
    expect(sessionStorage.getItem(UNRELATED_KEY)).toBe('kept');
  });

  it('still signs out when the browser refuses storage', async () => {
    h.signOutAction.mockImplementation(async () => {});
    render(<SignOutForm />);
    const restore = blockSessionStorage();
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
      await waitFor(() => expect(h.signOutAction).toHaveBeenCalledTimes(1));
    } finally {
      restore();
    }
  });
});
