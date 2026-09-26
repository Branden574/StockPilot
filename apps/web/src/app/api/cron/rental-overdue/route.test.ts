import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { callArgs, inFilters, makeSupabaseStub, type MockCall } from '@/test/supabase-mock';

import { RENTAL_OVERDUE_SWEEP } from '@stockpilot/core';

/**
 * Overdue-rental reminder cron (S6-A). Security invariant, listed in
 * scripts/security-test.sh: it emails people outside the organization.
 *
 *   - MODULE GATE: only organizations whose explicit `organization_modules`
 *     row for rentals is enabled. It is automation that emails people outside
 *     the organization, so it follows the row and never the comp. A module-off
 *     org's rentals are never read, so never stamped.
 *   - FAILED MODULE READ: 500 and nothing sent (unknown is not "everyone").
 *   - CLAIM, THEN SEND: a guarded update (still out, not yet reminded) that
 *     returns the row only to the run that won it; the email goes out only for
 *     a claimed row. It used to send and then stamp, so overlapping runs could
 *     email the same borrower twice.
 *   - A SEND THAT DID NOT GO OUT GIVES THE CLAIM BACK: the stamp is what the
 *     rental pages print as "Sent <time>", so a refused or failed send clears
 *     it (guarded on the exact value written) for the next run to retry.
 *
 * This repo's supabase mock does not filter rows, so the rentals read answers
 * through a function that applies the `.in('organization_id', …)` filter the
 * way PostgREST would. A route that stops filtering by the allowlist gets
 * every row back and emails the module-off org.
 */

vi.mock('@/lib/env', () => ({
  env: { CRON_SECRET: 'test-cron-secret' },
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));

const adminHolder = { client: null as unknown };
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => adminHolder.client),
}));

let callOrder: string[] = [];
type Outcome = 'sent' | 'no_email' | 'not_found' | 'failed';
const sendMock = vi.fn(async (rentalId: string): Promise<Outcome> => {
  callOrder.push(`send:${rentalId}`);
  return 'sent';
});
vi.mock('@/lib/email/rentals', () => ({
  sendRentalOverdueEmail: (rentalId: string) => sendMock(rentalId),
}));

import { reportError } from '@/lib/error-reporter';

import { GET } from './route';

type Rental = {
  id: string;
  organization_id: string;
  status: string;
  expected_return_at: string;
  overdue_reminder_sent_at: string | null;
};

function rental(id: string, organizationId: string, daysLate = 2): Rental {
  return {
    id,
    organization_id: organizationId,
    status: 'out',
    expected_return_at: new Date(Date.now() - daysLate * 24 * 60 * 60 * 1000).toISOString(),
    overdue_reminder_sent_at: null,
  };
}

function authed() {
  return new Request('https://test.local/api/cron/rental-overdue', {
    headers: { authorization: 'Bearer test-cron-secret' },
  });
}

/** The id a claim targeted: its `.eq('id', …)`. */
function claimedId(call: MockCall): string | undefined {
  const i = call.methods.findIndex((m, idx) => m === 'eq' && call.args[idx]?.[0] === 'id');
  return i === -1 ? undefined : (call.args[i]?.[1] as string);
}

