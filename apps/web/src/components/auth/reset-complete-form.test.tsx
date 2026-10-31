import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { redirect } from 'next/navigation';
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
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  keysAtRequest: null as string[] | null,
}));

// The real module stays under the router: isControlFlow (lib/control-flow) is
// Next's unstable_rethrow, and the redirect test below throws a real redirect.
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ replace: h.replace, refresh: h.refresh }),
}));
vi.mock('sonner', () => ({
  toast: {
    error: (...a: unknown[]) => h.toastError(...a),
    success: (...a: unknown[]) => h.toastSuccess(...a),
  },
}));
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
  h.toastError.mockReset();
  h.toastSuccess.mockReset();
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

/**
 * Docket B50. GoTrue refuses a new password on a reset link's session for an
 * account with a verified authenticator until a code raises that session to
 * AAL2, so completePasswordResetAction answers `details.reason:
 * 'aal2_required'` and takes the code as `totpCode` (#185). The form never had
 * a box for it: everyone with an authenticator read "Enter the 6-digit code"
 * with nowhere to type it, on every press.
 */
describe('ResetCompleteForm: the authenticator code (B50)', () => {
  const ASK =
    'Enter the 6-digit code from your authenticator app to finish resetting your password.';
  const REFUSED = 'That code is not valid. Check your authenticator app and try again.';
  const asked = (message = ASK) => ({
    ok: false,
    error: { code: 'forbidden', message, details: { reason: 'aal2_required' } },
  });
  const DONE = { ok: true, data: { next: '/signin?reset=success' } };

  async function fillPasswords(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByLabelText('New password'), TYPED_VALUE);
    await user.type(screen.getByLabelText('Confirm password'), TYPED_VALUE);
  }

  // The button shows a spinner, not its name, while a request is out.
  async function press(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('button', { name: 'Update password' }));
  }

  const codeBox = () => screen.findByRole('textbox', { name: 'Authentication code' });

  it('asks for the authenticator code when the server needs it, then sends it with the same new password', async () => {
    h.complete.mockResolvedValueOnce(asked()).mockResolvedValueOnce(DONE);
    const user = userEvent.setup();
    render(<ResetCompleteForm />);

    await fillPasswords(user);
    await press(user);

    const box = await codeBox();
    await waitFor(() => expect(box).toHaveFocus());
    expect(box).toHaveAccessibleDescription(expect.stringContaining(ASK));
    expect(screen.getByRole('link', { name: 'Contact support' })).toHaveAttribute(
      'href',
      '/support',
    );
    // The ask is the box's description, not an error or a toast.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(h.toastError).not.toHaveBeenCalled();
    expect(h.replace).not.toHaveBeenCalled();

    await user.type(box, '123456');
    await press(user);

    await waitFor(() => expect(h.complete).toHaveBeenCalledTimes(2));
    // Strict: a code registered with the form would be stripped by the
    // schema's resolver, and the server would ask again forever.
    expect(h.complete.mock.calls[1]![0]).toStrictEqual({
      password: TYPED_VALUE,
      confirmPassword: TYPED_VALUE,
      totpCode: '123456',
    });
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith('/signin?reset=success'));
  });

  it('a refused code empties the box and says why on the form', async () => {
    h.complete.mockResolvedValueOnce(asked()).mockResolvedValueOnce(asked(REFUSED));
    const user = userEvent.setup();
    render(<ResetCompleteForm />);

    await fillPasswords(user);
    await press(user);
    await user.type(await codeBox(), '123456');
    await press(user);

    expect(await screen.findByRole('alert')).toHaveTextContent(REFUSED);
    const box = await codeBox();
    expect(box).toHaveValue('');
    await waitFor(() => expect(box).toHaveFocus());
    expect(screen.getByLabelText('New password')).toHaveValue(TYPED_VALUE);
    expect(screen.getByLabelText('Confirm password')).toHaveValue(TYPED_VALUE);
    expect(h.replace).not.toHaveBeenCalled();
  });

  it('a code pasted with a space is sent as six digits', async () => {
    h.complete.mockResolvedValueOnce(asked()).mockResolvedValueOnce(DONE);
    const user = userEvent.setup();
    render(<ResetCompleteForm />);

    await fillPasswords(user);
    await press(user);
    const box = await codeBox();

    // Typed, the space never stays; only a paste of the whole string meets a
    // maxLength, which cuts it at six characters: "123 45".
    await user.type(box, '123 456');
    expect(box).toHaveValue('123456');
    await user.clear(box);
    await user.click(box);
    await user.paste('123 456');
    expect(box).toHaveValue('123456');

    await press(user);
    await waitFor(() => expect(h.complete).toHaveBeenCalledTimes(2));
    expect(h.complete.mock.calls[1]![0]).toMatchObject({ totpCode: '123456' });
  });

  it('the interrupted-run records go before the request that carries the code too', async () => {
    const keysAtCall: string[][] = [];
    h.complete
      .mockImplementationOnce(async () => {
        keysAtCall.push(interruptedRunKeys());
        return asked();
      })
      .mockImplementationOnce(async () => {
        keysAtCall.push(interruptedRunKeys());
        return DONE;
      });
    seedInterruptedRuns();
    const user = userEvent.setup();
    render(<ResetCompleteForm />);

    await fillPasswords(user);
    await press(user);
    const box = await codeBox();
    seedInterruptedRuns();
    await user.type(box, '123456');
    await press(user);

    await waitFor(() => expect(h.complete).toHaveBeenCalledTimes(2));
    expect(keysAtCall).toEqual([[], []]);
    expect(sessionStorage.getItem(UNRELATED_KEY)).toBe('kept');
  });

  it('a code that is not six digits sends nothing and removes nothing', async () => {
    h.complete.mockResolvedValueOnce(asked());
    const user = userEvent.setup();
    render(<ResetCompleteForm />);

    await fillPasswords(user);
    await press(user);
    const box = await codeBox();
    seedInterruptedRuns();
    await user.type(box, '123');
    await press(user);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Enter the 6-digit code from your authenticator app.',
    );
    await waitFor(() => expect(box).toHaveFocus());
    expect(h.complete).toHaveBeenCalledTimes(1);
    expect(interruptedRunKeys()).toHaveLength(2);
  });

  it("one press for an account with no authenticator, and for an owner's invite", async () => {
    const user = userEvent.setup();
    render(<ResetCompleteForm />);

    await fillPasswords(user);
    await press(user);

    await waitFor(() => expect(h.complete).toHaveBeenCalledTimes(1));
    // Strict: no totpCode key at all (toEqual would let an undefined one by).
    expect(h.complete.mock.calls[0]![0]).toStrictEqual({
      password: TYPED_VALUE,
      confirmPassword: TYPED_VALUE,
    });
    expect(screen.queryByRole('textbox', { name: 'Authentication code' })).toBeNull();
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith('/signin?reset=success'));
  });

  it.each([
    ['rate_limited', 'Too many attempts. Try again in a few minutes.'],
    ['internal_error', 'Could not update your password.'],
  ])('a %s refusal is said on the form and shows no box', async (code, message) => {
    h.complete.mockResolvedValueOnce({ ok: false, error: { code, message } });
    const user = userEvent.setup();
    render(<ResetCompleteForm />);

    await fillPasswords(user);
    await press(user);

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(h.toastError).toHaveBeenCalledWith(message);
    expect(screen.queryByRole('textbox', { name: 'Authentication code' })).toBeNull();
    expect(h.replace).not.toHaveBeenCalled();
  });

  it('after the code is accepted and the password refused, the next press goes through', async () => {
    const SAME = 'Choose a password that is different from your current one.';
    h.complete
      .mockResolvedValueOnce(asked())
      .mockResolvedValueOnce({ ok: false, error: { code: 'validation_error', message: SAME } })
      .mockResolvedValueOnce(DONE);
    const user = userEvent.setup();
    render(<ResetCompleteForm />);

    await fillPasswords(user);
    await press(user);
    await user.type(await codeBox(), '123456');
    await press(user);

    expect(await screen.findByRole('alert')).toHaveTextContent(SAME);
    // The session is AAL2 now, so the server skips the code on the next press;
    // the box keeps it either way.
    expect(await codeBox()).toHaveValue('123456');

    await press(user);
    await waitFor(() => expect(h.complete).toHaveBeenCalledTimes(3));
    expect(h.complete.mock.calls[2]![0]).toMatchObject({ totpCode: '123456' });
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith('/signin?reset=success'));
  });

  it('a request that gets no answer says so on the form', async () => {
    h.complete.mockRejectedValueOnce(new Error('fetch failed'));
    const user = userEvent.setup();
    render(<ResetCompleteForm />);

    await fillPasswords(user);
    await press(user);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not reach the server. Try again.',
    );
    // Update password works again, to send the same request once more.
    expect(await screen.findByRole('button', { name: 'Update password' })).toBeEnabled();
    expect(h.replace).not.toHaveBeenCalled();
  });

  // Built the way lot-trace-search.test.tsx builds it: a Server Action that
  // redirected rejects with the redirect the router is already following.
  it('a request answered with a redirect shows nothing', async () => {
    let signInRedirect: unknown = null;
    try {
      redirect('/signin');
    } catch (e) {
      signInRedirect = e;
    }
    expect(signInRedirect).not.toBeNull();
    h.complete.mockRejectedValueOnce(signInRedirect);
    const user = userEvent.setup();
    render(<ResetCompleteForm />);

    await fillPasswords(user);
    await press(user);

    await waitFor(() => expect(h.complete).toHaveBeenCalledTimes(1));
    await screen.findByRole('button', { name: 'Update password' });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(h.toastError).not.toHaveBeenCalled();
    expect(screen.queryByText(/NEXT_REDIRECT/)).toBeNull();
  });
});
