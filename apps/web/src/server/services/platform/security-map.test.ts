import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, type MockCall } from '@/test/supabase-mock';

import {
  SECURITY_EVENT_CATEGORIES,
  SECURITY_MAP_POLL_FAILED,
  readSecurityMapAnswer,
  readSecurityMapView,
} from '@stockpilot/core';

/**
 * The platform console's attack map read (service client).
 *
 * Security invariant. Pinned: one call of platform_security_map with the
 * service client, with its own time budget; the whole window is asked for
 * with the database's own defaults and the viewer's day start, the last ten
 * minutes with a start ten minutes back and no day start; a function that is
 * not in the database yet (PGRST202), the database's own cancel (57014), a
 * timeout, or an answer whose shape this build does not know (a key too
 * many, a key missing, a list past its cap) is "could not check", reported
 * once as a warning with no value from the answer, and never an empty map;
 * the zod schema and core's plain reader accept and refuse the same answers;
 * what is handed back is core's view, with a category the map does not show
 * taken out; nothing throws. Made-up places and organizations only.
 */

const NOW = Date.parse('2026-11-23T22:00:00Z');

const h = vi.hoisted(() => ({
  reportError: vi.fn(async (..._a: unknown[]) => {}),
  clientFails: false,
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/error-reporter', () => ({ reportError: h.reportError }));

const zeros = () =>
  Object.fromEntries(
    SECURITY_EVENT_CATEGORIES.map((c) => [c, { blocked: 0, flagged: 0, allowed: 0 }]),
  ) as Record<string, { blocked: number; flagged: number; allowed: number }>;

const feedEntry = (over: Record<string, unknown> = {}) => ({
  minute: '2026-11-23T21:58:00+00:00',
  category: 'password_guessing',
  outcome: 'blocked',
  reason: 'wrong_password',
  source: 'web',
  country: 'US',
  city: 'Example Falls',
  events: 11,
  at_least: false,
  organization_id: null,
  organization_name: null,
  organizations: 0,
  ...over,
});

const FLAGGED_ENTRY = feedEntry({
  outcome: 'flagged',
  reason: 'sign_in_alerts_held',
  country: 'GB',
  city: 'Example Borough',
  events: 4,
  at_least: true,
});

/** The contract's answer (VERSION 2): twenty-four keys. */
const mapAnswer = (over: Record<string, unknown> = {}) => ({
  window: {
    from: '2026-11-22T22:00:00+00:00',
    to: '2026-11-23T22:00:00+00:00',
    live_from: '2026-11-23T21:50:00+00:00',
    asked_from: '2026-11-22T22:00:00+00:00',
  },
  window_shortened: false,
  short_window: false,
  refused: null,
  generated_at: '2026-11-23T22:00:00.123456+00:00',
  oldest_event_at: '2026-11-01T19:42:00+00:00',
  timeline: [
    {
      bucket_start: '2026-11-23T21:58:00+00:00',
      bucket_seconds: 60,
      country: 'US',
      category: 'password_guessing',
      outcome: 'blocked',
      events: 11,
    },
    {
      bucket_start: '2026-11-23T21:50:00+00:00',
      bucket_seconds: 600,
      country: 'US',
      category: 'password_guessing',
      outcome: 'blocked',
      events: 11,
    },
    {
      bucket_start: '2026-11-23T21:50:00+00:00',
      bucket_seconds: 600,
      country: 'PT',
      category: 'phishing',
      outcome: 'flagged',
      events: 1,
    },
  ],
  timeline_truncated: false,
  by_country: [
    { country: 'US', category: 'password_guessing', outcome: 'blocked', events: 11 },
    { country: 'PT', category: 'phishing', outcome: 'flagged', events: 1 },
  ],
  by_country_truncated: false,
  totals: {
    ...zeros(),
    password_guessing: { blocked: 11, flagged: 0, allowed: 0 },
    phishing: { blocked: 0, flagged: 1, allowed: 0 },
  },
  no_place: zeros(),
  blocked_window: 11,
  flagged_window: 1,
  allowed_window: 0,
  day_start: null,
  blocked_since_day_start: null,
  blocked_since_day_start_partial: false,
  floors: ['flagged_window', 'totals.phishing.flagged'],
  feed: [
    feedEntry(),
    feedEntry({
      category: 'phishing',
      outcome: 'flagged',
      reason: 'sign_in_new_country',
      country: 'PT',
      city: 'Example Harbour',
      events: 1,
      at_least: true,
      organizations: 3,
    }),
  ],
  flagged_feed: [FLAGGED_ENTRY],
  late_sources: [],
  tallies: [],
  flood_rows: [],
  ...over,
});

type Answer = { data: unknown; error: { message: string; code?: string } | null };
let answer: Answer | (() => Answer);
let awaited: MockCall[];

const stub = makeSupabaseStub({
  'rpc:platform_security_map': (call: MockCall) => {
    if (call.methods.includes('abortSignal')) awaited.push(call);
    return typeof answer === 'function' ? answer() : answer;
  },
});

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => {
    if (h.clientFails) throw new Error('no service client');
    return stub.client;
  },
}));

