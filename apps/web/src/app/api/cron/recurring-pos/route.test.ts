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
  templatesSkipped: [],
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

/**
 * A template whose purchase order the save refused (its destination deleted
 * after it was saved, ...) or could not make: the run names it with why
 * (templatesSkipped, recurring-pos.run-skips.test.ts). The cron tells the
 * organization's owners and admins, as for every notice, AND the template's
 * creator, who may be a manager: the person who set the template up is the
 * one who will fix it. Each person once; a creator who is no longer an
 * accepted member of the organization is not told.
 */
describe('GET /api/cron/recurring-pos — a skipped template is told to its creator too', () => {
  const MEMBERS = [
    { user_id: 'admin-1', role: 'owner', accepted: true },
    { user_id: 'manager-1', role: 'manager', accepted: true },
    { user_id: 'left-1', role: 'manager', accepted: false },
  ];

  /** organization_members as each read asks: by role (owners and admins),
   *  or by user id (the creators), accepted members only. */
  function members(call: { methods: string[]; args: unknown[][] }) {
    const ins = call.methods
      .map((m, i) => (m === 'in' ? (call.args[i] as [string, string[]]) : null))
      .filter((x): x is [string, string[]] => x !== null);
    const byRole = ins.find(([col]) => col === 'role')?.[1];
    const byUser = ins.find(([col]) => col === 'user_id')?.[1];
    const rows = MEMBERS.filter(
      (m) => m.accepted && (!byRole || byRole.includes(m.role)) && (!byUser || byUser.includes(m.user_id)),
    ).map((m) => ({ user_id: m.user_id, role: m.role }));
    return { data: rows, error: null };
  }

  function runWith(summary: RecurringRunSummary) {
    summaryHolder.summary = summary;
    adminHolder.client = makeSupabaseStub({
      'organization_modules.select': { data: [{ organization_id: 'org-1', module_id: 'purchase_orders' }], error: null },
      'organizations.select': { data: { plan: 'pro' }, error: null },
      'organization_members.select': members,
    }).client;
    return GET(
      new Request('https://test.local/api/cron/recurring-pos', {
        headers: { authorization: 'Bearer test-cron-secret' },
      }),
    );
  }

  const skipped = (createdBy: string | null) => ({
    ...EMPTY,
    failures: 1,
    templatesSkipped: [
      {
        templateId: 'tpl-1',
        name: 'Annex Paper',
        reason: 'Its destination, "Old Annex", was deleted. Edit the template and choose another destination.',
        createdBy,
      },
    ],
  });

  const told = () => createNotification.mock.calls.map(([a]) => (a as { userId: string }).userId).sort();

  it('tells the owners and admins and the template creator, with the reason, and reports the skip in the run total', async () => {
    const res = await runWith(skipped('manager-1'));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ posCreated: 0, failures: 1, templatesSkipped: 1 });
    expect(told()).toEqual(['admin-1', 'manager-1']);
    for (const [args] of createNotification.mock.calls) {
      expect(args).toEqual(
        expect.objectContaining({
          organizationId: 'org-1',
          title: 'Recurring purchase orders need attention',
          body: '"Annex Paper" created no purchase order. Its destination, "Old Annex", was deleted. Edit the template and choose another destination.',
          link: '/dashboard/purchase-orders',
        }),
      );
    }
  });

  it('a creator who is also an owner or admin is told once', async () => {
    await runWith(skipped('admin-1'));
    expect(told()).toEqual(['admin-1']);
  });

  it('a creator who is no longer an accepted member, or none recorded, is not told', async () => {
    await runWith(skipped('left-1'));
    expect(told()).toEqual(['admin-1']);
    createNotification.mockClear();
    await runWith(skipped(null));
    expect(told()).toEqual(['admin-1']);
  });
});
