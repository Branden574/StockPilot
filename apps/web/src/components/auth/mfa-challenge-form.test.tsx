import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    target: { value: 'pw-123456' },
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
        password: 'pw-123456',
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
