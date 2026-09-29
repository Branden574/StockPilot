import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A moved Schedule event is reminded again (F2 decision D23, correction 16).
 *
 * The reminder cron (api/cron/schedule-reminders) sends one day-ahead reminder
 * per event and remembers it in reminded_24h_at (and the one-hour reminder in
 * reminded_1h_at). It only sends a day-ahead reminder while BOTH stamps are
 * null. ScheduleService.update moved starts_at and left the stamps alone, so
 * an event that had been reminded for its old time was never reminded for its
 * new one: the cron read "already reminded" and skipped it for good.
 *
 * The fix: when an update moves starts_at, the same update clears both stamps.
 * The first test runs the real update() and then the real cron over the same
 * row, so it fails on the old code (the cron sends nothing) and passes only
 * when the stamps are cleared in the update itself.
 */

vi.mock('@/lib/env', () => ({
  env: { CRON_SECRET: 'test-cron-secret', NEXT_PUBLIC_APP_URL: 'https://stockpilotusa.com' },
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/lib/auth/warehouse', () => ({
  assertWarehouseAccess: vi.fn(),
  ForbiddenError: class ForbiddenError extends Error {},
}));
vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));
const adminHolder = { client: null as unknown };
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn(() => adminHolder.client) }));
const createNotificationMock = vi.fn(async (_args: unknown) => undefined);
vi.mock('@/server/services/notifications', () => ({
  createNotification: (args: unknown) => createNotificationMock(args),
}));
const sendEmailMock = vi.fn(async (_args: unknown) => ({ ok: true }));
vi.mock('@/lib/email/resend', () => ({ sendEmail: (args: unknown) => sendEmailMock(args) }));

import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

import { GET as runReminderCron } from '@/app/api/cron/schedule-reminders/route';
import {
  callArgs,
  makeServiceContext,
  makeSupabaseStub,
  servedLikePostgrest,
  type MockCall,
} from '@/test/supabase-mock';

import { ScheduleService } from './schedule';

const EVENT_ID = 'eeeeeeee-0000-4000-8000-000000000001';
const HOUR = 60 * 60 * 1000;
// The cron test's frozen clock (2026-08-24 13:20 PT); only Date is faked.
const NOW = new Date('2026-08-24T20:20:00.000Z');

type Row = Record<string, unknown>;

function eventRow(overrides: Row = {}): Row {
  return {
    id: EVENT_ID,
    organization_id: 'org-test',
    title: 'SO-000016 pickup',
    // Was 20 h out when the cron reminded it a day ahead…
    starts_at: new Date(NOW.getTime() + 20 * HOUR).toISOString(),
    ends_at: null,
    all_day: false,
    location_text: null,
    warehouse_id: null,
    requester_name: null,
    details: 'Auto-created from order SO-000016.',
    status: 'scheduled',
    bundle_id: null,
    bundle_quantity: null,
    bundle_warehouse_id: null,
    order_request_id: null,
    assigned_user_id: 'user-assignee',
    created_by: 'user-test',
    updated_by: 'user-test',
    created_at: '2026-08-20T00:00:00.000Z',
    updated_at: '2026-08-20T00:00:00.000Z',
    reminded_24h_at: new Date(NOW.getTime() - 4 * HOUR).toISOString(),
    reminded_1h_at: null,
    ...overrides,
  };
}

/** The payload a schedule_events.update chain was given. */
function updatePayload(call: MockCall): Row {
  return (callArgs(call, 'update')?.[0] ?? {}) as Row;
}

/** A user client whose schedule_events rows live in `store`: reads serve it,
 *  and an update writes its payload into it (what PostgREST would do). */
function userClientOver(store: { row: Row }, seen: Row[]) {
  return makeSupabaseStub({
    'schedule_events.select': () => ({ data: [store.row], error: null }),
    'schedule_events.update': (call) => {
      const payload = updatePayload(call);
      seen.push(payload);
      store.row = { ...store.row, ...payload };
      return { data: store.row, error: null };
    },
    'bundle_distributions.select': { data: [], error: null },
    'user_profiles.select': { data: [], error: null },
  });
}

