import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const replace = vi.fn();
const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace, push }) }));
const errorMock = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({
  toast: {
    error: (...a: unknown[]) => errorMock(...a),
    success: vi.fn(),
  },
}));
const deleteOwnAccountAction = vi.hoisted(() => vi.fn());
vi.mock('@/server/actions/profile', () => ({ deleteOwnAccountAction }));

import { DeleteAccountButton, LAST_OWNER_TOAST_MS, showDeleteAccountError } from './delete-account-button';

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * A3 review 2026-10-05: the last-owner refusal is an instruction the person
 * has to follow (transfer ownership on the Team page). In a default 4 s toast
 * it vanished while the dialog stayed open. It now stays long enough to read
 * and carries a link to the Team page; every other refusal is unchanged.
 */
describe('showDeleteAccountError', () => {
  it('keeps the last-owner sentence up for 15 s with a link to the Team page', () => {
    const openTeam = vi.fn();
    showDeleteAccountError(
      { message: 'You are the only owner of Learn4Life. …', details: { reason: 'last_owner' } },
      openTeam,
    );
    expect(LAST_OWNER_TOAST_MS).toBe(15_000);
    expect(errorMock).toHaveBeenCalledTimes(1);
    const [message, options] = errorMock.mock.calls[0] as [string, { duration: number; action: { label: string; onClick: () => void } }];
    expect(message).toBe('You are the only owner of Learn4Life. …');
    expect(options.duration).toBe(LAST_OWNER_TOAST_MS);
    expect(options.action.label).toBe('Open the Team page');
    options.action.onClick();
    expect(openTeam).toHaveBeenCalledTimes(1);
  });

  it('shows any other refusal as before (default duration, no action)', () => {
    const openTeam = vi.fn();
    showDeleteAccountError({ message: 'Your account could not be deleted right now.', details: undefined }, openTeam);
    showDeleteAccountError({ message: 'This account is a StockPilot platform admin.', details: { reason: 'platform_admin' } }, openTeam);
    expect(errorMock.mock.calls).toEqual([
      ['Your account could not be deleted right now.'],
      ['This account is a StockPilot platform admin.'],
    ]);
    expect(openTeam).not.toHaveBeenCalled();
  });
});

/**
 * L112: a refused Delete account (the last owner of an organization with other
 * members) showed its reason only as a toast, which sat behind the dialog that
 * stayed open. The reason now also shows inside the dialog, until it is closed
 * or the person tries again.
 */
const REFUSAL = 'You are the only owner of Demo Co. Make another member the owner first.';

async function openAndConfirm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Delete my account' }));
  const dialog = screen.getByRole('dialog');
  await user.type(within(dialog).getByRole('textbox'), 'DELETE');
  await user.click(within(dialog).getByRole('button', { name: 'Delete account' }));
  return dialog;
}

describe('DeleteAccountButton: a refusal', () => {
  beforeEach(() => {
    deleteOwnAccountAction.mockResolvedValue({
      ok: false,
      error: { code: 'conflict', message: REFUSAL, details: { reason: 'last_owner' } },
    });
  });

  it('says why inside the dialog, which stays open, and still toasts with the Team link', async () => {
    const user = userEvent.setup();
    render(<DeleteAccountButton />);

    const dialog = await openAndConfirm(user);

    expect(within(dialog).getByRole('alert')).toHaveTextContent(REFUSAL);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(errorMock).toHaveBeenCalledWith(
      REFUSAL,
      expect.objectContaining({ duration: LAST_OWNER_TOAST_MS }),
    );
    expect(replace).not.toHaveBeenCalled();
  });

  it('a plain refusal shows inside the dialog too', async () => {
    deleteOwnAccountAction.mockResolvedValue({
      ok: false,
      error: { code: 'internal', message: 'Your account could not be deleted right now.' },
    });
    const user = userEvent.setup();
    render(<DeleteAccountButton />);

    const dialog = await openAndConfirm(user);

    expect(within(dialog).getByRole('alert')).toHaveTextContent('Your account could not be deleted right now.');
    expect(errorMock).toHaveBeenCalledWith('Your account could not be deleted right now.');
  });

  it('clears the reason when the dialog is opened again', async () => {
    const user = userEvent.setup();
    render(<DeleteAccountButton />);

    await openAndConfirm(user);
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Delete my account' }));

    expect(within(screen.getByRole('dialog')).queryByRole('alert')).toBeNull();
  });

  it('clears the reason while it tries again', async () => {
    const user = userEvent.setup();
    render(<DeleteAccountButton />);
    const dialog = await openAndConfirm(user);
    expect(within(dialog).getByRole('alert')).toBeInTheDocument();

    let resolve!: (v: unknown) => void;
    deleteOwnAccountAction.mockReturnValue(new Promise((r) => (resolve = r)));
    await user.click(within(dialog).getByRole('button', { name: /Delete account/ }));
    expect(within(screen.getByRole('dialog')).queryByRole('alert')).toBeNull();
    resolve({ ok: true, data: undefined });
  });
});
