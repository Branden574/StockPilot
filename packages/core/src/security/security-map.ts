/**
 * The platform console's attack map (migration platform_security_map): the
 * rules and the words, with no database, no network and no drawing in them.
 *
 * Four parts:
 *   1. THE ANSWER. The database's document as plain types, with a reader
 *      that accepts exactly the documented shape and nothing else (the web's
 *      zod schema mirrors it). An answer this build does not know is "could
 *      not check", never a zero.
 *   2. THE VIEW. What leaves the server for the browser: only what the page
 *      draws and says. A category with no shown detector is taken out here,
 *      so it can never be drawn; its events are counted in one line of words.
 *   3. THE PLAYBACK PLAN. Live when the last ten minutes hold events (the
 *      database already leaves the late sources out of them), otherwise a
 *      replay of the window, otherwise still. At most 40 arcs at once, one
 *      per country, category and outcome. Every renderer (the globe, the flat
 *      map) draws this plan and decides nothing.
 *   4. THE WORDS. Every sentence the page shows is made here.
 *
 * No number is ever invented, rounded up or padded. A flagged event is never
 * called blocked. A count that the database's fold makes a floor says
 * "at least". Never an address, an email or an account: the answer holds
 * none, and nothing here names one.
 */

import {
  SECURITY_EVENT_CATEGORIES,
  SECURITY_EVENT_REASON_RE,
  SECURITY_EVENT_SOURCES,
  isSecurityEventCategory,
  isSecurityEventSource,
  securityEventCategoryLabel,
  type SecurityEventCategory,
  type SecurityEventOutcome,
  type SecurityEventSource,
} from './security-events';

/* ═════════════════════════════ 1. THE LISTS ═════════════════════════════ */

/*
 * Copied from the migration's contract ("The lists"). The database holds the
 * same four lists (its test 0478/13 pins them to the letter) and counts with
 * them; this copy is for the words. security-map.test.ts applies them to the
 * rows of the shared fixture and must get the database's numbers.
 */

/** Recorded once in each organization of one account: platform-wide, one event. */
export const SECURITY_MAP_FOLDED_REASONS = [
  'sign_in_new_country',
  'sign_in_not_me',
  'sign_in_alerts_held',
] as const;
/** A count of other rows of the record: in no total; listed apart. */
export const SECURITY_MAP_TALLY_REASONS = ['too_many_forms_to_count'] as const;
/** Rows that stand for events past a cap: counted, never placed. */
export const SECURITY_MAP_FLOOD_REASONS = ['over_minute_cap', 'over_buffer_cap'] as const;
/** Sources whose rows can be added up to hours after their minute: never in the 60-second cells. */
export const SECURITY_MAP_LATE_SOURCES = ['phone', 'api'] as const;

/**
 * The category and outcome each folded reason is always written with
 * (server/security/sign-in-alert-events.ts in the web app). A number that can
 * hold one of them is a floor: two accounts that sign in from the same place
 * in the same minute count once.
 */
export const SECURITY_MAP_FOLDED_REASON_KINDS: Readonly<
  Record<
    (typeof SECURITY_MAP_FOLDED_REASONS)[number],
    readonly [SecurityEventCategory, SecurityEventOutcome]
  >
> = {
  sign_in_new_country: ['phishing', 'flagged'],
  sign_in_not_me: ['phishing', 'flagged'],
  sign_in_alerts_held: ['password_guessing', 'flagged'],
};

const includes = (list: readonly string[], value: unknown): boolean =>
  typeof value === 'string' && list.includes(value);

export const isSecurityMapFoldedReason = (reason: unknown): boolean =>
  includes(SECURITY_MAP_FOLDED_REASONS, reason);
export const isSecurityMapTallyReason = (reason: unknown): boolean =>
  includes(SECURITY_MAP_TALLY_REASONS, reason);
export const isSecurityMapFloodReason = (reason: unknown): boolean =>
  includes(SECURITY_MAP_FLOOD_REASONS, reason);
export const isSecurityMapLateSource = (source: unknown): boolean =>
  includes(SECURITY_MAP_LATE_SOURCES, source);

/** The database's caps on each list of the answer. */
export const SECURITY_MAP_MAX_TIMELINE = 4000;
export const SECURITY_MAP_MAX_BY_COUNTRY = 2000;
export const SECURITY_MAP_MAX_FEED = 60;
export const SECURITY_MAP_MAX_LATE_SOURCES = 30;
export const SECURITY_MAP_MAX_COUNTED_ROWS = 200;

/** Why the database would not read a window. It never repeats the argument. */
export const SECURITY_MAP_REFUSALS = [
  'not_a_time',
  'to_in_the_future',
  'from_not_before_to',
  'longer_than_48_hours',
] as const;
export type SecurityMapRefusal = (typeof SECURITY_MAP_REFUSALS)[number];

/* ═════════════════════════ 2. THE DATABASE'S ANSWER ═════════════════════════ */

export interface SecurityMapOutcomeCounts {
  blocked: number;
  flagged: number;
  allowed: number;
}
export type SecurityMapCategoryCounts = Record<SecurityEventCategory, SecurityMapOutcomeCounts>;

export interface SecurityMapTimelineCell {
  bucket_start: string;
  /** 600: the replay. 60: the live play (the window's last ten minutes, no late source). */
  bucket_seconds: 600 | 60;
  country: string;
  category: SecurityEventCategory;
  outcome: SecurityEventOutcome;
  events: number;
}

export interface SecurityMapCountryRow {
  country: string;
  category: SecurityEventCategory;
  outcome: SecurityEventOutcome;
  events: number;
}

export interface SecurityMapFeedEntry {
  minute: string;
  category: SecurityEventCategory;
  outcome: SecurityEventOutcome;
  reason: string;
  source: SecurityEventSource;
  country: string | null;
  city: string | null;
  events: number;
  organization_id: string | null;
  organization_name: string | null;
  organizations: number;
}

export interface SecurityMapLateRow {
  source: SecurityEventSource;
  category: SecurityEventCategory;
  outcome: SecurityEventOutcome;
  events: number;
}

export interface SecurityMapCountedRow {
  reason: string;
  source: SecurityEventSource;
  category: SecurityEventCategory;
  outcome: SecurityEventOutcome;
  events: number;
  rows: number;
}

/** The nineteen keys, always all of them. */
export interface SecurityMapAnswer {
  window: { from: string; to: string; live_from: string };
  refused: null;
  generated_at: string;
  oldest_event_at: string | null;
  timeline: SecurityMapTimelineCell[];
  timeline_truncated: boolean;
  by_country: SecurityMapCountryRow[];
  by_country_truncated: boolean;
  totals: SecurityMapCategoryCounts;
  no_place: SecurityMapCategoryCounts;
  blocked_window: number;
  flagged_window: number;
  allowed_window: number;
  day_start: string | null;
  blocked_since_day_start: number | null;
  feed: SecurityMapFeedEntry[];
  late_sources: SecurityMapLateRow[];
  tallies: SecurityMapCountedRow[];
  flood_rows: SecurityMapCountedRow[];
}

export type SecurityMapAnswerRead =
  | { ok: true; refused: null; answer: SecurityMapAnswer }
  | { ok: true; refused: SecurityMapRefusal; answer: null }
  /** `where` names the key that differs. Never a value from the answer. */
  | { ok: false; where: string };

