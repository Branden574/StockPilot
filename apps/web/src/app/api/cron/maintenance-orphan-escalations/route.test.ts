// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
 * EACH organization on its own with the service role, under its own cap, so
 * one organization's requests (any member can type "Ref EX-" into one) can
 * never hide another organization's unlinked request. It runs only for the
 * cron's Bearer CRON_SECRET (constant-time compare) and FAILS CLOSED when the
 * secret is unset; it only reads (no insert, update, delete or RPC); its one
 * alert per run names each request by id, handle and EX reference and its
 * organization by id, in the text the alerts channel receives, never its
 * subject, description or requester; an organization that reached its cap,
 * or that the run did not reach, is named in one error alert; and a failed
 * read in any organization answers 500 with no alert about requests, never
 * "nothing found" (a failed link read would otherwise make every request
 * look unlinked).
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

import { GET, maxDuration } from './route';

const NOW = Date.parse('2026-10-25T15:20:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
/** More "Ref EX-" requests than the one read across every organization used
 *  to take (1,000), and more than one organization's cap. */
const FLOOD = 1005;

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

/** `count` live "Ref EX-" requests in `org`, oldest first (index 0 is the
 *  oldest), all about 62 hours old: inside the window, and older than the
 *  one-hour-old requests the tests put in other organizations. */
function flood(org: string, count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_v, i) =>
    request({
      id: `${org}-${String(i).padStart(4, '0')}`,
      organization_id: org,
      request_number: 1000 + i,
      created_at: ago(62 * HOUR - i * 1000),
    }),
  );
}

const linksTo = (rows: Array<Record<string, unknown>>) =>
  rows.map((r) => ({ maintenance_request_id: r.id as string }));

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

/** The value of the chain's `.eq(column, value)`, or undefined. */
function eqValue(methods: string[], args: unknown[][], column: string): unknown {
  const at = methods.findIndex((m, i) => m === 'eq' && args[i]?.[0] === column);
  return at === -1 ? undefined : args[at]?.[1];
}

interface World {
  /** Every organization on the platform. Default: org-a, and each one a
   *  request belongs to. */
  orgs?: string[];
  requests?: Array<Record<string, unknown>>;
  links?: Array<{ maintenance_request_id: string | null }>;
  fail?: { orgs?: boolean; requestsOf?: string; links?: boolean };
  /** Runs as each request read is answered, with the organization it asked for. */
  onRequestRead?: (organizationId: unknown) => void;
}

function setup({ orgs, requests = [], links = [], fail = {}, onRequestRead }: World = {}) {
  const orgIds = orgs ?? [
    ...new Set(['org-a', ...requests.map((r) => r.organization_id as string)]),
  ];
  const served = servedWithLike(requests);
  const stub = makeSupabaseStub({
    'organizations.select': fail.orgs
      ? { data: null, error: { message: 'boom' } }
      : servedLikePostgrest(orgIds.map((id) => ({ id }))),
    'maintenance_requests.select': (call) => {
      const org = eqValue(call.methods, call.args, 'organization_id');
      onRequestRead?.(org);
      if (fail.requestsOf !== undefined && org === fail.requestsOf) {
        return { data: null, error: { message: 'boom' } };
      }
      return served(call);
    },
    'exception_occurrences.select': (call) => {
      if (fail.links) return { data: null, error: { message: 'boom' } };
      const ids = inFilters(call).find(([c]) => c === 'maintenance_request_id')?.[1] ?? [];
      return { data: links.filter((l) => ids.includes(l.maintenance_request_id)), error: null };
    },
  });
  h.admin = stub.client;
  return stub;
}

/** The organization each request read asked for, in the order they were made. */
function requestReadOrgs(stub: ReturnType<typeof setup>): unknown[] {
  const chains = stub.chainsAll.get('maintenance_requests.select') ?? [];
  const args = stub.chainArgsAll.get('maintenance_requests.select') ?? [];
  return chains.map((chain, i) => eqValue(chain, args[i] ?? [], 'organization_id'));
}

