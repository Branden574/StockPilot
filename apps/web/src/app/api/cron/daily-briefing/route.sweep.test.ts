import type { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { cronAttemptsTable } from '@/test/cron-attempts-table';
import { makeSupabaseStub } from '@/test/supabase-mock';

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

function client(table: ReturnType<typeof cronAttemptsTable>) {
  return makeSupabaseStub({
    ...table.results,
    'organization_modules.select': (call) =>
      call.methods.includes('range')
        ? { data: ORGS.map((id) => ({ organization_id: id })), error: null }
        : { data: [{ module_id: 'ai' }, { module_id: 'inventory' }], error: null },
    'organization_members.select': { data: [{ user_id: 'admin-1', role: 'owner' }], error: null },
    // No briefing yet today for anyone (the per-user check).
    'notifications.select': { data: [], error: null },
  }).client;
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
});
