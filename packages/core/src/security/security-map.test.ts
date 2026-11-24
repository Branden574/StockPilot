import { describe, expect, it } from 'vitest';

import { SECURITY_EVENT_CATEGORIES, type SecurityEventCategory } from './security-events';
import {
  SECURITY_MAP_FIXTURE_EXPECTED,
  SECURITY_MAP_FIXTURE_ROWS,
  type SecurityMapFixtureRow,
} from './security-map.fixture';
import {
  SECURITY_CATEGORIES_WITH_DETECTOR,
  SECURITY_MAP_COULD_NOT_CHECK,
  SECURITY_MAP_FAILED_POLLS_BEFORE_STOP,
  SECURITY_MAP_FLOOD_REASONS,
  SECURITY_MAP_FOLDED_REASONS,
  SECURITY_MAP_HEALTH_AT_START,
  SECURITY_MAP_LATE_SOURCES,
  SECURITY_MAP_MAX_ARCS,
  SECURITY_MAP_NOT_COUNTED_YET,
  SECURITY_MAP_POLL_FAILED,
  SECURITY_MAP_POLL_REFUSED,
  SECURITY_MAP_REFUSALS,
  SECURITY_MAP_ROWS_PER_SIGN_IN,
  SECURITY_MAP_STEP_MS,
  SECURITY_MAP_TALLY_REASONS,
  isSecurityMapFloorName,
  isSecurityMapFloodReason,
  isSecurityMapFoldedReason,
  isSecurityMapLateSource,
  isSecurityMapTallyReason,
  planSecurityMapPlayback,
  readSecurityMapAnswer,
  readSecurityMapPollResult,
  readSecurityMapView,
  securityMapArcOf,
  securityMapArcWidth,
  securityMapAsOfWords,
  securityMapClock,
  securityMapCountWords,
  securityMapCounters,
  securityMapEmptyWords,
  securityMapFeedOf,
  securityMapFeedWords,
  securityMapFlaggedFeedOf,
  securityMapHealthAfter,
  securityMapIsFloor,
  securityMapLegend,
  securityMapLegendHelp,
  securityMapModeWords,
  securityMapNextPollDelay,
  securityMapNotes,
  securityMapOutcomeWords,
  securityMapRefusedWindowWords,
  securityMapShortenedWords,
  securityMapShownCategories,
  securityMapStopReason,
  securityMapStopWords,
  securityMapTableRows,
  securityMapViewOf,
  securityMapWindowWords,
  type SecurityCategoryDetectors,
  type SecurityMapAnswer,
  type SecurityMapCategoryCounts,
  type SecurityMapFeedEntry,
  type SecurityMapFeedRow,
  type SecurityMapTimelineCell,
  type SecurityMapView,
  type SecurityMapWholeRead,
} from './security-map';

/**
 * The attack map's rules and words. Pinned: the four lists against the
 * database's shared fixture; an answer of any other shape is "could not
 * check"; a hidden category is never drawn, listed or in the legend, and is
 * counted in words; a flagged event is never called blocked; a folded count
 * says "at least"; no number is made up when a part could not be read; the
 * play is live, a replay or still by the timeline alone, and stops when the
 * page stops updating. Made-up places and organizations only.
 */

/* ───────────────────────────── builders ───────────────────────────── */

const zeros = (): SecurityMapCategoryCounts =>
  Object.fromEntries(
    SECURITY_EVENT_CATEGORIES.map((c) => [c, { blocked: 0, flagged: 0, allowed: 0 }]),
  ) as SecurityMapCategoryCounts;

const counts = (
  over: Partial<
    Record<SecurityEventCategory, Partial<{ blocked: number; flagged: number; allowed: number }>>
  >,
): SecurityMapCategoryCounts => {
  const all = zeros();
  for (const [category, part] of Object.entries(over)) {
    Object.assign(all[category as SecurityEventCategory], part);
  }
  return all;
};

const FROM = '2026-11-22T22:00:00+00:00';
const TO = '2026-11-23T22:00:00+00:00';
const LIVE_FROM = '2026-11-23T21:50:00+00:00';
/** The start a shortened window is read from: three hours before its end, on a whole minute. */
const TO_MINUS_3H = '2026-11-23T19:00:00+00:00';

function answer(over: Partial<SecurityMapAnswer> = {}): SecurityMapAnswer {
  return {
    window: { from: FROM, to: TO, live_from: LIVE_FROM, asked_from: FROM },
    window_shortened: false,
    short_window: false,
    refused: null,
    generated_at: '2026-11-23T22:00:00.123456+00:00',
    oldest_event_at: '2026-11-01T19:42:00+00:00',
    timeline: [],
    timeline_truncated: false,
    by_country: [],
    by_country_truncated: false,
    totals: zeros(),
    no_place: zeros(),
    blocked_window: 0,
    flagged_window: 0,
    allowed_window: 0,
    day_start: null,
    blocked_since_day_start: null,
    blocked_since_day_start_partial: false,
    floors: [],
    feed: [],
    flagged_feed: [],
    late_sources: [],
    tallies: [],
    flood_rows: [],
    ...over,
  };
}

const cell = (
  bucket_start: string,
  bucket_seconds: 600 | 60,
  country: string,
  category: SecurityEventCategory,
  outcome: 'blocked' | 'flagged' | 'allowed',
  events: number,
): SecurityMapTimelineCell => ({
  bucket_start,
  bucket_seconds,
  country,
  category,
  outcome,
  events,
});

