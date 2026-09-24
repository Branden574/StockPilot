import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

import type { RecurringRunSummary } from '@/server/services/recurring-pos';

/**
 * The daily recurring-PO cron told the admins only when a PO was created.
 * A template whose lines were left off (a deleted item, a kit's
 * pre-assembled stock) ordered less than it says with no word to anyone, and
 * one with nothing orderable left created nothing and notified nobody, every
 * period. The notice now comes from recurringRunNotice (tested with the
 * service); this pins that the route sends it in both cases and stays quiet
 * when there is nothing to say.
 */

vi.mock('@/lib/env', () => ({ env: { CRON_SECRET: 'test-cron-secret' } }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));

const adminHolder = { client: null as unknown };
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn(() => adminHolder.client) }));

const createNotification = vi.fn(async (_args: unknown) => 'notif-id');
vi.mock('@/server/services/notifications', () => ({
  createNotification: (args: unknown) => createNotification(args),
}));

const summaryHolder = { summary: null as RecurringRunSummary | null };
vi.mock('@/server/services/recurring-pos', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/services/recurring-pos')>();
  return {
    ...actual,
    RecurringPoTemplatesService: class {
      async runDueTemplates() {
        return summaryHolder.summary;
      }
    },
  };
});

vi.mock('@stockpilot/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stockpilot/core')>();
  return { ...actual, planAllowsRecurringPos: () => true };
});

import { GET } from './route';

const EMPTY: RecurringRunSummary = {
  created: 0,
  sent: 0,
  heldForReview: 0,
  failures: 0,
  linesLeftOff: 0,
  templatesWithLinesLeftOff: [],
  templatesWithNothingOrderable: [],
};

function run(summary: RecurringRunSummary) {
  summaryHolder.summary = summary;
  adminHolder.client = makeSupabaseStub({
    'organization_modules.select': { data: [{ organization_id: 'org-1', module_id: 'purchase_orders' }], error: null },
    'organizations.select': { data: { plan: 'pro' }, error: null },
    'organization_members.select': { data: [{ user_id: 'admin-1', role: 'owner' }], error: null },
  }).client;
  return GET(
    new Request('https://test.local/api/cron/recurring-pos', {
      headers: { authorization: 'Bearer test-cron-secret' },
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/cron/recurring-pos — admin notification', () => {
  it('notifies when a template created nothing because none of its lines can be ordered', async () => {
    const res = await run({
      ...EMPTY,
      failures: 1,
      linesLeftOff: 1,
      templatesWithLinesLeftOff: ['Monthly Pens'],
      templatesWithNothingOrderable: ['Monthly Pens'],
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ posCreated: 0, linesLeftOff: 1 });
    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        userId: 'admin-1',
        title: 'Recurring purchase orders need attention',
        body: expect.stringContaining('"Monthly Pens" created no purchase order'),
        link: '/dashboard/purchase-orders',
      }),
    );
  });

  it('says what was left off when POs were created', async () => {
    await run({ ...EMPTY, created: 1, linesLeftOff: 1, templatesWithLinesLeftOff: ['Weekly Supplies'] });

    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Recurring purchase orders ran',
        body: expect.stringContaining('1 template line was left off ("Weekly Supplies")'),
      }),
    );
  });

  it('stays quiet when nothing was created and nothing was left off', async () => {
    await run(EMPTY);
    expect(createNotification).not.toHaveBeenCalled();
  });
});