const OUTCOMES: readonly SecurityEventOutcome[] = ['blocked', 'flagged', 'allowed'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COUNTRY_RE = /^[A-Z]{2}$/;
/** The longest city the record keeps, and the longest name the database hands over. */
export const SECURITY_MAP_CITY_MAX = 80;
export const SECURITY_MAP_ORGANIZATION_NAME_MAX = 200;

type Bag = Record<string, unknown>;
const isBag = (v: unknown): v is Bag => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isTime = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= 64 && Number.isFinite(Date.parse(v));
const isCountry = (v: unknown): v is string => typeof v === 'string' && COUNTRY_RE.test(v);
const isOutcome = (v: unknown): v is SecurityEventOutcome => includes(OUTCOMES, v);
const isReason = (v: unknown): v is string =>
  typeof v === 'string' && SECURITY_EVENT_REASON_RE.test(v);
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
/** Counted in characters, as the database cuts (a name may hold characters of two code units). */
const textWithin = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length <= max * 2 && [...v].length <= max;

/** The first way `bag` is not exactly `keys`, or null. */
function keysDiffer(bag: Bag, keys: readonly string[]): string | null {
  for (const key of keys) if (!(key in bag)) return `${key}: missing`;
  for (const key of Object.keys(bag))
    if (!keys.includes(key)) return 'a key this build does not know';
  return null;
}

function readCategoryCounts(v: unknown, at: string): string | null {
  if (!isBag(v)) return `${at}: not an object`;
  const differ = keysDiffer(v, SECURITY_EVENT_CATEGORIES);
  if (differ) return `${at}.${differ}`;
  for (const category of SECURITY_EVENT_CATEGORIES) {
    const counts = v[category];
    if (!isBag(counts)) return `${at}.${category}: not an object`;
    const inner = keysDiffer(counts, OUTCOMES);
    if (inner) return `${at}.${category}.${inner}`;
    for (const outcome of OUTCOMES) {
      if (!isCount(counts[outcome])) return `${at}.${category}.${outcome}: not a count`;
    }
  }
  return null;
}

/** A list of objects with exactly `keys`, each checked by `check` (null when good). */
function readList(
  v: unknown,
  at: string,
  max: number,
  keys: readonly string[],
  check: (row: Bag) => string | null,
): string | null {
  if (!Array.isArray(v)) return `${at}: not a list`;
  if (v.length > max) return `${at}: longer than its cap`;
  for (let i = 0; i < v.length; i += 1) {
    const row: unknown = v[i];
    if (!isBag(row)) return `${at}.${i}: not an object`;
    const differ = keysDiffer(row, keys) ?? check(row);
    if (differ) return `${at}.${i}.${differ}`;
  }
  return null;
}

const kindDiffers = (row: Bag): string | null => {
  if (!isSecurityEventCategory(row.category)) return 'category: not a category';
  if (!isOutcome(row.outcome)) return 'outcome: not an outcome';
  if (!isCount(row.events)) return 'events: not a count';
  return null;
};

const countedRowDiffers = (row: Bag): string | null => {
  if (!isReason(row.reason)) return 'reason: not a reason code';
  if (!isSecurityEventSource(row.source)) return 'source: not a source';
  if (!isCount(row.rows)) return 'rows: not a count';
  return kindDiffers(row);
};

const ANSWER_KEYS = [
  'window',
  'refused',
  'generated_at',
  'oldest_event_at',
  'timeline',
  'timeline_truncated',
  'by_country',
  'by_country_truncated',
  'totals',
  'no_place',
  'blocked_window',
  'flagged_window',
  'allowed_window',
  'day_start',
  'blocked_since_day_start',
  'feed',
  'late_sources',
  'tallies',
  'flood_rows',
] as const;

/**
 * The database's answer, read against the contract: exactly its keys, every
 * list within its cap, every value of its kind. Anything else is not ok, and
 * the caller shows "could not check". Never throws.
 */
export function readSecurityMapAnswer(raw: unknown): SecurityMapAnswerRead {
  const no = (where: string): SecurityMapAnswerRead => ({ ok: false, where });
  if (!isBag(raw)) return no('(root): not an object');

  // A window the database would not read: exactly three keys.
  if (raw.window === null) {
    const differ = keysDiffer(raw, ['window', 'refused', 'generated_at']);
    if (differ) return no(differ);
    if (!includes(SECURITY_MAP_REFUSALS, raw.refused)) return no('refused: not a known refusal');
    if (!isTime(raw.generated_at)) return no('generated_at: not a time');
    return { ok: true, refused: raw.refused as SecurityMapRefusal, answer: null };
  }

  const differ = keysDiffer(raw, ANSWER_KEYS);
  if (differ) return no(differ);
  if (raw.refused !== null) return no('refused: not null beside a window');

  const window = raw.window;
  if (!isBag(window)) return no('window: not an object');
  const windowDiffers = keysDiffer(window, ['from', 'to', 'live_from']);
  if (windowDiffers) return no(`window.${windowDiffers}`);
  for (const key of ['from', 'to', 'live_from'] as const) {
    if (!isTime(window[key])) return no(`window.${key}: not a time`);
  }

  if (!isTime(raw.generated_at)) return no('generated_at: not a time');
  if (raw.oldest_event_at !== null && !isTime(raw.oldest_event_at)) {
    return no('oldest_event_at: not a time');
  }
  if (raw.day_start !== null && !isTime(raw.day_start)) return no('day_start: not a time');
  for (const key of ['timeline_truncated', 'by_country_truncated'] as const) {
    if (typeof raw[key] !== 'boolean') return no(`${key}: not a boolean`);
  }
  for (const key of ['blocked_window', 'flagged_window', 'allowed_window'] as const) {
    if (!isCount(raw[key])) return no(`${key}: not a count`);
  }
  if (raw.blocked_since_day_start !== null && !isCount(raw.blocked_since_day_start)) {
    return no('blocked_since_day_start: not a count');
  }

  const lists =
    readCategoryCounts(raw.totals, 'totals') ??
    readCategoryCounts(raw.no_place, 'no_place') ??
    readList(
      raw.timeline,
      'timeline',
      SECURITY_MAP_MAX_TIMELINE,
      ['bucket_start', 'bucket_seconds', 'country', 'category', 'outcome', 'events'],
      (row) => {
        if (!isTime(row.bucket_start)) return 'bucket_start: not a time';
        if (row.bucket_seconds !== 600 && row.bucket_seconds !== 60) {
          return 'bucket_seconds: not 600 or 60';
        }
        if (!isCountry(row.country)) return 'country: not two capital letters';
        return kindDiffers(row);
      },
    ) ??
    readList(
      raw.by_country,
      'by_country',
      SECURITY_MAP_MAX_BY_COUNTRY,
      ['country', 'category', 'outcome', 'events'],
      (row) => (isCountry(row.country) ? kindDiffers(row) : 'country: not two capital letters'),
    ) ??
    readList(
      raw.feed,
      'feed',
      SECURITY_MAP_MAX_FEED,
      [
        'minute',
        'category',
        'outcome',
        'reason',
        'source',
        'country',
        'city',
        'events',
        'organization_id',
        'organization_name',
        'organizations',
      ],
      (row) => {
        if (!isTime(row.minute)) return 'minute: not a time';
        if (!isReason(row.reason)) return 'reason: not a reason code';
        if (!isSecurityEventSource(row.source)) return 'source: not a source';
        if (row.country !== null && !isCountry(row.country)) {
          return 'country: not two capital letters';
        }
        if (row.city !== null && !textWithin(row.city, SECURITY_MAP_CITY_MAX)) {
          return 'city: not a short text';
        }
        if (row.organization_id !== null && !isUuid(row.organization_id)) {
          return 'organization_id: not an id';
        }
        if (
          row.organization_name !== null &&
          !textWithin(row.organization_name, SECURITY_MAP_ORGANIZATION_NAME_MAX)
        ) {
          return 'organization_name: not a short text';
        }
        if (!isCount(row.organizations)) return 'organizations: not a count';
        return kindDiffers(row);
      },
    ) ??
    readList(
      raw.late_sources,
      'late_sources',
      SECURITY_MAP_MAX_LATE_SOURCES,
      ['source', 'category', 'outcome', 'events'],
      (row) => (isSecurityEventSource(row.source) ? kindDiffers(row) : 'source: not a source'),
    ) ??
    readList(
      raw.tallies,
      'tallies',
      SECURITY_MAP_MAX_COUNTED_ROWS,
      ['reason', 'source', 'category', 'outcome', 'events', 'rows'],
      countedRowDiffers,
    ) ??
    readList(
      raw.flood_rows,
      'flood_rows',
      SECURITY_MAP_MAX_COUNTED_ROWS,
      ['reason', 'source', 'category', 'outcome', 'events', 'rows'],
      countedRowDiffers,
    );
  if (lists) return no(lists);

  return { ok: true, refused: null, answer: raw as unknown as SecurityMapAnswer };
}

/* ═══════════════════ 3. WHICH CATEGORIES THE MAP SHOWS ═══════════════════ */

export interface SecurityCategoryDetectors {
  /** Whether the map shows the category. Never shown while `firesNow` is empty. */
  shown: boolean;
  /** What records an event of this category today, in words. The legend's help is made from these. */
  firesNow: readonly string[];
}

/**
 * Which categories the map shows, and what feeds each one NOW. The owner's
 * rule: a category shows only when a real detector feeds it.
 *
 * PHISHING IS HIDDEN, and showing it is this one line: `shown: true`. What
 * feeds it today is two stand-ins (a member's own sign-in from a new country,
 * and a member saying a sign-in was not them), both flagged and not blocked;
 * the owner has not yet said whether those count as "a real detector". Nothing
 * records Malware, so it cannot be shown whatever `shown` says.
 *
 * A passkey refusal is not listed: every passkey switch is off, so none can
 * be recorded. When the switches go on, its words are added here.
 */
export const SECURITY_CATEGORIES_WITH_DETECTOR: Readonly<
  Record<SecurityEventCategory, SecurityCategoryDetectors>
> = {
  password_guessing: {
    shown: true,
    firesNow: [
      'wrong passwords and wrong codes at sign-in',
      'sign-ins and code checks paused after too many attempts',
      'unknown API keys',
      "refused sign-ins in the sign-in service's own log, which is read once an hour",
    ],
  },
  exploit: {
    shown: true,
    firesNow: ['requests for files and pages this site never serves'],
  },
  bots: {
    shown: true,
    firesNow: [
      'too many requests to a public form, a shared link or the public API',
      'sign-in attempts paused by the sign-in service, from its log, which is read once an hour',
    ],
  },
  phishing: {
    shown: false,
    firesNow: ['a sign-in from a new country', 'a member saying a sign-in was not them'],
  },
  malware: { shown: false, firesNow: [] },
};

/** The categories the map draws, lists and counts in its legend, in the record's own order. */
export function securityMapShownCategories(
  detectors: Readonly<
    Record<SecurityEventCategory, SecurityCategoryDetectors>
  > = SECURITY_CATEGORIES_WITH_DETECTOR,
): SecurityEventCategory[] {
  return SECURITY_EVENT_CATEGORIES.filter(
    (category) => detectors[category].shown && detectors[category].firesNow.length > 0,
  );
}

const listWords = (parts: readonly string[]): string => {
  if (parts.length <= 1) return parts[0] ?? '';
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join('; ')}; and ${parts[parts.length - 1]}`;
};

/**
 * The legend's help for one category, made from what can record it now. Null
 * for a category nothing records.
 */
export function securityMapLegendHelp(
  category: SecurityEventCategory,
  detectors: Readonly<
    Record<SecurityEventCategory, SecurityCategoryDetectors>
  > = SECURITY_CATEGORIES_WITH_DETECTOR,
): string | null {
  const fires = detectors[category].firesNow;
  if (fires.length === 0) return null;
  return `Counted today from: ${listWords(fires)}.`;
}

/* ═══════════════════════════ 4. THE VIEW ═══════════════════════════ */

/** The two outcomes the map draws. An allowed event is counted in words only. */
export type SecurityMapDrawnOutcome = 'blocked' | 'flagged';
const DRAWN: readonly SecurityMapDrawnOutcome[] = ['blocked', 'flagged'];

/**
 * One count by country, category and outcome, as it travels: the category is
 * its place in SECURITY_EVENT_CATEGORIES, the outcome 0 for blocked and 1 for
 * flagged.
 */
export type SecurityMapArcRow = readonly [
  country: string,
  category: number,
  outcome: 0 | 1,
  events: number,
];

/** One feed entry as it travels. The outcome: 0 blocked, 1 flagged, 2 allowed. */
export type SecurityMapFeedRow = readonly [
  minute: string,
  category: number,
  outcome: 0 | 1 | 2,
  reason: string,
  source: string,
  country: string | null,
  city: string | null,
  events: number,
  organizationId: string | null,
  organizationName: string | null,
  organizations: number,
];

/** One hour of the replay that holds events: where it starts, and its arcs. */
export type SecurityMapStepRow = readonly [fromMs: number, arcs: readonly SecurityMapArcRow[]];

/** One line of the legend: a shown category with its two numbers for the window. */
export type SecurityMapLegendRow = readonly [category: number, blocked: number, flagged: number];

/** The parts only a read of the whole window gives. */
export interface SecurityMapWholeView {
  oldestEventAt: string | null;
  /** The replay: the hours of the window that hold events, in time order. */
  steps: readonly SecurityMapStepRow[];
  /** The whole window as one picture, the largest first, at most 40. */
  still: readonly SecurityMapArcRow[];
  /** Every by-country count of the shown categories, blocked and flagged, the largest first. */
  table: readonly SecurityMapArcRow[];
  /** The database left groups out of the by-country list. */
  tableCut: boolean;
  /** Something was left out of the drawing: cells by the database, or arcs past 40 in an hour. */
  drawingCut: boolean;
  /** The window's sums over every category, as the database gives them. */
  blocked: number;
  flagged: number;
  /** Allowed events of the shown categories: counted in words, never drawn. */
  allowed: number;
  dayStart: string | null;
  blockedSinceDayStart: number | null;
  legend: readonly SecurityMapLegendRow[];
  /** Blocked and flagged events of the shown categories that have no country. */
  noPlace: number;
  /** Events past a cap, of the shown categories: counted, no place. They are in `noPlace` too. */
  flood: number;
  /** Events of the window from the late sources. */
  late: number;
  /** The tally rows: requests that were counted, and how many rows say so. In no total. */
  tallyEvents: number;
  tallyRows: number;
  /** Events of the categories the map does not show. */
  notDrawnSignInAlerts: number;
  notDrawnOther: number;
}

/** What leaves the server. `whole` is null for a read of the last ten minutes. */
export interface SecurityMapView {
  v: 1;
  scope: 'whole' | 'recent';
  from: string;
  to: string;
  liveFrom: string;
  generatedAt: string;
  /** The last ten minutes, one per country, category and outcome, at most 40. */
  live: readonly SecurityMapArcRow[];
  /** More than 40 were live, or the database cut the timeline. */
  liveCut: boolean;
  feed: readonly SecurityMapFeedRow[];
  whole: SecurityMapWholeView | null;
}

/** At most this many arcs are drawn, and so move, at once. */
export const SECURITY_MAP_MAX_ARCS = 40;
/** One replay step is one hour of the clock (UTC, as the database's buckets are). */
export const SECURITY_MAP_STEP_MS = 60 * 60 * 1000;
/** A 48-hour window touches at most this many clock hours. */
export const SECURITY_MAP_MAX_STEPS = 49;

interface KindCount {
  country: string;
  category: SecurityEventCategory;
  outcome: SecurityEventOutcome;
  events: number;
}

const categoryIndex = (category: SecurityEventCategory): number =>
  SECURITY_EVENT_CATEGORIES.indexOf(category);

/** Largest first; then country, category and outcome, so the same counts always give the same order. */
function byEventsThenName(a: SecurityMapArcRow, b: SecurityMapArcRow): number {
  return b[3] - a[3] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0) || a[1] - b[1] || a[2] - b[2];
}

/**
 * One row per country, category and outcome of the shown categories, the
 * counts of equal rows added, the largest first. Hidden categories, the
 * allowed outcome and empty counts never pass.
 */
function arcRows(
  counts: Iterable<KindCount>,
  shown: readonly SecurityEventCategory[],
): SecurityMapArcRow[] {
  const sums = new Map<string, [string, number, 0 | 1, number]>();
  for (const c of counts) {
    if (!shown.includes(c.category)) continue;
    const outcome = DRAWN.indexOf(c.outcome as SecurityMapDrawnOutcome);
    if (outcome === -1 || c.events <= 0) continue;
    const category = categoryIndex(c.category);
    const key = `${c.country}:${category}:${outcome}`;
    const held = sums.get(key);
    if (held) held[3] += c.events;
    else sums.set(key, [c.country, category, outcome as 0 | 1, c.events]);
  }
  return [...sums.values()].sort(byEventsThenName);
}

const sumCounts = (
  counts: SecurityMapCategoryCounts,
  categories: readonly SecurityEventCategory[],
  outcomes: readonly SecurityEventOutcome[],
): number =>
  categories.reduce(
    (sum, category) => sum + outcomes.reduce((s, outcome) => s + counts[category][outcome], 0),
    0,
  );

/**
 * The database's answer cut down to what the page draws and says.
 *
 * A category that is not shown is taken out of every list here (the arcs, the
 * table, the legend, the feed), so nothing downstream can draw it; its events
 * are two numbers for one line of words. `recent` (a read of the last ten
 * minutes) keeps the live arcs and the feed only: its totals are ten minutes'
 * worth and must never stand in for the window's.
 */
export function securityMapViewOf(
  answer: SecurityMapAnswer,
  scope: 'whole' | 'recent',
  shown: readonly SecurityEventCategory[] = securityMapShownCategories(),
): SecurityMapView {
  const liveRows = arcRows(
    answer.timeline.filter((cell) => cell.bucket_seconds === 60),
    shown,
  );
  const feed: SecurityMapFeedRow[] = answer.feed
    .filter((entry) => shown.includes(entry.category))
    .map((e) => [
      e.minute,
      categoryIndex(e.category),
      OUTCOMES.indexOf(e.outcome) as 0 | 1 | 2,
      e.reason,
      e.source,
      e.country,
      e.city,
      e.events,
      e.organization_id,
      e.organization_name,
      e.organizations,
    ]);
  const view: SecurityMapView = {
    v: 1,
    scope,
    from: answer.window.from,
    to: answer.window.to,
    liveFrom: answer.window.live_from,
    generatedAt: answer.generated_at,
    live: liveRows.slice(0, SECURITY_MAP_MAX_ARCS),
    liveCut: liveRows.length > SECURITY_MAP_MAX_ARCS || answer.timeline_truncated,
    feed,
    whole: null,
  };
  if (scope === 'recent') return view;

  // The replay: the 600-second cells by the clock hour they start in.
  const hours = new Map<number, SecurityMapTimelineCell[]>();
  for (const cell of answer.timeline) {
    if (cell.bucket_seconds !== 600) continue;
    const hour = Math.floor(Date.parse(cell.bucket_start) / SECURITY_MAP_STEP_MS);
    const held = hours.get(hour);
    if (held) held.push(cell);
    else hours.set(hour, [cell]);
  }
  let arcsCut = false;
  const steps: SecurityMapStepRow[] = [];
  for (const hour of [...hours.keys()].sort((a, b) => a - b)) {
    const rows = arcRows(hours.get(hour) ?? [], shown);
    if (rows.length === 0) continue;
    if (rows.length > SECURITY_MAP_MAX_ARCS) arcsCut = true;
    steps.push([hour * SECURITY_MAP_STEP_MS, rows.slice(0, SECURITY_MAP_MAX_ARCS)]);
  }

  const table = arcRows(answer.by_country, shown);
  const hidden = SECURITY_EVENT_CATEGORIES.filter((category) => !shown.includes(category));
  const signInAlerts = hidden.includes('phishing') ? answer.totals.phishing.flagged : 0;
  const drawnFlood = answer.flood_rows.filter(
    (row) => shown.includes(row.category) && row.outcome !== 'allowed',
  );
  const sumEvents = (rows: readonly { events: number }[]): number =>
    rows.reduce((sum, row) => sum + row.events, 0);

  view.whole = {
    oldestEventAt: answer.oldest_event_at,
    steps,
    still: table.slice(0, SECURITY_MAP_MAX_ARCS),
    table,
    tableCut: answer.by_country_truncated,
    drawingCut: answer.timeline_truncated || arcsCut,
    blocked: answer.blocked_window,
    flagged: answer.flagged_window,
    allowed: sumCounts(answer.totals, shown, ['allowed']),
    dayStart: answer.day_start,
    blockedSinceDayStart: answer.blocked_since_day_start,
    legend: shown.map((category) => [
      categoryIndex(category),
      answer.totals[category].blocked,
      answer.totals[category].flagged,
    ]),
    noPlace: sumCounts(answer.no_place, shown, DRAWN),
    flood: sumEvents(drawnFlood),
    late: sumEvents(answer.late_sources),
    tallyEvents: sumEvents(answer.tallies),
    tallyRows: answer.tallies.reduce((sum, row) => sum + row.rows, 0),
    notDrawnSignInAlerts: signInAlerts,
    notDrawnOther: sumCounts(answer.totals, hidden, OUTCOMES) - signInAlerts,
  };
  return view;
}

/* ─────────────── the view, read again where it arrives ─────────────── */

const isArcRow = (v: unknown, shownIndexes: readonly number[]): v is SecurityMapArcRow =>
  Array.isArray(v) &&
  v.length === 4 &&
  isCountry(v[0]) &&
  shownIndexes.includes(v[1] as number) &&
  (v[2] === 0 || v[2] === 1) &&
  isCount(v[3]) &&
  v[3] > 0;

const isArcList = (v: unknown, max: number, shownIndexes: readonly number[]): boolean =>
  Array.isArray(v) && v.length <= max && v.every((row) => isArcRow(row, shownIndexes));

function isFeedRow(v: unknown, shownIndexes: readonly number[]): v is SecurityMapFeedRow {
  if (!Array.isArray(v) || v.length !== 11) return false;
  const [minute, category, outcome, reason, source, country, city, events, id, name, orgs] =
    v as unknown[];
  return (
    isTime(minute) &&
    shownIndexes.includes(category as number) &&
    (outcome === 0 || outcome === 1 || outcome === 2) &&
    isReason(reason) &&
    includes(SECURITY_EVENT_SOURCES, source) &&
    (country === null || isCountry(country)) &&
    (city === null || textWithin(city, SECURITY_MAP_CITY_MAX)) &&
    isCount(events) &&
    (id === null || isUuid(id)) &&
    (name === null || textWithin(name, SECURITY_MAP_ORGANIZATION_NAME_MAX)) &&
    isCount(orgs)
  );
}

const WHOLE_KEYS = [
  'oldestEventAt',
  'steps',
  'still',
  'table',
  'tableCut',
  'drawingCut',
  'blocked',
  'flagged',
  'allowed',
  'dayStart',
  'blockedSinceDayStart',
  'legend',
  'noPlace',
  'flood',
  'late',
  'tallyEvents',
  'tallyRows',
  'notDrawnSignInAlerts',
  'notDrawnOther',
] as const;

function isWholeView(v: unknown, shownIndexes: readonly number[]): v is SecurityMapWholeView {
  if (!isBag(v) || keysDiffer(v, WHOLE_KEYS)) return false;
  const counts = [
    'blocked',
    'flagged',
    'allowed',
    'noPlace',
    'flood',
    'late',
    'tallyEvents',
    'tallyRows',
    'notDrawnSignInAlerts',
    'notDrawnOther',
  ] as const;
  if (!counts.every((key) => isCount(v[key]))) return false;
  if (typeof v.tableCut !== 'boolean' || typeof v.drawingCut !== 'boolean') return false;
  if (v.oldestEventAt !== null && !isTime(v.oldestEventAt)) return false;
  if (v.dayStart !== null && !isTime(v.dayStart)) return false;
  if (v.blockedSinceDayStart !== null && !isCount(v.blockedSinceDayStart)) return false;
  if (!isArcList(v.still, SECURITY_MAP_MAX_ARCS, shownIndexes)) return false;
  if (!isArcList(v.table, SECURITY_MAP_MAX_BY_COUNTRY, shownIndexes)) return false;
  if (!Array.isArray(v.steps) || v.steps.length > SECURITY_MAP_MAX_STEPS) return false;
  for (const step of v.steps as unknown[]) {
    if (!Array.isArray(step) || step.length !== 2) return false;
    if (!isCount(step[0]) || !isArcList(step[1], SECURITY_MAP_MAX_ARCS, shownIndexes)) return false;
    if ((step[1] as unknown[]).length === 0) return false;
  }
  if (!Array.isArray(v.legend) || v.legend.length !== shownIndexes.length) return false;
  return (v.legend as unknown[]).every(
    (row, i) =>
      Array.isArray(row) &&
      row.length === 3 &&
      row[0] === shownIndexes[i] &&
      isCount(row[1]) &&
      isCount(row[2]),
  );
}

/**
 * The view as the browser reads what the server handed it: the same strict
 * check, so a build that is older or newer than the server shows "could not
 * check" instead of drawing a shape it does not know. A row of a category
 * this build does not show is such a shape. Null when it is not a view.
 */
export function readSecurityMapView(
  raw: unknown,
  shown: readonly SecurityEventCategory[] = securityMapShownCategories(),
): SecurityMapView | null {
  if (!isBag(raw)) return null;
  const keys = [
    'v',
    'scope',
    'from',
    'to',
    'liveFrom',
    'generatedAt',
    'live',
    'liveCut',
    'feed',
    'whole',
  ];
  if (keysDiffer(raw, keys)) return null;
  if (raw.v !== 1 || (raw.scope !== 'whole' && raw.scope !== 'recent')) return null;
  if (!isTime(raw.from) || !isTime(raw.to) || !isTime(raw.liveFrom) || !isTime(raw.generatedAt)) {
    return null;
  }
  if (typeof raw.liveCut !== 'boolean') return null;
  const shownIndexes = shown.map(categoryIndex);
  if (!isArcList(raw.live, SECURITY_MAP_MAX_ARCS, shownIndexes)) return null;
  if (!Array.isArray(raw.feed) || raw.feed.length > SECURITY_MAP_MAX_FEED) return null;
  if (!(raw.feed as unknown[]).every((row) => isFeedRow(row, shownIndexes))) return null;
  if (raw.scope === 'recent' ? raw.whole !== null : !isWholeView(raw.whole, shownIndexes)) {
    return null;
  }
  return raw as unknown as SecurityMapView;
}

/* ─────────────────────── what one poll answers ─────────────────────── */

/**
 * The one answer for every reader the console's gate turns away: no session,
 * not a platform administrator, no second step on the session. The same
 * value whichever it was.
 */
export const SECURITY_MAP_POLL_REFUSED = Object.freeze({ ok: false, reason: 'refused' } as const);
/** The read failed, timed out or answered a shape this build does not know. */
export const SECURITY_MAP_POLL_FAILED = Object.freeze({
  ok: false,
  reason: 'could_not_check',
} as const);

export type SecurityMapPollResult =
  | { ok: true; view: SecurityMapView; refusedWindow: null }
  | { ok: true; view: null; refusedWindow: SecurityMapRefusal }
  | typeof SECURITY_MAP_POLL_REFUSED
  | typeof SECURITY_MAP_POLL_FAILED;

/** A poll's answer as the browser reads it. Anything it does not know is a failed read. */
export function readSecurityMapPollResult(raw: unknown): SecurityMapPollResult {
  if (!isBag(raw)) return SECURITY_MAP_POLL_FAILED;
  if (raw.ok === false && raw.reason === 'refused') return SECURITY_MAP_POLL_REFUSED;
  if (raw.ok !== true) return SECURITY_MAP_POLL_FAILED;
  if (raw.view === null && includes(SECURITY_MAP_REFUSALS, raw.refusedWindow)) {
    return { ok: true, view: null, refusedWindow: raw.refusedWindow as SecurityMapRefusal };
  }
  const view = raw.refusedWindow === null ? readSecurityMapView(raw.view) : null;
  return view ? { ok: true, view, refusedWindow: null } : SECURITY_MAP_POLL_FAILED;
}

/* ═════════════════ 5. TWO READS, ONE PICTURE; THE PLAYBACK ═════════════════ */

/** The view of the whole window, when the page has one. */
export type SecurityMapWholeRead = SecurityMapView & { whole: SecurityMapWholeView };

/** One arc of the plan: a country, a category, an outcome, a count. */
export interface SecurityMapArc {
  /** Stable for a country, category and outcome, so a renderer can keep an arc across reads. */
  key: string;
  country: string;
  category: SecurityEventCategory;
  outcome: SecurityMapDrawnOutcome;
  events: number;
  /** Stroke width in the map's own units: by the count, on a log scale. */
  width: number;
}

export const SECURITY_MAP_ARC_MIN_WIDTH = 1;
export const SECURITY_MAP_ARC_MAX_WIDTH = 4;

/**
 * An arc's width from its count, on a log scale: 1 event is the thinnest,
 * ten times as many adds three quarters of a unit, 10,000 or more is the
 * widest. A count is never drawn wider to look busier.
 */
export function securityMapArcWidth(events: number): number {
  if (!Number.isFinite(events) || events <= 1) return SECURITY_MAP_ARC_MIN_WIDTH;
  const width = SECURITY_MAP_ARC_MIN_WIDTH + 0.75 * Math.log10(events);
  return Math.min(SECURITY_MAP_ARC_MAX_WIDTH, Math.round(width * 100) / 100);
}

export function securityMapArcOf(row: SecurityMapArcRow): SecurityMapArc {
  const category = SECURITY_EVENT_CATEGORIES[row[1]] as SecurityEventCategory;
  const outcome: SecurityMapDrawnOutcome = row[2] === 1 ? 'flagged' : 'blocked';
  return {
    key: `${row[0]}:${category}:${outcome}`,
    country: row[0],
    category,
    outcome,
    events: row[3],
    width: securityMapArcWidth(row[3]),
  };
}

export type SecurityMapPlayMode = 'live' | 'replay' | 'still';

export interface SecurityMapReplayStep {
  /** The clock hour this step stands for, as instants. */
  fromMs: number;
  toMs: number;
  arcs: SecurityMapArc[];
}

export interface SecurityMapPlan {
  mode: SecurityMapPlayMode;
  /** live: the arcs of the last ten minutes. Empty otherwise. */
  live: SecurityMapArc[];
  /** replay: the hours that hold events, in time order. Empty otherwise. */
  steps: SecurityMapReplayStep[];
  /**
   * What the mode shows as ONE picture that does not move: for reduced
   * motion, a pause, and a page that has stopped updating. live: the live
   * arcs. replay: the whole window's largest. still: nothing.
   */
  picture: SecurityMapArc[];
  /** Something was left out of the drawing; the page says so. */
  cut: boolean;
}

/** How long one hour of the replay stays on the map. */
export const SECURITY_MAP_REPLAY_STEP_MS = 2500;

/**
 * THE PLAYBACK PLAN. Live when the newest read's last ten minutes hold
 * events (the database leaves the late sources out of those cells, so a row
 * added hours late is never played as if it had just happened); otherwise a
 * replay of the whole window, hour by hour, skipping hours with nothing;
 * otherwise still. Arcs come from the timeline and from nothing else.
 *
 * `recent` is the newest read of the last ten minutes, or null; it counts
 * only when it is newer than the read of the whole window.
 */
export function planSecurityMapPlayback(
  whole: SecurityMapWholeRead | null,
  recent: SecurityMapView | null,
): SecurityMapPlan {
  const newest =
    recent && (!whole || Date.parse(recent.generatedAt) >= Date.parse(whole.generatedAt))
      ? recent
      : whole;
  const live = (newest?.live ?? []).slice(0, SECURITY_MAP_MAX_ARCS).map(securityMapArcOf);
  if (live.length > 0) {
    return { mode: 'live', live, steps: [], picture: live, cut: newest?.liveCut ?? false };
  }
  const steps: SecurityMapReplayStep[] = (whole?.whole.steps ?? []).map(([fromMs, rows]) => ({
    fromMs,
    toMs: fromMs + SECURITY_MAP_STEP_MS,
    arcs: rows.slice(0, SECURITY_MAP_MAX_ARCS).map(securityMapArcOf),
  }));
  if (whole && steps.length > 0) {
    return {
      mode: 'replay',
      live: [],
      steps,
      picture: whole.whole.still.slice(0, SECURITY_MAP_MAX_ARCS).map(securityMapArcOf),
      cut: whole.whole.drawingCut,
    };
  }
  return { mode: 'still', live: [], steps: [], picture: [], cut: false };
}

/**
 * The feed of two reads as one list. Inside the ten minutes the newer read
 * covers, only its entries count (an entry there can change between reads: a
 * sign-in recorded in one organization and then in two more stops naming the
 * first). Before that, the whole window's entries. Newest first, at most 60.
 */
export function securityMapFeedOf(
  whole: SecurityMapWholeRead | null,
  recent: SecurityMapView | null,
): SecurityMapFeedRow[] {
  if (!whole) return recent ? [...recent.feed] : [];
  if (!recent || Date.parse(recent.generatedAt) < Date.parse(whole.generatedAt)) {
    return [...whole.feed];
  }
  const from = Date.parse(recent.from);
  const older = whole.feed.filter((row) => Date.parse(row[0]) < from);
  return [...recent.feed, ...older].slice(0, SECURITY_MAP_MAX_FEED);
}

/* ───────────────────── polling, and when the play stops ───────────────────── */

/** The last ten minutes are read this often; the whole window this often (review S8). */
export const SECURITY_MAP_RECENT_POLL_MS = 30_000;
export const SECURITY_MAP_WHOLE_POLL_MS = 5 * 60_000;
/** After this many failed reads in a row the page says it is not updating, and the play stops. */
export const SECURITY_MAP_FAILED_POLLS_BEFORE_STOP = 2;
const BACK_OFF_MAX_MS = 120_000;

export interface SecurityMapHealth {
  /** Failed reads in a row. */
  failures: number;
  /** When a read last succeeded (the page's clock), or null when none has. */
  lastGoodAt: number | null;
  /** The gate turned the last read away. */
  refused: boolean;
}

export const SECURITY_MAP_HEALTH_AT_START: SecurityMapHealth = Object.freeze({
  failures: 0,
  lastGoodAt: null,
  refused: false,
});

export type SecurityMapPollOutcome = 'ok' | 'failed' | 'refused';

/** The health after one read. A refusal is also a failure: the page backs off and stops. */
export function securityMapHealthAfter(
  health: SecurityMapHealth,
  outcome: SecurityMapPollOutcome,
  nowMs: number,
): SecurityMapHealth {
  if (outcome === 'ok') return { failures: 0, lastGoodAt: nowMs, refused: false };
  return {
    failures: health.failures + 1,
    lastGoodAt: health.lastGoodAt,
    refused: outcome === 'refused',
  };
}

/** How long to wait before the next read of the last ten minutes: 30 s, then 60 s, then 120 s. */
export function securityMapNextPollDelay(failures: number): number {
  const doubled = SECURITY_MAP_RECENT_POLL_MS * 2 ** Math.max(0, Math.min(failures, 8));
  return Math.min(BACK_OFF_MAX_MS, doubled);
}

export type SecurityMapStopReason =
  'sign_in_again' | 'not_updating' | 'reduced_motion' | 'paused' | 'hidden' | 'nothing_to_play';

/**
 * Whether anything on the map may move, and why not. The order matters: a
 * page that was turned away or has stopped updating never moves, whatever
 * else is true, so old arcs cannot keep moving as if they were live.
 */
export function securityMapStopReason(input: {
  mode: SecurityMapPlayMode;
  health: SecurityMapHealth;
  reducedMotion: boolean;
  paused: boolean;
  hidden: boolean;
}): SecurityMapStopReason | null {
  if (input.health.refused) return 'sign_in_again';
  if (input.health.failures >= SECURITY_MAP_FAILED_POLLS_BEFORE_STOP) return 'not_updating';
  if (input.reducedMotion) return 'reduced_motion';
  if (input.paused) return 'paused';
  if (input.hidden) return 'hidden';
  if (input.mode === 'still') return 'nothing_to_play';
  return null;
}

/* ═════════════════════════════ 6. THE WORDS ═════════════════════════════ */

export const SECURITY_MAP_COULD_NOT_CHECK = 'Could not check';
export const SECURITY_MAP_FLAGGED_NOT_BLOCKED = 'flagged, not blocked';

const num = (n: number): string => n.toLocaleString('en-US');
const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/**
 * Whether a number for this category and outcome can hold a folded sign-in.
 * Such a number is a floor (the database's fold counts two accounts that
 * signed in from the same place in the same minute once).
 */
export function securityMapCountIsFloor(
  category: SecurityEventCategory,
  outcome: SecurityEventOutcome,
): boolean {
  return Object.values(SECURITY_MAP_FOLDED_REASON_KINDS).some(
    ([c, o]) => c === category && o === outcome,
  );
}

/** A count in words: "7", or "at least 7" for a floor that counted something. Zero is zero. */
export function securityMapCountWords(count: number, floor: boolean): string {
  return floor && count > 0 ? `at least ${num(count)}` : num(count);
}

/** Whether the window's flagged sum is a floor: it adds up every category's flagged events. */
const FLAGGED_SUM_IS_FLOOR = SECURITY_EVENT_CATEGORIES.some((category) =>
  securityMapCountIsFloor(category, 'flagged'),
);

/** "last 24 hours" for a whole number of hours, "this window" otherwise. */
export function securityMapWindowWords(from: string, to: string): string {
  const hours = (Date.parse(to) - Date.parse(from)) / SECURITY_MAP_STEP_MS;
  const whole = Math.round(hours);
  if (!Number.isFinite(hours) || whole < 1 || Math.abs(hours - whole) > 1 / 60)
    return 'this window';
  return whole === 1 ? 'last hour' : `last ${whole} hours`;
}

export interface SecurityMapCounter {
  id: 'blocked_today' | 'blocked_window' | 'flagged_window';
  label: string;
  /** The number in words, "Could not check", or "Not counted yet". */
  value: string;
  /** Words under the number, or null. */
  note: string | null;
}

export const SECURITY_MAP_NOT_COUNTED_YET = 'Not counted yet';

/**
 * The three counters. With no read of the whole window every one says "Could
 * not check". The day's count needs the viewer's own midnight, which only the
 * browser knows: before the first read that carried it, "Not counted yet";
 * when it was asked for and the database gave none, "Could not check". Never
 * a zero in a number's place.
 */
export function securityMapCounters(
  whole: SecurityMapWholeRead | null,
  dayStartAsked: boolean,
): SecurityMapCounter[] {
  const window = whole ? securityMapWindowWords(whole.from, whole.to) : 'last 24 hours';
  const w = whole?.whole ?? null;
  const today =
    w === null
      ? SECURITY_MAP_COULD_NOT_CHECK
      : w.blockedSinceDayStart !== null
        ? num(w.blockedSinceDayStart)
        : dayStartAsked
          ? SECURITY_MAP_COULD_NOT_CHECK
          : SECURITY_MAP_NOT_COUNTED_YET;
  return [
    {
      id: 'blocked_today',
      label: 'Blocked since midnight, your time',
      value: today,
      note: null,
    },
    {
      id: 'blocked_window',
      label: `Blocked, ${window}`,
      value: w === null ? SECURITY_MAP_COULD_NOT_CHECK : num(w.blocked),
      note: null,
    },
    {
      id: 'flagged_window',
      label: `Flagged, ${window}`,
      value:
        w === null
          ? SECURITY_MAP_COULD_NOT_CHECK
          : securityMapCountWords(w.flagged, FLAGGED_SUM_IS_FLOOR),
      note: SECURITY_MAP_FLAGGED_NOT_BLOCKED,
    },
  ];
}

export interface SecurityMapLegendItem {
  category: SecurityEventCategory;
  label: string;
  /** "12 blocked", or "Could not check". */
  blocked: string;
  /** "at least 3 flagged, not blocked". */
  flagged: string;
  /** What records this category now, in a sentence. */
  help: string | null;
}

/**
 * The legend: the shown categories and only those, each with its two numbers
 * for the window and its help line. Without a read of the whole window the
 * categories are still named, and their numbers say "Could not check".
 */
export function securityMapLegend(
  whole: SecurityMapWholeRead | null,
  shown: readonly SecurityEventCategory[] = securityMapShownCategories(),
): SecurityMapLegendItem[] {
  return shown.map((category) => {
    const row = whole?.whole.legend.find(([index]) => index === categoryIndex(category)) ?? null;
    return {
      category,
      label: securityEventCategoryLabel(category),
      blocked: row ? `${num(row[1])} blocked` : SECURITY_MAP_COULD_NOT_CHECK,
      flagged: row
        ? `${securityMapCountWords(row[2], securityMapCountIsFloor(category, 'flagged'))} ${SECURITY_MAP_FLAGGED_NOT_BLOCKED}`
        : SECURITY_MAP_COULD_NOT_CHECK,
      help: securityMapLegendHelp(category),
    };
  });
}

/** The legend's two marks, in words: an arc's outcome is never told by colour alone. */
export const SECURITY_MAP_MARK_WORDS = {
  blocked: 'Blocked: a solid line and a filled mark',
  flagged: 'Flagged, not blocked: a dashed line and a hollow mark',
} as const;

/** "HH:MM" on a 24-hour clock, in `timeZone` (the runtime's own zone when none is given). */
export function securityMapClock(at: number | string, timeZone?: string): string {
  const ms = typeof at === 'number' ? at : Date.parse(at);
  if (!Number.isFinite(ms)) return '--:--';
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).format(new Date(ms));
}

/** "November 21, 2026" in `timeZone`. */
function dateWords(at: string, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone,
  }).format(new Date(Date.parse(at)));
}

/** The words under the map for the mode it is in. */
export function securityMapModeWords(
  plan: SecurityMapPlan,
  whole: SecurityMapWholeRead | null,
  stepIndex: number,
  timeZone?: string,
): string {
  if (plan.mode === 'live') {
    return 'Live: the last 10 minutes. Events that are added late (from the phone app and direct callers) are never in the live play.';
  }
  const window = whole ? securityMapWindowWords(whole.from, whole.to) : 'last 24 hours';
  if (plan.mode === 'replay') {
    const step = plan.steps[Math.max(0, Math.min(stepIndex, plan.steps.length - 1))];
    const hour = step
      ? ` Now showing ${securityMapClock(step.fromMs, timeZone)} to ${securityMapClock(step.toMs, timeZone)}, your time.`
      : '';
    return `Replay of the ${window}: nothing in the last 10 minutes.${hour} Hours with nothing to draw are skipped.`;
  }
  return whole
    ? `Nothing to play: no event of the ${window} has a place on the map.`
    : 'Nothing to play.';
}

/** Why the map is not moving, in a sentence. Null while it moves. */
export function securityMapStopWords(
  reason: SecurityMapStopReason | null,
  health: SecurityMapHealth,
  timeZone?: string,
): string | null {
  switch (reason) {
    case 'sign_in_again':
      return 'Sign in again. This page stopped reading: your session ended, or it no longer has its second step.';
    case 'not_updating':
      return health.lastGoodAt === null
        ? 'Not updating. Nothing could be read, so the map is stopped.'
        : `Not updating since ${securityMapClock(health.lastGoodAt, timeZone)}, your time. The map is stopped and shows what was read then.`;
    case 'reduced_motion':
      return 'Not moving: your device asks for reduced motion. The picture and the numbers are the same.';
    case 'paused':
      return 'Paused. The numbers still update.';
    default:
      return null;
  }
}

/** A window the database would not read, in a sentence. Nothing was read. */
export function securityMapRefusedWindowWords(refused: SecurityMapRefusal): string {
  const why: Record<SecurityMapRefusal, string> = {
    not_a_time: 'the window asked for is not a time',
    to_in_the_future: 'the window asked for ends in the future',
    from_not_before_to: 'the window asked for ends before it starts',
    longer_than_48_hours: 'the window asked for is longer than 48 hours',
  };
  return `${SECURITY_MAP_COULD_NOT_CHECK}: ${why[refused]}. Nothing was read.`;
}

/**
 * The lines under the map that say what the numbers leave out, cut short or
 * cannot place. Each is there only when it has something to say.
 */
export function securityMapNotes(whole: SecurityMapWholeRead, timeZone?: string): string[] {
  const w = whole.whole;
  const window = securityMapWindowWords(whole.from, whole.to);
  const notes: string[] = [];

  if (w.notDrawnSignInAlerts > 0 || w.notDrawnOther > 0) {
    const parts: string[] = [];
    if (w.notDrawnSignInAlerts > 0) {
      const count = securityMapCountWords(
        w.notDrawnSignInAlerts,
        securityMapCountIsFloor('phishing', 'flagged'),
      );
      parts.push(`${count} flagged sign-in ${plural(w.notDrawnSignInAlerts, 'alert', 'alerts')}`);
    }
    if (w.notDrawnOther > 0) {
      parts.push(
        `${num(w.notDrawnOther)} other ${plural(w.notDrawnOther, 'event', 'events')} of a kind this map does not show`,
      );
    }
    const they = w.notDrawnSignInAlerts + w.notDrawnOther === 1 ? 'It is' : 'They are';
    notes.push(`Not drawn: ${parts.join(' and ')}. ${they} on the Security page.`);
  }
  if (w.noPlace > 0) {
    notes.push(
      `Not on the map: ${num(w.noPlace)} ${plural(w.noPlace, 'event has', 'events have')} no country. ${plural(w.noPlace, 'It is', 'They are')} in the totals.`,
    );
  }
  if (w.flood > 0) {
    notes.push(
      `${num(w.flood)} ${plural(w.flood, 'event', 'events')} in a flood: place not listed.`,
    );
  }
  if (w.allowed > 0) {
    notes.push(
      `${num(w.allowed)} ${plural(w.allowed, 'event was', 'events were')} allowed. Allowed events are counted here and never drawn.`,
    );
  }
  if (w.late > 0) {
    notes.push(
      `Rows from the phone app and direct callers are added once an hour, up to about seven hours late, with a country only. They are in the totals and the replay, never in the live play. In the ${window}: ${num(w.late)} such ${plural(w.late, 'event', 'events')} so far.`,
    );
  }
  if (w.tallyRows > 0) {
    notes.push(
      `An hour's refused sign-ins could not all be counted: ${num(w.tallyEvents)} ${plural(w.tallyEvents, 'request was', 'requests were')} counted. That number is in no total here.`,
    );
  }
  if (w.drawingCut) {
    notes.push(
      'More happened than the map can draw: the largest counts are drawn and the rest are left out of the drawing.',
    );
  }
  if (w.tableCut) {
    notes.push(
      `The table is cut short: the ${num(SECURITY_MAP_MAX_BY_COUNTRY)} largest groups were read and smaller ones were left out.`,
    );
  }
  if (w.oldestEventAt !== null && Date.parse(w.oldestEventAt) > Date.parse(whole.from)) {
    notes.push(
      `The record starts on ${dateWords(w.oldestEventAt, timeZone)}, so the ${window} ${window === 'this window' ? 'is' : 'are'} not all on record.`,
    );
  }
  if (w.flagged > 0 && FLAGGED_SUM_IS_FLOOR) {
    notes.push(
      'A flagged sign-in is counted once however many organizations the account is in. Two accounts that sign in from the same place in the same minute also count once, so those numbers say "at least".',
    );
  }
  return notes;
}

