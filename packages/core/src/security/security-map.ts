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
  securityEventReasonLabel,
  SECURITY_EVENT_UNKNOWN_REASON_LABEL,
  type SecurityEventCategory,
  type SecurityEventOutcome,
  type SecurityEventSource,
} from './security-events';
import {
  clockWords,
  runtimeTimeZone,
  usableTimeZone,
  zoneLongWords,
  zoneShortName,
  type ClockStyle,
} from '../time/viewer-zone';
import { zonedParts } from '../time/zoned-wall-clock';

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

/** Whether a floor's name holds one of these kinds (`totals.<kind>.<outcome>`, `no_place.<kind>.<outcome>`). */
function namesAHiddenKind(name: string, hidden: readonly SecurityEventCategory[]): boolean {
  const kind = name.split('.')[1];
  return kind !== undefined && (hidden as readonly string[]).includes(kind);
}

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

/**
 * The four parts every kept entry starts with, in both feeds: its key (made
 * on the server from the entry's identity, securityMapEntryKey), its
 * minute, its count, and whether the count is a floor ("at least").
 */
export type SecurityMapKeptRow = readonly [
  key: string,
  minute: string,
  events: number,
  atLeast: boolean,
  ...rest: unknown[],
];

/**
 * One entry of the plain feed as it travels: every part is drawn. The
 * outcome: 0 blocked, 1 flagged, 2 allowed. The organization's id is there
 * for the entry's "Open organization" link, its name for the entry's
 * Organization line (design VERSION 2, V2.3: the reader is the platform
 * administrator).
 */
export type SecurityMapFeedRow = readonly [
  key: string,
  minute: string,
  events: number,
  /** The count is a floor: "at least". */
  atLeast: boolean,
  category: number,
  outcome: 0 | 1 | 2,
  reason: string,
  source: string,
  country: string | null,
  city: string | null,
  organizationId: string | null,
  organizationName: string | null,
  organizations: number,
];

/**
 * One entry of the flagged list as it travels: what the list draws and
 * nothing else. Always flagged, so no outcome; no source, which the list never
 * shows. The category is its place in SECURITY_EVENT_CATEGORIES when the map
 * shows that kind (its mark's colour), and null for a kind the map does not
 * show (a neutral mark): such a kind's name never leaves the server.
 *
 * The organization travels as on the plain feed (its id for the links, its
 * name, and how many organizations a sign-in recorded in several names): the
 * owner reversed review M1 for his console in his own words, 2026-11-24, "its
 * fine showing org names so I know", because an Act now card asks him to act
 * in that organization.
 */
export type SecurityMapFlaggedRow = readonly [
  key: string,
  minute: string,
  events: number,
  atLeast: boolean,
  category: number | null,
  reason: string,
  country: string | null,
  city: string | null,
  organizationId: string | null,
  organizationName: string | null,
  organizations: number,
];

/**
 * One tally reason of the window: its code and, only for the reason whose
 * number the page says, the requests it counted. The page writes one line
 * per reason and never adds two together (contract VERSION 2, "tallies").
 */
export type SecurityMapTallyRow = readonly [reason: string, counted: number | null];

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
  /**
   * The answer's numbers that are floors, by name: the words say "at least"
   * beside them. Only names of shown kinds and of the window's sums: a hidden
   * kind's name never leaves the server (review round 2, N3).
   */
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
  /** The tally reasons of the window, one row each, in the answer's order. In no total. */
  tallies: readonly SecurityMapTallyRow[];
  /** Events of the categories the map does not show. */
  notDrawnSignInAlerts: number;
  /** The not-drawn sign-in alerts hold a floor: their line says "at least". */
  notDrawnSignInAlertsFloor: boolean;
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
  /**
   * The last ten minutes hold blocked or flagged events of a shown kind that
   * the live play cannot draw: no place, a flood, or from the phone app or
   * the API (the late sources, which the 60-second cells leave out).
   */
  liveUndrawn: boolean;
  feed: readonly SecurityMapFeedRow[];
  /** The newest flagged entries, at most 20. */
  flaggedFeed: readonly SecurityMapFlaggedRow[];
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

/** A key is at most 11 characters: 53 bits in base 36. */
const ENTRY_KEY_RE = /^[0-9a-z]{1,11}$/;

/**
 * A short opaque key for one feed entry, made on the server from the
 * entry's identity as the contract defines it (minute, category, outcome,
 * reason, source, country, city, organization). The browser keeps entries
 * across reads by it, so the flagged list needs neither the source nor the
 * organization to tell two entries apart. It is a plain hash (53 bits,
 * cyrb53), not a secret: it hides nothing from someone who already holds
 * every field it is made of. Two entries of one list sharing a key does not
 * arise in practice at 53 bits.
 */