import {
  SECURITY_MAP_READ_BUDGET_MS,
  platformSecurityMapSchema,
  readPlatformSecurityMap,
} from './security-map';

beforeEach(() => {
  vi.clearAllMocks();
  stub.rpcCalls.length = 0;
  awaited = [];
  h.clientFails = false;
  answer = { data: mapAnswer(), error: null };
});

afterEach(() => {
  vi.restoreAllMocks();
});

const reports = () =>
  h.reportError.mock.calls.map(([err, ctx]) => ({
    message: (err as Error).message,
    ...(ctx as { tag: string; level?: string; extra?: Record<string, unknown> }),
  }));

describe('the read', () => {
  it("the whole window: one call with the service client, the database's own window, the day start handed on", async () => {
    const result = await readPlatformSecurityMap(
      { scope: 'whole', dayStart: '2026-11-23T08:00:00.000Z' },
      NOW,
    );
    expect(stub.rpcCalls).toEqual([
      {
        name: 'platform_security_map',
        args: { p_from: null, p_to: null, p_day_start: '2026-11-23T08:00:00.000Z' },
      },
    ]);
    expect(result.ok && result.view?.scope).toBe('whole');
    expect(h.reportError).not.toHaveBeenCalled();
  });

  it("on the day the clocks go back, the whole window starts at the viewer's midnight, up to 26 hours", async () => {
    // Midnight was 25 hours ago: the window starts there so the day is counted.
    await readPlatformSecurityMap({ scope: 'whole', dayStart: '2026-11-22T21:00:00.000Z' }, NOW);
    // 24 hours ago or less, or more than 26 (less a minute for the two clocks): the database's default.
    await readPlatformSecurityMap({ scope: 'whole', dayStart: '2026-11-22T22:00:00.000Z' }, NOW);
    await readPlatformSecurityMap({ scope: 'whole', dayStart: '2026-11-22T20:00:00.000Z' }, NOW);
    expect(stub.rpcCalls.map((c) => (c.args as { p_from: unknown }).p_from)).toEqual([
      '2026-11-22T21:00:00.000Z',
      null,
      null,
    ]);
  });

  it('the last ten minutes: a start ten minutes back, the end left to the database, never a day start', async () => {
    const result = await readPlatformSecurityMap(
      { scope: 'recent', dayStart: '2026-11-23T08:00:00.000Z' },
      NOW,
    );
    expect(stub.rpcCalls).toEqual([
      {
        name: 'platform_security_map',
        args: { p_from: '2026-11-23T21:50:00.000Z', p_to: null, p_day_start: null },
      },
    ]);
    expect(result.ok && result.view?.scope).toBe('recent');
    expect(result.ok && result.view?.whole).toBeNull();
  });

  it('has its own time budget of 6 seconds, handed to the call', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    await readPlatformSecurityMap({ scope: 'whole', dayStart: null }, NOW);
    expect(SECURITY_MAP_READ_BUDGET_MS).toBe(6000);
    expect(timeout.mock.calls).toEqual([[6000]]);
    expect(awaited).toHaveLength(1);
    expect(awaited[0]?.methods).toEqual(['rpc', 'abortSignal']);
    expect(awaited[0]?.args[1]?.[0]).toBe(timeout.mock.results[0]?.value);
  });

  it("hands back core's view, not the database's document: a hidden category never leaves the server", async () => {
    const result = await readPlatformSecurityMap({ scope: 'whole', dayStart: null }, NOW);
    if (!result.ok || result.view === null) throw new Error('expected a view');
    expect(readSecurityMapView(JSON.parse(JSON.stringify(result.view)))).toEqual(result.view);
    const sent = JSON.stringify(result);
    expect(sent).not.toContain('Example Harbour');
    expect(sent).not.toContain('sign_in_new_country');
    expect(sent).not.toContain('"PT"');
    expect(sent).not.toContain('by_country');
    expect(sent).not.toContain('timeline');
    expect(result.view.live).toEqual([['US', 0, 0, 11]]);
    expect(result.view.feed).toHaveLength(1);
    // Counted in words: one flagged sign-in alert that is not drawn.
    expect(result.view.whole?.notDrawnSignInAlerts).toBe(1);
    expect(result.view.whole?.flagged).toBe(1);
  });

  it('a window the database would not read is said, not shown as an empty map', async () => {
    answer = {
      data: {
        window: null,
        refused: 'from_not_before_to',
        generated_at: '2026-11-23T22:00:00+00:00',
      },
      error: null,
    };
    await expect(
      readPlatformSecurityMap({ scope: 'recent', dayStart: null }, NOW),
    ).resolves.toEqual({
      ok: true,
      view: null,
      refusedWindow: 'from_not_before_to',
    });
    expect(h.reportError).not.toHaveBeenCalled();
  });
});

