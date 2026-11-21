import 'server-only';

import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * REFUSED SIGN-INS THAT NEVER REACH OUR SERVER, read once an hour from
 * Supabase's gateway log (part 1 of the security tools, second step). The
 * cron route app/api/cron/security-events-auth-logs calls readAuthLogs.
 *
 * The phone app signs in straight to Supabase Auth, and anyone who has the
 * public key can send a password or an authenticator code there too, so our
 * server never sees those refusals. Supabase's gateway log has one line per
 * request. This job counts the refused ones and stores the COUNTS in the
 * security-events record (migration 0472) through its writer,
 * record_security_events.
 *
 * WHAT LEAVES SUPABASE. Two constant queries (AUTH_LOGS_GROUPS_SQL and
 * AUTH_LOGS_TOTALS_SQL) answer, for each group of lines: the minute, the kind
 * of request, the status, the caller's class (the client string reduced
 * INSIDE the query to phone, server, browser, other or none), the network's
 * class (hosting or other, worked out inside the query from the network
 * owner's name, which never leaves), the country (two capital letters, or
 * empty) and a count. Never an address, an email, an account, a path, a query
 * string, an id, the client string itself or a raw log line. The hour travels
 * in the two timestamp parameters; nothing is ever put into the SQL text.
 * Every field that comes back is checked before use (parseGroupRow,
 * parseTotalsRow); a row that fails is dropped and counted in the run's log
 * line.
 *
 * THE KIND is read the way the sign-in service reads the request: from the
 * DECODED path, with the case it routes, and from the decoded grant_type of
 * the query string. A sign-in with exactly one grant_type, `password`, is
 * `password`; exactly one, `refresh_token`, is `refresh` (an ordinary expired
 * session); anything else sent to the sign-in path is `token_other`. A code
 * check on `/auth/v1/factors/<id>/verify` with a well-formed id is `verify`;
 * any other form of it is `verify_other`. The id never leaves the query.
 *
 * WHAT IS STORED (classifyAuthLogLine):
 *   - a password sign-in answered 400: password_guessing / wrong_password;
 *   - a code check answered 422: password_guessing / wrong_code;
 *   - either answered 429, Supabase's own limit: bots / auth_rate_limited;
 *   - any other status of those two is counted in the log line and not
 *     stored: a status whose meaning is not known is not shown as an attack;
 *   - refreshes are counted, never stored;
 *   - requests of an unusual form (token_other, verify_other) are counted and
 *     not stored as attacks; when an hour has AUTH_LOGS_UNCLASSIFIED_FLAG_AT
 *     or more of them, ONE flagged element carries their count
 *     (unclassified_sign_in_refusals, source api, no country).
 *   The source is phone for the phone app's client string and api for
 *   everything else (a browser, anything unknown, none). OUR OWN SERVER's
 *   lines are not stored: part 1 recorded those refusals already, with the
 *   member's real place (the gateway's country for them is the server's).
 *   Our own server is its client string AND a hosting network. The same
 *   client string from any other network is someone dressing up as our
 *   server, and is stored as api: a network class that is not exactly
 *   `hosting` is `other` (fail closed). Every element has no organization
 *   (the line names no account), no city and no source hash.
 *
 * AN HOUR IS WRITTEN ONCE (the writer ADDS on a repeat). Each run handles the
 * last six complete UTC hours, oldest first, so a missed run heals. An hour
 * that already holds a row only this job writes (no organization, source
 * phone or api, a reason in AUTH_LOGS_REASONS: auth-logs.guard.test.ts pins
 * that no other code writes one) is skipped; an hour's elements go in ONE
 * writer call, so an hour is stored whole or not at all; an hour with
 * nothing to store is read again by the next run. If every element of an
 * hour lands past the writer's per-minute caps (it then stores them as
 * over_minute_cap rows, which the check does not read), the check cannot see
 * the hour, and that is reported.
 *
 * TWO QUERIES AN HOUR. The groups query lists the lines that can be stored
 * (kinds password and verify) by minute and country, at most
 * AUTH_LOGS_ROW_LIMIT groups, largest first. The totals query counts every
 * kind by kind, status, caller and network only: it gives the log line, the
 * unusual-form count and, when the groups query was full, the rest. What the
 * groups did not list is stored on one auth_log_over_cap element per category
 * and source (a reason no other code writes), at the hour's first minute,
 * with no country; the smallest groups are folded into those elements until
 * the call holds at most AUTH_LOGS_MAX_ELEMENTS.
 *
 * FAILURES. The run stops at its first failure and reports it once, in plain
 * words with a status or a code: a refused token (401 or 403: the owner makes
 * a new one), a query the logs service did not run (it answers 200 with an
 * error), a logs answer that is late (20 s), refused (another status) or not
 * readable, a read or a write of the record that failed. The hour is left for
 * the next run. The run has a deadline (AUTH_LOGS_RUN_DEADLINE_MS) inside the
 * route's 60 s limit; a run that reaches it stops and says so once.
 *
 * THE TOKEN (SUPABASE_LOGS_READ_TOKEN, which the route reads through the env
 * module and hands in) is sent only as the Authorization header of a GET to
 * AUTH_LOGS_API_ORIGIN, with redirects refused. It is never logged, never put
 * in a report and never returned. An answer that is not a success is never
 * read, and no error's own text is ever passed on: a failure is described by
 * this module's words, a status and a code.
 *
 * Server code only (server/security/events.guard.test.ts).
 */

