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
 * record_security_events. No refusal it reads is ever invisible: what is not
 * stored one by one is counted in the run's log line, and what it cannot
 * account for is stored as a flagged count.
 *
 * WHAT LEAVES SUPABASE. Two constant queries (AUTH_LOGS_GROUPS_SQL and
 * AUTH_LOGS_TOTALS_SQL) answer, for each group of lines: the minute, the kind
 * of request, whether any of its lines was of an ambiguous form (several
 * grant_type values, a repeated slash), the status's class (400, 404, 422,
 * 429, or `other` for every other refused status), the caller's class (the
 * client string reduced INSIDE the query to phone, server or other), the
 * network's class (hosting or other, worked out inside the query from the
 * network owner's name, which never leaves), the
 * country (two capital letters, or empty) and a count. Never an address, an
 * email, an account, a path, a query string, an id, the client string itself
 * or a raw log line. The hour travels in the two timestamp parameters;
 * nothing is ever put into the SQL text. Every field that comes back is
 * checked before use (parseGroupRow, parseTotalsRow); a row that fails is
 * dropped and counted in the run's log line, and a dropped row of the totals
 * also marks the hour as not whole (below).
 *
 * WHICH LINES ARE READ: A LOOSE NET. Every refused POST whose path, decoded
 * and in small letters, HOLDS `auth` and one of `token`, `factors` or
 * `verify`, wherever they stand. That takes in every path that starts as
 * `/auth/v1/token`, `/auth/v1/factors` or `/auth/v1/verify` does, and every
 * other spelling of them: dot segments, another separator, an encoded letter
 * or slash, a parameter, a byte after the word. The net is wide on purpose,
 * and it is a search for the words' bytes, not a pattern, so no byte of a
 * path can end it early: whatever spelling the gateway might route, the line
 * is read, and what is not an exact form below is an unknown form.
 *
 * THE KIND is read the way the request is routed and the way the sign-in
 * service reads it. The exact forms are compared with the path AS SENT, its
 * repeated slashes as one and its case kept: measured on 2026-11-21, the
 * gateway routes `/auth/v1//token` to the same password check as
 * `/auth/v1/token` (and logs the path as sent), and answers 404 for a
 * trailing slash, capitals or an encoded letter. Such a line with a repeated
 * slash is classed exactly as the plain path is, and counted in the log line
 * as of an ambiguous form.
 *   - `/auth/v1/token`: by the FIRST decoded grant_type of the query string
 *     (the value the service acts on; the whole query string is decoded
 *     first, so a grant whose name is encoded is read as the service reads
 *     it). `password` and `refresh_token` (an ordinary expired session) are
 *     named; the other grants Supabase Auth knows (pkce, id_token, web3) are
 *     `token_known_other`; anything else (no grant, an empty or unknown one,
 *     a query string that does not decode the way the service decodes it) is
 *     `token_other`. So is a query string that holds a raw semicolon
 *     anywhere: measured on 2026-11-21, the service drops a pair with one
 *     and acts on the next grant_type, so the first grant read here would
 *     not be the one it acted on. Several grant_type values are counted in
 *     the log line as of an ambiguous form. Only the query string is read:
 *     a grant in a form body cannot carry a password check (measured on
 *     2026-11-21: the body must be JSON, and the grant of the address wins
 *     over one inside a JSON body).
 *   - `/auth/v1/factors/<id>/verify` with a well-formed id: `verify`, a code
 *     check. `/auth/v1/factors` (enrolling a factor) and
 *     `/auth/v1/factors/<id>/challenge` (asking for a challenge) check no
 *     secret: `factors_known_other`. The id never leaves the query.
 *   - `/auth/v1/verify`: `emailed_code`, a check of an emailed code or link.
 *     A wrong emailed code is answered 403 (measured 2026-11-21: 403;
 *     counted, not stored, until our own server's emailed-code refusals are
 *     recorded). Our own server checks emailed codes there too and records
 *     nothing for a refusal, so storing these would first need its lines
 *     told apart and compared, as passwords and authenticator codes are.
 *     Until then every refusal there is COUNTED in the log line (by caller
 *     class; a 403 is in the status class `other`), NOT STORED.
 *   - anything else in the net is an unknown form: `verify_other` (the
 *     path holds `factors`), `emailed_code_other` (it holds `verify`) or
 *     `token_other`.
 *
 * WHAT IS STORED (classifyAuthLogLine, buildHourElements):
 *   - a password sign-in answered 400: password_guessing / wrong_password;
 *   - a code check answered 422: password_guessing / wrong_code;
 *   - either answered 429, Supabase's own limit: bots / auth_rate_limited;
 *   - any other status of those two is counted in the log line and not
 *     stored: a status whose meaning is not known is not shown as an attack;
 *   - refreshes, the other known grants, factor enrolments, challenge
 *     requests and checks of an emailed code are counted, not stored;
 *   - requests of an unknown form, even one, are stored as ONE flagged count
 *     per source for the hour (unclassified_sign_in_refusals), never taken
 *     for our own server. The one exception: an unknown form answered 404
 *     was routed nowhere, so nothing was checked; it is counted in the log
 *     line (not_routed) and neither stored nor flagged.
 *   The source is phone for the phone app's client string and api for
 *   everything else (a browser, anything unknown, none). Every element has no
 *   organization (the line names no account), no city and no source hash.
 *
 * OUR OWN SERVER is one of its two exact client strings (matched whole,
 * inside the query) AND a hosting network. Its lines are not stored one by
 * one: part 1 recorded those refusals already, with the member's real place.
 * THAT PAIR IS NOT PROOF OF ORIGIN. The client string is a header anyone can
 * send, and the hosting network is one anyone can rent a machine on. The
 * pair only decides WHICH lines are compared with our own record instead of
 * being stored one by one; it never makes a line trusted. What makes that
 * safe is the comparison: the refused passwords (400) and codes (422) of
 * the hour in that form are RECONCILED with what our own server
 * recorded for that hour (source web; readRecorded reads it, however many
 * rows it is): when the gateway holds AUTH_LOGS_UNRECORDED_FLAG_AT or more
 * that our server has no record of, the excess is stored as a flagged count
 * (unrecorded_server_form_password or _code). Our server records a refusal
 * for every password and every code it sends there, so the expected excess
 * is zero and the threshold is small. Only rows whose reason names a refused
 * password or code count as recorded; overflow rows cover nothing. A
 * current-password check the phone app asks for through our API is our
 * server's too: its refusals are recorded with the phone as their source,
 * and those rows, and no other phone row, are counted.
 * AT AN HOUR'S EDGE the gateway stamps a refusal in one hour and our server
 * records it in the next. Before an hour is flagged, its excess is reduced
 * by a carry: at most what our server recorded in the first minute of the
 * next hour, and at most what that hour's record holds beyond its own
 * gateway count, so one recorded row never covers two refusals
 * (hourEdgeCarry). The newest hour, when it would be flagged, waits one run
 * for the hour after it to be complete, with nothing written (totals of it
 * that were not whole are reported at once, by the run that saw them).
 * Our client strings from any other network, or any string that only
 * contains their words, are not ours, and are stored as api. A network class
 * that is not exactly `hosting` is `other` (fail closed), and the queries
 * answer `hosting` for our server's client string alone. In the groups
 * query our own server's lines are left out, so they take no row of its
 * limit from other callers; the totals query counts them.
 *
 * AN HOUR IS WRITTEN ONCE (the writer ADDS on a repeat). Each run handles the
 * last six complete UTC hours, oldest first, so a missed run heals. An hour
 * that already holds a row only this job writes (no organization, source
 * phone or api, a reason in AUTH_LOGS_REASONS: auth-logs.guard.test.ts pins
 * that no other code writes one) is skipped; an hour's elements go in ONE
 * writer call, so an hour is stored whole or not at all; an hour with
 * nothing to store is read again by the next run, and so is an hour whose
 * reconciliation could not be read. The check is made a second time right
 * before the write, so a run that overlaps another leaves alone an hour the
 * other has just stored (runHour says what gap remains). If every element
 * of an hour lands past the writer's per-minute caps (it then stores them as
 * over_minute_cap rows, which the check does not read), the check cannot see
 * the hour, and that is reported. The writer's own count of what it stored
 * is read, and a count below what was sent is reported.
 *
 * TWO QUERIES AN HOUR. The groups query lists the lines that can be stored
 * (a password answered 400 or 429, a code check answered 422 or 429) by
 * minute and country, at most AUTH_LOGS_ROW_LIMIT groups, largest first.
 * The totals query counts every kind by kind, status class, caller class and network
 * class only: it gives the log line, the flagged counts, our server's counts
 * and, when the groups query was full, the rest. THE TOTALS CANNOT BE
 * FILLED BY A CALLER: every class it is grouped by is a short list written
 * in the query (nine kinds, five status classes, four pairs of caller and
 * network), so it answers at most 180 rows, below its limit. Nothing a
 * caller chooses (a status it provokes, a client string, a network, the
 * form of the request) opens a row beyond those. What the groups did not
 * list is stored on one
 * auth_log_over_cap element per category and source (a reason no other code
 * writes), at the hour's first minute, with no country; the smallest groups
 * are folded into those elements until the call holds at most
 * AUTH_LOGS_MAX_ELEMENTS.
 *
 * TOTALS THAT ARE NOT WHOLE ARE NEVER STORED AS IF THEY WERE. If the totals
 * answer is full all the same, or a row of it fails its checks, the rows
 * that are missing can be the ones a flagged count is made from. The hour
 * is then stored with ONE flagged count of its own (too_many_forms_to_count:
 * refused sign-in requests in an hour that could not all be counted; source
 * api; its number is the refused requests of the hour that WERE counted, of
 * every kind), its lines in our server's form are compared with the part
 * that was read, and the run reports it once.
 *
 * A FLAGGED COUNT IS REPORTED AS WELL AS STORED. The rows this job stores
 * have no organization, so they are on no organization's Blocked activity
 * page, only on the platform console's Security page (the newest entries of
 * every organization and none). Whenever a run stores a flagged element (requests of an unknown
 * form, refusals in our server's form that our server has no record of,
 * totals that were not whole) it sends one warning with the events by
 * reason. A run that stores only ordinary counts reports nothing.
 *
 * THE HOUR'S END. A line stamped on the very instant an hour ends belongs to
 * the next hour. Whether the logs service answers it for the hour that ends
 * there is not relied on. If it does: a totals row whose last line is on
 * that instant is kept, its count as it is (one line more in an hour is the
 * safe direction; such a line can never take a row away), and a group row
 * on that minute is left to the next hour's own run, which lists it.
 *
 * FAILURES. A failed hour is left for the next run, and the hours after it
 * are still tried, so one bad hour does not hold up the newer ones. The run
 * stops only at a failure every hour would meet (a refused token, a query
 * the logs service did not run, a service that cannot be reached) or at its
 * deadline. Each distinct failure is reported once per run, in plain words
 * with a status or a code and the number of hours it stopped: a refused
 * token (401 or 403: the owner makes a new one), a query the logs service
 * did not run (it answers 200 with an error), a logs answer that is late
 * (20 s), refused (another status), too large or not readable, a read or a
 * write of the record that failed. The run has a deadline
 * (AUTH_LOGS_RUN_DEADLINE_MS) inside the route's 60 s limit; a run that
 * reaches it stops and says so once. The reports are sent together and
 * waited for AUTH_LOGS_REPORTS_MAX_MS at most.
 *
 * THE TOKEN (SUPABASE_LOGS_READ_TOKEN, which the route reads through the env
 * module and hands in) is sent only as the Authorization header of a GET to
 * AUTH_LOGS_API_ORIGIN, with redirects refused. It is never logged, never put
 * in a report and never returned. An answer that is not a success is never
 * read, a successful one is read up to a size limit, and no error's own text
 * is ever passed on: a failure is described by this module's words, a status
 * and a code.
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
/** Requests of an unknown form in one hour (per source) from which a flagged count is stored: any. */
export const AUTH_LOGS_UNCLASSIFIED_FLAG_AT = 1;
/**
 * Refusals of our server's form in one hour (per kind) that our server has
 * no record of, from which a flagged count is stored. Our own server records
 * a refusal for every password and every code it sends to the sign-in
 * service (the reasons listed at RECORDED_PASSWORD_REASONS below), so the
 * expected number is zero. One or two can still be missing with nobody at
 * fault: a server instance that stopped before its record was saved, or a
 * code check the service answered 422 without judging the code (a challenge
 * that had expired). Those must not raise a flag; three do. A refusal on
 * one side of an hour's edge and recorded on the other is not one of them:
 * it is carried (hourEdgeCarry), so it neither raises a flag nor uses up
 * this allowance.
 */
