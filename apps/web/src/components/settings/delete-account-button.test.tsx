import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fakeBroadcastChannels,
  interruptedRunKeys,
  seedInterruptedRuns,
  UNRELATED_KEY,
} from '@/test/interrupted-run-fixtures';

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

import { DeleteAccountButton } from './delete-account-button';

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * L112: a refused Delete account (the last owner of an organization with other
 * members) showed its reason only as a toast, which sat behind the dialog that
 * stayed open. The reason now shows inside the dialog, until it is closed or
 * the person tries again.
 *
 * Test stage: the A3 review's 15 s toast carried "Open the Team page", but an
 * open dialog takes every click outside it (the body gets pointer-events: none),
 * so neither the link nor the toast's close could be pressed, and at 390 px the
 * toast covered the dialog's buttons. The link now sits in the dialog with the
 * reason, and a refusal the dialog shows raises no toast.
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

  it('says why inside the dialog, which stays open, with the Team page link beside it and no toast', async () => {
    const user = userEvent.setup();
    render(<DeleteAccountButton />);

    const dialog = await openAndConfirm(user);

    expect(within(dialog).getByRole('alert')).toHaveTextContent(REFUSAL);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(errorMock).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Open the Team page' }));
    expect(push).toHaveBeenCalledWith('/dashboard/team');
    expect(screen.queryByRole('dialog')).toBeNull();
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
    expect(within(dialog).queryByRole('button', { name: 'Open the Team page' })).toBeNull();
    expect(errorMock).not.toHaveBeenCalled();
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

/**
 * Deleting the account ends this browser's session on purpose (the action
 * signs it out), so what an interrupted run kept in this tab
 * (lib/interrupted-run) goes before the request leaves.
 */
describe('DeleteAccountButton: deleting the account', () => {
  afterEach(() => {
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it('removes every interrupted-run record in this tab before the request leaves', async () => {
    sessionStorage.clear();
    seedInterruptedRuns();
    let keysAtRequest: string[] | null = null;
    deleteOwnAccountAction.mockImplementation(async () => {
      keysAtRequest = interruptedRunKeys();
      return { ok: true, data: undefined };
    });
    const user = userEvent.setup();
    render(<DeleteAccountButton />);

    await openAndConfirm(user);

    await waitFor(() => expect(deleteOwnAccountAction).toHaveBeenCalledTimes(1));
    expect(keysAtRequest).toEqual([]);
    expect(sessionStorage.getItem(UNRELATED_KEY)).toBe('kept');
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/signin'));
  });

  it('tells the other tabs of this browser before the request leaves: the action signs them out too', async () => {
    // Review of round 2's repair: the action ends the session in every tab
    // (the session cookies are the browser's) and sends no revoke, so another
    // tab kept its records until their hour.
    const tabs = fakeBroadcastChannels();
    const otherTab = tabs.otherTab();
    let sentAtRequest: unknown[] | null = null;
    deleteOwnAccountAction.mockImplementation(async () => {
      sentAtRequest = tabs.sent();
      return { ok: true, data: undefined };
    });
    const user = userEvent.setup();
    render(<DeleteAccountButton />);

    await openAndConfirm(user);

    await waitFor(() => expect(deleteOwnAccountAction).toHaveBeenCalledTimes(1));
    expect(sentAtRequest).toEqual([{ type: 'purge' }]);
    tabs.deliver();
    expect(otherTab.received).toEqual([{ type: 'purge' }]);
  });

  it('opening the dialog and cancelling removes nothing and tells no other tab', async () => {
    const tabs = fakeBroadcastChannels();
    sessionStorage.clear();
    seedInterruptedRuns();
    const user = userEvent.setup();
    render(<DeleteAccountButton />);

    await user.click(screen.getByRole('button', { name: 'Delete my account' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));

    expect(deleteOwnAccountAction).not.toHaveBeenCalled();
    expect(interruptedRunKeys()).toHaveLength(2);
    expect(tabs.sent()).toEqual([]);
  });
});