function req(auth?: string): Request {
  return new Request('https://test.local/api/cron/maintenance-orphan-escalations', {
    headers: auth === undefined ? {} : { authorization: auth },
  });
}
const AUTH = 'Bearer test-cron-secret';

type Report = [
  Error,
  {
    tag: string;
    level?: string;
    organizationId?: string | null;
    extra?: Record<string, unknown>;
  },
];
const reports = (tag: string) =>
  (h.reportError.mock.calls as unknown as Report[]).filter(([, c]) => c.tag === tag);
/** The run's alert about unlinked requests. */
const orphanAlerts = () => reports('exceptions.escalate_orphan_detected');
/** The run's alert that it did not read everything. */
const incompleteAlerts = () => reports('cron.maintenance-orphan-escalations.incomplete');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  h.env = { CRON_SECRET: 'test-cron-secret' };
  h.reportError.mockReset();
  h.reportError.mockImplementation(async () => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GET /api/cron/maintenance-orphan-escalations: the cron secret', () => {
  it('refuses a request with no Authorization header, reading nothing', async () => {
    const stub = setup({ requests: [request()] });
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(stub.fromCalls).toEqual([]);
  });

  it('refuses a wrong secret', async () => {
    const stub = setup({ requests: [request()] });
    const res = await GET(req('Bearer not-the-secret'));
    expect(res.status).toBe(401);
    expect(stub.fromCalls).toEqual([]);
  });

  it('FAILS CLOSED when CRON_SECRET is unset (even for an empty Bearer)', async () => {
    h.env = {};
    const stub = setup({ requests: [request()] });
    for (const auth of [undefined, 'Bearer ', 'Bearer undefined']) {
      const res = await GET(req(auth));
      expect(res.status).toBe(401);
    }
    expect(stub.fromCalls).toEqual([]);
  });
});

