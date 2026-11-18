import type { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { cronAttemptsTable } from '@/test/cron-attempts-table';
import { makeSupabaseStub, type MockCall } from '@/test/supabase-mock';

import { ROLE_PERMISSIONS, type Permission, type Role } from '@stockpilot/core';

/**
 * The daily briefing reaches every organization: least recently reached
 * first, a soft deadline before maxDuration, one log line with what it left,
 * and one briefing per person per day however often the tick is delivered.
 */

vi.mock('@/lib/env', () => ({ env: { CRON_SECRET: 'test-cron-secret' } }));
const reportError = vi.hoisted(() => vi.fn());
vi.mock('@/lib/error-reporter', () => ({ reportError }));
const adminHolder = { client: null as unknown };
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn(() => adminHolder.client) }));

const sent: Array<{ organizationId: string; userId: string }> = [];
vi.mock('@/server/services/notifications', () => ({
  createNotification: async (args: { organizationId: string; userId: string }) => {
    sent.push({ organizationId: args.organizationId, userId: args.userId });
    return 'notification-1';
  },
}));

const gathered: string[] = [];
const cost = { ms: 0, wait: false };
vi.mock('@/server/services/insights', () => ({
  gatherInsightsForCtx: async (ctx: { organizationId: string }) => {
    gathered.push(ctx.organizationId);
    if (cost.ms > 0) vi.setSystemTime(Date.now() + cost.ms);
    if (cost.wait) await new Promise((r) => setTimeout(r, 1));
    return {
      signals: [{ key: 'low_stock', label: 'items at or under their reorder point', count: 4 }],
    };
  },
  summarizeInsights: async () => null,
}));

vi.mock('@/lib/auth/effective-permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/effective-permissions')>()),
  loadEffectivePermissions: async (_c: unknown, _o: string, _u: string, role: Role) =>
    new Set<Permission>(ROLE_PERMISSIONS[role]),
}));

import { GET, maxDuration } from './route';

const ORGS = ['org-1', 'org-2', 'org-3', 'org-4', 'org-5', 'org-6'];

/** Organizations with no accepted owner or admin. */
const noOwner = new Set<string>();
/** Organizations whose owner/admin read ('members') or module set read
 *  ('modules') fails. */
const readFails = new Map<string, 'members' | 'modules'>();
const READ_ERROR = { message: 'canceling statement due to statement timeout', code: '57014' };
const eqValue = (call: MockCall, col: string) =>
  call.args.find((a, i) => call.methods[i] === 'eq' && a[0] === col)?.[1] as string | undefined;

function client(table: ReturnType<typeof cronAttemptsTable>) {
  return stubFor(table).client;
}

function stubFor(
  table: ReturnType<typeof cronAttemptsTable>,
  extra: Parameters<typeof makeSupabaseStub>[0] = {},
) {
  return makeSupabaseStub({
    ...table.results,
    'organization_modules.select': (call: MockCall) =>
      readFails.get(eqValue(call, 'organization_id') ?? '') === 'modules'
        ? { data: null, error: READ_ERROR }
        : call.methods.includes('range')
          ? { data: ORGS.map((id) => ({ organization_id: id })), error: null }
          : { data: [{ module_id: 'ai' }, { module_id: 'inventory' }], error: null },
    'organization_members.select': (call: MockCall) =>
      readFails.get(eqValue(call, 'organization_id') ?? '') === 'members'
        ? { data: null, error: READ_ERROR }
        : noOwner.has(eqValue(call, 'organization_id') ?? '')
          ? { data: [], error: null }
          : { data: [{ user_id: 'admin-1', role: 'owner' }], error: null },
    // No briefing yet today for anyone (the per-user check).
    'notifications.select': { data: [], error: null },
    ...extra,
  });
}

const get = () =>
  GET(
    new Request('https://test.local/api/cron/daily-briefing', {
      headers: { authorization: 'Bearer test-cron-secret' },
    }) as unknown as NextRequest,
  );

