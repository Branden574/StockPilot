import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

/**
 * Unsent-draft reminder cron (Task 22). Clones the schedule-reminders
 * skeleton's guarded behaviors for a single-recipient, no-email case:
 *   - crash-safe dedupe: draft_reminder_sent_at is stamped BEFORE
 *     createNotification, and a 0-row match on the guarded update sends
 *     NOTHING (2026-07-11 duplicate-bug guard, cloned here),
 *   - the eligibility query shape (status='saved', created_at < 24h ago,
 *     draft_reminder_sent_at is null, not archived/cancelled, org module
 *     enabled, limit 200) is pinned via call-recording — this repo's
 *     supabase mock replays canned rows without PostgREST filtering,
 *   - recipient = requester_user_id only, pref-gated fail-open on
 *     push_maintenance_draft_reminder,
 *   - copy is verbatim per the brief.
 *
 * Fast-follow (final-review finding): the eligibility query had no
 * module-enabled check — a stamped-but-disabled row could still fire. The
 * fix prefetches the org allowlist (organization_modules) and filters the
 * eligibility SELECT with `.in('organization_id', ...)` BEFORE anything is
 * stamped, so a module-OFF org's row is skipped entirely (no stamp, no
 * notify) — the reminder revives on its own if the module is re-enabled,
 * rather than being permanently silenced. `stubFor` defaults the allowlist
 * to every org the passed rows belong to (so the pre-existing tests below
 * don't need to know this query exists); pass `{ enabledOrgIds: [...] }`
 * explicitly to exercise the module-OFF path.
 */

vi.mock('@/lib/env', () => ({
  env: {
    CRON_SECRET: 'test-cron-secret',
    NEXT_PUBLIC_APP_URL: 'https://stockpilotusa.com',
  },
}));

vi.mock('@/lib/error-reporter', () => ({
  reportError: vi.fn(),
}));

const adminHolder = { client: null as unknown };
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => adminHolder.client),
}));

// Shared order log: both the guarded-update result and createNotification
// push into this so the test can assert stamp-BEFORE-notify by sequence,
// not just by "both got called".
let callOrder: string[] = [];

const createNotificationMock = vi.fn(async (_args: unknown) => {
  callOrder.push('notify');
  return 'notif-id';
});
vi.mock('@/server/services/notifications', () => ({
  createNotification: (args: unknown) => createNotificationMock(args),
}));

import { GET } from './route';

function buildRequest(authHeader?: string) {
  return new Request('https://test.local/api/cron/maintenance-draft-reminders', {
    method: 'GET',
    headers: authHeader ? { authorization: authHeader } : {},
  });
}

function draftRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mr-1',
    organization_id: 'org-1',
    requester_user_id: 'user-req',
    request_number: 42,
    created_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