export const AUTH_LOGS_UNRECORDED_FLAG_AT = 3;
/** Rows of our own record one page of the reconciliation read asks for. */
export const AUTH_LOGS_RECONCILE_PAGE_ROWS = 1000;
/**
 * Pages the reconciliation read takes for one hour, at most. An hour with
 * more rows is compared with the rows that were read (see readRecorded).
 */
export const AUTH_LOGS_RECONCILE_MAX_PAGES = 10;
/** One logs call: one try, this long at most. */
export const AUTH_LOGS_CALL_TIMEOUT_MS = 20_000;
/** One read or write of the record, this long at most (the writer waits 2 s for its turn). */
export const AUTH_LOGS_DB_TIMEOUT_MS = 5_000;
/** A run starts no call after this long, and cuts any call at it (the route allows 60 s). */
export const AUTH_LOGS_RUN_DEADLINE_MS = 50_000;
/**
 * How long a run waits for its reports, all sent at once, before it answers
 * anyway. With the deadline above, a run ends inside 54 s of the route's 60.
 */
export const AUTH_LOGS_REPORTS_MAX_MS = 4_000;
/** A call is not started with less time than this left. */
const MIN_CALL_MS = 1_000;
/** Distinct (kind, status, caller, network) counts the log line lists; the rest are summed. */
export const AUTH_LOGS_SEEN_LIMIT = 40;
/** A logs answer longer than this many bytes is not read (199 small rows are a few tens of thousands). */
const MAX_ANSWER_BYTES = 2_000_000;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** Every reason this job writes. No other code may write one with source phone or api. */
export const AUTH_LOGS_REASONS = [
  'wrong_password',
  'wrong_code',
  'auth_rate_limited',
  'auth_log_over_cap',
  'unclassified_sign_in_refusals',
  'unrecorded_server_form_password',
  'unrecorded_server_form_code',
  'too_many_forms_to_count',
] as const;
export type AuthLogsReason = (typeof AUTH_LOGS_REASONS)[number];

/** Every source this job writes. */
export const AUTH_LOGS_SOURCES = ['phone', 'api'] as const;
export type AuthLogsSource = (typeof AUTH_LOGS_SOURCES)[number];

/**
 * What our own server records for a refusal that reached Supabase from it
 * (server/security/account-events.ts and its callers, through the writer's
 * repeats rule). Every password or code our server sends there and Supabase
 * refuses has one of these reasons:
 *   - a sign-in password Supabase judged wrong (its 400): wrong_password,
 *     or repeated_wrong_password once the same source has five in ten
 *     minutes;
 *   - a signed-in member's current password judged wrong, asked again
 *     before a sensitive change (lib/auth/verify-password.ts):
 *     wrong_current_password;
 *   - a password sign-in refused with the same status for another reason (a
 *     disabled account, an unconfirmed email): sign_in_refused_other;
 *   - a refused authenticator code (its 422): wrong_code or
 *     repeated_wrong_code;
 *   - a refused first code while an authenticator is being set up
 *     (server/actions/mfa.ts): wrong_setup_code.
 * Its other reasons are not such refusals (sign_in_paused and
 * code_checks_paused never reach Supabase, auth_server_paused is Supabase's
 * 429, recovery codes are checked here).
 *
 * THE TWO OVERFLOW REASONS ARE READ AND COVER NOTHING. An overflow row counts
 * events of ANY password_guessing reason past the recorder's listed keys or
 * the writer's minute caps, also ones that never reach Supabase (a paused
 * sign-in), and anyone can fill it from our own sign-in page. Counted toward
 * what our server recorded, it would let a caller dressed as our server buy
 * as much room as it wanted for unrecorded guesses. Its sum is in the log
 * line only. An hour that truly overflowed is a busy hour already: a flagged
 * count there is true of what it says (our server has no record of them).
 */
const RECORDED_PASSWORD_REASONS: readonly string[] = [
  'wrong_password',
  'repeated_wrong_password',
  'wrong_current_password',
  'sign_in_refused_other',
];
const RECORDED_CODE_REASONS: readonly string[] = [
  'wrong_code',
  'repeated_wrong_code',
  'wrong_setup_code',
];
const RECORDED_OVERFLOW_REASONS: readonly string[] = ['over_minute_cap', 'over_buffer_cap'];
/**
 * The sources of our own record the reconciliation reads. `web` is our
 * server's. `phone` is read for ONE thing: a current-password check the
 * phone app asked for through our API (deleting the account, changing the
 * sign-in email) is our server sending a password, in our server's form,
 * and its refusal is recorded with the phone as its source
 * (server/security/account-events.ts). Only the two reasons that check
 * records are counted from a phone row. Every other phone row is not our
 * server's: this job itself stores the phone app's own refused sign-ins
 * and codes with that source, anyone can cause those, and counted as
 * recorded they would hide refusals in our server's form.
 */
export const AUTH_LOGS_RECONCILE_SOURCES = ['web', 'phone'] as const;
const RECORDED_PHONE_API_REASONS: readonly string[] = [
  'wrong_current_password',
  'sign_in_refused_other',
];
/** Every reason the reconciliation reads (the three lists above). */
export const AUTH_LOGS_RECONCILE_REASONS = [
  'wrong_password',
  'repeated_wrong_password',
  'wrong_current_password',
  'sign_in_refused_other',
  'wrong_code',
  'repeated_wrong_code',
  'wrong_setup_code',
  'over_minute_cap',
  'over_buffer_cap',
] as const;

