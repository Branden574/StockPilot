// apps/web/src/components/team/team-manager.redesign.test.tsx
//
// The Team page in the redesign (P4.F2, rows W-WS-09 and 09a-09c): the page
// header with its one accent action, the Members and Pending invites cards,
// the row menu and its dialogs. Every gate stays where it was (buttons by the
// viewer's ROLE, the page by members:invite), every word stays, and the
// hand-built checkboxes and radios keep what a click toggles: the charter
// checklist (empty = every charter the warehouse services), the transfer
// acknowledgement and the All / One warehouse choice.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  setCharters: vi.fn(),
  setWarehouseAccess: vi.fn(),
  transfer: vi.fn(),
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
  setMemberWarehouseAccessAction: h.setWarehouseAccess,
  transferOwnershipAction: h.transfer,
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

beforeEach(() => {
  vi.clearAllMocks();
  h.setCharters.mockResolvedValue({ ok: true, data: null });
  h.setWarehouseAccess.mockResolvedValue({ ok: true, data: null });
  h.transfer.mockResolvedValue({ ok: true, data: null });
});

type MemberProps = Parameters<typeof TeamManager>[0]['members'][number];

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

function renderTeam(currentUserRole: Role, opts: Partial<Parameters<typeof TeamManager>[0]> = {}) {
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
        member({}),
      ]}
      pendingInvites={[
        {
          id: 'inv-1',
          email: 'new@example.com',
          role: 'viewer',
          expiresAt: '2099-01-01T00:00:00.000Z',
          acceptUrl: 'https://app.test/i/tok-1',
        },
      ]}
      charters={[
        { id: 'ch-1', name: 'North Charter' },
        { id: 'ch-2', name: 'South Charter' },
        { id: 'ch-3', name: 'Elsewhere Charter' },
      ]}
      warehouses={[
        { id: 'wh-1', name: 'Main' },
        { id: 'wh-2', name: 'Annex' },
      ]}
      warehouseCharters={[
        { warehouse_id: 'wh-1', charter_id: 'ch-1' },
        { warehouse_id: 'wh-1', charter_id: 'ch-2' },
        { warehouse_id: 'wh-2', charter_id: 'ch-3' },
      ]}
      allCategories={[]}
      grantsByUser={{}}
      charterSingular="Charter"
      warehouseSingular="Warehouse"
      {...opts}
    />,
  );
}

async function openMenuFor(name: string) {
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  await user.click(screen.getByRole('button', { name: `Actions for ${name}` }));
  await screen.findByRole('menu');
  return user;
}

