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

import { createClient } from '@/lib/supabase/server';

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

/**
 * Docket S19: the editable matrix draws every role and member from the
 * organization's override rows. When one of its three reads fails, the page
 * throws to the settings boundary ("We couldn't load this settings page" with
 * Try again). It must never draw the matrix without them: every role would sit
 * at its defaults, so a permission the organization took away would show as
 * granted. The owner reaches this page even while the reads fail.
 */
describe('Roles & permissions: a read the editable matrix needs fails', () => {
  /** Stands for the PostgREST message, which can quote request details. */
  const SECRET = 'relation secret-detail is not readable';

  const FAILED = { data: null, error: { code: '57014', message: SECRET }, status: 500 };

  function client(failing: string | null, answer: object = FAILED) {
    return {
      from: (table: string) => {
        const q: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'not']) q[m] = () => q;
        q.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve(table === failing ? answer : { data: [], error: null, status: 200 }).then(
            resolve,
            reject,
          );
        return q;
      },
    };
  }

  beforeEach(() => {
    ctxHolder.current = { role: 'admin', permissions: new Set(['members:read']) };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it.each([
    ['admin', 'role_permission_overrides'],
    ['admin', 'user_permission_overrides'],
    ['admin', 'organization_members'],
    ['owner', 'role_permission_overrides'],
  ] as const)(
    '%s: a failed %s read throws to the settings boundary instead of drawing the matrix',
    async (role, table) => {
      ctxHolder.current = { role, permissions: new Set(['members:read']) };
      vi.mocked(createClient).mockResolvedValue(client(table) as never);
      const result = await RolesPage().then(
        (page) => ({ page, error: null as unknown }),
        (error: unknown) => ({ page: null, error }),
      );
      if (result.page) render(result.page);
      expect(screen.queryByTestId('role-permission-matrix')).toBeNull();
      expect(result.error).toBeInstanceOf(Error);
      expect(String((result.error as Error).message)).not.toContain('secret-detail');
    },
  );

  // postgrest-js answers an empty body with no error and no rows (data null; a
  // 404's status rewritten to 204). That is no answer, not "no overrides": the
  // matrix would again draw every role at its defaults (docket S19 review).
  it.each(['role_permission_overrides', 'user_permission_overrides', 'organization_members'])(
    'an answer from %s that is not a list (an empty body) throws the same way',
    async (table) => {
      vi.mocked(createClient).mockResolvedValue(
        client(table, { data: null, error: null, status: 204 }) as never,
      );
      const result = await RolesPage().then(
        (page) => ({ page, error: null as unknown }),
        (error: unknown) => ({ page: null, error }),
      );
      if (result.page) render(result.page);
      expect(screen.queryByTestId('role-permission-matrix')).toBeNull();
      expect(result.error).toBeInstanceOf(Error);
      expect(vi.mocked(console.error).mock.calls.map((c) => c.map(String).join(' '))).toEqual([
        expect.stringContaining(`${table} code=unexpected status=204`),
      ]);
    },
  );

  it('with every read answered, an admin gets the editable matrix', async () => {
    vi.mocked(createClient).mockResolvedValue(client(null) as never);
    render(await RolesPage());
    expect(screen.getByTestId('role-permission-matrix')).toBeInTheDocument();
  });
});