const KINDS = [
  'password',
  'refresh',
  'token_known_other',
  'token_other',
  'verify',
  'verify_other',
  'factors_known_other',
  'emailed_code',
  'emailed_code_other',
] as const;
type AuthLogsKind = (typeof KINDS)[number];
/** The caller classes the queries answer: the phone app, our server's client string, anything else. */
const CALLERS = ['phone', 'server', 'other'] as const;
type AuthLogsCaller = (typeof CALLERS)[number];
/** The status classes the queries answer: the four the job acts on, and every other refused status. */
const STATUSES = ['400', '404', '422', '429', 'other'] as const;
type AuthLogsStatus = (typeof STATUSES)[number];
type AuthLogsNetwork = 'hosting' | 'other';

/**
 * The refused lines of one hour that can be stored, by minute, kind,
 * status, caller class, network class and country, largest groups first.
 * Only the pairs of kind and status classifyAuthLogLine stores are listed: a
 * password answered 400 or 429, a code check (verify) answered 422 or 429.
 * Any other pair is counted by the totals query alone, so it takes no row
 * of this query's limit from one that is stored.
 *
 * Read from Supabase's single `logs` table (ClickHouse), gateway lines only
 * (source edge_logs), where every field is a string in log_attributes. Only
 * POSTs answered 400 to 499 inside the loose net (net_path: the decoded
 * path in small letters, holding `auth` and one of the three words).
 * routed_path is the path as sent with repeated slashes as one, case kept:
 * the exact forms are compared with it.
 *
 * THE FORM IS NESTED SELECTS, the one the logs service's own SQL parser
 * accepts (it refuses a `WITH <expression> AS <name>` list): the innermost
 * select names the raw fields and filters the lines; the middle one works out
 * the kind, the caller class, the network class and the country from those
 * names; the outermost filters by kind, groups, orders and limits. A select
 * uses only the names of the select it reads from, and only functions that
 * were seen to run on the logs service on 2026-11-21. AUTH_LOGS_TOTALS_SQL
 * defines every name it shares with this query the same way (a test compares
 * them), and reads the same lines.
 *
 * The status is one of the four the job acts on, or `other`; the caller is
 * the phone app, our server's client string, or `other` (a browser, a tool,
 * no client string). The network is `hosting` when the caller is our
 * server's client string and the network owner's name starts with the one
 * prefix written in the query (measured: the leading comment says when).
 * The kind is `token_other` when the query string holds an escape that
 * does not decode, an encoded `&` or `=` (which the sign-in service keeps inside a
 * value, so reading the whole decoded string would read it differently), an
 * encoded control character, or a raw semicolon (the service drops the pair
 * that holds one). Our server's class is its two client
 * strings matched whole (a `.` is written `[.]`, so the text holds no
 * backslash). The client string and the owner's name are reduced to a class
 * here; the path and the query string are compared, never returned.
 */
export const AUTH_LOGS_GROUPS_SQL = `/* The hosting network owner prefix in this query was measured on 2026-11-21 from 24 hours of gateway lines. */
SELECT minute, kind, status, caller, network, country, count() AS n
FROM (
  SELECT
    minute,
    multiIf(
      match(routed_path, '^/auth/v1/factors/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/verify$'), 'verify',
      routed_path = '/auth/v1/factors', 'factors_known_other',
      match(routed_path, '^/auth/v1/factors/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/challenge$'), 'factors_known_other',
      position(net_path, 'factors') > 0, 'verify_other',
      routed_path = '/auth/v1/verify', 'emailed_code',
      position(net_path, 'verify') > 0, 'emailed_code_other',
      routed_path != '/auth/v1/token', 'token_other',
      match(raw_search, '%([^0-9A-Fa-f]|[0-9A-Fa-f][^0-9A-Fa-f]|[0-9A-Fa-f]?$|26|3[Dd]|[01][0-9A-Fa-f]|7[Ff])'), 'token_other',
      position(raw_search, ';') > 0, 'token_other',
      first_grant = 'password', 'password',
      first_grant = 'refresh_token', 'refresh',
      first_grant IN ('pkce', 'id_token', 'web3'), 'token_known_other',
      'token_other'
    ) AS kind,
    multiIf(raw_status = '400', '400', raw_status = '404', '404', raw_status = '422', '422', raw_status = '429', '429', 'other') AS status,
    caller,
    if(caller = 'server' AND startsWith(owner, 'Amazon'), 'hosting', 'other') AS network,
    if(match(raw_country, '^[A-Z]{2}$') AND raw_country != 'XX', raw_country, '') AS country
  FROM (
    SELECT
      toString(toStartOfMinute(timestamp)) AS minute,
      replaceRegexpAll(log_attributes['request.path'], '/+', '/') AS routed_path,
      lower(decodeURLComponent(log_attributes['request.path'])) AS net_path,
      log_attributes['request.search'] AS raw_search,
      extract(decodeURLComponent(log_attributes['request.search']), '(?:^[?]?|&)grant_type=([^&]*)(?:&|$)') AS first_grant,
      multiIf(
        match(log_attributes['request.headers.x_client_info'], '^supabase-ssr/[0-9]+[.][0-9]+[.][0-9]+ createServerClient$'), 'server',
        match(log_attributes['request.headers.x_client_info'], '^supabase-js/[0-9]+[.][0-9]+[.][0-9]+; runtime=node; runtime-version=[0-9]+[.][0-9]+[.][0-9]+$'), 'server',
        position(log_attributes['request.headers.x_client_info'], 'supabase-js-react-native') > 0, 'phone',
        position(log_attributes['request.headers.x_client_info'], '; runtime=react-native') > 0, 'phone',
        'other'
      ) AS caller,
      log_attributes['response.status_code'] AS raw_status,
      log_attributes['request.cf.asOrganization'] AS owner,
      log_attributes['request.cf.country'] AS raw_country
    FROM logs
    WHERE source = 'edge_logs'
      AND log_attributes['request.method'] = 'POST'
      AND match(log_attributes['response.status_code'], '^4[0-9][0-9]$')
      AND position(lower(decodeURLComponent(log_attributes['request.path'])), 'auth') > 0
      AND (position(lower(decodeURLComponent(log_attributes['request.path'])), 'token') > 0
           OR position(lower(decodeURLComponent(log_attributes['request.path'])), 'factors') > 0
           OR position(lower(decodeURLComponent(log_attributes['request.path'])), 'verify') > 0)
  )
)
WHERE ((kind = 'password' AND status IN ('400', '429')) OR (kind = 'verify' AND status IN ('422', '429'))) AND (caller != 'server' OR network != 'hosting')
GROUP BY minute, kind, status, caller, network, country
ORDER BY n DESC, minute, kind, status, caller, network, country
LIMIT 199`;

/**
 * Every refused line of the same hour, of every kind, by kind, status
 * class, caller class and network class only, with the first and last
 * instant of each group and whether any of its lines was of an ambiguous
 * form (`forms`: the least of `ambiguous`, for several grant_type values or
 * a path with a repeated slash, and `plain`): the log line's counts, the
 * flagged counts, our server's counts for the reconciliation and, when the
 * groups query was full, what it did not list.
 *
 * Each class it is grouped by is one of a short list written in the query,
 * so the answer has at most 9 x 5 x 4 = 180 rows whatever is sent (a test
 * multiplies the lists out): its limit cannot be reached by a caller. The
 * form is not one of them, so a request of another form opens no new row.
 */
