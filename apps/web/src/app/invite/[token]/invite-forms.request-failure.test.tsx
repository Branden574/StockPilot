import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { requestFailedMessage } from '@/lib/request-failure';
import { offline } from '@/test/rejected-request';

// B40: accepting an invite when the request got no answer (offline, a server
// error, a deploy) left the button spinning for good, with nothing said.

const replace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
const actions = vi.hoisted(() => ({
  acceptInviteAction: vi.fn(),
  acceptInviteWithSignupAction: vi.fn(),
}));
vi.mock('@/server/actions/team', () => actions);

import { AcceptInviteButton } from './accept-button';
import { InviteSignupForm } from './signup-form';

beforeEach(() => vi.clearAllMocks());

describe('invite forms when the request gets no answer', () => {
  it('Accept invite stops its spinner and says the invite was not accepted', async () => {
    actions.acceptInviteAction.mockRejectedValueOnce(offline());
    render(<AcceptInviteButton token="tok-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Accept invite' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(requestFailedMessage('accept the invite')),
    );
    expect(screen.getByRole('button', { name: 'Accept invite' })).toBeEnabled();
    expect(replace).not.toHaveBeenCalled();
  });

  it('Accept & create account stops its spinner and says the account was not created', async () => {
    actions.acceptInviteWithSignupAction.mockRejectedValueOnce(offline());
    render(<InviteSignupForm token="tok-1" email="new.member@example.com" />);
    fireEvent.change(screen.getByLabelText('Choose a password'), {
      target: { value: 'longenough' },
    });
    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: 'longenough' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Accept & create account' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(requestFailedMessage('create your account')),
    );
    expect(screen.getByRole('button', { name: 'Accept & create account' })).toBeEnabled();
    expect(replace).not.toHaveBeenCalled();
  });
});
