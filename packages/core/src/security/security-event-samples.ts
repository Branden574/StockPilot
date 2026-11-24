/**
 * "What was asked for" on the platform console (security tools part 5, stage
 * 3): the scrubbed paths and query strings scanners asked for, read through
 * platform_security_event_samples (migration 0479) and shown inside the
 * how-to-respond panel of an exploit-attempt entry.
 *
 * This module holds what the browser and the server share: the view that
 * leaves the server (and nothing else of the database's answer), the two
 * fixed failures, a strict reader of the action's answer for the browser, the
 * rule for the hour an entry asks about, and every word the section says.
 *
 * Every path and query string in a view is text a stranger chose. It was
 * scrubbed before it was stored (request-scrub.ts) and is shown as plain text
 * only, never as a link, a title or a name.
 *
 * Pure: no I/O.
 */

import { isStorableSample, isStorableTarget, SAMPLE_METHODS } from './request-scrub';
import {
  isSecurityProbeKind,
  SECURITY_PROBE_KINDS,
  type SecurityProbeKind,
} from './security-events';

/** The most paths one read returns (the contract's p_limit ceiling; review S4: a card asks for all of its hour). */
export const SECURITY_EVENT_SAMPLES_LIMIT = 50;
/** The paths shown before "Show all". */
export const SECURITY_EVENT_SAMPLES_FIRST = 5;
/** The most method and query string pairs the read gives a path. */
export const SECURITY_EVENT_SAMPLES_PAIRS_MAX = 5;
/** How far back an entry's hour may be (the read's longest window). */
export const SECURITY_EVENT_SAMPLES_MAX_AGE_HOURS = 168;

const HOUR_MS = 3_600_000;

/** One method and query string of a path, with how many requests asked it so. */
export interface SecurityEventSamplePair {
  method: string;
  /** The scrubbed query string, or null when there was none. */
  sample: string | null;
  events: number;
}

/** One path asked for, of one kind, with its count and its first pairs. */
export interface SecurityEventSampleTarget {
  reason: SecurityProbeKind;
  /** The scrubbed path (or '(unreadable)'). */
  target: string;
  events: number;
  pairs: SecurityEventSamplePair[];
  /** More pairs were asked for than the read gives (it gives five). */
  pairsTruncated: boolean;
}

/** What one kind's overflow rows counted: requests past the hour's 50 listed rows. */
export interface SecurityEventSamplesOverflow {
  reason: SecurityProbeKind;
  events: number;
  hours: number;
}

/** WHAT LEAVES THE SERVER: these keys and no others. Never an organization, a time of a row, or an id. */
export interface SecurityEventSamplesView {
  /** The country the read was filtered to, when one was asked for. */
  country: string | null;
  /** When the database read less than was asked (its row ceiling): the start it read from. */
  windowFrom: string | null;
  targets: SecurityEventSampleTarget[];
  /** More paths than were returned. */
  targetsTruncated: boolean;
  /** Every path in the window (after the filters). */
  listedTargets: number;
  moreThanListed: SecurityEventSamplesOverflow[];
}

/** The one answer every caller the console's rule turns away gets. */
export const SECURITY_EVENT_SAMPLES_REFUSED = Object.freeze({
  ok: false,
  reason: 'refused',
} as const);
/** The read failed, timed out, was refused a window, or answered a shape this build does not know. */
export const SECURITY_EVENT_SAMPLES_FAILED = Object.freeze({
  ok: false,
  reason: 'could_not_check',
} as const);

export type SecurityEventSamplesResult =
  | { ok: true; view: SecurityEventSamplesView }
  | typeof SECURITY_EVENT_SAMPLES_REFUSED
  | typeof SECURITY_EVENT_SAMPLES_FAILED;

/** What the panel asks for: one kind (or every kind), one UTC hour (or the last 24 hours), one country (or all). */
export interface SecurityEventSamplesAsk {
  reason: SecurityProbeKind | null;
  /** A whole UTC hour as an ISO time; null for the last 24 hours. */
  hour: string | null;
  country: string | null;
}

/** The UTC hour an instant falls in, as an ISO time (`2026-11-24T05:00:00.000Z`); null for no instant. */
export function securityEventSamplesHourOf(at: unknown): string | null {
  if (typeof at !== 'number' || !Number.isFinite(at)) return null;
  return new Date(Math.floor(at / HOUR_MS) * HOUR_MS).toISOString();
}

/**
 * Whether `hour` is one the read may be asked about at `now`: an ISO time on a
 * whole UTC hour, not after the hour running now, and at most
 * SECURITY_EVENT_SAMPLES_MAX_AGE_HOURS before it.
 */
export function isSecurityEventSamplesHour(hour: unknown, now: number): hour is string {
  if (typeof hour !== 'string' || hour.length > 40) return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:00:00(?:\.000)?Z$/.test(hour)) return false;
  const at = Date.parse(hour);
  if (!Number.isFinite(at) || at % HOUR_MS !== 0) return false;
  const current = Math.floor(now / HOUR_MS) * HOUR_MS;
  return at <= current && current - at <= SECURITY_EVENT_SAMPLES_MAX_AGE_HOURS * HOUR_MS;
}