/** The words where the map and the table have nothing to show. Null when they have. */
export function securityMapEmptyWords(whole: SecurityMapWholeRead | null): string | null {
  if (!whole) return null;
  const w = whole.whole;
  const window = securityMapWindowWords(whole.from, whole.to);
  if (w.oldestEventAt === null) return 'No security events have been recorded yet.';
  if (w.blocked + w.flagged + w.allowed + w.notDrawnSignInAlerts + w.notDrawnOther === 0) {
    return `Nothing was blocked or flagged in the ${window}.`;
  }
  if (w.table.length === 0) {
    return `Nothing to draw: no event of the ${window} has a country and a kind this map shows.`;
  }
  return null;
}

/** When the numbers were read, and how often they are read again. */
export function securityMapAsOfWords(
  whole: SecurityMapWholeRead | null,
  timeZone?: string,
): string {
  if (!whole) return 'The totals could not be read. They are read again every 5 minutes.';
  return `Totals and table as of ${securityMapClock(whole.generatedAt, timeZone)}, your time. They are counted again every 5 minutes; the live play and the feed every 30 seconds.`;
}

export interface SecurityMapFeedWords {
  /** Stable for an entry across reads. */
  key: string;
  /** "21:58 UTC". */
  time: string;
  category: SecurityEventCategory;
  categoryLabel: string;
  outcome: SecurityEventOutcome;
  /** "Blocked", or "Flagged, not blocked", or "Allowed". */
  outcomeLabel: string;
  reason: string;
  source: string;
  country: string | null;
  city: string | null;
  /** True for a row that stands for events past a cap: it has no place to show. */
  flood: boolean;
  /** "at least 2" or "11". */
  count: string;
  organizationId: string | null;
  organizationName: string | null;
  /** "No organization", "3 organizations", or null when one organization is named. */
  organizationWords: string | null;
}

