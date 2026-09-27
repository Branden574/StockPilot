import { cleanup, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { effectivePermissions, type Role } from '@stockpilot/core';

/**
 * The Distribute button matches the database (2026-09-27).
 *
 * Staff hold `bundles:distribute` by default, but distribute_bundle has refused
 * anyone below manager since 0101, so a staff member was shown Distribute and
 * got "Permission denied". The REAL page is rendered here with its services
 * stubbed; the button appears only for a manager or above who holds the
 * permission. The page itself still opens for staff (read-only).
 */

const ctx: { role: Role; permissions: ReadonlySet<string> } = {
  role: 'staff',
  permissions: effectivePermissions('staff'),
};

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('notFound');
  }),
  redirect: vi.fn((to: string) => {
    throw new Error(`redirect:${to}`);
  }),
}));
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
  };
});
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({ organizationId: 'org-1', userId: 'u-1', ...ctx })),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'is', 'gte', 'order', 'limit', 'not']) chain[m] = () => chain;
    chain.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
    return { from: () => chain };
  }),
}));
vi.mock('@/server/services/bundles', () => ({
  BundlesService: {
    forCurrentUser: vi.fn(async () => ({
      get: vi.fn(async () => ({
        bundle: {
          id: 'b-1',
          name: 'New Hire Bundle',
          sku: null,
          description: null,
          is_active: true,
          archived_at: null,
          preassembly_enabled: false,
          created_at: '2026-09-25T12:00:00Z',
          updated_at: '2026-09-25T12:00:00Z',
        },
        components: [],
        phantom: null,
      })),
      recentDistributions: vi.fn(async () => []),
    })),
  },
}));
vi.mock('@/server/services/warehouses', () => ({
  WarehousesService: {
    forCurrentUser: vi.fn(async () => ({ listNames: vi.fn(async () => [{ id: 'wh-1', name: 'DC4' }]) })),
  },
}));
vi.mock('@/components/bundles/distribute-bundle-modal', () => ({
  DistributeBundleModal: () => <button type="button">Distribute</button>,
}));
vi.mock('@/components/bundles/assemble-bundle-modal', () => ({ AssembleBundleModal: () => null }));
vi.mock('@/components/bundles/archive-bundle-button', () => ({ ArchiveBundleButton: () => null }));

import BundleDetailPage from './page';

async function renderAs(role: Role, permissions: ReadonlySet<string> = effectivePermissions(role)) {
  ctx.role = role;
  ctx.permissions = permissions;
  return render(await BundleDetailPage({ params: Promise.resolve({ id: 'b-1' }) }));
}

beforeEach(() => {
  cleanup();
});

describe('bundle page: Distribute is offered only where the database accepts it', () => {
  it('staff open the bundle but are not offered Distribute, although they hold bundles:distribute', async () => {
    expect(effectivePermissions('staff').has('bundles:distribute')).toBe(true);
    await renderAs('staff');
    expect(screen.getByRole('heading', { name: 'New Hire Bundle' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Distribute' })).toBeNull();
  });

  it.each(['manager', 'admin', 'owner'] as const)('%s is offered Distribute', async (role) => {
    await renderAs(role);
    expect(screen.getByRole('button', { name: 'Distribute' })).toBeTruthy();
  });

  it('a manager whose bundles:distribute was revoked is not offered it', async () => {
    await renderAs(
      'manager',
      effectivePermissions('manager', [{ permission: 'bundles:distribute', granted: false }]),
    );
    expect(screen.queryByRole('button', { name: 'Distribute' })).toBeNull();
  });
});
