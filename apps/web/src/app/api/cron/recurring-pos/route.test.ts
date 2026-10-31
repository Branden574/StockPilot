import { beforeEach, describe, expect, it, vi } from 'vitest';

import { reportError } from '@/lib/error-reporter';
import {
  inFilters,
  makeSupabaseStub,
  servedLikePostgrest,
  type MockCall,
  type QueryResult,
} from '@/test/supabase-mock';

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
  templatesSendFailed: [],
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
 * one who will fix it. Each person once; a creator who is not an accepted
 * member of this organization (another organization's member, a support
 * session) is not told.
 */
describe('GET /api/cron/recurring-pos — a skipped template is told to its creator too', () => {
  const ACCEPTED = '2026-01-01T00:00:00Z';
  const member = (
    organization_id: string,
    user_id: string,
    role: string,
    extra: { accepted_at?: string | null; impersonation_expires_at?: string } = {},
  ) => ({
    organization_id,
    user_id,
    role,
    accepted_at: ACCEPTED,
    impersonation_expires_at: null,
    ...extra,
  });
  /** organization_members as stored. Of the org-1 rows, only admin-1,
   *  manager-1, staff-1 and viewer-1 are accepted members: left-1 and
   *  invited-admin-1 have not accepted, and support-1 is a support session
   *  ("act as": a temporary owner row, accepted, with an expiry;
   *  services/platform/impersonation.ts). The org-2 rows are another
   *  organization's members. */
  const MEMBERS = [
    member('org-1', 'admin-1', 'owner'),
    member('org-1', 'manager-1', 'manager'),
    member('org-1', 'left-1', 'manager', { accepted_at: null }),
    member('org-1', 'staff-1', 'staff'),
    member('org-1', 'viewer-1', 'viewer'),
    member('org-1', 'invited-admin-1', 'admin', { accepted_at: null }),
    member('org-1', 'support-1', 'owner', { impersonation_expires_at: '2026-01-01T01:00:00Z' }),
    member('org-2', 'other-org-manager-1', 'manager'),
    member('org-2', 'other-org-owner-1', 'owner'),
  ];

  /** The organization's permission overrides for this run (none by default). */
  const overrides: {
    role: QueryResult | null;
    user: QueryResult | null;
  } = { role: null, user: null };
  /** When set, the read of the creators' memberships (by user id) fails with
   *  this error. The owners and admins read (by role) still answers. */
  const creatorsRead: { error: QueryResult['error'] } = { error: null };
  beforeEach(() => {
    overrides.role = null;
    overrides.user = null;
    creatorsRead.error = null;
  });

  /**
   * organization_members answered as PostgREST would: each read's own
   * filters (its organization, the roles or user ids it names, accepted, not
   * a support session), its limit and its selected columns are applied to
   * MEMBERS, so a read that drops a filter gets a row it must not and a test
   * fails. Evaluated here because servedLikePostgrest cannot evaluate `.not`;
   * any other method throws.
   */
  function members(call: MockCall): QueryResult {
    if (creatorsRead.error && inFilters(call).some(([col]) => col === 'user_id')) {
      return { data: null, error: creatorsRead.error };
    }
    let rows: Array<Record<string, unknown>> = [...MEMBERS];
    let columns: string[] = [];
    let limit = Infinity;
    call.methods.forEach((method, i) => {
      const [col, a, b] = (call.args[i] ?? []) as [string, unknown, unknown];
      const get = (r: Record<string, unknown>) => r[col] ?? null;
      switch (method) {
        case 'select':
          columns = col.split(',').map((c) => c.trim());
          if (!columns.every((c) => /^[a-z_]+$/.test(c))) {
            throw new Error(`members cannot select ${col}`);
          }
          break;
        case 'eq':
          rows = rows.filter((r) => get(r) === a);
          break;
        case 'in':
          rows = rows.filter((r) => (a as unknown[]).includes(get(r)));
          break;
        case 'is':
          rows = rows.filter((r) => get(r) === a);
          break;
        case 'not':
          if (a !== 'is' || b !== null) {
            throw new Error(`members cannot evaluate .not(${col}, ${String(a)}, ${String(b)})`);
          }
          rows = rows.filter((r) => get(r) !== null);
          break;
        case 'limit':
          limit = Number(col);
          break;
        default:
          throw new Error(`members cannot evaluate .${method}()`);
      }
    });
    return {
      data: rows.slice(0, limit).map((r) => Object.fromEntries(columns.map((c) => [c, r[c]]))),
      error: null,
    };
  }

  function runWith(summary: RecurringRunSummary) {
    summaryHolder.summary = summary;
    const served = (result: QueryResult | null) =>
      result === null
        ? servedLikePostgrest([])
        : result.error
          ? () => result
          : servedLikePostgrest(result.data as Array<Record<string, unknown>>);
    adminHolder.client = makeSupabaseStub({
      'organization_modules.select': { data: [{ organization_id: 'org-1', module_id: 'purchase_orders' }], error: null },
      'organizations.select': { data: { plan: 'pro' }, error: null },
      'organization_members.select': members,
      'role_permission_overrides.select': served(overrides.role),
      'user_permission_overrides.select': served(overrides.user),
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

  // The notice names three skipped templates and counts the rest, so the
  // creator of the fourth was told "1 more template" without its name. Each
  // creator's notice names every template of theirs first (slice 8 review).
  it("a creator is told their own template's name, even past the first three", async () => {
    await runWith({
      ...EMPTY,
      failures: 4,
      templatesSkipped: ['A', 'B', 'C', 'D'].map((name) => ({
        templateId: `tpl-${name}`,
        name,
        reason: 'An unexpected error stopped it. It runs again on its next date.',
        createdBy: name === 'D' ? 'manager-1' : 'admin-1',
      })),
    });
    const bodyFor = (userId: string) =>
      (createNotification.mock.calls.find(([a]) => (a as { userId: string }).userId === userId)?.[0] as { body: string })
        .body;
    expect(bodyFor('manager-1')).toMatch(/^"D" created no purchase order\./);
    expect(bodyFor('admin-1')).not.toContain('"D"');
    expect(bodyFor('admin-1')).toContain('1 more template created no purchase order.');
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

  // The creators' memberships are read in this organization only: a creator
  // who left it and is a manager of another organization would otherwise be
  // told this organization's skipped templates, by that membership's role.
  // And a support session ("act as") is not a member.
  it('a creator who is a manager of another organization only is not told', async () => {
    await runWith(skipped('other-org-manager-1'));
    expect(told()).toEqual(['admin-1']);
  });

  it('a creator seen only through a support session ("act as") is not told', async () => {
    await runWith(skipped('support-1'));
    expect(told()).toEqual(['admin-1']);
  });

  // The owners and admins are read the same way: this organization's
  // accepted members, never another organization's owner, an admin who has
  // not accepted, or a support session (an owner row with an expiry).
  it("a run's notice goes to this organization's accepted owners and admins only", async () => {
    await runWith({ ...EMPTY, created: 1 });
    expect(told()).toEqual(['admin-1']);
  });

  // A template is edited only with purchase_orders:manage (every
  // RecurringPoTemplatesService action and the Recurring page check it). A
  // creator moved to staff or viewer, or whose permission was taken away,
  // was still sent the organization's whole run notice and told to edit a
  // template they cannot open (slice 8 review). The creator is told only
  // while they hold it: role defaults, then the organization's role
  // overrides, then their own (the owner always), as the gate resolves it.
  describe('only while the creator can still edit templates (purchase_orders:manage)', () => {
    it('a creator moved to staff or viewer is not told', async () => {
      await runWith(skipped('staff-1'));
      expect(told()).toEqual(['admin-1']);
      createNotification.mockClear();
      await runWith(skipped('viewer-1'));
      expect(told()).toEqual(['admin-1']);
    });

    it('a manager whose permission was taken away is not told; a staff member granted it is', async () => {
      overrides.user = {
        data: [
          { organization_id: 'org-1', user_id: 'manager-1', permission: 'purchase_orders:manage', granted: false },
          { organization_id: 'org-1', user_id: 'staff-1', permission: 'purchase_orders:manage', granted: true },
          // Another organization's override never applies.
          { organization_id: 'org-2', user_id: 'viewer-1', permission: 'purchase_orders:manage', granted: true },
        ],
        error: null,
      };
      await runWith({
        ...EMPTY,
        failures: 3,
        templatesSkipped: [
          { templateId: 'tpl-1', name: 'Annex Paper', reason: 'Its destination was deleted.', createdBy: 'manager-1' },
          { templateId: 'tpl-2', name: 'Dock Tape', reason: 'Its destination was deleted.', createdBy: 'staff-1' },
          { templateId: 'tpl-3', name: 'Labels', reason: 'Its destination was deleted.', createdBy: 'viewer-1' },
        ],
      });
      expect(told()).toEqual(['admin-1', 'staff-1']);
    });

    it("an organization's role override that takes it from managers stops a manager creator", async () => {
      overrides.role = {
        data: [
          { organization_id: 'org-1', role: 'manager', permission: 'purchase_orders:manage', granted: false },
          // Another organization's override never applies.
          { organization_id: 'org-2', role: 'staff', permission: 'purchase_orders:manage', granted: true },
        ],
        error: null,
      };
      await runWith({
        ...EMPTY,
        failures: 2,
        templatesSkipped: [
          { templateId: 'tpl-1', name: 'Annex Paper', reason: 'Its destination was deleted.', createdBy: 'manager-1' },
          { templateId: 'tpl-2', name: 'Dock Tape', reason: 'Its destination was deleted.', createdBy: 'staff-1' },
        ],
      });
      expect(told()).toEqual(['admin-1']);
    });

    // A failed read used to fall back to the role's defaults, so a manager
    // whose purchase_orders:manage an override had taken away was still told,
    // and the notice names the organization's other skipped templates too.
    // A creator's notice is optional, so when the creator's membership or
    // either override cannot be read, no creator is told this run: the
    // failure is reported once, and the owners and admins (read by role,
    // before this) are told as always.
    describe('fails closed: a failed read tells no creator this run', () => {
      /** The same run each time: one skipped template, created by manager-1,
       *  a manager, who holds purchase_orders:manage by the role's defaults. */
      const runManagerTemplate = () => runWith(skipped('manager-1'));
      const permissionReports = () =>
        vi
          .mocked(reportError)
          .mock.calls.filter(([, context]) => context.tag === 'cron.recurring-pos.creator_permissions');
      const notice = (userId: string) =>
        createNotification.mock.calls.find(([a]) => (a as { userId: string }).userId === userId)?.[0];

      it('with every read OK, the manager creator is told (unchanged)', async () => {
        await runManagerTemplate();
        expect(told()).toEqual(['admin-1', 'manager-1']);
        expect(permissionReports()).toEqual([]);
      });

      it('with every read OK, a manager creator whose permission an override took away is not told', async () => {
        overrides.user = {
          data: [{ organization_id: 'org-1', user_id: 'manager-1', permission: 'purchase_orders:manage', granted: false }],
          error: null,
        };
        await runManagerTemplate();
        expect(told()).toEqual(['admin-1']);
        expect(permissionReports()).toEqual([]);
      });

      it.each([
        [
          'the role override read',
          () => {
            overrides.role = { data: null, error: { message: 'role overrides unavailable' } };
          },
          'role overrides unavailable',
        ],
        [
          'the member override read',
          () => {
            overrides.user = { data: null, error: { message: 'member overrides unavailable' } };
          },
          'member overrides unavailable',
        ],
        [
          "the read of the creators' memberships",
          () => {
            creatorsRead.error = { message: 'memberships unavailable' };
          },
          'memberships unavailable',
        ],
      ])(
        'when %s fails, the creator is not told, the owners and admins are, and it is reported once',
        async (_read, fail, message) => {
          fail();
          const res = await runManagerTemplate();

          expect(res.status).toBe(200);
          expect(await res.json()).toMatchObject({ failures: 1, templatesSkipped: 1 });
          expect(told()).toEqual(['admin-1']);
          expect(notice('admin-1')).toEqual(
            expect.objectContaining({
              organizationId: 'org-1',
              title: 'Recurring purchase orders need attention',
              body: expect.stringContaining('"Annex Paper" created no purchase order.'),
            }),
          );
          const reports = permissionReports();
          expect(reports).toHaveLength(1);
          expect((reports[0]?.[0] as Error).message).toBe(message);
          expect(reports[0]?.[1]).toEqual(
            expect.objectContaining({ level: 'warning', extra: expect.objectContaining({ orgId: 'org-1' }) }),
          );
        },
      );

      it('when every read fails, it is still reported once', async () => {
        overrides.role = { data: null, error: { message: 'role overrides unavailable' } };
        overrides.user = { data: null, error: { message: 'member overrides unavailable' } };
        creatorsRead.error = { message: 'memberships unavailable' };
        await runManagerTemplate();

        expect(told()).toEqual(['admin-1']);
        expect(permissionReports()).toHaveLength(1);
      });
    });
  });
});
