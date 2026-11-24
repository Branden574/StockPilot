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
 * Copied from the migration's contract, VERSION 2 ("The lists"). The
 * database holds the same four lists and the rule of 5 (its tests 0478/13
 * and 0478/16 pin them to the letter) and counts with them; this copy is for
 * the words. security-map.test.ts applies them to the rows of the shared
 * fixture and must get the database's numbers.
 */

/** Recorded once in each organization of one account: platform-wide, one event, counted as a floor. */
export const SECURITY_MAP_FOLDED_REASONS = [
  'sign_in_new_country',
  'sign_in_not_me',
  'sign_in_alerts_held',
] as const;
/** A number that can be a count of other rows of the record: in no total; listed apart. */
export const SECURITY_MAP_TALLY_REASONS = [
  'too_many_forms_to_count',
  'unrecorded_server_form_password',
  'unrecorded_server_form_code',
] as const;
/** Rows that stand for events past a cap: counted, never placed. */
export const SECURITY_MAP_FLOOD_REASONS = [
  'over_minute_cap',
  'over_buffer_cap',
  'auth_log_over_cap',
] as const;
/** Sources whose rows can be added up to hours after their minute: never in the 60-second cells. */
export const SECURITY_MAP_LATE_SOURCES = ['phone', 'api'] as const;
/** The most rows one sign-in writes of a folded reason (one in each of at most 5 organizations). */
export const SECURITY_MAP_ROWS_PER_SIGN_IN = 5;

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
/** A poll's timeline: its 60-second cells only. */
export const SECURITY_MAP_MAX_POLL_TIMELINE = 1000;
export const SECURITY_MAP_MAX_BY_COUNTRY = 2000;
export const SECURITY_MAP_MAX_FEED = 60;
export const SECURITY_MAP_MAX_FLAGGED_FEED = 20;
export const SECURITY_MAP_MAX_FLOORS = 40;
export const SECURITY_MAP_MAX_LATE_SOURCES = 30;
export const SECURITY_MAP_MAX_COUNTED_ROWS = 300;
/** The longest window the database reads, and the window below which a read is a poll. */
export const SECURITY_MAP_MAX_WINDOW_HOURS = 26;
export const SECURITY_MAP_SHORT_WINDOW_MS = 30 * 60_000;

