// apps/web/src/components/team/team-manager.disabled-badge.test.tsx
//
// Org-facing visibility for the account-disable program (migs 0308-0313):
// the Team page must show a "Disabled" status badge on disabled members'
// rows — STATUS ONLY, never disabled_reason/disabled_by (those columns
// aren't even sent to this component; see TeamService.listMembers and
// dashboard/team/page.tsx). The badge is gated by the same admin-only
// predicate that gates the row's action menu and the "Invite member"
// button (owner/admin), not by the per-row `canManage` exclusion that
// hides ACTIONS on the owner's own row — a disabled owner must still be
// visible to an admin.
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pushMock = vi.fn();
const refreshMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock, back: vi.fn() }),
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
  setMemberChartersAction: vi.fn(),
  setMemberDriverAction: vi.fn(),
  setMemberWarehouseAccessAction: vi.fn(),
  transferOwnershipAction: vi.fn(),
  updateMemberRoleAction: vi.fn(),
}));

import { TeamManager } from './team-manager';

import type { Role } from '@stockpilot/core';

function baseMember(overrides: Partial<Parameters<typeof TeamManager>[0]['members'][number]>) {
  return {
    id: 'member-1',
    userId: 'user-1',
    role: 'staff' as Role,
    invitedAt: null,
    acceptedAt: '2026-01-01T00:00:00.000Z',
    email: 'person@example.com',
    fullName: 'Person One',
    avatarUrl: null,
    warehouseId: null,
    charterIds: [],
    allWarehouses: false,
    isDriver: false,
    disabledAt: null,
    ...overrides,
  };
}

function renderTeam(
  currentUserRole: Role,
  members: Array<Partial<Parameters<typeof TeamManager>[0]['members'][number]>>,
) {
  render(
    <TeamManager
      currentUserRole={currentUserRole}
      members={members.map((m) => baseMember(m))}
      pendingInvites={[]}
      charters={[]}
      warehouses={[]}
      warehouseCharters={[]}
      allCategories={[]}
      grantsByUser={{}}
      charterSingular="Charter"
      warehouseSingular="Warehouse"
    />,
  );
}

describe('TeamManager — disabled status badge', () => {
  beforeEach(() => {
    pushMock.mockReset();
    refreshMock.mockReset();
  });

  it('shows a "Disabled" badge on a disabled member\'s row, to an admin viewer', () => {
    renderTeam('admin', [
      { id: 'm1', fullName: 'Active Person', disabledAt: null },
      { id: 'm2', fullName: 'Disabled Person', disabledAt: '2026-07-30T12:00:00.000Z' },
    ]);

    // Both members stay in the list — disable doesn't remove membership.
    expect(screen.getByText('Active Person')).toBeInTheDocument();
    expect(screen.getByText('Disabled Person')).toBeInTheDocument();

    // Exactly one "Disabled" badge — on the disabled row only.
    expect(screen.getAllByText('Disabled')).toHaveLength(1);
  });

  it('never renders the disable reason or who disabled them — status only', () => {
    renderTeam('admin', [
      { id: 'm2', fullName: 'Disabled Person', disabledAt: '2026-07-30T12:00:00.000Z' },
    ]);
    // The badge text is exactly "Disabled" — no reason, no admin identity.
    // (The component doesn't even receive those fields — this asserts the
    // rendered surface, since a leak could also come from a title/tooltip.)
    const badge = screen.getByText('Disabled');
    expect(badge.textContent).toBe('Disabled');
    expect(screen.queryByText(/reason/i)).not.toBeInTheDocument();
  });

  it('owner viewer also sees the badge (same admin-only gate as the actions)', () => {
    renderTeam('owner', [
      { id: 'm2', fullName: 'Disabled Person', disabledAt: '2026-07-30T12:00:00.000Z' },
    ]);
    expect(screen.getByText('Disabled')).toBeInTheDocument();
  });

  it('shows the badge on a disabled OWNER row too — canManage\'s owner-target exclusion must not hide status', () => {
    renderTeam('admin', [
      {
        id: 'm-owner',
        role: 'owner',
        fullName: 'The Owner',
        disabledAt: '2026-07-30T12:00:00.000Z',
      },
    ]);
    expect(screen.getByText('Disabled')).toBeInTheDocument();
  });

  it('hides the badge from a viewer without admin-controls visibility (manager)', () => {
    renderTeam('manager', [
      { id: 'm2', fullName: 'Disabled Person', disabledAt: '2026-07-30T12:00:00.000Z' },
    ]);
    // Member still listed...
    expect(screen.getByText('Disabled Person')).toBeInTheDocument();
    // ...but the status badge is gated the same as the row actions.
    expect(screen.queryByText('Disabled')).not.toBeInTheDocument();
  });
});