const entry = (over: Partial<SecurityMapFeedEntry> = {}): SecurityMapFeedEntry => ({
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

const whole = (over: Partial<SecurityMapAnswer> = {}): SecurityMapWholeRead =>
  securityMapViewOf(answer(over), 'whole') as SecurityMapWholeRead;
/** A poll: the last ten minutes, as the database answers a short window (no 600-second cells, no groups). */
const recent = (over: Partial<SecurityMapAnswer> = {}): SecurityMapView =>
  securityMapViewOf(
    answer({
      window: { from: LIVE_FROM, to: TO, live_from: LIVE_FROM, asked_from: LIVE_FROM },
      short_window: true,
      ...over,
      timeline: (over.timeline ?? []).filter((c) => c.bucket_seconds === 60),
      by_country: [],
    }),
    'recent',
  );

/** A flagged entry of a shown kind. */
const FLAGGED = entry({
  minute: '2026-11-23T21:57:00+00:00',
  outcome: 'flagged',
  reason: 'sign_in_alerts_held',
  events: 2,
});

/** A flagged sign-in held back after too many alerts, folded across two organizations. */
const GB_HELD = entry({
  minute: '2026-11-23T03:20:00+00:00',
  outcome: 'flagged',
  reason: 'sign_in_alerts_held',
  country: 'GB',
  city: 'Example Borough',
  events: 4,
  at_least: true,
  organization_id: 'a0478000-0000-4000-8000-000000000001',
  organization_name: 'Example Academy',
  organizations: 1,
});

/** A busy window: three countries, a flagged kind, a hidden kind, and a live minute. */
const busy = (): Partial<SecurityMapAnswer> => ({
  timeline: [
    cell('2026-11-23T21:58:00+00:00', 60, 'US', 'password_guessing', 'blocked', 4),
    cell('2026-11-23T21:59:00+00:00', 60, 'US', 'password_guessing', 'blocked', 3),
    cell('2026-11-23T21:59:00+00:00', 60, 'PT', 'phishing', 'flagged', 1),
    cell('2026-11-23T03:10:00+00:00', 600, 'DE', 'exploit', 'blocked', 120),
    cell('2026-11-23T03:20:00+00:00', 600, 'DE', 'exploit', 'blocked', 30),
    cell('2026-11-23T03:20:00+00:00', 600, 'GB', 'password_guessing', 'flagged', 4),
    cell('2026-11-23T21:50:00+00:00', 600, 'US', 'password_guessing', 'blocked', 7),
    cell('2026-11-23T21:50:00+00:00', 600, 'PT', 'phishing', 'flagged', 1),
    cell('2026-11-23T21:50:00+00:00', 600, 'US', 'bots', 'allowed', 2),
  ],
  by_country: [
    { country: 'DE', category: 'exploit', outcome: 'blocked', events: 150 },
    { country: 'US', category: 'password_guessing', outcome: 'blocked', events: 7 },
    { country: 'GB', category: 'password_guessing', outcome: 'flagged', events: 4 },
    { country: 'US', category: 'bots', outcome: 'allowed', events: 2 },
    { country: 'PT', category: 'phishing', outcome: 'flagged', events: 1 },
  ],
  totals: counts({
    exploit: { blocked: 150 },
    password_guessing: { blocked: 7, flagged: 4 },
    bots: { blocked: 36, allowed: 2 },
    phishing: { flagged: 3 },
  }),
  no_place: counts({ bots: { blocked: 36 }, phishing: { flagged: 2 } }),
  blocked_window: 193,
  flagged_window: 7,
  allowed_window: 2,
  floors: ['flagged_window', 'totals.password_guessing.flagged', 'totals.phishing.flagged'],
  feed: [
    entry(),
    entry({
      minute: '2026-11-23T21:59:00+00:00',
      category: 'phishing',
      outcome: 'flagged',
      reason: 'sign_in_new_country',
      country: 'PT',
      city: 'Example Harbour',
      events: 1,
      at_least: true,
      organizations: 3,
    }),
    GB_HELD,
  ],
  flagged_feed: [
    entry({
      minute: '2026-11-23T21:59:00+00:00',
      category: 'phishing',
      outcome: 'flagged',
      reason: 'sign_in_new_country',
      country: 'PT',
      city: 'Example Harbour',
      events: 1,
      at_least: true,
      organizations: 3,
    }),
    GB_HELD,
  ],
  late_sources: [{ source: 'api', category: 'password_guessing', outcome: 'blocked', events: 5 }],
  tallies: [
    {
      reason: 'too_many_forms_to_count',
      source: 'api',
      category: 'password_guessing',
      outcome: 'flagged',
      events: 400,
      rows: 1,
    },
  ],
  flood_rows: [
    {
      reason: 'over_buffer_cap',
      source: 'web',
      category: 'bots',
      outcome: 'blocked',
      events: 6,
      rows: 1,
    },
    {
      reason: 'over_minute_cap',
      source: 'web',
      category: 'bots',
      outcome: 'blocked',
      events: 30,
      rows: 1,
    },
  ],
});

/* ───────────────────────────── the lists ───────────────────────────── */

describe("the four lists are the contract's, to the letter", () => {
  it('folded, tally, flood and late', () => {
    expect(SECURITY_MAP_FOLDED_REASONS).toEqual([
      'sign_in_new_country',
      'sign_in_not_me',
      'sign_in_alerts_held',
    ]);
    expect(SECURITY_MAP_TALLY_REASONS).toEqual([
      'too_many_forms_to_count',
      'unrecorded_server_form_password',
      'unrecorded_server_form_code',
    ]);
    expect(SECURITY_MAP_FLOOD_REASONS).toEqual([
      'over_minute_cap',
      'over_buffer_cap',
      'auth_log_over_cap',
    ]);
    expect(SECURITY_MAP_LATE_SOURCES).toEqual(['phone', 'api']);
    expect(SECURITY_MAP_ROWS_PER_SIGN_IN).toBe(5);
  });

  it('no reason is in two lists', () => {
    const all = [
      ...SECURITY_MAP_FOLDED_REASONS,
      ...SECURITY_MAP_TALLY_REASONS,
      ...SECURITY_MAP_FLOOD_REASONS,
    ];
    expect(new Set(all).size).toBe(all.length);
  });
});

/**
 * The database's counting, written out plainly with core's lists, for the
 * shared fixture only: a folded reason's rows of one minute, category,
 * outcome, reason, source, country and city are one unit, counted as the
 * larger of its largest row and a fifth of its rows' sum, rounded up (the
 * rule of 5), and a floor when it is made of two rows or more; a tally is in
 * no total; a row past a cap has no place.
 */
function countFixture(rows: readonly SecurityMapFixtureRow[]) {
  interface Unit extends SecurityMapFixtureRow {
    kind: 'event' | 'tally' | 'flood';
    rows: number[];
    atLeast: boolean;
  }
  const folded = new Map<string, Unit>();
  const units: Unit[] = [];
  for (const row of rows) {
    const plain = { ...row, rows: [row.count], atLeast: false };
    if (isSecurityMapTallyReason(row.reason)) units.push({ ...plain, kind: 'tally' });
    else if (isSecurityMapFloodReason(row.reason)) {
      units.push({ ...plain, country: null, city: null, kind: 'flood' });
    } else if (isSecurityMapFoldedReason(row.reason)) {
      const key = [
        row.minute,
        row.category,
        row.outcome,
        row.reason,
        row.source,
        row.country,
        row.city,
      ].join('|');
      const held = folded.get(key);
      if (held) {
        held.rows.push(row.count);
        const sum = held.rows.reduce((s, n) => s + n, 0);
        held.count = Math.max(
          Math.max(...held.rows),
          Math.ceil(sum / SECURITY_MAP_ROWS_PER_SIGN_IN),
        );
        held.atLeast = true;
      } else {
        const unit: Unit = { ...plain, kind: 'event' };
        folded.set(key, unit);
        units.push(unit);
      }
    } else units.push({ ...plain, kind: 'event' });
  }
  const counted = units.filter((u) => u.kind !== 'tally');
  const sum = (list: Unit[]) => list.reduce((s, u) => s + u.count, 0);
  const grouped = (list: Unit[], key: (u: Unit) => string) => {
    const out = new Map<string, number>();
    for (const u of list) out.set(key(u), (out.get(key(u)) ?? 0) + u.count);
    return out;
  };
  const byCountry = [
    ...grouped(
      counted.filter((u) => u.country !== null),
      (u) => `${u.country}|${u.category}|${u.outcome}`,
    ),
  ]
    .map(([key, events]) => [...key.split('|'), events])
    .sort(
      (a, b) => (b[3] as number) - (a[3] as number) || String(a[0]).localeCompare(String(b[0])),
    );
  const listed = (kind: 'tally' | 'flood') =>
    [
      ...grouped(
        units.filter((u) => u.kind === kind),
        (u) => `${u.reason}|${u.source}|${u.category}|${u.outcome}`,
      ),
    ]
      .map(([key, events]) => [
        ...key.split('|'),
        events,
        units.filter(
          (u) => u.kind === kind && `${u.reason}|${u.source}|${u.category}|${u.outcome}` === key,
        ).length,
      ])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const floorOf = (list: Unit[], name: string) => (list.some((u) => u.atLeast) ? [name] : []);
  const floors = [
    ...['blocked', 'flagged', 'allowed'].flatMap((o) =>
      floorOf(
        counted.filter((u) => u.outcome === o),
        `${o}_window`,
      ),
    ),
    ...SECURITY_EVENT_CATEGORIES.flatMap((c) =>
      ['blocked', 'flagged', 'allowed'].flatMap((o) => [
        ...floorOf(
          counted.filter((u) => u.category === c && u.outcome === o),
          `totals.${c}.${o}`,
        ),
        ...floorOf(
          counted.filter((u) => u.category === c && u.outcome === o && u.country === null),
          `no_place.${c}.${o}`,
        ),
      ]),
    ),
  ].sort();
  const late = [
    ...grouped(
      counted.filter((u) => isSecurityMapLateSource(u.source)),
      (u) => `${u.source}|${u.category}|${u.outcome}`,
    ),
  ].map(([key, events]) => [...key.split('|'), events]);
  return {
    floors,
    late_sources: late,
    blocked_window: sum(counted.filter((u) => u.outcome === 'blocked')),
    flagged_window: sum(counted.filter((u) => u.outcome === 'flagged')),
    allowed_window: sum(counted.filter((u) => u.outcome === 'allowed')),
    totals: Object.fromEntries(grouped(counted, (u) => `${u.category}.${u.outcome}`)),
    no_place: Object.fromEntries(
      grouped(
        counted.filter((u) => u.country === null),
        (u) => `${u.category}.${u.outcome}`,
      ),
    ),
    by_country: byCountry,
    tallies: listed('tally'),
    flood_rows: listed('flood'),
  };
}

describe("the shared fixture: core's lists give the database's numbers", () => {
  it("the fold, tally and flood lists and the rule of 5: the database's numbers, floors included", () => {
    const got = countFixture(SECURITY_MAP_FIXTURE_ROWS);
    const want = SECURITY_MAP_FIXTURE_EXPECTED;
    expect(got.blocked_window).toBe(want.blocked_window);
    expect(got.flagged_window).toBe(want.flagged_window);
    expect(got.allowed_window).toBe(want.allowed_window);
    expect(got.totals).toEqual(want.totals);
    expect(got.no_place).toEqual(want.no_place);
    expect(got.by_country).toEqual(want.by_country);
    expect(got.tallies).toEqual(want.tallies);
    expect(got.flood_rows).toEqual(want.flood_rows);
    expect(got.late_sources).toEqual(want.late_sources);
    expect(got.floors).toEqual([...want.floors].sort());
    for (const name of got.floors) expect(isSecurityMapFloorName(name), name).toBe(true);
  });

  it('the numbers the rules exist to avoid are the plain sums', () => {
    const flagged = SECURITY_MAP_FIXTURE_ROWS.filter((r) => r.outcome === 'flagged');
    const sum = (rows: readonly SecurityMapFixtureRow[]) => rows.reduce((s, r) => s + r.count, 0);
    expect(sum(flagged.filter((r) => !isSecurityMapTallyReason(r.reason)))).toBe(
      SECURITY_MAP_FIXTURE_EXPECTED.flagged_unfolded,
    );
    expect(sum(flagged)).toBe(SECURITY_MAP_FIXTURE_EXPECTED.flagged_plain_sum);
  });

  it('a late source is the phone app or a direct caller, and nothing else', () => {
    expect(['web', 'phone', 'api', 'email', 'edge'].filter(isSecurityMapLateSource)).toEqual([
      'phone',
      'api',
    ]);
  });
});

/* ─────────────────────── the database's answer ─────────────────────── */

describe("readSecurityMapAnswer: the contract's shape and nothing else", () => {
  it('reads the documented answer, empty and busy', () => {
    expect(readSecurityMapAnswer(answer())).toMatchObject({ ok: true, refused: null });
    const read = readSecurityMapAnswer(answer(busy()));
    expect(read.ok && read.answer?.blocked_window).toBe(193);
    // An empty record, and a day count.
    expect(
      readSecurityMapAnswer(
        answer({ oldest_event_at: null, day_start: FROM, blocked_since_day_start: 0 }),
      ).ok,
    ).toBe(true);
  });

  it('a window that was refused is exactly three keys and one of five words', () => {
    expect(SECURITY_MAP_REFUSALS).toEqual([
      'not_a_time',
      'to_in_the_future',
      'from_not_before_to',
      'longer_than_26_hours',
      'too_many_events_in_one_minute',
    ]);
    for (const refused of SECURITY_MAP_REFUSALS) {
      expect(readSecurityMapAnswer({ window: null, refused, generated_at: TO })).toEqual({
        ok: true,
        refused,
        answer: null,
      });
    }
    expect(readSecurityMapAnswer({ window: null, refused: 'because', generated_at: TO }).ok).toBe(
      false,
    );
    expect(
      readSecurityMapAnswer({ window: null, refused: 'not_a_time', generated_at: TO, feed: [] }).ok,
    ).toBe(false);
    expect(readSecurityMapAnswer({ ...answer(), refused: 'not_a_time' }).ok).toBe(false);
  });

  it('a key too many, a key missing, a list past its cap or a value of the wrong kind is not read', () => {
    const bad: Array<[string, unknown]> = [
      ['an extra key', { ...answer(), source_hash: 'x' }],
      [
        'a key missing',
        (() => {
          const a: Record<string, unknown> = { ...answer() };
          delete a.tallies;
          return a;
        })(),
      ],
      [
        'a feed entry with an extra key',
        answer({ feed: [{ ...entry(), ip: 'MARKER-NOT-AN-ADDRESS' } as never] }),
      ],
      ['a feed past 60', answer({ feed: Array.from({ length: 61 }, () => entry()) })],
      [
        'a timeline past 4,000',
        answer({
          timeline: Array.from({ length: 4001 }, () => cell(FROM, 600, 'US', 'bots', 'blocked', 1)),
        }),
      ],
      [
        'a by-country list past 2,000',
        answer({
          by_country: Array.from({ length: 2001 }, () => ({
            country: 'US',
            category: 'bots' as const,
            outcome: 'blocked' as const,
            events: 1,
          })),
        }),
      ],
      [
        'a bucket of another length',
        answer({
          timeline: [
            { ...cell(FROM, 600, 'US', 'bots', 'blocked', 1), bucket_seconds: 300 as never },
          ],
        }),
      ],
      [
        'a country that is not two capital letters',
        answer({
          by_country: [{ country: 'usa', category: 'bots', outcome: 'blocked', events: 1 }],
        }),
      ],
      [
        'a category the record does not have',
        answer({
          by_country: [{ country: 'US', category: 'spam' as never, outcome: 'blocked', events: 1 }],
        }),
      ],
      ['a count that is a fraction', answer({ blocked_window: 1.5 })],
      ['a negative count', answer({ flagged_window: -1 })],
      ['a count as text', answer({ allowed_window: '3' as never })],
      [
        'totals without a category',
        answer({
          totals: (() => {
            const t: Record<string, unknown> = { ...zeros() };
            delete t.malware;
            return t as never;
          })(),
        }),
      ],
      ['a city of 81 characters', answer({ feed: [entry({ city: 'x'.repeat(81) })] })],
      [
        'an organization name of 201 characters',
        answer({ feed: [entry({ organization_name: 'x'.repeat(201) })] }),
      ],
      [
        'an organization id that is no id',
        answer({ feed: [entry({ organization_id: 'not-an-id' })] }),
      ],
      ['a reason that is no code', answer({ feed: [entry({ reason: 'Wrong Password' })] })],
      [
        'a source the record does not have',
        answer({
          late_sources: [
            { source: 'fax' as never, category: 'bots', outcome: 'blocked', events: 1 },
          ],
        }),
      ],
      ['a time that is no time', answer({ generated_at: 'yesterday' })],
      [
        'a feed entry with no at_least',
        answer({ feed: [{ ...entry(), at_least: undefined } as never] }),
      ],
      [
        'an at_least that is not true or false',
        answer({ feed: [entry({ at_least: 1 as never })] }),
      ],
      [
        'a flagged feed past 20',
        answer({ flagged_feed: Array.from({ length: 21 }, () => FLAGGED) }),
      ],
      ['a blocked entry in the flagged feed', answer({ flagged_feed: [entry()] })],
      [
        'a floor with a name the answer has not',
        answer({ floors: ['totals.spam.blocked' as never] }),
      ],
      ['a floor that is the feed', answer({ floors: ['feed' as never] })],
      [
        'floors past 40',
        answer({ floors: Array.from({ length: 41 }, () => 'flagged_window' as const) }),
      ],
      ['floors that are not a list', answer({ floors: 'flagged_window' as never })],
      [
        'a window with no start asked for',
        answer({ window: { from: FROM, to: TO, live_from: LIVE_FROM } as never }),
      ],
      [
        'a window read later than asked but not said to be shortened',
        answer({ window: { from: TO_MINUS_3H, to: TO, live_from: LIVE_FROM, asked_from: FROM } }),
      ],
      ['a window said to be shortened that was read as asked', answer({ window_shortened: true })],
      [
        'a window read from before the start asked for',
        answer({ window: { from: FROM, to: TO, live_from: LIVE_FROM, asked_from: TO_MINUS_3H } }),
      ],
      ['a partial day count with no count', answer({ blocked_since_day_start_partial: true })],
      [
        'a partial day count not named a floor',
        answer({
          day_start: FROM,
          blocked_since_day_start: 9,
          blocked_since_day_start_partial: true,
          floors: [],
        }),
      ],
      ['short_window as text', answer({ short_window: 'yes' as never })],
      [
        'a replay cell in a poll',
        answer({ short_window: true, timeline: [cell(FROM, 600, 'US', 'bots', 'blocked', 1)] }),
      ],
      [
        'groups by country in a poll',
        answer({
          short_window: true,
          by_country: [{ country: 'US', category: 'bots', outcome: 'blocked', events: 1 }],
        }),
      ],
      [
        'a poll that says its groups were cut',
        answer({ short_window: true, by_country_truncated: true }),
      ],
      [
        'a poll past 1,000 cells',
        answer({
          short_window: true,
          timeline: Array.from({ length: 1001 }, () =>
            cell(LIVE_FROM, 60, 'US', 'bots', 'blocked', 1),
          ),
        }),
      ],
      [
        'tallies past 300',
        answer({ tallies: Array.from({ length: 301 }, () => busy().tallies![0]!) }),
      ],
      ['not an object', [answer()]],
      ['nothing', null],
    ];
    for (const [name, raw] of bad) {
      expect(readSecurityMapAnswer(raw).ok, name).toBe(false);
    }
  });

  it("reads version 2's parts: a shortened window, a poll, a partial day count, floors and the flagged feed", () => {
    const shortened = answer({
      window: { from: TO_MINUS_3H, to: TO, live_from: LIVE_FROM, asked_from: FROM },
      window_shortened: true,
      day_start: FROM,
      blocked_since_day_start: 12,
      blocked_since_day_start_partial: true,
      floors: ['blocked_since_day_start', 'no_place.bots.blocked', 'allowed_window'],
      flagged_feed: [FLAGGED],
    });
    expect(readSecurityMapAnswer(shortened).ok).toBe(true);
    const poll = answer({
      window: { from: LIVE_FROM, to: TO, live_from: LIVE_FROM, asked_from: LIVE_FROM },
      short_window: true,
      timeline: Array.from({ length: 1000 }, () => cell(LIVE_FROM, 60, 'US', 'bots', 'blocked', 1)),
    });
    expect(readSecurityMapAnswer(poll).ok).toBe(true);
    expect(
      readSecurityMapAnswer(
        answer({ tallies: Array.from({ length: 300 }, () => busy().tallies![0]!) }),
      ).ok,
    ).toBe(true);
    // Every name a floor can have is read; nothing else is.
    for (const name of ['totals.malware.allowed', 'no_place.exploit.flagged', 'flagged_window']) {
      expect(isSecurityMapFloorName(name), name).toBe(true);
    }
    for (const name of ['totals', 'totals.bots', 'by_country', 'blocked_today', '']) {
      expect(isSecurityMapFloorName(name), name).toBe(false);
    }
  });

  it('says where the shape differs and never repeats a value from the answer', () => {
    const read = readSecurityMapAnswer(
      answer({ feed: [entry(), entry({ organization_id: 'SECRET-LOOKING-VALUE' })] }),
    );
    expect(read).toEqual({ ok: false, where: 'feed.1.organization_id: not an id' });
    const extra = readSecurityMapAnswer({ ...answer(), session_id_of_someone: 1 });
    expect(extra).toEqual({ ok: false, where: 'a key this build does not know' });
  });

  it('a name of 200 characters that are two code units each is read', () => {
    expect(
      readSecurityMapAnswer(
        answer({ feed: [entry({ organization_name: '\u{1F512}'.repeat(200) })] }),
      ).ok,
    ).toBe(true);
  });
});

/* ───────────────────── which categories are shown ───────────────────── */

describe('the categories the map shows', () => {
  it('today: password guessing, exploit attempts and automated traffic; Phishing and Malware are hidden', () => {
    expect(securityMapShownCategories()).toEqual(['password_guessing', 'exploit', 'bots']);
    expect(SECURITY_CATEGORIES_WITH_DETECTOR.phishing.shown).toBe(false);
    expect(SECURITY_CATEGORIES_WITH_DETECTOR.malware.shown).toBe(false);
  });

  it('showing Phishing is one line; a category nothing records cannot be shown', () => {
    const flipped: Record<SecurityEventCategory, SecurityCategoryDetectors> = {
      ...SECURITY_CATEGORIES_WITH_DETECTOR,
      phishing: { ...SECURITY_CATEGORIES_WITH_DETECTOR.phishing, shown: true },
      malware: { ...SECURITY_CATEGORIES_WITH_DETECTOR.malware, shown: true },
    };
    expect(securityMapShownCategories(flipped)).toEqual([
      'password_guessing',
      'exploit',
      'bots',
      'phishing',
    ]);
  });

  it("the legend's help is made from what records the category now, never a fixed sentence", () => {
    expect(securityMapLegendHelp('exploit')).toBe(
      'Counted today from: requests for files and pages this site never serves.',
    );
    expect(securityMapLegendHelp('malware')).toBeNull();
    const two: Record<SecurityEventCategory, SecurityCategoryDetectors> = {
      ...SECURITY_CATEGORIES_WITH_DETECTOR,
      exploit: { shown: true, firesNow: ['one thing', 'another thing'] },
      bots: { shown: true, firesNow: ['a', 'b', 'c'] },
    };
    expect(securityMapLegendHelp('exploit', two)).toBe(
      'Counted today from: one thing and another thing.',
    );
    expect(securityMapLegendHelp('bots', two)).toBe('Counted today from: a; b; and c.');
    // Nothing that cannot be recorded while the passkey switches are off is named.
    for (const category of SECURITY_EVENT_CATEGORIES) {
      expect(securityMapLegendHelp(category) ?? '').not.toMatch(/passkey/i);
    }
  });
});

/* ─────────────────────────────── the view ─────────────────────────────── */

const securityMapArcKey = (row: Parameters<typeof securityMapArcOf>[0]): string =>
  securityMapArcOf(row).key;

describe('securityMapViewOf: what leaves the server', () => {
  const view = whole(busy());

  it('a hidden category is in no arc, no step, no table row, no legend line and no feed entry', () => {
    const phishing = SECURITY_EVENT_CATEGORIES.indexOf('phishing');
    const rows = [
      ...view.live,
      ...view.whole.still,
      ...view.whole.table,
      ...view.whole.steps.flatMap(([, arcs]) => arcs),
    ];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => row[1] === phishing)).toBe(false);
    expect(rows.some((row) => row[0] === 'PT')).toBe(false);
    expect(view.whole.legend.map(([c]) => SECURITY_EVENT_CATEGORIES[c])).toEqual([
      'password_guessing',
      'exploit',
      'bots',
    ]);
    expect(view.feed.some((row) => row[1] === phishing)).toBe(false);
    expect(view.feed).toHaveLength(2);
    expect(JSON.stringify(view)).not.toContain('Example Harbour');
  });

  it("its events are counted for one line of words, and stay in the window's sums", () => {
    expect(view.whole.notDrawnSignInAlerts).toBe(3);
    expect(view.whole.notDrawnOther).toBe(0);
    expect(view.whole.flagged).toBe(7);
    expect(view.whole.blocked).toBe(193);
  });

  it('shown, it is drawn like any other', () => {
    const shown = ['password_guessing', 'exploit', 'bots', 'phishing'] as const;
    const all = securityMapViewOf(answer(busy()), 'whole', shown);
    expect(all.live.map(securityMapArcKey)).toContain('PT:phishing:flagged');
    expect(all.whole?.notDrawnSignInAlerts).toBe(0);
    expect(all.feed).toHaveLength(3);
  });

  it('an allowed event is never an arc or a table row; it is counted in words', () => {
    const bots = SECURITY_EVENT_CATEGORIES.indexOf('bots');
    expect(view.whole.table.some((row) => row[1] === bots)).toBe(false);
    expect(view.whole.allowed).toBe(2);
  });

  it('the live arcs add up the last ten minutes, one per country, category and outcome', () => {
    expect(view.live).toEqual([['US', 0, 0, 7]]);
    expect(view.liveCut).toBe(false);
  });

  it('the replay is the 600-second cells by clock hour, the hours in time order, empty hours left out', () => {
    expect(view.whole.steps).toEqual([
      [
        Date.parse('2026-11-23T03:00:00Z'),
        [
          ['DE', 1, 0, 150],
          ['GB', 0, 1, 4],
        ],
      ],
      [Date.parse('2026-11-23T21:00:00Z'), [['US', 0, 0, 7]]],
    ]);
  });

  it('the still picture and the table are the by-country counts, the largest first', () => {
    expect(view.whole.table).toEqual([
      ['DE', 1, 0, 150],
      ['US', 0, 0, 7],
      ['GB', 0, 1, 4],
    ]);
    expect(view.whole.still).toEqual(view.whole.table);
  });

  it('at most 40 arcs live, in an hour and in the still picture, and the view says when it cut', () => {
    const codes = Array.from(
      { length: 45 },
      (_, i) =>
        `${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}`,
    );
    const many = whole({
      timeline: [
        ...codes.map((c, i) => cell('2026-11-23T21:55:00+00:00', 60, c, 'bots', 'blocked', i + 1)),
        ...codes.map((c, i) => cell('2026-11-23T05:00:00+00:00', 600, c, 'bots', 'blocked', i + 1)),
      ],
      by_country: codes.map((c, i) => ({
        country: c,
        category: 'bots' as const,
        outcome: 'blocked' as const,
        events: i + 1,
      })),
    });
    expect(many.live).toHaveLength(SECURITY_MAP_MAX_ARCS);
    expect(many.liveCut).toBe(true);
    expect(many.whole.steps[0]?.[1]).toHaveLength(SECURITY_MAP_MAX_ARCS);
    expect(many.whole.drawingCut).toBe(true);
    expect(many.whole.still).toHaveLength(SECURITY_MAP_MAX_ARCS);
    // The table is the accessible version: it keeps every row.
    expect(many.whole.table).toHaveLength(45);
    // The largest are the ones kept.
    expect(many.live[0]?.[3]).toBe(45);
    expect(many.live.at(-1)?.[3]).toBe(6);
  });

  it("the database's own cut flags are carried", () => {
    const cut = whole({ timeline_truncated: true, by_country_truncated: true });
    expect(cut.liveCut).toBe(true);
    expect(cut.whole.drawingCut).toBe(true);
    expect(cut.whole.tableCut).toBe(true);
  });

  it('no place, floods, late sources and tallies are sums of what the answer lists', () => {
    expect(view.whole.noPlace).toBe(36);
    expect(view.whole.flood).toBe(36);
    expect(view.whole.late).toBe(5);
    expect(view.whole.tallyEvents).toBe(400);
    expect(view.whole.tallyRows).toBe(1);
  });

  it('a read of the last ten minutes carries the live arcs and the two feeds, and no totals', () => {
    const r = recent(busy());
    expect(r.whole).toBeNull();
    expect(r.live).toEqual([['US', 0, 0, 7]]);
    expect(r.feed).toHaveLength(2);
    expect(r.flaggedFeed).toHaveLength(1);
    expect(Object.keys(r).sort()).toEqual([
      'askedFrom',
      'feed',
      'flaggedFeed',
      'from',
      'generatedAt',
      'live',
      'liveCut',
      'liveFrom',
      'scope',
      'shortened',
      'to',
      'v',
      'whole',
    ]);
  });

  it('the flagged feed: the shown kinds only, flagged only, each with its own "at least"', () => {
    expect(view.flaggedFeed).toEqual([
      [
        '2026-11-23T03:20:00+00:00',
        0,
        1,
        'sign_in_alerts_held',
        'web',
        'GB',
        'Example Borough',
        4,
        true,
        'a0478000-0000-4000-8000-000000000001',
        'Example Academy',
        1,
      ],
    ]);
    expect(view.feed.map((row) => row[8])).toEqual([false, true]);
  });

  it('the floors, the partial day count and the window read are carried as the database gives them', () => {
    expect(view.whole.floors).toEqual([
      'flagged_window',
      'totals.password_guessing.flagged',
      'totals.phishing.flagged',
    ]);
    expect(view.whole.blockedSinceDayStartPartial).toBe(false);
    expect(view.whole.lateFloor).toBe(false);
    expect([view.shortened, view.askedFrom, view.from]).toEqual([false, FROM, FROM]);
    const cut = whole({
      ...busy(),
      window: { from: TO_MINUS_3H, to: TO, live_from: LIVE_FROM, asked_from: FROM },
      window_shortened: true,
      day_start: FROM,
      blocked_since_day_start: 9,
      blocked_since_day_start_partial: true,
      floors: ['blocked_since_day_start', 'totals.password_guessing.blocked'],
    });
    expect([cut.shortened, cut.askedFrom, cut.from]).toEqual([true, FROM, TO_MINUS_3H]);
    expect(cut.whole.blockedSinceDayStartPartial).toBe(true);
    // The late line is api password guessing blocked, and that total is a floor.
    expect(cut.whole.lateFloor).toBe(true);
  });
});

