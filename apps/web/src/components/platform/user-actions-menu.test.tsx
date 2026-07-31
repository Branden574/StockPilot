import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  refresh: vi.fn(),
  push: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  disable: vi.fn(),
  reenable: vi.fn(),
  reset: vi.fn(),
  ensure: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: h.refresh, push: h.push }),
}));
vi.mock('sonner', () => ({ toast: { success: h.success, error: h.error } }));
vi.mock('@/components/auth/step-up-modal', () => ({
  useStepUp: () => ({ ensure: h.ensure, modal: null }),
}));
vi.mock('@/server/actions/platform/users', () => ({
  disableUserAccountAction: (...a: unknown[]) => h.disable(...a),
  reenableUserAccountAction: (...a: unknown[]) => h.reenable(...a),
  sendUserPasswordResetAction: (...a: unknown[]) => h.reset(...a),
}));

import { UserActionsMenu } from './user-actions-menu';

const USER_ID = '11111111-1111-1111-1111-111111111111';
const EMAIL = 'target@example.com';

// Radix DropdownMenu leans on Pointer Capture, absent in happy-dom.
beforeAll(() => {
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = () => {};
  if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => {};
});

beforeEach(() => {
  vi.clearAllMocks();
  h.disable.mockResolvedValue({ ok: true, data: { sessionsRevoked: 2, alreadyDisabled: false } });
  h.reenable.mockResolvedValue({ ok: true, data: { alreadyActive: false } });
  h.reset.mockResolvedValue({ ok: true, data: { ok: true } });
  h.ensure.mockResolvedValue(true);
});

function renderMenu(
  props: Partial<{
    email: string | null;
    disabledAt: string | null;
    protectedAdmin: boolean;
  }> = {},
) {
  return render(
    <UserActionsMenu
      userId={USER_ID}
      email={props.email === undefined ? EMAIL : props.email}
      disabledAt={props.disabledAt ?? null}
      protectedAdmin={props.protectedAdmin ?? false}
    />,
  );
}

async function openMenu() {
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  await user.click(screen.getByRole('button', { name: /user actions/i }));
  await screen.findByRole('menu');
  return user;
}

/** Opens the menu, opens the confirm dialog, and satisfies both gates. */
async function armDisableDialog() {
  const user = await openMenu();
  await user.click(screen.getByRole('menuitem', { name: /disable account/i }));
  const dialog = await screen.findByRole('dialog');
  await user.type(screen.getByLabelText(/to confirm/i), EMAIL);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /^disable account$/i })).toBeEnabled(),
  );
  return { user, dialog };
}

describe('UserActionsMenu — what the menu offers', () => {
  it('offers Disable for an active, unprotected account', async () => {
    renderMenu();
    await openMenu();
    expect(screen.getByRole('menuitem', { name: /disable account/i })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /re-enable/i })).not.toBeInTheDocument();
  });

  it('offers Re-enable, and not Disable, for a disabled account', async () => {
    renderMenu({ disabledAt: '2026-07-30T12:00:00Z' });
    await openMenu();
    expect(screen.getByRole('menuitem', { name: /re-enable account/i })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /disable account/i })).not.toBeInTheDocument();
  });

  it('hides both status actions for a protected platform admin', async () => {
    renderMenu({ protectedAdmin: true });
    await openMenu();
    expect(screen.queryByRole('menuitem', { name: /disable account/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /re-enable/i })).not.toBeInTheDocument();
    // The non-destructive action survives.
    expect(screen.getByRole('menuitem', { name: /password reset/i })).toBeInTheDocument();
  });

  // Without an email there is nothing to type into the type-to-confirm gate,
  // so the action must not be reachable at all.
  it('hides Disable when the member has no email on file', async () => {
    renderMenu({ email: null });
    await openMenu();
    expect(screen.queryByRole('menuitem', { name: /disable account/i })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /password reset/i })).toBeInTheDocument();
  });

  it('still offers Re-enable when the member has no email on file', async () => {
    renderMenu({ email: null, disabledAt: '2026-07-30T12:00:00Z' });
    await openMenu();
    expect(screen.getByRole('menuitem', { name: /re-enable account/i })).toBeInTheDocument();
  });
});

