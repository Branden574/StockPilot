import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

/**
 * The Exception Center sync cron (F1-1): CRON_SECRET-gated, three orgs at a
 * time, least recently reached first (the later of the last sync and the
 * cron's last attempt), fail-open per org, and a soft deadline so a slow run
 * stops itself instead of being killed mid-sweep.
 */

const envHolder = { env: { CRON_SECRET: 'test-cron-secret' } as { CRON_SECRET?: string } };
vi.mock('@/lib/env', () => ({
  get env() {
    return envHolder.env;
  },
}));

const reportError = vi.hoisted(() => vi.fn());
vi.mock('@/lib/error-reporter', () => ({ reportError }));

const adminHolder = { client: null as unknown };
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn(() => adminHolder.client) }));

const syncOrg = vi.hoisted(() => vi.fn());
vi.mock('@/server/services/exception-occurrences', () => ({
  ExceptionOccurrencesService: { syncOrg },
}));

import { GET, maxDuration } from './route';

function req(auth?: string): NextRequest {
  return new Request('https://test.local/api/cron/exception-occurrences', {
    headers: auth ? { authorization: auth } : {},
  }) as unknown as NextRequest;
}

function orgsStub(opts: {
  orgs: string[];
  synced?: Record<string, string>;
  stateError?: boolean;
  created?: Record<string, string>;
  attempts?: Record<string, { at: string; failures?: number }>;
  attemptsReadError?: boolean;
  attemptsWriteError?: boolean;
}) {
  const stub = makeSupabaseStub({
    'organizations.select': {
      data: opts.orgs.map((id) =>
        opts.created?.[id] ? { id, created_at: opts.created[id] } : { id },
      ),
      error: null,
    },
    'cron_sweep_attempts.select': opts.attemptsReadError
      ? { data: null, error: { message: 'attempts read failed' } }
      : {
          data: Object.entries(opts.attempts ?? {}).map(([organization_id, a]) => ({
            organization_id,
            last_attempt_at: a.at,
            consecutive_failures: a.failures ?? 0,
          })),
          error: null,
        },
    'cron_sweep_attempts.insert': opts.attemptsWriteError
      ? { data: null, error: { message: 'attempts write failed' } }
      : { data: null, error: null },
    'exception_sync_state.select': opts.stateError
      ? { data: null, error: { message: 'boom' } }
      : {
          data: Object.entries(opts.synced ?? {}).map(([organization_id, last_synced_at]) => ({
            organization_id,
            last_synced_at,
          })),
          error: null,
        },
  });
  adminHolder.client = stub.client;
  return stub;
}

const APPLIED = { status: 'applied', raised: 0, seen: 0, resolved: 0, recountsClosed: 0, dropped: 0, factsOmitted: 0, settled: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  envHolder.env = { CRON_SECRET: 'test-cron-secret' };
  syncOrg.mockResolvedValue(APPLIED);
});

describe('GET /api/cron/exception-occurrences — secret gate', () => {
  it('refuses a missing header', async () => {
    orgsStub({ orgs: ['o1'] });
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(syncOrg).not.toHaveBeenCalled();
  });

  it('refuses a wrong secret of the same length', async () => {
    orgsStub({ orgs: ['o1'] });
    const res = await GET(req('Bearer test-cron-secreT'));
    expect(res.status).toBe(401);
    expect(syncOrg).not.toHaveBeenCalled();
  });

  it('fails closed with 503 when CRON_SECRET is not configured', async () => {
    envHolder.env = {};
    orgsStub({ orgs: ['o1'] });
    const res = await GET(req('Bearer '));
    expect(res.status).toBe(503);
    expect(syncOrg).not.toHaveBeenCalled();
  });
});

