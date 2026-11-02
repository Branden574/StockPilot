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

const { stubRef, managerProps, ceiling, reportError } = vi.hoisted(() => ({
  stubRef: { current: null as unknown },
  managerProps: vi.fn(),
  // The shared LOOKUP_ROW_CEILING, lowered by the ceiling test.
  ceiling: { value: 10_000 },
  reportError: vi.fn(async (..._args: unknown[]) => {}),
}));

vi.mock('@/lib/error-reporter', () => ({ reportError }));
// A getter, so a test can lower the ceiling: the page reads the binding on
// every render.
vi.mock('@/server/services/lib/lookup-ceiling', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/lib/lookup-ceiling')>()),
  get LOOKUP_ROW_CEILING() {
    return ceiling.value;
  },
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
// The heading's nav label reads the request-cached org row; not under test here.
vi.mock('@/lib/nav-labels', () => ({
  effectiveNavLabel: vi.fn(async (_href: string, fallback: string) => fallback),
}));

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

import {
  callArgs,
  inFilters,
  makeSupabaseStub,
  servedLikePostgrest,
  type MockCall,
} from '@/test/supabase-mock';

import TeamPage from './page';

beforeEach(() => {
  vi.clearAllMocks();
  ceiling.value = 10_000;
});

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

  it('the failed categories read keeps the PostgREST text in its message, for the log', async () => {
    stubRef.current = makeSupabaseStub({
      'organizations.select': { data: { terminology: null }, error: null },
      'categories.select': { data: null, error: { message: 'fetch failed' } },
      'user_category_assignments.select': { data: [], error: null },
    }).client;
    await expect(TeamPage()).rejects.toThrow(/\[team\] categories read failed: fetch failed/);
  });
});

/**
 * B47: the Category access dialog lists the categories to grant from ONE read
 * ordered by name with no range, so past 1000 categories PostgREST cut it at
 * the first 1000 with no error and a later category could not be granted or
 * unticked on its own. The read is now paged, ordered by name and then id.
 */
describe('Team page: more than 1000 categories', () => {
  it("lists all 1200 categories in the viewer's Category access, the last by name included", async () => {
    const cats = Array.from({ length: 1200 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      organization_id: 'org-1',
      name: `A category ${String(i).padStart(4, '0')}`,
      deleted_at: null,
    }));
    const stub = makeSupabaseStub({
      'organizations.select': { data: { terminology: null }, error: null },
      'categories.select': servedLikePostgrest([
        ...cats,
        {
          id: 'ffffffff-0000-4000-8000-000000000001',
          organization_id: 'org-1',
          name: 'Zebra',
          deleted_at: null,
        },
        {
          id: 'eeeeeeee-0000-4000-8000-000000000001',
          organization_id: 'org-1',
          name: 'B gone',
          deleted_at: '2026-01-01T00:00:00Z',
        },
      ]),
      'user_category_assignments.select': { data: [], error: null },
    });
    stubRef.current = stub.client;

    render(await TeamPage());

    const props = managerProps.mock.calls.at(-1)?.[0] as {
      allCategories: Array<{ id: string; name: string }>;
    };
    expect(props.allCategories).toHaveLength(1201);
    expect(props.allCategories.at(-1)).toEqual({
      id: 'ffffffff-0000-4000-8000-000000000001',
      name: 'Zebra',
    });
    expect(stub.chainsAll.get('categories.select')).toHaveLength(2);
    expect(reportError).not.toHaveBeenCalled();
  });

  /**
   * B47 decisions round (2026-11-01): the read stops at LOOKUP_ROW_CEILING,
   * the first categories by name and then id, and reports it once with the
   * organization only. The list is for display: the dialog's save sends the
   * viewer's whole grant set, seeded from the grants read.
   */
  it('stops at the ceiling with the first categories by name then id, and reports it once', async () => {
    ceiling.value = 1100;
    const cats = Array.from({ length: 1200 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      organization_id: 'org-1',
      name: `A category ${String(i).padStart(4, '0')}`,
      deleted_at: null,
    }));
    const stub = makeSupabaseStub({
      'organizations.select': { data: { terminology: null }, error: null },
      'categories.select': servedLikePostgrest(cats),
      'user_category_assignments.select': { data: [], error: null },
    });
    stubRef.current = stub.client;

    render(await TeamPage());

    const props = managerProps.mock.calls.at(-1)?.[0] as {
      allCategories: Array<{ id: string; name: string }>;
    };
    expect(props.allCategories).toHaveLength(1100);
    expect(props.allCategories.at(-1)?.name).toBe('A category 1099');
    // The second page is cut at the ceiling, not read in full.
    const page2 = stub.chainsAll.get('categories.select')![1]!;
    expect(stub.chainArgsAll.get('categories.select')![1]![page2.indexOf('range')]).toEqual([
      1000, 1099,
    ]);
    const ceilingReports = reportError.mock.calls.filter((c) =>
      String((c[1] as { tag: string }).tag).startsWith('lookup_ceiling.'),
    );
    expect(ceilingReports).toHaveLength(1);
    expect(ceilingReports[0]?.[1]).toMatchObject({
      tag: 'lookup_ceiling.team.categories',
      extra: { lookup: 'team.categories', organizationId: 'org-1' },
    });
  });
});

/**
 * B9 review: the Disabled badge's tooltip printed the server's clock (UTC on
 * Vercel) with no zone named. The page now hands the list the organization's
 * zone, read with the terminology it already reads.
 */
describe("Team page: the organization's time zone", () => {
  const ORG_ROW: Record<string, unknown> = { terminology: null, timezone: 'America/New_York' };

  it('asks for the zone and passes it to the list', async () => {
    stubRef.current = makeSupabaseStub({
      // Only the columns the page asks for, as PostgREST answers.
      'organizations.select': (call: MockCall) => {
        const cols = String(callArgs(call, 'select')?.[0] ?? '')
          .split(',')
          .map((c) => c.trim());
        return {
          data: Object.fromEntries(cols.filter((c) => c in ORG_ROW).map((c) => [c, ORG_ROW[c]])),
          error: null,
        };
      },
      'categories.select': { data: [], error: null },
      'user_category_assignments.select': { data: [], error: null },
    }).client;

    render(await TeamPage());

    const props = managerProps.mock.calls.at(-1)?.[0] as { timeZone: string };
    expect(props.timeZone).toBe('America/New_York');
  });

  it('an organization row that did not arrive is the documented default zone, not a failed page', async () => {
    stubRef.current = makeSupabaseStub({
      'organizations.select': { data: null, error: { message: 'fetch failed' } },
      'categories.select': { data: [], error: null },
      'user_category_assignments.select': { data: [], error: null },
    }).client;

    render(await TeamPage());

    const props = managerProps.mock.calls.at(-1)?.[0] as { timeZone: string };
    expect(props.timeZone).toBe('America/Los_Angeles');
  });
});
