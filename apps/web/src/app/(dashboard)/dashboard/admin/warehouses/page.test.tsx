import { render, screen } from '@testing-library/react';
import type * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { effectivePermissions, type Role } from '@stockpilot/core';

/**
 * Admin > Warehouses (B99). Only an owner's or an admin's change to a
 * warehouse is saved: every write policy on warehouses and their charter links
 * asks the admin role. A member below admin given organization:update reaches
 * this page (the Admin layout asks that permission), so the page tells the
 * manager whether to offer changes, and for anyone who cannot make them it
 * says so in the organization's own words and skips the members read, which
 * only the editor's Manager list uses.
 */

const h = vi.hoisted(() => ({
  ctx: null as unknown,
  reads: [] as string[],
  managerProps: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/lib/auth/session', () => ({ requireOrgContext: vi.fn(async () => h.ctx) }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    from(table: string) {
      h.reads.push(table);
      const result =
        table === 'organizations'
          ? {
              data: { terminology: { warehouse_singular: 'Depot', warehouse_plural: 'Depots' } },
              error: null,
            }
          : {
              data: [
                {
                  user_id: 'u-1',
                  role: 'manager',
                  user: { id: 'u-1', full_name: 'Morgan Manager', email: 'morgan@example.com' },
                },
              ],
              error: null,
            };
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'not']) chain[m] = () => chain;
      chain.maybeSingle = async () => result;
      chain.then = (resolve: (v: unknown) => unknown) => resolve(result);
      return chain;
    },
  })),
}));
vi.mock('@/server/services/warehouses', () => ({
  WarehousesService: { forCurrentUser: async () => ({ list: async () => [] }) },
}));
vi.mock('@/server/services/charters', () => ({
  ChartersService: { forCurrentUser: async () => ({ list: async () => [] }) },
}));
// The manager has its own tests; here it shows what the page hands it.
vi.mock('@/components/admin/warehouses-manager', () => ({
  WarehousesManager: (props: Record<string, unknown>) => {
    h.managerProps.push(props);
    return <div data-testid="manager">{props.subline as React.ReactNode}</div>;
  },
}));

import WarehousesAdminPage from './page';

function contextOf(role: Role, grant?: boolean) {
  return {
    organizationId: 'org-1',
    userId: 'u-me',
    role,
    permissions: effectivePermissions(
      role,
      grant === undefined ? [] : [{ permission: 'organization:update', granted: grant }],
    ),
  };
}

async function renderPage() {
  render(await WarehousesAdminPage({ searchParams: Promise.resolve({}) }));
  return h.managerProps.at(-1)!;
}

beforeEach(() => {
  h.reads.length = 0;
  h.managerProps.length = 0;
});

describe('Admin > Warehouses', () => {
  it('an admin is offered changes, with the Manager list and no note', async () => {
    h.ctx = contextOf('admin');
    const props = await renderPage();
    expect(props.canManage).toBe(true);
    expect(props.managers).toEqual([{ id: 'u-1', name: 'Morgan Manager' }]);
    expect(h.reads).toContain('organization_members');
    expect(screen.queryByText(/Only owners and admins can add or change/)).toBeNull();
  });

  // The Admin layout lets in anyone holding organization:update, so these are
  // the members below admin it lets in.
  it.each([
    ['a manager granted organization:update', contextOf('manager', true)],
    ['staff granted organization:update', contextOf('staff', true)],
    ['a viewer granted organization:update', contextOf('viewer', true)],
  ])(
    '%s gets a read-only list, the note in their own words, and no members read',
    async (_who, ctx) => {
      h.ctx = ctx;
      const props = await renderPage();
      expect(props.canManage).toBe(false);
      expect(props.managers).toEqual([]);
      expect(h.reads).not.toContain('organization_members');
      expect(
        screen.getByText('Only owners and admins can add or change depots.'),
      ).toBeInTheDocument();
    },
  );
});
