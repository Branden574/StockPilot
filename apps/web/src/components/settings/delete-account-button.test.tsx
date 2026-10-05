import { beforeEach, describe, expect, it, vi } from 'vitest';

const errorMock = vi.fn();

vi.mock('sonner', () => ({
  toast: {
    error: (...a: unknown[]) => errorMock(...a),
    success: vi.fn(),
  },
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
vi.mock('@/server/actions/profile', () => ({ deleteOwnAccountAction: vi.fn() }));

import { LAST_OWNER_TOAST_MS, showDeleteAccountError } from './delete-account-button';

beforeEach(() => {
  errorMock.mockReset();
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
