// @vitest-environment happy-dom
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Team's member Charters dialog (B47). It offers the charters the member's
 * warehouse serves: ChartersService.list() (active charters) crossed with
 * WarehouseChartersService.listPairs() (the organization's links), and seeds
 * its selection from them, then saves that pruned list. Both reads were cut by
 * PostgREST's 1000-row max_rows with no error: the charters at the first 1000
 * by name, the links at an ARBITRARY 1000 (that read had no order). A member's
 * charter outside either cut was dropped on a save that changed nothing, and a
 * member whose only charter fell outside it became "all charters" at that
 * warehouse. Both reads are now paged, so the dialog sees every charter and
 * every link. The real services run here over one stub.
 */

const h = vi.hoisted(() => ({
  ctx: null as unknown,
  stub: null as unknown,
  managerProps: vi.fn(),
}));

vi.mock('@/server/services/context', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/server/services/context')>();
  return { ...real, withContext: vi.fn(async () => h.ctx) };
});
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-test',
    userId: 'u1',
    role: 'admin',
    permissions: new Set(['members:invite']),
  })),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => h.stub) }));
vi.mock('@/lib/env', () => ({ env: { NEXT_PUBLIC_APP_URL: 'https://app.test' } }));
vi.mock('@/lib/nav-labels', () => ({
  effectiveNavLabel: vi.fn(async (_href: string, fallback: string) => fallback),
}));

const W = '00000000-0000-4000-8000-0000000000a1';
const LAST_CHARTER = 'ffffffff-0000-4000-8000-000000000001';

vi.mock('@/server/services/team', () => ({
  TeamService: {
    forCurrentUser: vi.fn(async () => ({
      listMembers: async () => [
        {
          id: 'm-1',
          user_id: '00000000-0000-4000-8000-0000000000e1',
          role: 'staff',
          invited_at: null,
          accepted_at: null,
          user: {
            email: 'member@example.test',
            full_name: null,
            avatar_url: null,
            disabled_at: null,
          },
          warehouse_id: W,
          charter_ids: [LAST_CHARTER],
        },
      ],
      listPendingInvites: async () => [],
    })),
  },
}));
vi.mock('@/server/services/warehouses', () => ({
  WarehousesService: {
    forCurrentUser: vi.fn(async () => ({ listNames: async () => [{ id: W, name: 'North' }] })),
  },
}));
vi.mock('@/components/team/team-manager', () => ({
  TeamManager: (props: Record<string, unknown>) => {
    h.managerProps(props);
    return null;
  },
}));

import { makeServiceContext, makeSupabaseStub, servedLikePostgrest } from '@/test/supabase-mock';

import TeamPage from './page';

const ORG = 'org-test';
const charterId = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

// 1200 active charters; the member's only charter sorts LAST by name.
const CHARTERS = [
  ...Array.from({ length: 1199 }, (_, i) => ({
    id: charterId(i),
    organization_id: ORG,
    name: `A charter ${String(i).padStart(4, '0')}`,
    code: null,
    status: 'active',
    warehouses: [],
    users: [],
  })),
  {
    id: LAST_CHARTER,
    organization_id: ORG,
    name: 'Zebra charter',
    code: null,
    status: 'active',
    warehouses: [],
    users: [],
  },
];

// 1500 links: W serves 1200 of the charters, a second warehouse 300. The
// member's link is stored LAST, past the first 1000 of an unordered read.
const OTHER_WH = '00000000-0000-4000-8000-0000000000a2';
const LINKS = [
  ...Array.from({ length: 1199 }, (_, i) => ({
    organization_id: ORG,
    warehouse_id: W,
    charter_id: charterId(i),
  })),
  ...Array.from({ length: 300 }, (_, i) => ({
    organization_id: ORG,
    warehouse_id: OTHER_WH,
    charter_id: charterId(i),
  })),
  { organization_id: ORG, warehouse_id: W, charter_id: LAST_CHARTER },
];

beforeEach(() => {
  vi.clearAllMocks();
  const stub = makeSupabaseStub({
    'organizations.select': { data: { terminology: null }, error: null },
    'categories.select': { data: [], error: null },
    'user_category_assignments.select': { data: [], error: null },
    'charters.select': servedLikePostgrest(CHARTERS),
    'warehouse_charters.select': servedLikePostgrest(LINKS),
  });
  h.stub = stub.client;
  h.ctx = makeServiceContext(stub.client, { organizationId: ORG });
});

describe('Team page: the member Charters dialog past 1000 charters and 1000 links', () => {
  it("offers the member's charter that sorts last by name, and its link to the member's warehouse", async () => {
    render(await TeamPage());

    const props = h.managerProps.mock.calls.at(-1)?.[0] as {
      charters: Array<{ id: string; name: string }>;
      warehouseCharters: Array<{ warehouse_id: string; charter_id: string }>;
    };
    expect(props.charters).toHaveLength(1200);
    expect(props.charters).toContainEqual({ id: LAST_CHARTER, name: 'Zebra charter' });
    expect(props.warehouseCharters).toHaveLength(1500);
    expect(props.warehouseCharters.map((p) => `${p.warehouse_id}/${p.charter_id}`)).toContain(
      `${W}/${LAST_CHARTER}`,
    );
  });
});