describe('Team page header and cards', () => {
  it('renders one h1, "Team" by default, with the subline the page passes', () => {
    renderTeam('admin', { subline: 'Invite, assign roles, and manage workspace access.' });
    const h1s = screen.getAllByRole('heading', { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent('Team');
    expect(
      screen.getByText('Invite, assign roles, and manage workspace access.'),
    ).toBeInTheDocument();
  });

  it('prints the renamed heading the page resolved (Settings > Navigation)', () => {
    renderTeam('admin', { title: 'Crew' });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Crew');
  });

  it('keeps Invite member for owners and admins only (a role gate, not a permission gate)', () => {
    const { unmount } = renderTeam('owner');
    expect(screen.getByRole('button', { name: /Invite member/ })).toBeInTheDocument();
    unmount();
    renderTeam('manager');
    expect(screen.queryByRole('button', { name: /Invite member/ })).not.toBeInTheDocument();
  });

  it('titles the two cards with their counts as headings', () => {
    renderTeam('admin');
    expect(screen.getByRole('heading', { level: 2, name: 'Members (2)' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Pending invites (1)' }),
    ).toBeInTheDocument();
    // Each card title names its table's scroll region.
    const [members, invites] = screen.getAllByRole('table');
    expect(screen.getByRole('region', { name: 'Members (2)' })).toContainElement(members!);
    expect(screen.getByRole('region', { name: 'Pending invites (1)' })).toContainElement(invites!);
  });

  it('names the icon-only row menu and the revoke button, and never shows a menu on the owner row', () => {
    renderTeam('admin');
    expect(screen.getByRole('button', { name: 'Actions for Sam Staff' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Actions for Olive Owner' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Revoke invite for new@example.com' }),
    ).toBeInTheDocument();
    // The invite row keeps Resend and Copy link.
    const invites = screen
      .getByRole('heading', { name: 'Pending invites (1)' })
      .closest('section')!;
    expect(within(invites).getByRole('button', { name: /Resend/ })).toBeInTheDocument();
    expect(within(invites).getByRole('button', { name: /Copy link/ })).toBeInTheDocument();
  });

  it('marks a delivery driver with the Driver pill and its explanation', () => {
    renderTeam('admin', {
      members: [member({ isDriver: true })],
    });
    const pill = screen.getByText('Driver');
    expect(pill).toHaveAttribute(
      'title',
      'Delivery driver — appears in the Assign-delivery picker',
    );
  });
});

describe('Charters checklist (shared box, same toggles)', () => {
  it('lists only the charters the member’s warehouse services, as checkboxes, and saves the picks', async () => {
    renderTeam('admin');
    const user = await openMenuFor('Sam Staff');
    await user.click(screen.getByRole('menuitem', { name: 'Charters…' }));
    const dialog = await screen.findByRole('dialog');

    const boxes = within(dialog).getAllByRole('checkbox');
    expect(boxes.map((b) => b.textContent)).toEqual(['North Charter', 'South Charter']);
    expect(boxes.every((b) => b.getAttribute('aria-checked') === 'false')).toBe(true);
    // Empty means every charter this warehouse services.
    expect(dialog).toHaveTextContent(
      "No charter picked — they'll see every charter this warehouse services.",
    );

    await user.click(within(dialog).getByRole('checkbox', { name: 'South Charter' }));
    expect(within(dialog).getByRole('checkbox', { name: 'South Charter' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(dialog).toHaveTextContent('Scoped to the selected charter at this warehouse.');

    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(h.setCharters).toHaveBeenCalledWith({
        userId: 'u-1',
        warehouseId: 'wh-1',
        charterIds: ['ch-2'],
      }),
    );
  });
});

describe('Warehouse access (shared radios)', () => {
  it('offers All and One as radios and saves All with no warehouse', async () => {
    renderTeam('admin');
    const user = await openMenuFor('Sam Staff');
    await user.click(screen.getByRole('menuitem', { name: 'Warehouse access…' }));
    const dialog = await screen.findByRole('dialog');
    const group = within(dialog).getByRole('radiogroup', { name: 'Warehouse access' });
    const one = within(group).getByRole('radio', { name: 'One warehouse' });
    const all = within(group).getByRole('radio', { name: 'All warehouses' });
    expect(one).toBeChecked();
    expect(all).not.toBeChecked();

    await user.click(all);
    expect(all).toBeChecked();
    expect(dialog).toHaveTextContent('Charter scoping does not apply with all-warehouse access.');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(h.setWarehouseAccess).toHaveBeenCalledWith({
        userId: 'u-1',
        allWarehouses: true,
        warehouseId: null,
      }),
    );
  });
});

describe('Transfer ownership (password plus the acknowledgement box)', () => {
  it('keeps the destructive button disabled until the password is typed and the box is ticked', async () => {
    renderTeam('owner');
    const user = await openMenuFor('Sam Staff');
    await user.click(screen.getByRole('menuitem', { name: 'Transfer ownership…' }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Transfer ownership' });
    expect(confirm).toBeDisabled();

    await user.type(within(dialog).getByLabelText('Confirm your password'), 'secret-pass');
    expect(confirm).toBeDisabled();

    const ack = within(dialog).getByRole('checkbox', { name: /I understand I will be demoted/ });
    expect(ack).toHaveAttribute('aria-checked', 'false');
    await user.click(ack);
    expect(ack).toHaveAttribute('aria-checked', 'true');
    expect(confirm).toBeEnabled();

    await user.click(confirm);
    await waitFor(() =>
      expect(h.transfer).toHaveBeenCalledWith({ targetMemberId: 'm-1', password: 'secret-pass' }),
    );
  });

  it('is not offered to an admin', async () => {
    renderTeam('admin');
    await openMenuFor('Sam Staff');
    expect(screen.queryByRole('menuitem', { name: 'Transfer ownership…' })).not.toBeInTheDocument();
  });
});
