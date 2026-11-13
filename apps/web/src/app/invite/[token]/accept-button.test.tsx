import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Accept invite button: a new member is welcomed; a person who was
 * already a member is told their access has not changed. Both go to the
 * dashboard.
 */

const h = vi.hoisted(() => ({
  result: null as unknown,
  replace: vi.fn(),
  refresh: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@/server/actions/team', () => ({ acceptInviteAction: vi.fn(async () => h.result) }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: h.replace, refresh: h.refresh }),
}));
vi.mock('sonner', () => ({ toast: { success: h.success, info: h.info, error: h.error } }));

import { AcceptInviteButton } from './accept-button';
import { INVITE_ALREADY_MEMBER_TOAST } from './invite-copy';

beforeEach(() => vi.clearAllMocks());

async function press() {
  render(<AcceptInviteButton token="invite-ref-0001" />);
  fireEvent.click(screen.getByRole('button', { name: 'Accept invite' }));
  await waitFor(() => expect(h.replace).toHaveBeenCalledWith('/dashboard'));
}

describe('AcceptInviteButton', () => {
  it('already a member: says the access has not changed, no welcome', async () => {
    h.result = { ok: true, data: { organizationId: 'org-1', alreadyMember: true } };
    await press();
    expect(h.info).toHaveBeenCalledWith(INVITE_ALREADY_MEMBER_TOAST);
    expect(INVITE_ALREADY_MEMBER_TOAST).toBe(
      "You're already a member of this organization. Your access has not changed.",
    );
    expect(h.success).not.toHaveBeenCalled();
  });

  it('new member: the welcome, as before', async () => {
    h.result = { ok: true, data: { organizationId: 'org-1', alreadyMember: false } };
    await press();
    expect(h.success).toHaveBeenCalledWith('Invite accepted. Welcome to the team.');
    expect(h.info).not.toHaveBeenCalled();
  });
});