export const AUTH_LOGS_TAG = 'cron.security-events-auth-logs';
/** The only host this job sends the token to. */
export const AUTH_LOGS_API_ORIGIN = 'https://api.supabase.com';
/** Complete UTC hours each run handles, oldest first. */
export const AUTH_LOGS_HOURS_PER_RUN = 6;
/** The LIMIT of both queries (written into the SQL text below). */
export const AUTH_LOGS_ROW_LIMIT = 199;
/** What record_security_events reads of one call (`limit 200` on its array). */
export const AUTH_LOGS_MAX_ELEMENTS = 200;
/** The writer reads a count of at most six digits (anything longer is stored as 1). */
export const AUTH_LOGS_MAX_COUNT = 999_999;
/** Requests of an unusual form in one hour from which one flagged count is stored. */
export const AUTH_LOGS_UNCLASSIFIED_FLAG_AT = 20;
/** One logs call: one try, this long at most. */
export const AUTH_LOGS_CALL_TIMEOUT_MS = 20_000;
/** One read or write of the record, this long at most (the writer waits 2 s for its turn). */
export const AUTH_LOGS_DB_TIMEOUT_MS = 5_000;
/** A run starts no call after this long, and cuts any call at it (the route allows 60 s). */
export const AUTH_LOGS_RUN_DEADLINE_MS = 50_000;
/** A call is not started with less time than this left. */
const MIN_CALL_MS = 1_000;
/** Distinct (kind, status, caller, network) counts the log line lists; the rest are summed. */
export const AUTH_LOGS_SEEN_LIMIT = 40;
/** A logs answer longer than this is not read. */
const MAX_ANSWER_CHARS = 2_000_000;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** Every reason this job writes. No other code may write one with source phone or api. */
export const AUTH_LOGS_REASONS = [
  'wrong_password',
  'wrong_code',
  'auth_rate_limited',
  'auth_log_over_cap',
  'unclassified_sign_in_refusals',
] as const;
export type AuthLogsReason = (typeof AUTH_LOGS_REASONS)[number];

/** Every source this job writes. */
export const AUTH_LOGS_SOURCES = ['phone', 'api'] as const;
export type AuthLogsSource = (typeof AUTH_LOGS_SOURCES)[number];

const KINDS = ['password', 'refresh', 'token_other', 'verify', 'verify_other'] as const;
type AuthLogsKind = (typeof KINDS)[number];
const CALLERS = ['phone', 'server', 'browser', 'other', 'none'] as const;
type AuthLogsCaller = (typeof CALLERS)[number];
type AuthLogsNetwork = 'hosting' | 'other';

/**
 * The refused lines of one hour that can be stored (kinds password and
 * verify), by minute, kind, status, caller class, network class and country,
 * largest groups first.
 *
 * Read from Supabase's single `logs` table (ClickHouse), gateway lines only
 * (source edge_logs), where every field is a string in log_attributes. Only
 * POSTs answered 400 to 499 whose decoded path is `/auth/v1/token` or
 * `/auth/v1/factors/<one segment>/verify`. The named values at the top are
 * shared with AUTH_LOGS_TOTALS_SQL, word for word:
 *   - hosting_owner_prefix: the start of the network owner's name that makes
 *     a line's network `hosting` (measured; see the comment in the query);
 *   - the path and the query string, raw and decoded;
 *   - first_grant: the first decoded grant_type value.
 * The kind is `token_other` when the query string holds an escape that does
 * not decode, an encoded `&` or `=` (which the sign-in service keeps inside a
 * value, so reading the whole decoded string would read it differently) or
 * an encoded control character, or when it holds two grant_type values.
 * The client string and the owner's name are reduced to a class here; the
 * path and the query string are compared, never returned.
 */
export const AUTH_LOGS_GROUPS_SQL = `WITH
  /* The hosting of our own server, measured on 2026-11-21 from 24 hours of gateway lines: every
     line with the client string of our own server came from a network owner whose name starts
     with this, and no line of the phone app or of a browser did. */
  'Amazon' AS hosting_owner_prefix,
  log_attributes['request.path'] AS raw_path,
  decodeURLComponent(raw_path) AS decoded_path,
  log_attributes['request.search'] AS raw_search,
  decodeURLComponent(raw_search) AS decoded_search,
  extract(decoded_search, '(?:^[?]?|&)grant_type=([^&]*)') AS first_grant
SELECT
  toString(toStartOfMinute(timestamp)) AS minute,
  multiIf(
    match(raw_path, '^/auth/v1/factors/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/verify$'), 'verify',
    decoded_path != '/auth/v1/token', 'verify_other',
    raw_path != '/auth/v1/token', 'token_other',
    match(raw_search, '%([^0-9A-Fa-f]|[0-9A-Fa-f][^0-9A-Fa-f]|[0-9A-Fa-f]?$|26|3[Dd]|[01][0-9A-Fa-f]|7[Ff])'), 'token_other',
    match(decoded_search, '(^[?]?|&)grant_type=.*&grant_type='), 'token_other',
    first_grant = 'password', 'password',
    first_grant = 'refresh_token', 'refresh',
    'token_other'
  ) AS kind,
  log_attributes['response.status_code'] AS status,
  multiIf(
    position(log_attributes['request.headers.x_client_info'], 'supabase-js-react-native') > 0, 'phone',
    position(log_attributes['request.headers.x_client_info'], 'createServerClient') > 0, 'server',
    position(log_attributes['request.headers.x_client_info'], 'runtime=node') > 0, 'server',
    position(log_attributes['request.headers.x_client_info'], 'createBrowserClient') > 0, 'browser',
    log_attributes['request.headers.x_client_info'] = '', 'none',
    'other'
  ) AS caller,
  if(startsWith(log_attributes['request.cf.asOrganization'], hosting_owner_prefix), 'hosting', 'other') AS network,
  if(match(log_attributes['request.cf.country'], '^[A-Z]{2}$') AND log_attributes['request.cf.country'] != 'XX', log_attributes['request.cf.country'], '') AS country,
  count() AS n
FROM logs
WHERE source = 'edge_logs'
  AND log_attributes['request.method'] = 'POST'
  AND match(log_attributes['response.status_code'], '^4[0-9][0-9]$')
  AND (decoded_path = '/auth/v1/token' OR match(decoded_path, '^/auth/v1/factors/[^/]+/verify$'))
  AND kind IN ('password', 'verify')
GROUP BY minute, kind, status, caller, network, country
ORDER BY n DESC, minute, kind, status, caller, network, country
LIMIT 199`;

