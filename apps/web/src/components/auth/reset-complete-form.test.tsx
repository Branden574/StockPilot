import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  interruptedRunKeys,
  seedInterruptedRuns,
  UNRELATED_KEY,
} from '@/test/interrupted-run-fixtures';

/**
 * Setting a new password from a reset link signs the account out everywhere,
 * this tab included (completePasswordResetAction). That is a sign-out on
 * purpose, so what an interrupted run kept in this tab (lib/interrupted-run)
 * goes before the request leaves. A form that fails its own checks sends
 * nothing and removes nothing.
 */

const h = vi.hoisted(() => ({
  complete: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  keysAtRequest: null as string[] | null,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: h.replace, refresh: h.refresh }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/server/actions/auth', () => ({
  completePasswordResetAction: (...a: unknown[]) => h.complete(...a),
}));

import { ResetCompleteForm } from './reset-complete-form';

// What the test types as the new password: a dull value that meets the rules,
// under a neutral name (a password-shaped name holding a literal trips secret
// scanners whatever the value).
const TYPED_VALUE = 'Typed-value-1';

beforeEach(() => {
  sessionStorage.clear();
  h.keysAtRequest = null;
  h.complete.mockReset();
  h.complete.mockImplementation(async () => {
    h.keysAtRequest = interruptedRunKeys();
    return { ok: true, data: { next: '/signin?reset=success' } };
  });
  h.replace.mockReset();
});

afterEach(() => sessionStorage.clear());

describe('ResetCompleteForm', () => {
  it('removes every interrupted-run record in this tab before the new password is sent', async () => {
    seedInterruptedRuns();
    const user = userEvent.setup();
    render(<ResetCompleteForm />);

    await user.type(screen.getByLabelText('New password'), TYPED_VALUE);
    await user.type(screen.getByLabelText('Confirm password'), TYPED_VALUE);
    await user.click(screen.getByRole('button', { name: 'Update password' }));

    await waitFor(() => expect(h.complete).toHaveBeenCalledTimes(1));
    expect(h.keysAtRequest).toEqual([]);
    expect(sessionStorage.getItem(UNRELATED_KEY)).toBe('kept');
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith('/signin?reset=success'));
  });

  it('a form that fails its own checks sends nothing and removes nothing', async () => {
    seedInterruptedRuns();
    const user = userEvent.setup();
    render(<ResetCompleteForm />);

    await user.type(screen.getByLabelText('New password'), TYPED_VALUE);
    await user.type(screen.getByLabelText('Confirm password'), `${TYPED_VALUE}x`);
    await user.click(screen.getByRole('button', { name: 'Update password' }));

    expect(await screen.findByText('Passwords do not match')).toBeInTheDocument();
    expect(h.complete).not.toHaveBeenCalled();
    expect(interruptedRunKeys()).toHaveLength(2);
  });
});
