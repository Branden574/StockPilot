// @vitest-environment happy-dom
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Team page's names for the charters members hold that the active charter
 * list lacks (S44): an archived or inactive charter keeps its links and
 * assignments, so the member Charters dialog lists it, named. The page reads
 * those names by id, only when a member holds one (no request otherwise), and
 * a failed read is a warning with a neutral label in the dialog, never an
 * error page and never a change to what a member holds.
 */

const { stubRef, managerProps, reportError, names } = vi.hoisted(() => ({
  stubRef: { current: null as unknown },
  managerProps: vi.fn(),
  reportError: vi.fn(async (..._args: unknown[]) => {}),
  names: {
    members: [] as Array<{ user_id: string; charter_ids: string[] }>,
    namesByIds: vi.fn(async (_ids: readonly string[]): Promise<unknown[]> => []),
  },
}));

vi.mock('@/lib/error-reporter', () => ({ reportError }));
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
vi.mock('@/lib/nav-labels', () => ({
  effectiveNavLabel: vi.fn(async (_href: string, fallback: string) => fallback),
}));

const CH_1 = '00000000-0000-4000-8000-0000000000c1';
const CH_X = '00000000-0000-4000-8000-0000000000c9';
const WH = '00000000-0000-4000-8000-0000000000a1';

vi.mock('@/server/services/team', () => ({
  TeamService: {
    forCurrentUser: vi.fn(async () => ({
      listMembers: async () =>
        names.members.map((m, i) => ({
          id: `m-${i}`,
          user_id: m.user_id,
          role: 'staff',
          invited_at: null,
          accepted_at: null,
          user: {
            email: `s${i}@example.test`,
            full_name: null,
            avatar_url: null,
            disabled_at: null,
          },
          warehouse_id: WH,
          charter_ids: m.charter_ids,
        })),
      listPendingInvites: async () => [],
    })),
  },
}));
vi.mock('@/server/services/charters', () => ({
  ChartersService: {
    forCurrentUser: vi.fn(async () => ({
      list: async () => [{ id: CH_1, name: 'North', status: 'active' }],
      namesByIds: (ids: readonly string[]) => names.namesByIds(ids),
    })),
  },
}));
vi.mock('@/server/services/warehouses', () => ({
  WarehousesService: {
    forCurrentUser: vi.fn(async () => ({ listNames: async () => [{ id: WH, name: 'Main' }] })),
  },
}));
vi.mock('@/server/services/warehouse-charters', () => ({
  WarehouseChartersService: {
    forCurrentUser: vi.fn(async () => ({
      listPairs: async () => [
        { warehouse_id: WH, charter_id: CH_1 },
        { warehouse_id: WH, charter_id: CH_X },
      ],
    })),
  },
}));
vi.mock('@/components/team/team-manager', () => ({
  TeamManager: (props: Record<string, unknown>) => {
    managerProps(props);
    return null;
  },
}));

import { ServiceError } from '@/server/services/context';
import { makeSupabaseStub } from '@/test/supabase-mock';

import TeamPage from './page';

beforeEach(() => {
  vi.clearAllMocks();
  names.namesByIds.mockImplementation(async () => [
    { id: CH_X, name: 'Old Campus', status: 'archived' },
  ]);
  stubRef.current = makeSupabaseStub({
    'organizations.select': { data: { terminology: null }, error: null },
    'categories.select': { data: [], error: null },
    'user_category_assignments.select': { data: [], error: null },
  }).client;
});

const lastProps = () =>
  managerProps.mock.calls.at(-1)?.[0] as {
    unlistedCharters?: Array<{ id: string; name: string; status: string }>;
    members: Array<{ charterIds: string[] }>;
  };

describe("Team page: names for members' charters the active list lacks", () => {
  it('reads only the ids the active list lacks, once, and passes their names and statuses', async () => {
    names.members = [
      { user_id: 'u-a', charter_ids: [CH_X, CH_1] },
      { user_id: 'u-b', charter_ids: [CH_X] },
    ];

    render(await TeamPage());

    expect(names.namesByIds).toHaveBeenCalledTimes(1);
    expect(names.namesByIds).toHaveBeenCalledWith([CH_X]);
    expect(lastProps().unlistedCharters).toEqual([
      { id: CH_X, name: 'Old Campus', status: 'archived' },
    ]);
    // What each member holds is passed on as it is.
    expect(lastProps().members.map((m) => m.charterIds)).toEqual([[CH_X, CH_1], [CH_X]]);
  });

  it('sends no request when every held charter is active', async () => {
    names.members = [{ user_id: 'u-a', charter_ids: [CH_1] }];

    render(await TeamPage());

    expect(names.namesByIds).not.toHaveBeenCalled();
    expect(lastProps().unlistedCharters).toEqual([]);
  });

  it('a failed read still renders the page, with no names and one warning report', async () => {
    names.members = [{ user_id: 'u-a', charter_ids: [CH_X] }];
    names.namesByIds.mockImplementation(async () => {
      throw new ServiceError('internal_error', 'upstream connect error');
    });

    render(await TeamPage());

    expect(lastProps().unlistedCharters).toEqual([]);
    expect(lastProps().members.map((m) => m.charterIds)).toEqual([[CH_X]]);
    expect(reportError).toHaveBeenCalledTimes(1);
    const [, opts] = reportError.mock.calls[0] as [
      Error,
      { tag: string; level: string; extra: Record<string, unknown> },
    ];
    expect(opts.tag).toBe('team.member_charters.labels');
    expect(opts.level).toBe('warning');
    expect(String(opts.extra.detail)).toContain('upstream connect error');
  });
});