/**
 * Every refused line of the same hour, of every kind, by kind, status, caller
 * class and network class only, with the first and last instant of each
 * group: the log line's counts, the unusual-form count and, when the groups
 * query was full, what it did not list.
 */
export const AUTH_LOGS_TOTALS_SQL = `WITH
  /* The hosting of our own server, measured on 2026-11-21 from 24 hours of gateway lines: every
     line with the client string of our own server came from a network owner whose name starts
     with this, and no line of the phone app or of a browser did. */
  'Amazon' AS hosting_owner_prefix,
  log_attributes['request.path'] AS raw_path,
  decodeURLComponent(raw_path) AS decoded_path,
  log_attributes['request.search'] AS raw_search,
  decodeURLComponent(raw_search) AS decoded_search,
  extract(decoded_search, '(?:^[?]?|&)grant_type=([^&]*)') AS first_grant
SELECT
  multiIf(
    match(raw_path, '^/auth/v1/factors/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/verify$'), 'verify',
    decoded_path != '/auth/v1/token', 'verify_other',
    raw_path != '/auth/v1/token', 'token_other',
    match(raw_search, '%([^0-9A-Fa-f]|[0-9A-Fa-f][^0-9A-Fa-f]|[0-9A-Fa-f]?$|26|3[Dd]|[01][0-9A-Fa-f]|7[Ff])'), 'token_other',
    match(decoded_search, '(^[?]?|&)grant_type=.*&grant_type='), 'token_other',
    first_grant = 'password', 'password',
    first_grant = 'refresh_token', 'refresh',
    'token_other'
  ) AS kind,
  log_attributes['response.status_code'] AS status,
  multiIf(
    position(log_attributes['request.headers.x_client_info'], 'supabase-js-react-native') > 0, 'phone',
    position(log_attributes['request.headers.x_client_info'], 'createServerClient') > 0, 'server',
    position(log_attributes['request.headers.x_client_info'], 'runtime=node') > 0, 'server',
    position(log_attributes['request.headers.x_client_info'], 'createBrowserClient') > 0, 'browser',
    log_attributes['request.headers.x_client_info'] = '', 'none',
    'other'
  ) AS caller,
  if(startsWith(log_attributes['request.cf.asOrganization'], hosting_owner_prefix), 'hosting', 'other') AS network,
  toString(min(timestamp)) AS first_seen,
  toString(max(timestamp)) AS last_seen,
  count() AS n
FROM logs
WHERE source = 'edge_logs'
  AND log_attributes['request.method'] = 'POST'
  AND match(log_attributes['response.status_code'], '^4[0-9][0-9]$')
  AND (decoded_path = '/auth/v1/token' OR match(decoded_path, '^/auth/v1/factors/[^/]+/verify$'))
GROUP BY kind, status, caller, network
ORDER BY n DESC, kind, status, caller, network
LIMIT 199`;

// ── Types ───────────────────────────────────────────────────────────────────

/** One UTC hour: [startMs, endMs). */
export interface AuthLogsHour {
  startMs: number;
  endMs: number;
}

/** What a log line is described by, for the mapping. */
export interface AuthLogsLine {
  kind: AuthLogsKind;
  status: string;
  caller: AuthLogsCaller;
  /** `hosting` only when the query said exactly that; anything else is `other`. */
  network: AuthLogsNetwork;
}

/** One checked row of the groups query. */
export interface AuthLogsGroupRow extends AuthLogsLine {
  minuteMs: number;
  /** Two capital letters, or '' when not known. */
  country: string;
  n: number;
}

/** One checked row of the totals query. */
export interface AuthLogsTotalsRow extends AuthLogsLine {
  n: number;
}

export type AuthLogsNotStored = 'our_server' | 'other_status' | 'refresh' | 'unclassified';

export type AuthLogsVerdict =
  | {
      store: true;
      category: 'password_guessing' | 'bots';
      reason: 'wrong_password' | 'wrong_code' | 'auth_rate_limited';
      source: AuthLogsSource;
    }
  | { store: false; why: AuthLogsNotStored };

/** One element of record_security_events' array, as this job sends it. */
export interface AuthLogsElement {
  category: 'password_guessing' | 'bots';
  /** `flagged` only on the count of requests of an unusual form. */
  outcome: 'blocked' | 'flagged';
  reason: AuthLogsReason;
  source: AuthLogsSource;
  count: number;
  /** The minute, in ms since 1970. */
  at_ms: number;
  /** Present only when known. */
  country?: string;
}

export type AuthLogsFailureCause =
  | 'token_refused'
  | 'logs_query_error'
  | 'logs_unavailable'
  | 'logs_timeout'
  | 'logs_unreachable'
  | 'logs_bad_answer'
  | 'db_read_failed'
  | 'writer_failed'
  | 'out_of_time'
  | 'unexpected';

interface AuthLogsFailure {
  cause: AuthLogsFailureCause;
  status?: number;
  code?: string;
}

export interface AuthLogsHourReport {
  /** The hour's start, e.g. 2026-11-21T04:00Z. */
  hour: string;
  outcome: 'stored' | 'already_stored' | 'nothing_to_store' | 'failed' | 'not_tried';
  /** Events stored for the hour by this run. */
  events: number;
}

/** What a run did, in counts and codes only: the route's answer and its one log line. */
export interface AuthLogsRunSummary {
  ok: boolean;
  hours: AuthLogsHourReport[];
  /** Hours whose logs were read. */
  hoursRead: number;
  /** Hours skipped because they were already stored. */
  hoursSkipped: number;
  hoursStored: number;
  /** Group rows that passed the checks. */
  groups: number;
  /** Rows (of either query) dropped by the checks. */
  dropped: number;
  /** Hours whose groups query was full (199 rows). */
  capped: number;
  /** Hours whose totals query was full too: their counts and remainder are undercounts. */
  totalsCapped: number;
  /** Full hours given no remainder because a group row was dropped. */
  remainderSkipped: number;
  /** Elements sent to the writer. */
  elements: number;
  /** Events in them. */
  eventsStored: number;
  /** Elements whose count was cut to AUTH_LOGS_MAX_COUNT. */
  clamped: number;
  /** Lines not stored one by one, by why (the unusual-form ones may be in a flagged count). */
  notStored: Record<AuthLogsNotStored, number>;
  /** Hours that stored one flagged count of requests of an unusual form. */
  flaggedHours: number;
  /** `<kind> <status> <caller> <network>` -> lines, for the hours read. */
  seen: Record<string, number>;
  /** Lines of the kinds past AUTH_LOGS_SEEN_LIMIT. */
  seenOther: number;
  /** Stored hours the check could not find afterwards (past the writer's minute caps). */
  landedPastMinuteCaps: number;
  failure: (AuthLogsFailure & { hour?: string }) | null;
}

