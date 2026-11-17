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

type AttemptRow = {
  job: string;
  organization_id: string;
  last_attempt_at: string;
  consecutive_failures: number;
};

function stub(opts: {
  orgs: string[];
  points?: PointRow[] | (() => PointRow[]);
  pointsError?: boolean;
  items?: (call: MockCall) => { data: unknown; error: { message: string } | null };
  /** cron_sweep_attempts rows, kept up to date by the cron's upserts. */
  attempts?: AttemptRow[];
  /** Organizations whose owner/admin read ('members') or module set read
   *  ('modules') fails. */
  contextFails?: Record<string, 'members' | 'modules'>;
}) {
  const readFails = (call: MockCall, what: 'members' | 'modules') =>
    opts.contextFails?.[String(call.args[call.methods.indexOf('eq')]?.[1])] === what;
  const READ_ERROR = { message: 'canceling statement due to statement timeout', code: '57014' };
  const attempts = opts.attempts ?? [];
  const s = makeSupabaseStub({
    'cron_sweep_attempts.select': servedLikePostgrest(() => attempts),
    'cron_sweep_attempts.insert': (call) => {
      const row = call.args[call.methods.indexOf('upsert')]![0] as Partial<AttemptRow> & {
        job: string;
        organization_id: string;
      };
      const prev = attempts.find(
        (a) => a.job === row.job && a.organization_id === row.organization_id,
      );
      if (prev) Object.assign(prev, row);
      else attempts.push({ consecutive_failures: 0, last_attempt_at: '', ...row });
      return { data: null, error: null };
    },
    'organizations.select': servedLikePostgrest(opts.orgs.map(business)),
    'organization_members.select': (call) =>
      readFails(call, 'members')
        ? { data: null, error: READ_ERROR }
        : { data: [{ user_id: 'owner-1' }], error: null },
    'organization_modules.select': (call) =>
      readFails(call, 'modules') ? { data: null, error: READ_ERROR } : { data: [], error: null },
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
    // One at a time: a at 0 s, b at 120 s; c would start at 240 s, past the
    // 200 s deadline.
    expect(started).toEqual(['a', 'b']);
    expect(await res.json()).toMatchObject({ eligible: 5, snapshotted: 2, leftForNextRun: 3 });

    const deadline = h.reportError.mock.calls.find(
      (c) => (c[1] as { tag: string }).tag === 'cron.restore-points.deadline',
    );
    expect(deadline?.[1]).toMatchObject({
      level: 'warning',
      extra: { eligible: 5, snapshotted: 2, leftForNextRun: 3 },
    });
    const lines = info.mock.calls.filter((c) => c[0] === '[cron.restore-points]');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(String(lines[0]![1]))).toMatchObject({
      eligible: 5,
      snapshotted: 2,
      leftForNextRun: 3,
    });
    // Counts only: no organization ids in the line.
    expect(String(lines[0]![1])).not.toMatch(/"a"|"b"|"c"|"d"|"e"/);
    info.mockRestore();
  });

  it('over consecutive nights every organization gets a point, the ones left first on the next night', async () => {
    // Two snapshots fit in a night (one at a time, each 100 s, so the third
    // would start at 200 s, the deadline). Before, the order was id order
    // every night, so c, d and e never got one.
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
    expect(nights[0]).toEqual(['a', 'b']);
    expect(nights[1]).toEqual(['c', 'd']);
    expect(nights[2]).toEqual(['e', 'a']);
    expect(new Set(nights.flat())).toEqual(new Set(['a', 'b', 'c', 'd', 'e']));
  });

  it('takes one snapshot at a time: none starts before the one before it has ended', async () => {
    // A snapshot can hold 50,000 items in memory; the cap bounds the peak
    // only while one runs at a time.
    vi.useRealTimers();
    stub({ orgs: ['a', 'b', 'c', 'd'] });
    let inFlight = 0;
    let most = 0;
    h.createSnapshot = async (ctx) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      started.push(ctx.organizationId);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { id: 'x', itemCount: 0, capped: false };
    };
    vi.spyOn(console, 'info').mockImplementation(() => {});
    await run();
    expect(started).toEqual(['a', 'b', 'c', 'd']);
    expect(most).toBe(1);
  });

  it('leaves the snapshot in flight minutes past the deadline to finish', () => {
    expect(maxDuration * 1000 - 200_000).toBeGreaterThanOrEqual(90_000);
  });
});

