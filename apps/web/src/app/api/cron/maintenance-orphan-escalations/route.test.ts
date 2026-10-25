// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  inFilters,
  makeSupabaseStub,
  servedLikePostgrest,
  type MockCall,
  type QueryResult,
} from '@/test/supabase-mock';

/**
 * Security invariant (listed in scripts/security-test.sh): the daily check for
 * maintenance requests an escalation saved but never linked (F1-5; the crash
 * window between the request insert and exception_escalation_finish) reads
 * every organization with the service role. It runs only for the cron's
 * Bearer CRON_SECRET (constant-time compare) and FAILS CLOSED when the secret
 * is unset; it only reads (no insert, update, delete or RPC); each alert names
 * the request by id, handle and its exception's EX reference, never its
 * subject, description or requester; and a failed read answers 500 with no
 * alert at all, never "nothing found" (a failed link read would otherwise
 * make every request look unlinked).
 */

const h = vi.hoisted(() => ({
  env: { CRON_SECRET: 'test-cron-secret' } as { CRON_SECRET?: string },
  reportError: vi.fn(async (_e: unknown, _c: unknown) => undefined),
  admin: null as unknown,
}));
vi.mock('@/lib/env', () => ({
  get env() {
    return h.env;
  },
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: h.reportError }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn(() => h.admin) }));

import { ORPHAN_SWEEP } from '@/server/services/escalation-orphans';

import { GET } from './route';

const NOW = Date.parse('2026-10-25T15:20:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

function request(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'mr-orphan',
    organization_id: 'org-a',
    request_number: 12,
    created_at: ago(2 * HOUR),
    cancelled_at: null,
    archived_at: null,
    resolved_at: null,
    subject: 'Inventory issue: Test Widget (TW-1)',
    description:
      'On hand but on no rack: 5 units unplaced for at least 20 days. Location: Unplaced. Ref EX-000045.',
    ...over,
  };
}

/** servedLikePostgrest, plus the one filter it does not evaluate: `.like()`
 *  with `%` wildcards, applied first, so a missing filter still fails. */
function servedWithLike(rows: Array<Record<string, unknown>>): (call: MockCall) => QueryResult {
  return (call) => {
    const at = call.methods.indexOf('like');
    if (at === -1) return servedLikePostgrest(rows)(call);
    const [col, pattern] = call.args[at] as [string, string];
    const re = new RegExp(
      `^${pattern
        .split('%')
        .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*')}$`,
      's',
    );
    const kept = rows.filter((r) => typeof r[col] === 'string' && re.test(r[col] as string));
    return servedLikePostgrest(kept)({
      ...call,
      methods: call.methods.filter((_m, i) => i !== at),
      args: call.args.filter((_a, i) => i !== at),
    });
  };
}

function setup(
  requests: Array<Record<string, unknown>>,
  links: Array<{ maintenance_request_id: string | null }>,
  fail: { requests?: boolean; links?: boolean } = {},
) {
  const stub = makeSupabaseStub({
    'maintenance_requests.select': fail.requests
      ? { data: null, error: { message: 'boom' } }
      : servedWithLike(requests),
    'exception_occurrences.select': (call) => {
      if (fail.links) return { data: null, error: { message: 'boom' } };
      const ids = inFilters(call).find(([c]) => c === 'maintenance_request_id')?.[1] ?? [];
      return { data: links.filter((l) => ids.includes(l.maintenance_request_id)), error: null };
    },
  });
  h.admin = stub.client;
  return stub;
}

function req(auth?: string): Request {
  return new Request('https://test.local/api/cron/maintenance-orphan-escalations', {
    headers: auth === undefined ? {} : { authorization: auth },
  });
}
const AUTH = 'Bearer test-cron-secret';

