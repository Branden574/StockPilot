import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Stage 5 (answers Q6, Q7): the code page's recovery code says what a used
 * code now does, in plain words. The dialog says it before the press: the
 * code is used up, the two-factor sign-in methods are removed, the other
 * devices are signed out, and this one stays. After the press the toast says
 * what happened: "Your sign-in methods were removed and your other devices
 * were signed out. Set up a new one now." When the server could not end the
 * other sessions (`otherSessionsLeft`), it says that instead, and what to do.
 * The page then goes to Settings, Security, as before. The words name no
 * passkey: they are the same for every member.
 */

const consumeMfaRecoveryCodeAction = vi.fn();
const replace = vi.fn();
const refresh = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock('@/server/actions/mfa', () => ({ challengeFactorAction: vi.fn() }));
vi.mock('@/server/actions/mfa-recovery', () => ({
  consumeMfaRecoveryCodeAction: (...a: unknown[]) => consumeMfaRecoveryCodeAction(...a),
}));
vi.mock('@/server/actions/auth', () => ({ signOutAction: vi.fn() }));
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

const TYPED_VALUE = 'pw-123456';

beforeEach(() => {
  vi.clearAllMocks();
});

function useACode() {
  fireEvent.click(screen.getByRole('button', { name: /Use a recovery code/ }));
  fireEvent.change(screen.getByLabelText('Recovery code'), {
    target: { value: 'abcd-efgh-ijkl-mnop' },
  });
  fireEvent.change(screen.getByLabelText('Confirm your password'), {
    target: { value: TYPED_VALUE },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Use recovery code' }));
}

describe.each([
  ['with an authenticator app', [{ id: 'factor-1', friendlyName: 'Phone' }]],
  ['with no app to offer', []],
])('the recovery code on the code page, %s', (_name, factors) => {
  it('the dialog says what a used code does before the press', () => {
    render(<MfaChallengeForm factors={factors} />);
    fireEvent.click(screen.getByRole('button', { name: /Use a recovery code/ }));
    expect(screen.getByRole('dialog')).toHaveTextContent(
      'Enter one of the recovery codes you saved when you set up two-factor authentication. This uses up the code and removes your two-factor sign-in methods. Your other devices are signed out. You stay signed in here and set up a new one next.',
    );
    expect(screen.getByRole('dialog').textContent).not.toMatch(/passkey/i);
  });

  it('a used code: the methods were removed and the other devices signed out; then Settings, Security', async () => {
    consumeMfaRecoveryCodeAction.mockResolvedValue({ ok: true, data: { unenrolled: 1 } });
    render(<MfaChallengeForm factors={factors} />);
    useACode();
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(
        'Your sign-in methods were removed and your other devices were signed out. Set up a new one now.',
      ),
    );
    expect(replace).toHaveBeenCalledWith('/dashboard/settings/security');
  });

  it('the other sessions could not be ended: the words say so, and what to do', async () => {
    consumeMfaRecoveryCodeAction.mockResolvedValue({
      ok: true,
      data: { unenrolled: 1, otherSessionsLeft: true },
    });
    render(<MfaChallengeForm factors={factors} />);
    useACode();
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(
        'Your sign-in methods were removed. We could not sign out your other devices, so change your password now. Then set up a new one.',
      ),
    );
    expect(replace).toHaveBeenCalledWith('/dashboard/settings/security');
  });
});