describe('GET /api/cron/restore-points: attempts (cron_sweep_attempts, 0492)', () => {
  it('records each attempt as the org starts, under job restore_points, before its snapshot', async () => {
    const s = stub({ orgs: ['a', 'b'] });
    const order: string[] = [];
    h.createSnapshot = async (ctx) => {
      const stamped = (s.chainArgsAll.get('cron_sweep_attempts.insert') ?? []).map(
        (args) => (args[0]![0] as { organization_id: string }).organization_id,
      );
      order.push(
        `${ctx.organizationId}:${stamped.includes(ctx.organizationId) ? 'stamped' : 'not'}`,
      );
      return { id: 'x', itemCount: 0, capped: false };
    };
    vi.spyOn(console, 'info').mockImplementation(() => {});
    await run();
    expect(order).toEqual(['a:stamped', 'b:stamped']);
    const writes = (s.chainArgsAll.get('cron_sweep_attempts.insert') ?? []).map((args) => ({
      row: args[0]![0] as Record<string, unknown>,
      opts: args[0]![1],
    }));
    // The stamp as each org starts (counted as a failure in advance), then
    // the correction after its snapshot.
    expect(
      writes.map((w) => [w.row.job, w.row.organization_id, w.row.consecutive_failures]),
    ).toEqual([
      ['restore_points', 'a', 1],
      ['restore_points', 'a', 0],
      ['restore_points', 'b', 1],
      ['restore_points', 'b', 0],
    ]);
    for (const w of writes) expect(w.opts).toEqual({ onConflict: 'job,organization_id' });
    // The read takes this job's rows only.
    const read = s.chainArgsAll.get('cron_sweep_attempts.select')![0]!;
    expect(read).toContainEqual(['job', 'restore_points']);
  });

  it('an organization whose snapshot always fails goes to the back of the line instead of leading every night', async () => {
    // Two snapshots fit in a night. 'a-fails' has no point, so ordering by the
    // last point alone put it first every night and it took one of the two
    // places each time.
    const store: PointRow[] = [];
    const attempts: AttemptRow[] = [];
    stub({ orgs: ['a-fails', 'b', 'c', 'd'], points: () => store, attempts });
    h.createSnapshot = async (ctx) => {
      started.push(ctx.organizationId);
      vi.setSystemTime(Date.now() + 100_000);
      if (ctx.organizationId === 'a-fails') throw new Error('statement timeout');
      store.push(point(ctx.organizationId, 0));
      return { id: 'x', itemCount: 0, capped: false };
    };
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const nights: string[][] = [];
    for (let night = 0; night < 3; night += 1) {
      vi.setSystemTime(NOW.getTime() + night * DAY);
      started = [];
      await run();
      nights.push(started);
    }
    expect(nights).toEqual([
      ['a-fails', 'b'],
      ['c', 'd'],
      ['a-fails', 'b'],
    ]);
    expect(attempts.find((a) => a.organization_id === 'a-fails')?.consecutive_failures).toBe(2);
    expect(attempts.find((a) => a.organization_id === 'b')?.consecutive_failures).toBe(0);
    const last = info.mock.calls.filter((c) => c[0] === '[cron.restore-points]').at(-1);
    expect(JSON.parse(String(last?.[1]))).toMatchObject({ failed: 1, failingRepeatedly: 0 });
  });

  it('a failed attempts read still runs, ordered by the last point, and is reported', async () => {
    const s = makeSupabaseStub({
      'organizations.select': servedLikePostgrest(['a', 'b'].map(business)),
      'organization_members.select': { data: [{ user_id: 'owner-1' }], error: null },
      'organization_modules.select': { data: [], error: null },
      'restore_points.select': servedLikePostgrest([point('a', 1 * DAY), point('b', 2 * DAY)]),
      'cron_sweep_attempts.select': { data: null, error: { message: 'attempts read failed' } },
      'cron_sweep_attempts.insert': { data: null, error: null },
    });
    h.client = s.client;
    vi.spyOn(console, 'info').mockImplementation(() => {});
    await run();
    expect(started).toEqual(['b', 'a']);
    const tags = h.reportError.mock.calls.map((c) => (c[1] as { tag: string }).tag);
    expect(tags).toEqual(['cron.restore-points.attempts']);
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

describe('GET /api/cron/restore-points: the system context', () => {
  it('an organization whose owner/admin or module set cannot be read is failed, reported once, never "no owner"', async () => {
    stub({ orgs: ['a', 'b', 'c'], contextFails: { a: 'members', b: 'modules' } });
    vi.spyOn(console, 'info').mockImplementation(() => {});

    const res = await run();
    expect(await res.json()).toMatchObject({ eligible: 3, snapshotted: 1, noOwner: 0, failed: 2 });
    expect(started).toEqual(['c']);
    const reports = h.reportError.mock.calls.filter(
      (c) => (c[1] as { tag: string }).tag === 'cron.restore-points.context',
    );
    expect(reports).toHaveLength(1);
    // No organization id in the report: the count is in the log line.
    expect(reports[0]![1]).toEqual({ tag: 'cron.restore-points.context' });
  });
});