function stubFor(
  rows: unknown[],
  overrides: Record<string, { data: unknown; error: null } | (() => { data: unknown; error: null })> = {},
  opts: { enabledOrgIds?: string[] } = {},
) {
  // Module allowlist default: every org the passed rows belong to is
  // treated as module-enabled, so tests that predate the module-gate fix
  // don't have to know this query exists. Pass opts.enabledOrgIds (e.g.
  // []) explicitly to model a module-OFF org.
  const enabledOrgIds =
    opts.enabledOrgIds ??
    Array.from(
      new Set(
        rows
          .map((r) => (r as { organization_id?: string }).organization_id)
          .filter((id): id is string => Boolean(id)),
      ),
    );
  return makeSupabaseStub({
    'maintenance_requests.select': { data: rows, error: null },
    'organization_modules.select': {
      data: enabledOrgIds.map((organization_id) => ({ organization_id })),
      error: null,
    },
    // The stamp-guard update: returning a row means we won the write.
    'maintenance_requests.update': () => {
      callOrder.push('update');
      return { data: [{ id: (rows[0] as { id?: string } | undefined)?.id ?? 'mr-1' }], error: null };
    },
    'notification_preferences.select': { data: [], error: null },
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  callOrder = [];
});

describe('GET /api/cron/maintenance-draft-reminders', () => {
  it('returns 401 without the cron secret (fail-closed)', async () => {
    adminHolder.client = stubFor([]).client;
    expect((await GET(buildRequest())).status).toBe(401);
    expect((await GET(buildRequest('Bearer wrong'))).status).toBe(401);
    expect(createNotificationMock).not.toHaveBeenCalled();
  });

  it('stamps draft_reminder_sent_at BEFORE createNotification and pins the eligibility query shape', async () => {
    // FIX 1: Pin the 24h cutoff magnitude using fake timers
    const fixedTime = new Date('2026-08-06T12:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(fixedTime);

    const rows = [draftRow()];
    const stub = stubFor(rows);
    adminHolder.client = stub.client;

    const res = await GET(buildRequest('Bearer test-cron-secret'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, remindersSent: 1 });

    // Eligibility predicate, pinned via call-recording (the mock replays
    // canned rows without applying real PostgREST filters).
    const selectChain = stub.chains.get('maintenance_requests.select');
    expect(selectChain).toEqual(['select', 'eq', 'lt', 'is', 'is', 'is', 'is', 'in', 'limit']);
    const selectArgs = stub.chainArgs.get('maintenance_requests.select') ?? [];
    expect(selectArgs[selectChain!.indexOf('eq')]).toEqual(['status', 'saved']);
    expect(selectArgs[selectChain!.indexOf('lt')]?.[0]).toBe('created_at');
    // Pin the exact 24h cutoff: fixed time minus 24 hours
    const expectedCutoff = new Date(fixedTime.getTime() - 24 * 60 * 60 * 1000).toISOString();
    expect(selectArgs[selectChain!.indexOf('lt')]?.[1]).toBe(expectedCutoff);
    expect(selectArgs[3]).toEqual(['draft_reminder_sent_at', null]);
    expect(selectArgs[4]).toEqual(['archived_at', null]);
    expect(selectArgs[5]).toEqual(['cancelled_at', null]);
    // Maintenance Resolved (Task 4) defensive hedge — the reminders query
    // chain now includes .is('resolved_at', null) alongside the existing
    // saved/archived/cancelled pins.
    expect(selectArgs[6]).toEqual(['resolved_at', null]);
    // Module-gate fast-follow: the eligibility SELECT is filtered to the
    // module-enabled org allowlist BEFORE the row limit.
    expect(selectArgs[7]).toEqual(['organization_id', ['org-1']]);
    expect(selectArgs[8]).toEqual([200]);

    // The module allowlist query itself: enabled orgs for this module only.
    const modChain = stub.chains.get('organization_modules.select');
    expect(modChain).toEqual(['select', 'eq', 'eq', 'order', 'range']);
    const modArgs = stub.chainArgs.get('organization_modules.select') ?? [];
    expect(modArgs[modChain!.indexOf('eq')]).toEqual(['module_id', 'maintenance_requests']);
    expect(modArgs[modChain!.lastIndexOf('eq')]).toEqual(['enabled', true]);

    // Stamp-FIRST dedupe: update runs, guarded on IS NULL, BEFORE select('id').
    const updateChain = stub.chains.get('maintenance_requests.update');
    expect(updateChain).toEqual(['update', 'eq', 'is', 'select']);
    const updateArgs = stub.chainArgs.get('maintenance_requests.update') ?? [];
    expect(updateArgs[0]?.[0]).toEqual({ draft_reminder_sent_at: expect.any(String) });
    expect(updateArgs[1]).toEqual(['id', 'mr-1']);
    expect(updateArgs[2]).toEqual(['draft_reminder_sent_at', null]);

    // The order assertion the 2026-07-11 duplicate-bug guard requires:
    // the stamp resolves BEFORE createNotification is ever called.
    expect(callOrder).toEqual(['update', 'notify']);

    expect(createNotificationMock).toHaveBeenCalledTimes(1);
    const call = createNotificationMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(call).toMatchObject({
      organizationId: 'org-1',
      userId: 'user-req',
      link: '/dashboard/maintenance/mr-1',
    });

    vi.useRealTimers();
  });

  it('sends NOTHING when the guarded update matches 0 rows (another instance already won)', async () => {
    const stub = stubFor([draftRow()], {
      'maintenance_requests.update': { data: null, error: null },
    });
    adminHolder.client = stub.client;

    const res = await GET(buildRequest('Bearer test-cron-secret'));
    expect(await res.json()).toMatchObject({ ok: true, remindersSent: 0 });
    expect(createNotificationMock).not.toHaveBeenCalled();
  });

  it('notification copy matches the brief verbatim (sweep: no "Email sent", no "ticket")', async () => {
    const createdAt = new Date(Date.now() - 30 * 60 * 60 * 1000);
    const rows = [draftRow({ id: 'mr-9', request_number: 7, created_at: createdAt.toISOString() })];
    const stub = stubFor(rows);
    adminHolder.client = stub.client;

    await GET(buildRequest('Bearer test-cron-secret'));

    const handle = `MR-${createdAt.getUTCFullYear()}-000007`;
    expect(createNotificationMock).toHaveBeenCalledTimes(1);
    const call = createNotificationMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.title).toBe(`Reminder: finish your ${handle} draft`);
    expect(call.body).toBe(
      `Your maintenance request ${handle} was saved, but no email draft has been opened yet. Open it in StockPilot to finish sending it to DC4.`,
    );
    expect(call.link).toBe('/dashboard/maintenance/mr-9');
    expect(call.body).not.toMatch(/email sent/i);
    expect(call.body).not.toMatch(/ticket/i);
    expect(call.title).not.toMatch(/email sent/i);
    expect(call.title).not.toMatch(/ticket/i);
  });

  it('mutes a requester with push_maintenance_draft_reminder=false', async () => {
    const stub = stubFor([draftRow()], {
      'notification_preferences.select': {
        data: [{ user_id: 'user-req', push_maintenance_draft_reminder: false }],
        error: null,
      },
    });
    adminHolder.client = stub.client;

    const res = await GET(buildRequest('Bearer test-cron-secret'));
    expect(await res.json()).toMatchObject({ ok: true, remindersSent: 0 });
    expect(createNotificationMock).not.toHaveBeenCalled();

    // The dedupe stamp still wins regardless of the pref mute — the row is
    // marked handled either way, never re-evaluated tomorrow.
    const updateChain = stub.chains.get('maintenance_requests.update');
    expect(updateChain).toContain('update');
  });

  it('fail-open: a missing notification_preferences row still sends the reminder', async () => {
    const stub = stubFor([draftRow()], {
      'notification_preferences.select': { data: null, error: null },
    });
    adminHolder.client = stub.client;

    await GET(buildRequest('Bearer test-cron-secret'));
    expect(createNotificationMock).toHaveBeenCalledTimes(1);
  });

  it('FIX 2: null-requester guard—rows with no requester_user_id are stamped but produce zero notifications (continue, not abort)', async () => {
    // Two rows: first has null requester, second is valid.
    // Proves: (1) null-requester row gets stamped (update called), (2) no notification for it,
    // (3) loop continues to next row, (4) second row DOES get notified.
    const nullRequesterRow = draftRow({ id: 'mr-no-req', requester_user_id: null });
    const validRow = draftRow({ id: 'mr-valid', requester_user_id: 'user-valid' });
    const rows = [nullRequesterRow, validRow];

    let updateCount = 0;
    const stub = stubFor(rows, {
      'maintenance_requests.update': () => {
        updateCount++;
        callOrder.push('update');
        // Return the row that matches by id in the iteration.
        const currentId = rows[updateCount - 1]?.id ?? 'mr-1';
        return { data: [{ id: currentId }], error: null };
      },
    });
    adminHolder.client = stub.client;

    const res = await GET(buildRequest('Bearer test-cron-secret'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, remindersSent: 1 });

    // Both rows should have been stamped (update called twice).
    expect(updateCount).toBe(2);

    // But only the valid row should trigger a notification (1 call, not 2).
    expect(createNotificationMock).toHaveBeenCalledTimes(1);
    const call = createNotificationMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.userId).toBe('user-valid');
    expect(call.organizationId).toBe('org-1');

    // Call order proves: stamp #1 (null-req row) → stamp #2 (valid row) → notify (valid only).
    expect(callOrder).toContain('update');
    expect(callOrder[callOrder.length - 1]).toBe('notify');
  });

  it('FIX 3 (fast-follow): an eligible row in a module-OFF org sends NOTHING and is NOT stamped', async () => {
    // org-1 has an otherwise-eligible saved row, but the module allowlist is
    // empty — org-1 does not have maintenance_requests enabled. The org
    // allowlist is fetched and filtered BEFORE the eligibility SELECT runs,
    // so a module-OFF org's row never even enters the query result: no
    // stamp, no notification. This also means re-enabling the module later
    // makes the row eligible again on the next run (chosen over stamping,
    // so the reminder revives instead of being silenced permanently).
    const stub = stubFor([draftRow()], {}, { enabledOrgIds: [] });
    adminHolder.client = stub.client;

    const res = await GET(buildRequest('Bearer test-cron-secret'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, remindersSent: 0 });
    expect(createNotificationMock).not.toHaveBeenCalled();

    // Not stamped: the eligibility query — and therefore the per-row update
    // loop — never ran, because the org allowlist came back empty.
    expect(stub.chains.get('maintenance_requests.select')).toBeUndefined();
    expect(stub.chains.get('maintenance_requests.update')).toBeUndefined();
    expect(callOrder).toEqual([]);

    // The allowlist query itself still ran and was correctly scoped.
    const modChain = stub.chains.get('organization_modules.select');
    expect(modChain).toEqual(['select', 'eq', 'eq', 'order', 'range']);
  });
});
