import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Roles & permissions for a member who cannot configure roles: the read-only
// matrix of every role. It is wider than a phone and its rows hold no
// control, so its scroll area is a Tab stop, named by the card's title. The
// card itself carries no name, so the page lists All roles at a glance once
// (axe landmark-unique).

const ctxHolder = vi.hoisted(() => ({
  current: {
    role: 'staff' as 'owner' | 'admin' | 'manager' | 'staff' | 'viewer',
    permissions: null as Set<string> | null,
  },
}));

vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'user-1',
    role: ctxHolder.current.role,
    permissions: ctxHolder.current.permissions,
  })),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }));
vi.mock('@/components/settings/role-permission-matrix', () => ({
  RolePermissionMatrix: () => <div data-testid="role-permission-matrix" />,
}));

import { ORDER_ITEMS_ROLES_LOCK_NOTE_COPY } from '@stockpilot/core';

import RolesPage from './page';

beforeEach(() => {
  vi.clearAllMocks();
  ctxHolder.current = { role: 'staff', permissions: null };
});

describe('Roles & permissions: the read-only matrix', () => {
  it('names the matrix scroll area by the card title, and lists that name once', async () => {
    render(await RolesPage());
    expect(screen.queryByTestId('role-permission-matrix')).toBeNull();
    const regions = screen.getAllByRole('region', { name: 'All roles at a glance' });
    expect(regions).toHaveLength(1);
    expect(regions[0]!.tagName).toBe('DIV');
    expect(regions[0]).toHaveAttribute('tabindex', '0');
    expect(within(regions[0]!).getByRole('table')).toBeInTheDocument();
    // The card keeps its title as its heading, but is not a region of its own.
    expect(
      screen.getByRole('heading', { level: 2, name: 'All roles at a glance' }).closest('section'),
    ).not.toHaveAttribute('aria-labelledby');
  });
});

/**
 * Manage order items (orders:manage_catalog_visibility, migration 0413) is
 * platform-managed: a member's effective access can differ from their role's
 * default only by StockPilot's exception, so the reference says who manages
 * it, and "Your role can" never claims it from a static fallback (a denied
 * manager whose effective set is unknown must not read that they hold it).
 */
describe('Roles & permissions: the platform-managed Manage order items row', () => {
  const yourRolePanel = () =>
    screen.getByRole('heading', { level: 2, name: /You.re signed in as/ }).closest('section')!;

  it('notes in the read-only matrix that StockPilot support manages it', async () => {
    render(await RolesPage());
    const region = screen.getByRole('region', { name: 'All roles at a glance' });
    const row = within(region)
      .getByRole('rowheader', { name: /Manage order items/ })
      .closest('tr')!;
    expect(within(row).getByText(ORDER_ITEMS_ROLES_LOCK_NOTE_COPY)).toBeInTheDocument();
  });

  it('"Your role can" leaves it out when only the static role default is known', async () => {
    ctxHolder.current = { role: 'manager', permissions: null };
    render(await RolesPage());
    expect(within(yourRolePanel()).queryByText('Manage order items')).toBeNull();
    // The rest of the manager's defaults are still listed.
    expect(within(yourRolePanel()).getAllByRole('listitem').length).toBeGreaterThan(0);
  });

  it('"Your role can" lists it from the effective set, and not after a deny', async () => {
    ctxHolder.current = {
      role: 'manager',
      permissions: new Set(['orders:read', 'orders:manage_catalog_visibility']),
    };
    const { unmount } = render(await RolesPage());
    expect(within(yourRolePanel()).getByText('Manage order items')).toBeInTheDocument();
    unmount();

    ctxHolder.current = { role: 'manager', permissions: new Set(['orders:read']) };
    render(await RolesPage());
    expect(within(yourRolePanel()).queryByText('Manage order items')).toBeNull();
  });
});
