import { cleanup, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { effectivePermissions } from '@stockpilot/core';

import { makeSupabaseStub, servedLikePostgrest } from '@/test/supabase-mock';

/**
 * B92: Distribute's event picker offers only this organization's events.
 *
 * The page read schedule_events with no organization filter, and its RLS
 * (is_org_member) lets a member of two organizations read both. So a member
 * of two was offered the other organization's events, which distribute_bundle
 * then refuses (0415). The read here answers as PostgREST would for such a
 * member: every row of both organizations, cut only by the query's own
 * filters.
 */

const ORG = 'org-own';
const OTHER_ORG = 'org-other';
const SOON = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

const EVENTS = [
  {
    id: 'ev-own',
    organization_id: ORG,
    title: 'Own event',
    starts_at: SOON(2),
    status: 'scheduled',
  },
  {
    id: 'ev-other',
    organization_id: OTHER_ORG,
    title: 'Other organization event',
    starts_at: SOON(1),
    status: 'scheduled',
  },
];

const offered = vi.fn();

vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: vi.fn(async () => ({ enabled: true, canManage: true })),
}));
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('notFound');
  }),
  redirect: vi.fn((to: string) => {
    throw new Error(`redirect:${to}`);
  }),
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: ORG,
    userId: 'u-1',
    role: 'manager',
    permissions: effectivePermissions('manager'),
  })),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(
    async () =>
      makeSupabaseStub({ 'schedule_events.select': servedLikePostgrest(() => EVENTS) }).client,
  ),
}));
vi.mock('@/server/services/bundles', () => ({
  BundlesService: {
    forCurrentUser: vi.fn(async () => ({
      get: vi.fn(async () => ({
        bundle: {
          id: '5eed0000-0000-4000-8000-0000000000b9',
          name: 'Kit',
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
    forCurrentUser: vi.fn(async () => ({ listNames: vi.fn(async () => []) })),
  },
}));
vi.mock('@/components/bundles/distribute-bundle-modal', () => ({
  DistributeBundleModal: ({ upcomingEvents }: { upcomingEvents: Array<{ id: string }> }) => {
    offered(upcomingEvents.map((e) => e.id));
    return <button type="button">Distribute</button>;
  },
}));
vi.mock('@/components/bundles/assemble-bundle-modal', () => ({ AssembleBundleModal: () => null }));
vi.mock('@/components/bundles/archive-bundle-button', () => ({ ArchiveBundleButton: () => null }));

import BundleDetailPage from './page';

beforeEach(() => {
  cleanup();
  offered.mockClear();
});

describe("Distribute's event picker (B92)", () => {
  it("offers a member of two organizations only this organization's events", async () => {
    render(
      await BundleDetailPage({
        params: Promise.resolve({ id: '5eed0000-0000-4000-8000-0000000000b9' }),
      }),
    );
    expect(screen.getByRole('button', { name: 'Distribute' })).toBeTruthy();
    expect(offered).toHaveBeenCalledWith(['ev-own']);
  });
});
