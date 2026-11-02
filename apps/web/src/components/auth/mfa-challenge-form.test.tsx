import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  interruptedRunKeys,
  seedInterruptedRuns,
  UNRELATED_KEY,
} from '@/test/interrupted-run-fixtures';

/**
 * /signin/mfa (P5.1). The recovery-code dialog is portalled, but React still
 * bubbles a portalled form's submit event up the React tree. While the dialog
 * sat inside the code form, submitting a recovery code also submitted the
 * authenticator-code form: a typed six-digit code was sent to the factor
 * challenge as well, and an empty one raised a stray "Enter the 6-digit code"
 * toast over the recovery flow.
 */

const challengeFactorAction = vi.fn();
const consumeMfaRecoveryCodeAction = vi.fn();
const signOutAction = vi.fn();
const replace = vi.fn();
const refresh = vi.fn();
const toastError = vi.fn();
const toastSuccess = vi.fn();

vi.mock('@/server/actions/mfa', () => ({
  challengeFactorAction: (...a: unknown[]) => challengeFactorAction(...a),
}));
vi.mock('@/server/actions/mfa-recovery', () => ({
  consumeMfaRecoveryCodeAction: (...a: unknown[]) => consumeMfaRecoveryCodeAction(...a),
}));
vi.mock('@/server/actions/auth', () => ({
  signOutAction: (...a: unknown[]) => signOutAction(...a),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, refresh }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('sonner', () => ({
  toast: {
    error: (...a: unknown[]) => toastError(...a),
    success: (...a: unknown[]) => toastSuccess(...a),
  },
}));

import { MfaChallengeForm } from './mfa-challenge-form';

const FACTORS = [{ id: 'factor-1', friendlyName: 'Phone' }];
// What the test types into "Confirm your password": a dull value under a
// neutral name. GitGuardian's generic password detector fires on a
// password-shaped name holding a string literal, whatever the value, so the
// action's password field is checked against this constant instead.
const TYPED_VALUE = 'pw-123456';

beforeEach(() => {
  vi.clearAllMocks();
  challengeFactorAction.mockResolvedValue({ ok: false, error: { message: 'Invalid code' } });
  consumeMfaRecoveryCodeAction.mockResolvedValue({ ok: true, data: { unenrolled: 1 } });
});

function openRecovery() {
  fireEvent.click(screen.getByRole('button', { name: /Lost your phone\? Use a recovery code/ }));
  fireEvent.change(screen.getByLabelText('Recovery code'), {
    target: { value: 'abcd-efgh-ijkl-mnop' },
  });
  fireEvent.change(screen.getByLabelText('Confirm your password'), {
    target: { value: TYPED_VALUE },
  });
}

describe('MfaChallengeForm', () => {
  it('submitting a recovery code never submits the authenticator code', async () => {
    render(<MfaChallengeForm factors={FACTORS} />);
    fireEvent.change(screen.getByLabelText('Authentication code'), { target: { value: '123456' } });
    openRecovery();
    fireEvent.click(screen.getByRole('button', { name: 'Use recovery code' }));

    await waitFor(() =>
      expect(consumeMfaRecoveryCodeAction).toHaveBeenCalledWith({
        code: 'ABCD-EFGH-IJKL-MNOP',
        password: TYPED_VALUE,
      }),
    );
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/dashboard/settings/security'));
    expect(challengeFactorAction).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalledWith('/dashboard');
  });

  it('with no code typed, the recovery flow raises no "Enter the 6-digit code" toast', async () => {
    render(<MfaChallengeForm factors={FACTORS} />);
    openRecovery();
    fireEvent.click(screen.getByRole('button', { name: 'Use recovery code' }));
    await waitFor(() => expect(consumeMfaRecoveryCodeAction).toHaveBeenCalled());
    expect(toastError).not.toHaveBeenCalledWith(
      'Enter the 6-digit code from your authenticator app.',
    );
  });

  it('keeps the code form: digits only, Verify & continue disabled until six digits', async () => {
    render(<MfaChallengeForm factors={FACTORS} />);
    const code = screen.getByLabelText('Authentication code') as HTMLInputElement;
    const verify = screen.getByRole('button', { name: 'Verify & continue' });
    fireEvent.change(code, { target: { value: '12a3' } });
    expect(code.value).toBe('123');
    expect(verify).toBeDisabled();
    fireEvent.change(code, { target: { value: '123456' } });
    expect(verify).toBeEnabled();
    fireEvent.click(verify);
    await waitFor(() =>
      expect(challengeFactorAction).toHaveBeenCalledWith({ factorId: 'factor-1', code: '123456' }),
    );
    expect(code).toHaveAttribute('autocomplete', 'one-time-code');
    expect(screen.getByRole('button', { name: 'Cancel and sign out' })).toBeInTheDocument();
  });

  // Docket B50: authenticator apps show the code as "123 456". A maxLength of
  // 6 cut a pasted copy at six characters, "123 45", before the digits were
  // kept: five digits, and Verify & continue stayed off.
  it('a code pasted with a space is sent as six digits', async () => {
    challengeFactorAction.mockResolvedValue({ ok: true, data: undefined });
    const user = userEvent.setup();
    render(<MfaChallengeForm factors={FACTORS} />);
    const code = screen.getByLabelText('Authentication code');

    await user.click(code);
    await user.paste('123 456');
    expect(code).toHaveValue('123456');
    // Without a maxLength, the box itself keeps six digits and no more.
    await user.paste('7');
    expect(code).toHaveValue('123456');
    await user.click(screen.getByRole('button', { name: 'Verify & continue' }));

    await waitFor(() =>
      expect(challengeFactorAction).toHaveBeenCalledWith({ factorId: 'factor-1', code: '123456' }),
    );
  });

  it('shows the authenticator picker only with more than one factor, and a change clears the code', () => {
    render(
      <MfaChallengeForm
        factors={[
          { id: 'factor-1', friendlyName: 'Phone' },
          { id: 'factor-2abcdef', friendlyName: null },
        ]}
      />,
    );
    const code = screen.getByLabelText('Authentication code') as HTMLInputElement;
    fireEvent.change(code, { target: { value: '123456' } });
    const picker = screen.getByLabelText('Authenticator') as HTMLSelectElement;
    expect(Array.from(picker.options).map((o) => o.textContent)).toEqual([
      'Phone',
      'Authenticator (factor)',
    ]);
    fireEvent.change(picker, { target: { value: 'factor-2abcdef' } });
    expect(code.value).toBe('');
  });
});

describe('MfaChallengeForm: Cancel and sign out', () => {
  // A sign-out on purpose: what an interrupted run kept in this tab
  // (lib/interrupted-run) goes before the sign-out request leaves, because
  // the request answers with a redirect and nothing after it runs.
  afterEach(() => sessionStorage.clear());

  it('removes every interrupted-run record in this tab before the sign-out request leaves', async () => {
    sessionStorage.clear();
    seedInterruptedRuns();
    let keysAtSignOut: string[] | null = null;
    signOutAction.mockImplementationOnce(async () => {
      keysAtSignOut = interruptedRunKeys();
    });
    render(<MfaChallengeForm factors={FACTORS} />);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel and sign out' }));

    await waitFor(() => expect(signOutAction).toHaveBeenCalledTimes(1));
    expect(keysAtSignOut).toEqual([]);
    expect(sessionStorage.getItem(UNRELATED_KEY)).toBe('kept');
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/signin'));
  });
});