describe('GET /api/cron/exception-occurrences — the sweep', () => {
  it('syncs every org, unforced, least recently reached first: a never-synced org by its creation time', async () => {
    // The order used to be tiers (due, never synced, failing, recent), and an
    // org not synced for over an hour waited behind every due org. Now one
    // line: the later of the last sync and the last attempt, oldest first.
    const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
    orgsStub({
      orgs: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      synced: {
        a: minutesAgo(16),
        b: minutesAgo(31),
        d: minutesAgo(2), // synced just now (a posted count)
        e: minutesAgo(24 * 60), // not synced for a day: failing run after run
        g: minutesAgo(90),
      },
      created: {
        c: minutesAgo(3 * 24 * 60), // never synced, created three days ago
        f: minutesAgo(5), // never synced, created five minutes ago
      },
    });
    const res = await GET(req('Bearer test-cron-secret'));
    expect(res.status).toBe(200);
    expect(syncOrg.mock.calls.map((c) => c[0])).toEqual(['c', 'e', 'g', 'b', 'a', 'f', 'd']);
    for (const call of syncOrg.mock.calls) expect(call[1]).toEqual({ reason: 'cron' });
    expect(await res.json()).toMatchObject({ orgs: 7, processed: 7, deferredForTime: 0, applied: 7 });
  });

  it('sums the settled count (lines held because they were confirmed, 0386) over the orgs applied, for the log', async () => {
    orgsStub({ orgs: ['a', 'b', 'c'] });
    syncOrg
      .mockResolvedValueOnce({ ...APPLIED, settled: 2 })
      .mockResolvedValueOnce({ status: 'busy' })
      .mockResolvedValueOnce({ ...APPLIED, settled: 1 });
    const res = await GET(req('Bearer test-cron-secret'));
    expect(await res.json()).toMatchObject({ processed: 3, applied: 2, busy: 1, settled: 3 });
  });

  it('orgs that never complete a sync cannot use up the budget ahead of due ones', async () => {
    // Before: never-synced orgs sorted first (epoch 0), so a set of orgs that
    // always fail (no owner or admin, a persistent RPC error) led every run.
    // Mutation caught: ordering by last success alone.
    orgsStub({
      orgs: ['n1', 'n2', 'due'],
      synced: { due: new Date(Date.now() - 20 * 60_000).toISOString() },
    });
    let now = 1_000_000;
    const realNow = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now + realNow);
    syncOrg.mockImplementation(async () => {
      now += 30_000;
      return { status: 'no_system_actor' };
    });
    const res = await GET(req('Bearer test-cron-secret'));
    expect(syncOrg.mock.calls.map((c) => c[0])).toEqual(['due', 'n1']);
    expect(await res.json()).toMatchObject({ processed: 2, deferredForTime: 1 });
    vi.mocked(Date.now).mockRestore();
  });

  it('one failing org does not stop the rest, and the tally says so', async () => {
    orgsStub({ orgs: ['a', 'b', 'c'] });
    syncOrg
      .mockResolvedValueOnce(APPLIED)
      .mockResolvedValueOnce({ status: 'failed' })
      .mockResolvedValueOnce({ status: 'throttled', lastSyncedAt: '2026-09-24T18:00:00Z' });
    const res = await GET(req('Bearer test-cron-secret'));
    expect(res.status).toBe(200);
    expect(syncOrg).toHaveBeenCalledTimes(3);
    expect(await res.json()).toMatchObject({ processed: 3, applied: 1, failed: 1, throttled: 1 });
  });

  it('even a sync that THROWS does not stop the sweep (syncOrg promises never to; the route does not rely on it)', async () => {
    orgsStub({ orgs: ['a', 'b'] });
    syncOrg.mockRejectedValueOnce(new Error('unexpected')).mockResolvedValueOnce(APPLIED);
    const res = await GET(req('Bearer test-cron-secret'));
    expect(res.status).toBe(200);
    expect(syncOrg.mock.calls.map((c) => c[0])).toEqual(['a', 'b']);
    expect(await res.json()).toMatchObject({ processed: 2, applied: 1, failed: 1 });
    const tags = reportError.mock.calls.map((c) => (c as unknown as [unknown, { tag: string }])[1].tag);
    expect(tags).toEqual(['exceptions.sync_failed']);
  });

  it('a failed ordering read still sweeps every org, in id order', async () => {
    orgsStub({ orgs: ['a', 'b'], stateError: true });
    const res = await GET(req('Bearer test-cron-secret'));
    expect(res.status).toBe(200);
    expect(syncOrg.mock.calls.map((c) => c[0])).toEqual(['a', 'b']);
  });

  it('stops STARTING orgs at the soft deadline and reports how many it left', async () => {
    orgsStub({ orgs: ['a', 'b', 'c'] });
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    syncOrg.mockImplementation(async () => {
      now += 30_000; // each org takes 30 s
      return APPLIED;
    });
    const res = await GET(req('Bearer test-cron-secret'));
    expect(res.status).toBe(200);
    // a starts at 0 s, b at 30 s, c would start at 60 s: past the 45 s deadline.
    expect(syncOrg.mock.calls.map((c) => c[0])).toEqual(['a', 'b']);
    expect(await res.json()).toMatchObject({ processed: 2, deferredForTime: 1 });
    const tags = reportError.mock.calls.map((c) => (c as unknown as [unknown, { tag: string }])[1].tag);
    expect(tags).toContain('cron.exception-occurrences.deadline');
    vi.mocked(Date.now).mockRestore();
  });

  it('the hard limit leaves the org in flight minutes past the 45 s deadline to finish', () => {
    // The deadline stops orgs from STARTING; b above ran from 30 s to 60 s,
    // which at maxDuration 60 was the uncatchable kill. Mutation caught:
    // maxDuration back at 60.
    expect(maxDuration * 1000 - 45_000).toBeGreaterThanOrEqual(4 * 60_000);
  });
});