describe('readSecurityMapView: the browser reads what the server handed it', () => {
  it('a view survives the trip as JSON', () => {
    const view = whole(busy());
    expect(readSecurityMapView(JSON.parse(JSON.stringify(view)))).toEqual(view);
    const r = recent(busy());
    expect(readSecurityMapView(JSON.parse(JSON.stringify(r)))).toEqual(r);
  });

  it('a row of a category this build does not show is not a view', () => {
    const view = JSON.parse(JSON.stringify(whole(busy()))) as SecurityMapView;
    const phishing = SECURITY_EVENT_CATEGORIES.indexOf('phishing');
    expect(readSecurityMapView({ ...view, live: [['PT', phishing, 1, 1]] })).toBeNull();
    expect(
      readSecurityMapView({ ...view, whole: { ...view.whole, table: [['PT', phishing, 1, 1]] } }),
    ).toBeNull();
    expect(
      readSecurityMapView({
        ...view,
        feed: [
          [
            '2026-11-23T21:59:00+00:00',
            phishing,
            1,
            'sign_in_new_country',
            'web',
            'PT',
            null,
            1,
            true,
            null,
            null,
            3,
          ],
        ],
      }),
    ).toBeNull();
    const phishingFlagged: SecurityMapFeedRow = [
      '2026-11-23T21:59:00+00:00',
      phishing,
      1,
      'sign_in_new_country',
      'web',
      'PT',
      null,
      1,
      true,
      null,
      null,
      3,
    ];
    expect(readSecurityMapView({ ...view, flaggedFeed: [phishingFlagged] })).toBeNull();
  });

  it('anything else is not a view', () => {
    const view = JSON.parse(JSON.stringify(whole(busy()))) as Record<string, unknown>;
    const w = view.whole as Record<string, unknown>;
    const bad: Array<[string, unknown]> = [
      ['the version before', { ...view, v: 1 }],
      ['a version after', { ...view, v: 3 }],
      ['no flagged feed', { ...view, flaggedFeed: undefined }],
      [
        'a blocked entry in the flagged feed',
        { ...view, flaggedFeed: [[...(view.feed as unknown[][])[0]!]] },
      ],
      ['shortened as text', { ...view, shortened: 'no' }],
      ['no start asked for', { ...view, askedFrom: null }],
      ['a floor by another name', { ...view, whole: { ...w, floors: ['legend'] } }],
      [
        'a partial day count as text',
        { ...view, whole: { ...w, blockedSinceDayStartPartial: 'no' } },
      ],
      [
        'a partial day count with no count',
        { ...view, whole: { ...w, blockedSinceDayStartPartial: true, blockedSinceDayStart: null } },
      ],
      [
        'a partial day count not named a floor',
        {
          ...view,
          whole: { ...w, blockedSinceDayStartPartial: true, blockedSinceDayStart: 9, floors: [] },
        },
      ],
      ['an extra key', { ...view, extra: 1 }],
      ['41 live arcs', { ...view, live: Array.from({ length: 41 }, () => ['US', 0, 0, 1]) }],
      ['an arc with no events', { ...view, live: [['US', 0, 0, 0]] }],
      ['an outcome that is not drawn', { ...view, live: [['US', 0, 2, 1]] }],
      ['a country that is no code', { ...view, live: [['<b>', 0, 0, 1]] }],
      ['a whole part on a recent read', { ...view, scope: 'recent' }],
      ['no whole part on a whole read', { ...view, whole: null }],
      ['a count that is text', { ...view, whole: { ...w, blocked: '193' } }],
      ['a legend of other categories', { ...view, whole: { ...w, legend: [[0, 1, 1]] } }],
      ['an empty step', { ...view, whole: { ...w, steps: [[0, []]] } }],
      [
        'a feed row of the eleven parts of version 1',
        {
          ...view,
          feed: [
            [
              '2026-11-23T21:59:00+00:00',
              0,
              0,
              'wrong_password',
              'web',
              'US',
              null,
              1,
              null,
              null,
              0,
            ],
          ],
        },
      ],
      ['text', 'view'],
    ];
    for (const [name, raw] of bad) expect(readSecurityMapView(raw), name).toBeNull();
  });
});