/** Two capital letters, as the record writes a country. */
export function isSecurityEventSamplesCountry(country: unknown): country is string {
  return typeof country === 'string' && /^[A-Z]{2}$/.test(country);
}

/**
 * What an entry hands the panel for its "What was asked for": what it shows
 * already, and nothing else. Never a path or a query string.
 */
export interface SecurityEventSamplesEntry {
  /** The entry's probe kind; null for every kind (a card opened from the map's legend). */
  reason: string | null;
  /** The entry's instant (the UTC hour it falls in is read); null for the last 24 hours. */
  at: number | null;
  /** The entry's country, when its list names exactly one; null for every country. */
  country: string | null;
  /** The zone the entry's list writes its times in; null for the browser's own. */
  timeZone: string | null;
}

/**
 * What the panel reads for an entry: the ask, or why it reads nothing. An
 * hour more than 7 days back is `too_old` (the read's longest window); a kind
 * that is not a probe kind, or an instant that is not one, is `not_readable`
 * ("could not check"). An hour after the browser's own is still asked: the
 * server's clock decides. A country that is not two capitals reads every
 * country.
 */
export function securityEventSamplesAskFor(
  entry: Pick<SecurityEventSamplesEntry, 'reason' | 'at' | 'country'>,
  now: number,
): { ok: true; ask: SecurityEventSamplesAsk } | { ok: false; why: 'too_old' | 'not_readable' } {
  const reason = entry.reason;
  if (reason !== null && !isSecurityProbeKind(reason)) return { ok: false, why: 'not_readable' };
  const country = isSecurityEventSamplesCountry(entry.country) ? entry.country : null;
  if (entry.at === null) return { ok: true, ask: { reason, hour: null, country } };
  const hour = securityEventSamplesHourOf(entry.at);
  if (hour === null) return { ok: false, why: 'not_readable' };
  const current = Math.floor(now / HOUR_MS) * HOUR_MS;
  if (current - Date.parse(hour) > SECURITY_EVENT_SAMPLES_MAX_AGE_HOURS * HOUR_MS) {
    return { ok: false, why: 'too_old' };
  }
  return { ok: true, ask: { reason, hour, country } };
}

/* ─────────────── the browser's reader of the action's answer ─────────────── */

type Bag = Record<string, unknown>;
const isBag = (v: unknown): v is Bag => typeof v === 'object' && v !== null && !Array.isArray(v);
const hasOnly = (v: Bag, keys: readonly string[]) =>
  Object.keys(v).length === keys.length &&
  keys.every((k) => Object.prototype.hasOwnProperty.call(v, k));
const isCount = (v: unknown, min: number): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min;

function readPair(raw: unknown): SecurityEventSamplePair | null {
  if (!isBag(raw) || !hasOnly(raw, ['method', 'sample', 'events'])) return null;
  const { method, sample, events } = raw;
  if (!(SAMPLE_METHODS as readonly unknown[]).includes(method)) return null;
  if (
    sample !== null &&
    (typeof sample !== 'string' || sample === '' || !isStorableSample(sample))
  ) {
    return null;
  }
  if (!isCount(events, 1)) return null;
  return { method: method as string, sample: sample as string | null, events };
}

function readTarget(raw: unknown): SecurityEventSampleTarget | null {
  if (!isBag(raw) || !hasOnly(raw, ['reason', 'target', 'events', 'pairs', 'pairsTruncated'])) {
    return null;
  }
  const { reason, target, events, pairs, pairsTruncated } = raw;
  if (!isSecurityProbeKind(reason)) return null;
  if (typeof target !== 'string' || !isStorableTarget(target)) return null;
  if (!isCount(events, 1) || typeof pairsTruncated !== 'boolean') return null;
  if (
    !Array.isArray(pairs) ||
    pairs.length < 1 ||
    pairs.length > SECURITY_EVENT_SAMPLES_PAIRS_MAX
  ) {
    return null;
  }
  const read = pairs.map(readPair);
  if (read.some((p) => p === null)) return null;
  return { reason, target, events, pairs: read as SecurityEventSamplePair[], pairsTruncated };
}

