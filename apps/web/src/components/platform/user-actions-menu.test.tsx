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
  /**
   * BOTH status items are offered on every row, and that is the fix for the
   * finding below rather than a cosmetic choice. The items are idempotent state
   * SETTERS ("make this account disabled" / "make this account active") and the
   * row's own Disabled chip is what reports the current state; deriving which
   * item exists from `disabledAt` is what made a half-applied change
   * unrepairable the moment the page was reloaded.
   */
  it('offers both status actions for an active, unprotected account', async () => {
    renderMenu();
    await openMenu();
    expect(screen.getByRole('menuitem', { name: /disable account/i })).toBeInTheDocument();
    // Reachable on an ACTIVE row because a partial re-enable leaves exactly
    // that row shape with the sign-in block still standing.
    expect(screen.getByRole('menuitem', { name: /re-enable account/i })).toBeInTheDocument();
  });

  it('offers both status actions for a disabled account', async () => {
    renderMenu({ disabledAt: '2026-07-30T12:00:00Z' });
    await openMenu();
    expect(screen.getByRole('menuitem', { name: /re-enable account/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /disable account/i })).toBeInTheDocument();
  });

  it('hides Disable for a protected platform admin', async () => {
    renderMenu({ protectedAdmin: true });
    await openMenu();
    expect(screen.queryByRole('menuitem', { name: /disable account/i })).not.toBeInTheDocument();
    // Re-enable is never refused by the server, for anyone, so it stays.
    expect(screen.getByRole('menuitem', { name: /re-enable account/i })).toBeInTheDocument();
    // The non-destructive action survives.
    expect(screen.getByRole('menuitem', { name: /password reset/i })).toBeInTheDocument();
  });

  /**
   * The asymmetry is the point. Disable is refused for a protected admin by the
   * SERVER, so hiding it is an honest courtesy. Re-enable is NOT refused by the
   * server for a protected admin — restoring access to a god admin is always
   * allowed. Gating the menu item on `!protectedAdmin` invented a restriction
   * the server does not have, and it stranded exactly one real account shape:
   * a user disabled BEFORE their address was added to
   * STOCKPILOT_PLATFORM_ADMIN_EMAILS could never be re-enabled from the console
   * at all.
   */
  it('offers Re-enable for a protected platform admin who is already disabled', async () => {
    renderMenu({ protectedAdmin: true, disabledAt: '2026-07-30T12:00:00Z' });
    await openMenu();
    expect(screen.getByRole('menuitem', { name: /re-enable account/i })).toBeInTheDocument();
    // Disable stays refused — you may always restore access, never remove a
    // god admin's.
    expect(screen.queryByRole('menuitem', { name: /disable account/i })).not.toBeInTheDocument();
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

/**
 * THE ADVERTISED RETRY MUST SURVIVE A REFRESH.
 *
 * A partial result tells the operator to press a named button again. The menu
 * used to derive which button existed from the server-rendered `disabledAt`,
 * so the retry survived only inside that one page instance: reload, navigate,
 * or hand the incident to a colleague, and the button the toast named was
 * gone. Worse in the mirror case — a re-enable returning ['ban_not_lifted']
 * clears the flag while the ban stands, so after a reload the row read Active,
 * "Re-enable account" was gone, and for a member with no email on file
 * "Disable account..." was hidden too: a signed-out, banned, legitimate user
 * with no status action anywhere in the product.
 *
 * These render the POST-REFRESH row shape each partial leaves behind and
 * require the named button to still be there.
 */
describe('UserActionsMenu — the advertised retry survives a reload', () => {
  it('a partial disable leaves a Disabled row that can still be pressed Disable', async () => {
    // What the server renders after the refresh: Layer A landed.
    renderMenu({ disabledAt: '2026-07-30T12:00:00Z' });
    await openMenu();

    expect(screen.getByRole('menuitem', { name: /disable account/i })).toBeInTheDocument();
  });

  it('a partial re-enable leaves an Active row that can still be pressed Re-enable', async () => {
    // What the server renders after the refresh: the flag was cleared, and the
    // stray ban this retry exists to clear is invisible to the console.
    renderMenu({ disabledAt: null });
    await openMenu();

    expect(screen.getByRole('menuitem', { name: /re-enable account/i })).toBeInTheDocument();
  });

  it('reaches the worst case: active row, banned user, no email on file', async () => {
    renderMenu({ email: null, disabledAt: null });
    await openMenu();

    // Disable stays hidden (nothing to type into the confirm gate) — but the
    // action that actually clears the ban must not be hidden with it.
    expect(screen.queryByRole('menuitem', { name: /disable account/i })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /re-enable account/i })).toBeInTheDocument();
  });

  /**
   * Both items are always present, so `disabledAt` stops deciding WHETHER an
   * action exists — but it must still decide which one leads, or the menu
   * gives a disabled row and an active row identical guidance.
   */
  it('leads with Re-enable on a disabled row', async () => {
    renderMenu({ disabledAt: '2026-07-30T12:00:00Z' });
    await openMenu();

    const labels = screen.getAllByRole('menuitem').map((n) => n.textContent ?? '');
    expect(labels.findIndex((t) => /re-enable account/i.test(t))).toBeLessThan(
      labels.findIndex((t) => /^disable account/i.test(t)),
    );
  });

  it('leads with Disable on an active row', async () => {
    renderMenu({ disabledAt: null });
    await openMenu();

    const labels = screen.getAllByRole('menuitem').map((n) => n.textContent ?? '');
    expect(labels.findIndex((t) => /^disable account/i.test(t))).toBeLessThan(
      labels.findIndex((t) => /re-enable account/i.test(t)),
    );
  });

  it('actually runs the re-enable from an active row', async () => {
    renderMenu({ disabledAt: null });
    const user = await openMenu();
    await user.click(screen.getByRole('menuitem', { name: /re-enable account/i }));

    await waitFor(() => expect(h.reenable).toHaveBeenCalledWith({ targetUserId: USER_ID }));
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

  /**
   * A PARTIAL re-enable carries code ACCOUNT_NOT_DISABLED *and* partialReasons:
   * the authoritative half landed (the flag is cleared) but a later layer did
   * not. ACCOUNT_NOT_DISABLED is also a stale-status code, so checking
   * staleness first sent this down the refresh path — which re-reads the row,
   * now `disabledAt: null`, and unmounts the very "Re-enable account" item the
   * toast just told the operator to press. The advertised retry has to survive.
   */
  it('keeps the advertised retry reachable after a partial re-enable', async () => {
    h.reenable.mockResolvedValue({
      ok: false,
      error: {
        code: 'internal_error',
        message:
          'The disable flag was cleared, but the change was not written to the audit log. Press Re-enable again to finish.',
        details: { code: 'ACCOUNT_NOT_DISABLED', partialReasons: ['not_audited'] },
      },
    });
    renderMenu({ disabledAt: '2026-07-30T12:00:00Z' });
    const user = await openMenu();
    await user.click(screen.getByRole('menuitem', { name: /re-enable account/i }));

    await waitFor(() => expect(h.error).toHaveBeenCalled());
    expect(String(h.error.mock.calls[0]![0])).toMatch(/press re-enable again/i);
    expect(h.success).not.toHaveBeenCalled();
    // Refreshing is what would strand the retry, so it must NOT happen.
    expect(h.refresh).not.toHaveBeenCalled();
    // And the item the message names is still there to be pressed.
    await openMenu();
    expect(screen.getByRole('menuitem', { name: /re-enable account/i })).toBeInTheDocument();
  });

  /**
   * The counterpart: a genuinely stale row (no partialReasons) must still
   * refresh, which is literally what its own message instructs.
   */
  it('still re-reads the row on a stale-only re-enable conflict', async () => {
    h.reenable.mockResolvedValue({
      ok: false,
      error: {
        code: 'conflict',
        message:
          "That account's status changed while you were working. Reload the page and try again.",
        details: { code: 'ACCOUNT_STATUS_CHANGED' },
      },
    });
    renderMenu({ disabledAt: '2026-07-30T12:00:00Z' });
    const user = await openMenu();
    await user.click(screen.getByRole('menuitem', { name: /re-enable account/i }));

    await waitFor(() => expect(h.refresh).toHaveBeenCalled());
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