describe('GET /api/cron/exception-occurrences — attempts and rotation (0492)', () => {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const upserts = (stub: ReturnType<typeof orgsStub>) =>
    (stub.chainArgsAll.get('cron_sweep_attempts.insert') ?? []).map((args) => ({
      row: args[0]![0] as {
        job: string;
        organization_id: string;
        last_attempt_at: string;
        consecutive_failures?: number;
      },
      opts: args[0]![1] as { onConflict?: string },
    }));

  it('an org the cron tried but could not sync goes behind one synced earlier', async () => {
    orgsStub({
      orgs: ['x', 'y'],
      synced: { x: minutesAgo(30), y: minutesAgo(20) },
      attempts: { x: { at: minutesAgo(1), failures: 1 } },
    });
    await GET(req('Bearer test-cron-secret'));
    expect(syncOrg.mock.calls.map((c) => c[0])).toEqual(['y', 'x']);
  });

  it('records each attempt as the org starts (an upsert on organization_id), and none for an org the deadline left', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-17T12:00:00.000Z'));
    const stub = orgsStub({ orgs: ['a', 'b', 'c', 'd'] });
    const startedAt: Record<string, string> = {};
    syncOrg.mockImplementation(async (orgId: string) => {
      startedAt[orgId] = new Date().toISOString();
      vi.setSystemTime(Date.now() + 20_000);
      return APPLIED;
    });
    const res = await GET(req('Bearer test-cron-secret'));
    // Three at once: a at 0 s, b at 20 s, c at 40 s; d would start at 60 s.
    expect(syncOrg.mock.calls.map((c) => c[0])).toEqual(['a', 'b', 'c']);
    expect(await res.json()).toMatchObject({ processed: 3, deferredForTime: 1 });
    const written = upserts(stub);
    expect(written.map((w) => w.row.organization_id)).toEqual(['a', 'b', 'c']);
    for (const w of written) {
      expect(w.opts).toEqual({ onConflict: 'job,organization_id' });
      expect(w.row.job).toBe('exception_sync');
      // Stamped when the org started, before its sync ran.
      expect(w.row.last_attempt_at).toBe(startedAt[w.row.organization_id]);
      expect(w.row.consecutive_failures).toBeUndefined();
    }
  });

  it('counts attempts in a row that end without a sync, resets after a sync, leaves busy alone, and logs the repeated ones', async () => {
    const stub = orgsStub({
      orgs: ['org-ok', 'org-busy', 'org-none', 'org-fail'],
      attempts: {
        'org-ok': { at: minutesAgo(15), failures: 4 },
        'org-busy': { at: minutesAgo(15), failures: 2 },
        'org-none': { at: minutesAgo(15), failures: 2 },
        'org-fail': { at: minutesAgo(15) },
      },
    });
    syncOrg.mockImplementation(async (orgId: string) =>
      orgId === 'org-ok'
        ? APPLIED
        : orgId === 'org-busy'
          ? { status: 'busy' }
          : orgId === 'org-none'
            ? { status: 'no_system_actor' }
            : { status: 'failed' },
    );
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await GET(req('Bearer test-cron-secret'));
    const counts = Object.fromEntries(
      upserts(stub)
        .filter((w) => w.row.consecutive_failures !== undefined)
        .map((w) => [w.row.organization_id, w.row.consecutive_failures]),
    );
    expect(counts).toEqual({ 'org-ok': 0, 'org-none': 3, 'org-fail': 1 });
    const line = info.mock.calls.find((c) => c[0] === '[cron.exception-occurrences]');
    expect(JSON.parse(String(line?.[1]))).toMatchObject({ failingRepeatedly: 1, applied: 1, busy: 1 });
    expect(String(line?.[1])).not.toMatch(/org-/);
    info.mockRestore();
  });

  it('a failed attempt write never stops a sync, and is reported once per run', async () => {
    orgsStub({ orgs: ['a', 'b', 'c'], attemptsWriteError: true });
    const res = await GET(req('Bearer test-cron-secret'));
    expect(syncOrg.mock.calls.map((c) => c[0])).toEqual(['a', 'b', 'c']);
    expect(await res.json()).toMatchObject({ processed: 3, applied: 3 });
    const tags = reportError.mock.calls.map((c) => (c as unknown as [unknown, { tag: string }])[1].tag);
    expect(tags).toEqual(['cron.exception-occurrences.attempts']);
  });

  it('a failed attempts read still sweeps every org, by last sync, and is reported', async () => {
    orgsStub({
      orgs: ['a', 'b'],
      synced: { a: minutesAgo(20), b: minutesAgo(40) },
      attemptsReadError: true,
    });
    await GET(req('Bearer test-cron-secret'));
    expect(syncOrg.mock.calls.map((c) => c[0])).toEqual(['b', 'a']);
    const tags = reportError.mock.calls.map((c) => (c as unknown as [unknown, { tag: string }])[1].tag);
    expect(tags).toEqual(['cron.exception-occurrences.attempts']);
  });

  it('runs at most three orgs at once', async () => {
    orgsStub({ orgs: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] });
    let inFlight = 0;
    let most = 0;
    syncOrg.mockImplementation(async () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return APPLIED;
    });
    const res = await GET(req('Bearer test-cron-secret'));
    expect(await res.json()).toMatchObject({ processed: 7, applied: 7 });
    expect(most).toBe(3);
  });

  it('over consecutive runs every org is reached, failing and never-synced ones included', async () => {
    // 20 orgs, three syncs per run (each takes 15 s; the deadline is 45 s).
    // 12 are healthy, 5 never get a sync (no owner or admin) and were last
    // synced two days ago, 3 are new. Under the old tiers the healthy due orgs
    // filled every run, so the 5 never got another attempt and the 3 new ones
    // waited behind every due org.
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = new Date('2026-11-17T12:00:00.000Z').getTime();
    vi.setSystemTime(t0);
    const healthy = Array.from({ length: 12 }, (_, i) => `h${String(i).padStart(2, '0')}`);
    const failing = ['f0', 'f1', 'f2', 'f3', 'f4'];
    const fresh = ['n0', 'n1', 'n2'];
    const all = [...healthy, ...failing, ...fresh].sort();
    const synced = new Map<string, string>([
      ...healthy.map((id, i) => [id, new Date(t0 - (20 + i) * 60_000).toISOString()] as const),
      ...failing.map((id) => [id, new Date(t0 - 2 * 24 * 60 * 60_000).toISOString()] as const),
    ]);
    const attempts = new Map<string, { last_attempt_at: string; consecutive_failures: number }>();
    const stub = makeSupabaseStub({
      'organizations.select': {
        data: all.map((id) => ({
          id,
          created_at: fresh.includes(id)
            ? new Date(t0 - 45 * 60_000).toISOString()
            : '2026-01-01T00:00:00.000Z',
        })),
        error: null,
      },
      'exception_sync_state.select': () => ({
        data: [...synced].map(([organization_id, last_synced_at]) => ({ organization_id, last_synced_at })),
        error: null,
      }),
      'cron_sweep_attempts.select': () => ({
        data: [...attempts].map(([organization_id, a]) => ({ organization_id, ...a })),
        error: null,
      }),
      'cron_sweep_attempts.insert': (call) => {
        const row = call.args[call.methods.indexOf('upsert')]![0] as {
          organization_id: string;
          last_attempt_at: string;
          consecutive_failures?: number;
        };
        const prev = attempts.get(row.organization_id);
        attempts.set(row.organization_id, {
          last_attempt_at: row.last_attempt_at,
          consecutive_failures: row.consecutive_failures ?? prev?.consecutive_failures ?? 0,
        });
        return { data: null, error: null };
      },
    });
    adminHolder.client = stub.client;
    syncOrg.mockImplementation(async (orgId: string) => {
      vi.setSystemTime(Date.now() + 15_000);
      if (failing.includes(orgId)) return { status: 'no_system_actor' };
      synced.set(orgId, new Date().toISOString());
      return APPLIED;
    });
    vi.spyOn(console, 'info').mockImplementation(() => {});

    const reachedInRun = new Map<string, number>();
    const timesReached = new Map<string, number>();
    const runs = Math.ceil(all.length / 3); // 7
    for (let run = 0; run < runs; run += 1) {
      vi.setSystemTime(t0 + run * 15 * 60_000);
      syncOrg.mockClear();
      await GET(req('Bearer test-cron-secret'));
      expect(syncOrg).toHaveBeenCalledTimes(3);
      for (const c of syncOrg.mock.calls) {
        const id = c[0] as string;
        if (!reachedInRun.has(id)) reachedInRun.set(id, run);
        timesReached.set(id, (timesReached.get(id) ?? 0) + 1);
      }
    }
    expect([...reachedInRun.keys()].sort()).toEqual(all);
    // The failing orgs, whose last sync is oldest, went first; the new ones
    // (created 45 minutes before the first run) came next, before the healthy
    // orgs synced 20 to 31 minutes before it.
    expect(failing.map((id) => reachedInRun.get(id))).toEqual([0, 0, 0, 1, 1]);
    expect(fresh.map((id) => reachedInRun.get(id))).toEqual([1, 2, 2]);
    // Each failing org carries its attempts in a row without a sync.
    for (const id of failing) {
      expect(attempts.get(id)?.consecutive_failures).toBe(timesReached.get(id));
    }
  });
});

