import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, type MockCall } from '@/test/supabase-mock';

/**
 * The daily automatic-reordering cron's notice to the organization's owners
 * and admins (B105). It counted the purchase orders the run marked as
 * ordered as "sent" ("Auto-reorder created 3 purchase orders, 1 sent."), but
 * what the run does in that mode is the status change Mark as ordered makes
 * (runAutoReorder's updateStatus 'ordered'): nothing is sent to a supplier,
 * so the supplier never hears of an order the notice called sent.
 */

vi.mock('@/lib/env', () => ({ env: { CRON_SECRET: 'test-cron-secret' } }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));

const adminHolder = { client: null as unknown };
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn(() => adminHolder.client) }));

const createNotification = vi.fn(async (_args: unknown) => 'notif-id');
vi.mock('@/server/services/notifications', () => ({
  createNotification: (args: unknown) => createNotification(args),
}));

type RunSummary = {
  created: number;
  sent: number;
  heldForReview: number;
  skippedDuplicate: number;
  skippedNoSupplier: number;
  supplierFailures: number;
};
const summaryHolder = { summary: null as RunSummary | null };
vi.mock('@/server/services/purchase-orders', () => ({
  PurchaseOrdersService: class {
    async runAutoReorder() {
      return summaryHolder.summary;
    }
  },
}));

vi.mock('@stockpilot/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stockpilot/core')>();
  return { ...actual, planAllowsAutoReorder: () => true };
});

import { GET } from './route';

const NONE: RunSummary = {
  created: 0,
  sent: 0,
  heldForReview: 0,
  skippedDuplicate: 0,
  skippedNoSupplier: 0,
  supplierFailures: 0,
};

function run(summary: RunSummary) {
  summaryHolder.summary = summary;
  adminHolder.client = makeSupabaseStub({
    // The settings read (one organization that turned automatic reordering
    // on, in the mode that marks purchase orders as ordered), then the
    // organization's enabled modules.
    'organization_modules.select': (call: MockCall) =>
      call.args[0]?.[0] === 'organization_id, settings'
        ? {
            data: [
              {
                organization_id: 'org-1',
                settings: { autoReorder: { enabled: true, mode: 'send', maxAutoSendCents: null } },
              },
            ],
            error: null,
          }
        : { data: [{ module_id: 'purchase_orders' }], error: null },
    'organizations.select': { data: { plan: 'pro' }, error: null },
    'organization_members.select': { data: [{ user_id: 'admin-1', role: 'owner' }], error: null },
  }).client;
  return GET(
    new Request('https://test.local/api/cron/auto-reorder', {
      headers: { authorization: 'Bearer test-cron-secret' },
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/cron/auto-reorder — the admins’ notice', () => {
  it('says the purchase orders it marked as ordered were marked as ordered, never sent', async () => {
    const res = await run({ ...NONE, created: 3, sent: 1, heldForReview: 2 });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ orgsProcessed: 1, posCreated: 3, posSent: 1 });
    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(createNotification).toHaveBeenCalledWith({
      organizationId: 'org-1',
      userId: 'admin-1',
      type: 'purchase_order.auto_reorder',
      title: 'Automatic reorder ran',
      body: 'Auto-reorder created 3 purchase orders, 1 marked as ordered, 2 held for review.',
      link: '/dashboard/purchase-orders',
    });
  });

  it('says nothing of marking when the run only drafted, and stays quiet when it created nothing', async () => {
    await run({ ...NONE, created: 1 });
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'Auto-reorder created 1 purchase order.' }),
    );

    createNotification.mockClear();
    await run(NONE);
    expect(createNotification).not.toHaveBeenCalled();
  });
});