function arrange(opts: {
  rentals: Rental[];
  enabledOrgIds: string[];
  modulesError?: { message: string };
  rentalsError?: { message: string };
  /** Ids another run already claimed: the guarded update matches no row. */
  alreadyClaimed?: string[];
  claimError?: { message: string };
  /** The guarded release of a claim fails. */
  releaseError?: { message: string };
  /** Seeded so a route that reads the comp would let this org through. */
  compedOrgIds?: string[];
}) {
  const claims: string[] = [];
  /** Each release: the rental, and the stamp value its guard names. */
  const releases: Array<{ id: string; guard: unknown }> = [];
  /** Each claim's stamp value, by rental. */
  const stamps = new Map<string, unknown>();
  const stub = makeSupabaseStub({
    'organization_modules.select': opts.modulesError
      ? { data: null, error: opts.modulesError }
      : { data: opts.enabledOrgIds.map((organization_id) => ({ organization_id })), error: null },
    'organizations.select': {
      data: (opts.compedOrgIds ?? []).map((id) => ({ id, all_modules_comp: true })),
      error: null,
    },
    'rentals.select': (call: MockCall) => {
      if (opts.rentalsError) return { data: null, error: opts.rentalsError };
      const orgFilter = inFilters(call).find(([col]) => col === 'organization_id');
      const rows = orgFilter
        ? opts.rentals.filter((r) => (orgFilter[1] as string[]).includes(r.organization_id))
        : opts.rentals;
      return {
        data: rows.map(({ id, status, expected_return_at, overdue_reminder_sent_at }) => ({
          id,
          status,
          expected_return_at,
          overdue_reminder_sent_at,
        })),
        error: null,
      };
    },
    'rentals.update': (call: MockCall) => {
      const id = claimedId(call) ?? '?';
      const payload = callArgs(call, 'update')?.[0] as { overdue_reminder_sent_at: unknown };
      if (payload.overdue_reminder_sent_at === null) {
        callOrder.push(`release:${id}`);
        const guard = eqArgs(call).find(([col]) => col === 'overdue_reminder_sent_at')?.[1];
        releases.push({ id, guard });
        return { data: null, error: opts.releaseError ?? null };
      }
      callOrder.push(`claim:${id}`);
      stamps.set(id, payload.overdue_reminder_sent_at);
      if (opts.claimError) return { data: null, error: opts.claimError };
      if (opts.alreadyClaimed?.includes(id)) return { data: null, error: null };
      claims.push(id);
      return { data: { id }, error: null };
    },
  });
  adminHolder.client = stub.client;
  return { stub, claims, releases, stamps };
}

/** Every `.eq(col, value)` of a call, in order. */
function eqArgs(call: MockCall): Array<[string, unknown]> {
  return call.methods.flatMap((m, i) =>
    m === 'eq' ? [call.args[i] as [string, unknown]] : [],
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  callOrder = [];
});

