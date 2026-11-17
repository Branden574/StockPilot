import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { cronAttemptsTable } from '@/test/cron-attempts-table';
import { makeSupabaseStub } from '@/test/supabase-mock';

/**
 * The daily archived-item cleanup reaches every organization: least recently
 * reached first, a soft deadline before maxDuration, one log line with what
 * it left, and one run per organization per day however often the tick is
 * delivered.
 */

vi.mock('@/lib/env', () => ({ env: { CRON_SECRET: 'test-cron-secret' } }));
const reportError = vi.hoisted(() => vi.fn());
vi.mock('@/lib/error-reporter', () => ({ reportError }));
const adminHolder = { client: null as unknown };
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn(() => adminHolder.client) }));
vi.mock('@/server/loaders/inventory-list', () => ({ revalidateInventoryList: vi.fn() }));

const purged: string[] = [];
const cost = { ms: 0, wait: false };
vi.mock('@/server/services/archive-cleanup', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/server/services/archive-cleanup')>();
  return {
    ...real,
    purgeExpiredArchivedItems: async (ctx: { organizationId: string }) => {
      purged.push(ctx.organizationId);
      if (cost.ms > 0) vi.setSystemTime(Date.now() + cost.ms);
      if (cost.wait) await new Promise((r) => setTimeout(r, 1));
      return { deleted: 2, ids: ['i1', 'i2'], truncated: false, failed: 0, skipped: 0 };
    },
  };
});

import { GET, maxDuration } from './route';

const ORGS = ['org-1', 'org-2', 'org-3', 'org-4', 'org-5', 'org-6'];

function client(table: ReturnType<typeof cronAttemptsTable>) {
  return makeSupabaseStub({
    ...table.results,
    'organization_modules.select': (call) =>
      call.methods.includes('range')
        ? {
            data: ORGS.map((id) => ({
              organization_id: id,
              settings: { autoDeleteArchived: { enabled: true, days: 90 } },
            })),
            error: null,
          }
        : { data: [{ module_id: 'inventory' }], error: null },
    'organization_members.select': { data: [{ user_id: 'u1', role: 'owner' }], error: null },
  }).client;
}

const get = () =>
  GET(
    new Request('https://test.local/api/cron/auto-delete-archived', {
      headers: { authorization: 'Bearer test-cron-secret' },
    }),
  );

let info: MockInstance<Console['info']>;
beforeEach(() => {
  vi.clearAllMocks();
  purged.length = 0;
  cost.ms = 0;
  cost.wait = false;
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  info.mockRestore();
});

const logLine = () =>
  JSON.parse(
    String(info.mock.calls.find((c) => c[0] === '[cron.auto-delete-archived]')?.[1]),
  ) as Record<string, unknown>;

describe('GET /api/cron/auto-delete-archived reaches every organization', () => {
  it('has room past the soft deadline: maxDuration 300', () => {
    expect(maxDuration).toBe(300);
  });

  it('stops starting organizations at the deadline, says how many it left, and the next day starts with them', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-11-17T03:00:00.000Z'));
    cost.ms = 100_000;
    const table = cronAttemptsTable();
    adminHolder.client = client(table);

    expect(await (await get()).json()).toMatchObject({ orgsProcessed: 3, leftForNextRun: 3 });
    expect(purged).toEqual(['org-1', 'org-2', 'org-3']);
    expect(logLine()).toMatchObject({ candidates: 6, leftForNextRun: 3 });

    purged.length = 0;
    vi.setSystemTime(Date.parse('2026-11-18T03:00:00.000Z'));
    await get();
    expect(purged).toEqual(['org-4', 'org-5', 'org-6']);
  });

  it('one tick delivered twice: each organization is purged once', async () => {
    cost.wait = true;
    adminHolder.client = client(cronAttemptsTable());
    const [a, b] = await Promise.all([get(), get()]);
    const bodies = [await a.json(), await b.json()];
    expect([...purged].sort()).toEqual(ORGS);
    expect(bodies[0].itemsDeleted + bodies[1].itemsDeleted).toBe(2 * ORGS.length);
  });
});