export interface AuthLogsSkipped {
  skipped: 'no_project' | 'token_unusable';
}

// ── Pure parts ──────────────────────────────────────────────────────────────

const PROJECT_REF_RE = /^[a-z0-9]{8,40}$/;

/**
 * The Supabase project ref named by the Supabase URL setting: the first
 * label of `https://<ref>.supabase.co`, or null for anything else (the lab's
 * local address, a custom domain, another port, user info).
 */
export function supabaseProjectRef(url: unknown): string | null {
  if (typeof url !== 'string' || url.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.port !== '' ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    return null;
  }
  const labels = parsed.hostname.split('.');
  if (labels.length !== 3 || labels[1] !== 'supabase' || labels[2] !== 'co') return null;
  const ref = labels[0]!;
  return PROJECT_REF_RE.test(ref) ? ref : null;
}

/** The last AUTH_LOGS_HOURS_PER_RUN complete UTC hours before `nowMs`, oldest first. */
export function hoursToRead(nowMs: number): AuthLogsHour[] {
  const current = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  const hours: AuthLogsHour[] = [];
  for (let back = AUTH_LOGS_HOURS_PER_RUN; back >= 1; back--) {
    const startMs = current - back * HOUR_MS;
    hours.push({ startMs, endMs: startMs + HOUR_MS });
  }
  return hours;
}

/** What a refused line stands for: the event to store, or why it is not stored. */
export function classifyAuthLogLine(line: AuthLogsLine): AuthLogsVerdict {
  // Ours: already recorded by part 1, with the member's real place. Our
  // client string from any other network is someone dressing up as our
  // server, and is read as any other caller (source api).
  if (line.caller === 'server' && line.network === 'hosting') {
    return { store: false, why: 'our_server' };
  }
  const source: AuthLogsSource = line.caller === 'phone' ? 'phone' : 'api';
  switch (line.kind) {
    case 'refresh':
      return { store: false, why: 'refresh' };
    case 'token_other':
    case 'verify_other':
      return { store: false, why: 'unclassified' };
    case 'password':
      if (line.status === '429')
        return { store: true, category: 'bots', reason: 'auth_rate_limited', source };
      if (line.status === '400')
        return { store: true, category: 'password_guessing', reason: 'wrong_password', source };
      return { store: false, why: 'other_status' };
    case 'verify':
      if (line.status === '429')
        return { store: true, category: 'bots', reason: 'auth_rate_limited', source };
      if (line.status === '422')
        return { store: true, category: 'password_guessing', reason: 'wrong_code', source };
      return { store: false, why: 'other_status' };
  }
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw);
}

/** A whole number from 0 up, as a JSON number or a string of at most `digits` digits; else null. */
function wholeNumber(value: unknown, digits: number): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= digits &&
    /^[0-9]+$/.test(value)
  ) {
    return Number(value);
  }
  return null;
}

/**
 * The fields both queries return, checked; null when one fails. The network
 * class is never a reason to drop a row: anything but exactly `hosting` is
 * `other`, so a line is never taken for our own server by mistake.
 */
function lineOf(raw: Record<string, unknown>): AuthLogsLine | null {
  const { kind, status, caller } = raw;
  if (typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind)) return null;
  if (typeof status !== 'string' || !/^[0-9]{3}$/.test(status)) return null;
  if (typeof caller !== 'string' || !(CALLERS as readonly string[]).includes(caller)) return null;
  return {
    kind: kind as AuthLogsKind,
    status,
    caller: caller as AuthLogsCaller,
    network: raw.network === 'hosting' ? 'hosting' : 'other',
  };
}

/** A count: a whole number from 1 up. */
function countOf(value: unknown): number | null {
  const n = wholeNumber(value, 10);
  return n !== null && n >= 1 ? n : null;
}

const LOGS_TIME_RE =
  /^([0-9]{4})-([0-9]{2})-([0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,9}))?$/;

/**
 * A time as the queries print it (toString of a UTC time, e.g.
 * `2026-11-21 18:42:00`, with or without a fraction of a second), read as
 * UTC, in ms (a fraction below a millisecond is dropped). Null for any other
 * form and for a date that does not exist.
 */
export function parseLogsTime(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = LOGS_TIME_RE.exec(value);
  if (!m) return null;
  const [y, mo, d, hh, mi, ss] = m.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const ms = Date.UTC(y, mo - 1, d, hh, mi, ss);
  // Date.UTC carries an impossible date over (2026-11-31 becomes 2026-12-01): refuse it.
  if (
    !Number.isFinite(ms) ||
    new Date(ms).toISOString().slice(0, 19) !== value.slice(0, 19).replace(' ', 'T')
  ) {
    return null;
  }
  return ms + (m[7] ? Math.floor(Number(`0.${m[7]}`) * 1000) : 0);
}

/**
 * One row of the groups query, checked: the minute is a time on a minute
 * inside the hour, the kind and caller are ones the query answers, the status
 * is three digits, the country two capital letters (not XX) or empty, the
 * count a whole number from 1. Null for anything else: the row is dropped.
 */