/** The cron's admin client over the same store. */
function adminClientOver(store: { row: Row }) {
  return makeSupabaseStub({
    'schedule_events.select': servedLikePostgrest(() => [store.row]),
    // The stamp-guard update: the cron wins its own stamp.
    'schedule_events.update': (call) => {
      store.row = { ...store.row, ...updatePayload(call) };
      return { data: { id: EVENT_ID }, error: null };
    },
    'organizations.select': { data: [{ id: 'org-test', timezone: 'America/Los_Angeles' }], error: null },
    'organization_members.select': { data: [{ user_id: 'user-manager' }], error: null },
    'user_profiles.select': {
      data: [
        { id: 'user-assignee', email: 'assignee@l4l.example', full_name: 'Theo Marsh' },
        { id: 'user-manager', email: 'manager@l4l.example', full_name: 'Dana Reyes' },
      ],
      error: null,
    },
    'notification_preferences.select': { data: [], error: null },
  }).client;
}

function service(client: unknown) {
  return new ScheduleService(
    makeServiceContext(client, {
      enabledModules: new Set<ModuleId>([...DEFAULT_MODULE_IDS, 'schedule' as ModuleId]),
    }) as never,
  );
}

async function cronRun() {
  const res = await runReminderCron(
    new Request('https://test.local/api/cron/schedule-reminders', {
      headers: { authorization: 'Bearer test-cron-secret' },
    }),
  );
  return (await res.json()) as { ok: boolean; remindersSent: number };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ScheduleService.update re-arms reminders when the start moves', () => {
  it('an event reminded for its old time is reminded again for its new time (update, then the real cron)', async () => {
    const store = { row: eventRow() };
    adminHolder.client = adminClientOver(store);

    // Before the move the cron has nothing to send: the day-ahead reminder
    // for this start already went out.
    expect((await cronRun()).remindersSent).toBe(0);

    // The manager moves it to 23 h from now (still inside the day-ahead window).
    const moved = new Date(NOW.getTime() + 23 * HOUR).toISOString();
    await service(userClientOver(store, []).client).update(EVENT_ID, { startsAt: moved } as never);
    expect(store.row.starts_at).toBe(moved);

    // One reminder for the new time; a second run sends nothing more.
    expect((await cronRun()).remindersSent).toBe(1);
    expect((await cronRun()).remindersSent).toBe(0);
  });

  it('clears both stamps in the SAME update that moves starts_at', async () => {
    const store = { row: eventRow({ reminded_1h_at: NOW.toISOString() }) };
    const seen: Row[] = [];
    await service(userClientOver(store, seen).client).update(EVENT_ID, {
      startsAt: '2026-08-27T18:00:00.000Z',
    } as never);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      starts_at: '2026-08-27T18:00:00.000Z',
      reminded_24h_at: null,
      reminded_1h_at: null,
    });
  });

  it('leaves the stamps alone when the start does not move (same instant, another spelling)', async () => {
    const startsAt = '2026-08-25T16:20:00.000Z';
    const store = { row: eventRow({ starts_at: startsAt }) };
    const seen: Row[] = [];
    await service(userClientOver(store, seen).client).update(EVENT_ID, {
      title: 'Renamed',
      startsAt: '2026-08-25T09:20:00-07:00',
    } as never);
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toHaveProperty('reminded_24h_at');
    expect(seen[0]).not.toHaveProperty('reminded_1h_at');
    expect(store.row.reminded_24h_at).not.toBeNull();
  });

  it('leaves the stamps alone for an edit that does not touch the start', async () => {
    const store = { row: eventRow() };
    const seen: Row[] = [];
    await service(userClientOver(store, seen).client).update(EVENT_ID, {
      title: 'Renamed',
    } as never);
    expect(seen[0]).not.toHaveProperty('reminded_24h_at');
    expect(seen[0]).not.toHaveProperty('reminded_1h_at');
  });
});