// L102: on success the cron logged nothing; its counts were only in the
// response body. It now writes one summary line per run (counts only), and the
// body carries raised and resolved too.
describe('GET /api/cron/exception-occurrences — one log line per run (L102)', () => {
  it('logs exactly one line with the summed counts and the time taken, and returns raised and resolved', async () => {
    orgsStub({ orgs: ['o1', 'o2', 'o3'] });
    syncOrg
      .mockResolvedValueOnce({ ...APPLIED, raised: 2, resolved: 1, recountsClosed: 1, settled: 3 })
      .mockResolvedValueOnce({ status: 'throttled', lastSyncedAt: '2026-10-05T00:00:00Z' })
      .mockResolvedValueOnce({ ...APPLIED, raised: 1, resolved: 4, recountsClosed: 0, settled: 0 });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    const res = await GET(req('Bearer test-cron-secret'));
    const body = (await res.json()) as Record<string, number>;

    expect(body).toMatchObject({ raised: 3, resolved: 5, settled: 3, applied: 2, throttled: 1 });
    const lines = info.mock.calls.filter((args: unknown[]) => args[0] === '[cron.exception-occurrences]');
    expect(lines).toHaveLength(1);
    const logged = JSON.parse(String(lines[0]?.[1])) as Record<string, unknown>;
    expect(logged).toMatchObject({
      orgs: 3,
      processed: 3,
      raised: 3,
      resolved: 5,
      recountsClosed: 1,
      settled: 3,
      applied: 2,
      throttled: 1,
    });
    expect(typeof logged.ms).toBe('number');
    // Counts only: no org ids.
    expect(String(lines[0]?.[1])).not.toMatch(/o1|o2|o3/);
  });
});

describe('the cron imports the shared helpers', () => {
  it('uses the shared secretsEqual and pastes no copy of either helper', () => {
    // The daily-briefing guard caps the route copies (6 and 19, both at their
    // caps); a new cron must import server/services/lib/system-context.ts.
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'route.ts'), 'utf8');
    expect(src).toMatch(/import \{ secretsEqual \} from '@\/server\/services\/lib\/system-context'/);
    expect(src).not.toMatch(/function\s+secretsEqual\s*\(/);
    expect(src).not.toMatch(/function\s+buildSystemContext\s*\(/);
  });
});
