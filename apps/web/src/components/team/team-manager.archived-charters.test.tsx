// apps/web/src/components/team/team-manager.archived-charters.test.tsx
//
// Team > a member > Charters... when a charter the member holds has been
// archived (or set inactive) (S44). Archiving keeps the charter's warehouse
// links and the members' assignments, while the dialog's checklist lists the
// active charters. The dialog now also lists every charter the member holds
// that the active list lacks, ticked and named '(archived)' or '(inactive)',
// and a Save sends what is ticked: it keeps such a charter unless it is
// unticked.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  setCharters: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));
vi.mock('@/server/actions/team', () => ({
  inviteMemberAction: vi.fn(),
  removeMemberAction: vi.fn(),
  resendInviteAction: vi.fn(),
  revokeInviteAction: vi.fn(),
  sendMemberPasswordResetAction: vi.fn(),
  setMemberChartersAction: h.setCharters,
  setMemberDriverAction: vi.fn(),
  setMemberWarehouseAccessAction: vi.fn(),
  transferOwnershipAction: vi.fn(),
  updateMemberRoleAction: vi.fn(),
}));
vi.mock('@/server/actions/user-categories', () => ({ setUserCategoryAccessAction: vi.fn() }));

import { TeamManager } from './team-manager';

import type { Role } from '@stockpilot/core';