/** The alerts this run sent for unlinked requests (not run-level failures). */
function orphanAlerts() {
  return h.reportError.mock.calls.filter(
    ([, c]) => (c as { tag: string }).tag === 'exceptions.escalate_orphan_detected',
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  h.env = { CRON_SECRET: 'test-cron-secret' };
  h.reportError.mockClear();
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

describe('GET /api/cron/maintenance-orphan-escalations: the cron secret', () => {
  it('refuses a request with no Authorization header, reading nothing', async () => {
    const stub = setup([request()], []);
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(stub.fromCalls).toEqual([]);
  });

  it('refuses a wrong secret', async () => {
    const stub = setup([request()], []);
    const res = await GET(req('Bearer not-the-secret'));
    expect(res.status).toBe(401);
    expect(stub.fromCalls).toEqual([]);
  });

  it('FAILS CLOSED when CRON_SECRET is unset (even for an empty Bearer)', async () => {
    h.env = {};
    const stub = setup([request()], []);
    for (const auth of [undefined, 'Bearer ', 'Bearer undefined']) {
      const res = await GET(req(auth));
      expect(res.status).toBe(401);
    }
    expect(stub.fromCalls).toEqual([]);
  });
});

describe('GET /api/cron/maintenance-orphan-escalations: what it finds', () => {
  it('alerts once for a live escalation request no exception links, naming it by id, handle and EX reference only', async () => {
    setup(
      [request(), request({ id: 'mr-linked', request_number: 13 })],
      [{ maintenance_request_id: 'mr-linked' }],
    );

    const res = await GET(req(AUTH));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, candidates: 2, orphans: 1, reported: 1 });
    expect(orphanAlerts()).toHaveLength(1);
    const [err, ctx] = orphanAlerts()[0]!;
    expect(err).toBeInstanceOf(Error);
    expect(ctx).toEqual({
      tag: 'exceptions.escalate_orphan_detected',
      level: 'warning',
      organizationId: 'org-a',
      extra: {
        requestId: 'mr-orphan',
        reference: 'MR-2026-000012',
        exceptionReference: 'EX-000045',
        createdAt: ago(2 * HOUR),
      },
    });
    // Nothing a person typed reaches the alert: not the subject, not the
    // description (only its EX reference, which the system wrote).
    const sent = JSON.stringify(h.reportError.mock.calls);
    expect(sent).not.toContain('Test Widget');
    expect(sent).not.toContain('unplaced');
  });

  it.each([
    ['cancelled', { cancelled_at: ago(HOUR) }],
    ['archived', { archived_at: ago(HOUR) }],
    ['resolved (cannot be cancelled; the work is done)', { resolved_at: ago(HOUR) }],
    [
      'younger than the grace (its escalation may still be linking it)',
      { created_at: ago(5 * MIN) },
    ],
    [
      'older than the look-back (already reported on earlier runs)',
      { created_at: ago(4 * 24 * HOUR) },
    ],
    ['without the prefill reference', { description: 'The sink leaks.' }],
    ['with "Ref EX-" but no number', { description: 'See Ref EX-abc.' }],
  ])('does not alert for a request that is %s', async (_label, over) => {
    setup([request(over)], []);
    const res = await GET(req(AUTH));
    expect(res.status).toBe(200);
    expect(orphanAlerts()).toHaveLength(0);
  });

  it('reads with the service role only: one select per table, no write and no RPC', async () => {
    const stub = setup([request()], []);
    await GET(req(AUTH));
    expect([...stub.chainsAll.keys()].sort()).toEqual([
      'exception_occurrences.select',
      'maintenance_requests.select',
    ]);
    expect(stub.rpcCalls).toEqual([]);
    // The coarse cut is made by the database, not after reading every
    // live request (the number check then runs on what came back).
    const chain = stub.chainsAll.get('maintenance_requests.select')![0]!;
    const args = stub.chainArgsAll.get('maintenance_requests.select')![0]!;
    expect(args[chain.indexOf('like')]).toEqual(['description', '%Ref EX-%']);
  });

  it(`alerts for at most ${ORPHAN_SWEEP.maxReports} requests a run, and says how many more there are`, async () => {
    const many = Array.from({ length: ORPHAN_SWEEP.maxReports + 5 }, (_v, i) =>
      request({
        id: `mr-${String(i).padStart(3, '0')}`,
        request_number: 100 + i,
        created_at: ago(HOUR + i * MIN),
      }),
    );
    setup(many, []);

    const res = await GET(req(AUTH));

    expect(await res.json()).toMatchObject({
      orphans: ORPHAN_SWEEP.maxReports + 5,
      reported: ORPHAN_SWEEP.maxReports,
    });
    expect(orphanAlerts()).toHaveLength(ORPHAN_SWEEP.maxReports);
    const more = h.reportError.mock.calls.filter(
      ([, c]) => (c as { tag: string }).tag === 'cron.maintenance-orphan-escalations.more',
    );
    expect(more).toHaveLength(1);
    expect((more[0]![1] as { extra: Record<string, unknown> }).extra).toEqual({ notReported: 5 });
  });
});