describe('GET /api/cron/maintenance-orphan-escalations: what it finds', () => {
  it('sends one alert naming a live escalation request no exception links, by handle, EX reference, request id and organization id only', async () => {
    setup({
      requests: [request(), request({ id: 'mr-linked', request_number: 13 })],
      links: [{ maintenance_request_id: 'mr-linked' }],
    });

    const res = await GET(req(AUTH));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      complete: true,
      organizations: 1,
      read: 1,
      candidates: 2,
      orphans: 1,
      reported: 1,
      capped: [],
      notRead: [],
    });
    expect(orphanAlerts()).toHaveLength(1);
    const [err, ctx] = orphanAlerts()[0]!;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe(
      [
        '1 maintenance request saved by an exception escalation is linked to no exception. Tell its requester, who can cancel it.',
        'Organization org-a: 1 unlinked',
        `  MR-2026-000012 for EX-000045: request mr-orphan, created ${ago(2 * HOUR)}`,
      ].join('\n'),
    );
    expect(ctx).toEqual({
      tag: 'exceptions.escalate_orphan_detected',
      level: 'warning',
      extra: { orphans: 1, listed: 1 },
    });
    expect(incompleteAlerts()).toHaveLength(0);
    // Nothing a person typed reaches an alert: not the subject, not the
    // description (only its EX reference, which the system wrote).
    const sent = JSON.stringify(
      (h.reportError.mock.calls as unknown as Report[]).map(([e, c]) => [e.message, c]),
    );
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
    setup({ requests: [request(over)] });
    const res = await GET(req(AUTH));
    expect(res.status).toBe(200);
    expect(orphanAlerts()).toHaveLength(0);
  });

  it('reads every organization on its own with the service role: no write and no RPC', async () => {
    const stub = setup({ orgs: ['org-a', 'org-b', 'org-c'], requests: [request()] });

    await GET(req(AUTH));

    expect([...stub.chainsAll.keys()].sort()).toEqual([
      'exception_occurrences.select',
      'maintenance_requests.select',
      'organizations.select',
    ]);
    expect(stub.rpcCalls).toEqual([]);
    // One request read per organization, each filtered to it.
    expect(requestReadOrgs(stub).sort()).toEqual(['org-a', 'org-b', 'org-c']);
    // The coarse cut is made by the database, not after reading every live
    // request (the number check then runs on what came back).
    const chains = stub.chainsAll.get('maintenance_requests.select')!;
    const args = stub.chainArgsAll.get('maintenance_requests.select')!;
    chains.forEach((chain, i) => {
      expect(args[i]![chain.indexOf('like')]).toEqual(['description', '%Ref EX-%']);
    });
  });

  it('reads every organization whatever its modules: a request outlives a module turned off', async () => {
    const stub = setup({
      orgs: ['org-a', 'org-off'],
      requests: [request({ organization_id: 'org-off' })],
    });

    await GET(req(AUTH));

    expect(stub.fromCalls).not.toContain('organization_modules');
    expect(orphanAlerts()[0]![0].message).toContain('Organization org-off: 1 unlinked');
  });

  it(`lists at most ${ORPHAN_SWEEP.maxReports} requests in its one alert, oldest first, and counts the rest`, async () => {
    setup({ requests: flood('org-a', ORPHAN_SWEEP.maxReports + 5) });

    const res = await GET(req(AUTH));

    expect(await res.json()).toMatchObject({
      orphans: ORPHAN_SWEEP.maxReports + 5,
      reported: ORPHAN_SWEEP.maxReports,
    });
    expect(orphanAlerts()).toHaveLength(1);
    const [err, ctx] = orphanAlerts()[0]!;
    const lines = err.message.split('\n');
    expect(lines[0]).toBe(
      `${ORPHAN_SWEEP.maxReports + 5} maintenance requests saved by an exception escalation are linked to no exception. Tell each requester, who can cancel it.`,
    );
    expect(lines[1]).toBe(
      `Organization org-a: ${ORPHAN_SWEEP.maxReports + 5} unlinked, the oldest ${ORPHAN_SWEEP.maxReports} listed`,
    );
    expect(lines.slice(2)).toHaveLength(ORPHAN_SWEEP.maxReports);
    expect(lines[2]).toContain('request org-a-0000,');
    expect(ctx.extra).toEqual({
      orphans: ORPHAN_SWEEP.maxReports + 5,
      listed: ORPHAN_SWEEP.maxReports,
    });
  });

  it("lists each organization's requests in turn, so one organization's cannot crowd another's out", async () => {
    setup({ requests: [...flood('org-a', 40), request({ id: 'mr-b', organization_id: 'org-b' })] });

    await GET(req(AUTH));

    const message = orphanAlerts()[0]![0].message;
    expect(message).toContain(
      'Organization org-b: 1 unlinked\n  MR-2026-000012 for EX-000045: request mr-b,',
    );
    expect(message).toContain(
      `Organization org-a: 40 unlinked, the oldest ${ORPHAN_SWEEP.maxReports - 1} listed`,
    );
  });

  it('names every organization with an unlinked request, also past what the alert lists', async () => {
    const orgs = Array.from(
      { length: ORPHAN_SWEEP.maxReports + 2 },
      (_v, i) => `org-${String(i).padStart(2, '0')}`,
    );
    setup({
      orgs,
      requests: orgs.map((org) => request({ id: `mr-${org}`, organization_id: org })),
    });

    const res = await GET(req(AUTH));

    expect(await res.json()).toMatchObject({
      orphans: orgs.length,
      reported: ORPHAN_SWEEP.maxReports,
    });
    const message = orphanAlerts()[0]![0].message;
    for (const org of orgs) expect(message).toContain(org);
    expect(message).toMatch(
      /\n2 more organizations have 2 unlinked, not listed: org-\d\d, org-\d\d$/,
    );
  });
});