describe("a poll's answer", () => {
  it('a refusal is one fixed value, and it is not the failed read', () => {
    expect(SECURITY_MAP_POLL_REFUSED).toEqual({ ok: false, reason: 'refused' });
    expect(Object.isFrozen(SECURITY_MAP_POLL_REFUSED)).toBe(true);
    expect(SECURITY_MAP_POLL_FAILED).toEqual({ ok: false, reason: 'could_not_check' });
    expect(readSecurityMapPollResult({ ok: false, reason: 'refused' })).toBe(
      SECURITY_MAP_POLL_REFUSED,
    );
    expect(readSecurityMapPollResult({ ok: false, reason: 'could_not_check' })).toBe(
      SECURITY_MAP_POLL_FAILED,
    );
  });

  it('a view, a refused window, and anything else as a failed read', () => {
    const view = JSON.parse(JSON.stringify(recent(busy()))) as SecurityMapView;
    expect(readSecurityMapPollResult({ ok: true, view, refusedWindow: null })).toEqual({
      ok: true,
      view,
      refusedWindow: null,
    });
    expect(
      readSecurityMapPollResult({ ok: true, view: null, refusedWindow: 'to_in_the_future' }),
    ).toEqual({
      ok: true,
      view: null,
      refusedWindow: 'to_in_the_future',
    });
    for (const raw of [
      undefined,
      null,
      {},
      { ok: true },
      { ok: true, view: { ...view, v: 9 }, refusedWindow: null },
      { ok: true, view: null, refusedWindow: 'because' },
      { ok: true, view, refusedWindow: 'to_in_the_future' },
      { ok: false, reason: 'something else' },
    ]) {
      expect(readSecurityMapPollResult(raw)).toBe(SECURITY_MAP_POLL_FAILED);
    }
  });
});

