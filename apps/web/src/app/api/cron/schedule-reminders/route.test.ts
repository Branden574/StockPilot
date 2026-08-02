import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

/**
 * Schedule-reminders cron wiring — the es-template swap must NOT change
 * the guarded behaviors:
 *   - crash-safe dedupe: reminded_*_at is stamped BEFORE sending and the
 *     send is skipped when another run won the stamp,
 *   - the 24h notice never follows a 1h notice (owner-reported duplicate,
 *     2026-07-11),
 *   - recipients = assignee + owner/admin/manager, deduped, pref-gated
 *     fail-open,
 *   - emails now render via the es schedule family: schedule@ sender,
 *     registry subject (byte-identical to the legacy subject), pref
 *     footer, List-Unsubscribe header.
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

const createNotificationMock = vi.fn(async (_args: unknown) => undefined);
vi.mock('@/server/services/notifications', () => ({
  createNotification: (args: unknown) => createNotificationMock(args),
}));

interface SendEmailArgs {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  from?: string;
  headers?: Record<string, string>;
}
const sendEmailMock = vi.fn(async (_args: SendEmailArgs) => ({ ok: true }));
vi.mock('@/lib/email/resend', () => ({
  sendEmail: (args: SendEmailArgs) => sendEmailMock(args),
}));

import { GET } from './route';

function buildRequest(authHeader?: string) {
  return new Request('https://test.local/api/cron/schedule-reminders', {
    method: 'GET',
    headers: authHeader ? { authorization: authHeader } : {},
  });
}

function eventIn(hoursFromNow: number, overrides: Record<string, unknown> = {}) {
  return {
    id: 'ev-1',
    organization_id: 'org-1',
    title: 'Cycle count — Aisle 4',
    starts_at: new Date(Date.now() + hoursFromNow * 60 * 60 * 1000).toISOString(),
    ends_at: null,
    all_day: false,
    location_text: 'DCIV — Fresno',
    details: 'Full count of bin locations A4-01 through A4-36.',
    warehouse_id: null,
    assigned_user_id: 'user-assignee',
    reminded_24h_at: null,
    reminded_1h_at: null,
    ...overrides,
  };
}

function stubFor(events: unknown[], extra: Record<string, { data: unknown; error: null }> = {}) {
  return makeSupabaseStub({
    'schedule_events.select': { data: events, error: null },
    // The stamp-guard update: returning a row means we won the write.
    'schedule_events.update': { data: [{ id: 'ev-1' }], error: null },
    'organization_members.select': {
      data: [{ user_id: 'user-manager' }],
      error: null,
    },
    'user_profiles.select': {
      data: [
        { id: 'user-assignee', email: 'assignee@l4l.example', full_name: 'Theo Marsh' },
        { id: 'user-manager', email: 'manager@l4l.example', full_name: 'Dana Reyes' },
      ],
      error: null,
    },
    'notification_preferences.select': { data: [], error: null },
    ...extra,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/cron/schedule-reminders', () => {
  it('returns 401 without the cron secret (fail-closed)', async () => {
    adminHolder.client = stubFor([]).client;
    expect((await GET(buildRequest())).status).toBe(401);
    expect((await GET(buildRequest('Bearer wrong'))).status).toBe(401);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('sends the 1h reminder via the es sched-hour template to assignee + managers', async () => {
    const stub = stubFor([eventIn(0.5)]);
    adminHolder.client = stub.client;

    const res = await GET(buildRequest('Bearer test-cron-secret'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, remindersSent: 1 });

    // Dedupe stamp direction unchanged: update FIRST, guarded on null.
    const updateChain = stub.chains.get('schedule_events.update');
    expect(updateChain).toContain('update');
    expect(updateChain).toContain('is');
    const updateArgs = stub.chainArgs.get('schedule_events.update') ?? [];
    expect(updateArgs[0]?.[0]).toEqual({ reminded_1h_at: expect.any(String) });
    expect(updateArgs[updateChain!.indexOf('is')]).toEqual(['reminded_1h_at', null]);

    // Both recipients, deduped.
    expect(sendEmailMock).toHaveBeenCalledTimes(2);
    const sends = sendEmailMock.mock.calls.map((c) => c[0]);
    expect(new Set(sends.map((s) => s.to))).toEqual(
      new Set(['assignee@l4l.example', 'manager@l4l.example']),
    );
    for (const s of sends) {
      // Subject byte-identical to the legacy `Reminder: ${title} — in 1 hour`.
      expect(s.subject).toBe('Reminder: Cycle count — Aisle 4 — in 1 hour');
      expect(s.from).toBe('StockPilot <schedule@stockpilotusa.com>');
      expect(s.headers).toEqual({
        'List-Unsubscribe': '<https://stockpilotusa.com/dashboard/settings/notifications>',
      });
      // es template, not the old one-line <p><strong> body.
      expect(s.html).toContain('<!doctype html>');
      expect(s.html).toContain('class="warnpill"');
      expect(s.html).toContain('clock@2x.gif');
      expect(s.html).toContain('Manage email preferences');
      expect(s.html).toContain('https://stockpilotusa.com/dashboard/schedule/ev-1');
      expect(s.html).not.toContain('<p><strong>');
    }
    // "Assigned to you" only for the assignee.
    const assigneeSend = sends.find((s) => s.to === 'assignee@l4l.example')!;
    const managerSend = sends.find((s) => s.to === 'manager@l4l.example')!;
    expect(assigneeSend.html).toContain('Assigned to you');
    expect(managerSend.html).not.toContain('Assigned to you');
    // Personal greeting from full_name.
    expect(assigneeSend.html).toContain('Hi Theo &mdash;');
    expect(managerSend.html).toContain('Hi Dana &mdash;');

    // In-app notification wording unchanged.
    expect(createNotificationMock).toHaveBeenCalledTimes(2);
  });

  it('sends the 24h reminder via the es sched-tmrw template', async () => {
    const stub = stubFor([eventIn(20)]);
    adminHolder.client = stub.client;

    const res = await GET(buildRequest('Bearer test-cron-secret'));
    expect(await res.json()).toMatchObject({ ok: true, remindersSent: 1 });

    const updateArgs = stub.chainArgs.get('schedule_events.update') ?? [];
    expect(updateArgs[0]?.[0]).toEqual({ reminded_24h_at: expect.any(String) });

    const s = sendEmailMock.mock.calls[0]![0];
    expect(s.subject).toBe('Reminder: Cycle count — Aisle 4 — tomorrow');
    expect(s.html).toContain('class="infopill"');
    expect(s.html).toContain('calendar@2x.gif');
    // Full (non-compact) event card renders the details row.
    expect(s.html).toContain('Full count of bin locations A4-01 through A4-36.');
  });

  it('never sends a late 24h notice after the 1h notice (two-horizon guard)', async () => {
    const stub = stubFor([eventIn(20, { reminded_1h_at: '2026-07-19T00:00:00Z' })]);
    adminHolder.client = stub.client;

    const res = await GET(buildRequest('Bearer test-cron-secret'));
    expect(await res.json()).toMatchObject({ ok: true, remindersSent: 0 });
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(createNotificationMock).not.toHaveBeenCalled();
  });

  it('skips the send when another run won the dedupe stamp', async () => {
    const stub = stubFor([eventIn(0.5)], {
      'schedule_events.update': { data: null, error: null },
    });
    adminHolder.client = stub.client;

    const res = await GET(buildRequest('Bearer test-cron-secret'));
    expect(await res.json()).toMatchObject({ ok: true, remindersSent: 0 });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('sends neither push nor email to a disabled recipient, but still reaches an active one on the same event', async () => {
    // The account-disable program (migs 0308-0311) blocks reads via RLS,
    // but this cron runs as service-role and previously ignored
    // disabled_at entirely — a disabled manager kept getting the reminder
    // push AND the reminder email for every upcoming event in the org.
    const stub = stubFor([eventIn(0.5)], {
      'user_profiles.select': {
        data: [
          {
            id: 'user-assignee',
            email: 'assignee@l4l.example',
            full_name: 'Theo Marsh',
            disabled_at: null,
          },
          {
            id: 'user-manager',
            email: 'manager@l4l.example',
            full_name: 'Dana Reyes',
            disabled_at: '2026-07-30T00:00:00Z',
          },
        ],
        error: null,
      },
    });
    adminHolder.client = stub.client;

    await GET(buildRequest('Bearer test-cron-secret'));

    expect(createNotificationMock).toHaveBeenCalledTimes(1);
    expect(createNotificationMock.mock.calls[0]![0]).toMatchObject({ userId: 'user-assignee' });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0]![0].to).toBe('assignee@l4l.example');
  });

  it('respects an explicit email opt-out but keeps push (pref gating unchanged)', async () => {
    const stub = stubFor([eventIn(0.5)], {
      'notification_preferences.select': {
        data: [
          {
            user_id: 'user-assignee',
            email_schedule_reminders: false,
            push_schedule_reminders: true,
          },
        ],
        error: null,
      },
    });
    adminHolder.client = stub.client;

    await GET(buildRequest('Bearer test-cron-secret'));
    // Assignee gets push only; manager (no pref row = fail-open) gets both.
    expect(createNotificationMock).toHaveBeenCalledTimes(2);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0]![0].to).toBe('manager@l4l.example');
  });
});