describe("GET /api/cron/maintenance-orphan-escalations: one organization's requests cannot hide another's", () => {
  it.each([
    ['all linked', true],
    ['none linked (typed by hand)', false],
  ])(
    `a flood of ${FLOOD} older "Ref EX-" requests in one organization, %s, does not hide another organization's unlinked request`,
    async (_label, linked) => {
      const crowd = flood('org-a', FLOOD);
      setup({
        requests: [
          ...crowd,
          request({ id: 'mr-b-orphan', organization_id: 'org-b', created_at: ago(HOUR) }),
        ],
        links: linked ? linksTo(crowd) : [],
      });

      const res = await GET(req(AUTH));

      expect(res.status).toBe(200);
      const told = orphanAlerts()
        .map(([e, c]) => `${e.message} ${JSON.stringify(c)}`)
        .join('\n');
      expect(told).toContain('mr-b-orphan');
      expect(orphanAlerts()).toHaveLength(1);
      expect(orphanAlerts()[0]![0].message).toContain(
        `Organization org-b: 1 unlinked\n  MR-2026-000012 for EX-000045: request mr-b-orphan, created ${ago(HOUR)}`,
      );
    },
  );

  it('names an organization that reached its cap in one error alert, with how many it read and where the read stopped; the summary carries the same list', async () => {
    const crowd = flood('org-a', FLOOD);
    setup({
      requests: [
        ...crowd,
        request({ id: 'mr-b-orphan', organization_id: 'org-b', created_at: ago(HOUR) }),
      ],
      links: linksTo(crowd),
    });

    const res = await GET(req(AUTH));

    const namedInError = (h.reportError.mock.calls as unknown as Report[]).filter(
      ([e, c]) => c.level === 'error' && e.message.includes('org-a'),
    );
    expect(namedInError).toHaveLength(1);
    const cap = ORPHAN_SWEEP.maxCandidatesPerOrg;
    const stoppedAt = crowd[cap - 1]!.created_at as string;
    expect(await res.json()).toMatchObject({
      complete: false,
      capped: [{ organizationId: 'org-a', candidates: cap, stoppedAt }],
      notRead: [],
    });
    expect(incompleteAlerts()).toHaveLength(1);
    const [err, ctx] = incompleteAlerts()[0]!;
    expect(ctx).toEqual({
      tag: 'cron.maintenance-orphan-escalations.incomplete',
      level: 'error',
      extra: { capped: 1, notRead: 0 },
    });
    expect(err.message).toContain(`Organization org-a: ${cap} read, the last created ${stoppedAt}`);
    expect(err.message).not.toContain('org-b');
    // The other organization was read whole, and its request reported.
    expect(orphanAlerts()[0]![0].message).toContain('request mr-b-orphan,');
  });

  it('reads an organization with exactly the cap whole, and does not call it capped', async () => {
    const crowd = flood('org-a', ORPHAN_SWEEP.maxCandidatesPerOrg);
    setup({ requests: crowd, links: linksTo(crowd) });

    const res = await GET(req(AUTH));

    expect(await res.json()).toMatchObject({
      complete: true,
      candidates: ORPHAN_SWEEP.maxCandidatesPerOrg,
      capped: [],
    });
    expect(incompleteAlerts()).toHaveLength(0);
  });

  it('asks any one organization for at most one request past its cap', async () => {
    const stub = setup({ requests: flood('org-a', FLOOD) });

    await GET(req(AUTH));

    const chains = stub.chainsAll.get('maintenance_requests.select')!;
    const args = stub.chainArgsAll.get('maintenance_requests.select')!;
    expect(chains).toHaveLength(1);
    const [from, to] = args[0]![chains[0]!.indexOf('range')] as [number, number];
    expect(to - from + 1).toBe(ORPHAN_SWEEP.maxCandidatesPerOrg + 1);
  });
});

