import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { interruptedRunKeys, seedInterruptedRuns } from '@/test/interrupted-run-fixtures';

/**
 * Stage 5: the reset form and the account's passkey (plan section 4, 3.2 j).
 * The form shows the passkey only when the server offers it
 * (`details.method`: 'passkey', or 'both' with an authenticator app). A
 * server that never offers it (passkeys not usable, or no passkey) leaves the
 * form exactly as before. The passwords are checked before the device prompt,
 * and the answer goes with them in one press of the reset, which removes what
 * an interrupted run kept in this tab first, as any press of the reset does.
 */

const h = vi.hoisted(() => ({
  complete: vi.fn(),
  start: vi.fn(),
  startAuthentication: vi.fn(),
  supported: true,
  replace: vi.fn(),
  refresh: vi.fn(),
  keysAtRequest: null as string[] | null,
}));

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ replace: h.replace, refresh: h.refresh }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/server/actions/auth', () => ({
  completePasswordResetAction: (...a: unknown[]) => h.complete(...a),
}));
vi.mock('@/server/actions/passkeys', () => ({
  startPasswordResetPasskeyAction: (...a: unknown[]) => h.start(...a),
  startSecondStepAction: vi.fn(),
  finishSecondStepAction: vi.fn(),
}));
vi.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: () => h.supported,
  startAuthentication: (...a: unknown[]) => h.startAuthentication(...a),
}));

import { ResetCompleteForm } from './reset-complete-form';

const TYPED_VALUE = 'Typed-value-1';
const PASSKEY_ASK = 'Confirm with your passkey to finish resetting your password.';
const BOTH_ASK =
  'Confirm with your passkey, or enter the 6-digit code from your authenticator app, to finish resetting your password.';
const asked = (message: string, method?: 'passkey' | 'both') => ({
  ok: false,
  error: {
    code: 'forbidden',
    message,
    details: method ? { reason: 'aal2_required', method } : { reason: 'aal2_required' },
  },
});

beforeEach(() => {
  sessionStorage.clear();
  h.complete.mockReset();
  h.start.mockReset();
  h.startAuthentication.mockReset();
  h.replace.mockReset();
  h.supported = true;
  h.keysAtRequest = null;
  h.start.mockResolvedValue({
    ok: true,
    data: { kind: 'options', challengeId: 'sample-challenge', optionsJSON: { challenge: 'abc' } },
  });
  h.startAuthentication.mockResolvedValue({ id: 'sample-answer' });
});

async function typePasswords(user: ReturnType<typeof userEvent.setup>, confirm = TYPED_VALUE) {
  await user.type(screen.getByLabelText('New password'), TYPED_VALUE);
  await user.type(screen.getByLabelText('Confirm password'), confirm);
}