/* ───────────────────────────── the playback ───────────────────────────── */

describe('the playback plan', () => {
  it('LIVE when the last ten minutes hold events', () => {
    const plan = planSecurityMapPlayback(whole(busy()), null);
    expect(plan.mode).toBe('live');
    expect(plan.live.map((a) => a.key)).toEqual(['US:password_guessing:blocked']);
    expect(plan.steps).toEqual([]);
    expect(plan.picture).toEqual(plan.live);
  });

  it('REPLAY when they hold none and the window holds some', () => {
    const quiet = busy();
    quiet.timeline = quiet.timeline?.filter((c) => c.bucket_seconds === 600);
    const plan = planSecurityMapPlayback(whole(quiet), null);
    expect(plan.mode).toBe('replay');
    expect(plan.live).toEqual([]);
    expect(
      plan.steps.map((s) => [new Date(s.fromMs).toISOString(), s.toMs - s.fromMs, s.arcs.length]),
    ).toEqual([
      ['2026-11-23T03:00:00.000Z', SECURITY_MAP_STEP_MS, 2],
      ['2026-11-23T21:00:00.000Z', SECURITY_MAP_STEP_MS, 1],
    ]);
    expect(plan.picture.map((a) => a.key)).toEqual([
      'DE:exploit:blocked',
      'US:password_guessing:blocked',
      'GB:password_guessing:flagged',
    ]);
  });

  it('STILL when the window holds nothing to draw, and with no read at all', () => {
    expect(planSecurityMapPlayback(whole(), null)).toEqual({
      mode: 'still',
      live: [],
      steps: [],
      picture: [],
      cut: false,
    });
    expect(planSecurityMapPlayback(null, null).mode).toBe('still');
    // Only a hidden category in the last ten minutes: nothing is live.
    const hiddenOnly = whole({
      timeline: [cell('2026-11-23T21:59:00+00:00', 60, 'PT', 'phishing', 'flagged', 1)],
    });
    expect(planSecurityMapPlayback(hiddenOnly, null).mode).toBe('still');
  });

  it('the late sources never make the play live: only the 60-second cells do, and the database keeps late rows out of them', () => {
    // An hour-late row is in the 600-second cell of the last ten minutes and in no 60-second cell.
    const late = whole({
      timeline: [cell('2026-11-23T21:50:00+00:00', 600, 'US', 'password_guessing', 'blocked', 9)],
    });
    expect(planSecurityMapPlayback(late, null).mode).toBe('replay');
  });

  it('the newer read of the last ten minutes decides live; an older one is ignored', () => {
    const quiet = busy();
    quiet.timeline = quiet.timeline?.filter((c) => c.bucket_seconds === 600);
    const w = whole(quiet);
    const newer = recent({
      generated_at: '2026-11-23T22:00:30+00:00',
      timeline: [cell('2026-11-23T22:00:00+00:00', 60, 'FR', 'exploit', 'blocked', 2)],
    });
    expect(planSecurityMapPlayback(w, newer).live.map((a) => a.key)).toEqual([
      'FR:exploit:blocked',
    ]);
    const older = recent({
      generated_at: '2026-11-23T21:59:00+00:00',
      timeline: [cell('2026-11-23T21:58:00+00:00', 60, 'FR', 'exploit', 'blocked', 2)],
    });
    expect(planSecurityMapPlayback(w, older).mode).toBe('replay');
    // A newer read with nothing live ends the live play, whatever the whole read held.
    const emptied = recent({ generated_at: '2026-11-23T22:00:30+00:00' });
    expect(planSecurityMapPlayback(whole(busy()), emptied).mode).toBe('replay');
    // A recent read alone can be live.
    expect(planSecurityMapPlayback(null, newer).mode).toBe('live');
  });

  it('flagged is a different arc from blocked for the same country and category', () => {
    const both = whole({
      timeline: [
        cell('2026-11-23T21:59:00+00:00', 60, 'GB', 'password_guessing', 'blocked', 2),
        cell('2026-11-23T21:59:00+00:00', 60, 'GB', 'password_guessing', 'flagged', 1),
      ],
    });
    const arcs = planSecurityMapPlayback(both, null).live;
    expect(arcs.map((a) => [a.key, a.outcome])).toEqual([
      ['GB:password_guessing:blocked', 'blocked'],
      ['GB:password_guessing:flagged', 'flagged'],
    ]);
  });

  it("an arc's width is its count on a log scale, never wider than the widest", () => {
    expect([0, 1, 10, 100, 1000, 10_000, 5_000_000].map(securityMapArcWidth)).toEqual([
      1, 1, 1.75, 2.5, 3.25, 4, 4,
    ]);
    expect(securityMapArcWidth(Number.NaN)).toBe(1);
    expect(securityMapArcOf(['US', 0, 0, 100])).toEqual({
      key: 'US:password_guessing:blocked',
      country: 'US',
      category: 'password_guessing',
      outcome: 'blocked',
      events: 100,
      width: 2.5,
    });
  });
});

describe('the feed of two reads', () => {
  const old = entry({ minute: '2026-11-23T20:00:00+00:00', reason: 'wrong_code' });
  const stale = entry({ minute: '2026-11-23T21:55:00+00:00', events: 1 });
  const fresh = entry({ minute: '2026-11-23T21:55:00+00:00', events: 3 });
  const w = whole({ feed: [stale, old] });

  it("inside the newer read's ten minutes only its entries count; before them, the whole window's", () => {
    const r = recent({ generated_at: '2026-11-23T22:00:30+00:00', feed: [fresh] });
    const feed = securityMapFeedOf(w, r);
    expect(feed.map((row) => [row[0], row[3], row[7]])).toEqual([
      ['2026-11-23T21:55:00+00:00', 'wrong_password', 3],
      ['2026-11-23T20:00:00+00:00', 'wrong_code', 11],
    ]);
  });

  it('an older recent read changes nothing; one read alone is its own feed; at most 60', () => {
    const r = recent({ generated_at: '2026-11-23T21:00:00+00:00', feed: [fresh] });
    expect(securityMapFeedOf(w, r)).toEqual(w.feed);
    expect(securityMapFeedOf(null, r)).toEqual(r.feed);
    expect(securityMapFeedOf(null, null)).toEqual([]);
    const full = whole({ feed: Array.from({ length: 60 }, () => old) });
    const newer = recent({ generated_at: '2026-11-23T22:00:30+00:00', feed: [fresh, fresh] });
    expect(securityMapFeedOf(full, newer)).toHaveLength(60);
  });

  it('the flagged feed is merged the same way, at most 20, and never from the plain feed', () => {
    const oldFlag = entry({ ...FLAGGED, minute: '2026-11-23T20:00:00+00:00', events: 1 });
    const staleFlag = entry({ ...FLAGGED, events: 1 });
    const freshFlag = entry({ ...FLAGGED, events: 5, at_least: true });
    const wf = whole({ feed: [stale, old], flagged_feed: [staleFlag, oldFlag] });
    const rf = recent({
      generated_at: '2026-11-23T22:00:30+00:00',
      feed: [fresh],
      flagged_feed: [freshFlag],
    });
    expect(securityMapFlaggedFeedOf(wf, rf).map((row) => [row[0], row[7], row[8]])).toEqual([
      ['2026-11-23T21:57:00+00:00', 5, true],
      ['2026-11-23T20:00:00+00:00', 1, false],
    ]);
    // A blocked entry of the plain feed is never in it.
    expect(securityMapFlaggedFeedOf(wf, rf).every((row) => row[2] === 1)).toBe(true);
    const many = whole({ flagged_feed: Array.from({ length: 20 }, () => oldFlag) });
    const newer = recent({ generated_at: '2026-11-23T22:00:30+00:00', flagged_feed: [freshFlag] });
    expect(securityMapFlaggedFeedOf(many, newer)).toHaveLength(20);
    expect(securityMapFlaggedFeedOf(null, null)).toEqual([]);
  });
});

