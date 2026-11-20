import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { cronAttemptsTable } from '@/test/cron-attempts-table';
import { makeSupabaseStub, type MockCall } from '@/test/supabase-mock';

import type { RecurringRunSummary } from '@/server/services/recurring-pos';

/**
 * The daily recurring-PO cron reaches every organization: least recently
 * reached first, a soft deadline before maxDuration, one log line with what
 * it left, and one run per organization per day however often the tick is
 * delivered. (One purchase order for a template missed for several days is
 * runDueTemplates' rule, pinned in recurring-pos.test.ts.)
 */

vi.mock('@/lib/env', () => ({ env: { CRON_SECRET: 'test-cron-secret' } }));
const reportError = vi.hoisted(() => vi.fn());
vi.mock('@/lib/error-reporter', () => ({ reportError }));
const adminHolder = { client: null as unknown };
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn(() => adminHolder.client) }));

const createNotification = vi.fn(async (_args: unknown) => 'notif-id');
vi.mock('@/server/services/notifications', () => ({
  createNotification: (args: unknown) => createNotification(args),
}));

const ran: string[] = [];
const cost = { ms: 0, wait: false };
const ONE_PO: RecurringRunSummary = {
  created: 1,
  sent: 0,
  heldForReview: 0,
  failures: 0,
  linesLeftOff: 0,
  templatesWithLinesLeftOff: [],
  templatesWithNothingOrderable: [],
  templatesSkipped: [],
  templatesSendFailed: [],
};
vi.mock('@/server/services/recurring-pos', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/services/recurring-pos')>();
  return {
    ...actual,
    RecurringPoTemplatesService: class {
      constructor(private readonly ctx: { organizationId: string }) {}
      async runDueTemplates() {
        ran.push(this.ctx.organizationId);
        if (cost.ms > 0) vi.setSystemTime(Date.now() + cost.ms);
        if (cost.wait) await new Promise((r) => setTimeout(r, 1));
        return ONE_PO;
      }
    },
  };
});

vi.mock('@stockpilot/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stockpilot/core')>();
  return { ...actual, planAllowsRecurringPos: () => true };
});

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
  return makeSupabaseStub({
    ...table.results,
    'organization_modules.select': (call: MockCall) =>
      readFails.get(eqValue(call, 'organization_id') ?? '') === 'modules'
        ? { data: null, error: READ_ERROR }
        : call.methods.includes('range')
          ? { data: ORGS.map((id) => ({ organization_id: id })), error: null }
          : { data: [{ module_id: 'purchase_orders' }], error: null },
    'organizations.select': { data: { plan: 'pro' }, error: null },
    'organization_members.select': (call: MockCall) =>
      readFails.get(eqValue(call, 'organization_id') ?? '') === 'members'
        ? { data: null, error: READ_ERROR }
        : noOwner.has(eqValue(call, 'organization_id') ?? '')
          ? { data: [], error: null }
          : { data: [{ user_id: 'admin-1', role: 'owner' }], error: null },
  }).client;
}

const get = () =>
  GET(
    new Request('https://test.local/api/cron/recurring-pos', {
      headers: { authorization: 'Bearer test-cron-secret' },
    }),
  );

let info: MockInstance<Console['info']>;
beforeEach(() => {
  vi.clearAllMocks();
  noOwner.clear();
  readFails.clear();
  ran.length = 0;
  cost.ms = 0;
  cost.wait = false;
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  info.mockRestore();
});

const logLine = () =>
  JSON.parse(String(info.mock.calls.find((c) => c[0] === '[cron.recurring-pos]')?.[1])) as Record<
    string,
    unknown
  >;

describe('GET /api/cron/recurring-pos reaches every organization', () => {
  it('has room past the soft deadline: maxDuration 300', () => {
    expect(maxDuration).toBe(300);
  });

  it('stops starting organizations at the deadline, says how many it left, and the next day starts with them', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-11-17T07:00:00.000Z'));
    cost.ms = 100_000;
    const table = cronAttemptsTable();
    adminHolder.client = client(table);

    expect(await (await get()).json()).toMatchObject({
      orgsProcessed: 3,
      posCreated: 3,
      leftForNextRun: 3,
    });
    expect(ran).toEqual(['org-1', 'org-2', 'org-3']);
    expect(logLine()).toMatchObject({ candidates: 6, leftForNextRun: 3 });

    ran.length = 0;
    vi.setSystemTime(Date.parse('2026-11-18T07:00:00.000Z'));
    await get();
    expect(ran).toEqual(['org-4', 'org-5', 'org-6']);
  });

  it('one tick delivered twice: each organization runs its templates, and its admins are told, once', async () => {
    cost.wait = true;
    adminHolder.client = client(cronAttemptsTable());
    const [a, b] = await Promise.all([get(), get()]);
    const bodies = [await a.json(), await b.json()];
    expect([...ran].sort()).toEqual(ORGS);
    expect(bodies[0].posCreated + bodies[1].posCreated).toBe(ORGS.length);
    expect(createNotification).toHaveBeenCalledTimes(ORGS.length);
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
    expect(ran).toEqual(['org-1', 'org-3', 'org-5', 'org-6']);
    expect(logLine()).toMatchObject({ noActor: 0, contextUnread: 2, failed: 2 });
    for (const id of ['org-2', 'org-4']) {
      expect(table.rows.find((r) => r.organization_id === id)!.consecutive_failures, id).toBe(1);
    }
    const reports = reportError.mock.calls.filter(
      ([, c]) => (c as { tag?: string }).tag === 'cron.recurring-pos.context',
    );
    expect(reports).toHaveLength(1);
    // No organization id anywhere in the report: the count is in the log line.
    expect(reports[0]![1]).toEqual({ tag: 'cron.recurring-pos.context' });
    expect((reports[0]![0] as Error).message).not.toMatch(/org-/);
  });
});