const OUTCOME_WORDS: Record<SecurityEventOutcome, string> = {
  blocked: 'Blocked',
  flagged: 'Flagged, not blocked',
  allowed: 'Allowed',
};

/** The outcome in words. A flagged event is never called blocked. */
export function securityMapOutcomeWords(outcome: SecurityEventOutcome): string {
  return OUTCOME_WORDS[outcome];
}

/** One feed entry's facts, ready to show. The reason's own words come from securityEventReasonLabel. */
export function securityMapFeedWords(row: SecurityMapFeedRow): SecurityMapFeedWords {
  const [minute, c, o, reason, source, country, city, events, id, name, organizations] = row;
  const category = SECURITY_EVENT_CATEGORIES[c] as SecurityEventCategory;
  const outcome = OUTCOMES[o] as SecurityEventOutcome;
  const flood = isSecurityMapFloodReason(reason);
  return {
    key: [minute, c, o, reason, source, country ?? '', city ?? '', id ?? ''].join('|'),
    time: `${securityMapClock(minute, 'UTC')} UTC`,
    category,
    categoryLabel: securityEventCategoryLabel(category),
    outcome,
    outcomeLabel: securityMapOutcomeWords(outcome),
    reason,
    source,
    country: flood ? null : country,
    city: flood ? null : city,
    flood,
    count: securityMapCountWords(events, isSecurityMapFoldedReason(reason)),
    organizationId: id,
    organizationName: name,
    organizationWords:
      id !== null
        ? null
        : organizations > 1
          ? `${num(organizations)} organizations`
          : 'No organization',
  };
}

