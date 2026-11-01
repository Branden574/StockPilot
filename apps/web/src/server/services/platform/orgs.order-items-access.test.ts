import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The console Users tab's Order items column (orders:manage_catalog_visibility,
 * migration 0413): ONE batched read for the page's members, turned into each
 * member's access preview by the same core function the dialog uses, so the
 * column and the dialog cannot disagree.
 *
 * Pinned: the read is batched (one call, only real members with a known
 * role), every preview input comes from that read (exception, the Orders
 * module, orders:request rows) or from the member row (role, disabled), a
 * failed read costs the column and nothing else (null, reported, never a
 * throw: this tab is the only place that can disable an account), and a page
 * of the tab never asks for more members than the read accepts.
 */

const h = vi.hoisted(() => ({
  listForMembers: vi.fn(),
  reportError: vi.fn(async () => undefined),
}));

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: h.reportError }));
vi.mock('@/server/services/platform/permission-exceptions', () => ({
  PERMISSION_EXCEPTIONS_MAX_MEMBERS: 50,
  PermissionExceptionsService: { listForMembers: h.listForMembers },
}));

import { getOrgMembersOrderItemsAccess, MEMBERS_PAGE_SIZE, type PlatformOrgMember } from './orgs';

const ORG = '0413b000-0000-4000-8000-000000000001';

function member(userId: string | null, role: string, over: Partial<PlatformOrgMember> = {}) {
  return {
    userId,
    email: userId ? `${userId}@example.test` : null,
    fullName: userId,
    role,
    joinedAt: '2026-01-01T00:00:00Z',
    disabledAt: null,
    lastSignInAt: null,
    lastSessionAt: null,
    lastActionAt: null,
    lastSeenAt: null,
    ...over,
  } satisfies PlatformOrgMember;
}