// Radix DropdownMenu and Select lean on Pointer Capture, absent in the test DOM.
beforeAll(() => {
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = () => {};
  if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => {};
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

beforeEach(() => {
  vi.clearAllMocks();
  h.setCharters.mockResolvedValue({ ok: true, data: null });
});

type ManagerProps = Parameters<typeof TeamManager>[0];
type MemberProps = ManagerProps['members'][number];

const OLD_CAMPUS = { id: 'ch-x', name: 'Old Campus', status: 'archived' as const };
const CLOSED_CAMPUS = { id: 'ch-y', name: 'Closed Campus', status: 'inactive' as const };

function member(overrides: Partial<MemberProps>): MemberProps {
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

function renderTeam(memberOverrides: Partial<MemberProps>, opts: Partial<ManagerProps> = {}) {
  return render(
    <TeamManager
      currentUserRole="admin"
      members={[member(memberOverrides)]}
      pendingInvites={[]}
      charters={[
        { id: 'ch-1', name: 'North' },
        { id: 'ch-2', name: 'South' },
      ]}
      warehouses={[
        { id: 'wh-1', name: 'Main' },
        { id: 'wh-2', name: 'Annex' },
      ]}
      warehouseCharters={[
        { warehouse_id: 'wh-1', charter_id: 'ch-1' },
        { warehouse_id: 'wh-1', charter_id: 'ch-2' },
        { warehouse_id: 'wh-1', charter_id: 'ch-x' },
        { warehouse_id: 'wh-1', charter_id: 'ch-y' },
        { warehouse_id: 'wh-2', charter_id: 'ch-x' },
      ]}
      unlistedCharters={[OLD_CAMPUS, CLOSED_CAMPUS]}
      allCategories={[]}
      grantsByUser={{}}
      charterSingular="Charter"
      warehouseSingular="Warehouse"
      timeZone="America/Los_Angeles"
      {...opts}
    />,
  );
}

async function openCharters() {
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  await user.click(screen.getByRole('button', { name: 'Actions for Sam Staff' }));
  await screen.findByRole('menu');
  await user.click(screen.getByRole('menuitem', { name: 'Charters…' }));
  const dialog = await screen.findByRole('dialog');
  return { user, dialog };
}

async function saveAndGetIds(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement) {
  await user.click(within(dialog).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(h.setCharters).toHaveBeenCalledTimes(1));
  const arg = h.setCharters.mock.calls[0]![0] as {
    userId: string;
    warehouseId: string;
    charterIds: string[];
  };
  return { ...arg, charterIds: [...arg.charterIds].sort() };
}

describe("Team > Charters: a member's archived or inactive charter", () => {
  it('lists it ticked and named (archived), and a Save keeps it', async () => {
    renderTeam({ charterIds: ['ch-x'] });
    const { user, dialog } = await openCharters();

    const boxes = within(dialog).getAllByRole('checkbox');
    expect(boxes.map((b) => b.textContent)).toEqual(['North', 'South', 'Old Campus (archived)']);
    expect(within(dialog).getByRole('checkbox', { name: 'Old Campus (archived)' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(dialog).toHaveTextContent('Scoped to the selected charter at this warehouse.');
    expect(dialog).not.toHaveTextContent('No charter picked');

    expect(await saveAndGetIds(user, dialog)).toEqual({
      userId: 'u-1',
      warehouseId: 'wh-1',
      charterIds: ['ch-x'],
    });
  });

  it('a Save with no change sends every charter the member holds', async () => {
    renderTeam({ charterIds: ['ch-1', 'ch-x'] });
    const { user, dialog } = await openCharters();

    expect(within(dialog).getByRole('checkbox', { name: 'North' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect((await saveAndGetIds(user, dialog)).charterIds).toEqual(['ch-1', 'ch-x']);
  });

  it('unticking it removes it, and the dialog says what an empty choice means before Save', async () => {
    renderTeam({ charterIds: ['ch-x'] });
    const { user, dialog } = await openCharters();

    await user.click(within(dialog).getByRole('checkbox', { name: 'Old Campus (archived)' }));
    expect(within(dialog).getByRole('checkbox', { name: 'Old Campus (archived)' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(dialog).toHaveTextContent(
      "No charter picked — they'll see every charter this warehouse services.",
    );
    expect((await saveAndGetIds(user, dialog)).charterIds).toEqual([]);
  });

  it('names an inactive charter (inactive)', async () => {
    renderTeam({ charterIds: ['ch-y'] });
    const { user, dialog } = await openCharters();

    expect(
      within(dialog).getByRole('checkbox', { name: 'Closed Campus (inactive)' }),
    ).toHaveAttribute('aria-checked', 'true');
    expect((await saveAndGetIds(user, dialog)).charterIds).toEqual(['ch-y']);
  });

  it('at a warehouse that links only archived charters, shows the held one instead of the empty hint', async () => {
    renderTeam({ warehouseId: 'wh-2', charterIds: ['ch-x'] });
    const { user, dialog } = await openCharters();

    expect(dialog).not.toHaveTextContent(/has no (active )?charters linked/);
    const boxes = within(dialog).getAllByRole('checkbox');
    expect(boxes.map((b) => b.textContent)).toEqual(['Old Campus (archived)']);
    expect(boxes[0]).toHaveAttribute('aria-checked', 'true');
    expect(await saveAndGetIds(user, dialog)).toEqual({
      userId: 'u-1',
      warehouseId: 'wh-2',
      charterIds: ['ch-x'],
    });
  });

  it('when its name could not be read, still lists it ticked with a neutral label and keeps it', async () => {
    renderTeam({ charterIds: ['ch-x'] }, { unlistedCharters: [] });
    const { user, dialog } = await openCharters();

    expect(
      within(dialog).getByRole('checkbox', { name: 'Charter (name could not be loaded)' }),
    ).toHaveAttribute('aria-checked', 'true');
    expect(dialog).not.toHaveTextContent('ch-x');
    expect((await saveAndGetIds(user, dialog)).charterIds).toEqual(['ch-x']);
  });

  it('at a warehouse that links only archived charters and a member who holds none, says no ACTIVE charter is linked', async () => {
    renderTeam({ warehouseId: 'wh-2', charterIds: [] });
    const { dialog } = await openCharters();

    expect(within(dialog).queryAllByRole('checkbox')).toHaveLength(0);
    expect(dialog).toHaveTextContent(
      'This warehouse has no active charters linked. Restore one in Admin → Charters or link one in Admin → Warehouses — this member already sees all stock at this warehouse.',
    );
  });

  it('a warehouse with no charter linked at all keeps the old hint', async () => {
    renderTeam(
      { warehouseId: 'wh-3', charterIds: [] },
      {
        warehouses: [
          { id: 'wh-1', name: 'Main' },
          { id: 'wh-3', name: 'Depot' },
        ],
      },
    );
    const { dialog } = await openCharters();

    expect(dialog).toHaveTextContent(
      'This warehouse has no charters linked yet. Link some in Admin → Warehouses — this member already sees all stock at this warehouse.',
    );
  });

  it('the invite dialog still offers the active charters only', async () => {
    renderTeam({});
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(screen.getByRole('button', { name: /Invite member/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('combobox', { name: /Warehouse/ }));
    await user.click(await screen.findByRole('option', { name: 'Main' }));

    const boxes = within(dialog).getAllByRole('checkbox');
    expect(boxes.map((b) => b.textContent)).toEqual(['North', 'South']);
  });
});