export interface SecurityMapTableRow {
  key: string;
  country: string;
  category: SecurityEventCategory;
  categoryLabel: string;
  /** "12", or "0". */
  blocked: string;
  /** "at least 3", or "0". */
  flagged: string;
  /** Blocked plus flagged, for the order of the rows. */
  total: number;
}

/**
 * The by-country table: one row per country and category, with its blocked
 * and its flagged count side by side, the largest first. This is the map's
 * numbers in full, and what a screen reader is given in the drawing's place.
 */
export function securityMapTableRows(whole: SecurityMapWholeRead): SecurityMapTableRow[] {
  const rows = new Map<string, { country: string; c: number; blocked: number; flagged: number }>();
  for (const [country, c, outcome, events] of whole.whole.table) {
    const key = `${country}:${c}`;
    const row = rows.get(key) ?? { country, c, blocked: 0, flagged: 0 };
    if (outcome === 1) row.flagged += events;
    else row.blocked += events;
    rows.set(key, row);
  }
  return [...rows.entries()]
    .map(([key, row]) => {
      const category = SECURITY_EVENT_CATEGORIES[row.c] as SecurityEventCategory;
      return {
        key,
        country: row.country,
        category,
        categoryLabel: securityEventCategoryLabel(category),
        blocked: num(row.blocked),
        flagged: securityMapCountWords(row.flagged, securityMapCountIsFloor(category, 'flagged')),
        total: row.blocked + row.flagged,
      };
    })
    .sort((a, b) => b.total - a.total || (a.key < b.key ? -1 : 1));
}

/** The words of the controls and of the globe's fallbacks. */
export const SECURITY_MAP_WORDS = {
  title: 'Attack map',
  stockpilot: 'StockPilot',
  pause: 'Pause',
  play: 'Play',
  globe: 'Globe',
  flat: 'Flat map',
  viewLabel: 'Map view',
  loading: 'Loading the map...',
  feedTitle: 'Newest entries',
  feedTimes: 'Times in UTC.',
  feedEmpty: 'No entries to list.',
  tableTitle: 'By country',
  tableNote:
    'The same numbers as the map, in full. A country is where a request came from, which can be a relay.',
  placeUnknown: 'No place',
  placeFlood: 'Place not listed (a flood)',
  openOrganization: 'Open organization',
  globeUnavailable: 'This browser cannot draw the globe, so the flat map is shown.',
  globeLost: 'The globe stopped drawing, so the flat map is shown.',
  globeReducedMotion: 'The flat map is shown: your device asks for reduced motion.',
} as const;