let info: MockInstance<Console['info']>;
beforeEach(() => {
  vi.clearAllMocks();
  noOwner.clear();
  readFails.clear();
  sent.length = 0;
  gathered.length = 0;
  cost.ms = 0;
  cost.wait = false;
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  info.mockRestore();
});

const logLine = () =>
  JSON.parse(String(info.mock.calls.find((c) => c[0] === '[cron.daily-briefing]')?.[1])) as Record<
    string,
    unknown
  >;

describe('GET /api/cron/daily-briefing reaches every organization', () => {
  it('keeps maxDuration 300, past the soft deadline', () => {
    expect(maxDuration).toBe(300);
  });

  it('stops starting organizations at the deadline, says how many it left, and the next run starts with them', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-11-17T13:00:00.000Z'));
    cost.ms = 100_000;
    const table = cronAttemptsTable();
    adminHolder.client = client(table);

    expect(await (await get()).json()).toMatchObject({ orgsProcessed: 3, leftForNextRun: 3 });
    expect(gathered).toEqual(['org-1', 'org-2', 'org-3']);
    expect(logLine()).toMatchObject({ candidates: 6, briefingsSent: 3, leftForNextRun: 3 });

    gathered.length = 0;
    vi.setSystemTime(Date.parse('2026-11-18T13:00:00.000Z'));
    await get();
    expect(gathered).toEqual(['org-4', 'org-5', 'org-6']);
  });

  it('one tick delivered twice: each person gets one briefing', async () => {
    cost.wait = true;
    adminHolder.client = client(cronAttemptsTable());
    const [a, b] = await Promise.all([get(), get()]);
    const bodies = [await a.json(), await b.json()];
    expect(sent.map((s) => s.organizationId).sort()).toEqual(ORGS);
    expect(bodies[0].briefingsSent + bodies[1].briefingsSent).toBe(ORGS.length);
  });

  it('an organization with no owner or admin is skipped, not a failure, and never counts as failing repeatedly', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const table = cronAttemptsTable();
    noOwner.add('org-3');
    for (let day = 0; day < 4; day += 1) {
      vi.setSystemTime(Date.parse('2026-11-17T08:00:00.000Z') + day * 24 * 60 * 60_000);
      adminHolder.client = client(table);
      info.mockClear();
      await get();
      expect(logLine()).toMatchObject({ noActor: 1, failed: 0, failingRepeatedly: 0 });
    }
    expect(table.rows.find((r) => r.organization_id === 'org-3')!.consecutive_failures).toBe(0);
  });

  it('an organization whose owner/admin or module set cannot be read is a failure, reported once, never "no owner" or "no modules"', async () => {
    const table = cronAttemptsTable();
    adminHolder.client = client(table);
    readFails.set('org-2', 'members');
    readFails.set('org-4', 'modules');
    await get();
    expect(gathered).toEqual(['org-1', 'org-3', 'org-5', 'org-6']);
    expect(logLine()).toMatchObject({ noActor: 0, contextUnread: 2, failed: 2 });
    for (const id of ['org-2', 'org-4']) {
      expect(table.rows.find((r) => r.organization_id === id)!.consecutive_failures, id).toBe(1);
    }
    const reports = reportError.mock.calls.filter(
      ([, c]) => (c as { tag?: string }).tag === 'cron.daily-briefing.context',
    );
    expect(reports).toHaveLength(1);
    // No organization id anywhere in the report: the count is in the log line.
    expect(reports[0]![1]).toEqual({ tag: 'cron.daily-briefing.context' });
    expect((reports[0]![0] as Error).message).not.toMatch(/org-/);
  });
});