export const AUTH_LOGS_TOTALS_SQL = `/* The hosting network owner prefix in this query was measured on 2026-11-21 from 24 hours of gateway lines. */
SELECT kind, status, caller, network, min(form) AS forms, toString(min(ts)) AS first_seen, toString(max(ts)) AS last_seen, count() AS n
FROM (
  SELECT
    ts,
    multiIf(
      match(routed_path, '^/auth/v1/factors/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/verify$'), 'verify',
      routed_path = '/auth/v1/factors', 'factors_known_other',
      match(routed_path, '^/auth/v1/factors/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/challenge$'), 'factors_known_other',
      position(net_path, 'factors') > 0, 'verify_other',
      routed_path = '/auth/v1/verify', 'emailed_code',
      position(net_path, 'verify') > 0, 'emailed_code_other',
      routed_path != '/auth/v1/token', 'token_other',
      match(raw_search, '%([^0-9A-Fa-f]|[0-9A-Fa-f][^0-9A-Fa-f]|[0-9A-Fa-f]?$|26|3[Dd]|[01][0-9A-Fa-f]|7[Ff])'), 'token_other',
      position(raw_search, ';') > 0, 'token_other',
      first_grant = 'password', 'password',
      first_grant = 'refresh_token', 'refresh',
      first_grant IN ('pkce', 'id_token', 'web3'), 'token_known_other',
      'token_other'
    ) AS kind,
    multiIf(raw_status = '400', '400', raw_status = '404', '404', raw_status = '422', '422', raw_status = '429', '429', 'other') AS status,
    caller,
    if(caller = 'server' AND startsWith(owner, 'Amazon'), 'hosting', 'other') AS network,
    if(match(decoded_search, '(^[?]?|&)grant_type=.*&grant_type=') OR raw_path != routed_path, 'ambiguous', 'plain') AS form
  FROM (
    SELECT
      timestamp AS ts,
      log_attributes['request.path'] AS raw_path,
      replaceRegexpAll(log_attributes['request.path'], '/+', '/') AS routed_path,
      lower(decodeURLComponent(log_attributes['request.path'])) AS net_path,
      log_attributes['request.search'] AS raw_search,
      decodeURLComponent(log_attributes['request.search']) AS decoded_search,
      extract(decodeURLComponent(log_attributes['request.search']), '(?:^[?]?|&)grant_type=([^&]*)(?:&|$)') AS first_grant,
      multiIf(
        match(log_attributes['request.headers.x_client_info'], '^supabase-ssr/[0-9]+[.][0-9]+[.][0-9]+ createServerClient$'), 'server',
        match(log_attributes['request.headers.x_client_info'], '^supabase-js/[0-9]+[.][0-9]+[.][0-9]+; runtime=node; runtime-version=[0-9]+[.][0-9]+[.][0-9]+$'), 'server',
        position(log_attributes['request.headers.x_client_info'], 'supabase-js-react-native') > 0, 'phone',
        position(log_attributes['request.headers.x_client_info'], '; runtime=react-native') > 0, 'phone',
        'other'
      ) AS caller,
      log_attributes['response.status_code'] AS raw_status,
      log_attributes['request.cf.asOrganization'] AS owner
    FROM logs
    WHERE source = 'edge_logs'
      AND log_attributes['request.method'] = 'POST'
      AND match(log_attributes['response.status_code'], '^4[0-9][0-9]$')
      AND position(lower(decodeURLComponent(log_attributes['request.path'])), 'auth') > 0
      AND (position(lower(decodeURLComponent(log_attributes['request.path'])), 'token') > 0
           OR position(lower(decodeURLComponent(log_attributes['request.path'])), 'factors') > 0
           OR position(lower(decodeURLComponent(log_attributes['request.path'])), 'verify') > 0)
  )
)
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
  status: AuthLogsStatus;
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
  /**
   * At least one line of the group had several grant_type values or a
   * repeated slash in its path (log line only).
   */
  ambiguous: boolean;
  n: number;
}

/**
 * Why a line is counted in the log line and not stored: our own server's
 * form (reconciled), a status whose meaning is not known, a refresh, a known
 * request that checks no password and no code (another grant, enrolling a
 * factor, asking for a challenge), a check of an emailed code (not stored
 * until our own server's emailed-code refusals are recorded), or a request
 * of an unknown form that the service routed nowhere (404: nothing was
 * checked).
 */
export type AuthLogsNotStored =
  'our_server' | 'other_status' | 'refresh' | 'known_other' | 'emailed_code' | 'not_routed';

export type AuthLogsVerdict =
  | {
      store: true;
      category: 'password_guessing' | 'bots';
      reason: 'wrong_password' | 'wrong_code' | 'auth_rate_limited';
      source: AuthLogsSource;
    }
  | { store: false; why: AuthLogsNotStored }
  /** Of an unknown form: stored with the others of its source as one flagged count. */
  | { store: false; why: 'unclassified'; source: AuthLogsSource };

/** One element of record_security_events' array, as this job sends it. */
export interface AuthLogsElement {
  category: 'password_guessing' | 'bots';
  /** `flagged` only on the counts of what the job cannot account for. */
  outcome: 'blocked' | 'flagged';
  reason: AuthLogsReason;
  source: AuthLogsSource;
  count: number;
  /** The minute, in ms since 1970. */
  at_ms: number;
  /** Present only when known. */
  country?: string;
}

/** What our own server recorded for an hour (source web), for the reconciliation. */
export interface AuthLogsRecorded {
  /** Events on the rows whose reason names a refused password. */
  password: number;
  /** Events on the rows whose reason names a refused code. */
  code: number;
  /** The overflow rows' counts, of any reason: for the log line only, never part of the comparison. */
  overflow: number;
  /**
   * False when not every row of the hour could be read: `password` and
   * `code` are then lower bounds, so the excess can only be too large.
   */
  complete: boolean;
}

/** Our server's form of an hour, reconciled with what it recorded. */
export interface AuthLogsReconcile {
  /** The gateway's refusals of our server's form: password 400s and code 422s. */
  gateway: { password: number; code: number };
  /** What our own server recorded, or null when it was not read. */
  recorded: AuthLogsRecorded | null;
  /**
   * gateway - recorded per kind, less what was carried, never below 0; null
   * when not reconciled.
   */
  excess: { password: number; code: number } | null;
  /**
   * What the hour's edge took off the excess, per kind: refusals the gateway
   * stamped in this hour and our server recorded in the first minute of the
   * next (hourEdgeCarry). Present only when a carry was worked out.
   */
  carried?: { password: number; code: number };
}

/** The most an hour's excess may be reduced by for its edge, per kind. */
export interface AuthLogsCarry {
  password: number;
  code: number;
}

export type AuthLogsFailureCause =
  | 'token_refused'
  | 'logs_query_error'
  | 'logs_unavailable'
  | 'logs_timeout'
  | 'logs_unreachable'
  | 'logs_bad_answer'
  | 'db_read_failed'
  | 'reconcile_read_failed'
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
  /**
   * `waiting`: the newest hour, left for the next run because it would be
   * flagged and the hour after it, which may hold our record of refusals at
   * its edge, is not complete yet. Nothing of it is written.
   */
  outcome: 'stored' | 'already_stored' | 'nothing_to_store' | 'waiting' | 'failed' | 'not_tried';
  /** Events stored for the hour by this run. */
  events: number;
  /** Our server's form of the hour, reconciled; present once the hour was read. */
  reconcile?: AuthLogsReconcile;
  /**
   * Present (true) when the hour's totals were not whole: `reconcile` and
   * every count of the hour are then of the part that was read.
   */
  totalsIncomplete?: true;
  /** Why the hour failed, when it did: it is read again by the next run. */
  failure?: AuthLogsFailure;
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
  /** Hours left for the next run with nothing written (see the `waiting` outcome). */
  hoursWaiting: number;
  /** Group rows that passed the checks. */
  groups: number;
  /** Rows (of either query) dropped by the checks. */
  dropped: number;
  /** Hours whose groups query was full (199 rows). */
  capped: number;
  /** Hours whose totals answer was full (as many rows as its limit lets through). */
  totalsCapped: number;
  /** Rows of the totals answers dropped by the checks. */
  totalsRowsDropped: number;
  /**
   * Hours whose totals were not whole (a full answer, or a dropped row):
   * each is given a flagged count, and its counts are of the part read. A
   * waiting hour is counted too, in the run that saw it: it is given its
   * flagged count by the next run.
   */
  totalsIncomplete: number;
  /** Of those, hours that wait for the next run (see the `waiting` outcome). */
  totalsIncompleteWaiting: number;
  /** Group rows on the minute an hour ends: lines of the next hour, left to its own run. */
  atHourEnd: number;
  /** Full hours given no remainder because a group row was dropped. */
  remainderSkipped: number;
  /** Elements sent to the writer. */
  elements: number;
  /** Events in them. */
  eventsStored: number;
  /** Elements whose count was cut to AUTH_LOGS_MAX_COUNT. */
  clamped: number;
  /** Lines counted here and not stored, by why. */
  notStored: Record<AuthLogsNotStored, number>;
  /** Lines of an unknown form (all stored, as flagged counts). */
  unclassified: number;
  /**
   * Groups of the totals (a kind, a status class, a caller class and a
   * network class in one hour) that held at least one line with several
   * grant_type values (classed by the first) or a repeated slash in the path.
   */
  ambiguousFormGroups: number;
  /** Flagged elements of refusals of our server's form that our server has no record of. */
  unrecordedFlags: number;
  /** Hours for which this run stored at least one flagged element. */
  flaggedHours: number;
  /** Reason -> events on the flagged elements this run stored. */
  flaggedStored: Partial<Record<AuthLogsReason, number>>;
  /** Hours whose own record could not all be read: compared with what was read (fail closed). */
  reconcileIncomplete: number;
  /** `<kind> <status> <caller> <network>` -> lines, for the hours read. */
  seen: Record<string, number>;
  /** Lines of the kinds past AUTH_LOGS_SEEN_LIMIT. */
  seenOther: number;
  /** Stored hours the check could not find afterwards (past the writer's minute caps). */
  landedPastMinuteCaps: number;
  /** Hours found stored by the check made again right before the write: another run wrote them meanwhile. */
  storedByAnotherRun: number;
  /** Stored hours for which the writer answered a count below the elements sent, or none. */
  storedFewer: number;
  /** The first failure of the run (each failed hour carries its own). */
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

/** Our own server: one of its two exact client strings AND a hosting network. */
const isOurServerForm = (line: AuthLogsLine) =>
  line.caller === 'server' && line.network === 'hosting';

/** What a refused line stands for: the event to store, or why it is not stored one by one. */
export function classifyAuthLogLine(line: AuthLogsLine): AuthLogsVerdict {
  const source: AuthLogsSource = line.caller === 'phone' ? 'phone' : 'api';
  // An unknown form is never taken for our own server: nothing of it is
  // hidden. Answered 404, the service routed it nowhere and checked nothing
  // (measured: a trailing slash, capitals, an encoded letter): counted only.
  // Any other refused status of it is flagged. THIS RESTS ON ONE FACT: a
  // wrong secret is never answered 404 (measured on 2026-11-21: a wrong
  // password is 400, a wrong authenticator code 422, a wrong emailed code
  // 403). If the sign-in service ever answers a checked secret with 404,
  // this rule must go.
  if (
    line.kind === 'token_other' ||
    line.kind === 'verify_other' ||
    line.kind === 'emailed_code_other'
  ) {
    if (line.status === '404') return { store: false, why: 'not_routed' };
    return { store: false, why: 'unclassified', source };
  }
  // Ours: already recorded by part 1, with the member's real place (its count
  // is reconciled with that record). Our client string from any other
  // network is someone dressing up as our server, read as any other caller.
  if (isOurServerForm(line)) return { store: false, why: 'our_server' };
  switch (line.kind) {
    case 'refresh':
      return { store: false, why: 'refresh' };
    case 'token_known_other':
    case 'factors_known_other':
      return { store: false, why: 'known_other' };
    case 'emailed_code':
      return { store: false, why: 'emailed_code' };
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

/** The gateway's refusals of our server's form in an hour: its wrong passwords (400) and codes (422). */
export function serverFormRefusals(totals: readonly AuthLogsTotalsRow[]): {
  password: number;
  code: number;
} {
  let password = 0;
  let code = 0;
  for (const row of totals) {
    if (!isOurServerForm(row)) continue;
    if (row.kind === 'password' && row.status === '400') password += row.n;
    if (row.kind === 'verify' && row.status === '422') code += row.n;
  }
  return { password, code };
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
  if (typeof status !== 'string' || !(STATUSES as readonly string[]).includes(status)) return null;
  if (typeof caller !== 'string' || !(CALLERS as readonly string[]).includes(caller)) return null;
  return {
    kind: kind as AuthLogsKind,
    status: status as AuthLogsStatus,
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

/**
 * Whether a row of the groups query is, in every other respect, a good row
 * whose minute is the one the hour ENDS on. A line stamped on the very
 * instant an hour ends belongs to the next hour. Whether the logs service
 * answers such a line for the hour that ends there is not relied on: if it
 * does, the line's group row is left to the next hour (whose own run lists
 * and stores it at its first minute) and is not a row that failed its
 * checks. Storing it here would put a row of this job on a minute of the
 * next hour, and that hour would then be taken as already stored.
 */
export function isGroupRowOfNextHour(raw: unknown, hour: AuthLogsHour): boolean {
  const next = parseGroupRow(raw, { startMs: hour.endMs, endMs: hour.endMs + HOUR_MS });
  return next !== null && next.minuteMs === hour.endMs;
}

/**
 * One row of the totals query, checked the same way; its first and last
 * instants are inside the hour, or its last is the instant the hour ends. A
 * line stamped on that instant belongs to the next hour, and whether the
 * logs service answers it for this one is not relied on: if it does, the row
 * is KEPT, with its count as it is, so such a line can never take a whole
 * row (our server's, for one) out of the totals. One line more in an hour is
 * the safe direction. The row held a line of an ambiguous form only when the
 * query said exactly that.
 */
export function parseTotalsRow(raw: unknown, hour: AuthLogsHour): AuthLogsTotalsRow | null {
  if (!isRecord(raw)) return null;
  const line = lineOf(raw);
  if (!line) return null;
  const first = parseLogsTime(raw.first_seen);
  const last = parseLogsTime(raw.last_seen);
  if (first === null || last === null) return null;
  if (first < hour.startMs || last > hour.endMs || first > last) return null;
  const n = countOf(raw.n);
  if (n === null) return null;
  // The forms only feed a count of the log line: never a reason to drop a row.
  return { ...line, ambiguous: raw.forms === 'ambiguous', n };
}

/** What one hour's rows come to. */
export interface AuthLogsHourElements {
  /** At most AUTH_LOGS_MAX_ELEMENTS, in a fixed order. */
  elements: AuthLogsElement[];
  notStored: Record<AuthLogsNotStored, number>;
  /** Lines of an unknown form (stored as flagged counts, one per source). */
  unclassified: number;
  /** Groups of the totals that held a line with several grant_type values, or a repeated slash in the path. */
  ambiguousFormGroups: number;
  /** Our server's form, reconciled with what it recorded. */
  reconcile: AuthLogsReconcile;
  /** `<kind> <status> <caller> <network>` -> lines. */
  seen: Record<string, number>;
  /** Elements whose count was cut to AUTH_LOGS_MAX_COUNT. */
  clamped: number;
  /** Events on the auth_log_over_cap elements. */
  remainder: number;
  /** The groups were full but a row was dropped, so no remainder was added. */
  remainderSkipped: boolean;
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
 * THE HOUR'S EDGE. The gateway stamps a request when it arrives; our server
 * stamps its record after the answer (and after the organization is looked
 * up). A refusal in the last moments of an hour is therefore in that hour at
 * the gateway and in the next hour in our record, and without a rule three
 * of them would be flagged as refusals our server has no record of.
 *
 * The rule is a CARRY, not a tolerance: an hour's excess may be reduced, per
 * kind, by at most the smaller of
 *   - the events our server recorded in the FIRST MINUTE of the next hour,
 *   - what the next hour's own record holds BEYOND the next hour's own
 *     gateway count.
 * The second limit is what keeps one recorded row from covering two
 * refusals: a row of the next hour that one of that hour's own gateway
 * lines accounts for is not carried back. Only rows whose reason names the
 * kind count (as everywhere in the reconciliation), so the carry is exactly
 * the refusals our server made at the edge. Refusals in our server's form
 * that our server did not make leave no record on either side of the edge,
 * so the carry never covers them. The threshold is unchanged.
 */
export function hourEdgeCarry(next: {
  /** What our server recorded in the first minute of the next hour. */
  firstMinute: { password: number; code: number };
  /** What our server recorded in the whole next hour. */
  recorded: { password: number; code: number };
  /** The gateway's refusals of our server's form in the next hour. */
  gateway: { password: number; code: number };
}): AuthLogsCarry {
  const of = (kind: 'password' | 'code') =>
    Math.max(0, Math.min(next.firstMinute[kind], next.recorded[kind] - next.gateway[kind]));
  return { password: of('password'), code: of('code') };
}

/**
 * Our server's form of an hour against what it recorded (pure), less the
 * carry of the hour's edge when one was worked out.
 */
export function reconcileServerForm(
  gateway: { password: number; code: number },
  recorded: AuthLogsRecorded | null,
  carry: AuthLogsCarry | null = null,
): AuthLogsReconcile {
  if (!recorded) {
    // Nothing of our server's form: nothing to reconcile. Otherwise unknown.
    const none = gateway.password === 0 && gateway.code === 0;
    return { gateway, recorded: null, excess: none ? { password: 0, code: 0 } : null };
  }
  // Only rows whose reason names the kind: overflow rows cover nothing.
  const before = {
    password: Math.max(0, gateway.password - recorded.password),
    code: Math.max(0, gateway.code - recorded.code),
  };
  if (!carry) return { gateway, recorded, excess: before };
  // A carry takes off no more than it is, and no more than the excess.
  const carried = {
    password: Math.max(0, Math.min(before.password, carry.password)),
    code: Math.max(0, Math.min(before.code, carry.code)),
  };
  return {
    gateway,
    recorded,
    excess: { password: before.password - carried.password, code: before.code - carried.code },
    carried,
  };
}

/**
 * The writer's elements for one hour (pure). Lines that land on the same row
 * are one element. `totals` (every kind of the hour) gives the counts that
 * are not stored, the log line, the flagged count of each source's requests
 * of an unknown form, and our server's form, which `recorded` (what our own
 * server recorded for the hour, or null when it was not read) reconciles.
 * When the groups were full (`groupsCapped`), the remainder is counted per
 * category, reason and source (never below zero) and stored on one
 * auth_log_over_cap element per category and source, unless a group row was
 * dropped (`groupsDropped`): its count would come back through the totals.
 * The smallest groups are folded into those elements until the call fits.
 * When the totals were not whole (`totalsIncomplete`), one flagged
 * too_many_forms_to_count element is added: the hour's other counts are then
 * of a part of it only.
 */
export function buildHourElements(input: {
  hour: AuthLogsHour;
  groups: readonly AuthLogsGroupRow[];
  groupsCapped: boolean;
  groupsDropped: number;
  totals: readonly AuthLogsTotalsRow[];
  /**
   * The totals answer was not whole: it was full, or a row of it failed its
   * checks. What `totals` holds is then only a part of the hour.
   */
  totalsIncomplete?: boolean;
  recorded: AuthLogsRecorded | null;
  /** The carry of the hour's edge (hourEdgeCarry), when one was worked out. */
  carry?: AuthLogsCarry | null;
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

  // The complete counts of the hour, every kind, from the totals.
  const notStored: Record<AuthLogsNotStored, number> = {
    our_server: 0,
    other_status: 0,
    refresh: 0,
    known_other: 0,
    emailed_code: 0,
    not_routed: 0,
  };
  const unclassifiedBySource: Record<AuthLogsSource, number> = { phone: 0, api: 0 };
  let ambiguousFormGroups = 0;
  const seen: Record<string, number> = {};
  for (const row of input.totals) {
    const key = seenKey(row);
    seen[key] = (seen[key] ?? 0) + row.n;
    if (row.ambiguous) ambiguousFormGroups += 1;
    const v = classifyAuthLogLine(row);
    if (v.store) continue;
    if (v.why === 'unclassified') unclassifiedBySource[v.source] += row.n;
    else notStored[v.why] += row.n;
  }

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

  // What the job cannot account for is never invisible: flagged counts,
  // never shown as blocked attacks, with no country.
  const flagged: AuthLogsElement[] = [];
  const flag = (reason: AuthLogsReason, source: AuthLogsSource, count: number, atMs: number) =>
    flagged.push({
      category: 'password_guessing',
      outcome: 'flagged',
      reason,
      source,
      count,
      at_ms: atMs,
    });
  // Totals that are not whole: every count above is of a part of the hour
  // only, and rows that were not read could be the very ones a flagged count
  // is made from (our server's form, an unknown form). The hour is never
  // stored as if it were clean: one flagged count at the hour's first
  // minute. Its words are "refused sign-in requests in an hour that could
  // not all be counted", and its number is what those words count: the
  // refused requests of the hour that were counted, of every kind (every
  // line of every totals row that passed its checks; at least 1). Whether
  // the answer was full or a row of it failed its checks, the requests
  // missing from that number are the ones that could not be counted.
  if (input.totalsIncomplete) {
    const counted = input.totals.reduce((sum, row) => sum + row.n, 0);
    flag('too_many_forms_to_count', 'api', Math.max(1, counted), input.hour.startMs);
  }
  // Requests of an unknown form, even one: one count per source, at the hour's first minute.
  for (const source of AUTH_LOGS_SOURCES) {
    const n = unclassifiedBySource[source];
    if (n >= AUTH_LOGS_UNCLASSIFIED_FLAG_AT)
      flag('unclassified_sign_in_refusals', source, n, input.hour.startMs);
  }
  // Refusals of our server's form that our server has no record of: from
  // AUTH_LOGS_UNRECORDED_FLAG_AT in an hour, one count per kind, at the hour's last minute.
  const reconcile = reconcileServerForm(
    serverFormRefusals(input.totals),
    input.recorded,
    input.carry ?? null,
  );
  const lastMinute = input.hour.endMs - MINUTE_MS;
  if (reconcile.excess) {
    if (reconcile.excess.password >= AUTH_LOGS_UNRECORDED_FLAG_AT)
      flag('unrecorded_server_form_password', 'api', reconcile.excess.password, lastMinute);
    if (reconcile.excess.code >= AUTH_LOGS_UNRECORDED_FLAG_AT)
      flag('unrecorded_server_form_code', 'api', reconcile.excess.code, lastMinute);
  }

  // Fit the call: the smallest listed elements are folded into their remainder element.
  const list = [...listed.values()].sort((a, b) => b.count - a.count || compareElements(a, b));
  while (list.length > 0 && list.length + overCap.size + flagged.length > AUTH_LOGS_MAX_ELEMENTS) {
    const smallest = list.pop()!;
    countOnOverCap(smallest.category, smallest.source, smallest.count);
  }

  let clamped = 0;
  const elements = [...list, ...overCap.values(), ...flagged]
    .map((e) => {
      if (e.count <= AUTH_LOGS_MAX_COUNT) return e;
      clamped += 1;
      return { ...e, count: AUTH_LOGS_MAX_COUNT };
    })
    .sort(compareElements);
  const remainder = elements
    .filter((e) => e.reason === 'auth_log_over_cap')
    .reduce((s, e) => s + e.count, 0);
  return {
    elements,
    notStored,
    unclassified: unclassifiedBySource.phone + unclassifiedBySource.api,
    ambiguousFormGroups,
    reconcile,
    seen,
    clamped,
    remainder,
    remainderSkipped,
  };
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
  /** The start of the hour that is still running: every hour that ends by it is complete. */
  completeUntil: number;
  /** The totals answers of this run, by the hour's start: an hour's totals are asked for once. */
  totalsAnswers: Map<number, unknown[]>;
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
 * The body of a successful answer as text, or null when it is larger than
 * MAX_ANSWER_BYTES. A length the answer declares above the limit is refused
 * before a byte is read; with no usable declared length (or a wrong one) the
 * body is read a piece at a time and given up, and cancelled, as soon as it
 * passes the limit. So an answer of any size costs this function a bounded
 * amount of memory. A body that cannot be read throws, as fetch does.
 */
async function readCapped(res: Response): Promise<string | null> {
  const giveUp = async () => {
    try {
      await res.body?.cancel();
    } catch {
      // Nothing to do: the body is not read either way.
    }
    return null;
  };
  const declared = res.headers.get('content-length');
  if (declared !== null && /^[0-9]{1,15}$/.test(declared) && Number(declared) > MAX_ANSWER_BYTES) {
    return giveUp();
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const pieces: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_ANSWER_BYTES) {
      try {
        await reader.cancel();
      } catch {
        // Nothing to do: the rest is not read either way.
      }
      return null;
    }
    pieces.push(value);
  }
  const whole = new Uint8Array(bytes);
  let at = 0;
  for (const piece of pieces) {
    whole.set(piece, at);
    at += piece.byteLength;
  }
  return new TextDecoder().decode(whole);
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
      const text = await readCapped(res);
      if (text === null) return { ok: false, failure: { cause: 'logs_bad_answer' } };
      const rows = rowsOf(text);
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

/**
 * One writer call with every element of the hour: stored whole or not at
 * all. Answers the writer's own count of the elements it stored (it skips an
 * element it cannot read), or null when it gave none.
 */
async function writeHour(
  ctx: RunContext,
  elements: AuthLogsElement[],
): Promise<Outcome<number | null>> {
  const limit = callLimit(ctx, AUTH_LOGS_DB_TIMEOUT_MS);
  if (!limit) return { ok: false, failure: { cause: 'out_of_time' } };
  try {
    const { data, error } = await within(limit.ms, (signal) =>
      Promise.resolve(
        ctx.admin().rpc('record_security_events', { p_events: elements }).abortSignal(signal),
      ),
    );
    if (error) return { ok: false, failure: { cause: 'writer_failed', code: codeOf(error) } };
    const stored: unknown = data;
    return {
      ok: true,
      value: typeof stored === 'number' && Number.isSafeInteger(stored) ? stored : null,
    };
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

/**
 * What our own server recorded for the hour: service-role reads of the
 * record's rows with a source of AUTH_LOGS_RECONCILE_SOURCES (a phone row
 * counts only for a current-password check asked through our API), category
 * password_guessing and a reason of
 * AUTH_LOGS_RECONCILE_REASONS, in the hour (every organization), a page of
 * AUTH_LOGS_RECONCILE_PAGE_ROWS at a time in the order of their ids, the
 * first with the count of rows. Their event counts are added up per kind.
 *
 * NEVER SKIPPED FOR BEING LARGE. An hour with many rows is exactly the hour
 * in which someone could hope the comparison is not made. The read goes on,
 * from the row after the last one it holds, until a page comes back short
 * with every counted row read, and stops at AUTH_LOGS_RECONCILE_MAX_PAGES
 * pages. If it could not read them all (the hard stop, or fewer rows than
 * the count says) it FAILS CLOSED: the sums of what it did read are returned
 * with `complete: false`. They are lower bounds, so the excess the caller
 * works out can only be larger than the true one: a flag may be stored that
 * a whole read would not store, never the reverse. (Ten full pages are taken
 * as not all, since one more row cannot be told from none.)
 *
 * A page that fails, a row that is not what was asked for, or a first page
 * with no count of rows fails the read: the hour is left for the next run.
 */
async function readRecorded(
  ctx: RunContext,
  /** An hour, or a part of one (the carry reads an hour's first minute). */
  hour: AuthLogsHour,
): Promise<Outcome<AuthLogsRecorded>> {
  const failed = (code: string): Outcome<AuthLogsRecorded> => ({
    ok: false,
    failure: { cause: 'reconcile_read_failed', code },
  });
  const recorded: AuthLogsRecorded = { password: 0, code: 0, overflow: 0, complete: false };
  let rowsRead = 0;
  let rowsCounted = 0;
  for (let page = 0; page < AUTH_LOGS_RECONCILE_MAX_PAGES; page++) {
    const limit = callLimit(ctx, AUTH_LOGS_DB_TIMEOUT_MS);
    if (!limit) return { ok: false, failure: { cause: 'out_of_time' } };
    const first = page === 0;
    const from = rowsRead;
    let data: unknown;
    try {
      const answer = await within(limit.ms, (signal) =>
        Promise.resolve(
          ctx
            .admin()
            .from('security_events')
            .select('source, reason, event_count', first ? { count: 'exact' } : undefined)
            .in('source', AUTH_LOGS_RECONCILE_SOURCES)
            .eq('category', 'password_guessing')
            .in('reason', AUTH_LOGS_RECONCILE_REASONS)
            .gte('minute', iso(hour.startMs))
            .lt('minute', iso(hour.endMs))
            .order('id', { ascending: true })
            .range(from, from + AUTH_LOGS_RECONCILE_PAGE_ROWS - 1)
            .abortSignal(signal),
        ),
      );
      if (answer.error) return failed(codeOf(answer.error));
      if (first) {
        const count = answer.count;
        if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)
          return failed('no_count');
        rowsCounted = count;
      }
      data = answer.data;
    } catch (e) {
      if (e instanceof CallTimeout) {
        return {
          ok: false,
          failure: timedOut(limit.cut, { cause: 'reconcile_read_failed', code: 'timeout' }),
        };
      }
      return failed(codeOf(e));
    }
    if (!Array.isArray(data)) return failed('no_rows');
    for (const row of data as unknown[]) {
      if (!isRecord(row) || typeof row.reason !== 'string') return failed('bad_row');
      const n = row.event_count;
      if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1) return failed('bad_row');
      if (row.source === 'phone') {
        // Only a current-password check asked through our API; any other
        // phone row is not our server's and covers nothing.
        if (RECORDED_PHONE_API_REASONS.includes(row.reason)) recorded.password += n;
        else if (!(AUTH_LOGS_RECONCILE_REASONS as readonly string[]).includes(row.reason))
          return failed('bad_row');
        continue;
      }
      if (row.source !== 'web') return failed('bad_row');
      if (RECORDED_PASSWORD_REASONS.includes(row.reason)) recorded.password += n;
      else if (RECORDED_CODE_REASONS.includes(row.reason)) recorded.code += n;
      else if (RECORDED_OVERFLOW_REASONS.includes(row.reason)) recorded.overflow += n;
      else return failed('bad_row');
    }
    rowsRead += data.length;
    // The end: nothing more came, or a short page with every counted row read.
    if (data.length === 0 || data.length < AUTH_LOGS_RECONCILE_PAGE_ROWS) {
      if (data.length === 0 || rowsRead >= rowsCounted) {
        recorded.complete = rowsRead >= rowsCounted;
        break;
      }
    }
  }
  return { ok: true, value: recorded };
}

// ── The run ─────────────────────────────────────────────────────────────────

function emptySummary(hours: AuthLogsHour[]): AuthLogsRunSummary {
  return {
    ok: true,
    hours: hours.map((hour) => ({ hour: hourLabel(hour), outcome: 'not_tried', events: 0 })),
    hoursRead: 0,
    hoursSkipped: 0,
    hoursStored: 0,
    hoursWaiting: 0,
    groups: 0,
    dropped: 0,
    capped: 0,
    totalsCapped: 0,
    totalsRowsDropped: 0,
    totalsIncomplete: 0,
    totalsIncompleteWaiting: 0,
    atHourEnd: 0,
    remainderSkipped: 0,
    elements: 0,
    eventsStored: 0,
    clamped: 0,
    notStored: {
      our_server: 0,
      other_status: 0,
      refresh: 0,
      known_other: 0,
      emailed_code: 0,
      not_routed: 0,
    },
    unclassified: 0,
    ambiguousFormGroups: 0,
    unrecordedFlags: 0,
    flaggedHours: 0,
    flaggedStored: {},
    reconcileIncomplete: 0,
    seen: {},
    seenOther: 0,
    landedPastMinuteCaps: 0,
    storedByAnotherRun: 0,
    storedFewer: 0,
    failure: null,
  };
}

/** The totals answer of an hour: asked for once in a run, then kept. */
async function readTotals(ctx: RunContext, hour: AuthLogsHour): Promise<Outcome<unknown[]>> {
  const kept = ctx.totalsAnswers.get(hour.startMs);
  if (kept) return { ok: true, value: kept };
  const answer = await queryLogs(ctx, AUTH_LOGS_TOTALS_SQL, hour);
  if (answer.ok) ctx.totalsAnswers.set(hour.startMs, answer.value);
  return answer;
}

/**
 * The carry of an hour's edge (hourEdgeCarry), read from the hour after it:
 * that hour's gateway count of our server's form, what our server recorded
 * in it, and what it recorded in its first minute. Null when that hour's
 * totals were not whole: its gateway count could then be short, which would
 * make the carry too large, so nothing is carried (fail closed). A record
 * that could not all be read gives lower bounds, so the carry can only be
 * too small. A read that fails is the caller's failure: the hour is left
 * for the next run, and no flag is stored on a guess.
 */
async function readEdgeCarry(
  ctx: RunContext,
  next: AuthLogsHour,
): Promise<Outcome<AuthLogsCarry | null>> {
  const answer = await readTotals(ctx, next);
  if (!answer.ok) return answer;
  if (answer.value.length >= AUTH_LOGS_ROW_LIMIT) return { ok: true, value: null };
  const totals: AuthLogsTotalsRow[] = [];
  for (const raw of answer.value) {
    const row = parseTotalsRow(raw, next);
    if (!row) return { ok: true, value: null };
    totals.push(row);
  }
  const recorded = await readRecorded(ctx, next);
  if (!recorded.ok) return recorded;
  const gateway = serverFormRefusals(totals);
  const beyond = (kind: 'password' | 'code') => recorded.value[kind] - gateway[kind];
  // Nothing beyond its own gateway lines: nothing to carry, whatever its first minute holds.
  if (beyond('password') <= 0 && beyond('code') <= 0) {
    return { ok: true, value: { password: 0, code: 0 } };
  }
  const firstMinute = await readRecorded(ctx, {
    startMs: next.startMs,
    endMs: next.startMs + MINUTE_MS,
  });
  if (!firstMinute.ok) return firstMinute;
  return {
    ok: true,
    value: hourEdgeCarry({ firstMinute: firstMinute.value, recorded: recorded.value, gateway }),
  };
}

/** Counts an hour whose totals were not whole in the run's summary (its report reads them). */
function countTotalsIncomplete(
  summary: AuthLogsRunSummary,
  full: boolean,
  rowsDropped: number,
): void {
  summary.totalsIncomplete += 1;
  if (full) summary.totalsCapped += 1;
  summary.totalsRowsDropped += rowsDropped;
}

/**
 * Reads, maps and stores one hour. Null when done (stored, already stored,
 * nothing to store, or waiting for the hour after it).
 */
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
  let atHourEnd = 0;
  for (const raw of groupsAnswer.value) {
    const row = parseGroupRow(raw, hour);
    if (row) groups.push(row);
    // Lines stamped on the instant the hour ends: the next hour's.
    else if (isGroupRowOfNextHour(raw, hour)) atHourEnd += 1;
    else dropped += 1;
  }
  const groupsDropped = dropped;
  const capped = groupsAnswer.value.length >= AUTH_LOGS_ROW_LIMIT;

  // Every kind of the hour: always read (the log line, the flagged counts,
  // our server's form, and the remainder when the groups were full).
  const totalsAnswer = await readTotals(ctx, hour);
  if (!totalsAnswer.ok) return totalsAnswer.failure;
  const totals: AuthLogsTotalsRow[] = [];
  let totalsDropped = 0;
  for (const raw of totalsAnswer.value) {
    const row = parseTotalsRow(raw, hour);
    if (row) totals.push(row);
    else totalsDropped += 1;
  }
  dropped += totalsDropped;
  // TOTALS THAT ARE NOT WHOLE ARE NEVER STORED AS IF THEY WERE. The query
  // answers its largest groups first, so a full answer leaves the smallest
  // out, and those can be the very rows everything below is read from: our
  // server's form, an unknown form. A row that failed its checks is the same
  // loss. (The query is written so that a caller cannot fill it: this is the
  // net under that.) The hour is then given a flagged count and reported;
  // its lines in our server's form are compared with the part that was read.
  const totalsFull = totalsAnswer.value.length >= AUTH_LOGS_ROW_LIMIT;
  const totalsIncomplete = totalsFull || totalsDropped > 0;

  // Our server's form, reconciled with what our own server recorded. A read
  // that fails leaves the whole hour for the next run: nothing of it is
  // written, so the hour is not taken as done. A read that could not take
  // every row still compares, with what it read (fail closed), and says so.
  let recorded: AuthLogsRecorded | null = null;
  const gateway = serverFormRefusals(totals);
  if (gateway.password > 0 || gateway.code > 0) {
    const read = await readRecorded(ctx, hour);
    if (!read.ok) return read.failure;
    recorded = read.value;
  }

  // THE HOUR'S EDGE. Before an hour is flagged for refusals our server has
  // no record of, the hour after it is read: refusals our server made in
  // this hour's last moments are recorded there (hourEdgeCarry). Only an
  // hour that would be flagged costs these reads. When the hour after it is
  // still running, its record is not complete, so the flag cannot be decided
  // yet: the whole hour waits for the next run, with nothing written (an
  // hour is written once, so its ordinary counts wait with it).
  let carry: AuthLogsCarry | null = null;
  const before = reconcileServerForm(gateway, recorded).excess;
  if (
    before &&
    (before.password >= AUTH_LOGS_UNRECORDED_FLAG_AT || before.code >= AUTH_LOGS_UNRECORDED_FLAG_AT)
  ) {
    const next: AuthLogsHour = { startMs: hour.endMs, endMs: hour.endMs + HOUR_MS };
    if (next.endMs > ctx.completeUntil) {
      report.outcome = 'waiting';
      report.reconcile = reconcileServerForm(gateway, recorded);
      summary.hoursWaiting += 1;
      // A waiting hour whose totals were not whole is told in THIS run, not
      // only by the run that stores it: the totals report counts it, and
      // says how many of its hours wait. The next run reads the hour again
      // and reports what it finds then, with the flagged count it stores.
      if (totalsIncomplete) {
        report.totalsIncomplete = true;
        countTotalsIncomplete(summary, totalsFull, totalsDropped);
        summary.totalsIncompleteWaiting += 1;
      }
      return null;
    }
    const read = await readEdgeCarry(ctx, next);
    if (!read.ok) return read.failure;
    carry = read.value;
  }
  if (recorded && !recorded.complete) summary.reconcileIncomplete += 1;

  if (totalsIncomplete) countTotalsIncomplete(summary, totalsFull, totalsDropped);
  summary.atHourEnd += atHourEnd;
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
    totalsIncomplete,
    recorded,
    carry,
  });
  report.reconcile = built.reconcile;
  if (totalsIncomplete) report.totalsIncomplete = true;
  summary.unclassified += built.unclassified;
  summary.ambiguousFormGroups += built.ambiguousFormGroups;
  summary.unrecordedFlags += built.elements.filter((e) =>
    e.reason.startsWith('unrecorded_server_form_'),
  ).length;
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

  if (built.elements.length === 0) {
    report.outcome = 'nothing_to_store';
    return null;
  }

  // THE CHECK AGAIN, RIGHT BEFORE THE WRITE. The writer adds on a repeat, so
  // an hour written twice shows every count doubled. Two runs can overlap (a
  // cron delivered twice, a call by hand during the scheduled run): both
  // find the hour unstored at the top, and the logs calls above take
  // seconds. Asking again here, with the same read, lets the later run see
  // the earlier one's rows and leave the hour alone. It narrows the gap to
  // the moment between this read and the write; it does not close it: two
  // runs that both pass this read before either writes still double the
  // hour. Closing that needs the check and the write in one database
  // function under the writer's lock (a later migration).
  const again = await alreadyStored(ctx, hour);
  if (!again.ok) return again.failure;
  if (again.value) {
    report.outcome = 'already_stored';
    summary.storedByAnotherRun += 1;
    return null;
  }

  const written = await writeHour(ctx, built.elements);
  if (!written.ok) return written.failure;
  // The writer skips an element it cannot read and says how many it stored.
  if (written.value === null || written.value < built.elements.length) summary.storedFewer += 1;
  const events = built.elements.reduce((s, e) => s + e.count, 0);
  report.outcome = 'stored';
  report.events = events;
  summary.hoursStored += 1;
  summary.elements += built.elements.length;
  summary.eventsStored += events;
  // What was stored as flagged, by reason: the run reports it (readAuthLogs).
  const flagged = built.elements.filter((e) => e.outcome === 'flagged');
  if (flagged.length > 0) summary.flaggedHours += 1;
  for (const e of flagged) {
    summary.flaggedStored[e.reason] = (summary.flaggedStored[e.reason] ?? 0) + e.count;
  }

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
  reconcile_read_failed: (f) =>
    `Our own record of refused web sign-ins could not be read to compare with Supabase's logs (code ${f.code ?? 'no_code'}); the hour is left for the next run`,
  db_read_failed: (f) =>
    `The security events record could not be read (code ${f.code ?? 'no_code'}); the hour is left for the next run`,
  writer_failed: (f) =>
    `The refused sign-ins of an hour could not be stored (code ${f.code ?? 'no_code'}); the hour is left for the next run`,
  out_of_time: () =>
    "Reading refused sign-ins from Supabase's logs stopped at its time limit; the hours left are read by the next run",
  unexpected: () =>
    "Reading refused sign-ins from Supabase's logs failed unexpectedly; the next run tries again",
};