describe('GET /api/cron/rental-overdue', () => {
  it('returns 401 without the cron secret, and reads nothing', async () => {
    const { stub } = arrange({ rentals: [rental('r-1', 'org-on')], enabledOrgIds: ['org-on'] });
    const bare = await GET(new Request('https://test.local/api/cron/rental-overdue'));
    const wrong = await GET(
      new Request('https://test.local/api/cron/rental-overdue', {
        headers: { authorization: 'Bearer nope' },
      }),
    );
    expect(bare.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(stub.fromCalls).toHaveLength(0);
    expect(sendMock).not.toHaveBeenCalled();
  });

  // Mutation caught: dropping the allowlist filter, so the module-off org's
  // borrower is emailed and its rental stamped.
  it('skips an org whose rentals row is off: no email, no stamp', async () => {
    const { stub, claims } = arrange({
      rentals: [rental('r-off', 'org-off'), rental('r-on', 'org-on')],
      enabledOrgIds: ['org-on'],
    });
    const res = await GET(authed());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, considered: 1, sent: 1, skipped: 0, failed: 0 });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith('r-on');
    expect(claims).toEqual(['r-on']);
    // The allowlist is the explicit rentals row, enabled.
    const [modulesChain] = stub.chainArgsAll.get('organization_modules.select') ?? [];
    expect(modulesChain).toEqual(
      expect.arrayContaining([
        ['module_id', 'rentals'],
        ['enabled', true],
      ]),
    );
  });

  // Mutation caught: the gate reading the comp (effectiveModules or
  // module_enabled) instead of the explicit row, which would restart emails an
  // admin turned off in a comped org like L4L.
  it('a comped org with its rentals row off still sends nothing, and the comp is never read', async () => {
    const { stub, claims } = arrange({
      rentals: [rental('r-comp', 'org-comp')],
      enabledOrgIds: [],
      compedOrgIds: ['org-comp'],
    });
    const res = await GET(authed());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, considered: 0, sent: 0 });
    expect(sendMock).not.toHaveBeenCalled();
    expect(claims).toEqual([]);
    expect(stub.fromCalls).not.toContain('organizations');
    expect(stub.fromCalls).not.toContain('rentals');
  });

  it('with the row on, claims each overdue rental with the guarded update, then sends', async () => {
    const { stub } = arrange({
      rentals: [rental('r-1', 'org-on', 3), rental('r-2', 'org-on', 1)],
      enabledOrgIds: ['org-on'],
    });
    const res = await GET(authed());
    expect(await res.json()).toEqual({ ok: true, considered: 2, sent: 2, skipped: 0, failed: 0 });
    // Claim BEFORE send, per rental, oldest due first.
    expect(callOrder).toEqual(['claim:r-1', 'send:r-1', 'claim:r-2', 'send:r-2']);

    // The claim is guarded: still out, not yet reminded, and returns the row.
    const claim = stub.chainArgsAll.get('rentals.update')?.[0] ?? [];
    const methods = stub.chainsAll.get('rentals.update')?.[0] ?? [];
    expect(methods).toEqual(['update', 'eq', 'eq', 'is', 'select']);
    expect(claim[0]?.[0]).toEqual({ overdue_reminder_sent_at: expect.any(String) });
    expect(claim.slice(1)).toEqual([
      ['id', 'r-1'],
      ['status', 'out'],
      ['overdue_reminder_sent_at', null],
      ['id'],
    ]);

    // The candidate read: out, not reminded, past due, oldest first.
    const readMethods = stub.chainsAll.get('rentals.select')?.[0] ?? [];
    const readArgs = stub.chainArgsAll.get('rentals.select')?.[0] ?? [];
    const read: MockCall = { table: 'rentals', op: 'select', methods: readMethods, args: readArgs };
    expect(callArgs(read, 'select')).toEqual(['id, status, expected_return_at, overdue_reminder_sent_at']);
    expect(callArgs(read, 'eq')).toEqual(['status', 'out']);
    expect(callArgs(read, 'is')).toEqual(['overdue_reminder_sent_at', null]);
    expect(callArgs(read, 'lt')?.[0]).toBe('expected_return_at');
    expect(callArgs(read, 'order')).toEqual(['expected_return_at', { ascending: true }]);
  });

  // Mutation caught: ignoring the modules read error, which would treat
  // "unknown" as either everyone or no one and carry on.
  it('a failed module read answers 500 and sends nothing', async () => {
    const { stub } = arrange({
      rentals: [rental('r-1', 'org-on')],
      enabledOrgIds: ['org-on'],
      modulesError: { message: 'connection reset' },
    });
    const res = await GET(authed());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal_error' });
    expect(stub.fromCalls).not.toContain('rentals');
    expect(sendMock).not.toHaveBeenCalled();
    expect(vi.mocked(reportError)).toHaveBeenCalledTimes(1);
  });

  it('a failed candidate read answers 500 and sends nothing', async () => {
    const { claims } = arrange({
      rentals: [rental('r-1', 'org-on')],
      enabledOrgIds: ['org-on'],
      rentalsError: { message: 'statement timeout' },
    });
    const res = await GET(authed());
    expect(res.status).toBe(500);
    expect(sendMock).not.toHaveBeenCalled();
    expect(claims).toEqual([]);
  });

  // Mutation caught: send-then-stamp (the old order), or sending without
  // checking that the claim returned the row. Either emails the borrower a
  // second time when two runs overlap.
  it('a rental another run already claimed is not sent', async () => {
    const { claims } = arrange({
      rentals: [rental('r-taken', 'org-on', 3), rental('r-mine', 'org-on', 1)],
      enabledOrgIds: ['org-on'],
      alreadyClaimed: ['r-taken'],
    });
    const res = await GET(authed());
    expect(await res.json()).toEqual({ ok: true, considered: 2, sent: 1, skipped: 1, failed: 0 });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith('r-mine');
    expect(claims).toEqual(['r-mine']);
  });

  it('a failed claim is not sent and is reported', async () => {
    arrange({
      rentals: [rental('r-1', 'org-on')],
      enabledOrgIds: ['org-on'],
      claimError: { message: 'deadlock detected' },
    });
    const res = await GET(authed());
    expect(await res.json()).toEqual({ ok: true, considered: 1, sent: 0, skipped: 0, failed: 1 });
    expect(sendMock).not.toHaveBeenCalled();
    expect(vi.mocked(reportError)).toHaveBeenCalledTimes(1);
  });

  it('no org with the module on: nothing is read past the allowlist', async () => {
    const { stub } = arrange({ rentals: [rental('r-1', 'org-x')], enabledOrgIds: [] });
    const res = await GET(authed());
    expect(await res.json()).toEqual({ ok: true, considered: 0, sent: 0, skipped: 0, failed: 0 });
    expect(stub.fromCalls).toEqual(['organization_modules']);
  });

  // Pattern #29: the allowlist has no bound and every id rides in the URL, so
  // the candidate read goes 100 organizations per request.
  it('reads candidates 100 organizations per request and merges them oldest first', async () => {
    const orgIds = Array.from({ length: 150 }, (_, i) => `org-${String(i).padStart(3, '0')}`);
    const { stub } = arrange({
      rentals: [rental('r-late-batch2', 'org-149', 5), rental('r-batch1', 'org-000', 1)],
      enabledOrgIds: orgIds,
    });
    const res = await GET(authed());
    expect(await res.json()).toMatchObject({ considered: 2, sent: 2 });
    const reads = stub.chainArgsAll.get('rentals.select') ?? [];
    expect(reads).toHaveLength(2);
    for (const args of reads) {
      const methods = stub.chainsAll.get('rentals.select')![reads.indexOf(args)]!;
      const call: MockCall = { table: 'rentals', op: 'select', methods, args };
      const [, ids] = inFilters(call).find(([col]) => col === 'organization_id')!;
      expect(ids.length).toBeLessThanOrEqual(100);
    }
    expect(sendMock.mock.calls.map(([id]) => id)).toEqual(['r-late-batch2', 'r-batch1']);
  });

  // The pages decide "sent" and "will be sent" with isOverdueReminderCandidate
  // (@stockpilot/core rentals/emails.ts). The run applies the same function to
  // every row its query returned, so a row the query lets through that the
  // shared rule refuses is never claimed or emailed. Mutation caught: dropping
  // the filter, which would email the rows below.
  it('claims only rows the shared rule accepts, whatever the query returned', async () => {
    const future = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    const { claims } = arrange({
      rentals: [
        { ...rental('r-returned', 'org-on'), status: 'returned' },
        { ...rental('r-reminded', 'org-on'), overdue_reminder_sent_at: new Date().toISOString() },
        { ...rental('r-not-due', 'org-on'), expected_return_at: future },
        rental('r-ok', 'org-on'),
      ],
      enabledOrgIds: ['org-on'],
    });
    const res = await GET(authed());
    expect(await res.json()).toEqual({ ok: true, considered: 1, sent: 1, skipped: 0, failed: 0 });
    expect(claims).toEqual(['r-ok']);
    expect(sendMock.mock.calls.map(([id]) => id)).toEqual(['r-ok']);
  });

  // The rental pages print the stamp as "Overdue reminder: Sent <time>".
  // Mutation caught: ignoring the send's result (the old code), which kept the
  // stamp on a reminder Resend refused, so the pages claimed a send that never
  // happened and no run ever tried again.
  it('a send that did not go out gives the claim back, guarded on the stamp it wrote', async () => {
    const { claims, releases, stamps } = arrange({
      rentals: [rental('r-bounced', 'org-on', 3), rental('r-ok', 'org-on', 1)],
      enabledOrgIds: ['org-on'],
    });
    sendMock.mockImplementationOnce(async (rentalId: string) => {
      callOrder.push(`send:${rentalId}`);
      return 'failed';
    });
    const res = await GET(authed());
    expect(await res.json()).toEqual({ ok: true, considered: 2, sent: 1, skipped: 0, failed: 1 });
    expect(claims).toEqual(['r-bounced', 'r-ok']);
    expect(callOrder).toEqual(['claim:r-bounced', 'send:r-bounced', 'release:r-bounced', 'claim:r-ok', 'send:r-ok']);
    // Released only where this run's own claim still stands.
    expect(releases).toEqual([{ id: 'r-bounced', guard: stamps.get('r-bounced') }]);
    expect(typeof stamps.get('r-bounced')).toBe('string');
    expect(vi.mocked(reportError)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reportError).mock.calls[0]?.[1]).toMatchObject({
      extra: { step: 'send', rentalId: 'r-bounced' },
    });
  });

  it('a send that throws (it should not) is treated as not sent and released', async () => {
    const { releases } = arrange({ rentals: [rental('r-1', 'org-on')], enabledOrgIds: ['org-on'] });
    const boom = new Error('boom');
    sendMock.mockRejectedValueOnce(boom);
    const res = await GET(authed());
    expect(await res.json()).toEqual({ ok: true, considered: 1, sent: 0, skipped: 0, failed: 1 });
    expect(releases.map((r) => r.id)).toEqual(['r-1']);
    // Reported once, with the error it threw.
    expect(vi.mocked(reportError)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reportError).mock.calls[0]?.[0]).toBe(boom);
  });

  // No email on file: nothing to send now or later. The pages say "Not sent:
  // no email on file" whatever the stamp says, and the stamp keeps the rental
  // from being re-read every day.
  it('no email on file keeps the stamp and is counted as skipped, not sent', async () => {
    const { claims, releases } = arrange({ rentals: [rental('r-1', 'org-on')], enabledOrgIds: ['org-on'] });
    sendMock.mockResolvedValueOnce('no_email');
    const res = await GET(authed());
    expect(await res.json()).toEqual({ ok: true, considered: 1, sent: 0, skipped: 1, failed: 0 });
    expect(claims).toEqual(['r-1']);
    expect(releases).toEqual([]);
    expect(vi.mocked(reportError)).not.toHaveBeenCalled();
  });

  it('a release that fails is reported as such', async () => {
    arrange({
      rentals: [rental('r-1', 'org-on')],
      enabledOrgIds: ['org-on'],
      releaseError: { message: 'connection reset' },
    });
    sendMock.mockResolvedValueOnce('failed');
    const res = await GET(authed());
    expect(await res.json()).toMatchObject({ sent: 0, failed: 1 });
    expect(vi.mocked(reportError)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reportError).mock.calls[0]?.[1]).toMatchObject({
      extra: { step: 'release', rentalId: 'r-1' },
    });
  });

  it('reads the module and status the pages describe (RENTAL_OVERDUE_SWEEP)', async () => {
    const { stub } = arrange({ rentals: [rental('r-1', 'org-on')], enabledOrgIds: ['org-on'] });
    await GET(authed());
    const [modulesChain] = stub.chainArgsAll.get('organization_modules.select') ?? [];
    expect(modulesChain).toEqual(expect.arrayContaining([['module_id', RENTAL_OVERDUE_SWEEP.moduleId]]));
    const claim = stub.chainArgsAll.get('rentals.update')?.[0] ?? [];
    expect(claim).toEqual(expect.arrayContaining([['status', RENTAL_OVERDUE_SWEEP.status]]));
  });
});

// The pages print when this run will send a reminder ("Sep 27, around 8:00 AM")
// from RENTAL_OVERDUE_SWEEP.utcHour. The run's real schedule is vercel.json.
// Mutation caught: moving the cron without moving the constant, which would
// make every "will be sent" line on the rental pages name the wrong time.
describe('the rental-overdue schedule the pages describe', () => {
  it('vercel.json runs the sweep daily at RENTAL_OVERDUE_SWEEP.utcHour UTC', () => {
    const vercel = JSON.parse(
      readFileSync(path.resolve(__dirname, '../../../../../vercel.json'), 'utf8'),
    ) as { crons?: Array<{ path: string; schedule: string }> };
    const entries = (vercel.crons ?? []).filter((c) => c.path === '/api/cron/rental-overdue');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.schedule).toBe(`0 ${RENTAL_OVERDUE_SWEEP.utcHour} * * *`);
  });
});
