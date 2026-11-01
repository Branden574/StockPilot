import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Role } from '@stockpilot/core';

import { requestFailedMessage } from '@/lib/request-failure';
import { offline, recordEscapedRejections, signInRedirect } from '@/test/rejected-request';

// ---------------------------------------------------------------------------
// B40: the Team page. Remove, Send password reset and Revoke invite set a
// busy flag that is also their confirm's `pending`, awaited the action with
// no catch and cleared it only when it answered: a call that got no answer
// (offline, a server error, a deploy) left a confirm that could not be
// closed, and nothing was said. Resend, the charters and warehouse dialogs,
// Transfer ownership and Send invite spun forever or said nothing; Change
// role and the driver mark (no busy flag) failed in silence. Now each says
// what did not happen, inside its confirm where it has one; a redirect to
// sign-in says nothing.
// ---------------------------------------------------------------------------

const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
// The real unstable_rethrow stays, so isControlFlow recognises the redirect.
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ push, refresh, back: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock('@/server/actions/team', () => ({
  inviteMemberAction: vi.fn(),
  removeMemberAction: vi.fn(),
  resendInviteAction: vi.fn(),
  revokeInviteAction: vi.fn(),
  sendMemberPasswordResetAction: vi.fn(),
  setMemberChartersAction: vi.fn(),
  setMemberDriverAction: vi.fn(),
  setMemberWarehouseAccessAction: vi.fn(),
  transferOwnershipAction: vi.fn(),
  updateMemberRoleAction: vi.fn(),
}));
vi.mock('@/server/actions/user-categories', () => ({ setUserCategoryAccessAction: vi.fn() }));

import { toast } from 'sonner';

import {
  inviteMemberAction,
  removeMemberAction,
  resendInviteAction,
  revokeInviteAction,
  sendMemberPasswordResetAction,
  setMemberChartersAction,
  setMemberDriverAction,
  setMemberWarehouseAccessAction,
  transferOwnershipAction,
  updateMemberRoleAction,
} from '@/server/actions/team';

import { TeamManager } from './team-manager';

// Radix DropdownMenu and Select lean on Pointer Capture, absent in the test DOM.
beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

// A redirect handled by the page leaves nothing behind (see recordEscapedRejections).
const escaped = recordEscapedRejections();

beforeEach(() => {
  vi.clearAllMocks();
});

type MemberProps = Parameters<typeof TeamManager>[0]['members'][number];

function member(overrides: Partial<MemberProps> = {}): MemberProps {
  return {
    id: 'm-1',
    userId: 'u-1',
    role: 'staff' as Role,
    invitedAt: null,
    acceptedAt: '2026-01-01T00:00:00.000Z',
    email: 'staff@example.com',
    fullName: 'Sam Staff',
    avatarUrl: null,
    warehouseId: 'wh-1',
    charterIds: [],
    allWarehouses: false,
    isDriver: false,
    disabledAt: null,
    ...overrides,
  };
}

function renderTeam(currentUserRole: Role = 'owner') {
  return render(
    <TeamManager
      currentUserRole={currentUserRole}
      members={[
        member({
          id: 'm-owner',
          userId: 'u-owner',
          role: 'owner',
          fullName: 'Olive Owner',
          email: 'owner@example.com',
          warehouseId: null,
        }),
        member(),
      ]}
      pendingInvites={[
        {
          id: 'inv-1',
          email: 'new@example.com',
          role: 'viewer',
          expiresAt: '2099-01-01T00:00:00.000Z',
          acceptUrl: 'https://app.example.com/i/tok-1',
        },
      ]}
      charters={[{ id: 'ch-1', name: 'North Charter' }]}
      warehouses={[{ id: 'wh-1', name: 'Main' }]}
      warehouseCharters={[{ warehouse_id: 'wh-1', charter_id: 'ch-1' }]}
      allCategories={[]}
      grantsByUser={{}}
      charterSingular="Charter"
      warehouseSingular="Warehouse"
      timeZone="America/Los_Angeles"
    />,
  );
}

async function openMenu() {
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  await user.click(screen.getByRole('button', { name: 'Actions for Sam Staff' }));
  await screen.findByRole('menu');
  return user;
}

