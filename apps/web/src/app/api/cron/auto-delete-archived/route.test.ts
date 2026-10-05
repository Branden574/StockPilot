import type { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

/**
 * The daily auto-delete of long-archived items (L15): items kept because they
 * still hold stock are counted in the response and in one log line per run,
 * counts only.
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

vi.mock('@/server/loaders/inventory-list', () => ({ revalidateInventoryList: vi.fn() }));

const purge = vi.hoisted(() => vi.fn());
vi.mock('@/server/services/archive-cleanup', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/server/services/archive-cleanup')>();
  return { ...real, purgeExpiredArchivedItems: purge };
});

import { GET } from './route';

function req(): NextRequest {
  return new Request('https://test.local/api/cron/auto-delete-archived', {
    headers: { authorization: 'Bearer test-cron-secret' },
  }) as unknown as NextRequest;
}

let info: MockInstance<Console['info']>;

beforeEach(() => {
  vi.clearAllMocks();
  envHolder.env = { CRON_SECRET: 'test-cron-secret' };
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
  adminHolder.client = makeSupabaseStub({
    'organization_modules.select': (call) =>
      call.methods.includes('range')
        ? {
            data: [
              { organization_id: 'o1', settings: { autoDeleteArchived: { enabled: true, days: 90 } } },
              { organization_id: 'o2', settings: { autoDeleteArchived: { enabled: true, days: 30 } } },
            ],
            error: null,
          }
        : { data: [{ module_id: 'inventory' }], error: null },
    'organization_members.select': { data: [{ user_id: 'u1', role: 'owner' }], error: null },
  }).client;
});

afterEach(() => {
  info.mockRestore();
});

describe('GET /api/cron/auto-delete-archived', () => {
  it('reports the items kept for their stock in the response and in one log line', async () => {
    purge
      .mockResolvedValueOnce({ deleted: 2, ids: ['a', 'b'], truncated: false, failed: 0, skipped: 3 })
      .mockResolvedValueOnce({ deleted: 0, ids: [], truncated: false, failed: 0, skipped: 1 });

    const res = await GET(req() as unknown as Request);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ orgsProcessed: 2, itemsDeleted: 2, itemsSkipped: 4 });
    const lines = info.mock.calls.filter((args: unknown[]) => args[0] === '[cron.auto-delete-archived]');
    expect(lines).toHaveLength(1);
    const logged = JSON.parse(String(lines[0]?.[1])) as Record<string, unknown>;
    expect(logged).toMatchObject({ itemsDeleted: 2, itemsSkipped: 4 });
    // Counts only: no ids or org ids in the line.
    expect(String(lines[0]?.[1])).not.toMatch(/o1|o2|"a"|"b"/);
  });
});
