import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, servedLikePostgrest, type MockCall } from '@/test/supabase-mock';

/**
 * The daily restore-point cron: organizations whose last automatic point is
 * oldest go first, a soft deadline stops new snapshots from starting, the
 * run says how many organizations it left, and those go first next run. A
 * snapshot that stops part way writes nothing.
 */

const envHolder = { env: { CRON_SECRET: 'test-cron-secret' } as { CRON_SECRET?: string } };
vi.mock('@/lib/env', () => ({
  get env() {
    return envHolder.env;
  },
}));

const h = vi.hoisted(() => ({
  client: null as unknown,
  reportError: vi.fn(),
  createSnapshot: null as
    null | ((ctx: { organizationId: string }, opts: unknown) => Promise<unknown>),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: h.reportError }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.client }));
vi.mock('@/server/services/restore-points', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/services/restore-points')>();
  return {
    ...actual,
    createSnapshot: (ctx: { organizationId: string }, opts: unknown) =>
      (h.createSnapshot ?? actual.createSnapshot)(ctx as never, opts as never),
  };
});

import { GET, maxDuration } from './route';

const DAY = 24 * 60 * 60_000;
const NOW = new Date('2026-11-17T02:00:00.000Z');

const business = (id: string) => ({
  id,
  plan: 'business',
  access_tier: null,
  billing_arrangement: null,
  stripe_subscription_id: null,
  trial_ends_at: null,
  trial_tier: null,
});

type PointRow = { id: string; organization_id: string; created_at: string; kind: string };

function stub(opts: {
  orgs: string[];
  points?: PointRow[] | (() => PointRow[]);
  pointsError?: boolean;
  items?: (call: MockCall) => { data: unknown; error: { message: string } | null };
}) {
  const s = makeSupabaseStub({
    'organizations.select': servedLikePostgrest(opts.orgs.map(business)),
    'organization_members.select': { data: [{ user_id: 'owner-1' }], error: null },
    'organization_modules.select': { data: [], error: null },
    'restore_points.select': opts.pointsError
      ? { data: null, error: { message: 'boom' } }
      : servedLikePostgrest(() =>
          typeof opts.points === 'function' ? opts.points() : (opts.points ?? []),
        ),
    'restore_points.insert': (call) => ({
      data: { id: `rp-${(call.args[0]![0] as { organization_id: string }).organization_id}` },
      error: null,
    }),
    ...(opts.items ? { 'inventory_items.select': opts.items } : {}),
  });
  h.client = s.client;
  return s;
}

const run = () =>
  GET(
    new Request('https://test.local/api/cron/restore-points', {
      headers: { authorization: 'Bearer test-cron-secret' },
    }),
  );

const point = (org: string, msAgo: number, kind = 'auto'): PointRow => ({
  id: `p-${org}-${msAgo}-${kind}`,
  organization_id: org,
  created_at: new Date(Date.now() - msAgo).toISOString(),
  kind,
});

let started: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  envHolder.env = { CRON_SECRET: 'test-cron-secret' };
  started = [];
  h.createSnapshot = async (ctx) => {
    started.push(ctx.organizationId);
    return { id: `rp-${ctx.organizationId}`, itemCount: 0, capped: false };
  };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GET /api/cron/restore-points: order', () => {
  it('goes oldest last automatic point first; an organization with none goes first of all', async () => {
    stub({
      orgs: ['a', 'b', 'c', 'd'],
      points: [
        point('a', 1 * DAY),
        point('b', 2 * DAY),
        point('d', 1 * DAY),
        point('d', 1 * DAY - 60_000), // d's newest point is a minute newer than a's
        // A manual point does not count: c still has no automatic one.
        point('c', 60 * 60_000, 'manual'),
      ],
    });
    const res = await run();
    expect(res.status).toBe(200);
    expect(started).toEqual(['c', 'b', 'a', 'd']);
    expect(await res.json()).toEqual({
      eligible: 4,
      snapshotted: 4,
      noOwner: 0,
      failed: 0,
      leftForNextRun: 0,
    });
  });

  it('a failed ordering read still snapshots every organization, in id order, and is reported', async () => {
    stub({ orgs: ['b', 'a'], pointsError: true });
    const res = await run();
    expect(res.status).toBe(200);
    expect(started).toEqual(['a', 'b']);
    const tags = h.reportError.mock.calls.map((c) => (c[1] as { tag: string }).tag);
    expect(tags).toEqual(['cron.restore-points.order']);
  });
});