describe("GET /api/cron/maintenance-orphan-escalations: the run's time limit", () => {
  it('names the organizations it did not start before its deadline, in the error alert and the summary, and never reads them', async () => {
    const orgs = Array.from({ length: ORPHAN_SWEEP.orgConcurrency + 3 }, (_v, i) => `org-${i}`);
    const stub = setup({
      orgs,
      // The first answer arrives after the deadline.
      onRequestRead: () => vi.setSystemTime(NOW + ORPHAN_SWEEP.deadlineMs + 1),
    });

    const res = await GET(req(AUTH));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { complete: boolean; read: number; notRead: string[] };
    expect(body.complete).toBe(false);
    expect(body.read).toBe(ORPHAN_SWEEP.orgConcurrency);
    expect(body.notRead).toHaveLength(3);
    // Each organization was either read or named as not read, never both.
    expect([...requestReadOrgs(stub), ...body.notRead].sort()).toEqual([...orgs].sort());
    expect(incompleteAlerts()).toHaveLength(1);
    const [err, ctx] = incompleteAlerts()[0]!;
    expect(ctx.level).toBe('error');
    expect(err.message).toContain(
      `Not read before the run's ${ORPHAN_SWEEP.deadlineMs / 1000}-second limit, 3 organizations: `,
    );
    for (const org of body.notRead) expect(err.message).toContain(org);
  });

  /**
   * Runs the check at `runAt` with the clock moved past its deadline as the
   * `reads`-th organization's request read starts, so the run reads exactly
   * that many organizations, however many it reads at once: an
   * organization's start is checked against the deadline in the same step
   * as its read is made, before the next organization's check.
   */
  async function runCutShort(orgs: string[], runAt: number, reads: number) {
    vi.setSystemTime(runAt);
    h.reportError.mockClear();
    const stub = setup({ orgs });
    const from = stub.client.from.bind(stub.client) as (table: string) => unknown;
    let started = 0;
    stub.client.from = vi.fn((table: string) => {
      if (table === 'maintenance_requests') {
        started += 1;
        if (started === reads) vi.setSystemTime(runAt + ORPHAN_SWEEP.deadlineMs + 1);
      }
      return from(table);
    });
    const res = await GET(req(AUTH));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { read: number; notRead: string[] };
    return { read: requestReadOrgs(stub) as string[], body };
  }

  // At least twice the organizations read at once, so a run cut short can
  // read fewer than half of them: an order that only alternates between two
  // directions then never reads the middle ones.
  it.each([
    [2 * ORPHAN_SWEEP.orgConcurrency, 1],
    [2 * ORPHAN_SWEEP.orgConcurrency + 3, 1],
    [2 * ORPHAN_SWEEP.orgConcurrency + 3, ORPHAN_SWEEP.orgConcurrency],
    [2 * ORPHAN_SWEEP.orgConcurrency + 3, ORPHAN_SWEEP.orgConcurrency + 1],
  ])(
    'with %i organizations and every run cut short after %i, the runs of that many consecutive days read every organization, and each run names the ones it did not read',
    async (count, reads) => {
      const orgs = Array.from({ length: count }, (_v, i) => `org-${String(i).padStart(2, '0')}`);
      const everRead = new Set<string>();

      for (let day = 0; day < count; day += 1) {
        const { read, body } = await runCutShort(orgs, NOW + day * 24 * HOUR, reads);

        expect(read).toHaveLength(reads);
        expect(body.read).toBe(reads);
        expect([...read, ...body.notRead].sort()).toEqual(orgs);
        // The run's error alert names exactly the organizations it did not read.
        expect(incompleteAlerts()).toHaveLength(1);
        const [err, ctx] = incompleteAlerts()[0]!;
        expect(ctx.level).toBe('error');
        for (const org of body.notRead) expect(err.message).toContain(org);
        for (const org of read) expect(err.message).not.toContain(org);
        for (const org of read) everRead.add(org);
      }

      expect([...everRead].sort()).toEqual(orgs);
    },
  );

  it('gives the reads in flight at the deadline minutes to finish before the function is stopped', () => {
    expect(maxDuration * 1000 - ORPHAN_SWEEP.deadlineMs).toBeGreaterThanOrEqual(4 * 60_000);
  });
});