describe('polling and when the play stops', () => {
  it('a failed read backs off: 30 s, 60 s, then 120 s', () => {
    expect([0, 1, 2, 3, 50].map(securityMapNextPollDelay)).toEqual([
      30_000, 60_000, 120_000, 120_000, 120_000,
    ]);
  });

  it('health: a good read clears the failures and is remembered; a refusal is a failure too', () => {
    let health = SECURITY_MAP_HEALTH_AT_START;
    health = securityMapHealthAfter(health, 'ok', 1000);
    expect(health).toEqual({ failures: 0, lastGoodAt: 1000, refused: false });
    health = securityMapHealthAfter(health, 'failed', 2000);
    expect(health).toEqual({ failures: 1, lastGoodAt: 1000, refused: false });
    health = securityMapHealthAfter(health, 'refused', 3000);
    expect(health).toEqual({ failures: 2, lastGoodAt: 1000, refused: true });
    expect(securityMapHealthAfter(health, 'ok', 4000)).toEqual({
      failures: 0,
      lastGoodAt: 4000,
      refused: false,
    });
  });

  const state = (over: Partial<Parameters<typeof securityMapStopReason>[0]> = {}) =>
    securityMapStopReason({
      mode: 'live',
      health: { failures: 0, lastGoodAt: 1, refused: false },
      reducedMotion: false,
      paused: false,
      hidden: false,
      ...over,
    });

  it('the not-updating state: one failed read keeps the play, the second stops it', () => {
    expect(SECURITY_MAP_FAILED_POLLS_BEFORE_STOP).toBe(2);
    expect(state({ health: { failures: 1, lastGoodAt: 1, refused: false } })).toBeNull();
    expect(state({ health: { failures: 2, lastGoodAt: 1, refused: false } })).toBe('not_updating');
    expect(state({ health: { failures: 9, lastGoodAt: null, refused: false } })).toBe(
      'not_updating',
    );
  });

  it('a refused read stops it at once and says so, whatever else is true', () => {
    expect(state({ health: { failures: 1, lastGoodAt: 1, refused: true }, paused: true })).toBe(
      'sign_in_again',
    );
  });

  it('reduced motion, a pause, a hidden tab and nothing to play each stop it', () => {
    expect(state()).toBeNull();
    expect(state({ mode: 'replay' })).toBeNull();
    expect(state({ reducedMotion: true })).toBe('reduced_motion');
    expect(state({ paused: true })).toBe('paused');
    expect(state({ hidden: true })).toBe('hidden');
    expect(state({ mode: 'still' })).toBe('nothing_to_play');
    // Not updating wins over the gentler reasons.
    expect(
      state({ health: { failures: 2, lastGoodAt: 1, refused: false }, reducedMotion: true }),
    ).toBe('not_updating');
  });
});

/* ─────────────────────────────── the words ─────────────────────────────── */