describe('a server that does not offer the passkey (dark)', () => {
  it('the form is the one of before: the code box when asked, never a passkey button', async () => {
    h.complete.mockResolvedValueOnce(
      asked(
        'Enter the 6-digit code from your authenticator app to finish resetting your password.',
      ),
    );
    const user = userEvent.setup();
    render(<ResetCompleteForm />);
    await typePasswords(user);
    await user.click(screen.getByRole('button', { name: 'Update password' }));
    await waitFor(() => expect(screen.getByLabelText('Authentication code')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /Use your passkey/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Update password' })).toBeTruthy();
    expect(h.start).not.toHaveBeenCalled();
  });
});

describe('a member whose only second step is a passkey', () => {
  it('the server’s ask, the passkey button, no code box; the answer goes with the passwords in one press', async () => {
    h.complete
      .mockResolvedValueOnce(asked(PASSKEY_ASK, 'passkey'))
      .mockImplementationOnce(async () => {
        h.keysAtRequest = interruptedRunKeys();
        return { ok: true, data: { next: '/signin?reset=success' } };
      });
    const user = userEvent.setup();
    render(<ResetCompleteForm />);
    await typePasswords(user);
    await user.click(screen.getByRole('button', { name: 'Update password' }));

    await waitFor(() => expect(screen.getByText(PASSKEY_ASK)).toBeTruthy());
    expect(screen.queryByLabelText('Authentication code')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Update password' })).toBeNull();

    seedInterruptedRuns();
    await user.click(screen.getByRole('button', { name: /Use your passkey/ }));
    await waitFor(() => expect(h.complete).toHaveBeenCalledTimes(2));
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.startAuthentication).toHaveBeenCalledWith({ optionsJSON: { challenge: 'abc' } });
    expect(h.complete.mock.calls[1]![0]).toEqual({
      password: TYPED_VALUE,
      confirmPassword: TYPED_VALUE,
      passkeyAnswer: { challengeId: 'sample-challenge', response: { id: 'sample-answer' } },
    });
    // What an interrupted run kept went before the request, as for any reset.
    expect(h.keysAtRequest).toEqual([]);
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith('/signin?reset=success'));
  });

  it('a refused answer is said next to the button, and the button stays', async () => {
    h.complete.mockResolvedValueOnce(asked(PASSKEY_ASK, 'passkey')).mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'validation_error',
        message: 'This passkey is not one of yours. Try another one.',
        details: { reason: 'aal2_required', method: 'passkey' },
      },
    });
    const user = userEvent.setup();
    render(<ResetCompleteForm />);
    await typePasswords(user);
    await user.click(screen.getByRole('button', { name: 'Update password' }));
    await user.click(await screen.findByRole('button', { name: /Use your passkey/ }));
    const alert = await screen.findByText('This passkey is not one of yours. Try another one.');
    expect(alert.closest('[role="alert"]')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Use your passkey/ })).toBeTruthy();
    expect(h.replace).not.toHaveBeenCalled();
  });

  it('passwords that do not match stop the press before the device prompt', async () => {
    h.complete.mockResolvedValueOnce(asked(PASSKEY_ASK, 'passkey'));
    const user = userEvent.setup();
    render(<ResetCompleteForm />);
    await typePasswords(user);
    await user.click(screen.getByRole('button', { name: 'Update password' }));
    await screen.findByRole('button', { name: /Use your passkey/ });
    await user.clear(screen.getByLabelText('Confirm password'));
    await user.type(screen.getByLabelText('Confirm password'), 'Typed-value-2');
    await user.click(screen.getByRole('button', { name: /Use your passkey/ }));
    await waitFor(() => expect(screen.getByText(/match/i)).toBeTruthy());
    expect(h.start).not.toHaveBeenCalled();
    expect(h.complete).toHaveBeenCalledTimes(1);
  });

  it('a browser with no passkeys says what to do on the reset, not the sign-in page’s words', async () => {
    h.supported = false;
    h.complete.mockResolvedValueOnce(asked(PASSKEY_ASK, 'passkey'));
    const user = userEvent.setup();
    render(<ResetCompleteForm />);
    await typePasswords(user);
    await user.click(screen.getByRole('button', { name: 'Update password' }));
    await user.click(await screen.findByRole('button', { name: /Use your passkey/ }));
    expect(
      await screen.findByText(
        "This browser can't use passkeys. Use another browser: choose Forgot? on the sign-in page there to get a new link.",
      ),
    ).toBeTruthy();
    expect(h.start).not.toHaveBeenCalled();
  });
});

describe('a member with an authenticator app and a passkey', () => {
  it('the passkey button, then "Or enter the 6-digit code", then the code box with the server’s ask', async () => {
    h.complete.mockResolvedValueOnce(asked(BOTH_ASK, 'both'));
    const user = userEvent.setup();
    render(<ResetCompleteForm />);
    await typePasswords(user);
    await user.click(screen.getByRole('button', { name: 'Update password' }));
    await screen.findByRole('button', { name: /Use your passkey/ });
    expect(screen.getByText('Or enter the 6-digit code from your authenticator app.')).toBeTruthy();
    expect(screen.getByLabelText('Authentication code')).toBeTruthy();
    expect(screen.getByText(BOTH_ASK)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Update password' })).toBeTruthy();
  });

  it('a browser with no passkeys points to the code box', async () => {
    h.supported = false;
    h.complete.mockResolvedValueOnce(asked(BOTH_ASK, 'both'));
    const user = userEvent.setup();
    render(<ResetCompleteForm />);
    await typePasswords(user);
    await user.click(screen.getByRole('button', { name: 'Update password' }));
    await user.click(await screen.findByRole('button', { name: /Use your passkey/ }));
    expect(
      await screen.findByText(
        "This browser can't use passkeys. Enter the 6-digit code from your authenticator app instead.",
      ),
    ).toBeTruthy();
    expect(h.start).not.toHaveBeenCalled();
  });
});