export function securityMapEntryKey(entry: SecurityMapFeedEntry): string {
  const identity = JSON.stringify([
    Date.parse(entry.minute),
    entry.category,
    entry.outcome,
    entry.reason,
    entry.source,
    entry.country,
    entry.city,
    entry.organization_id,
  ]);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < identity.length; i++) {
    const ch = identity.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** The one tally reason whose number the page says: a count of requests. The others say none. */
const TALLY_NUMBER_SAID = 'too_many_forms_to_count';

/**
 * The database's answer cut down to what the page draws and says, and
 * nothing more (the rule for this page: nothing leaves the server that the
 * page does not draw, or need for a link it draws).
 *
 * A category that is not shown is taken out of every drawing and list here
 * (the arcs, the table, the legend, the plain feed), so nothing downstream
 * can draw it; its events are two numbers for one line of words. Its
 * flagged entries are in the flagged list, with no category: a neutral mark
 * and the reason's own words. `recent` (a read of the last ten minutes, a
 * poll: the database gives it no 10-minute cells and no groups by country)
 * keeps the live arcs and the two feeds only: its totals are ten minutes'
 * worth and must never stand in for the window's. Cells of two answers are
 * never added together (contract VERSION 2, "timeline").
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
  // The plain feed holds the shown kinds only. The flagged feed holds every
  // kind: the flagged sign-in alerts are real events even though their
  // category is not drawn, and the flagged list is there for them.
  const feed: SecurityMapFeedRow[] = answer.feed
    .filter((e) => shown.includes(e.category))
    .map((e) => [
      securityMapEntryKey(e),
      e.minute,
      e.events,
      e.at_least,
      categoryIndex(e.category),
      OUTCOMES.indexOf(e.outcome) as 0 | 1 | 2,
      e.reason,
      e.source,
      e.country,
      e.city,
      e.organization_id,
      e.organization_name,
      e.organizations,
    ]);
  const flaggedFeed: SecurityMapFlaggedRow[] = answer.flagged_feed
    .filter((e) => e.outcome === 'flagged')
    .map((e) => [
      securityMapEntryKey(e),
      e.minute,
      e.events,
      e.at_least,
      shown.includes(e.category) ? categoryIndex(e.category) : null,
      e.reason,
      e.country,
      e.city,
      e.organization_id,
      e.organization_name,
      e.organizations,
    ]);
  // What the last ten minutes hold that the live play cannot draw. Every read
  // looks at its feeds' entries of those minutes; a poll's numbers are of
  // those minutes alone, so a poll looks at them too.
  const liveFromMs = Date.parse(answer.window.live_from);
  const undrawn = (e: SecurityMapFeedEntry): boolean =>
    shown.includes(e.category) &&
    e.outcome !== 'allowed' &&
    Date.parse(e.minute) >= liveFromMs &&
    (e.country === null || isSecurityMapFloodReason(e.reason) || isSecurityMapLateSource(e.source));
  const liveUndrawn =
    answer.feed.some(undrawn) ||
    answer.flagged_feed.some(undrawn) ||
    (scope === 'recent' &&
      (sumCounts(answer.no_place, shown, DRAWN) > 0 ||
        answer.late_sources.some(
          (row) => shown.includes(row.category) && row.outcome !== 'allowed' && row.events > 0,
        )));
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
    liveUndrawn,
    feed,
    flaggedFeed,
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
    floors: answer.floors.filter((name) => !namesAHiddenKind(name, hidden)),
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
    tallies: tallyRows(answer.tallies),
    notDrawnSignInAlerts: signInAlerts,
    notDrawnSignInAlertsFloor:
      signInAlerts > 0 && answer.floors.includes('totals.phishing.flagged'),
    notDrawnOther: sumCounts(answer.totals, hidden, OUTCOMES) - signInAlerts,
  };
  return view;
}

/**
 * The tally reasons, one row each, in the order they come: the requests a
 * reason counted are added up over its rows (its hours) and never across two
 * reasons. Only the reason whose number the page says carries one.
 */
function tallyRows(tallies: SecurityMapAnswer['tallies']): SecurityMapTallyRow[] {
  const byReason = new Map<string, number>();
  for (const row of tallies) {
    if (row.rows <= 0) continue;
    byReason.set(row.reason, (byReason.get(row.reason) ?? 0) + row.events);
  }
  return [...byReason].map(([reason, events]) => [
    reason,
    reason === TALLY_NUMBER_SAID ? events : null,
  ]);
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

/** The four parts both feeds' rows start with. */
const isKeptHead = (key: unknown, minute: unknown, events: unknown, atLeast: unknown): boolean =>
  typeof key === 'string' &&
  ENTRY_KEY_RE.test(key) &&
  isTime(minute) &&
  isCount(events) &&
  typeof atLeast === 'boolean';

/** An entry's organization: an id or none, a short name or none, and how many organizations it names. */
const isOrganization = (id: unknown, name: unknown, orgs: unknown): boolean =>
  (id === null || isUuid(id)) &&
  (name === null || textWithin(name, SECURITY_MAP_ORGANIZATION_NAME_MAX)) &&
  isCount(orgs);

const isPlace = (country: unknown, city: unknown): boolean =>
  (country === null || isCountry(country)) &&
  (city === null || textWithin(city, SECURITY_MAP_CITY_MAX));

function isFeedRow(v: unknown, shownIndexes: readonly number[]): v is SecurityMapFeedRow {
  if (!Array.isArray(v) || v.length !== 13) return false;
  const [
    key,
    minute,
    events,
    atLeast,
    category,
    outcome,
    reason,
    source,
    country,
    city,
    id,
    name,
    orgs,
  ] = v as unknown[];
  return (
    isKeptHead(key, minute, events, atLeast) &&
    shownIndexes.includes(category as number) &&
    (outcome === 0 || outcome === 1 || outcome === 2) &&
    isReason(reason) &&
    includes(SECURITY_EVENT_SOURCES, source) &&
    isPlace(country, city) &&
    isOrganization(id, name, orgs)
  );
}

/** A flagged list's row: eleven parts, a shown kind's place or null, the organization as the feed has it, and nothing else. */
function isFlaggedRow(v: unknown, shownIndexes: readonly number[]): v is SecurityMapFlaggedRow {
  if (!Array.isArray(v) || v.length !== 11) return false;
  const [key, minute, events, atLeast, category, reason, country, city, id, name, orgs] =
    v as unknown[];
  return (
    isKeptHead(key, minute, events, atLeast) &&
    (category === null || shownIndexes.includes(category as number)) &&
    isReason(reason) &&
    isPlace(country, city) &&
    isOrganization(id, name, orgs)
  );
}

/** The tally rows: a reason each, never twice; a number only beside the reason whose number is said. */
function isTallyList(v: unknown): v is readonly SecurityMapTallyRow[] {
  if (!Array.isArray(v) || v.length > SECURITY_MAP_MAX_COUNTED_ROWS) return false;
  const seen = new Set<string>();
  for (const row of v as unknown[]) {
    if (!Array.isArray(row) || row.length !== 2 || !isReason(row[0])) return false;
    const reason = row[0] as string;
    if (seen.has(reason)) return false;
    seen.add(reason);
    if (reason === TALLY_NUMBER_SAID ? !isCount(row[1]) : row[1] !== null) return false;
  }
  return true;
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
  'tallies',
  'notDrawnSignInAlerts',
  'notDrawnSignInAlertsFloor',
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
    'notDrawnSignInAlerts',
    'notDrawnOther',
  ] as const;
  if (!counts.every((key) => isCount(v[key]))) return false;
  if (!isTallyList(v.tallies)) return false;
  if (typeof v.tableCut !== 'boolean' || typeof v.drawingCut !== 'boolean') return false;
  if (
    typeof v.blockedSinceDayStartPartial !== 'boolean' ||
    typeof v.lateFloor !== 'boolean' ||
    typeof v.notDrawnSignInAlertsFloor !== 'boolean'
  ) {
    return false;
  }
  if (!Array.isArray(v.floors) || v.floors.length > SECURITY_MAP_MAX_FLOORS) return false;
  if (!(v.floors as unknown[]).every(isSecurityMapFloorName)) return false;
  // A hidden kind's name never comes: the server leaves those out.
  const hiddenKinds = SECURITY_EVENT_CATEGORIES.filter(
    (category) => !shownIndexes.includes(categoryIndex(category)),
  );
  if ((v.floors as string[]).some((name) => namesAHiddenKind(name, hiddenKinds))) return false;
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
    'liveUndrawn',
    'feed',
    'flaggedFeed',
    'whole',
  ];
  if (keysDiffer(raw, keys)) return null;
  if (raw.v !== 2 || (raw.scope !== 'whole' && raw.scope !== 'recent')) return null;
  for (const key of ['from', 'to', 'liveFrom', 'askedFrom', 'generatedAt'] as const) {
    if (!isTime(raw[key])) return null;
  }
  for (const key of ['liveCut', 'liveUndrawn', 'shortened'] as const) {
    if (typeof raw[key] !== 'boolean') return null;
  }
  const shownIndexes = shown.map(categoryIndex);
  if (!isArcList(raw.live, SECURITY_MAP_MAX_ARCS, shownIndexes)) return null;
  if (!Array.isArray(raw.feed) || raw.feed.length > SECURITY_MAP_MAX_FEED) return null;
  if (!(raw.feed as unknown[]).every((row) => isFeedRow(row, shownIndexes))) return null;
  if (!Array.isArray(raw.flaggedFeed) || raw.flaggedFeed.length > SECURITY_MAP_MAX_FLAGGED_FEED) {
    return null;
  }
  // A kind the map does not draw is in the flagged feed with no category at all.
  if (!(raw.flaggedFeed as unknown[]).every((row) => isFlaggedRow(row, shownIndexes))) {
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

/**
 * One arc of the plan: a country, a category, an outcome, a count. The
 * category is null for a flagged sign-in alert, drawn from the kept flagged
 * list (an entry of a kind the map's numbers leave out, which reaches the
 * browser with no category): the renderers give it the one neutral look and
 * no kind's name.
 */
export interface SecurityMapArc {
  /** Stable for a country, category and outcome, so a renderer can keep an arc across reads. */
  key: string;
  country: string;
  category: SecurityEventCategory | null;
  outcome: SecurityMapDrawnOutcome;
  events: number;
  /** Stroke width in the map's own units: by the count, on a log scale. */
  width: number;
  /** A sign-in alert arc's count holds a floor ("at least"): one of its entries said so. */
  atLeast?: boolean;
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
  /** The newest read's last ten minutes hold events the live play cannot draw (its `liveUndrawn`). */
  liveUndrawn: boolean;
}

/** How long one hour of the replay stays on the map. */
export const SECURITY_MAP_REPLAY_STEP_MS = 2500;

const MINUTE_MS = 60_000;

/**
 * The flagged sign-in alerts of the kept flagged list as arcs, one per
 * country (owner's decision of 2026-11-24: they are drawn, not only listed).
 * Only an entry of a kind the map's numbers leave out (it reaches the
 * browser with no category), with a country, and not a count past a cap.
 * Nothing new leaves the server for them: the list already carries the
 * minute, the count, the country and the city. The arc has no category and
 * so no kind's name; its count says "at least" when an entry's did.
 */
export function securityMapSignInAlertArcs(
  rows: readonly SecurityMapFlaggedRow[],
): SecurityMapArc[] {
  const byCountry = new Map<string, { events: number; atLeast: boolean }>();
  for (const [, , events, atLeast, category, reason, country] of rows) {
    if (category !== null || country === null || isSecurityMapFloodReason(reason)) continue;
    const held = byCountry.get(country);
    if (held) {
      held.events += events;
      held.atLeast ||= atLeast;
    } else byCountry.set(country, { events, atLeast });
  }
  return [...byCountry.entries()]
    .sort((a, b) => b[1].events - a[1].events || (a[0] < b[0] ? -1 : 1))
    .map(([country, { events, atLeast }]) => ({
      key: `${country}:alert:flagged`,
      country,
      category: null,
      outcome: 'flagged' as const,
      events,
      width: securityMapArcWidth(events),
      ...(atLeast ? { atLeast: true } : {}),
    }));
}

/**
 * The timeline's arcs and the sign-in alerts' together, the largest first,
 * at most 40. With no alert the timeline's arcs are kept as they are, in
 * their own order. An alert arc goes after every timeline arc with as many
 * events or more, so a tie never pushes a timeline arc out.
 */
function withAlertArcs(
  arcs: readonly SecurityMapArc[],
  alerts: readonly SecurityMapArc[],
): { arcs: SecurityMapArc[]; cut: boolean } {
  if (alerts.length === 0) {
    return { arcs: arcs.slice(0, SECURITY_MAP_MAX_ARCS), cut: arcs.length > SECURITY_MAP_MAX_ARCS };
  }
  const merged = [...arcs];
  for (const alert of alerts) {
    let at = merged.findIndex((arc) => arc.events < alert.events);
    if (at < 0) at = merged.length;
    merged.splice(at, 0, alert);
  }
  return {
    arcs: merged.slice(0, SECURITY_MAP_MAX_ARCS),
    cut: merged.length > SECURITY_MAP_MAX_ARCS,
  };
}

/** The flagged rows whose minute reaches into [fromMs, toMs). */
function rowsIn(
  rows: readonly SecurityMapFlaggedRow[],
  fromMs: number,
  toMs: number,
): SecurityMapFlaggedRow[] {
  return rows.filter((row) => {
    const at = Date.parse(row[1]);
    return at + MINUTE_MS > fromMs && at < toMs;
  });
}

/**
 * THE PLAYBACK PLAN. Live when the newest read's last ten minutes hold
 * events (the database leaves the late sources out of those cells, so a row
 * added hours late is never played as if it had just happened); otherwise a
 * replay of the whole window, hour by hour, skipping hours with nothing;
 * otherwise still. Arcs come from the timeline, and from the flagged sign-in
 * alerts of the kept flagged list (`alerts`, the island's kept list; owner's
 * decision of 2026-11-24): an alert is live when its minute reaches into the
 * live window, and in the replay at its hour. The 40-arc cap holds for both
 * together.
 *
 * `recent` is the newest read of the last ten minutes, or null; it counts
 * only when it is newer than the read of the whole window.
 */
export function planSecurityMapPlayback(
  whole: SecurityMapWholeRead | null,
  recent: SecurityMapView | null,
  alerts: readonly SecurityMapFlaggedRow[] = [],
): SecurityMapPlan {
  const newest =
    recent && (!whole || Date.parse(recent.generatedAt) >= Date.parse(whole.generatedAt))
      ? recent
      : whole;
  const liveFromMs = newest ? Date.parse(newest.liveFrom) : Number.NaN;
  const liveAlerts = Number.isFinite(liveFromMs)
    ? securityMapSignInAlertArcs(rowsIn(alerts, liveFromMs, Number.POSITIVE_INFINITY))
    : [];
  const liveRows = newest?.live ?? [];
  const live = withAlertArcs(liveRows.map(securityMapArcOf), liveAlerts);
  const liveUndrawn = newest?.liveUndrawn ?? false;
  if (live.arcs.length > 0) {
    return {
      mode: 'live',
      live: live.arcs,
      steps: [],
      picture: live.arcs,
      cut: (newest?.liveCut ?? false) || live.cut,
      liveUndrawn,
    };
  }
  if (!whole) return { mode: 'still', live: [], steps: [], picture: [], cut: false, liveUndrawn };
  const hours = new Map<number, readonly SecurityMapArcRow[]>(whole.whole.steps);
  for (const row of alerts) {
    const at = Date.parse(row[1]);
    if (!Number.isFinite(at)) continue;
    const hour = Math.floor(at / SECURITY_MAP_STEP_MS) * SECURITY_MAP_STEP_MS;
    if (!hours.has(hour) && securityMapSignInAlertArcs([row]).length > 0) hours.set(hour, []);
  }
  let cut = whole.whole.drawingCut;
  const steps: SecurityMapReplayStep[] = [...hours.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([fromMs, rows]) => {
      const toMs = fromMs + SECURITY_MAP_STEP_MS;
      const step = withAlertArcs(
        rows.map(securityMapArcOf),
        securityMapSignInAlertArcs(rowsIn(alerts, fromMs, toMs)),
      );
      cut ||= step.cut;
      return { fromMs, toMs, arcs: step.arcs };
    });
  if (steps.length > 0) {
    const picture = withAlertArcs(
      whole.whole.still.map(securityMapArcOf),
      securityMapSignInAlertArcs(alerts),
    );
    return {
      mode: 'replay',
      live: [],
      steps,
      picture: picture.arcs,
      cut: cut || picture.cut,
      liveUndrawn,
    };
  }
  return { mode: 'still', live: [], steps: [], picture: [], cut: false, liveUndrawn };
}

/** Newest first: the latest minute, inside a minute the largest count, then by key. */
function feedOrder(a: SecurityMapKeptRow, b: SecurityMapKeptRow): number {
  const byTime = Date.parse(b[1]) - Date.parse(a[1]);
  if (byTime !== 0) return byTime;
  if (b[2] !== a[2]) return b[2] - a[2];
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}

/** A list of entries kept across reads, and whether entries fell past its cap. */
export interface SecurityMapKeptFeed<R extends SecurityMapKeptRow = SecurityMapFeedRow> {
  rows: R[];
  /** Entries fell off the end, behind newer ones: the list leaves some out. */
  cut: boolean;
}

/**
 * A poll's entries merged into the list kept since the last read of the
 * whole window. A poll's feeds cover only its own ten minutes, so the kept
 * list is never replaced by a poll's (contract, corrections after review
 * round 2). One entry by identity: the same entry in both keeps the larger
 * count, since an entry only grows as rows come in and a poll's first minute
 * holds only part of it; the two are never added. An entry leaves only when
 * its minute has left the window (`fromMs`, the window's start now), when it
 * falls past `max` behind newer ones (`cut` then says so), or when the whole
 * window is read again (the caller starts a new list from that read).
 */
export function securityMapMergeFeed<R extends SecurityMapKeptRow>(
  kept: readonly R[],
  incoming: readonly R[],
  fromMs: number,
  max: number,
): SecurityMapKeptFeed<R> {
  const byKey = new Map<string, R>();
  for (const row of kept) byKey.set(row[0], row);
  for (const row of incoming) {
    const was = byKey.get(row[0]);
    if (!was || row[2] >= was[2]) byKey.set(row[0], row);
  }
  const inWindow = [...byKey.values()].filter((row) => Date.parse(row[1]) + MINUTE_MS > fromMs);
  inWindow.sort(feedOrder);
  return { rows: inWindow.slice(0, max), cut: inWindow.length > max };
}

/**
 * Whether entries or live cells hold something the last good read of the
 * whole window had not counted: an entry whose minute starts at or after the
 * end of the window that read covered (its `to`), or one whose minute
 * straddles that end with more events than the whole read's own lists gave
 * it (or that they did not hold). False with no whole read: there are no
 * totals to be behind.
 *
 * A live cell carries no minute of its own (the view sums the last ten
 * minutes by country, kind and outcome), so `recent`, a poll's read of its
 * own last ten minutes, is set beside the whole read's: both windows are ten
 * minutes long and the poll's ends later, so a count in the poll that is
 * larger than the whole read's for the same country, kind and outcome can
 * only come from events after the whole read's end. When the whole read's
 * live list was cut (more than 40, or a cut timeline) a missing or smaller
 * count proves nothing, and live cells are not looked at.
 *
 * Used twice (the coordinator's change of 2026-11-24): on a poll's own
 * entries, to read the whole window early (map-model nextPoll keeps every
 * other rule), and on the kept lists, so the page never says "nothing" while
 * its feed lists something newer than the totals.
 */
export function securityMapNewerThanTotals(
  whole: SecurityMapWholeRead | null,
  rows: readonly SecurityMapKeptRow[],
  recent: SecurityMapView | null = null,
): boolean {
  if (!whole) return false;
  const toMs = Date.parse(whole.to);
  if (!Number.isFinite(toMs)) return false;
  if (recent && !whole.liveCut && Date.parse(recent.to) > toMs) {
    const live = new Map<string, number>();
    for (const [country, category, outcome, events] of whole.live) {
      live.set(`${country}:${category}:${outcome}`, events);
    }
    const grew = recent.live.some(
      ([country, category, outcome, events]) =>
        events > (live.get(`${country}:${category}:${outcome}`) ?? 0),
    );
    if (grew) return true;
  }
  const counted = new Map<string, number>();
  for (const row of [...whole.feed, ...whole.flaggedFeed]) {
    counted.set(row[0], Math.max(counted.get(row[0]) ?? 0, row[2]));
  }
  return rows.some((row) => {
    const at = Date.parse(row[1]);
    if (!Number.isFinite(at)) return false;
    if (at >= toMs) return true;
    return at + MINUTE_MS > toMs && (counted.get(row[0]) ?? -1) < row[2];
  });
}

/**
 * Where the window starts now: the start the whole window was read from,
 * moved on by as much time as the newest poll reaches past that read.
 */
export function securityMapWindowStartNow(
  whole: SecurityMapWholeRead | null,
  poll: SecurityMapView,
): number {
  if (!whole) return Date.parse(poll.from);
  return Date.parse(whole.from) + Math.max(0, Date.parse(poll.to) - Date.parse(whole.to));
}

/**
 * Whether the flagged list leaves flagged events out: the events of the list
 * as kept add up to less than the flagged events of the last read of the
 * whole window (`flagged_window`, every kind). The list shows every kind, so
 * the two count the same things.
 */
export function securityMapFlaggedFeedLeavesOut(
  whole: SecurityMapWholeRead | null,
  rows: readonly SecurityMapFlaggedRow[],
): boolean {
  if (!whole) return false;
  let listed = 0;
  for (const row of rows) listed += row[2];
  return listed < whole.whole.flagged;
}

/**
 * The words beside the flagged list, or null when the list says it all.
 * `rows` is the list as kept; `cut` that it lost entries past its cap.
 */
export function securityMapFlaggedListWords(
  whole: SecurityMapWholeRead | null,
  rows: readonly SecurityMapFlaggedRow[],
  cut: boolean,
): string | null {
  if (!whole) {
    return rows.length === 0
      ? `${SECURITY_MAP_COULD_NOT_CHECK}.`
      : SECURITY_MAP_WORDS.flaggedFeedUnread;
  }
  const leavesOut = cut || securityMapFlaggedFeedLeavesOut(whole, rows);
  if (rows.length === 0) {
    return leavesOut
      ? SECURITY_MAP_WORDS.flaggedFeedNoneListed
      : SECURITY_MAP_WORDS.flaggedFeedEmpty;
  }
  return leavesOut ? SECURITY_MAP_WORDS.flaggedFeedMore : null;
}

/** The words for a flagged reason this build does not know: neutral, never the raw code. */
export const SECURITY_MAP_FLAGGED_UNKNOWN_REASON = 'Flagged sign-in event';

/** What a flagged entry was, in plain words from its reason code. */
export function securityMapFlaggedReasonWords(reason: string): string {
  const label = securityEventReasonLabel(reason);
  return label === SECURITY_EVENT_UNKNOWN_REASON_LABEL
    ? SECURITY_MAP_FLAGGED_UNKNOWN_REASON
    : label;
}

/* ───────────────────── polling, and when the play stops ───────────────────── */

/** The last ten minutes are read this often; the whole window this often (review S8). */
export const SECURITY_MAP_RECENT_POLL_MS = 30_000;
export const SECURITY_MAP_WHOLE_POLL_MS = 5 * 60_000;
/**
 * The shortest gap between the starts of two reads of the whole window the
 * page sends, whatever asks for one: the early read when a poll brought
 * events newer than the totals (the coordinator's change of 2026-11-24), the
 * 5-minute read, the viewer's midnight, the replay's turn, a tab shown again
 * (review M1, 2026-11-24).
 */
export const SECURITY_MAP_EARLY_WHOLE_GAP_MS = 45_000;
/** After this many failed reads in a row the page says it is not updating, and the play stops. */
export const SECURITY_MAP_FAILED_POLLS_BEFORE_STOP = 2;
const BACK_OFF_MAX_MS = 120_000;
/**
 * The browser's own limit on one read (review S1): a read with no answer by
 * then is counted out, the page says it is not updating, and an answer that
 * comes later is ignored. The server gives up on the database after 6 s.
 */
export const SECURITY_MAP_READ_LIMIT_MS = 20_000;
/** After a failed read of the whole window the next waits 2, 4, 8, then 10 minutes (review S2). */
const WHOLE_BACK_OFF_FIRST_MS = 2 * 60_000;
const WHOLE_BACK_OFF_MAX_MS = 10 * 60_000;

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

export type SecurityMapPollOutcome = 'ok' | 'failed' | 'refused' | 'timed_out';

/**
 * The health after one read. A refusal is also a failure: the page backs off
 * and stops. A read that never answered within SECURITY_MAP_READ_LIMIT_MS
 * stops the play at once: whatever is on the map is older than the page can
 * vouch for.
 */
export function securityMapHealthAfter(
  health: SecurityMapHealth,
  outcome: SecurityMapPollOutcome,
  nowMs: number,
): SecurityMapHealth {
  if (outcome === 'ok') return { failures: 0, lastGoodAt: nowMs, refused: false };
  const failures = health.failures + 1;
  return {
    failures:
      outcome === 'timed_out'
        ? Math.max(failures, SECURITY_MAP_FAILED_POLLS_BEFORE_STOP)
        : failures,
    lastGoodAt: health.lastGoodAt,
    refused: outcome === 'refused',
  };
}

/** How long to wait before the next read of the last ten minutes: 30 s, then 60 s, then 120 s. */
export function securityMapNextPollDelay(failures: number): number {
  const doubled = SECURITY_MAP_RECENT_POLL_MS * 2 ** Math.max(0, Math.min(failures, 8));
  return Math.min(BACK_OFF_MAX_MS, doubled);
}

/**
 * How long after the last ATTEMPT to read the whole window the next may be
 * sent: 5 minutes when it succeeded; after failures in a row 2, 4, 8, then
 * 10 minutes. The reads of the last ten minutes go on in between.
 */
export function securityMapNextWholeDelay(wholeFailures: number): number {
  if (!(wholeFailures > 0)) return SECURITY_MAP_WHOLE_POLL_MS;
  const doubled = WHOLE_BACK_OFF_FIRST_MS * 2 ** Math.min(wholeFailures - 1, 8);
  return Math.min(WHOLE_BACK_OFF_MAX_MS, doubled);
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

/** The words before a number that is a floor (the page sets them small, before the number). */
export const SECURITY_MAP_AT_LEAST = 'at least';

/** A count in words: "7", or "at least 7" for a floor that counted something. Zero is zero. */
export function securityMapCountWords(count: number, floor: boolean): string {
  return floor && count > 0 ? `${SECURITY_MAP_AT_LEAST} ${num(count)}` : num(count);
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
  options: { dayStartNow?: string | null; timeZone?: string; now?: number } = {},
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
      // The midnight of the zone the times beside it are in, named.
      label: `Blocked since midnight, ${zoneShortName(options.now ?? Date.now(), options.timeZone ?? runtimeTimeZone())}`,
      value: today,
      note: partial
        ? `Counted from ${securityMapZonedClock(whole.from, options.timeZone)}: there were too many events to count the whole day.`
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

/**
 * How the map writes a clock: 12-hour with AM or PM ("11:20 PM PST"), as the
 * owner was told the platform security pages would show it (2026-11-24). The
 * exact UTC beside each time stays 24-hour.
 */
export const SECURITY_MAP_CLOCK: ClockStyle = '12h';

/**
 * "HH:MM" on a 24-hour clock, or "h:MM AM" on a 12-hour one (`clock`), in
 * `timeZone` (the runtime's own zone when none is given).
 */
export function securityMapClock(
  at: number | string,
  timeZone?: string,
  clock: ClockStyle = '24h',
): string {
  const ms = typeof at === 'number' ? at : Date.parse(at);
  if (!Number.isFinite(ms)) return '--:--';
  if (clock === '12h') {
    const p = zonedParts(ms, timeZone ?? runtimeTimeZone());
    return clockWords(p.hour, p.minute, '12h');
  }
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).format(new Date(ms));
}

/**
 * "9:58 PM PST": the clock in `timeZone` (the map's clock, SECURITY_MAP_CLOCK,
 * unless `clock` says otherwise) and the zone's short name at that instant, as
 * the formatter gives it (the viewer's zone: the one they chose, else the
 * browser's; the runtime's own when none is given).
 */
export function securityMapZonedClock(
  at: number | string,
  timeZone?: string,
  clock: ClockStyle = SECURITY_MAP_CLOCK,
): string {
  const ms = typeof at === 'number' ? at : Date.parse(at);
  if (!Number.isFinite(ms)) return '--:--';
  const zone = timeZone ?? runtimeTimeZone();
  return `${securityMapClock(ms, zone, clock)} ${zoneShortName(ms, zone)}`;
}

/** The line under a list that says which zone its times are in: "Times in Pacific Standard Time (America/Los_Angeles)." */
export function securityMapTimesWords(
  timeZone: string | undefined,
  at: number = Date.now(),
): string {
  return `Times in ${zoneLongWords(at, timeZone ?? runtimeTimeZone())}.`;
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
      ? ` Now showing ${securityMapClock(step.fromMs, timeZone ?? runtimeTimeZone(), SECURITY_MAP_CLOCK)} to ${securityMapZonedClock(step.toMs, timeZone)}.`
      : '';
    const undrawn = plan.liveUndrawn ? ` ${SECURITY_MAP_WORDS.liveUndrawn}` : '';
    return `Replay of the ${window}. ${SECURITY_MAP_WORDS.liveNothingToDraw}${undrawn}${hour} Hours with nothing to draw are skipped.`;
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
        : `Not updating since ${securityMapZonedClock(health.lastGoodAt, timeZone)}. The map is stopped and shows what was read then.`;
    case 'reduced_motion':
      return 'Not moving: your device asks for reduced motion. The picture and the numbers are the same.';
    case 'paused':
      return 'Paused. The numbers still update.';
    default:
      return null;
  }
}

/** What the pill on the map says: the play's mode, or why it is not moving. */
export type SecurityMapPillKind =
  | 'live'
  | 'replay'
  | 'not_updating'
  | 'sign_in_again'
  | 'paused'
  | 'reduced_motion'
  | 'nothing_to_play';

/**
 * The short words of the pill on the map, the long sentence's headline (the
 * sentence itself is under the map): "Live"; "Replay 20:00 to 21:00" with the
 * hour shown (the viewer's time); "Not updating since 18:10"; "Sign in
 * again"; "Paused"; "Still: reduced motion"; "Nothing to play". A hidden tab
 * shows the mode it had.
 */
export function securityMapPillWords(
  plan: SecurityMapPlan,
  stop: SecurityMapStopReason | null,
  health: SecurityMapHealth,
  stepIndex: number,
  timeZone?: string,
): { kind: SecurityMapPillKind; text: string } {
  switch (stop) {
    case 'sign_in_again':
      return { kind: 'sign_in_again', text: SECURITY_MAP_WORDS.pillSignInAgain };
    case 'not_updating':
      return {
        kind: 'not_updating',
        text:
          health.lastGoodAt === null
            ? SECURITY_MAP_WORDS.pillNotUpdating
            : `${SECURITY_MAP_WORDS.pillNotUpdating} since ${securityMapZonedClock(health.lastGoodAt, timeZone)}`,
      };
    case 'reduced_motion':
      return { kind: 'reduced_motion', text: SECURITY_MAP_WORDS.pillReducedMotion };
    case 'paused':
      return { kind: 'paused', text: SECURITY_MAP_WORDS.pillPaused };
    default:
      break;
  }
  if (plan.mode === 'live') return { kind: 'live', text: SECURITY_MAP_WORDS.pillLive };
  if (plan.mode === 'replay') {
    const step = plan.steps[Math.max(0, Math.min(stepIndex, plan.steps.length - 1))];
    return {
      kind: 'replay',
      text: step
        ? `${SECURITY_MAP_WORDS.pillReplay} ${securityMapClock(step.fromMs, timeZone ?? runtimeTimeZone(), SECURITY_MAP_CLOCK)} to ${securityMapZonedClock(step.toMs, timeZone)}`
        : SECURITY_MAP_WORDS.pillReplay,
    };
  }
  return { kind: 'nothing_to_play', text: SECURITY_MAP_WORDS.pillNothingToPlay };
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
  const at = securityMapZonedClock(whole.from, timeZone);
  return `Showing the ${securityMapWindowWords(whole.from, whole.to)} only, from ${at}: there were too many events to count all of the ${securityMapWindowWords(whole.askedFrom, whole.to)}. Nothing before ${at} is in these numbers.`;
}

/**
 * The line that says more happened than the play on screen can draw, naming
 * that play: the live play's last ten minutes, or the replay's hours. Only
 * while the mode on screen is the one that was cut: never beside a live play
 * that draws everything, whatever the replay held (lab walk 2, note A).
 */
export function securityMapCutWords(plan: SecurityMapPlan): string | null {
  if (!plan.cut) return null;
  if (plan.mode === 'live') return SECURITY_MAP_WORDS.cutLive;
  if (plan.mode === 'replay') return SECURITY_MAP_WORDS.cutReplay;
  return null;
}

/**
 * The lines under the map that say what the numbers leave out, cut short or
 * cannot place. Each is there only when it has something to say. (Whether
 * the drawing was cut is said by securityMapCutWords, of the play on screen.)
 */
export function securityMapNotes(whole: SecurityMapWholeRead, timeZone?: string): string[] {
  const w = whole.whole;
  const window = securityMapWindowWords(whole.from, whole.to);
  const notes: string[] = [];

  if (w.notDrawnSignInAlerts > 0) {
    // Drawn since 2026-11-24 from the flagged list (its newest entries), and
    // still in no number by kind: this line says both, and where all of them are.
    const count = securityMapCountWords(w.notDrawnSignInAlerts, w.notDrawnSignInAlertsFloor);
    const one = w.notDrawnSignInAlerts === 1;
    notes.push(
      `${count.charAt(0).toUpperCase()}${count.slice(1)} flagged sign-in ${one ? 'alert is' : 'alerts are'} not in the numbers by kind. ${
        one ? 'It is drawn' : 'The newest are drawn'
      } with a grey mark, from the flagged list, and ${one ? 'it is' : 'every one is'} on the Security page.`,
    );
  }
  if (w.notDrawnOther > 0) {
    notes.push(
      `Not drawn: ${num(w.notDrawnOther)} ${plural(w.notDrawnOther, 'event', 'events')} of a kind this map does not show. ${
        w.notDrawnOther === 1 ? 'It is' : 'They are'
      } on the Security page.`,
    );
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
  for (const [reason, counted] of w.tallies) notes.push(securityMapTallyWords(reason, counted));
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

/**
 * One tally reason's line, in its own words (SECURITY_MAP_WORDS). Only the
 * reason whose number is a count of requests says a number; the two whose
 * number can repeat other rows say that some could not all be counted, and
 * no number. Never a sum across reasons.
 */
export function securityMapTallyWords(reason: string, counted: number | null): string {
  if (reason === TALLY_NUMBER_SAID && counted !== null) {
    return SECURITY_MAP_WORDS.tallyTooManyForms(counted);
  }
  switch (reason) {
    case 'unrecorded_server_form_password':
      return SECURITY_MAP_WORDS.tallyUnrecordedPassword;
    case 'unrecorded_server_form_code':
      return SECURITY_MAP_WORDS.tallyUnrecordedCode;
    default:
      return SECURITY_MAP_WORDS.tallyOther;
  }
}

/**
 * The words where the map and the table have nothing to show. Null when they
 * have, and null while the kept lists hold entries newer than the totals
 * (`behind`, securityMapNewerThanTotals): the totals are being counted again
 * then, and "nothing" would contradict the feed beside it.
 */
export function securityMapEmptyWords(
  whole: SecurityMapWholeRead | null,
  behind = false,
): string | null {
  if (!whole || behind) return null;
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
  /** The newest read of the whole window failed: the next waits longer (review S2). */
  retrying = false,
): string {
  if (!whole) return SECURITY_MAP_WORDS.wholeUnread;
  const at = `Totals and table as of ${securityMapZonedClock(whole.generatedAt, timeZone)}.`;
  return retrying
    ? `${at} ${SECURITY_MAP_WORDS.wholeRetrying}`
    : `${at} They are counted again every 5 minutes; the live play and the feed every 30 seconds.`;
}

export interface SecurityMapFeedWords {
  /** Stable for an entry across reads. */
  key: string;
  /** "21:58 UTC", or "13:58 PST": the minute in the viewer's zone, named. */
  time: string;
  /** The minute as an instant, for its exact UTC beside the words. */
  at: number;
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
  /** How many organizations the entry's events were recorded in (more than one: no id). */
  organizations: number;
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
export function securityMapFeedWords(
  row: SecurityMapFeedRow,
  /** The viewer's zone; anything else (an index from .map) is UTC. */
  timeZone?: unknown,
): SecurityMapFeedWords {
  const zone = usableTimeZone(timeZone) ?? 'UTC';
  const [
    key,
    minute,
    events,
    atLeast,
    c,
    o,
    reason,
    source,
    country,
    city,
    id,
    name,
    organizations,
  ] = row;
  const category = SECURITY_EVENT_CATEGORIES[c] as SecurityEventCategory;
  const outcome = OUTCOMES[o] as SecurityEventOutcome;
  const flood = isSecurityMapFloodReason(reason);
  return {
    key,
    time: securityMapZonedClock(minute, zone),
    at: Date.parse(minute),
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
    organizations,
    organizationWords: organizationWordsOf(id, organizations),
  };
}

/** An entry with no organization id in words: "3 organizations" (one sign-in in several), else "No organization". */
function organizationWordsOf(id: string | null, organizations: number): string | null {
  if (id !== null) return null;
  return organizations > 1 ? `${num(organizations)} organizations` : 'No organization';
}

export interface SecurityMapFlaggedWords {
  /** The key the server made, stable for an entry across reads. */
  key: string;
  /** "21:58 UTC", or "13:58 PST": the minute in the viewer's zone, named. */
  time: string;
  /** The minute as an instant, for its exact UTC beside the words. */
  at: number;
  /** The kind, when the map shows it (its mark's colour); null for a kind it does not (a neutral mark). */
  category: SecurityEventCategory | null;
  /** What it was, in its own plain words; a neutral name for a code this build does not know. */
  what: string;
  country: string | null;
  city: string | null;
  /** True for a row that stands for events past a cap: it has no place to show. */
  flood: boolean;
  /** "at least 2" or "11". */
  count: string;
  /** The organization's id, when the entry names one organization: its links. */
  organizationId: string | null;
  organizationName: string | null;
  /** How many organizations the entry's sign-in was recorded in (more than one: no id). */
  organizations: number;
  /** "3 organizations" or "No organization", when there is no id to show; else null. */
  organizationWords: string | null;
}

/** One flagged entry's facts, ready to show: time, place, count, its plain name, and its organization. */
export function securityMapFlaggedWords(
  row: SecurityMapFlaggedRow,
  /** The viewer's zone; anything else (an index from .map) is UTC. */
  timeZone?: unknown,
): SecurityMapFlaggedWords {
  const zone = usableTimeZone(timeZone) ?? 'UTC';
  const [key, minute, events, atLeast, c, reason, country, city, id, name, organizations] = row;
  const flood = isSecurityMapFloodReason(reason);
  return {
    key,
    time: securityMapZonedClock(minute, zone),
    at: Date.parse(minute),
    category:
      c === null
        ? null
        : ((SECURITY_EVENT_CATEGORIES[c] as SecurityEventCategory | undefined) ?? null),
    what: securityMapFlaggedReasonWords(reason),
    country: flood ? null : country,
    city: flood ? null : city,
    flood,
    count: securityMapCountWords(events, atLeast),
    organizationId: id,
    organizationName: name,
    organizations,
    organizationWords: organizationWordsOf(id, organizations),
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
  feedEmpty: 'No entries to list.',
  flaggedFeedTitle: 'Flagged, not blocked: the newest',
  flaggedFeedNote:
    'The newest 20 flagged entries of the window read, so a flood of blocked ones never hides them.',
  flaggedFeedSplit:
    'Flagged sign-in alerts are listed here and drawn on the map with a grey mark. They are not in the numbers by kind.',
  flaggedFeedEmpty: 'Nothing was flagged.',
  flaggedFeedMore: 'Only the newest are listed: this window holds more flagged events than these.',
  flaggedFeedNoneListed: 'None listed, though this window holds flagged events.',
  flaggedFeedUnread:
    'The whole window could not be read: only entries of the last ten minutes are listed.',
  liveNothingToDraw: 'Nothing to draw from the last 10 minutes.',
  liveUndrawn:
    'Events of the last 10 minutes without a place, or from the phone app and the API, are counted in the numbers, but the live play does not draw them.',
  tallyTooManyForms: (counted: number): string =>
    `Refused sign-in requests that could not all be counted one by one: ${num(counted)} ${plural(counted, 'request was', 'requests were')} counted together. That number can repeat requests already counted elsewhere, so it is in no total here.`,
  tallyUnrecordedPassword:
    "Refused sign-ins in our server's form could not all be counted: our server has no record of some of them. No number is given for them, and they are in no total here.",
  tallyUnrecordedCode:
    "Refused authenticator codes in our server's form could not all be counted: our server has no record of some of them. No number is given for them, and they are in no total here.",
  tallyOther:
    'Some other refused requests could not all be counted. No number is given for them, and they are in no total here.',
  wholeUnread:
    "The day's picture is incomplete: the totals and the table could not be read. They are tried again within 10 minutes.",
  wholeRetrying:
    'The newest count could not be read, so these may be out of date; it is tried again within 10 minutes. The live play and the feed are read every 30 seconds.',
  tableTitle: 'By country',
  tableNote:
    'The same numbers as the map, in full. A country is where a request came from, which can be a relay.',
  placeUnknown: 'No place',
  placeFlood: 'Place not listed (a flood)',
  openOrganization: 'Open organization',
  globeUnavailable: 'This browser cannot draw the globe, so the flat map is shown.',
  globeLost: 'The globe stopped drawing, so the flat map is shown.',
  pillLive: 'Live',
  pillReplay: 'Replay',
  pillNotUpdating: 'Not updating',
  pillSignInAgain: 'Sign in again',
  pillPaused: 'Paused',
  pillReducedMotion: 'Still: reduced motion',
  pillNothingToPlay: 'Nothing to play',
  legendBlocked: 'Blocked',
  legendFlagged: 'Flagged, not blocked',
  /** Under the legend, naming the view on screen: one sentence for the globe and the flat map. */
  legendCounts: (view: 'globe' | 'flat') =>
    `Numbers on the ${view === 'flat' ? 'map' : 'globe'}: events in this play`,
  legendSignInAlert: 'Flagged sign-in alert',
  legendSignInAlertHelp:
    'Drawn from the flagged list, with a grey mark and a dashed line. Not in the numbers by kind.',
  recounting:
    'New events arrived, so the totals and the table are being counted again. The numbers above are as of the time below until then.',
  tableRecounting: 'Being counted again: new events arrived.',
  cutLive:
    'More happened in the last 10 minutes than the map can draw: the largest counts are drawn and the rest are left out of the drawing.',
  cutReplay:
    'More happened in some hours of this replay than the map can draw: the largest counts are drawn and the rest are left out of the drawing.',
  showAll: (count: number): string => `Show all ${num(count)}`,
  showFewer: 'Show fewer',
} as const;
