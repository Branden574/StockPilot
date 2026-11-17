import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { cronAttemptsTable } from '@/test/cron-attempts-table';
import { makeSupabaseStub, type MockCall } from '@/test/supabase-mock';

/**
 * The daily automatic-reordering cron reaches every organization: least
 * recently reached first, a soft deadline before maxDuration, one log line
 * with what it left, and one run per organization per day however often the
 * tick is delivered.
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

const reorderRuns: string[] = [];
const reorderCost = { ms: 0, wait: false };
vi.mock('@/server/services/purchase-orders', () => ({
  PurchaseOrdersService: class {
    constructor(private readonly ctx: { organizationId: string }) {}
    async runAutoReorder() {
      reorderRuns.push(this.ctx.organizationId);
      if (reorderCost.ms > 0) vi.setSystemTime(Date.now() + reorderCost.ms);
      if (reorderCost.wait) await new Promise((r) => setTimeout(r, 1));
      return {
        created: 1,
        sent: 0,
        heldForReview: 0,
        skippedDuplicate: 0,
        skippedNoSupplier: 0,
        supplierFailures: 0,
      };
    }
  },
}));

vi.mock('@stockpilot/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stockpilot/core')>();
  return { ...actual, planAllowsAutoReorder: () => true };
});

import { GET, maxDuration } from './route';

const ORGS = ['org-1', 'org-2', 'org-3', 'org-4', 'org-5', 'org-6'];
const DAY = 24 * 60 * 60_000;

function client(table: ReturnType<typeof cronAttemptsTable>) {
  return makeSupabaseStub({
    ...table.results,
    'organization_modules.select': (call: MockCall) =>
      call.args[0]?.[0] === 'organization_id, settings'
        ? {
            data: ORGS.map((id) => ({
              organization_id: id,
              settings: { autoReorder: { enabled: true, mode: 'draft' } },
            })),
            error: null,
          }
        : { data: [{ module_id: 'purchase_orders' }], error: null },
    'organizations.select': { data: { plan: 'pro' }, error: null },
    'organization_members.select': { data: [{ user_id: 'admin-1', role: 'owner' }], error: null },
  }).client;
}

const get = () =>
  GET(
    new Request('https://test.local/api/cron/auto-reorder', {
      headers: { authorization: 'Bearer test-cron-secret' },
    }),
  );

let info: MockInstance<Console['info']>;
beforeEach(() => {
  vi.clearAllMocks();
  reorderRuns.length = 0;
  reorderCost.ms = 0;
  reorderCost.wait = false;
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  info.mockRestore();
});

function logLine(): Record<string, unknown> {
  const call = info.mock.calls.find((c) => c[0] === '[cron.auto-reorder]');
  return JSON.parse(String(call?.[1] ?? 'null')) as Record<string, unknown>;
}

describe('GET /api/cron/auto-reorder reaches every organization', () => {
  it('has room past the soft deadline: maxDuration 300', () => {
    expect(maxDuration).toBe(300);
  });

  it('stops starting organizations at the deadline, says how many it left, and the next day starts with them', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-11-17T08:00:00.000Z'));
    reorderCost.ms = 100_000; // started at 0, 100 and 200 s; the 4th would start at 300 s
    const table = cronAttemptsTable();
    adminHolder.client = client(table);

    const res1 = await get();
    expect(await res1.json()).toMatchObject({ orgsProcessed: 3, leftForNextRun: 3 });
    expect(reorderRuns).toEqual(['org-1', 'org-2', 'org-3']);
    expect(logLine()).toMatchObject({ candidates: 6, orgsProcessed: 3, leftForNextRun: 3 });
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tag: 'cron.auto-reorder.deadline' }),
    );

    reorderRuns.length = 0;
    info.mockClear();
    vi.setSystemTime(Date.parse('2026-11-18T08:00:00.000Z'));
    await get();
    expect(reorderRuns).toEqual(['org-4', 'org-5', 'org-6']);
    expect(logLine()).toMatchObject({ leftForNextRun: 3 });
  });

  it('one tick delivered twice: each organization is reordered and told once', async () => {
    reorderCost.wait = true;
    const table = cronAttemptsTable();
    adminHolder.client = client(table);

    const [a, b] = await Promise.all([get(), get()]);
    const bodies = [await a.json(), await b.json()];

    expect([...reorderRuns].sort()).toEqual(ORGS);
    expect(createNotification).toHaveBeenCalledTimes(ORGS.length);
    expect(bodies[0].orgsProcessed + bodies[1].orgsProcessed).toBe(ORGS.length);
    expect(bodies[0].heldByAnotherRun + bodies[1].heldByAnotherRun).toBe(ORGS.length);
  });

  it('a manual run later the same day reorders nobody again; the next day reorders everyone', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-11-17T08:00:00.000Z'));
    const table = cronAttemptsTable();
    adminHolder.client = client(table);
    await get();
    expect(reorderRuns).toHaveLength(6);

    vi.setSystemTime(Date.parse('2026-11-17T15:00:00.000Z'));
    await get();
    expect(reorderRuns).toHaveLength(6);

    vi.setSystemTime(Date.parse('2026-11-18T08:00:00.000Z'));
    await get();
    expect(reorderRuns).toHaveLength(12);
  });

  it('when the attempt records cannot be read, the first organization changes from day to day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const table = cronAttemptsTable([], { failRead: () => true });
    const firsts: string[] = [];
    for (let day = 0; day < 4; day += 1) {
      vi.setSystemTime(Date.parse('2026-11-17T08:00:00.000Z') + day * DAY);
      table.rows.length = 0; // no claims carried over: only the order is under test
      adminHolder.client = client(table);
      reorderRuns.length = 0;
      await get();
      firsts.push(reorderRuns[0]!);
    }
    expect(new Set(firsts).size).toBeGreaterThan(1);
    expect(logLine()).toMatchObject({ orderedBy: 'clock' });
  });
});
