import { render, screen } from '@testing-library/react';
import type * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { effectivePermissions, type Role } from '@stockpilot/core';

/**
 * Admin > Charters (B99). Only an owner's or an admin's change to a charter is
 * saved: charters_admin_write asks the admin role. A member below admin given
 * organization:update reaches this page (the Admin layout asks that
 * permission), so the page tells the manager whether to offer changes, and for
 * anyone who cannot make them it says so in the organization's own words.
 */

const h = vi.hoisted(() => ({
  ctx: null as unknown,
  managerProps: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/lib/auth/session', () => ({ requireOrgContext: vi.fn(async () => h.ctx) }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    from() {
      const result = {
        data: { terminology: { charter_singular: 'Region', charter_plural: 'Regions' } },
        error: null,
      };
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'eq']) chain[m] = () => chain;
      chain.maybeSingle = async () => result;
      return chain;
    },
  })),
}));
vi.mock('@/server/services/charters', () => ({
  ChartersService: { forCurrentUser: async () => ({ list: async () => [] }) },
}));
// The manager has its own tests; here it shows what the page hands it.
vi.mock('@/components/admin/charters-manager', () => ({
  ChartersManager: (props: Record<string, unknown>) => {
    h.managerProps.push(props);
    return <div data-testid="manager">{props.subline as React.ReactNode}</div>;
  },
}));

import ChartersAdminPage from './page';

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

async function renderPage(view?: string) {
  render(await ChartersAdminPage({ searchParams: Promise.resolve(view ? { view } : {}) }));
  return h.managerProps.at(-1)!;
}

beforeEach(() => {
  h.managerProps.length = 0;
});

describe('Admin > Charters', () => {
  it('the owner is offered changes, with no note', async () => {
    h.ctx = contextOf('owner');
    const props = await renderPage();
    expect(props.canManage).toBe(true);
    expect(screen.queryByText(/Only owners and admins can add or change/)).toBeNull();
  });

  // The Admin layout lets in anyone holding organization:update, so these are
  // the members below admin it lets in.
  it.each([
    ['a manager granted organization:update', contextOf('manager', true)],
    ['staff granted organization:update', contextOf('staff', true)],
  ])('%s gets a read-only list and the note in their own words', async (_who, ctx) => {
    h.ctx = ctx;
    const props = await renderPage();
    expect(props.canManage).toBe(false);
    expect(
      screen.getByText('Only owners and admins can add or change regions.'),
    ).toBeInTheDocument();
  });

  it('the archived view does not ask someone who cannot change charters to restore one', async () => {
    h.ctx = contextOf('manager', true);
    await renderPage('archived');
    expect(screen.queryByText(/Restore one/)).toBeNull();
    expect(
      screen.getByText('Only owners and admins can add or change regions.'),
    ).toBeInTheDocument();

    h.ctx = contextOf('admin');
    await renderPage('archived');
    expect(
      screen.getByText('Regions you archived. Restore one to bring it back into the active list.'),
    ).toBeInTheDocument();
  });
});