describe('GET /api/cron/daily-briefing when the day claim cannot be recorded', () => {
  /** The calls that read or write a briefing (the per-person check, the send). */
  const briefingCalls = (stub: ReturnType<typeof stubFor>) =>
    stub.fromCalls.filter((t) => t === 'notifications').length + sent.length;

  const claimReports = () =>
    reportError.mock.calls.filter(
      ([, c]) => (c as { tag?: string }).tag === 'cron.daily-briefing.attempts',
    );

  it('the claim update fails: every organization is skipped for this run, counted, and reported once', async () => {
    const stub = stubFor(cronAttemptsTable(), {
      'cron_sweep_attempts.update': {
        data: null,
        error: { message: 'relation "cron_sweep_attempts" does not exist', code: '42P01' },
      },
    });
    adminHolder.client = stub.client;
    expect(await (await get()).json()).toMatchObject({ orgsProcessed: 0, briefingsSent: 0 });
    expect(gathered).toEqual([]);
    expect(briefingCalls(stub)).toBe(0);
    expect(logLine()).toMatchObject({ claimUnavailable: 6, heldByAnotherRun: 0, failed: 0 });
    const reports = claimReports().filter(
      ([, c]) => (c as { extra?: { step?: string } }).extra?.step === 'claim',
    );
    expect(reports).toHaveLength(1);
    expect(reports[0]![1]).toMatchObject({
      level: 'warning',
      extra: { step: 'claim', job: 'daily_briefing', code: '42P01', onClaimUnavailable: 'skip' },
    });
    // No organization id in the report.
    expect(JSON.stringify(reports[0]![1])).not.toMatch(/org-/);
    expect((reports[0]![0] as Error).message).not.toMatch(/org-/);
  });

  it('the claim insert fails with an error other than the key: the same', async () => {
    const stub = stubFor(cronAttemptsTable(), {
      'cron_sweep_attempts.insert': {
        data: null,
        error: { message: 'permission denied for table cron_sweep_attempts', code: '42501' },
      },
    });
    adminHolder.client = stub.client;
    await get();
    expect(gathered).toEqual([]);
    expect(briefingCalls(stub)).toBe(0);
    expect(logLine()).toMatchObject({ claimUnavailable: 6, failed: 0 });
    const reports = claimReports();
    expect(reports).toHaveLength(1);
    expect(reports[0]![1]).toMatchObject({ extra: { step: 'claim', code: '42501' } });
  });

  it('a run that overlaps another while the claim cannot be recorded sends no second briefing', async () => {
    cost.wait = true;
    const stub = stubFor(cronAttemptsTable(), {
      'cron_sweep_attempts.update': {
        data: null,
        error: { message: 'canceling statement due to statement timeout', code: '57014' },
      },
    });
    adminHolder.client = stub.client;
    await Promise.all([get(), get()]);
    expect(sent).toEqual([]);
  });

  it('one organization whose claim cannot be written waits for the next run, where it goes first', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const table = cronAttemptsTable();
    const failing = new Set<string>();
    const update = table.results['cron_sweep_attempts.update'];
    const day = (n: number) => {
      vi.setSystemTime(Date.parse('2026-11-17T13:00:00.000Z') + n * 24 * 60 * 60_000);
      gathered.length = 0;
      info.mockClear();
      adminHolder.client = stubFor(table, {
        'cron_sweep_attempts.update': (call: MockCall) =>
          failing.has(eqValue(call, 'organization_id') ?? '')
            ? { data: null, error: { message: 'permission denied', code: '42501' } }
            : update(call),
      }).client;
      return get();
    };
    cost.ms = 1_000;
    await day(0);
    expect(gathered).toEqual(ORGS);

    failing.add('org-1');
    await day(1);
    expect(gathered).toEqual(ORGS.slice(1));
    expect(logLine()).toMatchObject({ claimUnavailable: 1, orgsProcessed: 5 });

    failing.clear();
    await day(2);
    expect(gathered[0]).toBe('org-1');
    expect([...gathered].sort()).toEqual(ORGS);
  });
});