describe('GET /api/cron/maintenance-orphan-escalations: the read bound', () => {
  it('a run that reaches the bound says so, and still checks what it read', async () => {
    const rows = Array.from({ length: ORPHAN_SWEEP.maxCandidates + 3 }, (_v, i) =>
      request({
        id: `mr-${String(i).padStart(4, '0')}`,
        request_number: 1000 + i,
        created_at: ago(HOUR + i * 1000),
      }),
    );
    setup(
      rows,
      rows.map((r) => ({ maintenance_request_id: r.id as string })),
    );

    const res = await GET(req(AUTH));

    expect(await res.json()).toEqual({
      ok: true,
      candidates: ORPHAN_SWEEP.maxCandidates,
      orphans: 0,
      reported: 0,
    });
    expect(orphanAlerts()).toHaveLength(0);
    const bound = h.reportError.mock.calls.filter(
      ([, c]) => (c as { tag: string }).tag === 'cron.maintenance-orphan-escalations.truncated',
    );
    expect(bound).toHaveLength(1);
    expect((bound[0]![1] as { extra: Record<string, unknown> }).extra).toEqual({
      candidates: ORPHAN_SWEEP.maxCandidates,
      bound: ORPHAN_SWEEP.maxCandidates,
    });
  });
});

describe('GET /api/cron/maintenance-orphan-escalations: a failed read alerts nothing', () => {
  it.each([
    ['the request read', { requests: true }],
    ['the link read (every request would look unlinked)', { links: true }],
  ])('%s fails: 500 with fixed words, one run report, no orphan alert', async (_label, fail) => {
    setup([request()], [], fail);

    const res = await GET(req(AUTH));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal_error' });
    expect(orphanAlerts()).toHaveLength(0);
    expect(h.reportError).toHaveBeenCalledTimes(1);
    expect(h.reportError.mock.calls[0]![1]).toMatchObject({
      tag: 'cron.maintenance-orphan-escalations',
    });
  });
});

describe('the schedule', () => {
  it('vercel.json runs the check once a day', () => {
    const vercel = JSON.parse(
      readFileSync(path.resolve(__dirname, '../../../../../vercel.json'), 'utf8'),
    ) as { crons: Array<{ path: string; schedule: string }> };
    const entries = vercel.crons.filter(
      (c) => c.path === '/api/cron/maintenance-orphan-escalations',
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.schedule).toBe(ORPHAN_SWEEP.schedule);
    // One run a day: fixed minute and hour, every day of every month.
    expect(entries[0]!.schedule).toMatch(/^\d{1,2} \d{1,2} \* \* \*$/);
  });

  it('looks back far enough that one or two missed daily runs still find a request', () => {
    expect(ORPHAN_SWEEP.lookbackMs).toBeGreaterThanOrEqual(3 * 24 * HOUR);
  });
});