export function parseGroupRow(raw: unknown, hour: AuthLogsHour): AuthLogsGroupRow | null {
  if (!isRecord(raw)) return null;
  const line = lineOf(raw);
  if (!line) return null;
  const minuteMs = parseLogsTime(raw.minute);
  if (minuteMs === null) return null;
  if (minuteMs % MINUTE_MS !== 0 || minuteMs < hour.startMs || minuteMs >= hour.endMs) return null;
  const country = raw.country;
  if (typeof country !== 'string' || !/^([A-Z]{2})?$/.test(country) || country === 'XX')
    return null;
  const n = countOf(raw.n);
  if (n === null) return null;
  return { minuteMs, ...line, country, n };
}

/** One row of the totals query, checked the same way; its first and last instants inside the hour. */
export function parseTotalsRow(raw: unknown, hour: AuthLogsHour): AuthLogsTotalsRow | null {
  if (!isRecord(raw)) return null;
  const line = lineOf(raw);
  if (!line) return null;
  const first = parseLogsTime(raw.first_seen);
  const last = parseLogsTime(raw.last_seen);
  if (first === null || last === null) return null;
  if (first < hour.startMs || last >= hour.endMs || first > last) return null;
  const n = countOf(raw.n);
  if (n === null) return null;
  return { ...line, n };
}

/** What one hour's rows come to. */
export interface AuthLogsHourElements {
  /** At most AUTH_LOGS_MAX_ELEMENTS, in a fixed order. */
  elements: AuthLogsElement[];
  notStored: Record<AuthLogsNotStored, number>;
  /** `<kind> <status> <caller> <network or ->` -> lines. */
  seen: Record<string, number>;
  /** Elements whose count was cut to AUTH_LOGS_MAX_COUNT. */
  clamped: number;
  /** Events on the auth_log_over_cap elements. */
  remainder: number;
  /** The groups were full but a row was dropped, so no remainder was added. */
  remainderSkipped: boolean;
  /** The count on the flagged element of requests of an unusual form; 0 when there is none. */
  flagged: number;
}

const seenKey = (line: AuthLogsLine) =>
  `${line.kind} ${line.status} ${line.caller} ${line.network}`;

function compareElements(a: AuthLogsElement, b: AuthLogsElement): number {
  const ka = [a.category, a.reason, a.source, a.country ?? ''];
  const kb = [b.category, b.reason, b.source, b.country ?? ''];
  if (a.at_ms !== b.at_ms) return a.at_ms - b.at_ms;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i]! < kb[i]!) return -1;
    if (ka[i]! > kb[i]!) return 1;
  }
  return 0;
}

/**
 * The writer's elements for one hour (pure). Lines that land on the same row
 * are one element. `totals` (every kind of the hour) gives the counts that
 * are not stored, the log line and the count of requests of an unusual form:
 * AUTH_LOGS_UNCLASSIFIED_FLAG_AT or more store one flagged element. When the
 * groups were full (`groupsCapped`), the remainder is counted per category,
 * reason and source (never below zero) and stored on one auth_log_over_cap
 * element per category and source, unless a group row was dropped
 * (`groupsDropped`): its count would come back through the totals. The
 * smallest groups are folded into those elements until the call fits.
 */
export function buildHourElements(input: {
  hour: AuthLogsHour;
  groups: readonly AuthLogsGroupRow[];
  groupsCapped: boolean;
  groupsDropped: number;
  totals: readonly AuthLogsTotalsRow[];
}): AuthLogsHourElements {
  const listed = new Map<string, AuthLogsElement>();
  const listedByKind = new Map<string, number>();

  for (const g of input.groups) {
    const v = classifyAuthLogLine(g);
    if (!v.store) continue;
    const key = [g.minuteMs, v.category, v.reason, v.source, g.country].join('\u001f');
    const same = listed.get(key);
    if (same) {
      same.count += g.n;
    } else {
      listed.set(key, {
        category: v.category,
        outcome: 'blocked',
        reason: v.reason,
        source: v.source,
        count: g.n,
        at_ms: g.minuteMs,
        ...(g.country ? { country: g.country } : {}),
      });
    }
    const kind = [v.category, v.reason, v.source].join('\u001f');
    listedByKind.set(kind, (listedByKind.get(kind) ?? 0) + g.n);
  }

  // The complete counts of the hour, every kind, from the totals: the log
  // line, what is not stored, and the requests of an unusual form (never
  // our own server's: classifyAuthLogLine answers our_server first).
  const notStored: Record<AuthLogsNotStored, number> = {
    our_server: 0,
    other_status: 0,
    refresh: 0,
    unclassified: 0,
  };
  const seen: Record<string, number> = {};
  for (const row of input.totals) {
    const key = seenKey(row);
    seen[key] = (seen[key] ?? 0) + row.n;
    const v = classifyAuthLogLine(row);
    if (!v.store) notStored[v.why] += row.n;
  }
  const flagged =
    notStored.unclassified >= AUTH_LOGS_UNCLASSIFIED_FLAG_AT ? notStored.unclassified : 0;

  // The remainder, one element per category and source.
  const overCap = new Map<string, AuthLogsElement>();
  const countOnOverCap = (
    category: AuthLogsElement['category'],
    source: AuthLogsSource,
    count: number,
  ) => {
    const key = [category, source].join('\u001f');
    const same = overCap.get(key);
    if (same) same.count += count;
    else {
      overCap.set(key, {
        category,
        outcome: 'blocked',
        reason: 'auth_log_over_cap',
        source,
        count,
        at_ms: input.hour.startMs,
      });
    }
  };
  let remainderSkipped = false;
  if (input.groupsCapped) {
    if (input.groupsDropped > 0) {
      remainderSkipped = true;
    } else {
      const totalByKind = new Map<
        string,
        { category: AuthLogsElement['category']; source: AuthLogsSource; n: number }
      >();
      for (const t of input.totals) {
        const v = classifyAuthLogLine(t);
        if (!v.store) continue;
        const kind = [v.category, v.reason, v.source].join('\u001f');
        const same = totalByKind.get(kind);
        if (same) same.n += t.n;
        else totalByKind.set(kind, { category: v.category, source: v.source, n: t.n });
      }
      for (const [kind, total] of totalByKind) {
        const rest = total.n - (listedByKind.get(kind) ?? 0);
        if (rest > 0) countOnOverCap(total.category, total.source, rest);
      }
    }
  }

  // Many requests of an unusual form: one flagged count for the hour, never
  // shown as blocked attacks, with no country (they come from every caller).
  const flaggedElements: AuthLogsElement[] =
    flagged > 0
      ? [
          {
            category: 'password_guessing',
            outcome: 'flagged',
            reason: 'unclassified_sign_in_refusals',
            source: 'api',
            count: flagged,
            at_ms: input.hour.startMs,
          },
        ]
      : [];

  // Fit the call: the smallest listed elements are folded into their remainder element.
  const list = [...listed.values()].sort((a, b) => b.count - a.count || compareElements(a, b));
  while (
    list.length > 0 &&
    list.length + overCap.size + flaggedElements.length > AUTH_LOGS_MAX_ELEMENTS
  ) {
    const smallest = list.pop()!;
    countOnOverCap(smallest.category, smallest.source, smallest.count);
  }

  let clamped = 0;
  const elements = [...list, ...overCap.values(), ...flaggedElements]
    .map((e) => {
      if (e.count <= AUTH_LOGS_MAX_COUNT) return e;
      clamped += 1;
      return { ...e, count: AUTH_LOGS_MAX_COUNT };
    })
    .sort(compareElements);
  const remainder = elements
    .filter((e) => e.reason === 'auth_log_over_cap')
    .reduce((s, e) => s + e.count, 0);
  return { elements, notStored, seen, clamped, remainder, remainderSkipped, flagged };
}