/** Why the database would not read a window. It never repeats the argument. */
export const SECURITY_MAP_REFUSALS = [
  'not_a_time',
  'to_in_the_future',
  'from_not_before_to',
  'longer_than_26_hours',
  'too_many_events_in_one_minute',
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
  /** The count is a floor (a folded sign-in made of two rows or more): "at least". */
  at_least: boolean;
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

/**
 * The numbers of an answer that can be floors, by name, as `floors` lists
 * them: each total and each no-place count by category and outcome, the
 * three window counts and the day's count.
 */
export type SecurityMapFloorName =
  | `totals.${SecurityEventCategory}.${SecurityEventOutcome}`
  | `no_place.${SecurityEventCategory}.${SecurityEventOutcome}`
  | 'blocked_window'
  | 'flagged_window'
  | 'allowed_window'
  | 'blocked_since_day_start';

const FLOOR_NAMES: ReadonlySet<string> = new Set([
  ...['totals', 'no_place'].flatMap((part) =>
    SECURITY_EVENT_CATEGORIES.flatMap((category) =>
      (['blocked', 'flagged', 'allowed'] as const).map((o) => `${part}.${category}.${o}`),
    ),
  ),
  'blocked_window',
  'flagged_window',
  'allowed_window',
  'blocked_since_day_start',
]);

/** Whether `name` is one of the numbers the database can mark as a floor. */
export const isSecurityMapFloorName = (name: unknown): name is SecurityMapFloorName =>
  typeof name === 'string' && FLOOR_NAMES.has(name);

/** The twenty-four keys (contract VERSION 2), always all of them. */
export interface SecurityMapAnswer {
  /** The window READ; `asked_from` is the start asked for (later only when the ceiling moved it). */
  window: { from: string; to: string; live_from: string; asked_from: string };
  /** Too many rows to read the whole window: `window.from` was moved later. */
  window_shortened: boolean;
  /** The window asked for is shorter than 30 minutes (a poll): no 600-second cells, no by_country. */
  short_window: boolean;
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
  /** The day began before the start read, so the day's count is counted from `window.from`: a floor. */
  blocked_since_day_start_partial: boolean;
  /** The names of this answer's numbers that are floors: the page says "at least" beside them. */
  floors: SecurityMapFloorName[];
  feed: SecurityMapFeedEntry[];
  /** The newest flagged entries, so a flood of blocked ones can never push them all off the page. */
  flagged_feed: SecurityMapFeedEntry[];
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
  'window_shortened',
  'short_window',
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
  'blocked_since_day_start_partial',
  'floors',
  'feed',
  'flagged_feed',
  'late_sources',
  'tallies',
  'flood_rows',
] as const;

const FEED_KEYS = [
  'minute',
  'category',
  'outcome',
  'reason',
  'source',
  'country',
  'city',
  'events',
  'at_least',
  'organization_id',
  'organization_name',
  'organizations',
] as const;

const feedEntryDiffers = (row: Bag): string | null => {
  if (!isTime(row.minute)) return 'minute: not a time';
  if (!isReason(row.reason)) return 'reason: not a reason code';
  if (!isSecurityEventSource(row.source)) return 'source: not a source';
  if (row.country !== null && !isCountry(row.country)) {
    return 'country: not two capital letters';
  }
  if (row.city !== null && !textWithin(row.city, SECURITY_MAP_CITY_MAX)) {
    return 'city: not a short text';
  }
  if (typeof row.at_least !== 'boolean') return 'at_least: not a boolean';
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
};

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
  const windowDiffers = keysDiffer(window, ['from', 'to', 'live_from', 'asked_from']);
  if (windowDiffers) return no(`window.${windowDiffers}`);
  for (const key of ['from', 'to', 'live_from', 'asked_from'] as const) {
    if (!isTime(window[key])) return no(`window.${key}: not a time`);
  }
  for (const key of [
    'window_shortened',
    'short_window',
    'blocked_since_day_start_partial',
  ] as const) {
    if (typeof raw[key] !== 'boolean') return no(`${key}: not a boolean`);
  }
  // Shortened exactly when the start read is later than the start asked for.
  const moved = Date.parse(window.from as string) > Date.parse(window.asked_from as string);
  if (raw.window_shortened !== moved) return no('window_shortened: not as the window says');
  if (Date.parse(window.from as string) < Date.parse(window.asked_from as string)) {
    return no('window.from: before the start asked for');
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
  if (raw.blocked_since_day_start_partial === true && raw.blocked_since_day_start === null) {
    return no('blocked_since_day_start_partial: beside no count');
  }
  if (!Array.isArray(raw.floors)) return no('floors: not a list');
  if (raw.floors.length > SECURITY_MAP_MAX_FLOORS) return no('floors: longer than its cap');
  for (let i = 0; i < raw.floors.length; i += 1) {
    if (!isSecurityMapFloorName(raw.floors[i])) return no(`floors.${i}: not a number's name`);
  }
  // A day count cut short by the ceiling is a floor, and the answer says so in both places.
  if (
    raw.blocked_since_day_start_partial === true &&
    !(raw.floors as unknown[]).includes('blocked_since_day_start')
  ) {
    return no('blocked_since_day_start_partial: the count is not in floors');
  }
  // A poll (a window asked for that is shorter than 30 minutes): the live
  // cells only, and no groups by country.
  if (raw.short_window === true) {
    if (!Array.isArray(raw.timeline) || raw.timeline.length > SECURITY_MAP_MAX_POLL_TIMELINE) {
      return no('timeline: longer than a poll holds');
    }
    if ((raw.timeline as unknown[]).some((c) => isBag(c) && c.bucket_seconds !== 60)) {
      return no('timeline: a replay cell in a poll');
    }
    if (!Array.isArray(raw.by_country) || raw.by_country.length > 0) {
      return no('by_country: not empty in a poll');
    }
    if (raw.by_country_truncated !== false) return no('by_country_truncated: true in a poll');
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
    readList(raw.feed, 'feed', SECURITY_MAP_MAX_FEED, FEED_KEYS, feedEntryDiffers) ??
    readList(
      raw.flagged_feed,
      'flagged_feed',
      SECURITY_MAP_MAX_FLAGGED_FEED,
      FEED_KEYS,
      (row) => feedEntryDiffers(row) ?? (row.outcome === 'flagged' ? null : 'outcome: not flagged'),
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
  /** The count is a floor: "at least". */
  atLeast: boolean,
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
  /** The day began before the start read: the day's count is counted from `from`, a floor. */
  blockedSinceDayStartPartial: boolean;
  /** The answer's numbers that are floors, by name: the words say "at least" beside them. */
  floors: readonly SecurityMapFloorName[];
  /** The late sources' events hold a floor. */
  lateFloor: boolean;
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
  v: 2;
  scope: 'whole' | 'recent';
  /** The window READ. */
  from: string;
  to: string;
  liveFrom: string;
  /** The start asked for: earlier than `from` only when the window was shortened. */
  askedFrom: string;
  /** Too many events to read the whole window: only the part from `from` was read. */
  shortened: boolean;
  generatedAt: string;
  /** The last ten minutes, one per country, category and outcome, at most 40. */
  live: readonly SecurityMapArcRow[];
  /** More than 40 were live, or the database cut the timeline. */
  liveCut: boolean;
  feed: readonly SecurityMapFeedRow[];
  /** The newest flagged entries, at most 20. */
  flaggedFeed: readonly SecurityMapFeedRow[];
  whole: SecurityMapWholeView | null;
}

/** At most this many arcs are drawn, and so move, at once. */
export const SECURITY_MAP_MAX_ARCS = 40;
/** One replay step is one hour of the clock (UTC, as the database's buckets are). */
export const SECURITY_MAP_STEP_MS = 60 * 60 * 1000;
/** A 26-hour window touches at most this many clock hours. */
export const SECURITY_MAP_MAX_STEPS = SECURITY_MAP_MAX_WINDOW_HOURS + 1;

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
 * minutes, a poll: the database gives it no 10-minute cells and no groups by
 * country) keeps the live arcs and the two feeds only: its totals are ten
 * minutes' worth and must never stand in for the window's. Cells of two
 * answers are never added together (contract VERSION 2, "timeline").
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
  const feedRows = (entries: readonly SecurityMapFeedEntry[]): SecurityMapFeedRow[] =>
    entries
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
        e.at_least,
        e.organization_id,
        e.organization_name,
        e.organizations,
      ]);
  const view: SecurityMapView = {
    v: 2,
    scope,
    from: answer.window.from,
    to: answer.window.to,
    liveFrom: answer.window.live_from,
    askedFrom: answer.window.asked_from,
    shortened: answer.window_shortened,
    generatedAt: answer.generated_at,
    live: liveRows.slice(0, SECURITY_MAP_MAX_ARCS),
    liveCut: liveRows.length > SECURITY_MAP_MAX_ARCS || answer.timeline_truncated,
    feed: feedRows(answer.feed),
    flaggedFeed: feedRows(answer.flagged_feed),
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
    blockedSinceDayStartPartial: answer.blocked_since_day_start_partial,
    floors: [...answer.floors],
    lateFloor: answer.late_sources.some((row) =>
      answer.floors.includes(`totals.${row.category}.${row.outcome}`),
    ),
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
  if (!Array.isArray(v) || v.length !== 12) return false;
  const [
    minute,
    category,
    outcome,
    reason,
    source,
    country,
    city,
    events,
    atLeast,
    id,
    name,
    orgs,
  ] = v as unknown[];
  return (
    isTime(minute) &&
    shownIndexes.includes(category as number) &&
    (outcome === 0 || outcome === 1 || outcome === 2) &&
    isReason(reason) &&
    includes(SECURITY_EVENT_SOURCES, source) &&
    (country === null || isCountry(country)) &&
    (city === null || textWithin(city, SECURITY_MAP_CITY_MAX)) &&
    isCount(events) &&
    typeof atLeast === 'boolean' &&
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
  'blockedSinceDayStartPartial',
  'floors',
  'lateFloor',
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
  if (typeof v.blockedSinceDayStartPartial !== 'boolean' || typeof v.lateFloor !== 'boolean') {
    return false;
  }
  if (!Array.isArray(v.floors) || v.floors.length > SECURITY_MAP_MAX_FLOORS) return false;
  if (!(v.floors as unknown[]).every(isSecurityMapFloorName)) return false;
  if (v.oldestEventAt !== null && !isTime(v.oldestEventAt)) return false;
  if (v.dayStart !== null && !isTime(v.dayStart)) return false;
  if (v.blockedSinceDayStart !== null && !isCount(v.blockedSinceDayStart)) return false;
  if (
    v.blockedSinceDayStartPartial === true &&
    (v.blockedSinceDayStart === null ||
      !(v.floors as unknown[]).includes('blocked_since_day_start'))
  ) {
    return false;
  }
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
    'askedFrom',
    'shortened',
    'generatedAt',
    'live',
    'liveCut',
    'feed',
    'flaggedFeed',
    'whole',
  ];
  if (keysDiffer(raw, keys)) return null;
  if (raw.v !== 2 || (raw.scope !== 'whole' && raw.scope !== 'recent')) return null;
  for (const key of ['from', 'to', 'liveFrom', 'askedFrom', 'generatedAt'] as const) {
    if (!isTime(raw[key])) return null;
  }
  if (typeof raw.liveCut !== 'boolean' || typeof raw.shortened !== 'boolean') return null;
  const shownIndexes = shown.map(categoryIndex);
  if (!isArcList(raw.live, SECURITY_MAP_MAX_ARCS, shownIndexes)) return null;
  if (!Array.isArray(raw.feed) || raw.feed.length > SECURITY_MAP_MAX_FEED) return null;
  if (!(raw.feed as unknown[]).every((row) => isFeedRow(row, shownIndexes))) return null;
  if (!Array.isArray(raw.flaggedFeed) || raw.flaggedFeed.length > SECURITY_MAP_MAX_FLAGGED_FEED) {
    return null;
  }
  if (
    !(raw.flaggedFeed as unknown[]).every((row) => isFeedRow(row, shownIndexes) && row[2] === 1)
  ) {
    return null;
  }
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
 * One list of two reads' entries. Inside the minutes the newer read covers,
 * only its entries count (an entry there can change between reads: a
 * sign-in recorded in one organization and then in two more stops naming the
 * first, and a folded count can grow). Before that, the whole window's
 * entries. Newest first, at most `max`. Entries are never added together.
 */
function feedOfTwoReads(
  whole: SecurityMapWholeRead | null,
  recent: SecurityMapView | null,
  pick: (view: SecurityMapView) => readonly SecurityMapFeedRow[],
  max: number,
): SecurityMapFeedRow[] {
  if (!whole) return recent ? [...pick(recent)] : [];
  if (!recent || Date.parse(recent.generatedAt) < Date.parse(whole.generatedAt)) {
    return [...pick(whole)];
  }
  const from = Date.parse(recent.from);
  const older = pick(whole).filter((row) => Date.parse(row[0]) < from);
  return [...pick(recent), ...older].slice(0, max);
}

/** The feed of the two reads: newest first, at most 60. */
export function securityMapFeedOf(
  whole: SecurityMapWholeRead | null,
  recent: SecurityMapView | null,
): SecurityMapFeedRow[] {
  return feedOfTwoReads(whole, recent, (view) => view.feed, SECURITY_MAP_MAX_FEED);
}

/** The flagged feed of the two reads: the newest flagged entries, at most 20. */
export function securityMapFlaggedFeedOf(
  whole: SecurityMapWholeRead | null,
  recent: SecurityMapView | null,
): SecurityMapFeedRow[] {
  return feedOfTwoReads(whole, recent, (view) => view.flaggedFeed, SECURITY_MAP_MAX_FLAGGED_FEED);
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
 * Whether the database marked the named number of this read as a floor (it
 * holds a folded sign-in, counted as the fewest sign-ins its rows can stand
 * for). The words say "at least" beside it. With no read, nothing is a floor:
 * the number itself is "Could not check".
 */
export function securityMapIsFloor(
  whole: SecurityMapWholeRead | null,
  name: SecurityMapFloorName,
): boolean {
  return whole?.whole.floors.includes(name) ?? false;
}

/** A count in words: "7", or "at least 7" for a floor that counted something. Zero is zero. */
export function securityMapCountWords(count: number, floor: boolean): string {
  return floor && count > 0 ? `at least ${num(count)}` : num(count);
}

/**
 * A window's length in words, counted to the nearest minute: "last 24
 * hours", "last hour", "last 3 hours 52 minutes", "last 52 minutes". A
 * window the ceiling shortened is said as long as it is, never as the window
 * that was asked for.
 */
export function securityMapWindowWords(from: string, to: string): string {
  const minutes = Math.round((Date.parse(to) - Date.parse(from)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return 'this window';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const h = hours === 0 ? '' : hours === 1 ? 'hour' : `${hours} hours`;
  const m = rest === 0 ? '' : rest === 1 ? '1 minute' : `${rest} minutes`;
  if (h && m) return `last ${hours === 1 ? '1 hour' : h} ${m}`;
  if (h) return `last ${h}`;
  return rest === 1 ? 'last minute' : `last ${m}`;
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
 * when it was asked for and the database gave none, "Could not check"; when
 * the viewer's day has turned since that read (`dayStartNow` is a later
 * midnight), "Not counted yet" again until the new day is read. Never a zero
 * in a number's place. A number the database marked as a floor says
 * "at least"; a day's count that the ceiling cut short says from when it
 * counts.
 */
export function securityMapCounters(
  whole: SecurityMapWholeRead | null,
  dayStartAsked: boolean,
  options: { dayStartNow?: string | null; timeZone?: string } = {},
): SecurityMapCounter[] {
  const window = whole ? securityMapWindowWords(whole.from, whole.to) : 'last 24 hours';
  const w = whole?.whole ?? null;
  const dayTurned =
    w !== null &&
    w.dayStart !== null &&
    options.dayStartNow != null &&
    Date.parse(options.dayStartNow) !== Date.parse(w.dayStart);
  const today =
    w === null
      ? SECURITY_MAP_COULD_NOT_CHECK
      : dayTurned
        ? SECURITY_MAP_NOT_COUNTED_YET
        : w.blockedSinceDayStart !== null
          ? securityMapCountWords(
              w.blockedSinceDayStart,
              w.blockedSinceDayStartPartial || securityMapIsFloor(whole, 'blocked_since_day_start'),
            )
          : dayStartAsked
            ? SECURITY_MAP_COULD_NOT_CHECK
            : SECURITY_MAP_NOT_COUNTED_YET;
  const partial =
    whole !== null &&
    w !== null &&
    !dayTurned &&
    w.blockedSinceDayStart !== null &&
    w.blockedSinceDayStartPartial;
  return [
    {
      id: 'blocked_today',
      label: 'Blocked since midnight, your time',
      value: today,
      note: partial
        ? `Counted from ${securityMapClock(whole.from, options.timeZone)}, your time: there were too many events to count the whole day.`
        : null,
    },
    {
      id: 'blocked_window',
      label: `Blocked, ${window}`,
      value:
        w === null
          ? SECURITY_MAP_COULD_NOT_CHECK
          : securityMapCountWords(w.blocked, securityMapIsFloor(whole, 'blocked_window')),
      note: null,
    },
    {
      id: 'flagged_window',
      label: `Flagged, ${window}`,
      value:
        w === null
          ? SECURITY_MAP_COULD_NOT_CHECK
          : securityMapCountWords(w.flagged, securityMapIsFloor(whole, 'flagged_window')),
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
      blocked: row
        ? `${securityMapCountWords(row[1], securityMapIsFloor(whole, `totals.${category}.blocked`))} blocked`
        : SECURITY_MAP_COULD_NOT_CHECK,
      flagged: row
        ? `${securityMapCountWords(row[2], securityMapIsFloor(whole, `totals.${category}.flagged`))} ${SECURITY_MAP_FLAGGED_NOT_BLOCKED}`
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
    return 'Live: the last 10 minutes, without the events from the phone app and direct callers (some of those are added hours late, so they are shown in the replay and the totals instead).';
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
    longer_than_26_hours: 'the window asked for is longer than 26 hours',
    too_many_events_in_one_minute: 'one minute alone holds more events than can be read',
  };
  return `${SECURITY_MAP_COULD_NOT_CHECK}: ${why[refused]}. Nothing was read.`;
}

/** Whether any shown category's number in `part` for these outcomes is a floor. */
function shownFloor(
  whole: SecurityMapWholeRead,
  part: 'totals' | 'no_place',
  outcomes: readonly SecurityEventOutcome[],
  shown: readonly SecurityEventCategory[] = securityMapShownCategories(),
): boolean {
  return shown.some((category) =>
    outcomes.some((outcome) => securityMapIsFloor(whole, `${part}.${category}.${outcome}`)),
  );
}

/**
 * A window the row ceiling shortened, in a sentence: the part read, from
 * when, and that the rest was not counted. Null for a window read whole.
 */
export function securityMapShortenedWords(
  whole: SecurityMapWholeRead | null,
  timeZone?: string,
): string | null {
  if (!whole || !whole.shortened) return null;
  const at = securityMapClock(whole.from, timeZone);
  return `Showing the ${securityMapWindowWords(whole.from, whole.to)} only, from ${at}, your time: there were too many events to count all of the ${securityMapWindowWords(whole.askedFrom, whole.to)}. Nothing before ${at} is in these numbers.`;
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
        securityMapIsFloor(whole, 'totals.phishing.flagged'),
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
    const floor = shownFloor(whole, 'no_place', DRAWN);
    notes.push(
      `Not on the map: ${securityMapCountWords(w.noPlace, floor)} ${plural(w.noPlace, 'event has', 'events have')} no country. ${plural(w.noPlace, 'It is', 'They are')} in the totals.`,
    );
  }
  if (w.flood > 0) {
    notes.push(
      `${num(w.flood)} ${plural(w.flood, 'event', 'events')} in a flood: place not listed.`,
    );
  }
  if (w.allowed > 0) {
    const floor = shownFloor(whole, 'totals', ['allowed']);
    notes.push(
      `${securityMapCountWords(w.allowed, floor)} ${plural(w.allowed, 'event was', 'events were')} allowed. Allowed events are counted here and never drawn.`,
    );
  }
  if (w.late > 0) {
    notes.push(
      `Events from the phone app and direct callers are left out of the live play: some of them are added up to about seven hours late, with a country only. They are in the totals and the replay. In the ${window}: ${securityMapCountWords(w.late, w.lateFloor)} such ${plural(w.late, 'event', 'events')} so far.`,
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
  if (w.floors.length > 0) {
    notes.push(
      'A sign-in is recorded once in each organization of the account, and the record cannot tell one account from another. So it is counted as the fewest sign-ins its rows can stand for, and a number that holds one says "at least".',
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
  const [minute, c, o, reason, source, country, city, events, atLeast, id, name, organizations] =
    row;
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
    count: securityMapCountWords(events, atLeast),
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
        blocked: securityMapCountWords(
          row.blocked,
          securityMapIsFloor(whole, `totals.${category}.blocked`),
        ),
        flagged: securityMapCountWords(
          row.flagged,
          securityMapIsFloor(whole, `totals.${category}.flagged`),
        ),
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
  flaggedFeedTitle: 'Flagged, not blocked: the newest',
  flaggedFeedNote:
    'The newest 20 flagged entries of the kinds this map shows, so a flood of blocked ones never hides them. Times in UTC.',
  flaggedFeedEmpty: 'Nothing was flagged.',
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