describe('GET /api/cron/restore-points: deadline', () => {
  it('stops STARTING snapshots at the soft deadline, and reports how many organizations it left', async () => {
    stub({ orgs: ['a', 'b', 'c', 'd', 'e'] });
    h.createSnapshot = async (ctx) => {
      started.push(ctx.organizationId);
      vi.setSystemTime(Date.now() + 120_000); // each snapshot takes 120 s
      return { id: 'x', itemCount: 0, capped: false };
    };
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    const res = await run();
    // Three at once: a, b and c start at 0 s and finish by 360 s, so d and e
    // would start past the 200 s deadline.
    expect(started).toEqual(['a', 'b', 'c']);
    expect(await res.json()).toMatchObject({ eligible: 5, snapshotted: 3, leftForNextRun: 2 });

    const deadline = h.reportError.mock.calls.find(
      (c) => (c[1] as { tag: string }).tag === 'cron.restore-points.deadline',
    );
    expect(deadline?.[1]).toMatchObject({
      level: 'warning',
      extra: { eligible: 5, snapshotted: 3, leftForNextRun: 2 },
    });
    const lines = info.mock.calls.filter((c) => c[0] === '[cron.restore-points]');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(String(lines[0]![1]))).toMatchObject({
      eligible: 5,
      snapshotted: 3,
      leftForNextRun: 2,
    });
    // Counts only: no organization ids in the line.
    expect(String(lines[0]![1])).not.toMatch(/"a"|"b"|"c"|"d"|"e"/);
    info.mockRestore();
  });

  it('over consecutive nights every organization gets a point, the ones left first on the next night', async () => {
    // Three snapshots fit in a night (three at once, each 100 s, so the next
    // would start at 300 s, past the 200 s deadline). Before, the order was id
    // order every night, so d and e never got one.
    const store: PointRow[] = [];
    stub({ orgs: ['a', 'b', 'c', 'd', 'e'], points: () => store });
    const nights: string[][] = [];
    h.createSnapshot = async (ctx) => {
      started.push(ctx.organizationId);
      store.push(point(ctx.organizationId, 0));
      vi.setSystemTime(Date.now() + 100_000);
      return { id: 'x', itemCount: 0, capped: false };
    };
    vi.spyOn(console, 'info').mockImplementation(() => {});

    for (let night = 0; night < 3; night += 1) {
      vi.setSystemTime(NOW.getTime() + night * DAY);
      started = [];
      await run();
      nights.push(started);
    }
    expect(nights[0]).toEqual(['a', 'b', 'c']);
    expect(nights[1]).toEqual(['d', 'e', 'a']);
    expect(nights[2]).toEqual(['b', 'c', 'd']);
    expect(new Set(nights.flat())).toEqual(new Set(['a', 'b', 'c', 'd', 'e']));
  });

  it('leaves the snapshot in flight minutes past the deadline to finish', () => {
    expect(maxDuration * 1000 - 200_000).toBeGreaterThanOrEqual(90_000);
  });
});

describe('GET /api/cron/restore-points: a snapshot is whole or absent', () => {
  it('a read that fails part way writes no restore point, is counted as failed, and the next organization still gets one', async () => {
    h.createSnapshot = null; // the real createSnapshot
    const s = stub({
      orgs: ['a', 'b'],
      items: (call) => {
        const org = call.args[call.methods.indexOf('eq')]?.[1];
        const from = Number(call.args[call.methods.indexOf('range')]?.[0]);
        if (org === 'a' && from >= 1000)
          return { data: null, error: { message: 'connection reset' } };
        if (org === 'a') {
          // A full first page, so the read goes on to the page that fails.
          return {
            data: Array.from({ length: 1000 }, (_, i) => ({
              id: `a-${i}`,
              sku: `A${i}`,
              name: 'Item',
            })),
            error: null,
          };
        }
        return { data: [{ id: 'b-1', sku: 'B1', name: 'Item' }], error: null };
      },
    });
    vi.spyOn(console, 'info').mockImplementation(() => {});

    const res = await run();
    expect(await res.json()).toMatchObject({ eligible: 2, snapshotted: 1, failed: 1 });
    const inserted = (s.chainArgsAll.get('restore_points.insert') ?? []).map(
      (args) => (args[0]![0] as { organization_id: string }).organization_id,
    );
    expect(inserted).toEqual(['b']);
  });
});