describe('a read that fails is "could not check", reported once, and never throws', () => {
  it('a function that is not in the database yet (PGRST202) is reported by name', async () => {
    answer = {
      data: null,
      error: {
        message: 'Could not find the function public.platform_security_map',
        code: 'PGRST202',
      },
    };
    const result = await readPlatformSecurityMap({ scope: 'whole', dayStart: null }, NOW);
    expect(result).toBe(SECURITY_MAP_POLL_FAILED);
    expect(reports()).toEqual([
      {
        message:
          'platform_security_map is not in the database yet: the code is ahead of the migration',
        tag: 'platform.security-map.platform_security_map',
        level: 'warning',
        extra: { scope: 'whole', code: 'PGRST202' },
      },
    ]);
  });

  it("the database's own five-second cancel (57014) is could not check, never an empty map", async () => {
    answer = {
      data: null,
      error: { message: 'canceling statement due to statement timeout', code: '57014' },
    };
    const result = await readPlatformSecurityMap({ scope: 'recent', dayStart: null }, NOW);
    expect(result).toBe(SECURITY_MAP_POLL_FAILED);
    expect(reports()).toEqual([
      {
        message: 'canceling statement due to statement timeout',
        tag: 'platform.security-map.platform_security_map',
        level: 'warning',
        extra: { scope: 'recent', code: '57014' },
      },
    ]);
  });

  it('a timeout, and a service client that cannot be made', async () => {
    answer = () => {
      throw new Error('The operation was aborted due to timeout');
    };
    await expect(readPlatformSecurityMap({ scope: 'whole', dayStart: null }, NOW)).resolves.toBe(
      SECURITY_MAP_POLL_FAILED,
    );
    h.clientFails = true;
    await expect(readPlatformSecurityMap({ scope: 'whole', dayStart: null }, NOW)).resolves.toBe(
      SECURITY_MAP_POLL_FAILED,
    );
    expect(reports().map((r) => [r.message, r.level])).toEqual([
      ['The operation was aborted due to timeout', 'warning'],
      ['no service client', 'warning'],
    ]);
  });

  it('an answer of another shape: where it differs is reported, and no value from the answer', async () => {
    answer = {
      data: mapAnswer({
        feed: [feedEntry({ source_address: '203.0.113.9', city: 'Example Falls' })],
      }),
      error: null,
    };
    const result = await readPlatformSecurityMap({ scope: 'whole', dayStart: null }, NOW);
    expect(result).toBe(SECURITY_MAP_POLL_FAILED);
    expect(h.reportError).toHaveBeenCalledTimes(1);
    const [report] = reports();
    expect(report?.message).toBe(
      'platform_security_map answered a shape this build does not know (feed.0: unrecognized_keys)',
    );
    const logged = JSON.stringify(h.reportError.mock.calls) + (report?.message ?? '');
    expect(logged).not.toContain('203.0.113.9');
    expect(logged).not.toContain('Example Falls');
  });

  it("null, a list or text in the answer's place is could not check", async () => {
    for (const data of [null, [], 'ok', 7]) {
      answer = { data, error: null };
      await expect(readPlatformSecurityMap({ scope: 'whole', dayStart: null }, NOW)).resolves.toBe(
        SECURITY_MAP_POLL_FAILED,
      );
    }
    expect(h.reportError).toHaveBeenCalledTimes(4);
  });
});