describe('UserActionsMenu — disabling', () => {
  it('sends the target and the structured reason, then reports the revocations', async () => {
    renderMenu();
    const { user } = await armDisableDialog();
    await user.click(screen.getByRole('button', { name: /^disable account$/i }));

    await waitFor(() =>
      expect(h.disable).toHaveBeenCalledWith({
        targetUserId: USER_ID,
        reason: { category: 'security_investigation' },
      }),
    );
    await waitFor(() => expect(h.success).toHaveBeenCalled());
    expect(String(h.success.mock.calls[0]![0])).toMatch(/2 sessions revoked/i);
    expect(h.refresh).toHaveBeenCalled();
  });

  it('renders a lost race as a reload-and-retry conflict, never a permission problem', async () => {
    h.disable.mockResolvedValue({
      ok: false,
      error: {
        code: 'conflict',
        message:
          "That account's status changed while you were working. Reload the page and try again.",
        details: { code: 'ACCOUNT_STATUS_CHANGED' },
      },
    });
    renderMenu();
    const { user } = await armDisableDialog();
    await user.click(screen.getByRole('button', { name: /^disable account$/i }));

    await waitFor(() => expect(h.error).toHaveBeenCalled());
    const message = String(h.error.mock.calls[0]![0]);
    expect(message).toMatch(/reload the page and try again/i);
    expect(message).not.toMatch(/not authorized|permission|forbidden/i);
    // A stale row must be re-read, which is exactly what the message promises.
    await waitFor(() => expect(h.refresh).toHaveBeenCalled());
  });

  it('surfaces every partial reason verbatim, including an unaudited change', async () => {
    h.disable.mockResolvedValue({
      ok: false,
      error: {
        code: 'internal_error',
        message:
          'The account is flagged as disabled, but the sign-in block did not finish applying, and the change was not written to the audit log. Press Disable again to complete it.',
        details: {
          code: 'ACCOUNT_TEMPORARILY_DISABLED',
          partialReasons: ['ban_not_applied', 'not_audited'],
        },
      },
    });
    renderMenu();
    const { user } = await armDisableDialog();
    await user.click(screen.getByRole('button', { name: /^disable account$/i }));

    await waitFor(() => expect(h.error).toHaveBeenCalled());
    const message = String(h.error.mock.calls[0]![0]);
    expect(message).toMatch(/flagged as disabled/i);
    expect(message).toMatch(/not written to the audit log/i);
    expect(h.success).not.toHaveBeenCalled();
    // The dialog stays open so the advertised "press Disable again" is reachable.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('re-challenges TOTP on a stale step-up and retries exactly once', async () => {
    h.disable
      .mockResolvedValueOnce({
        ok: false,
        error: {
          code: 'forbidden',
          message: 'Not authorized.',
          details: { code: 'ACCOUNT_DISABLE_NOT_AUTHORIZED', reason: 'aal2_required' },
        },
      })
      .mockResolvedValueOnce({ ok: true, data: { sessionsRevoked: 0, alreadyDisabled: false } });

    renderMenu();
    const { user } = await armDisableDialog();
    await user.click(screen.getByRole('button', { name: /^disable account$/i }));

    await waitFor(() => expect(h.ensure).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(h.disable).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(h.success).toHaveBeenCalled());
  });

  it('gives up quietly when the operator abandons the step-up', async () => {
    h.disable.mockResolvedValue({
      ok: false,
      error: {
        code: 'forbidden',
        message: 'Not authorized.',
        details: { code: 'ACCOUNT_DISABLE_NOT_AUTHORIZED', reason: 'aal2_required' },
      },
    });
    h.ensure.mockResolvedValue(false);

    renderMenu();
    const { user } = await armDisableDialog();
    await user.click(screen.getByRole('button', { name: /^disable account$/i }));

    await waitFor(() => expect(h.error).toHaveBeenCalled());
    expect(h.disable).toHaveBeenCalledTimes(1);
  });

  it('writes nothing when the dialog is cancelled', async () => {
    renderMenu();
    const { user } = await armDisableDialog();
    await user.click(screen.getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(h.disable).not.toHaveBeenCalled();
  });
});

describe('UserActionsMenu — re-enabling', () => {
  it('lifts the disable and refreshes the row', async () => {
    renderMenu({ disabledAt: '2026-07-30T12:00:00Z' });
    const user = await openMenu();
    await user.click(screen.getByRole('menuitem', { name: /re-enable account/i }));

    await waitFor(() => expect(h.reenable).toHaveBeenCalledWith({ targetUserId: USER_ID }));
    await waitFor(() => expect(h.success).toHaveBeenCalled());
    expect(String(h.success.mock.calls[0]![0])).toMatch(/can sign in again/i);
    expect(h.refresh).toHaveBeenCalled();
  });

  it('reports a re-enable conflict without claiming a permission problem', async () => {
    h.reenable.mockResolvedValue({
      ok: false,
      error: {
        code: 'conflict',
        message: 'That account is not disabled.',
        details: { code: 'ACCOUNT_NOT_DISABLED' },
      },
    });
    renderMenu({ disabledAt: '2026-07-30T12:00:00Z' });
    const user = await openMenu();
    await user.click(screen.getByRole('menuitem', { name: /re-enable account/i }));

    await waitFor(() => expect(h.error).toHaveBeenCalledWith('That account is not disabled.'));
    expect(h.success).not.toHaveBeenCalled();
  });
});

describe('UserActionsMenu — password reset', () => {
  it('confirms first, then sends', async () => {
    const confirmSpy = vi.fn(() => true);
    vi.stubGlobal('confirm', confirmSpy);
    renderMenu();
    const user = await openMenu();
    await user.click(screen.getByRole('menuitem', { name: /password reset/i }));

    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() => expect(h.reset).toHaveBeenCalledWith({ targetUserId: USER_ID }));
    vi.unstubAllGlobals();
  });

  it('sends nothing when the confirm is dismissed', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false));
    renderMenu();
    const user = await openMenu();
    await user.click(screen.getByRole('menuitem', { name: /password reset/i }));

    expect(h.reset).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
