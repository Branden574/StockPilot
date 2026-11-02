// apps/web/src/components/team/team-manager.remove-dialog.test.tsx
//
// B94: Remove releases the person's open work in this workspace (migration
// 0429), so the dialog says how much before the press: it asks when it opens
// ("Checking their open work..."), then names the cycle counts in progress,
// orders being picked and open deliveries (and maintenance requests and
// warehouses when there are any). A read that fails says so and that removing
// still releases the work; a refusal says who may remove. A removal the server
// refuses is said INSIDE the dialog (recurring pattern #20: a toast alone sits
// behind it), and cleared when the dialog opens again and on each try. The
// words no longer promise that a re-invite gives the work back.
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  remove: vi.fn(),
  openWork: vi.fn(),
  toastError: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: h.refresh, back: vi.fn() }),
}));
vi.mock('sonner', () => ({
  toast: { error: h.toastError, success: vi.fn(), warning: vi.fn() },
}));
vi.mock('@/server/actions/team', () => ({
  getMemberOpenWorkAction: h.openWork,
  inviteMemberAction: vi.fn(),
  removeMemberAction: h.remove,
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

import { TeamManager } from './team-manager';

import type { Role } from '@stockpilot/core';

// Radix DropdownMenu leans on Pointer Capture, absent in the test DOM.
beforeAll(() => {
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = () => {};
  if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => {};
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

const COUNTS = {
  cycleCounts: 1,
  picks: 2,
  deliveries: 1,
  scheduleEvents: 1,
  maintenanceRequests: 0,
  escalationClaims: 1,
  warehouses: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.openWork.mockResolvedValue({ ok: true, data: { kind: 'ok', counts: COUNTS } });
  h.remove.mockResolvedValue({ ok: true, data: undefined });
});

function renderTeam(currentUserRole: Role = 'admin') {
  return render(
    <TeamManager
      currentUserRole={currentUserRole}
      members={[
        {
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
        },
      ]}
      pendingInvites={[]}
      charters={[]}
      warehouses={[{ id: 'wh-1', name: 'Main' }]}
      warehouseCharters={[]}
      allCategories={[]}
      grantsByUser={{}}
      charterSingular="Charter"
      warehouseSingular="Site"
      timeZone="America/Los_Angeles"
    />,
  );
}

async function openRemove() {
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  await user.click(screen.getByRole('button', { name: 'Actions for Sam Staff' }));
  await screen.findByRole('menu');
  await user.click(screen.getByRole('menuitem', { name: /Remove/ }));
  const dialog = await screen.findByRole('dialog');
  return { user, dialog };
}

describe('Team — Remove says what it releases', () => {
  it("asks for the member's open work when it opens, and says it is checking until the answer comes", async () => {
    let answer: (v: unknown) => void = () => {};
    h.openWork.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    renderTeam();

    const { dialog } = await openRemove();

    expect(h.openWork).toHaveBeenCalledWith('m-1');
    expect(within(dialog).getByText('Checking their open work...')).toBeInTheDocument();
    answer({ ok: true, data: { kind: 'ok', counts: COUNTS } });
    expect(
      await within(dialog).findByText(
        'Removing them releases 1 cycle count in progress, 2 orders being picked and 1 open delivery, so others can take them over.',
      ),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText('Checking their open work...')).toBeNull();
  });

  it("adds the maintenance and warehouse line only when there are any, in the workspace's word", async () => {
    h.openWork.mockResolvedValue({
      ok: true,
      data: { kind: 'ok', counts: { ...COUNTS, maintenanceRequests: 1, warehouses: 2 } },
    });
    renderTeam();

    const { dialog } = await openRemove();

    expect(
      await within(dialog).findByText(
        'It also clears them as the local owner of 1 maintenance request and as the manager of 2 sites.',
      ),
    ).toBeInTheDocument();
  });

  it('says nothing is open when they hold no count, pick or delivery', async () => {
    h.openWork.mockResolvedValue({
      ok: true,
      data: {
        kind: 'ok',
        counts: { ...COUNTS, cycleCounts: 0, picks: 0, deliveries: 0 },
      },
    });
    renderTeam();

    const { dialog } = await openRemove();

    expect(
      await within(dialog).findByText(
        'They have no cycle counts in progress, orders being picked or open deliveries to release.',
      ),
    ).toBeInTheDocument();
  });

  it('says it could not check when the read fails, and that removing still releases the work', async () => {
    h.openWork.mockResolvedValue({ ok: true, data: { kind: 'failed' } });
    renderTeam();

    const { dialog } = await openRemove();

    expect(
      await within(dialog).findByText(
        'Could not check their open work. Removing them still releases it.',
      ),
    ).toBeInTheDocument();
  });

  it('says the same when the action answers an error', async () => {
    h.openWork.mockResolvedValueOnce({
      ok: false,
      error: { code: 'internal_error', message: 'x' },
    });
    renderTeam();
    const { dialog } = await openRemove();
    expect(
      await within(dialog).findByText(
        'Could not check their open work. Removing them still releases it.',
      ),
    ).toBeInTheDocument();
  });

  it('says the same when the action throws (a network failure)', async () => {
    h.openWork.mockRejectedValueOnce(new Error('Failed to fetch'));
    renderTeam();
    const { dialog } = await openRemove();
    expect(
      await within(dialog).findByText(
        'Could not check their open work. Removing them still releases it.',
      ),
    ).toBeInTheDocument();
  });

  it('says who may remove when the read is refused', async () => {
    h.openWork.mockResolvedValue({ ok: true, data: { kind: 'forbidden' } });
    renderTeam();

    const { dialog } = await openRemove();

    expect(
      await within(dialog).findByText('Only an owner or admin can remove a member.'),
    ).toBeInTheDocument();
  });

  it('no longer says they can be re-invited anytime: released work stays released', async () => {
    renderTeam();

    const { dialog } = await openRemove();
    await within(dialog).findByText(/Removing them releases/);

    expect(dialog).toHaveTextContent(
      'Sam Staff will lose access to this workspace immediately. Their activity history stays on the record. You can re-invite them later. Work released now stays released.',
    );
    expect(dialog.textContent).not.toMatch(/anytime/);
  });
});

describe('Team — no claim about releasing until the read shows the release exists', () => {
  it('does not say released work stays released while it checks', async () => {
    h.openWork.mockReturnValue(new Promise(() => {}));
    renderTeam();

    const { dialog } = await openRemove();

    expect(within(dialog).getByText('Checking their open work...')).toBeInTheDocument();
    expect(dialog.textContent).not.toMatch(/stays released/);
  });

  it('says only that they lose access when the read function is missing (before the migration, or after a rollback)', async () => {
    h.openWork.mockResolvedValue({ ok: true, data: { kind: 'unavailable' } });
    renderTeam();

    const { dialog } = await openRemove();

    await waitFor(() =>
      expect(within(dialog).queryByText('Checking their open work...')).toBeNull(),
    );
    expect(
      within(dialog).getByText(
        'Sam Staff will lose access to this workspace immediately. Their activity history stays on the record. You can re-invite them later.',
      ),
    ).toBeInTheDocument();
    expect(dialog.textContent).not.toMatch(/releas/i);
  });
});

describe('Team — each opening shows its own answer', () => {
  const FIRST =
    'Removing them releases 1 cycle count in progress, 2 orders being picked and 1 open delivery, so others can take them over.';
  const SECOND =
    'Removing them releases 0 cycle counts in progress, 0 orders being picked and 3 open deliveries, so others can take them over.';
  const SECOND_COUNTS = { ...COUNTS, cycleCounts: 0, picks: 0, deliveries: 3 };

  async function closeDialog(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement) {
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  }

  it("says it is checking again when reopened, never the last opening's numbers while it waits", async () => {
    renderTeam();
    const first = await openRemove();
    expect(await within(first.dialog).findByText(FIRST)).toBeInTheDocument();
    await closeDialog(first.user, first.dialog);

    let answer: (v: unknown) => void = () => {};
    h.openWork.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const second = await openRemove();

    expect(within(second.dialog).getByText('Checking their open work...')).toBeInTheDocument();
    expect(within(second.dialog).queryByText(FIRST)).toBeNull();
    answer({ ok: true, data: { kind: 'ok', counts: SECOND_COUNTS } });
    expect(await within(second.dialog).findByText(SECOND)).toBeInTheDocument();
  });

  it('keeps the newer answer when an earlier opening answers last', async () => {
    let answerFirst: (v: unknown) => void = () => {};
    let answerSecond: (v: unknown) => void = () => {};
    h.openWork
      .mockReturnValueOnce(new Promise((resolve) => (answerFirst = resolve)))
      .mockReturnValueOnce(new Promise((resolve) => (answerSecond = resolve)));
    renderTeam();
    const first = await openRemove();
    await closeDialog(first.user, first.dialog);
    const second = await openRemove();
    expect(h.openWork).toHaveBeenCalledTimes(2);

    answerSecond({ ok: true, data: { kind: 'ok', counts: SECOND_COUNTS } });
    expect(await within(second.dialog).findByText(SECOND)).toBeInTheDocument();
    await act(async () => {
      answerFirst({ ok: true, data: { kind: 'ok', counts: COUNTS } });
    });

    expect(within(second.dialog).getByText(SECOND)).toBeInTheDocument();
    expect(within(second.dialog).queryByText(FIRST)).toBeNull();
  });
});

describe('Team — a refused removal is said inside the dialog', () => {
  it('shows the refusal as an alert in the dialog, keeps it open, and clears it on the next try and on reopening', async () => {
    h.remove.mockResolvedValueOnce({
      ok: false,
      error: { code: 'conflict', message: 'Busy. Try again.' },
    });
    renderTeam();
    const { user, dialog } = await openRemove();
    await within(dialog).findByText(/Removing them releases/);

    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Busy. Try again.');
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    // The next try clears it while it runs (and it succeeds this time).
    let finish: (v: unknown) => void = () => {};
    h.remove.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(within(dialog).queryByRole('alert')).toBeNull());
    finish({ ok: true, data: undefined });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(h.refresh).toHaveBeenCalled();
  });

  it('clears an old refusal when the dialog is opened again', async () => {
    h.remove.mockResolvedValueOnce({
      ok: false,
      error: { code: 'forbidden', message: 'Only an owner or admin can remove a member.' },
    });
    renderTeam();
    const first = await openRemove();
    await within(first.dialog).findByText(/Removing them releases/);
    await first.user.click(within(first.dialog).getByRole('button', { name: 'Remove' }));
    expect(await within(first.dialog).findByRole('alert')).toBeInTheDocument();

    await first.user.click(within(first.dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    const second = await openRemove();
    expect(within(second.dialog).queryByRole('alert')).toBeNull();
    expect(h.openWork).toHaveBeenCalledTimes(2);
  });
});