/** The view as the browser reads it: exactly the keys above, each of its kind; anything else is null. */
export function readSecurityEventSamplesView(raw: unknown): SecurityEventSamplesView | null {
  const keys = [
    'country',
    'windowFrom',
    'targets',
    'targetsTruncated',
    'listedTargets',
    'moreThanListed',
  ];
  if (!isBag(raw) || !hasOnly(raw, keys)) return null;
  const { country, windowFrom, targets, targetsTruncated, listedTargets, moreThanListed } = raw;
  if (country !== null && !isSecurityEventSamplesCountry(country)) return null;
  if (
    windowFrom !== null &&
    (typeof windowFrom !== 'string' || !Number.isFinite(Date.parse(windowFrom)))
  ) {
    return null;
  }
  if (typeof targetsTruncated !== 'boolean' || !isCount(listedTargets, 0)) return null;
  if (!Array.isArray(targets) || targets.length > SECURITY_EVENT_SAMPLES_LIMIT) return null;
  const readTargets = targets.map(readTarget);
  if (readTargets.some((t) => t === null)) return null;
  if (!Array.isArray(moreThanListed) || moreThanListed.length > SECURITY_PROBE_KINDS.length)
    return null;
  const overflow: SecurityEventSamplesOverflow[] = [];
  for (const o of moreThanListed) {
    if (!isBag(o) || !hasOnly(o, ['reason', 'events', 'hours'])) return null;
    if (!isSecurityProbeKind(o.reason) || !isCount(o.events, 1) || !isCount(o.hours, 1))
      return null;
    if ((o.hours as number) > SECURITY_EVENT_SAMPLES_MAX_AGE_HOURS) return null;
    overflow.push({ reason: o.reason, events: o.events as number, hours: o.hours as number });
  }
  return {
    country: country as string | null,
    windowFrom: windowFrom as string | null,
    targets: readTargets as SecurityEventSampleTarget[],
    targetsTruncated,
    listedTargets,
    moreThanListed: overflow,
  };
}

/** The action's answer as the browser reads it. Anything it does not know is a failed read. */
export function readSecurityEventSamplesResult(raw: unknown): SecurityEventSamplesResult {
  if (!isBag(raw)) return SECURITY_EVENT_SAMPLES_FAILED;
  if (raw.ok === false && raw.reason === 'refused' && hasOnly(raw, ['ok', 'reason'])) {
    return SECURITY_EVENT_SAMPLES_REFUSED;
  }
  if (raw.ok !== true || !hasOnly(raw, ['ok', 'view'])) return SECURITY_EVENT_SAMPLES_FAILED;
  const view = readSecurityEventSamplesView(raw.view);
  return view ? { ok: true, view } : SECURITY_EVENT_SAMPLES_FAILED;
}

/* ───────────────────────────────── words ───────────────────────────────── */

const plural = (n: number, one: string, many: string) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

export const SECURITY_EVENT_SAMPLES_WORDS = {
  title: 'What was asked for',
  /** The label of a request's query string. */
  sent: 'What was sent',
  noQuery: 'No query string',
  loading: 'Loading what was asked for...',
  couldNotCheck:
    'Could not check what was asked for. Close this panel and open it again to try once more.',
  refused:
    'Not shown: the console needs you signed in with your second step. Reload the page and sign in again.',
  none: 'No sample was kept for this entry.',
  tooOld: 'What was asked for is read for the last 7 days only, and this entry is older.',
  noneWhy:
    'A sample is kept only for a request that matched a scanner rule, and only since samples began to be kept.',
  /**
   * The fixed line under every list. It says the text is the sender's, not
   * StockPilot's (review 3B S7: up to 200 characters of a stranger's words
   * are shown in the console).
   */
  removed:
    "Only the path and the query string of a request the site refused. A request body is never kept. Anything that looked like an email address, an id, a long value, a secret or a parameter the site's own routing uses was removed. The text shown is what the sender of the request typed, not something StockPilot wrote or ran. Do not visit, call or write to anything it names.",
  pairsTruncated: 'More variations were asked for than are shown.',
  /** The window, under the title. */
  hourWindow: (from: string, to: string): string => `In the hour from ${from} to ${to}.`,
  lastDay: 'In the last 24 hours.',
  inCountry: (country: string): string => `From ${country} only.`,
  windowFrom: (from: string): string =>
    `Read from ${from} only: the record held more than one read takes.`,
  requests: (n: number): string => plural(n, 'request', 'requests'),
  showAll: (n: number): string => `Show all ${n.toLocaleString('en-US')}`,
  showFirst: (n: number): string => `Show the first ${n.toLocaleString('en-US')}`,
  targetsTruncated: (listed: number, shown: number): string =>
    `${plural(listed, 'path was', 'paths were')} asked for; the ${shown.toLocaleString('en-US')} asked for most are listed.`,
  /**
   * The contract's line (0479 CONTRACT.md, "The page's line") for a kind
   * whose hour held more than its 50 listed rows. `kind` names it when the
   * list holds several kinds (a card opened from the legend).
   */
  overflow: (
    o: { events: number; hours: number },
    filteredByCountry: boolean,
    kind?: string,
  ): string =>
    `${kind ? `${kind}: ` : ''}${o.events.toLocaleString('en-US')} more requests of this kind were counted but not listed${
      o.hours > 1 ? ` in ${o.hours.toLocaleString('en-US')} hours` : ''
    }${filteredByCountry ? ' (all countries)' : ''}. Each hour lists only the first 50 different requests of a kind (a path with one method, one query string and one country); one path asked many ways can use them all.`,
} as const;