// ── Calls ───────────────────────────────────────────────────────────────────

/** A call that did not answer within its time. */
class CallTimeout extends Error {
  constructor() {
    super('call timed out');
    this.name = 'CallTimeout';
  }
}

/**
 * Runs `start` with a time limit: past `ms` its signal is aborted and the
 * wait here ends with CallTimeout, whether or not the call honours the
 * signal. Neither promise is left to reject unhandled.
 */
async function within<T>(ms: number, start: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new CallTimeout());
    }, ms);
  });
  deadline.catch(() => undefined);
  try {
    const work = start(controller.signal);
    work.catch(() => undefined);
    return await Promise.race([work, deadline]);
  } catch (e) {
    if (controller.signal.aborted) throw new CallTimeout();
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

interface RunContext {
  token: string;
  projectRef: string;
  fetch: typeof fetch;
  /** When the run must end, in ms since 1970. */
  deadline: number;
  admin: () => ReturnType<typeof createAdminClient>;
}

/** The time a call may take: its own limit, or what is left of the run (`cut`); null when too little is left. */
function callLimit(ctx: RunContext, own: number): { ms: number; cut: boolean } | null {
  const left = ctx.deadline - Date.now();
  if (left < MIN_CALL_MS) return null;
  return left < own ? { ms: left, cut: true } : { ms: own, cut: false };
}

const iso = (ms: number) => new Date(ms).toISOString();
/** An hour as the log line names it, e.g. 2026-11-21T04:00Z. */
const hourLabel = (hour: AuthLogsHour) => `${iso(hour.startMs).slice(0, 16)}Z`;

/** A database error's code, as a short code only; never its text. */
function codeOf(error: unknown): string {
  if (error instanceof CallTimeout) return 'timeout';
  const code =
    error && typeof error === 'object' && 'code' in error
      ? (error as { code: unknown }).code
      : null;
  return typeof code === 'string' && /^[A-Za-z0-9_]{1,16}$/.test(code) ? code : 'no_code';
}

type Outcome<T> = { ok: true; value: T } | { ok: false; failure: AuthLogsFailure };

/** A failure from a call that timed out: the run's deadline cut it, or its own limit did. */
const timedOut = (cut: boolean, own: AuthLogsFailure): AuthLogsFailure =>
  cut ? { cause: 'out_of_time' } : own;

/**
 * The rows of a successful logs answer: `{ "result": [...], "error": null }`
 * (an answer with no error field is read the same). The logs service answers
 * a query it did not run with status 200 and an error: that is
 * `query_error`, whatever else the body holds. Anything else that is not a
 * result list is null. The error's own text is never read.
 */
function rowsOf(text: string): unknown[] | 'query_error' | null {
  if (text.length > MAX_ANSWER_CHARS) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.error !== undefined && parsed.error !== null) return 'query_error';
  if (!Array.isArray(parsed.result) || parsed.result.length > AUTH_LOGS_ROW_LIMIT) return null;
  return parsed.result;
}

/**
 * One query to the logs endpoint for one hour: one try, AUTH_LOGS_CALL_TIMEOUT_MS
 * at most. The token goes in the Authorization header and nowhere else; a
 * redirect is refused, so it can never be sent on to another host. An answer
 * that is not a success is never read.
 */