describe('GET /api/cron/maintenance-orphan-escalations: a failed read alerts nothing about requests', () => {
  it.each([
    ['the organizations read', { orgs: true }, undefined],
    [
      "one organization's request read, while another has an unlinked request",
      { requestsOf: 'org-b' },
      'org-b',
    ],
    ['the link read (every request would look unlinked)', { links: true }, undefined],
  ] as const)(
    '%s fails: 500 with fixed words, one run report, no alert about requests',
    async (_label, fail, named) => {
      setup({
        orgs: ['org-a', 'org-b'],
        requests: [request(), request({ id: 'mr-b', organization_id: 'org-b' })],
        fail,
      });

      const res = await GET(req(AUTH));

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'internal_error' });
      expect(orphanAlerts()).toHaveLength(0);
      expect(h.reportError).toHaveBeenCalledTimes(1);
      const [err, ctx] = (h.reportError.mock.calls as unknown as Report[])[0]!;
      expect(ctx).toMatchObject({ tag: 'cron.maintenance-orphan-escalations' });
      if (named) expect(err.message).toContain(`organization ${named}`);
    },
  );

  it('reads no organization at all: 500, never "nothing found"', async () => {
    setup({ orgs: [], requests: [request()] });

    const res = await GET(req(AUTH));

    expect(res.status).toBe(500);
    expect(orphanAlerts()).toHaveLength(0);
    expect(h.reportError).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/cron/maintenance-orphan-escalations: what the alerts channel receives', () => {
  /** Runs the cron with the real reportError and a Slack incoming webhook
   *  (which takes the text alone), and returns each text posted. */
  async function postedTexts(world: World): Promise<string[]> {
    const real =
      await vi.importActual<typeof import('@/lib/error-reporter')>('@/lib/error-reporter');
    h.reportError.mockImplementation(async (err, context) => {
      await real.reportError(err, context as Parameters<typeof real.reportError>[1]);
      return undefined;
    });
    vi.stubEnv('ERROR_WEBHOOK_URL', 'https://hooks.slack.com/services/T/B/x');
    const fetchSpy = vi.fn(
      async (_url: string, _init: RequestInit) => new Response(null, { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    setup(world);

    const res = await GET(req(AUTH));

    expect(res.status).toBe(200);
    return fetchSpy.mock.calls.map(([, init]) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      expect(Object.keys(body)).toEqual(['text']);
      return body.text as string;
    });
  }

  it('names the request by id, handle and EX reference and its organization by id, once, and nothing a person typed', async () => {
    const texts = await postedTexts({
      orgs: ['org-b-uuid'],
      requests: [request({ id: 'mr-orphan-0000-uuid', organization_id: 'org-b-uuid' })],
    });

    expect(texts).toHaveLength(1);
    const text = texts[0]!;
    expect(text).toContain('exceptions.escalate_orphan_detected');
    expect(text).toContain('mr-orphan-0000-uuid');
    expect(text).toContain('MR-2026-000012');
    expect(text).toContain('EX-000045');
    expect(text).toContain('org-b-uuid');
    // Once: no stack block repeating the message.
    expect(text.split('mr-orphan-0000-uuid')).toHaveLength(2);
    expect(text).not.toContain('Test Widget');
    expect(text).not.toContain('no rack');
  });

  it('names a capped organization, how many it read and where its read stopped', async () => {
    const crowd = flood('org-a-uuid', FLOOD);

    const texts = await postedTexts({
      orgs: ['org-a-uuid'],
      requests: crowd,
      links: linksTo(crowd),
    });

    const error = texts.find((t) => t.startsWith('*ERROR'));
    expect(error).toBeDefined();
    expect(error).toContain('org-a-uuid');
    const cap = ORPHAN_SWEEP.maxCandidatesPerOrg;
    expect(error).toContain(
      `${cap} read, the last created ${crowd[cap - 1]!.created_at as string}`,
    );
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