interface Report {
  message: string;
  level: 'error' | 'warning';
  extra: Record<string, string | number>;
}

/**
 * Sends a run's reports, all at once, and waits for them
 * AUTH_LOGS_REPORTS_MAX_MS at most: a report that hangs cannot carry the run
 * past the limit of its route, and one that fails never reaches the caller.
 */
async function sendReports(reports: readonly Report[]): Promise<void> {
  if (reports.length === 0) return;
  const sent = Promise.all(
    reports.map(async ({ message, level, extra }) => {
      try {
        await reportError(new Error(message), { tag: AUTH_LOGS_TAG, level, extra });
      } catch {
        // A report that could not be sent is dropped: the run still answers.
      }
    }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, AUTH_LOGS_REPORTS_MAX_MS);
  });
  try {
    await Promise.race([sent, limit]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Failures that would repeat for every hour of the run, or leave no time for
 * one: the run stops at them. Any other failure is one hour's: the hours
 * after it are still tried.
 */
const RUN_STOPPING_CAUSES: readonly AuthLogsFailureCause[] = [
  'token_refused',
  'logs_query_error',
  'logs_unreachable',
  'out_of_time',
];

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
    await sendReports([
      {
        message:
          "The Supabase URL setting names no project, so refused sign-ins are not read from Supabase's logs",
        level: 'warning',
        extra: { cause: 'no_project' },
      },
    ]);
    return { skipped: 'no_project' };
  }
  if (typeof options.token !== 'string' || !HEADER_SAFE_RE.test(options.token)) {
    await sendReports([
      {
        message:
          'The Supabase logs token setting cannot be sent (it holds a space or a control character), so refused sign-ins are not read',
        level: 'warning',
        extra: { cause: 'token_unusable' },
      },
    ]);
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
    completeUntil: Math.floor((options.nowMs ?? started) / HOUR_MS) * HOUR_MS,
    totalsAnswers: new Map(),
  };

  // Each distinct failure of the run (its cause, status and code), with the
  // first hour it stopped and how many hours it stopped.
  const failures = new Map<string, { failure: AuthLogsFailure; hour: string; hours: number }>();
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
    if (!failure) continue;
    // The failed hour is left as it is and read again by the next run. One
    // bad hour does not hold up the newer ones: the run goes on, unless the
    // failure is one every hour would meet.
    hourReport.outcome = 'failed';
    hourReport.failure = failure;
    summary.ok = false;
    summary.failure ??= { ...failure, hour: hourLabel(hour) };
    const key = [failure.cause, failure.status ?? '', failure.code ?? ''].join(' ');
    const same = failures.get(key);
    if (same) same.hours += 1;
    else failures.set(key, { failure, hour: hourLabel(hour), hours: 1 });
    if (RUN_STOPPING_CAUSES.includes(failure.cause)) break;
  }

  // One report for each distinct failure, never one per hour.
  const reports: Report[] = [];
  for (const { failure, hour, hours: stopped } of failures.values()) {
    const { cause, status, code } = failure;
    reports.push({
      message: FAILURE_WORDS[cause](failure),
      // Both need someone to act: a new token, or a fix to the query.
      level: cause === 'token_refused' || cause === 'logs_query_error' ? 'error' : 'warning',
      extra: {
        cause,
        ...(status !== undefined ? { status } : {}),
        ...(code !== undefined ? { code } : {}),
        hour,
        hours: stopped,
        hoursStored: summary.hoursStored,
      },
    });
  }
  if (summary.reconcileIncomplete > 0) {
    reports.push({
      message:
        "The refused web sign-ins our server recorded in an hour could not all be read; that hour's lines in our server's form were compared with the part that was read, so a flagged count stored for it can be higher than what our server has no record of",
      level: 'warning',
      extra: { cause: 'reconcile_incomplete', hours: summary.reconcileIncomplete },
    });
  }
  if (summary.totalsIncomplete > 0) {
    reports.push({
      message:
        "The counts of an hour's refused sign-in requests, read from Supabase's logs, were not whole (the answer was full, or a row of it could not be read); the hour is given a flagged count (an hour that waits for the next run is given it by that run: `waiting` says how many), and its lines in our server's form were compared with the part that was read, so refusals our server has no record of can be missing from that hour",
      level: 'warning',
      extra: {
        cause: 'totals_incomplete',
        hours: summary.totalsIncomplete,
        full: summary.totalsCapped,
        rowsDropped: summary.totalsRowsDropped,
        waiting: summary.totalsIncompleteWaiting,
      },
    });
  }
  // A FLAGGED COUNT IS TOLD, NOT ONLY STORED. Every row this job stores has
  // no organization, so no organization's Blocked activity page shows it;
  // only the platform console's Security page does, among its newest
  // entries. A flagged count is what the job could not account for, and the
  // comparison with our own record only protects anyone if someone hears of
  // it: one warning for the run, with the events stored by reason.
  if (summary.flaggedHours > 0) {
    reports.push({
      message:
        "Flagged counts of refused sign-ins were stored. They have no organization, so no organization's Blocked activity page shows them; the platform console's Security page does. The counts by reason are in this report",
      level: 'warning',
      extra: { cause: 'flagged_stored', hours: summary.flaggedHours, ...summary.flaggedStored },
    });
  }
  if (summary.landedPastMinuteCaps > 0) {
    reports.push({
      message:
        'The refused sign-ins of an hour landed past the minute caps of the security events record; later runs may store that hour again',
      level: 'warning',
      extra: { cause: 'landed_past_minute_caps', hours: summary.landedPastMinuteCaps },
    });
  }
  if (summary.storedFewer > 0) {
    reports.push({
      message:
        'The security events record stored fewer of the refused sign-in counts of an hour than were sent to it (or did not say how many)',
      level: 'warning',
      extra: { cause: 'stored_fewer', hours: summary.storedFewer },
    });
  }
  await sendReports(reports);
  return summary;
}