describe('the words', () => {
  it('"at least" where a count is a floor, and never for a zero', () => {
    expect(securityMapCountWords(7, true)).toBe('at least 7');
    expect(securityMapCountWords(7, false)).toBe('7');
    expect(securityMapCountWords(0, true)).toBe('0');
    expect(securityMapCountWords(12_345, true)).toBe('at least 12,345');
  });

  it('a floor is what the database names in `floors`, and nothing else', () => {
    const w = whole(busy());
    expect(securityMapIsFloor(w, 'flagged_window')).toBe(true);
    expect(securityMapIsFloor(w, 'totals.phishing.flagged')).toBe(true);
    expect(securityMapIsFloor(w, 'blocked_window')).toBe(false);
    expect(securityMapIsFloor(w, 'totals.bots.blocked')).toBe(false);
    // Not guessed from the kind: flagged password guessing is a floor only when the database says so.
    expect(
      securityMapIsFloor(whole({ ...busy(), floors: [] }), 'totals.password_guessing.flagged'),
    ).toBe(false);
    expect(securityMapIsFloor(null, 'flagged_window')).toBe(false);
  });

  it('the window in words: as long as the window read, to the minute', () => {
    expect(securityMapWindowWords(FROM, TO)).toBe('last 24 hours');
    expect(securityMapWindowWords('2026-11-23T21:00:00Z', TO)).toBe('last hour');
    expect(securityMapWindowWords('2026-11-22T20:00:00Z', TO)).toBe('last 26 hours');
    expect(securityMapWindowWords('2026-11-23T21:50:00Z', TO)).toBe('last 10 minutes');
    expect(securityMapWindowWords('2026-11-23T21:59:00Z', TO)).toBe('last minute');
    expect(securityMapWindowWords('2026-11-23T18:08:00Z', TO)).toBe('last 3 hours 52 minutes');
    expect(securityMapWindowWords('2026-11-23T20:59:00Z', TO)).toBe('last 1 hour 1 minute');
    expect(securityMapWindowWords('2026-11-23T21:59:50Z', TO)).toBe('this window');
    expect(securityMapWindowWords('never', TO)).toBe('this window');
  });

  it('a shortened window: said as the part read, from when, and that the rest is not counted', () => {
    const cut = whole({
      ...busy(),
      window: { from: '2026-11-23T18:08:00+00:00', to: TO, live_from: LIVE_FROM, asked_from: FROM },
      window_shortened: true,
    });
    expect(securityMapShortenedWords(cut, 'UTC')).toBe(
      'Showing the last 3 hours 52 minutes only, from 18:08, your time: there were too many events to count all of the last 24 hours. Nothing before 18:08 is in these numbers.',
    );
    expect(securityMapCounters(cut, true).map((c) => c.label)).toEqual([
      'Blocked since midnight, your time',
      'Blocked, last 3 hours 52 minutes',
      'Flagged, last 3 hours 52 minutes',
    ]);
    expect(securityMapShortenedWords(whole(busy()), 'UTC')).toBeNull();
    expect(securityMapShortenedWords(null)).toBeNull();
  });

  it("the day's count: a partial count says at least and from when; a day that has turned is not counted yet", () => {
    const partial = whole({
      ...busy(),
      window: { from: '2026-11-23T18:08:00+00:00', to: TO, live_from: LIVE_FROM, asked_from: FROM },
      window_shortened: true,
      day_start: '2026-11-23T08:00:00+00:00',
      blocked_since_day_start: 40,
      blocked_since_day_start_partial: true,
      floors: ['blocked_since_day_start'],
    });
    expect(securityMapCounters(partial, true, { timeZone: 'UTC' })[0]).toEqual({
      id: 'blocked_today',
      label: 'Blocked since midnight, your time',
      value: 'at least 40',
      note: 'Counted from 18:08, your time: there were too many events to count the whole day.',
    });
    // Partial alone is enough for "at least", even where the floor's name was left out.
    const partialOnly = { ...partial, whole: { ...partial.whole, floors: [] } };
    expect(securityMapCounters(partialOnly, true, { timeZone: 'UTC' })[0]?.value).toBe(
      'at least 40',
    );
    const day = whole({
      ...busy(),
      day_start: '2026-11-23T08:00:00+00:00',
      blocked_since_day_start: 61,
    });
    expect(
      securityMapCounters(day, true, { dayStartNow: '2026-11-23T08:00:00.000Z' })[0]?.value,
    ).toBe('61');
    expect(
      securityMapCounters(day, true, { dayStartNow: '2026-11-24T08:00:00.000Z' })[0]?.value,
    ).toBe(SECURITY_MAP_NOT_COUNTED_YET);
    // Every other number a floor names says "at least".
    const floors = whole({ ...busy(), floors: ['blocked_window', 'totals.exploit.blocked'] });
    expect(securityMapCounters(floors, true).map((c) => c.value)).toEqual([
      SECURITY_MAP_COULD_NOT_CHECK,
      'at least 193',
      '7',
    ]);
    expect(securityMapLegend(floors)[1]?.blocked).toBe('at least 150 blocked');
    expect(securityMapTableRows(floors)[0]).toMatchObject({
      country: 'DE',
      blocked: 'at least 150',
    });
  });

  it('the counters: three labels, the numbers as read, flagged said as flagged', () => {
    const view = whole({
      ...busy(),
      day_start: '2026-11-23T08:00:00+00:00',
      blocked_since_day_start: 61,
    });
    expect(securityMapCounters(view, true)).toEqual([
      { id: 'blocked_today', label: 'Blocked since midnight, your time', value: '61', note: null },
      { id: 'blocked_window', label: 'Blocked, last 24 hours', value: '193', note: null },
      {
        id: 'flagged_window',
        label: 'Flagged, last 24 hours',
        value: 'at least 7',
        note: 'flagged, not blocked',
      },
    ]);
  });

  it('a part that could not be read says so; a zero is only ever a counted zero', () => {
    expect(securityMapCounters(null, true).map((c) => c.value)).toEqual([
      SECURITY_MAP_COULD_NOT_CHECK,
      SECURITY_MAP_COULD_NOT_CHECK,
      SECURITY_MAP_COULD_NOT_CHECK,
    ]);
    // The first read is made on the server, which does not know the viewer's midnight.
    expect(securityMapCounters(whole(busy()), false)[0]?.value).toBe(SECURITY_MAP_NOT_COUNTED_YET);
    // Asked for and not given: could not check, never zero.
    expect(securityMapCounters(whole(busy()), true)[0]?.value).toBe(SECURITY_MAP_COULD_NOT_CHECK);
    expect(
      securityMapCounters(whole({ day_start: FROM, blocked_since_day_start: 0 }), true).map(
        (c) => c.value,
      ),
    ).toEqual(['0', '0', '0']);
  });

  it('the legend: the shown categories only, each with its numbers and its help', () => {
    const legend = securityMapLegend(whole(busy()));
    expect(legend.map((l) => [l.label, l.blocked, l.flagged])).toEqual([
      ['Password guessing', '7 blocked', 'at least 4 flagged, not blocked'],
      ['Exploit attempts', '150 blocked', '0 flagged, not blocked'],
      ['Automated traffic', '36 blocked', '0 flagged, not blocked'],
    ]);
    expect(legend.every((l) => l.help?.startsWith('Counted today from: '))).toBe(true);
    expect(JSON.stringify(legend)).not.toMatch(/phishing|malware/i);
    expect(securityMapLegend(null).map((l) => [l.blocked, l.flagged])).toEqual([
      [SECURITY_MAP_COULD_NOT_CHECK, SECURITY_MAP_COULD_NOT_CHECK],
      [SECURITY_MAP_COULD_NOT_CHECK, SECURITY_MAP_COULD_NOT_CHECK],
      [SECURITY_MAP_COULD_NOT_CHECK, SECURITY_MAP_COULD_NOT_CHECK],
    ]);
  });

  it('a clock time is HH:MM in the zone asked for', () => {
    expect(securityMapClock('2026-11-23T21:58:00+00:00', 'UTC')).toBe('21:58');
    expect(securityMapClock(Date.parse('2026-11-23T08:03:00Z'), 'America/Los_Angeles')).toBe(
      '00:03',
    );
    expect(securityMapClock('never', 'UTC')).toBe('--:--');
  });

  it('the mode in words: live, the replay with its hour, and nothing to play', () => {
    const w = whole(busy());
    expect(securityMapModeWords(planSecurityMapPlayback(w, null), w, 0, 'UTC')).toBe(
      'Live: the last 10 minutes, without the events from the phone app and direct callers (some of those are added hours late, so they are shown in the replay and the totals instead).',
    );
    const quiet = busy();
    quiet.timeline = quiet.timeline?.filter((c) => c.bucket_seconds === 600);
    const q = whole(quiet);
    const replay = planSecurityMapPlayback(q, null);
    expect(securityMapModeWords(replay, q, 0, 'UTC')).toBe(
      'Replay of the last 24 hours: nothing in the last 10 minutes. Now showing 03:00 to 04:00, your time. Hours with nothing to draw are skipped.',
    );
    expect(securityMapModeWords(replay, q, 1, 'America/Los_Angeles')).toContain(
      'Now showing 13:00 to 14:00, your time.',
    );
    // A step past the end is the last one, never an invented hour.
    expect(securityMapModeWords(replay, q, 99, 'UTC')).toContain('Now showing 21:00 to 22:00');
    const e = whole();
    expect(securityMapModeWords(planSecurityMapPlayback(e, null), e, 0)).toBe(
      'Nothing to play: no event of the last 24 hours has a place on the map.',
    );
    expect(securityMapModeWords(planSecurityMapPlayback(null, null), null, 0)).toBe(
      'Nothing to play.',
    );
  });

  it('why the map is not moving', () => {
    const at = Date.parse('2026-11-23T12:03:20Z');
    const health = { failures: 2, lastGoodAt: at, refused: false };
    expect(securityMapStopWords('not_updating', health, 'UTC')).toBe(
      'Not updating since 12:03, your time. The map is stopped and shows what was read then.',
    );
    expect(securityMapStopWords('not_updating', { ...health, lastGoodAt: null })).toBe(
      'Not updating. Nothing could be read, so the map is stopped.',
    );
    expect(securityMapStopWords('sign_in_again', health)).toMatch(/^Sign in again\. /);
    expect(securityMapStopWords('paused', health)).toBe('Paused. The numbers still update.');
    expect(securityMapStopWords('reduced_motion', health)).toMatch(/^Not moving: /);
    expect(securityMapStopWords('hidden', health)).toBeNull();
    expect(securityMapStopWords('nothing_to_play', health)).toBeNull();
    expect(securityMapStopWords(null, health)).toBeNull();
  });

  it('a window the database would not read: could not check, with the reason and no value', () => {
    expect(securityMapRefusedWindowWords('to_in_the_future')).toBe(
      'Could not check: the window asked for ends in the future. Nothing was read.',
    );
    expect(securityMapRefusedWindowWords('longer_than_26_hours')).toBe(
      'Could not check: the window asked for is longer than 26 hours. Nothing was read.',
    );
    expect(securityMapRefusedWindowWords('too_many_events_in_one_minute')).toBe(
      'Could not check: one minute alone holds more events than can be read. Nothing was read.',
    );
    for (const refused of SECURITY_MAP_REFUSALS) {
      expect(securityMapRefusedWindowWords(refused)).toMatch(
        /^Could not check: .+\. Nothing was read\.$/,
      );
    }
  });

  it('the notes: each line only when it has something to say', () => {
    expect(securityMapNotes(whole())).toEqual([]);
    const notes = securityMapNotes(whole(busy()), 'UTC');
    expect(notes).toEqual([
      'Not drawn: at least 3 flagged sign-in alerts. They are on the Security page.',
      'Not on the map: 36 events have no country. They are in the totals.',
      '36 events in a flood: place not listed.',
      '2 events were allowed. Allowed events are counted here and never drawn.',
      'Events from the phone app and direct callers are left out of the live play: some of them are added up to about seven hours late, with a country only. They are in the totals and the replay. In the last 24 hours: 5 such events so far.',
      "An hour's refused sign-ins could not all be counted: 400 requests were counted. That number is in no total here.",
      'A sign-in is recorded once in each organization of the account, and the record cannot tell one account from another. So it is counted as the fewest sign-ins its rows can stand for, and a number that holds one says "at least".',
    ]);
    // With no floor, no "at least" and no line about floors.
    const exact = securityMapNotes(whole({ ...busy(), floors: [] }), 'UTC');
    expect(exact[0]).toBe('Not drawn: 3 flagged sign-in alerts. They are on the Security page.');
    expect(exact.some((line) => line.includes('fewest sign-ins'))).toBe(false);
  });

  it('every count in the notes that holds a floor says "at least"', () => {
    const notes = securityMapNotes(
      whole({
        ...busy(),
        floors: [
          'totals.phishing.flagged',
          'no_place.bots.blocked',
          'totals.bots.allowed',
          'totals.password_guessing.blocked',
        ],
      }),
      'UTC',
    );
    expect(notes).toContain(
      'Not on the map: at least 36 events have no country. They are in the totals.',
    );
    expect(notes).toContain(
      'at least 2 events were allowed. Allowed events are counted here and never drawn.',
    );
    expect(
      notes.some((line) => line.endsWith('In the last 24 hours: at least 5 such events so far.')),
    ).toBe(true);
  });

  it('the notes for one of each, for the cuts, and for a young record', () => {
    const one = securityMapNotes(
      whole({
        totals: counts({ phishing: { flagged: 1 }, bots: { blocked: 1, allowed: 1 } }),
        no_place: counts({ bots: { blocked: 1 } }),
        blocked_window: 1,
        flagged_window: 1,
        allowed_window: 1,
        flood_rows: [
          {
            reason: 'over_minute_cap',
            source: 'web',
            category: 'bots',
            outcome: 'blocked',
            events: 1,
            rows: 1,
          },
        ],
        late_sources: [{ source: 'phone', category: 'bots', outcome: 'blocked', events: 1 }],
        timeline_truncated: true,
        by_country_truncated: true,
        oldest_event_at: '2026-11-23T02:00:00+00:00',
      }),
      'UTC',
    );
    expect(one).toContain('Not drawn: 1 flagged sign-in alert. It is on the Security page.');
    expect(one).toContain('Not on the map: 1 event has no country. It is in the totals.');
    expect(one).toContain('1 event in a flood: place not listed.');
    expect(one).toContain('1 event was allowed. Allowed events are counted here and never drawn.');
    expect(one).toContain(
      'More happened than the map can draw: the largest counts are drawn and the rest are left out of the drawing.',
    );
    expect(one).toContain(
      'The table is cut short: the 2,000 largest groups were read and smaller ones were left out.',
    );
    expect(one).toContain(
      'The record starts on November 23, 2026, so the last 24 hours are not all on record.',
    );
    expect(one.some((line) => line.includes('1 such event so far.'))).toBe(true);
  });

  it('a hidden kind that is not a flagged sign-in alert is counted as "other"', () => {
    const notes = securityMapNotes(
      whole({ totals: counts({ phishing: { flagged: 2, blocked: 1 }, malware: { blocked: 4 } }) }),
    );
    expect(notes[0]).toBe(
      'Not drawn: 2 flagged sign-in alerts and 5 other events of a kind this map does not show. They are on the Security page.',
    );
  });

  it('the empty states', () => {
    expect(securityMapEmptyWords(null)).toBeNull();
    expect(securityMapEmptyWords(whole({ oldest_event_at: null }))).toBe(
      'No security events have been recorded yet.',
    );
    expect(securityMapEmptyWords(whole())).toBe(
      'Nothing was blocked or flagged in the last 24 hours.',
    );
    expect(
      securityMapEmptyWords(
        whole({
          totals: counts({ bots: { blocked: 3 } }),
          no_place: counts({ bots: { blocked: 3 } }),
          blocked_window: 3,
        }),
      ),
    ).toBe(
      'Nothing to draw: no event of the last 24 hours has a country and a kind this map shows.',
    );
    // Only a hidden category happened: still not "nothing was flagged".
    expect(
      securityMapEmptyWords(
        whole({ totals: counts({ phishing: { flagged: 1 } }), flagged_window: 1 }),
      ),
    ).toBe(
      'Nothing to draw: no event of the last 24 hours has a country and a kind this map shows.',
    );
    expect(securityMapEmptyWords(whole(busy()))).toBeNull();
  });

  it('when the totals were read', () => {
    expect(securityMapAsOfWords(whole(), 'UTC')).toBe(
      'Totals and table as of 22:00, your time. They are counted again every 5 minutes; the live play and the feed every 30 seconds.',
    );
    expect(securityMapAsOfWords(null)).toBe(
      'The totals could not be read. They are read again every 5 minutes.',
    );
  });

  it('a feed entry: flagged is never called blocked, a folded count says "at least", a flood has no place', () => {
    expect(securityMapOutcomeWords('flagged')).toBe('Flagged, not blocked');
    expect(securityMapOutcomeWords('blocked')).toBe('Blocked');
    expect(securityMapOutcomeWords('allowed')).toBe('Allowed');
    const view = whole(busy());
    const [first, held] = view.feed.map(securityMapFeedWords);
    expect(first).toMatchObject({
      time: '21:58 UTC',
      categoryLabel: 'Password guessing',
      outcomeLabel: 'Blocked',
      reason: 'wrong_password',
      country: 'US',
      city: 'Example Falls',
      flood: false,
      count: '11',
      organizationWords: 'No organization',
    });
    expect(held).toMatchObject({
      outcomeLabel: 'Flagged, not blocked',
      count: 'at least 4',
      organizationName: 'Example Academy',
      organizationWords: null,
    });
    const folded = securityMapFeedWords([
      '2026-11-23T21:59:00+00:00',
      0,
      1,
      'sign_in_alerts_held',
      'phone',
      'PT',
      'Example Harbour',
      1,
      true,
      null,
      null,
      3,
    ]);
    expect(folded.organizationWords).toBe('3 organizations');
    expect(folded.count).toBe('at least 1');
    const flood = securityMapFeedWords([
      '2026-11-23T21:59:00+00:00',
      2,
      0,
      'over_minute_cap',
      'web',
      'US',
      'Example Falls',
      30,
      false,
      null,
      null,
      0,
    ]);
    expect(flood).toMatchObject({ flood: true, country: null, city: null, count: '30' });
    // Two entries of one minute that differ only by organization have different keys.
    const a = securityMapFeedWords([
      '2026-11-23T21:59:00+00:00',
      0,
      0,
      'wrong_password',
      'web',
      'US',
      null,
      1,
      false,
      'a0478000-0000-4000-8000-000000000001',
      'One',
      1,
    ]);
    const b = securityMapFeedWords([
      '2026-11-23T21:59:00+00:00',
      0,
      0,
      'wrong_password',
      'web',
      'US',
      null,
      1,
      false,
      'a0478000-0000-4000-8000-000000000002',
      'Two',
      1,
    ]);
    // A folded count is said as the database marks it, not guessed from the reason.
    const exact = securityMapFeedWords([
      '2026-11-23T21:59:00+00:00',
      0,
      1,
      'sign_in_alerts_held',
      'web',
      'GB',
      null,
      4,
      false,
      null,
      null,
      1,
    ]);
    expect(exact.count).toBe('4');
    expect(a.key).not.toBe(b.key);
  });

  it('the table: one row per country and category, blocked beside flagged, the largest first', () => {
    const rows = securityMapTableRows(
      whole({
        by_country: [
          { country: 'DE', category: 'exploit', outcome: 'blocked', events: 150 },
          { country: 'GB', category: 'password_guessing', outcome: 'flagged', events: 4 },
          { country: 'GB', category: 'password_guessing', outcome: 'blocked', events: 1200 },
          { country: 'GB', category: 'bots', outcome: 'flagged', events: 2 },
        ],
        floors: ['totals.password_guessing.flagged'],
      }),
    );
    expect(rows.map((r) => [r.country, r.categoryLabel, r.blocked, r.flagged])).toEqual([
      ['GB', 'Password guessing', '1,200', 'at least 4'],
      ['DE', 'Exploit attempts', '150', '0'],
      ['GB', 'Automated traffic', '0', '2'],
    ]);
  });
});

