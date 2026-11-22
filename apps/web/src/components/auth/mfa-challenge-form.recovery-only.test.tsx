import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The code page's form with no authenticator app to offer (an account whose
 * only second step is a passkey that cannot be used here): no code box, no
 * code is ever sent, and the recovery code and sign-out stay (plan 3.1 #2).
 * With an app the form is unchanged (mfa-challenge-form.test.tsx).
 */

const challengeFactorAction = vi.fn();
const consumeMfaRecoveryCodeAction = vi.fn();
const signOutAction = vi.fn();
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
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { MfaChallengeForm } from './mfa-challenge-form';

/** What the test types into "Confirm your password": a dull value under a neutral name. */
const TYPED_VALUE = 'pw-123456';

beforeEach(() => {
  vi.clearAllMocks();
  consumeMfaRecoveryCodeAction.mockResolvedValue({ ok: true, data: { unenrolled: 1 } });
});

describe('MfaChallengeForm with no authenticator app', () => {
  it('shows no code box and sends no code', () => {
    render(<MfaChallengeForm factors={[]} />);
    expect(screen.queryByLabelText('Authentication code')).toBeNull();
    expect(screen.queryByRole('button', { name: /Verify/ })).toBeNull();
    expect(challengeFactorAction).not.toHaveBeenCalled();
  });

  it('keeps the recovery code, which sends the code and the password', async () => {
    render(<MfaChallengeForm factors={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /Use a recovery code/ }));
    fireEvent.change(screen.getByLabelText('Recovery code'), {
      target: { value: 'abcd-efgh-ijkl-mnop' },
    });
    fireEvent.change(screen.getByLabelText('Confirm your password'), {
      target: { value: TYPED_VALUE },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Use recovery code' }));
    await waitFor(() =>
      expect(consumeMfaRecoveryCodeAction).toHaveBeenCalledWith({
        code: 'ABCD-EFGH-IJKL-MNOP',
        password: TYPED_VALUE,
      }),
    );
    expect(challengeFactorAction).not.toHaveBeenCalled();
  });

  it('keeps Cancel and sign out', () => {
    render(<MfaChallengeForm factors={[]} />);
    expect(screen.getByRole('button', { name: 'Cancel and sign out' })).toBeInTheDocument();
  });
});