describe('the Team page when a request gets no answer', () => {
  it('Remove says why inside the confirm, which stays open and can be closed', async () => {
    vi.mocked(removeMemberAction).mockRejectedValueOnce(offline());
    renderTeam();
    const user = await openMenu();
    await user.click(screen.getByRole('menuitem', { name: /Remove/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    const sentence = requestFailedMessage(offline(), 'remove the member');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(sentence);
    expect(toast.error).toHaveBeenCalledWith(sentence);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('a refused Remove also says why inside the confirm', async () => {
    vi.mocked(removeMemberAction).mockResolvedValueOnce({
      ok: false,
      error: { code: 'forbidden', message: 'You cannot remove this member.' },
    } as never);
    renderTeam();
    const user = await openMenu();
    await user.click(screen.getByRole('menuitem', { name: /Remove/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'You cannot remove this member.',
    );
  });

  it('Send reset link says why inside the confirm, which can be pressed again', async () => {
    vi.mocked(sendMemberPasswordResetAction).mockRejectedValueOnce(offline());
    renderTeam();
    const user = await openMenu();
    await user.click(screen.getByRole('menuitem', { name: 'Send password reset…' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Send reset link' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      requestFailedMessage(offline(), 'send the reset link'),
    );
    expect(within(dialog).getByRole('button', { name: 'Send reset link' })).toBeEnabled();
  });

  it('Revoke invite says why inside the confirm', async () => {
    vi.mocked(revokeInviteAction).mockRejectedValueOnce(offline());
    const user = userEvent.setup();
    renderTeam();
    await user.click(screen.getByRole('button', { name: 'Revoke invite for new@example.com' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Revoke invite' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      requestFailedMessage(offline(), 'revoke the invite'),
    );
    expect(within(dialog).getByRole('button', { name: 'Revoke invite' })).toBeEnabled();
  });

  it('Resend says the invite was not sent again and works again', async () => {
    vi.mocked(resendInviteAction).mockRejectedValueOnce(offline());
    const user = userEvent.setup();
    renderTeam();
    await user.click(screen.getByRole('button', { name: /Resend/ }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestFailedMessage(offline(), 'resend the invite'),
      ),
    );
    expect(screen.getByRole('button', { name: /Resend/ })).toBeEnabled();
  });

  it('Change role and the driver mark (no busy flag) say what did not happen', async () => {
    vi.mocked(updateMemberRoleAction).mockRejectedValueOnce(offline());
    vi.mocked(setMemberDriverAction).mockRejectedValueOnce(offline());
    renderTeam();
    let user = await openMenu();
    await user.click(screen.getByRole('menuitem', { name: 'Manager' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(requestFailedMessage(offline(), 'change the role')),
    );
    user = await openMenu();
    await user.click(screen.getByRole('menuitem', { name: 'Mark as delivery driver' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestFailedMessage(offline(), 'mark them as a delivery driver'),
      ),
    );
    expect(refresh).not.toHaveBeenCalled();
  });

  it('the Charters and Warehouse access dialogs say so and keep their Save', async () => {
    vi.mocked(setMemberChartersAction).mockRejectedValueOnce(offline());
    vi.mocked(setMemberWarehouseAccessAction).mockRejectedValueOnce(offline());
    renderTeam();
    let user = await openMenu();
    await user.click(screen.getByRole('menuitem', { name: 'Charters…' }));
    let dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestFailedMessage(offline(), 'save the charter access'),
      ),
    );
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeEnabled();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    user = await openMenu();
    await user.click(screen.getByRole('menuitem', { name: 'Warehouse access…' }));
    dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestFailedMessage(offline(), 'save the warehouse access'),
      ),
    );
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('Transfer ownership says it did not happen and can be pressed again', async () => {
    vi.mocked(transferOwnershipAction).mockRejectedValueOnce(offline());
    renderTeam('owner');
    const user = await openMenu();
    await user.click(screen.getByRole('menuitem', { name: 'Transfer ownership…' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Confirm your password'), 'typed-value');
    await user.click(
      within(dialog).getByRole('checkbox', { name: /I understand I will be demoted/ }),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Transfer ownership' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestFailedMessage(offline(), 'transfer ownership'),
      ),
    );
    expect(within(dialog).getByRole('button', { name: 'Transfer ownership' })).toBeEnabled();
  });

  // Sent again after it went through, an invite is refused ("An active
  // invite already exists for that email.", server/services/team.ts), so the
  // failed sentence is safe.
  it('Send invite keeps what was typed and says the invite was not sent', async () => {
    vi.mocked(inviteMemberAction).mockRejectedValueOnce(offline());
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderTeam('owner');
    await user.click(screen.getByRole('button', { name: /Invite member/ }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Email'), 'new.hire@example.com');
    await user.click(within(dialog).getByRole('combobox', { name: /Warehouse/ }));
    await user.click(await screen.findByRole('option', { name: 'Main' }));
    await user.click(within(dialog).getByRole('button', { name: 'Send invite' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(requestFailedMessage(offline(), 'send the invite')),
    );
    expect(within(dialog).getByLabelText('Email')).toHaveValue('new.hire@example.com');
    expect(within(dialog).getByRole('button', { name: 'Send invite' })).toBeEnabled();
  });

  it('says nothing on the way to sign-in', async () => {
    vi.mocked(removeMemberAction).mockRejectedValueOnce(signInRedirect());
    renderTeam();
    const user = await openMenu();
    await user.click(screen.getByRole('menuitem', { name: /Remove/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(removeMemberAction).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(escaped, 'the redirect is handled, never left to escape').toEqual([]);
    expect(within(dialog).queryByRole('alert')).toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
  });
});
