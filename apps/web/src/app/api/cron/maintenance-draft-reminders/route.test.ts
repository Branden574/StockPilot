import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

/**
 * Unsent-draft reminder cron (Task 22). Clones the schedule-reminders
 * skeleton's guarded behaviors for a single-recipient, no-email case:
 *   - crash-safe dedupe: draft_reminder_sent_at is stamped BEFORE
 *     createNotification, and a 0-row match on the guarded update sends
 *     NOTHING (2026-07-11 duplicate-bug guard, cloned here),
 *   - the eligibility query shape (status='saved', created_at < 24h ago,
 *     draft_reminder_sent_at is null, not archived/cancelled, limit 200)
 *     is pinned via call-recording — this repo's supabase mock replays
 *     canned rows without PostgREST filtering,
 *   - recipient = requester_user_id only, pref-gated fail-open on
 *     push_maintenance_draft_reminder,
 *   - copy is verbatim per the brief.
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

function stubFor(rows: unknown[], overrides: Record<string, { data: unknown; error: null } | (() => { data: unknown; error: null })> = {}) {
  return makeSupabaseStub({
    'maintenance_requests.select': { data: rows, error: null },
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
    const rows = [draftRow()];
    const stub = stubFor(rows);
    adminHolder.client = stub.client;

    const res = await GET(buildRequest('Bearer test-cron-secret'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, remindersSent: 1 });

    // Eligibility predicate, pinned via call-recording (the mock replays
    // canned rows without applying real PostgREST filters).
    const selectChain = stub.chains.get('maintenance_requests.select');
    expect(selectChain).toEqual(['select', 'eq', 'lt', 'is', 'is', 'is', 'limit']);
    const selectArgs = stub.chainArgs.get('maintenance_requests.select') ?? [];
    expect(selectArgs[selectChain!.indexOf('eq')]).toEqual(['status', 'saved']);
    expect(selectArgs[selectChain!.indexOf('lt')]?.[0]).toBe('created_at');
    expect(typeof selectArgs[selectChain!.indexOf('lt')]?.[1]).toBe('string');
    expect(selectArgs[3]).toEqual(['draft_reminder_sent_at', null]);
    expect(selectArgs[4]).toEqual(['archived_at', null]);
    expect(selectArgs[5]).toEqual(['cancelled_at', null]);
    expect(selectArgs[6]).toEqual([200]);

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
});
