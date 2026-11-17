import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  callArgs,
  makeSupabaseStub,
  servedLikePostgrest,
  type MockCall,
  type QueryResult,
} from '@/test/supabase-mock';

/**
 * The reminder cron reads only the events still owed a reminder, soonest
 * first, a page at a time, until none are left or its soft deadline; what the
 * deadline leaves is counted, reported, and goes first next run. The claim
 * (stamp before send, guarded on the start and status read) is unchanged, so
 * each event is reminded at most once per horizon however the runs fall.
 * Every read here is answered by servedLikePostgrest over one store of
 * events, so a filter, order or cursor the cron leaves out changes the rows
 * it gets.
 */

vi.mock('@/lib/env', () => ({
  env: { CRON_SECRET: 'test-cron-secret', NEXT_PUBLIC_APP_URL: 'https://app.example' },
}));
const reportError = vi.hoisted(() => vi.fn());
vi.mock('@/lib/error-reporter', () => ({ reportError }));
const adminHolder = { client: null as unknown };
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn(() => adminHolder.client) }));

const notified: Array<{ eventId: string; horizon: string; at: number; title: string }> = [];
const notify = vi.hoisted(() => ({ cost: 0 }));
vi.mock('@/server/services/notifications', () => ({
  createNotification: async (args: {
    title: string;
    metadata: { scheduleEventId: string; horizon: string };
  }) => {
    notified.push({
      eventId: args.metadata.scheduleEventId,
      horizon: args.metadata.horizon,
      at: Date.now(),
      title: args.title,
    });
    if (notify.cost > 0) vi.setSystemTime(Date.now() + notify.cost);
  },
}));
vi.mock('@/lib/email/resend', () => ({ sendEmail: vi.fn(async () => ({ ok: true })) }));

import { GET, maxDuration } from './route';

const NOW = new Date('2026-08-24T20:20:00.000Z');
const HOUR = 60 * 60_000;

type Ev = {
  id: string;
  organization_id: string;
  title: string;
  starts_at: string;
  ends_at: null;
  all_day: boolean;
  location_text: null;
  details: null;
  warehouse_id: null;
  assigned_user_id: null;
  status: string;
  reminded_24h_at: string | null;
  reminded_1h_at: string | null;
};

function ev(id: string, startsInMs: number, overrides: Partial<Ev> = {}): Ev {
  return {
    id,
    organization_id: 'org-1',
    title: `Delivery ${id}`,
    starts_at: new Date(NOW.getTime() + startsInMs).toISOString(),
    ends_at: null,
    all_day: false,
    location_text: null,
    details: null,
    warehouse_id: null,
    assigned_user_id: null,
    status: 'scheduled',
    reminded_24h_at: null,
    reminded_1h_at: null,
    ...overrides,
  };
}

/** One store of events behind every read and every stamp. */
function stubOver(
  store: Ev[],
  extra: Record<string, QueryResult | ((call: MockCall) => QueryResult)> = {},
) {
  const served = servedLikePostgrest(() => store);
  const stub = makeSupabaseStub({
    'schedule_events.select': (call: MockCall): QueryResult => {
      const opts = callArgs(call, 'select')?.[1] as { head?: boolean } | undefined;
      const res = served(call);
      return opts?.head ? { data: null, error: null, count: (res.data as unknown[]).length } : res;
    },
    // The stamp: applied only when every guard of the chain holds, as the
    // database would (eq id, eq starts_at, eq status, is <stamp> null).
    'schedule_events.update': (call: MockCall): QueryResult => {
      const matched = (served({ ...call, methods: call.methods.slice(1), args: call.args.slice(1) })
        .data ?? []) as Ev[];
      const row = matched[0];
      if (!row) return { data: null, error: null };
      Object.assign(row, call.args[0]![0] as Partial<Ev>);
      return { data: { id: row.id }, error: null };
    },
    'organizations.select': {
      data: [{ id: 'org-1', timezone: 'America/Los_Angeles' }],
      error: null,
    },
    'organization_members.select': { data: [{ user_id: 'user-manager' }], error: null },
    'user_profiles.select': { data: [], error: null },
    'notification_preferences.select': { data: [], error: null },
    ...extra,
  });
  adminHolder.client = stub.client;
  return stub;
}

