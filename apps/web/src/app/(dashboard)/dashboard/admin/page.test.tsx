import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Admin hub (W-AD-01) in the redesign: compact rows instead of big tiles,
 * with the same four destinations, the same exact head-counts and the same
 * platform-only block behind the allowlist check.
 */

const platform = vi.hoisted(() => ({ admin: false }));
vi.mock('@/lib/auth/platform-admin', () => ({
  currentUserIsPlatformAdmin: vi.fn(async () => platform.admin),
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({ organizationId: 'org-1', userId: 'u1', role: 'owner' })),
}));
const navLabel = vi.hoisted(() => ({ override: null as string | null }));
vi.mock('@/lib/nav-labels', () => ({
  effectiveNavLabel: vi.fn(
    async (_href: string, fallback: string) => navLabel.override ?? fallback,
  ),
}));

// Every count query is a head-only exact count; record each one.
const COUNTS: Record<string, number> = {
  charters: 3,
  warehouses: 2,
  organization_members: 7,
  organization_invites: 1,
  audit_logs: 4210,
};
const selects: Array<{ table: string; options: unknown }> = [];
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    from(table: string) {
      const result = { count: COUNTS[table] ?? 0, data: null, error: null };
      const chain: Record<string, unknown> = {};
      for (const m of ['eq', 'neq', 'not', 'is', 'gt']) chain[m] = () => chain;
      chain.then = (resolve: (v: unknown) => unknown) => resolve(result);
      return {
        select(_cols: string, options: unknown) {
          selects.push({ table, options });
          return chain;
        },
      };
    },
  })),
}));

import AdminOverviewPage from './page';

beforeEach(() => {
  platform.admin = false;
  navLabel.override = null;
  selects.length = 0;
});

describe('/dashboard/admin overview', () => {
  it('lists the four destinations as rows with their exact counts', async () => {
    render(await AdminOverviewPage());
    expect(screen.getByRole('heading', { level: 1, name: 'Admin overview' })).toBeInTheDocument();
    expect(screen.getByText('Admin')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Configure the company structure, manage user access, and review what changed.',
      ),
    ).toBeInTheDocument();

    const charters = screen.getByRole('link', { name: /^Charters/ });
    expect(charters).toHaveAttribute('href', '/dashboard/admin/charters');
    expect(within(charters).getByText('3')).toBeInTheDocument();

    const warehouses = screen.getByRole('link', { name: /^Warehouses/ });
    expect(warehouses).toHaveAttribute('href', '/dashboard/admin/warehouses');
    expect(within(warehouses).getByText('2')).toBeInTheDocument();

    const users = screen.getByRole('link', { name: /^Users & invites/ });
    expect(users).toHaveAttribute('href', '/dashboard/admin/users');
    expect(within(users).getByText('7 active · 1 pending invite')).toBeInTheDocument();

    const audit = screen.getByRole('link', { name: /^Audit log/ });
    expect(audit).toHaveAttribute('href', '/dashboard/audit');
    expect(within(audit).getByText('4210')).toBeInTheDocument();
  });

  it('counts with head-only exact counts, never by reading rows', async () => {
    render(await AdminOverviewPage());
    expect(selects.map((s) => s.table).sort()).toEqual(
      [
        'audit_logs',
        'charters',
        'organization_invites',
        'organization_members',
        'warehouses',
      ].sort(),
    );
    for (const s of selects) expect(s.options).toEqual({ count: 'exact', head: true });
  });

  it('hides the platform block from an org admin who is not a platform admin', async () => {
    render(await AdminOverviewPage());
    expect(screen.queryByText('Platform admin')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Open' })).toBeNull();
  });

  it('shows the platform block, labelled, to a platform admin', async () => {
    platform.admin = true;
    render(await AdminOverviewPage());
    const block = screen.getByTestId('admin-platform-block');
    expect(within(block).getByRole('heading', { name: 'Platform admin' })).toBeInTheDocument();
    expect(within(block).getByText('Provision a new organization')).toBeInTheDocument();
    expect(within(block).getByText('Support tickets')).toBeInTheDocument();
    expect(
      within(block)
        .getAllByRole('link', { name: 'Open' })
        .map((a) => a.getAttribute('href')),
    ).toEqual(['/dashboard/admin/orgs/new', '/dashboard/admin/support']);
  });

  it('a Settings > Navigation rename reaches the heading', async () => {
    navLabel.override = 'Company setup';
    render(await AdminOverviewPage());
    expect(screen.getByRole('heading', { level: 1, name: 'Company setup' })).toBeInTheDocument();
  });
});