function read(
  over: Partial<{
    ordersModuleEnabled: boolean;
    ordersRequestRoleOverrides: Record<string, boolean>;
    members: Record<
      string,
      { exception: 'default' | 'allow' | 'deny'; ordersRequestOverride: boolean | null }
    >;
  }> = {},
) {
  return {
    permission: 'orders:manage_catalog_visibility',
    ordersModuleEnabled: over.ordersModuleEnabled ?? true,
    ordersRequestRoleOverrides: over.ordersRequestRoleOverrides ?? {},
    members: over.members ?? {},
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getOrgMembersOrderItemsAccess', () => {
  it('reads once for the page, only for members with an id and a known role', async () => {
    h.listForMembers.mockResolvedValue(
      read({
        members: {
          'u-manager': { exception: 'default', ordersRequestOverride: null },
          'u-staff': { exception: 'default', ordersRequestOverride: null },
        },
      }),
    );
    const out = await getOrgMembersOrderItemsAccess(ORG, [
      member('u-manager', 'manager'),
      member('u-staff', 'staff'),
      member(null, 'staff'),
      member('u-odd', 'customer'),
    ]);

    expect(h.listForMembers).toHaveBeenCalledTimes(1);
    expect(h.listForMembers).toHaveBeenCalledWith(ORG, ['u-manager', 'u-staff']);
    expect(out).not.toBeNull();
    expect([...out!.keys()]).toEqual(['u-manager', 'u-staff']);
  });

  it('gives each member the preview of their role and exception', async () => {
    h.listForMembers.mockResolvedValue(
      read({
        members: {
          'u-manager': { exception: 'default', ordersRequestOverride: null },
          'u-manager-denied': { exception: 'deny', ordersRequestOverride: null },
          'u-owner-denied': { exception: 'deny', ordersRequestOverride: null },
          'u-staff': { exception: 'default', ordersRequestOverride: null },
          'u-staff-allowed': { exception: 'allow', ordersRequestOverride: null },
          'u-viewer': { exception: 'default', ordersRequestOverride: null },
        },
      }),
    );
    const out = (await getOrgMembersOrderItemsAccess(ORG, [
      member('u-manager', 'manager'),
      member('u-manager-denied', 'manager'),
      member('u-owner-denied', 'owner'),
      member('u-staff', 'staff'),
      member('u-staff-allowed', 'staff'),
      member('u-viewer', 'viewer'),
    ]))!;

    const summary = Object.fromEntries(
      [...out.entries()].map(([id, a]) => [
        id,
        [a.role, a.exception, a.preview.roleDefault, a.preview.effective, a.preview.source],
      ]),
    );
    expect(summary).toEqual({
      'u-manager': ['manager', 'default', true, true, 'role_default'],
      'u-manager-denied': ['manager', 'deny', true, false, 'denied_by_stockpilot'],
      'u-owner-denied': ['owner', 'deny', true, false, 'denied_by_stockpilot'],
      'u-staff': ['staff', 'default', false, false, 'role_default'],
      'u-staff-allowed': ['staff', 'allow', false, true, 'allowed_by_stockpilot'],
      'u-viewer': ['viewer', 'default', false, false, 'role_default'],
    });
  });

  it('a disabled account and an Orders module that is off are blockers, never grants', async () => {
    h.listForMembers.mockResolvedValue(
      read({
        ordersModuleEnabled: false,
        members: {
          'u-manager': { exception: 'default', ordersRequestOverride: null },
          'u-admin-disabled': { exception: 'default', ordersRequestOverride: null },
        },
      }),
    );
    const out = (await getOrgMembersOrderItemsAccess(ORG, [
      member('u-manager', 'manager'),
      member('u-admin-disabled', 'admin', { disabledAt: '2026-10-01T00:00:00Z' }),
    ]))!;

    const manager = out.get('u-manager')!;
    expect(manager.ordersModuleEnabled).toBe(false);
    expect(manager.preview.capability).toBe(true);
    expect(manager.preview.effective).toBe(false);
    expect(manager.preview.blockers).toEqual(['orders_module_off']);

    const admin = out.get('u-admin-disabled')!;
    expect(admin.disabled).toBe(true);
    expect(admin.preview.effective).toBe(false);
    expect(admin.preview.blockers).toEqual(['account_disabled', 'orders_module_off']);
  });

  it('takes orders:request from the role row, then the member row, for the phone-entry note', async () => {
    h.listForMembers.mockResolvedValue(
      read({
        ordersRequestRoleOverrides: { staff: false },
        members: {
          'u-staff-allowed': { exception: 'allow', ordersRequestOverride: null },
          'u-staff-allowed-requests': { exception: 'allow', ordersRequestOverride: true },
        },
      }),
    );
    const out = (await getOrgMembersOrderItemsAccess(ORG, [
      member('u-staff-allowed', 'staff'),
      member('u-staff-allowed-requests', 'staff'),
    ]))!;

    expect(out.get('u-staff-allowed')!.canRequestOrders).toBe(false);
    expect(out.get('u-staff-allowed')!.preview.phoneEntryFromOrdersListOnly).toBe(true);
    expect(out.get('u-staff-allowed-requests')!.canRequestOrders).toBe(true);
    expect(out.get('u-staff-allowed-requests')!.preview.phoneEntryFromOrdersListOnly).toBe(false);
  });

  it('a failed read costs the column only: null, reported, never thrown', async () => {
    h.listForMembers.mockRejectedValue(new Error('listForMembers: boom'));
    await expect(
      getOrgMembersOrderItemsAccess(ORG, [member('u-manager', 'manager')]),
    ).resolves.toBeNull();
    expect(h.reportError).toHaveBeenCalledTimes(1);
    expect(h.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'listForMembers: boom' }),
      expect.objectContaining({ tag: 'platform.member-order-items-access' }),
    );
  });

  it('a page with nobody to look up reads nothing', async () => {
    const out = await getOrgMembersOrderItemsAccess(ORG, [member(null, 'staff')]);
    expect(out).toEqual(new Map());
    expect(h.listForMembers).not.toHaveBeenCalled();
  });

  it('one page of the Users tab never asks for more members than the read accepts', async () => {
    const real = await vi.importActual<
      typeof import('@/server/services/platform/permission-exceptions')
    >('@/server/services/platform/permission-exceptions');
    expect(MEMBERS_PAGE_SIZE).toBeLessThanOrEqual(real.PERMISSION_EXCEPTIONS_MAX_MEMBERS);
  });
});