async function queryLogs(
  ctx: RunContext,
  sql: string,
  hour: AuthLogsHour,
): Promise<Outcome<unknown[]>> {
  const limit = callLimit(ctx, AUTH_LOGS_CALL_TIMEOUT_MS);
  if (!limit) return { ok: false, failure: { cause: 'out_of_time' } };
  const params = new URLSearchParams({
    sql,
    iso_timestamp_start: iso(hour.startMs),
    iso_timestamp_end: iso(hour.endMs),
  });
  const url = `${AUTH_LOGS_API_ORIGIN}/v1/projects/${ctx.projectRef}/analytics/endpoints/logs?${params.toString()}`;
  try {
    return await within(limit.ms, async (signal): Promise<Outcome<unknown[]>> => {
      const res = await ctx.fetch(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${ctx.token}`, accept: 'application/json' },
        redirect: 'error',
        cache: 'no-store',
        signal,
      });
      if (!res.ok) {
        try {
          await res.body?.cancel();
        } catch {
          // Nothing to do: the body is not read either way.
        }
        const refused = res.status === 401 || res.status === 403;
        return {
          ok: false,
          failure: { cause: refused ? 'token_refused' : 'logs_unavailable', status: res.status },
        };
      }
      const rows = rowsOf(await res.text());
      if (rows === 'query_error') return { ok: false, failure: { cause: 'logs_query_error' } };
      return rows
        ? { ok: true, value: rows }
        : { ok: false, failure: { cause: 'logs_bad_answer' } };
    });
  } catch (e) {
    if (e instanceof CallTimeout)
      return { ok: false, failure: timedOut(limit.cut, { cause: 'logs_timeout' }) };
    // The error's own text is never used: it could carry a header value.
    return { ok: false, failure: { cause: 'logs_unreachable' } };
  }
}

/**
 * Whether the hour already holds a row only this job writes: no
 * organization, source phone or api, one of AUTH_LOGS_REASONS, a minute
 * inside the hour. One service-role read of one id.
 */
async function alreadyStored(ctx: RunContext, hour: AuthLogsHour): Promise<Outcome<boolean>> {
  const limit = callLimit(ctx, AUTH_LOGS_DB_TIMEOUT_MS);
  if (!limit) return { ok: false, failure: { cause: 'out_of_time' } };
  try {
    const { data, error } = await within(limit.ms, (signal) =>
      Promise.resolve(
        ctx
          .admin()
          .from('security_events')
          .select('id')
          .is('organization_id', null)
          .in('source', AUTH_LOGS_SOURCES)
          .in('reason', AUTH_LOGS_REASONS)
          .gte('minute', iso(hour.startMs))
          .lt('minute', iso(hour.endMs))
          .limit(1)
          .abortSignal(signal),
      ),
    );
    if (error) return { ok: false, failure: { cause: 'db_read_failed', code: codeOf(error) } };
    if (!Array.isArray(data))
      return { ok: false, failure: { cause: 'db_read_failed', code: 'no_rows' } };
    return { ok: true, value: data.length > 0 };
  } catch (e) {
    if (e instanceof CallTimeout) {
      return {
        ok: false,
        failure: timedOut(limit.cut, { cause: 'db_read_failed', code: 'timeout' }),
      };
    }
    return { ok: false, failure: { cause: 'db_read_failed', code: codeOf(e) } };
  }
}

/** One writer call with every element of the hour: stored whole or not at all. */
async function writeHour(ctx: RunContext, elements: AuthLogsElement[]): Promise<Outcome<null>> {
  const limit = callLimit(ctx, AUTH_LOGS_DB_TIMEOUT_MS);
  if (!limit) return { ok: false, failure: { cause: 'out_of_time' } };
  try {
    const { error } = await within(limit.ms, (signal) =>
      Promise.resolve(
        ctx.admin().rpc('record_security_events', { p_events: elements }).abortSignal(signal),
      ),
    );
    if (error) return { ok: false, failure: { cause: 'writer_failed', code: codeOf(error) } };
    return { ok: true, value: null };
  } catch (e) {
    if (e instanceof CallTimeout) {
      return {
        ok: false,
        failure: timedOut(limit.cut, { cause: 'writer_failed', code: 'timeout' }),
      };
    }
    return { ok: false, failure: { cause: 'writer_failed', code: codeOf(e) } };
  }
}

// ── The run ─────────────────────────────────────────────────────────────────

function emptySummary(hours: AuthLogsHour[]): AuthLogsRunSummary {
  return {
    ok: true,
    hours: hours.map((hour) => ({ hour: hourLabel(hour), outcome: 'not_tried', events: 0 })),
    hoursRead: 0,
    hoursSkipped: 0,
    hoursStored: 0,
    groups: 0,
    dropped: 0,
    capped: 0,
    totalsCapped: 0,
    remainderSkipped: 0,
    elements: 0,
    eventsStored: 0,
    clamped: 0,
    notStored: { our_server: 0, other_status: 0, refresh: 0, unclassified: 0 },
    flaggedHours: 0,
    seen: {},
    seenOther: 0,
    landedPastMinuteCaps: 0,
    failure: null,
  };
}

/** Reads, maps and stores one hour. Null when done (stored, already stored or nothing to store). */
async function runHour(
  ctx: RunContext,
  hour: AuthLogsHour,
  report: AuthLogsHourReport,
  summary: AuthLogsRunSummary,
): Promise<AuthLogsFailure | null> {
  const stored = await alreadyStored(ctx, hour);
  if (!stored.ok) return stored.failure;
  if (stored.value) {
    report.outcome = 'already_stored';
    summary.hoursSkipped += 1;
    return null;
  }

  const groupsAnswer = await queryLogs(ctx, AUTH_LOGS_GROUPS_SQL, hour);
  if (!groupsAnswer.ok) return groupsAnswer.failure;
  const groups: AuthLogsGroupRow[] = [];
  let dropped = 0;
  for (const raw of groupsAnswer.value) {
    const row = parseGroupRow(raw, hour);
    if (row) groups.push(row);
    else dropped += 1;
  }
  const groupsDropped = dropped;
  const capped = groupsAnswer.value.length >= AUTH_LOGS_ROW_LIMIT;

  // Every kind of the hour: always read (the log line, refreshes, the
  // unusual-form count, and the remainder when the groups were full).
  const totalsAnswer = await queryLogs(ctx, AUTH_LOGS_TOTALS_SQL, hour);
  if (!totalsAnswer.ok) return totalsAnswer.failure;
  const totals: AuthLogsTotalsRow[] = [];
  for (const raw of totalsAnswer.value) {
    const row = parseTotalsRow(raw, hour);
    if (row) totals.push(row);
    else dropped += 1;
  }
  if (totalsAnswer.value.length >= AUTH_LOGS_ROW_LIMIT) summary.totalsCapped += 1;
  if (capped) summary.capped += 1;
  summary.hoursRead += 1;
  summary.groups += groups.length;
  summary.dropped += dropped;

  const built = buildHourElements({
    hour,
    groups,
    groupsCapped: capped,
    groupsDropped,
    totals,
  });
  for (const why of Object.keys(built.notStored) as AuthLogsNotStored[])
    summary.notStored[why] += built.notStored[why];
  for (const [key, n] of Object.entries(built.seen)) {
    const listedAlready = Object.prototype.hasOwnProperty.call(summary.seen, key);
    if (listedAlready || Object.keys(summary.seen).length < AUTH_LOGS_SEEN_LIMIT) {
      summary.seen[key] = (summary.seen[key] ?? 0) + n;
    } else {
      summary.seenOther += n;
    }
  }
  summary.clamped += built.clamped;
  if (built.remainderSkipped) summary.remainderSkipped += 1;
  if (built.flagged > 0) summary.flaggedHours += 1;

  if (built.elements.length === 0) {
    report.outcome = 'nothing_to_store';
    return null;
  }

  const written = await writeHour(ctx, built.elements);
  if (!written.ok) return written.failure;
  const events = built.elements.reduce((s, e) => s + e.count, 0);
  report.outcome = 'stored';
  report.events = events;
  summary.hoursStored += 1;
  summary.elements += built.elements.length;
  summary.eventsStored += events;

  // The check must find the hour from now on. It cannot when every element
  // landed past the writer's minute caps (stored as over_minute_cap rows);
  // a later run would then store the hour again. Said, not hidden. A read
  // that fails here changes nothing: the hour is stored.
  const after = await alreadyStored(ctx, hour);
  if (after.ok && !after.value) summary.landedPastMinuteCaps += 1;
  return null;
}

const FAILURE_WORDS: Record<AuthLogsFailureCause, (f: AuthLogsFailure) => string> = {
  token_refused: () =>
    "Refused sign-ins were not read from Supabase's logs: the logs token was refused (expired or deleted): the owner makes a new one",
  logs_query_error: () =>
    "Supabase's logs did not run this job's query (it answered with an error); the hour is left for the next run",
  logs_unavailable: (f) =>
    `Supabase's logs could not be read (status ${f.status ?? 'unknown'}); the hour is left for the next run`,
  logs_timeout: () =>
    "Supabase's logs did not answer within 20 seconds; the hour is left for the next run",
  logs_unreachable: () => "Supabase's logs could not be reached; the hour is left for the next run",
  logs_bad_answer: () =>
    "Supabase's logs answered in a shape this job does not read; the hour is left for the next run",
  db_read_failed: (f) =>
    `The security events record could not be read (code ${f.code ?? 'no_code'}); the hour is left for the next run`,
  writer_failed: (f) =>
    `The refused sign-ins of an hour could not be stored (code ${f.code ?? 'no_code'}); the hour is left for the next run`,
  out_of_time: () =>
    "Reading refused sign-ins from Supabase's logs stopped at its time limit; the hours left are read by the next run",
  unexpected: () =>
    "Reading refused sign-ins from Supabase's logs failed unexpectedly; the next run tries again",
};

async function report(
  message: string,
  level: 'error' | 'warning',
  extra: Record<string, string | number>,
) {
  // reportError never throws; awaited so the report is sent before the answer.
  await reportError(new Error(message), { tag: AUTH_LOGS_TAG, level, extra });
}

/** A token that can be sent as a header value: visible ASCII, no space. */
const HEADER_SAFE_RE = /^[\x21-\x7e]{1,1024}$/;

/**
 * One run: the last six complete UTC hours, oldest first, each read and
 * stored once. Never throws. Answers counts and codes only (the route's
 * answer and its log line), or why nothing was read.
 */
export async function readAuthLogs(options: {
  token: string;
  supabaseUrl: string;
  nowMs?: number;
  fetch?: typeof fetch;
}): Promise<AuthLogsRunSummary | AuthLogsSkipped> {
  const projectRef = supabaseProjectRef(options.supabaseUrl);
  if (!projectRef) {
    await report(
      "The Supabase URL setting names no project, so refused sign-ins are not read from Supabase's logs",
      'warning',
      { cause: 'no_project' },
    );
    return { skipped: 'no_project' };
  }
  if (typeof options.token !== 'string' || !HEADER_SAFE_RE.test(options.token)) {
    await report(
      'The Supabase logs token setting cannot be sent (it holds a space or a control character), so refused sign-ins are not read',
      'warning',
      { cause: 'token_unusable' },
    );
    return { skipped: 'token_unusable' };
  }

  const started = Date.now();
  const hours = hoursToRead(options.nowMs ?? started);
  const summary = emptySummary(hours);
  let admin: ReturnType<typeof createAdminClient> | null = null;
  const ctx: RunContext = {
    token: options.token,
    projectRef,
    fetch: options.fetch ?? fetch,
    deadline: started + AUTH_LOGS_RUN_DEADLINE_MS,
    admin: () => (admin ??= createAdminClient()),
  };

  for (const [i, hour] of hours.entries()) {
    const hourReport = summary.hours[i]!;
    let failure: AuthLogsFailure | null;
    try {
      failure = await runHour(ctx, hour, hourReport, summary);
    } catch (e) {
      failure = {
        cause: 'unexpected',
        code: e instanceof Error ? codeOf({ code: e.name }) : 'no_code',
      };
    }
    if (failure) {
      hourReport.outcome = 'failed';
      summary.ok = false;
      summary.failure = { ...failure, hour: hourLabel(hour) };
      break;
    }
  }

  if (summary.failure) {
    const { cause, status, code, hour } = summary.failure;
    await report(
      FAILURE_WORDS[cause](summary.failure),
      // Both need someone to act: a new token, or a fix to the query.
      cause === 'token_refused' || cause === 'logs_query_error' ? 'error' : 'warning',
      {
        cause,
        ...(status !== undefined ? { status } : {}),
        ...(code !== undefined ? { code } : {}),
        ...(hour !== undefined ? { hour } : {}),
        hoursStored: summary.hoursStored,
      },
    );
  }
  if (summary.landedPastMinuteCaps > 0) {
    await report(
      'The refused sign-ins of an hour landed past the minute caps of the security events record; later runs may store that hour again',
      'warning',
      { cause: 'landed_past_minute_caps', hours: summary.landedPastMinuteCaps },
    );
  }
  return summary;
}