async function run() {
  const res = await GET(
    new Request('https://test.local/api/cron/schedule-reminders', {
      headers: { authorization: 'Bearer test-cron-secret' },
    }),
  );
  return (await res.json()) as {
    remindersSent: number;
    stoppedAtDeadline: boolean;
    leftForNextRun: number;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  notified.length = 0;
  notify.cost = 0;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('GET /api/cron/schedule-reminders: which events, in what order', () => {
  it('reads only events still owed a reminder, soonest first', async () => {
    const store = [
      ev('later', 5 * HOUR),
      ev('day-ahead-done', 20 * HOUR, { reminded_24h_at: '2026-08-24T00:00:00Z' }),
      ev('soon', 0.5 * HOUR),
      // Day-ahead sent, the start is now within the hour: the 1h one is owed.
      ev('soon-day-ahead-done', 0.25 * HOUR, { reminded_24h_at: '2026-08-24T00:00:00Z' }),
      ev('hour-done', 0.4 * HOUR, { reminded_1h_at: '2026-08-24T20:00:00Z' }),
    ];
    const stub = stubOver(store);
    const body = await run();
    expect(notified.map((n) => [n.eventId, n.horizon])).toEqual([
      ['soon-day-ahead-done', '1h'],
      ['soon', '1h'],
      ['later', '24h'],
    ]);
    expect(body).toMatchObject({ remindersSent: 3, stoppedAtDeadline: false, leftForNextRun: 0 });
    // The read itself carries the owed filter (not a filter applied after).
    const read = stub.chainsAll.get('schedule_events.select')![0]!;
    expect(read).toEqual(expect.arrayContaining(['is', 'or', 'order', 'limit']));
  });

  it('reaches owed events behind 600 already-reminded ones (the old read stopped at 500, unordered)', async () => {
    const store = [
      ...Array.from({ length: 600 }, (_, i) =>
        ev(`done-${String(i).padStart(3, '0')}`, 2 * HOUR + i * 1000, {
          reminded_24h_at: '2026-08-24T00:00:00Z',
        }),
      ),
      ...Array.from({ length: 5 }, (_, i) => ev(`owed-${i}`, 10 * HOUR + i * 1000)),
    ];
    stubOver(store);
    const body = await run();
    expect(notified.map((n) => n.eventId)).toEqual([
      'owed-0',
      'owed-1',
      'owed-2',
      'owed-3',
      'owed-4',
    ]);
    expect(body.remindersSent).toBe(5);
  });

  it('pages past PAGE_SIZE through events that share one start time, each reminded exactly once', async () => {
    const same = 3 * HOUR;
    const store = Array.from({ length: 450 }, (_, i) =>
      ev(`e-${String(i).padStart(3, '0')}`, same),
    );
    const stub = stubOver(store);
    const body = await run();
    expect(body.remindersSent).toBe(450);
    expect(new Set(notified.map((n) => n.eventId)).size).toBe(450);
    expect(notified).toHaveLength(450);
    // Three pages: 200, 200, 50.
    expect(stub.chainsAll.get('schedule_events.select')!.length).toBe(3);
    // A second run finds nothing owed.
    notified.length = 0;
    expect((await run()).remindersSent).toBe(0);
    expect(notified).toHaveLength(0);
  });
});

describe('GET /api/cron/schedule-reminders: one tick delivered twice', () => {
  it('a day-ahead claim loses to a 1h claim made since the run read the event', async () => {
    // Run A reads an event starting 1 h 5 s from now: day-ahead for A. A
    // second delivery of the same tick, seconds later, reads it as 1 h away
    // and claims (and sends) the 1h reminder before A claims. A's day-ahead
    // claim must then match no row, or the event gets "in 1 hour" and then
    // "today".
    const store = [ev('dup', HOUR + 5_000)];
    const served = servedLikePostgrest(() => store);
    let claims = 0;
    stubOver(store, {
      'schedule_events.update': (call: MockCall): QueryResult => {
        claims += 1;
        // The other delivery's 1h claim lands first.
        if (claims === 1) store[0]!.reminded_1h_at = new Date(NOW.getTime() + 10_000).toISOString();
        const row = (
          (served({ ...call, methods: call.methods.slice(1), args: call.args.slice(1) }).data ??
            []) as Ev[]
        )[0];
        if (!row) return { data: null, error: null };
        Object.assign(row, call.args[0]![0] as Partial<Ev>);
        return { data: { id: row.id }, error: null };
      },
    });
    const body = await run();
    expect(body.remindersSent).toBe(0);
    expect(notified).toHaveLength(0);
    expect(store[0]!.reminded_24h_at).toBeNull();
  });
});

describe('GET /api/cron/schedule-reminders: time zones across pages', () => {
  it("a failed zone read is retried on the next page, and that page formats in the org's own zone", async () => {
    // Page one: 200 events. Page two: one event at 04:30Z on the 25th, which
    // is 21:30 on the 24th in the fallback zone (Pacific, "today") and 00:30
    // on the 25th in the org's zone (New York, "tomorrow").
    const store = [
      ...Array.from({ length: 200 }, (_, i) =>
        ev(`p1-${String(i).padStart(3, '0')}`, 3 * HOUR + i * 1000),
      ),
      ev('p2-late', Date.parse('2026-08-25T04:30:00.000Z') - NOW.getTime()),
    ];
    let zoneReads = 0;
    stubOver(store, {
      'organizations.select': () => {
        zoneReads += 1;
        return zoneReads === 1
          ? { data: null, error: { message: 'fetch failed' } }
          : { data: [{ id: 'org-1', timezone: 'America/New_York' }], error: null };
      },
    });
    const body = await run();
    expect(body.remindersSent).toBe(201);
    expect(zoneReads).toBe(2);
    expect(notified.find((n) => n.eventId === 'p2-late')?.title).toContain('tomorrow');
    const tags = reportError.mock.calls.map((c) => (c[1] as { tag: string }).tag);
    expect(tags).toEqual(['cron.schedule-reminders.org-timezone']);
  });

  it('a zone read once is not read again on a later page', async () => {
    const store = Array.from({ length: 201 }, (_, i) =>
      ev(`e-${String(i).padStart(3, '0')}`, 3 * HOUR + i * 1000),
    );
    let zoneReads = 0;
    stubOver(store, {
      'organizations.select': () => {
        zoneReads += 1;
        return { data: [{ id: 'org-1', timezone: 'America/New_York' }], error: null };
      },
    });
    expect((await run()).remindersSent).toBe(201);
    expect(zoneReads).toBe(1);
  });
});

describe('GET /api/cron/schedule-reminders: deadline', () => {
  it('stops STARTING events at the soft deadline, counts and reports what it left, and the next run takes those first', async () => {
    // Ten owed events; each takes a minute (its notification). The run starts
    // events at 0, 1, 2 and 3 minutes; the fifth would start at 4 minutes,
    // the 240 s deadline.
    const store = Array.from({ length: 10 }, (_, i) => ev(`e-${i}`, 2 * HOUR + i * 60_000));
    stubOver(store);
    notify.cost = 60_000;

    const first = await run();
    expect(first).toMatchObject({ remindersSent: 4, stoppedAtDeadline: true, leftForNextRun: 6 });
    expect(notified.map((n) => n.eventId)).toEqual(['e-0', 'e-1', 'e-2', 'e-3']);
    const deadline = reportError.mock.calls.find(
      (c) => (c[1] as { tag: string }).tag === 'cron.schedule-reminders.deadline',
    );
    expect(deadline?.[1]).toMatchObject({
      level: 'warning',
      extra: { read: 10, remindersSent: 4, leftForNextRun: 6 },
    });
    const lines = vi
      .mocked(console.info)
      .mock.calls.filter((c) => c[0] === '[cron.schedule-reminders]');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(String(lines[0]![1]))).toMatchObject({
      read: 10,
      remindersSent: 4,
      stoppedAtDeadline: true,
      leftForNextRun: 6,
    });
    expect(String(lines[0]![1])).not.toMatch(/e-\d/);

    // Ten minutes later: the next run picks up where this one stopped.
    vi.setSystemTime(NOW.getTime() + 10 * 60_000);
    notified.length = 0;
    const second = await run();
    expect(notified.map((n) => n.eventId)).toEqual(['e-4', 'e-5', 'e-6', 'e-7']);
    expect(second.leftForNextRun).toBe(2);
  });

  it('leaves the event in flight time to finish after the deadline', () => {
    expect(maxDuration * 1000 - 240_000).toBeGreaterThanOrEqual(60_000);
  });
});
