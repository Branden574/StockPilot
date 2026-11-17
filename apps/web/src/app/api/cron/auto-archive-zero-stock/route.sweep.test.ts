import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { cronAttemptsTable } from '@/test/cron-attempts-table';
import { makeSupabaseStub } from '@/test/supabase-mock';

/**
 * The daily zero-stock auto-archive reaches every organization: least
 * recently reached first, a soft deadline before maxDuration, one log line
 * with what it left, and one run per organization per day however often the
 * tick is delivered (so its notice goes out once).
 */

vi.mock('@/lib/env', () => ({ env: { CRON_SECRET: 'test-cron-secret' } }));
const reportError = vi.hoisted(() => vi.fn());
vi.mock('@/lib/error-reporter', () => ({ reportError }));
const adminHolder = { client: null as unknown };
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn(() => adminHolder.client) }));
vi.mock('@/server/loaders/inventory-list', () => ({ revalidateInventoryList: vi.fn() }));

const archivedIn: string[] = [];
const notified: string[] = [];
const cost = { ms: 0, wait: false };
vi.mock('@/server/services/auto-archive', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/server/services/auto-archive')>();
  return {
    ...real,
    archiveExpiredZeroStockItems: async (ctx: { organizationId: string }) => {
      archivedIn.push(ctx.organizationId);
      if (cost.ms > 0) vi.setSystemTime(Date.now() + cost.ms);
      if (cost.wait) await new Promise((r) => setTimeout(r, 1));
      return {
        archived: 1,
        ids: ['i1'],
        items: [{ id: 'i1', name: 'Sample item' }],
        truncated: false,
        failed: 0,
      };
    },
    notifyAutoArchived: async (_admin: unknown, orgId: string) => {
      notified.push(orgId);
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
              settings: { autoArchiveOnZeroStock: { enabled: true, dwellDays: 30 } },
            })),
            error: null,
          }
        : { data: [{ module_id: 'inventory' }], error: null },
    'organization_members.select': { data: [{ user_id: 'u1', role: 'owner' }], error: null },
  }).client;
}

const get = () =>
  GET(
    new Request('https://test.local/api/cron/auto-archive-zero-stock', {
      headers: { authorization: 'Bearer test-cron-secret' },
    }),
  );

let info: MockInstance<Console['info']>;
beforeEach(() => {
  vi.clearAllMocks();
  archivedIn.length = 0;
  notified.length = 0;
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
    String(info.mock.calls.find((c) => c[0] === '[cron.auto-archive-zero-stock]')?.[1]),
  ) as Record<string, unknown>;

describe('GET /api/cron/auto-archive-zero-stock reaches every organization', () => {
  it('has room past the soft deadline: maxDuration 300', () => {
    expect(maxDuration).toBe(300);
  });

  it('stops starting organizations at the deadline, says how many it left, and the next day starts with them', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-11-17T08:00:00.000Z'));
    cost.ms = 100_000;
    const table = cronAttemptsTable();
    adminHolder.client = client(table);

    expect(await (await get()).json()).toMatchObject({ orgsProcessed: 3, leftForNextRun: 3 });
    expect(archivedIn).toEqual(['org-1', 'org-2', 'org-3']);
    expect(logLine()).toMatchObject({ candidates: 6, leftForNextRun: 3 });

    archivedIn.length = 0;
    vi.setSystemTime(Date.parse('2026-11-18T08:00:00.000Z'));
    await get();
    expect(archivedIn).toEqual(['org-4', 'org-5', 'org-6']);
  });

  it('one tick delivered twice: each organization is archived and told once', async () => {
    cost.wait = true;
    adminHolder.client = client(cronAttemptsTable());
    await Promise.all([get(), get()]);
    expect([...archivedIn].sort()).toEqual(ORGS);
    expect([...notified].sort()).toEqual(ORGS);
  });
});