describe("the zod schema and core's plain reader are the same contract", () => {
  const cases: Array<[string, unknown, boolean]> = [
    ['the documented answer', mapAnswer(), true],
    [
      'an empty record with a day count',
      mapAnswer({
        oldest_event_at: null,
        day_start: '2026-11-23T08:00:00+00:00',
        blocked_since_day_start: 0,
        timeline: [],
        by_country: [],
        feed: [],
      }),
      true,
    ],
    [
      'a refused window',
      { window: null, refused: 'to_in_the_future', generated_at: '2026-11-23T22:00:00+00:00' },
      true,
    ],
    [
      'a refused window with an unknown word',
      { window: null, refused: 'because', generated_at: '2026-11-23T22:00:00+00:00' },
      false,
    ],
    [
      'a refused window with a fourth key',
      { window: null, refused: 'not_a_time', generated_at: '2026-11-23T22:00:00+00:00', feed: [] },
      false,
    ],
    ['a refusal word beside a window', mapAnswer({ refused: 'not_a_time' }), false],
    ['an extra key', mapAnswer({ source_hash: 'x' }), false],
    [
      'a key missing',
      (() => {
        const a: Record<string, unknown> = mapAnswer();
        delete a.flood_rows;
        return a;
      })(),
      false,
    ],
    ['a feed past 60', mapAnswer({ feed: Array.from({ length: 61 }, () => feedEntry()) }), false],
    ['a feed of 60', mapAnswer({ feed: Array.from({ length: 60 }, () => feedEntry()) }), true],
    [
      'a by-country list past 2,000',
      mapAnswer({
        by_country: Array.from({ length: 2001 }, () => ({
          country: 'US',
          category: 'bots',
          outcome: 'blocked',
          events: 1,
        })),
      }),
      false,
    ],
    [
      'late sources past 30',
      mapAnswer({
        late_sources: Array.from({ length: 31 }, () => ({
          source: 'api',
          category: 'bots',
          outcome: 'blocked',
          events: 1,
        })),
      }),
      false,
    ],
    [
      'tallies past 300',
      mapAnswer({
        tallies: Array.from({ length: 301 }, () => ({
          reason: 'too_many_forms_to_count',
          source: 'api',
          category: 'bots',
          outcome: 'flagged',
          events: 1,
          rows: 1,
        })),
      }),
      false,
    ],
    [
      'a bucket of another length',
      mapAnswer({
        timeline: [
          {
            bucket_start: '2026-11-23T21:50:00+00:00',
            bucket_seconds: 300,
            country: 'US',
            category: 'bots',
            outcome: 'blocked',
            events: 1,
          },
        ],
      }),
      false,
    ],
    [
      'a country in small letters',
      mapAnswer({
        by_country: [{ country: 'us', category: 'bots', outcome: 'blocked', events: 1 }],
      }),
      false,
    ],
    [
      'an unknown category',
      mapAnswer({
        by_country: [{ country: 'US', category: 'spam', outcome: 'blocked', events: 1 }],
      }),
      false,
    ],
    [
      'an unknown outcome',
      mapAnswer({
        by_country: [{ country: 'US', category: 'bots', outcome: 'dropped', events: 1 }],
      }),
      false,
    ],
    ['an unknown source', mapAnswer({ feed: [feedEntry({ source: 'fax' })] }), false],
    [
      'a reason that is no code',
      mapAnswer({ feed: [feedEntry({ reason: 'Wrong Password' })] }),
      false,
    ],
    ['a count as text', mapAnswer({ blocked_window: '11' }), false],
    ['a negative count', mapAnswer({ flagged_window: -1 }), false],
    ['a count past 2^31', mapAnswer({ blocked_window: 5_000_000_000 }), true],
    [
      'totals without a category',
      mapAnswer({
        totals: (() => {
          const t: Record<string, unknown> = zeros();
          delete t.malware;
          return t;
        })(),
      }),
      false,
    ],
    [
      'totals with a sixth category',
      mapAnswer({ totals: { ...zeros(), spam: { blocked: 0, flagged: 0, allowed: 0 } } }),
      false,
    ],
    ['a city of 80 characters', mapAnswer({ feed: [feedEntry({ city: 'x'.repeat(80) })] }), true],
    ['a city of 81 characters', mapAnswer({ feed: [feedEntry({ city: 'x'.repeat(81) })] }), false],
    [
      'a name of 200 characters of two code units',
      mapAnswer({ feed: [feedEntry({ organization_name: '\u{1F512}'.repeat(200) })] }),
      true,
    ],
    [
      'a name of 201 characters',
      mapAnswer({ feed: [feedEntry({ organization_name: 'x'.repeat(201) })] }),
      false,
    ],
    [
      'an organization id that is no id',
      mapAnswer({ feed: [feedEntry({ organization_id: 'x' })] }),
      false,
    ],
    ['a time that is no time', mapAnswer({ generated_at: 'yesterday' }), false],
    [
      'a window refused as longer than 26 hours',
      { window: null, refused: 'longer_than_26_hours', generated_at: '2026-11-23T22:00:00+00:00' },
      true,
    ],
    [
      'a window refused for one minute too full to read',
      {
        window: null,
        refused: 'too_many_events_in_one_minute',
        generated_at: '2026-11-23T22:00:00+00:00',
      },
      true,
    ],
    [
      'the old word for a window too long',
      { window: null, refused: 'longer_than_48_hours', generated_at: '2026-11-23T22:00:00+00:00' },
      false,
    ],
    [
      'a shortened window',
      mapAnswer({
        window: {
          from: '2026-11-23T19:00:00+00:00',
          to: '2026-11-23T22:00:00+00:00',
          live_from: '2026-11-23T21:50:00+00:00',
          asked_from: '2026-11-22T22:00:00+00:00',
        },
        window_shortened: true,
        day_start: '2026-11-23T08:00:00+00:00',
        blocked_since_day_start: 9,
        blocked_since_day_start_partial: true,
        floors: ['blocked_since_day_start'],
      }),
      true,
    ],
    [
      'a window said to be shortened that was read as asked',
      mapAnswer({ window_shortened: true }),
      false,
    ],
    [
      'a window read later than asked and not said to be shortened',
      mapAnswer({
        window: {
          from: '2026-11-23T19:00:00+00:00',
          to: '2026-11-23T22:00:00+00:00',
          live_from: '2026-11-23T21:50:00+00:00',
          asked_from: '2026-11-22T22:00:00+00:00',
        },
      }),
      false,
    ],
    [
      'a partial day count with no count',
      mapAnswer({ blocked_since_day_start_partial: true }),
      false,
    ],
    [
      'a partial day count not named a floor',
      mapAnswer({
        day_start: '2026-11-23T08:00:00+00:00',
        blocked_since_day_start: 9,
        blocked_since_day_start_partial: true,
        floors: [],
      }),
      false,
    ],
    ['a floor by an unknown name', mapAnswer({ floors: ['by_country'] }), false],
    [
      'floors past 40',
      mapAnswer({ floors: Array.from({ length: 41 }, () => 'flagged_window') }),
      false,
    ],
    [
      'a feed entry with no at_least',
      mapAnswer({ feed: [feedEntry({ at_least: undefined })] }),
      false,
    ],
    ['a blocked entry in the flagged feed', mapAnswer({ flagged_feed: [feedEntry()] }), false],
    [
      'a flagged feed past 20',
      mapAnswer({ flagged_feed: Array.from({ length: 21 }, () => FLAGGED_ENTRY) }),
      false,
    ],
    [
      'a poll: the live cells only and no groups',
      mapAnswer({
        window: {
          from: '2026-11-23T21:50:00+00:00',
          to: '2026-11-23T22:00:00+00:00',
          live_from: '2026-11-23T21:50:00+00:00',
          asked_from: '2026-11-23T21:50:00+00:00',
        },
        short_window: true,
        timeline: [
          {
            bucket_start: '2026-11-23T21:58:00+00:00',
            bucket_seconds: 60,
            country: 'US',
            category: 'password_guessing',
            outcome: 'blocked',
            events: 11,
          },
        ],
        by_country: [],
      }),
      true,
    ],
    ['a poll with a replay cell and groups', mapAnswer({ short_window: true }), false],
    ['a poll with a replay cell', mapAnswer({ short_window: true, by_country: [] }), false],
    [
      'a poll with groups by country',
      mapAnswer({
        short_window: true,
        timeline: [
          {
            bucket_start: '2026-11-23T21:58:00+00:00',
            bucket_seconds: 60,
            country: 'US',
            category: 'password_guessing',
            outcome: 'blocked',
            events: 11,
          },
        ],
      }),
      false,
    ],
    [
      'a poll that says groups were cut',
      mapAnswer({ short_window: true, timeline: [], by_country: [], by_country_truncated: true }),
      false,
    ],
    [
      'a window without live_from',
      mapAnswer({ window: { from: '2026-11-22T22:00:00+00:00', to: '2026-11-23T22:00:00+00:00' } }),
      false,
    ],
  ];

  it.each(cases)('%s', (_name, raw, good) => {
    expect(platformSecurityMapSchema.safeParse(raw).success).toBe(good);
    expect(readSecurityMapAnswer(raw).ok).toBe(good);
  });
});