/* ─────────────────────── how much one poll can weigh ─────────────────────── */

describe("the size of what leaves the server, at the database's caps", () => {
  const codes = Array.from(
    { length: 249 },
    (_, i) =>
      `${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`,
  );
  const shown = ['password_guessing', 'exploit', 'bots'] as const;
  const kinds = shown.flatMap((category) =>
    (['blocked', 'flagged'] as const).map((outcome) => ({ category, outcome })),
  );
  const worst = (name: string): SecurityMapAnswer => {
    const timeline: SecurityMapTimelineCell[] = [];
    // 1,000 one-minute cells, then 3,000 ten-minute cells over 25 clock hours.
    for (let i = 0; timeline.length < 1000; i += 1) {
      const kind = kinds[i % kinds.length]!;
      timeline.push(
        cell(
          new Date(Date.parse(LIVE_FROM) + (i % 10) * 60_000).toISOString(),
          60,
          codes[i % 249]!,
          kind.category,
          kind.outcome,
          9_999_999,
        ),
      );
    }
    for (let i = 0; timeline.length < 4000; i += 1) {
      const kind = kinds[i % kinds.length]!;
      timeline.push(
        cell(
          new Date(Date.parse(FROM) + (i % 144) * 600_000).toISOString(),
          600,
          codes[(i * 7) % 249]!,
          kind.category,
          kind.outcome,
          9_999_999,
        ),
      );
    }
    const by_country = Array.from({ length: 2000 }, (_, i) => ({
      country: codes[i % 249]!,
      category: SECURITY_EVENT_CATEGORIES[Math.floor(i / 249) % 5]!,
      outcome: (['blocked', 'flagged', 'allowed'] as const)[Math.floor(i / 1245) % 3]!,
      events: 9_999_999 - i,
    }));
    return answer({
      timeline,
      timeline_truncated: true,
      by_country,
      by_country_truncated: true,
      totals: counts(
        Object.fromEntries(
          SECURITY_EVENT_CATEGORIES.map((c) => [
            c,
            { blocked: 9_999_999_999, flagged: 9_999_999_999, allowed: 9_999_999_999 },
          ]),
        ),
      ),
      no_place: counts(
        Object.fromEntries(
          SECURITY_EVENT_CATEGORIES.map((c) => [
            c,
            { blocked: 9_999_999_999, flagged: 9_999_999_999, allowed: 9_999_999_999 },
          ]),
        ),
      ),
      blocked_window: 49_999_999_995,
      flagged_window: 49_999_999_995,
      allowed_window: 49_999_999_995,
      day_start: FROM,
      blocked_since_day_start: 49_999_999_995,
      feed: Array.from({ length: 60 }, (_, i) =>
        entry({
          minute: '2026-11-23T21:59:00.123456+00:00',
          reason: 'x'.repeat(48),
          city: 'y'.repeat(80),
          organization_id: `a0478000-0000-4000-8000-${String(i).padStart(12, '0')}`,
          organization_name: name.repeat(200),
          organizations: 1,
          events: 9_999_999,
        }),
      ),
      flagged_feed: Array.from({ length: 20 }, (_, i) =>
        entry({
          minute: '2026-11-23T21:59:00.123456+00:00',
          outcome: 'flagged',
          reason: 'x'.repeat(48),
          city: 'y'.repeat(80),
          at_least: true,
          organization_id: `a0478000-0000-4000-8000-${String(i).padStart(12, '1')}`,
          organization_name: name.repeat(200),
          organizations: 1,
          events: 9_999_999,
        }),
      ),
      // Every name a floor can have today: 15 totals, 15 no-place counts, the three window counts, the day.
      floors: [
        ...SECURITY_EVENT_CATEGORIES.flatMap((c) =>
          (['blocked', 'flagged', 'allowed'] as const).flatMap((o) => [
            `totals.${c}.${o}` as const,
            `no_place.${c}.${o}` as const,
          ]),
        ),
        'blocked_window',
        'flagged_window',
        'allowed_window',
        'blocked_since_day_start',
      ],
    });
  };
  const bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

  it('a read of the whole window stays under 90 KB and a read of the last ten minutes under 40 KB (plain names)', () => {
    const a = worst('n');
    expect(readSecurityMapAnswer(a).ok).toBe(true);
    const w = securityMapViewOf(a, 'whole');
    const r = securityMapViewOf(a, 'recent');
    expect(readSecurityMapView(JSON.parse(JSON.stringify(w)))).not.toBeNull();
    expect(bytes(a)).toBeGreaterThan(400_000);
    expect(bytes(w)).toBeLessThan(90_000);
    expect(bytes(r)).toBeLessThan(40_000);
  });

  it('with every organization name 200 characters of four bytes each: under 140 KB and 90 KB', () => {
    const a = worst('\u{1F512}');
    expect(bytes(securityMapViewOf(a, 'whole'))).toBeLessThan(140_000);
    expect(bytes(securityMapViewOf(a, 'recent'))).toBeLessThan(90_000);
  });
});
