// @vitest-environment happy-dom
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Team page's viewer category grants.
 *
 * It read every viewer's grants in one `.in('user_id', …)`, unpaged, with the
 * error ignored. Past ~215 viewers the local gateway answers 414 and past
 * ~395 production fails after ~7 s of retries; a viewer can hold up to 500
 * grants, so even a short list was cut at 1000 rows. Either way the access
 * dialog showed fewer grants than a viewer has. The read is now batched and
 * paged and a failure fails the page.
 */

const { stubRef, managerProps } = vi.hoisted(() => ({
  stubRef: { current: null as unknown },
  managerProps: vi.fn(),
}));

vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u1',
    role: 'admin',
    permissions: new Set(['members:invite']),
  })),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => stubRef.current) }));
vi.mock('@/lib/env', () => ({ env: { NEXT_PUBLIC_APP_URL: 'https://app.test' } }));

const viewerId = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const members = Array.from({ length: 250 }, (_, i) => ({
  id: `m-${i}`,
  user_id: viewerId(i),
  role: 'viewer',
  invited_at: null,
  accepted_at: null,
  user: { email: `v${i}@x.test`, full_name: null, avatar_url: null, disabled_at: null },
  warehouse_id: null,
  charter_ids: [],
}));
vi.mock('@/server/services/team', () => ({
  TeamService: {
    forCurrentUser: vi.fn(async () => ({
      listMembers: async () => members,
      listPendingInvites: async () => [],
    })),
  },
}));
vi.mock('@/server/services/charters', () => ({
  ChartersService: { forCurrentUser: vi.fn(async () => ({ list: async () => [] })) },
}));
vi.mock('@/server/services/warehouses', () => ({
  WarehousesService: { forCurrentUser: vi.fn(async () => ({ listNames: async () => [] })) },
}));
vi.mock('@/server/services/warehouse-charters', () => ({
  WarehouseChartersService: { forCurrentUser: vi.fn(async () => ({ listPairs: async () => [] })) },
}));
vi.mock('@/components/team/team-manager', () => ({
  TeamManager: (props: Record<string, unknown>) => {
    managerProps(props);
    return null;
  },
}));

import { inFilters, makeSupabaseStub, type MockCall } from '@/test/supabase-mock';

import TeamPage from './page';

beforeEach(() => vi.clearAllMocks());

describe('Team page: 250 viewers', () => {
  it('reads grants in batches of at most 100 viewers, paged, and shows the last viewer its grants', async () => {
    const lists: string[][] = [];
    stubRef.current = makeSupabaseStub({
      'organizations.select': { data: { terminology: null }, error: null },
      'categories.select': { data: [{ id: 'cat-1', name: 'Tech' }], error: null },
      'user_category_assignments.select': (call: MockCall) => {
        const ids = (inFilters(call).find(([c]) => c === 'user_id')?.[1] ?? []) as string[];
        lists.push(ids);
        return {
          data: ids.map((user_id) => ({ user_id, category_id: 'cat-1' })),
          error: null,
        };
      },
    }).client;

    render(await TeamPage());

    expect(lists.map((l) => l.length)).toEqual([100, 100, 50]);
    const props = managerProps.mock.calls.at(-1)?.[0] as {
      grantsByUser: Record<string, string[]>;
    };
    expect(Object.keys(props.grantsByUser)).toHaveLength(250);
    expect(props.grantsByUser[viewerId(249)]).toEqual(['cat-1']);
  });

  it('a failed grants batch fails the page, never a viewer shown with no grants', async () => {
    let n = 0;
    stubRef.current = makeSupabaseStub({
      'organizations.select': { data: { terminology: null }, error: null },
      'categories.select': { data: [], error: null },
      'user_category_assignments.select': () =>
        ++n === 2 ? { data: null, error: { message: 'fetch failed' } } : { data: [], error: null },
    }).client;
    await expect(TeamPage()).rejects.toMatchObject({ code: 'internal_error' });
  });

  it('a failed categories read fails the page, never an empty list to grant from', async () => {
    stubRef.current = makeSupabaseStub({
      'organizations.select': { data: { terminology: null }, error: null },
      'categories.select': { data: null, error: { message: 'fetch failed' } },
      'user_category_assignments.select': { data: [], error: null },
    }).client;
    await expect(TeamPage()).rejects.toThrow(/categories read failed/);
  });
});
