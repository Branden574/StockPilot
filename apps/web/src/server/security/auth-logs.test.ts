// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type ModelLogLine,
  parseReaderQuery,
  runReaderQueryOnLine,
} from '@/test/clickhouse-row-model';

/**
 * Security invariant: the reader of refused sign-ins from Supabase's gateway
 * log (server/security/auth-logs.ts) keeps the logs token to one place,
 * stores counts only, and lets no refusal disappear.
 *
 *   - the token is sent only as the Authorization header of a GET to
 *     https://api.supabase.com, and appears in no report, no answer and no
 *     log line, even when the logs service answers with a body that repeats
 *     the header;
 *   - the SQL is two constants with no value in them; the hour travels in the
 *     two timestamp parameters; the query returns a minute, a kind, a form, a
 *     status, a caller class, a network class, a country and a count, never
 *     an address, a raw log line, a path, a query string, a network owner's
 *     name or the raw client string;
 *   - the lines are read through a loose net (every refused POST whose
 *     decoded path, in small letters, holds `auth` and one of `token`,
 *     `factors` or `verify`), so no spelling of those paths that the gateway
 *     might route is left unread;
 *   - the kind is read the way the request is routed and the way the sign-in
 *     service reads it: the path as sent with repeated slashes as one, the
 *     FIRST decoded grant_type; known requests that check no password and no
 *     code are counted only; anything of an unknown form is stored as a
 *     flagged count, even one, and never taken for our own server, unless it
 *     was answered 404 (routed nowhere: counted only);
 *   - our own server is its exact client string AND a hosting network; its
 *     lines are not stored one by one, but their count is reconciled with
 *     what our own server recorded (every row of it, however many; overflow
 *     rows cover nothing), and 3 or more refusals it has no record of in an
 *     hour are stored as a flagged count; refusals at an hour's edge, which
 *     our server records in the next hour's first minute, are carried and
 *     not flagged, and the carry cannot cover a refusal our server did not
 *     make;
 *   - a flagged count that is stored is also reported, once for the run;
 *   - every returned field is checked before use, and a row that fails is
 *     dropped and counted; a network class that is not exactly `hosting` is
 *     `other` (fail closed);
 *   - a caller cannot fill the totals answer (it is grouped only by short
 *     lists of classes written in the query); totals that are not whole all
 *     the same (a full answer, a row that fails its checks) are never stored
 *     as if they were: the hour carries a flagged count and is reported;
 *   - a line stamped on the instant an hour ends never takes a row of the
 *     totals away, and is stored with the next hour's;
 *   - an hour is written once: an hour with rows of this job is not read
 *     again, an hour with nothing to store is read again by the next run, an
 *     hour whose reconciliation could not be read is not written, and the
 *     check is made again right before the write;
 *   - a failed hour does not hold up the newer ones; each distinct failure is
 *     reported once, in plain words and codes; an answer is read up to a size
 *     limit, and the reports cannot carry the run past its route's limit.
 *
 * Every value here is made up: the project ref, the token, the network owner
 * names (but the one prefix the query compares with), the ids and the counts.
 * The client strings are the public forms of the Supabase libraries.
 */

const MADE_UP_LOGS_VALUE = ['made', 'up', 'logs', 'value', '0451', 'never', 'real'].join('-');
const PROJECT_URL = 'https://madeupprojectref0000.supabase.co';
const PROJECT_REF = 'madeupprojectref0000';

type RecordedRow = {
  hour: string;
  /** The minute of the hour the row is on (30 when not said). */
  minute?: number;
  source: string;
  category: string;
  reason: string;
  n: number;
};
type ReadQuery = {
  table: string;
  select?: string;
  count?: string;
  filters: unknown[][];
  limit?: number;
  order?: [string, unknown];
  range?: [number, number];
};

const h = vi.hoisted(() => ({
  report: vi.fn(async (_err: unknown, _ctx: unknown) => undefined),
  /** Rows the fake writer stored: the hour start (ISO), the reason and the source. */
  stored: [] as Array<{ hour: string; reason: string; source: string }>,
  /** Rows our own server's recorder stored, for the reconciliation read. */
  recorded: [] as RecordedRow[],
  /** Every read of security_events, as it was built. */
  reads: [] as ReadQuery[],
  /** Replaces the answer of the "already stored" check. */
  readAnswer: null as null | ((q: ReadQuery) => { data: unknown; error: unknown }),
  /** Replaces the answer of a page of the reconciliation read. */
  recordedAnswer: null as
    | null
    | ((q: ReadQuery) => {
        data: unknown;
        error: unknown;
        count: number | null;
      }),
  /** The most rows the fake record returns for one read, as a server row cap would. */
  serverMaxRows: Infinity,
  rpc: vi.fn(),
}));

vi.mock('@/lib/error-reporter', () => ({ reportError: h.report }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from(table: string) {
      const q: ReadQuery = { table, filters: [] };
      const filter = (op: string, col: string) =>
        q.filters.find((f) => f[0] === op && f[1] === col);
      const listed = (col: string) => (filter('in', col)?.[2] as unknown[] | undefined) ?? [];
      const hourRead = () => String(filter('gte', 'minute')?.[2]);
      const builder = {
        select(cols: string, options?: { count?: string }) {
          q.select = cols;
          if (options?.count) q.count = options.count;
          return builder;
        },
        is(col: string, value: unknown) {
          q.filters.push(['is', col, value]);
          return builder;
        },
        in(col: string, values: unknown[]) {
          q.filters.push(['in', col, values]);
          return builder;
        },
        eq(col: string, value: unknown) {
          q.filters.push(['eq', col, value]);
          return builder;
        },
        gte(col: string, value: unknown) {
          q.filters.push(['gte', col, value]);
          return builder;
        },
        lt(col: string, value: unknown) {
          q.filters.push(['lt', col, value]);
          return builder;
        },
        limit(n: number) {
          q.limit = n;
          return builder;
        },
        order(col: string, options?: unknown) {
          q.order = [col, options];
          return builder;
        },
        range(from: number, to: number) {
          q.range = [from, to];
          return builder;
        },
        abortSignal() {
          return builder;
        },
        then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
          h.reads.push(q);
          let answer: unknown;
          if (q.select === 'id') {
            // A row matches the way the database would: its hour, and its
            // reason and source among the ones the read lists.
            answer = h.readAnswer
              ? h.readAnswer(q)
              : {
                  data: h.stored.some(
                    (row) =>
                      row.hour === hourRead() &&
                      listed('reason').includes(row.reason) &&
                      listed('source').includes(row.source),
                  )
                    ? [{ id: '5eed0000-0000-4000-8000-00000000000a' }]
                    : [],
                  error: null,
                };
          } else {
            // A row matches by its own minute, inside the window the read asks for.
            const windowFrom = Date.parse(String(filter('gte', 'minute')?.[2]));
            const windowTo = Date.parse(String(filter('lt', 'minute')?.[2]));
            const minuteOfRow = (row: RecordedRow) =>
              Date.parse(row.hour) + (row.minute ?? 30) * 60_000;
            const rows = h.recorded
              .filter(
                (row) =>
                  minuteOfRow(row) >= windowFrom &&
                  minuteOfRow(row) < windowTo &&
                  listed('source').includes(row.source) &&
                  row.category === filter('eq', 'category')?.[2] &&
                  listed('reason').includes(row.reason),
              )
              .map((row) => ({ source: row.source, reason: row.reason, event_count: row.n }));
            // One page, as the database would cut it: the range asked for,
            // and never more rows than the server's own cap. The count of
            // every matching row comes only when it was asked for.
            const [from, to] = q.range ?? [0, Infinity];
            const page = rows.slice(from, Math.min(to + 1, from + h.serverMaxRows));
            answer = h.recordedAnswer
              ? h.recordedAnswer(q)
              : { data: page, error: null, count: q.count === 'exact' ? rows.length : null };
          }
          return Promise.resolve(answer).then(resolve, reject);
        },
      };
      return builder;
    },
    rpc(name: string, args: unknown) {
      return { abortSignal: (signal: AbortSignal) => h.rpc(name, args, signal) };
    },
  }),
}));

import * as logs from './auth-logs';

const {
  AUTH_LOGS_GROUPS_SQL,
  AUTH_LOGS_TOTALS_SQL,
  AUTH_LOGS_REASONS,
  AUTH_LOGS_ROW_LIMIT,
  AUTH_LOGS_MAX_ELEMENTS,
  AUTH_LOGS_MAX_COUNT,
  AUTH_LOGS_HOURS_PER_RUN,
  AUTH_LOGS_UNCLASSIFIED_FLAG_AT,
  AUTH_LOGS_UNRECORDED_FLAG_AT,
  AUTH_LOGS_RECONCILE_PAGE_ROWS,
  AUTH_LOGS_RECONCILE_MAX_PAGES,
  AUTH_LOGS_RUN_DEADLINE_MS,
  AUTH_LOGS_REPORTS_MAX_MS,
  buildHourElements,
  classifyAuthLogLine,
  hourEdgeCarry,
  hoursToRead,
  isGroupRowOfNextHour,
  parseGroupRow,
  parseLogsTime,
  parseTotalsRow,
  readAuthLogs,
  serverFormRefusals,
  supabaseProjectRef,
} = logs;

const MIN = 60_000;
const HOUR = 3_600_000;
/** Every kind the queries answer. */
const ALL_KINDS = [
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
/** 2026-11-21 10:10 UTC: the run reads 04:00 to 10:00. */
const NOW = Date.UTC(2026, 10, 21, 10, 10);
const H04 = Date.UTC(2026, 10, 21, 4);
const hourAt = (startMs: number) => ({ startMs, endMs: startMs + HOUR });
const iso = (ms: number) => new Date(ms).toISOString();
/** A time as the query prints it: toString of a UTC time, '2026-11-21 04:05:00'. */
const chTime = (ms: number) => iso(ms).replace('T', ' ').slice(0, 19);
/** The minute `m` of the hour starting at `startMs`, as the query prints it. */
const minuteOf = (startMs: number, m: number) => chTime(startMs + m * MIN);

/** The two client strings our own server sends (the public forms of the Supabase libraries). */
const SERVER_SSR = 'supabase-ssr/0.12.7 createServerClient';
const SERVER_NODE = 'supabase-js/2.116.0; runtime=node; runtime-version=24.22.3';

type Raw = Record<string, unknown>;
const groupRow = (over: Raw = {}, startMs = H04): Raw => ({
  minute: minuteOf(startMs, 5),
  kind: 'password',
  status: '400',
  caller: 'phone',
  network: 'other',
  country: 'NL',
  n: 3,
  ...over,
});
const totalsRow = (over: Raw = {}, startMs = H04): Raw => ({
  kind: 'password',
  forms: 'plain',
  status: '400',
  caller: 'phone',
  network: 'other',
  first_seen: chTime(startMs + 10_000),
  last_seen: chTime(startMs + 3_000_000),
  n: 3,
  ...over,
});
/** Lines of our own server's form (its client string from a hosting network). */
const ours = { caller: 'server', network: 'hosting' };
/** The totals rows the groups add up to (the service's second answer for the same lines). */
function totalsFrom(groups: Raw[], startMs = H04): Raw[] {
  const by = new Map<string, Raw>();
  for (const g of groups) {
    const key = [g.kind, g.status, g.caller, g.network].join(' ');
    const same = by.get(key);
    if (same) same.n = Number(same.n) + Number(g.n);
    else
      by.set(
        key,
        totalsRow(
          { kind: g.kind, status: g.status, caller: g.caller, network: g.network, n: g.n },
          startMs,
        ),
      );
  }
  return [...by.values()];
}
/** A row our own server's recorder stored for the hour starting at `startMs`. */
function recordWeb(startMs: number, reason: string, n: number, over: Partial<RecordedRow> = {}) {
  h.recorded.push({
    hour: iso(startMs),
    source: 'web',
    category: 'password_guessing',
    reason,
    n,
    ...over,
  });
}

// ── The logs service, faked ─────────────────────────────────────────────────

type Answer = (init: RequestInit) => Response | Promise<Response>;
const fetches: Array<{ url: string; init: RequestInit }> = [];
/** `groups@<hour start ISO>` or `totals@<hour start ISO>` -> how the service answers. */
const answers = new Map<string, Answer>();
const ok =
  (rows: unknown[]): Answer =>
  () =>
    new Response(JSON.stringify({ result: rows, error: null }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
const status =
  (code: number, body = ''): Answer =>
  () =>
    new Response(body, { status: code });
const never: Answer = (init) =>
  new Promise((_, reject) => {
    init.signal?.addEventListener(
      'abort',
      () => reject(new DOMException('aborted', 'AbortError')),
      {
        once: true,
      },
    );
  });
/** Both answers of one hour: its groups, and the totals they add up to. */
function hourAnswers(
  startMs: number,
  groups: unknown[],
  totals: unknown[] = totalsFrom(groups as Raw[], startMs),
) {
  answers.set(`groups@${iso(startMs)}`, ok(groups));
  answers.set(`totals@${iso(startMs)}`, ok(totals));
}

const fakeFetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = String(input);
  fetches.push({ url, init });
  const u = new URL(url);
  const sql = u.searchParams.get('sql');
  const which =
    sql === AUTH_LOGS_GROUPS_SQL ? 'groups' : sql === AUTH_LOGS_TOTALS_SQL ? 'totals' : 'other';
  const answer = answers.get(`${which}@${u.searchParams.get('iso_timestamp_start')}`) ?? ok([]);
  return answer(init);
}) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

const sqlOf = (f: { url: string }) => new URL(f.url).searchParams.get('sql');
const startOf = (f: { url: string }) => new URL(f.url).searchParams.get('iso_timestamp_start');

/** The writer, faked: stores each element's hour, reason and source, and answers how many it took. */
function writerStores() {
  h.rpc.mockImplementation(
    async (
      _name: string,
      args: { p_events: Array<{ at_ms: number; reason: string; source: string }> },
    ) => {
      for (const e of args.p_events) {
        h.stored.push({
          hour: iso(Math.floor(e.at_ms / HOUR) * HOUR),
          reason: e.reason,
          source: e.source,
        });
      }
      return { data: args.p_events.length, error: null };
    },
  );
}
const written = (call = 0) =>
  (h.rpc.mock.calls[call]![1] as { p_events: Array<Record<string, unknown>> }).p_events;
const reconcileReads = () => h.reads.filter((q) => q.select !== 'id');

const run = (over: Partial<Parameters<typeof readAuthLogs>[0]> = {}) =>
  readAuthLogs({
    token: MADE_UP_LOGS_VALUE,
    supabaseUrl: PROJECT_URL,
    nowMs: NOW,
    fetch: fakeFetch,
    ...over,
  });

/** The reports of a run that carry this cause. */
const reportsOf = (cause: string) =>
  h.report.mock.calls.filter(
    ([, ctx]) => (ctx as { extra?: { cause?: string } }).extra?.cause === cause,
  );
/** The causes of every report of a run, in the order they were sent. */
const reportCauses = () =>
  h.report.mock.calls.map(([, ctx]) => (ctx as { extra?: { cause?: string } }).extra?.cause);

/** A run's answer when it ran (not skipped). */
const full = (s: unknown) => s as logs.AuthLogsRunSummary;

/** Everything this job said: reports, and what it returned. */
function everythingSaid(summary: unknown): string {
  return JSON.stringify([
    summary,
    h.report.mock.calls.map(([e, c]) => [String(e), (e as Error)?.stack, c]),
  ]);
}

beforeEach(() => {
  h.report.mockReset();
  h.report.mockImplementation(async () => undefined);
  h.stored.length = 0;
  h.recorded.length = 0;
  h.reads.length = 0;
  h.readAnswer = null;
  h.recordedAnswer = null;
  h.serverMaxRows = Infinity;
  h.rpc.mockReset();
  writerStores();
  fetches.length = 0;
  answers.clear();
  fakeFetch.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── The project ref ─────────────────────────────────────────────────────────

describe('the project ref comes from the Supabase URL setting', () => {
  it.each([
    [PROJECT_URL, PROJECT_REF],
    [`${PROJECT_URL}/`, PROJECT_REF],
    ['https://abcd1234.supabase.co', 'abcd1234'],
  ])('%s -> %s', (url, ref) => {
    expect(supabaseProjectRef(url)).toBe(ref);
  });

  it.each([
    ['the lab', 'http://127.0.0.1:54321'],
    ['not https', 'http://madeupprojectref0000.supabase.co'],
    ['another host', 'https://auth.example.com'],
    ['a longer host', 'https://madeupprojectref0000.supabase.co.example.com'],
    ['a deeper host', 'https://a.madeupprojectref0000.supabase.co'],
    ['another port', 'https://madeupprojectref0000.supabase.co:8443'],
    ['user info', 'https://someone@madeupprojectref0000.supabase.co'],
    ['a ref with a dash', 'https://made-up-ref-000.supabase.co'],
    ['a short ref', 'https://abc.supabase.co'],
    ['empty', ''],
    ['not a url', 'madeupprojectref0000'],
    ['not a string', 42],
  ])('%s -> null', (_what, url) => {
    expect(supabaseProjectRef(url)).toBeNull();
  });
});

// ── The hour planner ────────────────────────────────────────────────────────

describe('the hours a run reads', () => {
  it('the last six complete UTC hours, oldest first', () => {
    expect(hoursToRead(NOW)).toEqual(
      [4, 5, 6, 7, 8, 9].map((hh) => hourAt(Date.UTC(2026, 10, 21, hh))),
    );
    expect(AUTH_LOGS_HOURS_PER_RUN).toBe(6);
  });

  it('an hour that ended this instant is complete; the running hour never is', () => {
    const at10 = Date.UTC(2026, 10, 21, 10);
    expect(hoursToRead(at10).at(-1)).toEqual(hourAt(Date.UTC(2026, 10, 21, 9)));
    expect(hoursToRead(at10 - 1).at(-1)).toEqual(hourAt(Date.UTC(2026, 10, 21, 8)));
  });

  it('the oldest minute read is well inside the 26 hours the writer accepts', () => {
    const oldest = hoursToRead(NOW)[0]!;
    expect(NOW - oldest.startMs).toBeLessThan(8 * HOUR);
  });
});

// ── The mapping ─────────────────────────────────────────────────────────────

describe('the mapping from a log line to an event', () => {
  /** A line as the checks would pass it (kind and caller are checked before the mapping sees them). */
  const line = (kind: string, status: string, caller: string, network = 'other') =>
    ({ kind, status, caller, network }) as logs.AuthLogsLine;

  it.each([
    ['password', '400', 'phone', 'other', 'password_guessing', 'wrong_password', 'phone'],
    // Every caller that is not the phone app or our server is `other`: a
    // browser, a tool, no client string at all.
    ['password', '400', 'other', 'other', 'password_guessing', 'wrong_password', 'api'],
    // A hosting network makes only our server's client string ours. (The
    // queries answer `hosting` for that string alone; any other pair is read
    // as it would be from any network.)
    ['password', '400', 'phone', 'hosting', 'password_guessing', 'wrong_password', 'phone'],
    ['password', '400', 'other', 'hosting', 'password_guessing', 'wrong_password', 'api'],
    // Our server's client string from any other network: dressed up as our server.
    ['password', '400', 'server', 'other', 'password_guessing', 'wrong_password', 'api'],
    ['verify', '422', 'phone', 'other', 'password_guessing', 'wrong_code', 'phone'],
    ['verify', '422', 'other', 'other', 'password_guessing', 'wrong_code', 'api'],
    ['verify', '422', 'server', 'other', 'password_guessing', 'wrong_code', 'api'],
    ['password', '429', 'phone', 'other', 'bots', 'auth_rate_limited', 'phone'],
    ['password', '429', 'server', 'other', 'bots', 'auth_rate_limited', 'api'],
    ['verify', '429', 'other', 'other', 'bots', 'auth_rate_limited', 'api'],
  ])(
    '%s %s from %s on a %s network -> %s / %s / %s',
    (kind, st, caller, network, category, reason, source) => {
      expect(classifyAuthLogLine(line(kind, st, caller, network))).toEqual({
        store: true,
        category,
        reason,
        source,
      });
    },
  );

  it.each([
    ['password', '404'],
    ['password', '422'],
    // Every refused status the job does not act on (401, 403, ...) is the class `other`.
    ['password', 'other'],
    // A wrong code is 422 (measured); a 400 there was not seen, so its meaning is not known.
    ['verify', '400'],
    ['verify', '404'],
    ['verify', 'other'],
  ])('%s %s is not stored: an unknown meaning is not shown as an attack', (kind, st) => {
    expect(classifyAuthLogLine(line(kind, st, 'phone'))).toEqual({
      store: false,
      why: 'other_status',
    });
  });

  it.each([
    ['400', 'phone', 'other'],
    ['429', 'phone', 'other'],
    ['other', 'other', 'other'],
    ['400', 'server', 'other'],
  ])(
    'a refresh answered %s from %s is an ordinary expired session: counted, never stored',
    (st, caller, network) => {
      expect(classifyAuthLogLine(line('refresh', st, caller, network))).toEqual({
        store: false,
        why: 'refresh',
      });
    },
  );

  it.each([
    ['400', 'phone', 'other'],
    ['429', 'other', 'other'],
    ['other', 'server', 'other'],
  ])(
    'a known grant that is not a password, answered %s from %s: counted, never stored',
    (st, caller, network) => {
      expect(classifyAuthLogLine(line('token_known_other', st, caller, network))).toEqual({
        store: false,
        why: 'known_other',
      });
    },
  );

  it.each([
    ['token_other', '400', 'phone', 'other', 'phone'],
    ['token_other', '429', 'other', 'other', 'api'],
    ['token_other', 'other', 'other', 'other', 'api'],
    ['verify_other', '422', 'phone', 'other', 'phone'],
    ['verify_other', '429', 'other', 'other', 'api'],
    ['emailed_code_other', '422', 'other', 'other', 'api'],
    ['emailed_code_other', 'other', 'phone', 'other', 'phone'],
    // Never taken for our own server.
    ['token_other', '400', 'server', 'hosting', 'api'],
    ['verify_other', '422', 'server', 'hosting', 'api'],
    ['emailed_code_other', 'other', 'server', 'hosting', 'api'],
  ])(
    '%s %s from %s on a %s network is of an unknown form: counted for a flagged count from %s',
    (kind, st, caller, network, source) => {
      expect(classifyAuthLogLine(line(kind, st, caller, network))).toEqual({
        store: false,
        why: 'unclassified',
        source,
      });
    },
  );

  it.each([
    ['token_other', 'phone', 'other'],
    ['verify_other', 'other', 'other'],
    ['emailed_code_other', 'other', 'hosting'],
    ['token_other', 'server', 'hosting'],
    ['verify_other', 'server', 'other'],
  ])(
    '%s answered 404 from %s on a %s network: the service routed it nowhere and checked nothing, so it is counted only',
    (kind, caller, network) => {
      expect(classifyAuthLogLine(line(kind, '404', caller, network))).toEqual({
        store: false,
        why: 'not_routed',
      });
    },
  );

  // Measured on 2026-11-21: a wrong emailed code is answered 403, which the
  // totals answer as the class `other`.
  it.each([
    ['other', 'other', 'other'],
    ['400', 'phone', 'other'],
    ['429', 'other', 'hosting'],
    ['404', 'other', 'other'],
  ])(
    "a refused check of an emailed code answered %s from %s: counted, not stored until our own server's emailed-code refusals are recorded",
    (st, caller, network) => {
      expect(classifyAuthLogLine(line('emailed_code', st, caller, network))).toEqual({
        store: false,
        why: 'emailed_code',
      });
    },
  );

  it.each([
    ['422', 'phone', 'other'],
    ['400', 'other', 'other'],
    ['404', 'other', 'other'],
  ])(
    'a refused request to enrol a factor or to ask for a challenge, answered %s from %s: no secret is checked there, counted only',
    (st, caller, network) => {
      expect(classifyAuthLogLine(line('factors_known_other', st, caller, network))).toEqual({
        store: false,
        why: 'known_other',
      });
    },
  );

  it('our own server is its client string AND a hosting network: its known kinds are not stored one by one', () => {
    for (const kind of [
      'password',
      'verify',
      'refresh',
      'token_known_other',
      'factors_known_other',
      'emailed_code',
    ])
      for (const st of ['400', '422', '429', 'other']) {
        expect(classifyAuthLogLine(line(kind, st, 'server', 'hosting')), `${kind} ${st}`).toEqual({
          store: false,
          why: 'our_server',
        });
      }
    // The same client string from another network is not ours.
    expect(classifyAuthLogLine(line('password', '400', 'server', 'other')).store).toBe(true);
  });

  it('nothing the mapping answers is outside the job reasons and the two sources', () => {
    const reasons = new Set<string>();
    const sources = new Set<string>();
    for (const kind of ALL_KINDS)
      for (const st of ['400', '404', '422', '429', 'other'])
        for (const caller of ['phone', 'server', 'other'])
          for (const network of ['hosting', 'other']) {
            const v = classifyAuthLogLine(line(kind, st, caller, network));
            if (v.store) reasons.add(v.reason);
            if (v.store || v.why === 'unclassified') sources.add(v.source);
          }
    expect([...reasons].every((r) => (AUTH_LOGS_REASONS as readonly string[]).includes(r))).toBe(
      true,
    );
    expect([...sources].sort()).toEqual(['api', 'phone']);
  });
});

// ── Validation ──────────────────────────────────────────────────────────────

describe('every returned field is checked before use', () => {
  const hour = hourAt(H04);

  it('a time is read in the form the query prints it, as UTC', () => {
    expect(parseLogsTime('2026-11-21 04:05:00')).toBe(H04 + 5 * MIN);
    expect(parseLogsTime('2026-11-21 04:05:00.000')).toBe(H04 + 5 * MIN);
    expect(parseLogsTime('2026-11-21 04:05:07.250000')).toBe(H04 + 5 * MIN + 7_250);
    // The form the logs service printed on 2026-11-21: nine digits after the second.
    expect(parseLogsTime('2026-11-21 18:39:35.412000000')).toBe(
      Date.UTC(2026, 10, 21, 18, 39, 35, 412),
    );
    for (const bad of [
      '2026-11-21T04:05:00Z',
      '2026-11-21T04:05:00',
      '2026-11-21 04:05:00Z',
      '2026-11-21 04:05:00+01:00',
      '2026-11-21 4:05:00',
      '2026-11-21 04:05',
      '2026-11-31 04:05:00',
      '2026-13-01 04:05:00',
      '2026-11-21 24:05:00',
      '2026-11-21 04:60:00',
      ' 2026-11-21 04:05:00',
      '',
      'five past',
      (H04 + 5 * MIN) / 1000,
      null,
      undefined,
    ]) {
      expect(parseLogsTime(bad), String(bad)).toBeNull();
    }
  });

  it('a good row', () => {
    expect(parseGroupRow(groupRow(), hour)).toEqual({
      minuteMs: H04 + 5 * MIN,
      kind: 'password',
      status: '400',
      caller: 'phone',
      network: 'other',
      country: 'NL',
      n: 3,
    });
    expect(
      parseGroupRow(
        groupRow({ minute: minuteOf(H04, 59), kind: 'verify', n: '12', country: '' }),
        hour,
      ),
    ).toEqual({
      minuteMs: H04 + 59 * MIN,
      kind: 'verify',
      status: '400',
      caller: 'phone',
      network: 'other',
      country: '',
      n: 12,
    });
  });

  it.each([
    ['hosting', 'hosting'],
    ['other', 'other'],
    ['Hosting', 'other'],
    ['hosting ', 'other'],
    ['', 'other'],
    ['Amazon', 'other'],
    [1, 'other'],
    [true, 'other'],
    [null, 'other'],
    [undefined, 'other'],
  ])('a network class %j is read as %s: anything not exactly hosting is other', (network, cls) => {
    expect(parseGroupRow(groupRow({ caller: 'server', network }), hour)?.network).toBe(cls);
    expect(parseTotalsRow(totalsRow({ caller: 'server', network }), hour)?.network).toBe(cls);
  });

  it.each([
    ['ambiguous', true],
    ['plain', false],
    ['Ambiguous', false],
    ['', false],
    [undefined, false],
  ])(
    'a group whose forms come back as %j: held a line of an ambiguous form, %s (counted in the log line only)',
    (forms, read) => {
      expect(parseTotalsRow(totalsRow({ forms }), hour)?.ambiguous).toBe(read);
    },
  );

  it.each([['400'], ['404'], ['422'], ['429'], ['other']])(
    'the status class %j is one the queries answer',
    (status) => {
      expect(parseGroupRow(groupRow({ status }), hour)?.status).toBe(status);
      expect(parseTotalsRow(totalsRow({ status }), hour)?.status).toBe(status);
    },
  );

  it.each([['phone'], ['server'], ['other']])(
    'the caller class %j is one the queries answer',
    (caller) => {
      expect(parseGroupRow(groupRow({ caller }), hour)?.caller).toBe(caller);
      expect(parseTotalsRow(totalsRow({ caller }), hour)?.caller).toBe(caller);
    },
  );

  it.each([
    ['not an object', 'row'],
    ['null', null],
    ['an array', [1, 2]],
    ['a minute before the hour', groupRow({ minute: minuteOf(H04, -1) })],
    ['a minute at the hour end', groupRow({ minute: minuteOf(H04, 60) })],
    ['a minute not on a minute', groupRow({ minute: chTime(H04 + 5 * MIN + 30_000) })],
    ['a minute with a fraction', groupRow({ minute: `${minuteOf(H04, 5)}.5` })],
    ['a minute in another form', groupRow({ minute: iso(H04 + 5 * MIN) })],
    ['a minute in seconds', groupRow({ minute: (H04 + 5 * MIN) / 1000 })],
    ['a minute that is text', groupRow({ minute: 'five past' })],
    ['no minute', groupRow({ minute: undefined })],
    ['another kind', groupRow({ kind: 'token' })],
    ['a kind in capitals', groupRow({ kind: 'Password' })],
    ['a two-digit status', groupRow({ status: '40' })],
    ['a four-digit status', groupRow({ status: '4000' })],
    ['a status that is text', groupRow({ status: 'bad' })],
    ['a status as a number', groupRow({ status: 400 })],
    ['a status that is not one of the five classes', groupRow({ status: '401' })],
    ['a status class in capitals', groupRow({ status: 'Other' })],
    ['an unknown caller', groupRow({ caller: 'Phone' })],
    ['a caller class the queries do not answer', groupRow({ caller: 'browser' })],
    ['no caller class', groupRow({ caller: '' })],
    ['a lower-case country', groupRow({ country: 'nl' })],
    ['a three-letter country', groupRow({ country: 'NLD' })],
    ['a country with a digit', groupRow({ country: 'T1' })],
    ['the unknown country', groupRow({ country: 'XX' })],
    ['a count of zero', groupRow({ n: 0 })],
    ['a negative count', groupRow({ n: -2 })],
    ['a count that is not whole', groupRow({ n: 1.5 })],
    ['a count that is text', groupRow({ n: 'many' })],
    ['no count', groupRow({ n: undefined })],
  ])('dropped: %s', (_what, raw) => {
    expect(parseGroupRow(raw, hour)).toBeNull();
  });

  it('a totals row: every kind the query answers, first and last inside the hour, or dropped', () => {
    expect(parseTotalsRow(totalsRow(), hour)).toEqual({
      kind: 'password',
      ambiguous: false,
      status: '400',
      caller: 'phone',
      network: 'other',
      n: 3,
    });
    for (const kind of ALL_KINDS)
      expect(parseTotalsRow(totalsRow({ kind }), hour)?.kind).toBe(kind);
    expect(
      parseTotalsRow(totalsRow({ first_seen: '2026-11-21 04:00:00.000001' }), hour),
    ).not.toBeNull();
    expect(parseTotalsRow(totalsRow({ first_seen: chTime(H04 - 1_000) }), hour)).toBeNull();
    expect(parseTotalsRow(totalsRow({ last_seen: chTime(H04 + HOUR + 1_000) }), hour)).toBeNull();
    expect(
      parseTotalsRow(totalsRow({ last_seen: '2026-11-21 05:00:00.001000000' }), hour),
    ).toBeNull();
    expect(
      parseTotalsRow(
        totalsRow({ first_seen: chTime(H04 + 50_000), last_seen: chTime(H04 + 40_000) }),
        hour,
      ),
    ).toBeNull();
    expect(parseTotalsRow(totalsRow({ first_seen: H04 / 1000 + 10 }), hour)).toBeNull();
    expect(parseTotalsRow(totalsRow({ kind: 'token' }), hour)).toBeNull();
    expect(parseTotalsRow(totalsRow({ status: '4x9' }), hour)).toBeNull();
    expect(parseTotalsRow(totalsRow({ status: '403' }), hour)).toBeNull();
    expect(parseTotalsRow(totalsRow({ caller: 'none' }), hour)).toBeNull();
    expect(parseTotalsRow(totalsRow({ n: 0 }), hour)).toBeNull();
  });
});

// ── Building the writer's elements ──────────────────────────────────────────

describe("the hour's end: a line stamped on the instant an hour ends belongs to the next hour", () => {
  const hour = hourAt(H04);
  const END = '2026-11-21 05:00:00.000000000';

  it('a totals row whose last line is on that instant is kept whole, its count used as it is', () => {
    // Whether the logs service answers such a line for this hour or not, it
    // can never take a whole row of the totals away: one line more in an
    // hour is the safe direction.
    expect(parseTotalsRow(totalsRow({ ...ours, n: 41, last_seen: END }), hour)).toEqual({
      kind: 'password',
      ambiguous: false,
      status: '400',
      caller: 'server',
      network: 'hosting',
      n: 41,
    });
    expect(parseTotalsRow(totalsRow({ last_seen: chTime(H04 + HOUR) }), hour)?.n).toBe(3);
    // A group made only of such lines is kept too.
    expect(parseTotalsRow(totalsRow({ first_seen: END, last_seen: END, n: 1 }), hour)?.n).toBe(1);
    // Anything later is not of this hour's answer at all.
    expect(
      parseTotalsRow(totalsRow({ last_seen: '2026-11-21 05:00:00.001000000' }), hour),
    ).toBeNull();
  });

  it('a group row at the minute the hour ends is of the next hour: not a row of this one, and told apart from a row that fails its checks', () => {
    const atEnd = groupRow({ minute: minuteOf(H04, 60), n: 4 });
    expect(parseGroupRow(atEnd, hour)).toBeNull();
    expect(isGroupRowOfNextHour(atEnd, hour)).toBe(true);
    // Its own hour reads it as an ordinary row of its first minute.
    expect(parseGroupRow(atEnd, hourAt(H04 + HOUR))).toMatchObject({ minuteMs: H04 + HOUR, n: 4 });
    for (const other of [
      groupRow(),
      groupRow({ minute: minuteOf(H04, 61) }),
      groupRow({ minute: minuteOf(H04, -1) }),
      groupRow({ minute: minuteOf(H04, 60), status: 'x' }),
      groupRow({ minute: minuteOf(H04, 60), n: 0 }),
      groupRow({ minute: `${minuteOf(H04, 60)}.5` }),
      'junk',
      null,
    ]) {
      expect(isGroupRowOfNextHour(other, hour), JSON.stringify(other)).toBe(false);
    }
  });
});

describe("one hour's elements for the writer", () => {
  const hour = hourAt(H04);
  const parsed = (rows: Raw[]) => rows.map((r) => parseGroupRow(r, hour)!);
  const totalsOf = (rows: Raw[]) => rows.map((r) => parseTotalsRow(r, hour)!);
  /** The elements of an hour whose groups were complete. */
  const build = (
    groups: Raw[],
    totals: Raw[] = totalsFrom(groups),
    recorded: logs.AuthLogsRecorded | null = null,
  ) =>
    buildHourElements({
      hour,
      groups: parsed(groups),
      groupsCapped: false,
      groupsDropped: 0,
      totals: totalsOf(totals),
      recorded,
    });

  it('counts, a minute, a country when known; never an organization, a city or a source hash', () => {
    const { elements } = build([
      groupRow({ minute: minuteOf(H04, 7), caller: 'phone', country: 'NL', n: 2 }),
      groupRow({ minute: minuteOf(H04, 7), caller: 'other', country: '', n: 5 }),
    ]);
    expect(elements).toEqual([
      {
        category: 'password_guessing',
        outcome: 'blocked',
        reason: 'wrong_password',
        source: 'api',
        count: 5,
        at_ms: H04 + 7 * MIN,
      },
      {
        category: 'password_guessing',
        outcome: 'blocked',
        reason: 'wrong_password',
        source: 'phone',
        count: 2,
        at_ms: H04 + 7 * MIN,
        country: 'NL',
      },
    ]);
    for (const e of elements) {
      expect(
        Object.keys(e).every((k) =>
          ['category', 'outcome', 'reason', 'source', 'count', 'at_ms', 'country'].includes(k),
        ),
      ).toBe(true);
    }
  });

  it('lines that land on the same row are one element with the counts added', () => {
    const { elements } = build([
      groupRow({ caller: 'other', n: 2 }),
      groupRow({ caller: 'other', country: 'NL', n: 7 }),
      groupRow({ caller: 'server', network: 'other', n: 1 }),
    ]);
    expect(elements).toHaveLength(1);
    expect(elements[0]).toMatchObject({ source: 'api', count: 10, country: 'NL' });
  });

  it("our own server's lines, refreshes, known grants and statuses with no known meaning are counted, not stored", () => {
    const out = build(
      [
        groupRow({ ...ours, n: 4 }),
        groupRow({ status: '404', n: 2 }),
        groupRow({ caller: 'phone', n: 1 }),
      ],
      [
        totalsRow({ ...ours, n: 4 }),
        totalsRow({ status: '404', n: 2 }),
        totalsRow({ caller: 'phone', n: 1 }),
        totalsRow({ kind: 'refresh', caller: 'other', n: 40 }),
        totalsRow({ kind: 'token_known_other', caller: 'phone', n: 30 }),
        totalsRow({ kind: 'token_known_other', ...ours, n: 6 }),
      ],
      { password: 4, code: 0, overflow: 0, complete: true },
    );
    expect(out.elements.map((e) => [e.source, e.count])).toEqual([['phone', 1]]);
    expect(out.notStored).toEqual({
      our_server: 10,
      other_status: 2,
      refresh: 40,
      known_other: 30,
      emailed_code: 0,
      not_routed: 0,
    });
    expect(out.seen).toEqual({
      'password 400 phone other': 1,
      'password 400 server hosting': 4,
      'password 404 phone other': 2,
      'refresh 400 other other': 40,
      'token_known_other 400 phone other': 30,
      'token_known_other 400 server hosting': 6,
    });
  });

  it("our server's client string from another network is stored as api; from a hosting network it is ours", () => {
    const out = build(
      [
        groupRow({ ...ours, n: 4 }),
        groupRow({ caller: 'server', network: 'other', n: 6, country: 'US' }),
      ],
      undefined,
      { password: 4, code: 0, overflow: 0, complete: true },
    );
    expect(out.elements).toEqual([
      expect.objectContaining({ reason: 'wrong_password', source: 'api', count: 6, country: 'US' }),
    ]);
    expect(out.notStored.our_server).toBe(4);
  });

  it('several grant_type values or a repeated slash: classed as the plain form is, and the groups that held one are counted', () => {
    const out = build(
      [groupRow({ n: 2 })],
      [
        totalsRow({ n: 2, forms: 'ambiguous' }),
        totalsRow({ kind: 'refresh', forms: 'ambiguous' }),
        totalsRow({ kind: 'token_known_other', n: 9 }),
      ],
    );
    expect(out.elements).toEqual([expect.objectContaining({ reason: 'wrong_password', count: 2 })]);
    expect(out.ambiguousFormGroups).toBe(2);
  });

  describe('requests of an unknown form: never invisible, one flagged count per source, even for one', () => {
    const flaggedOf = (out: logs.AuthLogsHourElements) =>
      out.elements.filter((e) => e.reason === 'unclassified_sign_in_refusals');

    it('one line stores one flagged element of count 1', () => {
      expect(AUTH_LOGS_UNCLASSIFIED_FLAG_AT).toBe(1);
      const out = build([], [totalsRow({ kind: 'token_other', caller: 'other', n: 1 })]);
      expect(out.elements).toEqual([
        {
          category: 'password_guessing',
          outcome: 'flagged',
          reason: 'unclassified_sign_in_refusals',
          source: 'api',
          count: 1,
          at_ms: H04,
        },
      ]);
      expect(out.unclassified).toBe(1);
    });

    it('the source is the caller class as usual; our own server form is never suppressed', () => {
      const out = build(
        [groupRow({ n: 2 })],
        [
          totalsRow({ n: 2 }),
          totalsRow({ kind: 'token_other', caller: 'phone', n: 12 }),
          totalsRow({ kind: 'verify_other', status: '422', caller: 'phone', n: 3 }),
          totalsRow({ kind: 'token_other', caller: 'other', n: 7 }),
          totalsRow({ kind: 'token_other', ...ours, n: 5 }),
        ],
      );
      expect(flaggedOf(out)).toEqual([
        expect.objectContaining({ outcome: 'flagged', source: 'api', count: 12, at_ms: H04 }),
        expect.objectContaining({ outcome: 'flagged', source: 'phone', count: 15, at_ms: H04 }),
      ]);
      expect(out.unclassified).toBe(27);
      // The ordinary elements are unchanged.
      expect(out.elements.filter((e) => e.outcome === 'blocked')).toEqual([
        expect.objectContaining({ reason: 'wrong_password', count: 2 }),
      ]);
    });

    it('an unknown form answered 404 is counted, not flagged; any other refused status of it is flagged', () => {
      const out = build(
        [],
        [
          totalsRow({ kind: 'token_other', status: '404', caller: 'other', n: 30 }),
          totalsRow({ kind: 'verify_other', status: '404', caller: 'phone', n: 4 }),
          totalsRow({ kind: 'token_other', status: '400', caller: 'other', n: 1 }),
          totalsRow({ kind: 'emailed_code_other', status: 'other', caller: 'other', n: 2 }),
          totalsRow({ kind: 'emailed_code', status: 'other', caller: 'other', n: 9 }),
          totalsRow({ kind: 'factors_known_other', status: '422', caller: 'other', n: 5 }),
        ],
      );
      expect(flaggedOf(out)).toEqual([
        expect.objectContaining({ outcome: 'flagged', source: 'api', count: 3, at_ms: H04 }),
      ]);
      expect(out.elements).toHaveLength(1);
      expect(out.unclassified).toBe(3);
      expect(out.notStored).toMatchObject({ not_routed: 34, emailed_code: 9, known_other: 5 });
      // Each is still in the log line, by kind, status and caller.
      expect(out.seen).toMatchObject({
        'token_other 404 other other': 30,
        'emailed_code other other other': 9,
        'factors_known_other 422 other other': 5,
      });
    });

    it('a flagged count past what the writer reads is cut to 999,999', () => {
      const out = build([], [totalsRow({ kind: 'token_other', caller: 'phone', n: 2_000_000 })]);
      expect(flaggedOf(out)).toEqual([
        expect.objectContaining({ source: 'phone', count: AUTH_LOGS_MAX_COUNT }),
      ]);
      expect(out.clamped).toBe(1);
    });
  });

  describe("lines of our server's form: reconciled with what our own server recorded", () => {
    const hourOf = (password: number, code: number, extra: Raw[] = []) => [
      ...(password ? [totalsRow({ ...ours, n: password })] : []),
      ...(code ? [totalsRow({ kind: 'verify', status: '422', ...ours, n: code })] : []),
      ...extra,
    ];
    const unrecordedOf = (out: logs.AuthLogsHourElements) =>
      out.elements.filter((e) => e.reason.startsWith('unrecorded_server_form_'));

    it('the gateway counts of our server form: its password 400s and code 422s only', () => {
      expect(
        serverFormRefusals(
          totalsOf(
            hourOf(7, 3, [
              totalsRow({ ...ours, status: '429', n: 50 }),
              totalsRow({ caller: 'server', network: 'other', n: 40 }),
              totalsRow({ kind: 'verify', status: '400', ...ours, n: 30 }),
              totalsRow({ kind: 'refresh', ...ours, n: 20 }),
              totalsRow({ kind: 'token_other', ...ours, n: 10 }),
              totalsRow({ caller: 'phone', n: 9 }),
            ]),
          ),
        ),
      ).toEqual({ password: 7, code: 3 });
    });

    it('an excess of 2 stores nothing, and is in the log line', () => {
      // Our server records every refusal it causes at the sign-in service, so
      // the excess is expected to be zero. One or two can be lost when a
      // server instance stops before its record is saved; three are flagged.
      expect(AUTH_LOGS_UNRECORDED_FLAG_AT).toBe(3);
      const out = build([], hourOf(14, 0), { password: 12, code: 0, overflow: 0, complete: true });
      expect(unrecordedOf(out)).toEqual([]);
      expect(out.reconcile).toEqual({
        gateway: { password: 14, code: 0 },
        recorded: { password: 12, code: 0, overflow: 0, complete: true },
        excess: { password: 2, code: 0 },
      });
    });

    it('an excess of 3 stores one flagged element of count 3, source api, at the hour last minute', () => {
      const out = build([], hourOf(15, 0), { password: 12, code: 0, overflow: 0, complete: true });
      expect(unrecordedOf(out)).toEqual([
        {
          category: 'password_guessing',
          outcome: 'flagged',
          reason: 'unrecorded_server_form_password',
          source: 'api',
          count: 3,
          at_ms: H04 + 59 * MIN,
        },
      ]);
      expect(out.reconcile.excess).toEqual({ password: 3, code: 0 });
      // The same for codes, on their own count.
      const codes = build([], hourOf(0, 5), { password: 0, code: 2, overflow: 0, complete: true });
      expect(unrecordedOf(codes)).toEqual([
        expect.objectContaining({ reason: 'unrecorded_server_form_code', count: 3 }),
      ]);
      const two = build([], hourOf(0, 4), { password: 0, code: 2, overflow: 0, complete: true });
      expect(unrecordedOf(two)).toEqual([]);
    });

    it('recorded at or above the gateway count stores nothing; the excess is never below zero', () => {
      const out = build([], hourOf(21, 4), { password: 40, code: 25, overflow: 0, complete: true });
      expect(unrecordedOf(out)).toEqual([]);
      expect(out.reconcile.excess).toEqual({ password: 0, code: 0 });
      const even = build([], hourOf(21, 4), { password: 21, code: 4, overflow: 0, complete: true });
      expect(unrecordedOf(even)).toEqual([]);
    });

    it('overflow rows do not widen the allowance: only rows whose reason names the kind count as recorded', () => {
      // An overflow row counts events of any reason, also ones that never
      // reached the sign-in service, and anyone can fill it from our own
      // sign-in page. It is kept for the log line and covers nothing.
      const out = build([], hourOf(25, 15), {
        password: 10,
        code: 5,
        overflow: 100_000,
        complete: true,
      });
      expect(out.reconcile).toEqual({
        gateway: { password: 25, code: 15 },
        recorded: { password: 10, code: 5, overflow: 100_000, complete: true },
        excess: { password: 15, code: 10 },
      });
      expect(unrecordedOf(out).map((e) => [e.reason, e.count])).toEqual([
        ['unrecorded_server_form_code', 10],
        ['unrecorded_server_form_password', 15],
      ]);
    });

    describe("the hour's edge: a refusal the gateway stamps in one hour and our server records in the next", () => {
      const none = { password: 0, code: 0 };

      it('the carry is what the next hour recorded in its first minute, and no more than that hour has beyond its own gateway lines', () => {
        expect(
          hourEdgeCarry({
            firstMinute: { password: 3, code: 0 },
            recorded: { password: 3, code: 0 },
            gateway: none,
          }),
        ).toEqual({ password: 3, code: 0 });
        // The first minute is the limit: later rows of the next hour carry nothing.
        expect(
          hourEdgeCarry({
            firstMinute: { password: 2, code: 1 },
            recorded: { password: 50, code: 9 },
            gateway: none,
          }),
        ).toEqual({ password: 2, code: 1 });
        // What the next hour's own gateway lines account for is not carried:
        // a recorded row is counted for one hour only.
        expect(
          hourEdgeCarry({
            firstMinute: { password: 5, code: 4 },
            recorded: { password: 8, code: 4 },
            gateway: { password: 6, code: 4 },
          }),
        ).toEqual({ password: 2, code: 0 });
        // Never below zero.
        expect(
          hourEdgeCarry({
            firstMinute: { password: 5, code: 5 },
            recorded: { password: 5, code: 5 },
            gateway: { password: 9, code: 30 },
          }),
        ).toEqual(none);
        expect(hourEdgeCarry({ firstMinute: none, recorded: none, gateway: none })).toEqual(none);
      });

      const withCarry = (
        password: number,
        code: number,
        carry: { password: number; code: number },
      ) =>
        buildHourElements({
          hour,
          groups: [],
          groupsCapped: false,
          groupsDropped: 0,
          totals: totalsOf(hourOf(password, code)),
          recorded: { password: 0, code: 0, overflow: 0, complete: true },
          carry,
        });

      it('three refusals recorded on the other side of the edge raise no flag', () => {
        const out = withCarry(3, 0, { password: 3, code: 0 });
        expect(unrecordedOf(out)).toEqual([]);
        expect(out.reconcile).toEqual({
          gateway: { password: 3, code: 0 },
          recorded: { password: 0, code: 0, overflow: 0, complete: true },
          excess: { password: 0, code: 0 },
          carried: { password: 3, code: 0 },
        });
      });

      it('a carry takes off only what it is: the rest of the excess is still flagged, with its true count', () => {
        const out = withCarry(9, 5, { password: 3, code: 1 });
        expect(unrecordedOf(out).map((e) => [e.reason, e.count])).toEqual([
          ['unrecorded_server_form_code', 4],
          ['unrecorded_server_form_password', 6],
        ]);
        expect(out.reconcile.carried).toEqual({ password: 3, code: 1 });
        // The threshold is unchanged: two left over are not flagged, three are.
        expect(unrecordedOf(withCarry(5, 0, { password: 3, code: 0 }))).toEqual([]);
        expect(unrecordedOf(withCarry(6, 0, { password: 3, code: 0 }))).toEqual([
          expect.objectContaining({ count: 3 }),
        ]);
      });

      it('a carry larger than the excess takes off no more than the excess; each kind has its own', () => {
        const out = withCarry(4, 4, { password: 50, code: 0 });
        expect(out.reconcile.excess).toEqual({ password: 0, code: 4 });
        expect(out.reconcile.carried).toEqual({ password: 4, code: 0 });
        expect(unrecordedOf(out)).toEqual([
          expect.objectContaining({ reason: 'unrecorded_server_form_code', count: 4 }),
        ]);
      });

      it('with no carry worked out, nothing is taken off and none is shown', () => {
        const out = build([], hourOf(5, 0), { password: 0, code: 0, overflow: 0, complete: true });
        expect(out.reconcile.carried).toBeUndefined();
        expect(unrecordedOf(out)).toEqual([expect.objectContaining({ count: 5 })]);
      });
    });

    it('codes are reconciled on their own: recorded passwords do not cover them', () => {
      const out = build([], hourOf(0, 14), { password: 500, code: 4, overflow: 0, complete: true });
      expect(unrecordedOf(out)).toEqual([
        expect.objectContaining({ reason: 'unrecorded_server_form_code', count: 10 }),
      ]);
    });

    it('not reconciled (nothing read) stores no flag, and says so with no excess', () => {
      const out = build([], hourOf(50, 0), null);
      expect(unrecordedOf(out)).toEqual([]);
      expect(out.reconcile).toEqual({
        gateway: { password: 50, code: 0 },
        recorded: null,
        excess: null,
      });
      // With nothing of our server form there is nothing to reconcile.
      expect(build([], [], null).reconcile).toEqual({
        gateway: { password: 0, code: 0 },
        recorded: null,
        excess: { password: 0, code: 0 },
      });
    });
  });

  describe('totals that are not whole: the hour is never stored as if it were', () => {
    const notWhole = (totals: Raw[], recorded: logs.AuthLogsRecorded | null = null) =>
      buildHourElements({
        hour,
        groups: [],
        groupsCapped: false,
        groupsDropped: 0,
        totals: totalsOf(totals),
        totalsIncomplete: true,
        recorded,
      });
    const tooMany = (out: logs.AuthLogsHourElements) =>
      out.elements.filter((e) => e.reason === 'too_many_forms_to_count');

    it('one flagged element for the hour: its own reason, source api, no country, and as its number the refused requests that were counted, of every kind', () => {
      // The words are "refused sign-in requests in an hour that could not all
      // be counted": the number beside them is every line of every row that
      // was read, whatever its kind (here: none of them is stored on its own).
      const out = notWhole([
        totalsRow({ kind: 'refresh', n: 40 }),
        totalsRow({ kind: 'token_known_other', caller: 'other', n: 25 }),
        totalsRow({ kind: 'emailed_code', status: 'other', caller: 'other', n: 5 }),
      ]);
      expect(out.elements).toEqual([
        {
          category: 'password_guessing',
          outcome: 'flagged',
          reason: 'too_many_forms_to_count',
          source: 'api',
          count: 70,
          at_ms: H04,
        },
      ]);
    });

    it('it is stored beside everything else the rows read come to', () => {
      const out = notWhole(
        [
          totalsRow({ kind: 'token_other', n: 2 }),
          totalsRow({ ...ours, n: 9 }),
          totalsRow({ kind: 'refresh', n: 10 }),
        ],
        { password: 1, code: 0, overflow: 0, complete: true },
      );
      expect(out.elements.map((e) => [e.reason, e.source, e.count])).toEqual([
        ['too_many_forms_to_count', 'api', 21],
        ['unclassified_sign_in_refusals', 'phone', 2],
        ['unrecorded_server_form_password', 'api', 8],
      ]);
      expect(out.elements.every((e) => e.outcome === 'flagged' && e.country === undefined)).toBe(
        true,
      );
    });

    it('with no row read at all it still counts 1: the hour is never clean', () => {
      expect(tooMany(notWhole([]))).toEqual([expect.objectContaining({ count: 1, at_ms: H04 })]);
    });

    it('a total past what the writer reads is cut to 999,999', () => {
      const out = notWhole([totalsRow({ kind: 'refresh', n: 3_000_000 })]);
      expect(tooMany(out)).toEqual([expect.objectContaining({ count: AUTH_LOGS_MAX_COUNT })]);
    });

    it('whole totals store no such element', () => {
      expect(tooMany(build([], [totalsRow({ kind: 'refresh', n: 40 })]))).toEqual([]);
    });
  });

  it('a count past what the writer reads is cut to 999,999, never stored as 1', () => {
    const out = build([groupRow({ n: 1_500_000 })]);
    expect(AUTH_LOGS_MAX_COUNT).toBe(999_999);
    expect(out.elements[0]!.count).toBe(999_999);
    expect(out.clamped).toBe(1);
  });

  describe('past the 199 groups: the cap and the remainder', () => {
    /** 199 distinct groups of phone wrong passwords, counts 200 down to 2. */
    const cappedRows = Array.from({ length: AUTH_LOGS_ROW_LIMIT }, (_, i) =>
      groupRow({
        minute: minuteOf(H04, i % 60),
        country: ['NL', 'US', 'DE', 'FR'][Math.floor(i / 60)]!,
        n: 200 - i,
      }),
    );
    let capped: logs.AuthLogsGroupRow[] = [];
    let listedSum = 0;
    beforeEach(() => {
      capped = parsed(cappedRows);
      listedSum = capped.reduce((s, r) => s + r.n, 0);
    });
    const buildCapped = (
      totals: Raw[],
      over: Partial<Parameters<typeof buildHourElements>[0]> = {},
    ) =>
      buildHourElements({
        hour,
        groups: capped,
        groupsCapped: true,
        groupsDropped: 0,
        totals: totalsOf(totals),
        recorded: null,
        ...over,
      });

    it('the remainder is one element per category and source, and the call holds at most 200', () => {
      expect(AUTH_LOGS_ROW_LIMIT).toBe(199);
      expect(AUTH_LOGS_MAX_ELEMENTS).toBe(200);
      const out = buildCapped([
        totalsRow({ n: listedSum + 50 }),
        totalsRow({ status: '429', caller: 'other', n: 7 }),
        // Not stored kinds never reach the remainder.
        totalsRow({ ...ours, status: '429', n: 900 }),
        totalsRow({ status: 'other', n: 300 }),
        totalsRow({ kind: 'refresh', n: 80 }),
      ]);
      expect(out.elements.length).toBeLessThanOrEqual(200);
      const over = out.elements.filter((e) => e.reason === 'auth_log_over_cap');
      expect(over).toEqual([
        {
          category: 'bots',
          outcome: 'blocked',
          reason: 'auth_log_over_cap',
          source: 'api',
          count: 7,
          at_ms: H04,
        },
        {
          category: 'password_guessing',
          outcome: 'blocked',
          reason: 'auth_log_over_cap',
          source: 'phone',
          // 50 not listed, plus the smallest listed group (2) folded in to make room.
          count: 52,
          at_ms: H04,
        },
      ]);
      expect(out.elements).toHaveLength(200);
      // Every stored event is counted once: the listed and the remainder add up to the totals.
      expect(out.elements.reduce((s, e) => s + e.count, 0)).toBe(listedSum + 50 + 7);
      expect(out.remainder).toBe(52 + 7);
      expect(out.notStored).toEqual({
        our_server: 900,
        other_status: 300,
        refresh: 80,
        known_other: 0,
        emailed_code: 0,
        not_routed: 0,
      });
    });

    it('with every flagged count as well, the call still holds at most 200', () => {
      const out = buildCapped(
        [
          totalsRow({ n: listedSum + 50 }),
          totalsRow({ status: '429', caller: 'other', n: 7 }),
          totalsRow({ kind: 'token_other', n: 25 }),
          totalsRow({ kind: 'token_other', caller: 'other', n: 5 }),
          totalsRow({ ...ours, n: 40 }),
          totalsRow({ kind: 'verify', status: '422', ...ours, n: 30 }),
        ],
        { recorded: { password: 0, code: 0, overflow: 0, complete: true } },
      );
      expect(out.elements).toHaveLength(200);
      expect(out.elements.filter((e) => e.outcome === 'flagged')).toHaveLength(4);
      expect(out.elements.reduce((s, e) => s + e.count, 0)).toBe(
        listedSum + 50 + 7 + 25 + 5 + 40 + 30,
      );
    });

    it('a remainder is never below zero, and none is added under the limit', () => {
      const out = buildCapped([totalsRow({ n: 10 })]);
      expect(out.elements.some((e) => e.reason === 'auth_log_over_cap')).toBe(false);
      const under = buildHourElements({
        hour,
        groups: capped.slice(0, 10),
        groupsCapped: false,
        groupsDropped: 0,
        totals: totalsOf([totalsRow({ n: 1_000_000 })]),
        recorded: null,
      });
      expect(under.elements.some((e) => e.reason === 'auth_log_over_cap')).toBe(false);
    });

    it('no remainder when a group row of the hour was dropped (its count would come back through the totals)', () => {
      const out = buildCapped([totalsRow({ n: listedSum + 50 })], { groupsDropped: 1 });
      expect(out.elements.some((e) => e.reason === 'auth_log_over_cap')).toBe(false);
      expect(out.remainderSkipped).toBe(true);
    });
  });
});

// ── The SQL ─────────────────────────────────────────────────────────────────

describe('the SQL is two constants that return classes and counts only', () => {
  const source = readFileSync(path.join(__dirname, 'auth-logs.ts'), 'utf8');
  const BOTH = [
    ['groups', AUTH_LOGS_GROUPS_SQL],
    ['totals', AUTH_LOGS_TOTALS_SQL],
  ] as const;

  /** The literal text a constant is declared with in the module. */
  function declared(name: string): string {
    const m = source.match(new RegExp(`export const ${name} = \`([^\`]*)\`;`));
    expect(m, name).not.toBeNull();
    return m![1]!;
  }

  it('each is one template literal with no placeholder and no backslash, and the value sent is that text', () => {
    for (const [name, value] of [
      ['AUTH_LOGS_GROUPS_SQL', AUTH_LOGS_GROUPS_SQL],
      ['AUTH_LOGS_TOTALS_SQL', AUTH_LOGS_TOTALS_SQL],
    ] as const) {
      const text = declared(name);
      expect(text, name).not.toContain('${');
      expect(text, name).not.toContain('\\');
      expect(value, name).toBe(text);
    }
  });

  /** A query's text with its comments and its quoted strings taken out. */
  const statementWords = (sql: string) =>
    sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/'[^']*'/g, "''");

  it("each is nested selects, the form the logs service's own parser accepts: never a WITH list", () => {
    for (const [name, sql] of BOTH) {
      // The service refuses `WITH <expression> AS <name>` (it answers 200 with an error).
      expect(statementWords(sql), name).not.toMatch(/\bwith\b/i);
      expect(sql, name).not.toContain('${');
      expect(sql, name).not.toContain('\\');
      // One leading block comment (a form the service was seen to accept), then the statement.
      expect(sql, name).toMatch(/^\/\*[^*']*\*\/\nSELECT /);
      expect(sql.match(/\/\*/g), name).toHaveLength(1);
      const { levels } = parseReaderQuery(sql);
      expect(levels, name).toHaveLength(3);
      // Only the outermost select filters by a computed class, groups, orders and limits.
      expect(levels[0]!.limit, name).toBe(AUTH_LOGS_ROW_LIMIT);
      expect(levels[0]!.orderBy[0], name).toEqual({ name: 'n', desc: true });
      expect(levels[1]!.where, name).toBeNull();
      for (const inner of levels.slice(1)) {
        expect(inner.groupBy, name).toEqual([]);
        expect(inner.orderBy, name).toEqual([]);
        expect(inner.limit, name).toBeNull();
      }
      expect(levels[2]!.where, name).not.toBeNull();
    }
  });

  it('each query fits a request line: its whole URL stays below 5,000 bytes, far below 8,000', () => {
    // The query travels in the URL of a GET. The longest one seen to run on
    // the logs service was about 3,600 bytes; a common limit for a request
    // line is 8,000. The texts reviewed before the first real run made URLs
    // of just under 5,000 bytes: neither may grow past that (a leading space
    // of the text is one byte of the URL, so the texts are indented by one).
    for (const [name, sql] of BOTH) {
      const params = new URLSearchParams({
        sql,
        iso_timestamp_start: iso(H04),
        iso_timestamp_end: iso(H04 + HOUR),
      });
      const url = `https://api.supabase.com/v1/projects/${PROJECT_REF}/analytics/endpoints/logs?${params.toString()}`;
      expect(url.length, name).toBeLessThan(5_000);
    }
  });

  it('the model refuses a WITH list, a name defined beside its use, and anything it does not know', () => {
    const line = { source: 'edge_logs', attributes: {} };
    expect(() => parseReaderQuery("WITH 'a' AS b SELECT b AS c FROM logs")).toThrow(/SELECT/);
    expect(() =>
      runReaderQueryOnLine("SELECT 'a' AS b, b AS c FROM logs WHERE source = 'edge_logs'", line, [
        'c',
      ]),
    ).toThrow(/unknown name b/);
    expect(() =>
      runReaderQueryOnLine("SELECT source AS s FROM logs WHERE s = 'edge_logs'", line, ['s']),
    ).toThrow(/unknown name s/);
    expect(() => runReaderQueryOnLine('SELECT upper(source) AS s FROM logs', line, ['s'])).toThrow(
      /not modelled/,
    );
    expect(() => parseReaderQuery('SELECT source AS s FROM logs GROUP BY t')).toThrow(/no column/);
    expect(() =>
      parseReaderQuery('SELECT source AS s FROM logs; SELECT 1 AS n FROM logs'),
    ).toThrow();
  });

  const aliases = (items: Array<{ alias: string }>) => items.map((i) => i.alias);

  it('the groups query returns a minute, a kind, a status, a caller class, a network class, a country and a count', () => {
    expect(aliases(parseReaderQuery(AUTH_LOGS_GROUPS_SQL).selectItems)).toEqual([
      'minute',
      'kind',
      'status',
      'caller',
      'network',
      'country',
      'n',
    ]);
    expect(aliases(parseReaderQuery(AUTH_LOGS_TOTALS_SQL).selectItems)).toEqual([
      'kind',
      'status',
      'caller',
      'network',
      'forms',
      'first_seen',
      'last_seen',
      'n',
    ]);
    expect(AUTH_LOGS_GROUPS_SQL).toContain('toString(toStartOfMinute(timestamp)) AS minute');
    expect(AUTH_LOGS_TOTALS_SQL).toContain('timestamp AS ts');
    expect(AUTH_LOGS_TOTALS_SQL).toContain('toString(min(ts)) AS first_seen');
    expect(AUTH_LOGS_TOTALS_SQL).toContain('toString(max(ts)) AS last_seen');
  });

  // -- The totals answer cannot be filled --

  /** Every text an expression of one select can answer, when it answers only texts written in the query. */
  function answersOf(sql: string, alias: string): string[] {
    const { levels } = parseReaderQuery(sql);
    type Tree = {
      k: string;
      v?: unknown;
      name?: string;
      args?: Tree[];
    };
    const depth = levels.findIndex(
      (level, i) =>
        i > 0 && level.items.some((x) => x.alias === alias && (x.node as Tree).k !== 'ref'),
    );
    expect(depth, alias).toBeGreaterThan(0);
    const out = new Set<string>();
    const walk = (node: Tree): void => {
      if (node.k === 'str') out.add(String(node.v));
      else if (node.k === 'call' && node.name === 'multiIf') {
        const args = node.args!;
        for (let i = 1; i < args.length; i += 2) walk(args[i]!);
        walk(args[args.length - 1]!);
      } else if (node.k === 'call' && node.name === 'if') {
        walk(node.args![1]!);
        walk(node.args![2]!);
      } else {
        // A column, or anything worked out from the line: not a fixed list.
        throw new Error(`${alias} can answer something that is not written in the query`);
      }
    };
    walk(levels[depth]!.items.find((x) => x.alias === alias)!.node as Tree);
    return [...out].sort();
  }

  it('the totals are grouped only by classes written in the query: a kind, a status class, a caller class and a network class', () => {
    const totals = parseReaderQuery(AUTH_LOGS_TOTALS_SQL).levels[0]!;
    expect(totals.groupBy).toEqual(['kind', 'status', 'caller', 'network']);
    expect(answersOf(AUTH_LOGS_TOTALS_SQL, 'kind')).toEqual([...ALL_KINDS].sort());
    // The statuses the job acts on, and one class for every other refused status.
    expect(answersOf(AUTH_LOGS_TOTALS_SQL, 'status')).toEqual([
      '400',
      '404',
      '422',
      '429',
      'other',
    ]);
    // The callers the job tells apart, and one class for every other client string.
    expect(answersOf(AUTH_LOGS_TOTALS_SQL, 'caller')).toEqual(['other', 'phone', 'server']);
    expect(answersOf(AUTH_LOGS_TOTALS_SQL, 'network')).toEqual(['hosting', 'other']);
    // The form is not a group: one request of another form opens no new row.
    expect(AUTH_LOGS_TOTALS_SQL).toContain('min(form) AS forms');
    // The groups query answers the same classes.
    for (const alias of ['kind', 'status', 'caller', 'network']) {
      expect(answersOf(AUTH_LOGS_GROUPS_SQL, alias), alias).toEqual(
        answersOf(AUTH_LOGS_TOTALS_SQL, alias),
      );
    }
  });

  it('whatever a caller sends, the totals answer stays below its limit: it cannot be filled', () => {
    // A hosting network is answered for our server's client string alone,
    // so a caller class and a network class make four pairs, not six.
    const pairs = new Set<string>();
    for (const client of [
      SERVER_SSR,
      SERVER_NODE,
      'supabase-js-react-native/2.50.0',
      'curl/8.4.0',
      '',
    ])
      for (const owner of ['Amazon Example Hosting', 'Example Telecom', '']) {
        const { values } = runReaderQueryOnLine(
          AUTH_LOGS_TOTALS_SQL,
          gatewayLine({ client, owner }),
          ['caller', 'network'],
        );
        pairs.add(`${String(values.caller)} ${String(values.network)}`);
      }
    expect([...pairs].sort()).toEqual([
      'other other',
      'phone other',
      'server hosting',
      'server other',
    ]);
    const network = parseReaderQuery(AUTH_LOGS_TOTALS_SQL).levels[1]!.items.find(
      (x) => x.alias === 'network',
    )!;
    expect(AUTH_LOGS_TOTALS_SQL).toContain(
      "if(caller = 'server' AND startsWith(owner, 'Amazon'), 'hosting', 'other') AS network",
    );
    expect(JSON.stringify(network.node)).toContain('"name":"caller"');
    const rows =
      answersOf(AUTH_LOGS_TOTALS_SQL, 'kind').length *
      answersOf(AUTH_LOGS_TOTALS_SQL, 'status').length *
      pairs.size;
    expect(rows).toBe(180);
    expect(rows).toBeLessThan(AUTH_LOGS_ROW_LIMIT);
  });

  it.each([
    ['400', '400'],
    ['404', '404'],
    ['422', '422'],
    ['429', '429'],
    ['401', 'other'],
    ['403', 'other'],
    ['405', 'other'],
    ['415', 'other'],
    ['499', 'other'],
  ])('a line answered %s is of the status class %s, in both queries', (st, cls) => {
    expect(bothOn(gatewayLine({ status: st })).totals.values.status).toBe(cls);
  });

  /** The definition of each alias of one select, as its syntax tree. */
  const definitions = (items: Array<{ alias: string; node: unknown }>) =>
    new Map(items.map((i) => [i.alias, JSON.stringify(i.node)]));

  it('both class a line by the same definitions, and the hosting prefix is written once, with when it was measured', () => {
    const groups = parseReaderQuery(AUTH_LOGS_GROUPS_SQL).levels;
    const totals = parseReaderQuery(AUTH_LOGS_TOTALS_SQL).levels;
    // The raw fields (innermost) and the classes (middle): a name both queries
    // define is defined the same way in both.
    for (const depth of [1, 2]) {
      const g = definitions(groups[depth]!.items);
      const t = definitions(totals[depth]!.items);
      const shared = [...g.keys()].filter((alias) => t.has(alias));
      for (const alias of shared) expect(g.get(alias), alias).toBe(t.get(alias));
      if (depth === 1) expect(shared).toEqual(['kind', 'status', 'caller', 'network']);
      else {
        expect(shared).toEqual(
          expect.arrayContaining([
            'routed_path',
            'net_path',
            'raw_search',
            'first_grant',
            'caller',
            'raw_status',
            'owner',
          ]),
        );
      }
    }
    for (const [name, sql] of BOTH) {
      expect(sql.match(/Amazon/g), name).toHaveLength(1);
      expect(sql, name).toContain("startsWith(owner, 'Amazon')");
      expect(sql, name).toMatch(/^\/\*[^*]*measured on 2026-11-21[^*]*\*\//);
    }
  });

  it('never an address, a raw log line, the raw client string, a path, a query string or a network name', () => {
    for (const [name, sql] of BOTH) {
      for (const word of [
        'event_message',
        'connecting_ip',
        'forwarded',
        'real_ip',
        'remote_addr',
        'request.url',
        'user_agent',
        'cf.city',
        'cf.asn',
        'latitude',
        'longitude',
        'id,',
        '*,',
        'select *',
      ]) {
        expect(sql.toLowerCase(), `${name}: ${word}`).not.toContain(word);
      }
      // The only header read is the client string.
      expect(
        sql
          .match(/request\.headers\.[a-z_]+/g)
          ?.every((f) => f === 'request.headers.x_client_info'),
      ).toBe(true);
    }
  });

  // ── The query run on made-up log lines ──

  const UUID = '5eed0000-0000-4000-8000-00000000c0de';
  /** A made-up gateway line; `null` leaves an attribute out. */
  function gatewayLine(
    over: {
      source?: string;
      method?: string | null;
      path?: string | null;
      search?: string | null;
      status?: string | null;
      client?: string | null;
      owner?: string | null;
      country?: string | null;
    } = {},
  ): ModelLogLine {
    const attributes: Record<string, string> = {};
    const put = (key: string, value: string | null | undefined, fallback: string) => {
      if (value === null) return;
      attributes[key] = value ?? fallback;
    };
    put('request.method', over.method, 'POST');
    put('request.path', over.path, '/auth/v1/token');
    put('request.search', over.search, '?grant_type=password');
    put('response.status_code', over.status, '400');
    put('request.headers.x_client_info', over.client, 'supabase-js-react-native/2.50.0');
    put('request.cf.asOrganization', over.owner, 'Example Telecom');
    put('request.cf.country', over.country, 'NL');
    return { source: over.source ?? 'edge_logs', attributes };
  }
  const ROW_ALIASES = ['kind', 'status', 'caller', 'network'] as const;
  /** What each query makes of one line: kept or not, and the classes it returns. */
  function bothOn(line: ModelLogLine) {
    const groups = runReaderQueryOnLine(AUTH_LOGS_GROUPS_SQL, line, [...ROW_ALIASES, 'country']);
    const totals = runReaderQueryOnLine(AUTH_LOGS_TOTALS_SQL, line, [...ROW_ALIASES, 'form']);
    // Both class every line the same way.
    for (const a of ROW_ALIASES) expect(groups.values[a], a).toBe(totals.values[a]);
    return { groups, totals, kind: totals.values.kind, form: totals.values.form };
  }
  /** The kind of a line the totals query keeps; null when it is not read at all. */
  const kindOf = (line: ModelLogLine) => {
    const { totals, kind } = bothOn(line);
    return totals.kept ? kind : null;
  };

  describe('the grant is read the way the sign-in service reads it: decoded, the first value', () => {
    const ofSearch = (search: string) => kindOf(gatewayLine({ search }));
    const formOf = (search: string) => bothOn(gatewayLine({ search })).form;

    it.each([
      ['?grant_type=password', 'password'],
      ['grant_type=password', 'password'],
      ['?scope=x&grant_type=password', 'password'],
      ['?grant_type=password&scope=x', 'password'],
      ['?grant_type=refresh_token', 'refresh'],
      ['?scope=x&grant_type=refresh_token', 'refresh'],
    ])('%j -> %s, of a plain form', (search, kind) => {
      expect(ofSearch(search)).toBe(kind);
      expect(formOf(search)).toBe('plain');
    });

    it.each([
      ['?grant_type=pass%77ord', 'password'],
      ['?grant_type=%70%61%73%73%77%6F%72%64', 'password'],
      ['?grant_type=%70%61%73%73%77%6f%72%64', 'password'],
      ['?grant%5Ftype=password', 'password'],
      ['?grant%5ftype=pass%77ord', 'password'],
      ['?grant_type=refresh%5Ftoken', 'refresh'],
      ['?grant_type=%70kce', 'token_known_other'],
    ])('an encoded grant %j is decoded as the service decodes it -> %s', (search, kind) => {
      expect(ofSearch(search)).toBe(kind);
    });

    it.each([
      ['?grant_type=password&grant_type=refresh_token', 'password'],
      ['?grant_type=password&grant_type=password', 'password'],
      ['?grant_type=password&scope=x&grant_type=pkce', 'password'],
      ['?grant_type=password&grant%5Ftype=refresh_token', 'password'],
      ['?grant_type=refresh_token&grant_type=password', 'refresh'],
      ['?grant_type=pkce&grant_type=password', 'token_known_other'],
      ['?grant_type=&grant_type=password', 'token_other'],
    ])(
      'several grant_type values %j: the first decides (%s), and the form is ambiguous',
      (search, kind) => {
        expect(ofSearch(search)).toBe(kind);
        expect(formOf(search)).toBe('ambiguous');
      },
    );

    it.each([['?grant_type=pkce'], ['?grant_type=id_token'], ['?grant_type=web3']])(
      'a known grant that is not a password (%j) -> token_known_other',
      (search) => {
        expect(ofSearch(search)).toBe('token_known_other');
      },
    );

    it.each([
      ['no grant', ''],
      ['an empty query', '?'],
      ['an empty grant', '?grant_type='],
      ['a grant with no value', '?grant_type'],
      ['an unknown grant', '?grant_type=magic'],
      ['a known grant in capitals', '?grant_type=PKCE'],
      ['a longer known grant', '?grant_type=pkce_x'],
      ['a longer value', '?grant_type=password_x'],
      ['capitals in the value', '?grant_type=PASSWORD'],
      ['capitals in the name', '?GRANT_TYPE=password'],
      ['a longer name', '?xgrant_type=password'],
      ['a plus sign', '?grant_type=password+'],
      ['a semicolon in the value', '?grant_type=password;scope=x'],
      ['a question mark inside', '?scope=x?grant_type=password'],
      ['an escape that does not decode', '?grant_type=pass%zzword'],
      ['an escape cut short', '?grant_type=password%2'],
      ['a lone percent sign', '?grant_type=password%'],
      ['an encoded & the service keeps in the value', '?grant_type=password%26scope=x'],
      ['an encoded & before the grant', '?scope=x%26grant_type=password'],
      ['an encoded =', '?grant_type%3Dpassword'],
      ['an encoded = in small letters', '?grant_type%3dpassword'],
      ['an encoded control character', '?grant_type=password%0A'],
      ['an encoded control character elsewhere', '?scope=%7F&grant_type=password'],
    ])('%s (%j) -> token_other', (_what, search) => {
      expect(ofSearch(search)).toBe('token_other');
    });

    it.each([
      ['a byte that is not text after the value', '?grant_type=password%FF'],
      ['the same after a refresh grant', '?grant_type=refresh_token%FF'],
      ['such a byte, then another pair', '?grant_type=password%FF&scope=x'],
      ['such a byte inside the value', '?grant_type=pass%FFword'],
      ['a letter that is not ASCII after the value', '?grant_type=password%C3%A9'],
    ])(
      '%s (%j): the service checks no password for it, so it is token_other, never password',
      (_what, search) => {
        // Measured on 2026-11-21: the service answered `?grant_type=password%FF`
        // with "unsupported grant type" (no password was checked).
        expect(ofSearch(search)).toBe('token_other');
      },
    );

    // Measured on 2026-11-21: the sign-in service drops a pair that holds a
    // raw semicolon and acts on the next grant_type, so the first grant this
    // query reads is then not the one the service acted on. A query string
    // with a raw semicolon anywhere is an unknown form whatever its grants
    // say: never a refresh, never another known grant, never a password.
    it.each([
      ['in the first grant, before a password grant', '?grant_type=x;y&grant_type=password'],
      [
        'in a refresh grant, before a password grant',
        '?grant_type=refresh_token;&grant_type=password',
      ],
      ['in another pair, after a refresh grant', '?grant_type=refresh_token&scope=a;b'],
      ['in another pair, before a refresh grant', '?scope=a;b&grant_type=refresh_token'],
      ['in another pair, after a known grant', '?grant_type=pkce&scope=a;b'],
      ['in another pair, before a password grant', '?a;b&grant_type=password'],
      ['in another pair, after a password grant', '?grant_type=password&scope=a;b'],
      ['at the very end', '?grant_type=password;'],
      ['at the very start', '?;grant_type=refresh_token'],
      ['alone', '?;'],
    ])('a raw semicolon %s (%j) -> token_other', (_what, search) => {
      expect(ofSearch(search)).toBe('token_other');
    });

    it('a raw semicolon is looked for in the query string as sent: an encoded one is part of a value', () => {
      for (const [name, sql] of BOTH) {
        expect(sql, name).toContain("position(raw_search, ';') > 0, 'token_other',");
      }
      // The service keeps an encoded semicolon inside the value, and so does
      // this query: the pair is not dropped, and the grant stays the first.
      expect(ofSearch('?grant_type=refresh_token&scope=a%3Bb')).toBe('refresh');
      expect(ofSearch('?grant_type=password&scope=a%3Bb')).toBe('password');
      expect(ofSearch('?grant_type=password%3Bx')).toBe('token_other');
    });

    it('a grant whose NAME is encoded is the grant the service acts on (measured: a password was checked)', () => {
      // The whole query string is decoded before the grant is looked for.
      expect(ofSearch('?grant%5Ftype=password')).toBe('password');
      expect(ofSearch('?%67rant_type=password')).toBe('password');
      for (const [name, sql] of BOTH) {
        expect(sql, name).toContain(
          "extract(decodeURLComponent(log_attributes['request.search']), '(?:^[?]?|&)grant_type=([^&]*)(?:&|$)') AS first_grant",
        );
      }
    });

    it('a byte that is not text in a later pair leaves the grant as it is', () => {
      expect(ofSearch('?grant_type=password&scope=%FF')).toBe('password');
    });

    it('the first grant is taken whole: its capture ends at the next pair or at the end', () => {
      for (const [name, sql] of BOTH) {
        expect(sql, name).toContain("'(?:^[?]?|&)grant_type=([^&]*)(?:&|$)'");
      }
    });

    it('a line with no query string at all is read, as token_other', () => {
      expect(kindOf(gatewayLine({ search: null }))).toBe('token_other');
    });
  });

  describe('the paths: a loose net, and inside it the exact forms the gateway routes', () => {
    const formOfPath = (p: string) => bothOn(gatewayLine({ path: p })).form;

    it.each([
      ['/auth/v1/token', 'password'],
      [`/auth/v1/factors/${UUID}/verify`, 'verify'],
      [`/auth/v1/factors/${UUID.toUpperCase()}/verify`, 'verify'],
      // No secret is checked by these two: enrolling a factor, asking for a challenge.
      ['/auth/v1/factors', 'factors_known_other'],
      [`/auth/v1/factors/${UUID}/challenge`, 'factors_known_other'],
      // A check of an emailed code: counted, not stored.
      ['/auth/v1/verify', 'emailed_code'],
    ])('%s is read, as %s, of a plain form', (p, kind) => {
      expect(kindOf(gatewayLine({ path: p }))).toBe(kind);
      expect(formOfPath(p)).toBe('plain');
    });

    // Measured on 2026-11-21: the gateway routes a repeated slash to the same
    // check (a password WAS checked for the first two), and logs the path as sent.
    it.each([
      ['/auth/v1//token', 'password'],
      ['/auth//v1/token', 'password'],
      ['//auth/v1/token', 'password'],
      ['/auth///v1////token', 'password'],
      [`/auth/v1//factors/${UUID}/verify`, 'verify'],
      [`/auth/v1/factors//${UUID}//verify`, 'verify'],
      ['/auth/v1//factors', 'factors_known_other'],
      [`/auth//v1/factors/${UUID}/challenge`, 'factors_known_other'],
      ['/auth/v1//verify', 'emailed_code'],
    ])(
      '%s (a repeated slash) is read as the plain path is, as %s, and counted as of an ambiguous form',
      (p, kind) => {
        expect(kindOf(gatewayLine({ path: p }))).toBe(kind);
        expect(formOfPath(p)).toBe('ambiguous');
      },
    );

    it('a repeated slash changes nothing else: the grant decides, and the groups query lists the line', () => {
      const refresh = gatewayLine({ path: '/auth/v1//token', search: '?grant_type=refresh_token' });
      expect(kindOf(refresh)).toBe('refresh');
      expect(kindOf(gatewayLine({ path: '/auth//v1/token', search: '?grant_type=magic' }))).toBe(
        'token_other',
      );
      const wrong = bothOn(gatewayLine({ path: '/auth/v1//token' }));
      expect(wrong.kind).toBe('password');
      expect(wrong.groups.kept).toBe(true);
      expect(wrong.groups.values.caller).toBe('phone');
    });

    // Inside the net, and not one of the exact forms: an unknown form. (Measured
    // on 2026-11-21: a trailing slash, capitals and an encoded letter were
    // answered 404; the mapping counts a 404 of an unknown form and flags any
    // other refused status.)
    it.each([
      ['/auth/v1/%74oken', 'token_other'],
      ['/auth/v1/to%6Ben', 'token_other'],
      ['/auth/v1/TOKEN', 'token_other'],
      ['/auth/v1/Token', 'token_other'],
      ['/AUTH/V1/token', 'token_other'],
      ['/auth/v1/%54OKEN', 'token_other'],
      ['/auth/v1/token/', 'token_other'],
      ['/auth/v1/token//', 'token_other'],
      ['/auth/v1/tokens', 'token_other'],
      ['/auth/v1/token/more', 'token_other'],
      ['/auth%2Fv1%2Ftoken', 'token_other'],
      ['/auth/v1%2F%2Ftoken', 'token_other'],
      [`/auth/v1/factors/${UUID.replaceAll('-', '')}/verify`, 'verify_other'],
      [`/auth/v1/factors/{${UUID}}/verify`, 'verify_other'],
      ['/auth/v1/factors/not-an-id/verify', 'verify_other'],
      [`/auth/v1/factors/%35${UUID.slice(1)}/verify`, 'verify_other'],
      [`/auth/v1/factors/${UUID}/verif%79`, 'verify_other'],
      [`/auth/v1/factors/${UUID}%2Fverify`, 'verify_other'],
      [`/auth/v1/factors/${UUID}/VERIFY`, 'verify_other'],
      [`/auth/v1/FACTORS/${UUID}/verify`, 'verify_other'],
      [`/auth/v1/factors/${UUID}/verify/more`, 'verify_other'],
      [`/auth/v1/factors/${UUID}/verify/`, 'verify_other'],
      ['/auth/v1/factors//verify', 'verify_other'],
      [`/auth/v1/factors/a/${UUID}/verify`, 'verify_other'],
      [`/auth/v1/factors/${UUID}`, 'verify_other'],
      ['/auth/v1/factors/', 'verify_other'],
      [`/auth/v1/factors/${UUID}/challenge/`, 'verify_other'],
      [`/auth/v1/factors/${UUID}/CHALLENGE`, 'verify_other'],
      ['/auth/v1/factors/not-an-id/challenge', 'verify_other'],
      ['/auth/v1/VERIFY', 'emailed_code_other'],
      ['/auth/v1/verify/', 'emailed_code_other'],
      ['/auth/v1/verify/more', 'emailed_code_other'],
      ['/auth/v1/%76erify', 'emailed_code_other'],
    ])('%s is read, as an unknown form (%s)', (p, kind) => {
      const { groups, totals } = bothOn(gatewayLine({ path: p }));
      expect(totals.kept).toBe(true);
      expect(totals.values.kind).toBe(kind);
      // Never listed by minute and country: an unknown form is counted, or flagged.
      expect(groups.kept).toBe(false);
    });

    // The net is wider than the paths that start as the three do: any path
    // that holds `auth` and one of the three words is read, so a spelling the
    // gateway might tidy before it routes (a dot segment, another separator,
    // an encoded letter or slash, a parameter, a byte after the word) is
    // never unread. None is an exact form, so none can be stored as a wrong
    // password or code: each is an unknown form (flagged unless answered 404).
    it.each([
      ['a dot segment', '/auth/v1/./token', 'token_other'],
      ['a dot segment earlier', '/auth/./v1/token', 'token_other'],
      ['a segment taken back', '/auth/v1/x/../token', 'token_other'],
      ['a segment taken back after the word', '/auth/v1/token/x/..', 'token_other'],
      ['a segment taken back before the path', '/x/../auth/v1/token', 'token_other'],
      ['an encoded dot segment', '/auth/v1/%2e/token', 'token_other'],
      ['an encoded segment taken back', '/auth/v1/x/%2e%2e/token', 'token_other'],
      ['another separator', '/auth\\v1\\token', 'token_other'],
      ['another separator, encoded', '/auth%5Cv1%5Ctoken', 'token_other'],
      ['encoded letters in the version', '/auth/%76%31/token', 'token_other'],
      ['an encoded first letter', '/%61uth/v1/token', 'token_other'],
      ['capitals at the start', '/AUTH/v1/token', 'token_other'],
      ['a capital in the version', '/auth/V1/token', 'token_other'],
      ['an encoded slash', '/auth/v1%2Ftoken', 'token_other'],
      ['an encoded slash earlier', '/auth%2Fv1/token', 'token_other'],
      ['a parameter after the word', '/auth/v1/token;x=1', 'token_other'],
      ['a parameter earlier', '/auth;x=1/v1/token', 'token_other'],
      ['an encoded NUL after the word', '/auth/v1/token%00', 'token_other'],
      ['an encoded space after the word', '/auth/v1/token%20', 'token_other'],
      ['an encoded tab after the word', '/auth/v1/token%09', 'token_other'],
      ['a query string inside the path', '/auth/v1/token%3Fgrant_type=password', 'token_other'],
      ['a byte that is not text before the word', '/auth/v1/%FF/token', 'token_other'],
      ['another version', '/auth/v2/token', 'token_other'],
      ['no version', '/auth/token', 'token_other'],
      ['a segment before the path', '/x/auth/v1/token', 'token_other'],
      ['a longer path that ends as the token path does', '/auth/v1/oauth/token', 'token_other'],
      ['a dot segment on the code path', `/auth/v1/./factors/${UUID}/verify`, 'verify_other'],
      ['another separator on the code path', `/auth\\v1\\factors\\${UUID}\\verify`, 'verify_other'],
      ['a parameter on the code path', `/auth/v1/factors;x=1/${UUID}/verify`, 'verify_other'],
      ['a dot segment on the emailed code path', '/auth/v1/./verify', 'emailed_code_other'],
      ['an encoded slash on the emailed code path', '/auth%2Fv1%2Fverify', 'emailed_code_other'],
    ])('%s (%s) is inside the net, as an unknown form (%s)', (_what, p, kind) => {
      const { groups, totals } = bothOn(gatewayLine({ path: p }));
      expect(totals.kept).toBe(true);
      expect(totals.values.kind).toBe(kind);
      // Never listed as a wrong password or code.
      expect(groups.kept).toBe(false);
    });

    it('a leading doubled slash and several doubled slashes are still the plain path (only repeated slashes)', () => {
      for (const p of ['//auth/v1/token', '/auth//v1//token']) {
        expect(kindOf(gatewayLine({ path: p })), p).toBe('password');
        expect(formOfPath(p), p).toBe('ambiguous');
      }
    });

    it('every path that starts as the token, factors or verify path does is inside the net', () => {
      for (const start of ['/auth/v1/token', '/auth/v1/factors', '/auth/v1/verify']) {
        for (const rest of ['', '/', 'x', '/more', '%00', ';a=b', '/../x']) {
          expect(
            kindOf(gatewayLine({ path: `${start}${rest}` })),
            `${start}${rest}`,
          ).not.toBeNull();
        }
      }
    });

    it.each([
      ['/auth/v1/user'],
      ['/auth/v1/otp'],
      ['/auth/v1/recover'],
      ['/auth/v1/logout'],
      ['/auth/v1/signup'],
      [`/rest/v1/factors/${UUID}/verify`],
      ['/rest/v1/token'],
      ['/token'],
      ['/auth'],
      [''],
    ])('%j holds no sign-in path: not read', (p) => {
      expect(kindOf(gatewayLine({ path: p }))).toBeNull();
    });

    it('a line with no path at all is not read', () => {
      expect(kindOf(gatewayLine({ path: null }))).toBeNull();
    });

    it('the net is the decoded path in small letters, holding `auth` and one of the three words', () => {
      const decoded = "lower(decodeURLComponent(log_attributes['request.path']))";
      for (const [name, sql] of BOTH) {
        const where = JSON.stringify(parseReaderQuery(sql).levels[2]!.where);
        for (const word of ['auth', 'token', 'factors', 'verify']) {
          expect(where, `${name} ${word}`).toContain(JSON.stringify({ k: 'str', v: word }));
          expect(sql, `${name} ${word}`).toContain(`position(${decoded}, '${word}') > 0`);
        }
        // A search for the bytes of a word: no pattern, so no byte of the
        // path (one that is not text, a line break, a NUL) can end it early.
        expect(sql.match(/position\(lower\(decodeURLComponent\(/g), name).toHaveLength(4);
        expect(sql, name).toContain(`${decoded} AS net_path`);
        // The exact forms are compared with the path as sent, repeated slashes as one, case kept.
        expect(sql, name).toContain(
          "replaceRegexpAll(log_attributes['request.path'], '/+', '/') AS routed_path",
        );
      }
    });

    it('the factor id never comes back', () => {
      const { groups, totals } = bothOn(gatewayLine({ path: `/auth/v1/factors/${UUID}/verify` }));
      expect(JSON.stringify([groups.values, totals.values])).not.toContain('c0de');
    });
  });

  describe('only refused POSTs of the gateway are read', () => {
    it.each([
      ['400', true],
      ['401', true],
      ['422', true],
      ['429', true],
      ['499', true],
      ['200', false],
      ['302', false],
      ['399', false],
      ['500', false],
      ['4000', false],
      ['40', false],
      ['', false],
    ])('status %j: read %s', (st, read) => {
      expect(kindOf(gatewayLine({ status: st })) !== null).toBe(read);
    });

    it('a GET, another log and a line with no method are not read', () => {
      expect(kindOf(gatewayLine({ method: 'GET' }))).toBeNull();
      expect(kindOf(gatewayLine({ method: 'post' }))).toBeNull();
      expect(kindOf(gatewayLine({ method: null }))).toBeNull();
      expect(kindOf(gatewayLine({ source: 'auth_logs' }))).toBeNull();
    });
  });

  it('the groups query lists only the kinds that can be stored; the totals query counts every kind', () => {
    const cases: Array<[ModelLogLine, string, boolean]> = [
      [gatewayLine(), 'password', true],
      [gatewayLine({ path: `/auth/v1/factors/${UUID}/verify`, status: '422' }), 'verify', true],
      [gatewayLine({ search: '?grant_type=refresh_token' }), 'refresh', false],
      [gatewayLine({ search: '?grant_type=pkce' }), 'token_known_other', false],
      [gatewayLine({ search: '?grant_type=magic' }), 'token_other', false],
      [gatewayLine({ path: '/auth/v1/factors/not-an-id/verify' }), 'verify_other', false],
      [gatewayLine({ path: '/auth/v1/factors' }), 'factors_known_other', false],
      [gatewayLine({ path: '/auth/v1/verify', status: '403' }), 'emailed_code', false],
      [gatewayLine({ path: '/auth/v1/verify/', status: '404' }), 'emailed_code_other', false],
      // A password or a code answered with a status that is never stored is not listed either.
      [gatewayLine({ status: '401' }), 'password', false],
      [gatewayLine({ status: '404' }), 'password', false],
      [gatewayLine({ status: '429' }), 'password', true],
      [gatewayLine({ path: `/auth/v1/factors/${UUID}/verify`, status: '403' }), 'verify', false],
      [gatewayLine({ path: `/auth/v1/factors/${UUID}/verify`, status: '429' }), 'verify', true],
      // The two pairs that are never stored are not listed: a password answered
      // 422, a code check answered 400.
      [gatewayLine({ status: '422' }), 'password', false],
      [gatewayLine({ path: `/auth/v1/factors/${UUID}/verify`, status: '400' }), 'verify', false],
    ];
    for (const [line, kind, listed] of cases) {
      const { groups, totals } = bothOn(line);
      expect(totals.values.kind).toBe(kind);
      expect(totals.kept, kind).toBe(true);
      expect(groups.kept, kind).toBe(listed);
    }
  });

  it('the groups query lists exactly the pairs of kind and status that are stored, for every caller but our server', () => {
    // Every kind the query answers, by a path (and a grant) that gives it,
    // with every status class and one status outside them: a line is listed
    // when, and only when, classifyAuthLogLine stores it.
    const kinds: Array<[string, { path?: string; search?: string }]> = [
      ['password', {}],
      ['refresh', { search: '?grant_type=refresh_token' }],
      ['token_known_other', { search: '?grant_type=pkce' }],
      ['token_other', { search: '?grant_type=magic' }],
      ['verify', { path: `/auth/v1/factors/${UUID}/verify` }],
      ['verify_other', { path: '/auth/v1/factors/not-an-id/verify' }],
      ['factors_known_other', { path: '/auth/v1/factors' }],
      ['emailed_code', { path: '/auth/v1/verify' }],
      ['emailed_code_other', { path: '/auth/v1/verify/' }],
    ];
    let listed = 0;
    for (const [kind, where] of kinds) {
      for (const status of ['400', '401', '403', '404', '422', '429', '418']) {
        for (const client of ['supabase-js-react-native/2.50.0', 'curl/8.0.0']) {
          const { groups, totals } = bothOn(gatewayLine({ ...where, status, client }));
          expect(totals.values.kind, `${kind} ${status}`).toBe(kind);
          const verdict = classifyAuthLogLine({
            kind: kind as logs.AuthLogsLine['kind'],
            status: totals.values.status as logs.AuthLogsLine['status'],
            caller: totals.values.caller as logs.AuthLogsLine['caller'],
            network: 'other',
          });
          expect(groups.kept, `${kind} ${status} ${client}`).toBe(verdict.store);
          if (groups.kept) listed += 1;
        }
      }
    }
    // password 400 and 429, verify 422 and 429, from two callers each.
    expect(listed).toBe(8);
  });

  it('both read the same lines; the groups query keeps only the kinds that can be stored', () => {
    const groups = parseReaderQuery(AUTH_LOGS_GROUPS_SQL).levels;
    const totals = parseReaderQuery(AUTH_LOGS_TOTALS_SQL).levels;
    // The innermost WHERE (which lines are read at all) is the same in both.
    expect(JSON.stringify(groups[2]!.where)).toBe(JSON.stringify(totals[2]!.where));
    // Only the groups query filters again, by the computed kind.
    expect(totals[0]!.where).toBeNull();
    // Only the statuses that can be stored are listed: a status the job does
    // not act on takes no row of the groups from one it does.
    expect(AUTH_LOGS_GROUPS_SQL).toContain(
      "\nWHERE ((kind = 'password' AND status IN ('400', '429')) OR (kind = 'verify' AND status IN ('422', '429'))) AND (caller != 'server' OR network != 'hosting')\n",
    );
    for (const [, sql] of BOTH) {
      expect(sql.trimEnd().endsWith(`LIMIT ${AUTH_LOGS_ROW_LIMIT}`)).toBe(true);
      expect(sql).toMatch(/ORDER BY n DESC/);
    }
  });

  it("our own server's lines take no row of the groups query from other callers (they are counted in the totals)", () => {
    const hosted = { owner: 'Amazon Example Hosting' };
    const cases: Array<[string, ModelLogLine, boolean]> = [
      ['our server, ssr', gatewayLine({ client: SERVER_SSR, ...hosted }), false],
      ['our server, node', gatewayLine({ client: SERVER_NODE, ...hosted }), false],
      [
        'our server, a code',
        gatewayLine({
          client: SERVER_SSR,
          ...hosted,
          path: `/auth/v1/factors/${UUID}/verify`,
          status: '422',
        }),
        false,
      ],
      // Its client string from any other network is listed, as any caller is.
      ['its string, another network', gatewayLine({ client: SERVER_SSR }), true],
      ['the phone app on a hosting network', gatewayLine(hosted), true],
      ['no client string on a hosting network', gatewayLine({ client: '', ...hosted }), true],
    ];
    for (const [what, line, listed] of cases) {
      const { groups, totals } = bothOn(line);
      expect(totals.kept, what).toBe(true);
      expect(groups.kept, what).toBe(listed);
    }
  });

  describe("the network class: hosting only for our server's client string, when the owner name starts with the measured prefix", () => {
    it.each([
      ['Amazon', 'hosting'],
      ['Amazon Example Hosting', 'hosting'],
      ['Amazon.example, Inc.', 'hosting'],
      ['Example Telecom', 'other'],
      ['Example Amazon Reseller', 'other'],
      [' Amazon Example', 'other'],
      ['amazon example', 'other'],
      ['AMAZON EXAMPLE', 'other'],
      ['', 'other'],
    ])("our server's client string from %j -> %s", (owner, network) => {
      for (const client of [SERVER_SSR, SERVER_NODE]) {
        expect(bothOn(gatewayLine({ client, owner })).totals.values.network).toBe(network);
      }
    });

    it('a line with no owner name is other', () => {
      expect(bothOn(gatewayLine({ client: SERVER_SSR, owner: null })).totals.values.network).toBe(
        'other',
      );
    });

    it.each([
      ['supabase-js-react-native/2.50.0'],
      ['supabase-ssr/0.12.7 createBrowserClient'],
      ['curl/8.4.0'],
      [`${SERVER_SSR} x`],
      [''],
    ])(
      'any other client string (%j) is of the network class other wherever it comes from: the network opens no row of its own',
      (client) => {
        expect(
          bothOn(gatewayLine({ client, owner: 'Amazon Example Hosting' })).totals.values.network,
        ).toBe('other');
      },
    );
  });

  describe('the caller class: our server only for its two exact client strings', () => {
    it.each([
      [SERVER_SSR, 'server'],
      [SERVER_NODE, 'server'],
      ['supabase-ssr/0.6.1 createServerClient', 'server'],
      ['supabase-js/2.50.0; runtime=node; runtime-version=22.1.0', 'server'],
      ['supabase-js-react-native/2.50.0', 'phone'],
      // The form the newer client library sends from the phone app.
      ['supabase-js/2.116.0; runtime=react-native', 'phone'],
      ['supabase-js/2.130.0; runtime=react-native; runtime-version=0.81.4', 'phone'],
      // Everything else is one class: the job stores them all as api.
      ['supabase-ssr/0.12.7 createBrowserClient', 'other'],
      ['supabase-js-web/2.50.0', 'other'],
      ['curl/8.4.0', 'other'],
      ['', 'other'],
    ])('%j -> %s', (client, cls) => {
      expect(bothOn(gatewayLine({ client })).totals.values.caller).toBe(cls);
    });

    it.each([
      [`x ${SERVER_SSR}`],
      [`${SERVER_SSR} x`],
      [`${SERVER_SSR}\t`],
      ['createServerClient'],
      ['supabase-ssr createServerClient'],
      ['supabase-ssr/0.12 createServerClient'],
      ['supabase-ssr/0.12.7  createServerClient'],
      ['supabase-ssr/0a12b7 createServerClient'],
      ['Supabase-ssr/0.12.7 createServerClient'],
      ['supabase-js/2.116.0; runtime=node'],
      ['runtime=node'],
      ['supabase-js/2.116.0; runtime=node; runtime-version=v24.22.3'],
      [`${SERVER_NODE}; extra`],
      [`${SERVER_NODE.replace('runtime=node', 'runtime=deno')}`],
      ['supabase-js/2.116.0; runtime=react-nativ'],
      ['supabase-js/2.116.0 runtime=react-native'],
    ])('%j only contains words of our server: other (stored as api)', (client) => {
      expect(bothOn(gatewayLine({ client })).totals.values.caller).toBe('other');
    });

    describe('the two exact strings are the ones the installed libraries really send from our server', () => {
      // An upgrade of either library that changes the form of its client
      // string would make our own server's lines `other`: stored one by one
      // as outside traffic, and no longer compared with our own record. These
      // tests send a sign-in through the INSTALLED libraries to a fake
      // sign-in service and class the header they really sent, so such an
      // upgrade fails here first. Nothing leaves this process.
      const versionOf = (pkg: string) =>
        (
          JSON.parse(
            readFileSync(
              path.join(__dirname, '../../../node_modules', pkg, 'package.json'),
              'utf8',
            ),
          ) as { version: string }
        ).version;
      /** A sign-in service that refuses every password, and keeps each client string it was sent. */
      function refusingService() {
        const sent: string[] = [];
        const serviceFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
          const headers = new Headers(
            input instanceof Request ? input.headers : (init?.headers ?? undefined),
          );
          if (init?.headers) new Headers(init.headers).forEach((v, k) => headers.set(k, v));
          if (String(input instanceof Request ? input.url : input).includes('/auth/v1/token')) {
            sent.push(headers.get('x-client-info') ?? '');
          }
          return new Response(
            JSON.stringify({
              code: 400,
              error_code: 'invalid_credentials',
              msg: 'Invalid login credentials',
            }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          );
        }) as typeof fetch;
        return { sent, serviceFetch };
      }
      const TYPED_VALUE = 'the-typed-value';
      const classOf = (client: string) =>
        bothOn(gatewayLine({ client, owner: 'Amazon Example Hosting' })).totals.values.caller;

      it('@supabase/supabase-js (the current-password check): `supabase-js/<version>; runtime=node; runtime-version=<node>`', async () => {
        const { createClient } = await import('@supabase/supabase-js');
        const { sent, serviceFetch } = refusingService();
        const client = createClient(PROJECT_URL, 'made-up-public-value', {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
          global: { fetch: serviceFetch },
        });
        const { error } = await client.auth.signInWithPassword({
          email: 'ada@example.com',
          password: TYPED_VALUE,
        });
        expect(error).not.toBeNull();
        expect(sent).toEqual([
          `supabase-js/${versionOf('@supabase/supabase-js')}; runtime=node; runtime-version=${process.version.replace(/^v/, '')}`,
        ]);
        expect(classOf(sent[0]!)).toBe('server');
      });

      it('@supabase/ssr createServerClient (the sign-in page and the code checks): `supabase-ssr/<version> createServerClient`', async () => {
        const { createServerClient } = await import('@supabase/ssr');
        const { sent, serviceFetch } = refusingService();
        const client = createServerClient(PROJECT_URL, 'made-up-public-value', {
          cookies: { getAll: () => [], setAll: () => undefined },
          global: { fetch: serviceFetch },
        });
        const { error } = await client.auth.signInWithPassword({
          email: 'ada@example.com',
          password: TYPED_VALUE,
        });
        expect(error).not.toBeNull();
        expect(sent).toEqual([`supabase-ssr/${versionOf('@supabase/ssr')} createServerClient`]);
        expect(classOf(sent[0]!)).toBe('server');
      });

      it('the strings the tests above use are of those two forms', () => {
        expect(classOf(SERVER_SSR)).toBe('server');
        expect(classOf(SERVER_NODE)).toBe('server');
      });
    });

    it('a line with no client string is other', () => {
      expect(bothOn(gatewayLine({ client: null })).totals.values.caller).toBe('other');
    });
  });

  it.each([
    ['NL', 'NL'],
    ['US', 'US'],
    ['XX', ''],
    ['T1', ''],
    ['nl', ''],
    ['NLD', ''],
    ['', ''],
  ])('the country %j comes back as %j', (country, back) => {
    expect(bothOn(gatewayLine({ country })).groups.values.country).toBe(back);
  });

  it('whatever a line holds, what comes back is a class, a status or a country, never its text', () => {
    const marker = 'zq9marker';
    const lines = [
      gatewayLine({ search: `?grant_type=password&${marker}=1`, client: `${marker}-client` }),
      gatewayLine({ search: `?grant_type=${marker}`, owner: `Amazon ${marker}` }),
      gatewayLine({ path: `/auth/v1/factors/${marker}/verify`, owner: `${marker} Telecom` }),
      gatewayLine({ path: '/auth/v1/%74oken', search: `?${marker}%zz`, client: '' }),
      gatewayLine({
        search: `?grant_type=password&grant_type=${marker}`,
        client: `supabase-ssr/0.1.2 createServerClient`,
      }),
      gatewayLine({
        path: `/auth/v1/factors/${UUID}/verify`,
        client: `createServerClient ${marker}`,
      }),
    ];
    for (const line of lines) {
      const { groups, totals } = bothOn(line);
      expect(JSON.stringify([groups.values, totals.values])).not.toContain(marker);
      expect(ALL_KINDS).toContain(groups.values.kind);
      expect(['plain', 'ambiguous']).toContain(totals.values.form);
      expect(['phone', 'server', 'other']).toContain(groups.values.caller);
      expect(['hosting', 'other']).toContain(groups.values.network);
      expect(['400', '404', '422', '429', 'other']).toContain(groups.values.status);
      expect(groups.values.country).toMatch(/^([A-Z]{2})?$/);
    }
  });

  it('the module reads no setting itself: the token comes in from the route, which reads the env module', () => {
    expect(source).not.toMatch(/process\.env/);
  });
});

// ── The run ─────────────────────────────────────────────────────────────────

describe('a run: six hours, oldest first, each written once', () => {
  const H = (hh: number) => Date.UTC(2026, 10, 21, hh);

  it('asks api.supabase.com only, with the token only in the Authorization header, the SQL constants and the hour', async () => {
    hourAnswers(H(5), [groupRow({}, H(5))]);
    const summary = await run();
    expect(fetches).toHaveLength(12);
    for (const [i, f] of fetches.entries()) {
      const u = new URL(f.url);
      expect(u.origin).toBe('https://api.supabase.com');
      expect(u.pathname).toBe(`/v1/projects/${PROJECT_REF}/analytics/endpoints/logs`);
      expect([...u.searchParams.keys()].sort()).toEqual([
        'iso_timestamp_end',
        'iso_timestamp_start',
        'sql',
      ]);
      // Each hour: its groups, then its totals.
      expect(sqlOf(f)).toBe(i % 2 === 0 ? AUTH_LOGS_GROUPS_SQL : AUTH_LOGS_TOTALS_SQL);
      const hh = 4 + Math.floor(i / 2);
      expect(startOf(f)).toBe(iso(H(hh)));
      expect(u.searchParams.get('iso_timestamp_end')).toBe(iso(H(hh + 1)));
      expect(f.url).not.toContain(MADE_UP_LOGS_VALUE);
      expect(f.init.method).toBe('GET');
      expect(f.init.redirect).toBe('error');
      const headers = new Headers(f.init.headers);
      expect(headers.get('authorization')).toBe(`Bearer ${MADE_UP_LOGS_VALUE}`);
      for (const [name, value] of headers)
        if (name !== 'authorization') expect(value).not.toContain(MADE_UP_LOGS_VALUE);
    }
    expect(summary).toMatchObject({
      ok: true,
      hoursRead: 6,
      hoursSkipped: 0,
      hoursStored: 1,
      eventsStored: 3,
    });
  });

  it('one writer call for an hour with something to store, none for an empty hour', async () => {
    hourAnswers(H(6), [groupRow({ n: 2 }, H(6)), groupRow({ status: '429', n: 1 }, H(6))]);
    await run();
    expect(h.rpc).toHaveBeenCalledTimes(1);
    const [name, args] = h.rpc.mock.calls[0]!;
    expect(name).toBe('record_security_events');
    expect(args).toEqual({
      p_events: [
        {
          category: 'bots',
          outcome: 'blocked',
          reason: 'auth_rate_limited',
          source: 'phone',
          count: 1,
          at_ms: H(6) + 5 * MIN,
          country: 'NL',
        },
        {
          category: 'password_guessing',
          outcome: 'blocked',
          reason: 'wrong_password',
          source: 'phone',
          count: 2,
          at_ms: H(6) + 5 * MIN,
          country: 'NL',
        },
      ],
    });
  });

  it('the "already stored" check: one read of rows only this job writes, inside the hour', async () => {
    await run();
    const checks = h.reads.filter((q) => q.select === 'id');
    expect(checks).toHaveLength(6);
    expect(checks[0]).toEqual({
      table: 'security_events',
      select: 'id',
      filters: [
        ['is', 'organization_id', null],
        ['in', 'source', ['phone', 'api']],
        [
          'in',
          'reason',
          [
            'wrong_password',
            'wrong_code',
            'auth_rate_limited',
            'auth_log_over_cap',
            'unclassified_sign_in_refusals',
            'unrecorded_server_form_password',
            'unrecorded_server_form_code',
            'too_many_forms_to_count',
          ],
        ],
        ['gte', 'minute', iso(H(4))],
        ['lt', 'minute', iso(H(5))],
      ],
      limit: 1,
    });
  });

  it('an hour is written once: the next run skips it and reads only the hours with nothing stored', async () => {
    hourAnswers(H(7), [groupRow({ n: 4 }, H(7))]);
    const first = await run();
    expect(first).toMatchObject({ hoursStored: 1, eventsStored: 4 });
    expect(h.rpc).toHaveBeenCalledTimes(1);

    fetches.length = 0;
    const second = await run();
    // Hour 07 holds rows now: not read, not written again. The empty hours are read again.
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect([...new Set(fetches.map(startOf))]).toEqual([4, 5, 6, 8, 9].map((hh) => iso(H(hh))));
    expect(second).toMatchObject({
      hoursSkipped: 1,
      hoursRead: 5,
      hoursStored: 0,
      eventsStored: 0,
    });
    expect(full(second).hours.find((x) => x.hour === '2026-11-21T07:00Z')).toMatchObject({
      hour: '2026-11-21T07:00Z',
      outcome: 'already_stored',
      events: 0,
    });
  });

  describe('the check is made again right before the write', () => {
    /** The reads of the "already stored" check for the hour starting at `startMs`. */
    const checksOf = (startMs: number) =>
      h.reads.filter(
        (q) => q.select === 'id' && q.filters.some((f) => f[0] === 'gte' && f[2] === iso(startMs)),
      );

    it('rows of the hour that appear between the first check and the write: the hour is not written a second time', async () => {
      hourAnswers(H(7), [groupRow({ n: 4 }, H(7))]);
      // Another run stores the hour while this one is reading the logs: the
      // first check finds nothing, the one before the write finds its rows.
      let asked = 0;
      h.readAnswer = (q) => {
        const forHour7 = q.filters.some((f) => f[0] === 'gte' && f[2] === iso(H(7)));
        if (!forHour7) return { data: [], error: null };
        asked += 1;
        return {
          data: asked === 1 ? [] : [{ id: '5eed0000-0000-4000-8000-00000000000a' }],
          error: null,
        };
      };
      const summary = full(await run());
      expect(h.rpc).not.toHaveBeenCalled();
      expect(summary).toMatchObject({
        ok: true,
        hoursStored: 0,
        eventsStored: 0,
        storedByAnotherRun: 1,
      });
      expect(summary.hours[3]).toMatchObject({ outcome: 'already_stored', events: 0 });
      expect(h.report).not.toHaveBeenCalled();
      // Two reads for that hour, and the second is the same read as the first.
      const checks = checksOf(H(7));
      expect(checks).toHaveLength(2);
      expect(checks[1]).toEqual(checks[0]);
    });

    it('it is the last thing before the writer call, and only for an hour with something to store', async () => {
      const order: string[] = [];
      const logged =
        (answer: Answer): Answer =>
        (init) => {
          order.push('logs');
          return answer(init);
        };
      const rows = [groupRow({ n: 4 }, H(7))];
      answers.set(`groups@${iso(H(7))}`, logged(ok(rows)));
      answers.set(`totals@${iso(H(7))}`, logged(ok(totalsFrom(rows, H(7)))));
      h.readAnswer = (q) => {
        if (q.filters.some((f) => f[0] === 'gte' && f[2] === iso(H(7)))) order.push('check');
        return { data: [], error: null };
      };
      h.rpc.mockImplementation(async (_name: string, args: { p_events: unknown[] }) => {
        order.push('write');
        return { data: args.p_events.length, error: null };
      });
      await run();
      // check, the two logs calls, the check again, the write, then the read that finds it.
      expect(order).toEqual(['check', 'logs', 'logs', 'check', 'write', 'check']);
      // An hour with nothing to store is checked once.
      expect(checksOf(H(4))).toHaveLength(1);
    });

    it('a second check that fails leaves the hour unwritten, for the next run', async () => {
      hourAnswers(H(7), [groupRow({ n: 4 }, H(7))]);
      let asked = 0;
      h.readAnswer = (q) => {
        const forHour7 = q.filters.some((f) => f[0] === 'gte' && f[2] === iso(H(7)));
        if (!forHour7) return { data: [], error: null };
        asked += 1;
        return asked === 1
          ? { data: [], error: null }
          : { data: null, error: { code: '57014', message: 'canceling statement' } };
      };
      const summary = full(await run());
      expect(h.rpc).not.toHaveBeenCalled();
      expect(summary.hours[3]).toMatchObject({
        outcome: 'failed',
        failure: { cause: 'db_read_failed', code: '57014' },
      });
    });
  });

  describe("the writer's own count of what it stored is read", () => {
    it('as many as were sent: nothing is said', async () => {
      hourAnswers(H(6), [groupRow({ n: 2 }, H(6)), groupRow({ status: '429', n: 1 }, H(6))]);
      const summary = full(await run());
      expect(summary).toMatchObject({ ok: true, hoursStored: 1, storedFewer: 0 });
      expect(h.report).not.toHaveBeenCalled();
    });

    it.each([
      ['fewer than were sent', 1],
      ['none', 0],
      ['no count at all', null],
      ['a count that is not a number', 'two'],
    ])('%s: the hour is stored, and the difference is reported once', async (_what, data) => {
      hourAnswers(H(6), [groupRow({ n: 2 }, H(6)), groupRow({ status: '429', n: 1 }, H(6))]);
      h.rpc.mockImplementation(
        async (
          _name: string,
          args: { p_events: Array<{ at_ms: number; reason: string; source: string }> },
        ) => {
          for (const e of args.p_events) {
            h.stored.push({
              hour: iso(Math.floor(e.at_ms / HOUR) * HOUR),
              reason: e.reason,
              source: e.source,
            });
          }
          return { data, error: null };
        },
      );
      const summary = full(await run());
      expect(summary).toMatchObject({ ok: true, hoursStored: 1, elements: 2, storedFewer: 1 });
      expect(h.report).toHaveBeenCalledTimes(1);
      const [err, ctx] = h.report.mock.calls[0]!;
      expect(String(err)).toContain('stored fewer');
      expect(ctx).toMatchObject({
        level: 'warning',
        extra: { cause: 'stored_fewer', hours: 1 },
      });
    });
  });

  describe('requests of an unknown form and known grants through a run', () => {
    it('a single refusal of an unknown form stores one flagged element; the hour is then already stored', async () => {
      hourAnswers(H(5), [], [totalsRow({ kind: 'token_other', n: 1 }, H(5))]);
      const summary = full(await run());
      expect(written()).toEqual([
        {
          category: 'password_guessing',
          outcome: 'flagged',
          reason: 'unclassified_sign_in_refusals',
          source: 'phone',
          count: 1,
          at_ms: H(5),
        },
      ]);
      expect(summary).toMatchObject({ unclassified: 1, hoursStored: 1, eventsStored: 1 });
      fetches.length = 0;
      const next = full(await run());
      expect(h.rpc).toHaveBeenCalledTimes(1);
      expect(fetches.map(startOf)).not.toContain(iso(H(5)));
      expect(next.hours[1]!.outcome).toBe('already_stored');
    });

    it('known grants that are not a password are counted in the log line only', async () => {
      hourAnswers(H(5), [], [totalsRow({ kind: 'token_known_other', n: 50 }, H(5))]);
      const summary = full(await run());
      expect(h.rpc).not.toHaveBeenCalled();
      expect(summary.notStored.known_other).toBe(50);
      expect(summary.seen).toEqual({ 'token_known_other 400 phone other': 50 });
    });

    it('several grant_type values: classed by the first, counted as ambiguous in the log line', async () => {
      hourAnswers(
        H(5),
        [groupRow({ n: 2 }, H(5))],
        [totalsRow({ n: 2, forms: 'ambiguous' }, H(5))],
      );
      const summary = full(await run());
      expect(written()).toEqual([expect.objectContaining({ reason: 'wrong_password', count: 2 })]);
      expect(summary.ambiguousFormGroups).toBe(1);
    });
  });

  describe("lines of our server's form, reconciled with our own record", () => {
    /** An hour whose lines of our server form are `password` 400s and `code` 422s. */
    function serverHour(startMs: number, password: number, code = 0, extra: Raw[] = []) {
      hourAnswers(
        startMs,
        [],
        [
          ...(password ? [totalsRow({ ...ours, n: password }, startMs)] : []),
          ...(code
            ? [totalsRow({ kind: 'verify', status: '422', ...ours, n: code }, startMs)]
            : []),
          ...extra,
        ],
      );
    }

    it('what our own server recorded for the hour: read by reason, a page at a time in a fixed order, with the count of rows', async () => {
      serverHour(H(5), 2);
      await run();
      expect(reconcileReads()).toEqual([
        {
          table: 'security_events',
          select: 'source, reason, event_count',
          count: 'exact',
          order: ['id', { ascending: true }],
          range: [0, AUTH_LOGS_RECONCILE_PAGE_ROWS - 1],
          filters: [
            ['in', 'source', ['web', 'phone']],
            ['eq', 'category', 'password_guessing'],
            [
              'in',
              'reason',
              [
                'wrong_password',
                'repeated_wrong_password',
                'wrong_current_password',
                'sign_in_refused_other',
                'wrong_code',
                'repeated_wrong_code',
                'wrong_setup_code',
                'over_minute_cap',
                'over_buffer_cap',
              ],
            ],
            ['gte', 'minute', iso(H(5))],
            ['lt', 'minute', iso(H(6))],
          ],
        },
      ]);
      expect(AUTH_LOGS_RECONCILE_PAGE_ROWS).toBe(1000);
      expect(AUTH_LOGS_RECONCILE_MAX_PAGES).toBe(10);
    });

    it('no read for an hour with no line of our server form', async () => {
      hourAnswers(H(5), [groupRow({}, H(5))]);
      await run();
      expect(reconcileReads()).toEqual([]);
    });

    it('an excess of 3 stores one flagged element; the next run skips the hour', async () => {
      serverHour(H(5), 18, 2);
      recordWeb(H(5), 'wrong_password', 12);
      recordWeb(H(5), 'repeated_wrong_password', 3);
      recordWeb(H(5), 'wrong_code', 2);
      // Not ours to count: another source, another category, another hour.
      recordWeb(H(5), 'wrong_password', 50, { source: 'api' });
      recordWeb(H(5), 'wrong_password', 50, { category: 'bots' });
      recordWeb(H(4), 'wrong_password', 50);
      const summary = full(await run());
      expect(written()).toEqual([
        {
          category: 'password_guessing',
          outcome: 'flagged',
          reason: 'unrecorded_server_form_password',
          source: 'api',
          count: 3,
          at_ms: H(5) + 59 * MIN,
        },
      ]);
      expect(summary.hours[1]).toMatchObject({
        outcome: 'stored',
        reconcile: {
          gateway: { password: 18, code: 2 },
          recorded: { password: 15, code: 2, overflow: 0, complete: true },
          excess: { password: 3, code: 0 },
        },
      });
      expect(summary.unrecordedFlags).toBe(1);
      fetches.length = 0;
      await run();
      expect(h.rpc).toHaveBeenCalledTimes(1);
      expect(fetches.map(startOf)).not.toContain(iso(H(5)));
    });

    it('an excess of 2 stores nothing and is in the log line', async () => {
      serverHour(H(5), 14);
      recordWeb(H(5), 'wrong_password', 12);
      const two = full(await run());
      expect(h.rpc).not.toHaveBeenCalled();
      expect(two.hours[1]).toMatchObject({ reconcile: { excess: { password: 2, code: 0 } } });
    });

    it('every refusal our own server records for a password or a code it sent is counted: ordinary use leaves no excess', async () => {
      // An hour in which an organization turns on a required authenticator:
      // mistyped sign-ins, current passwords and first codes, and one account
      // that is disabled.
      serverHour(H(5), 20, 9);
      recordWeb(H(5), 'wrong_password', 4);
      recordWeb(H(5), 'repeated_wrong_password', 1);
      recordWeb(H(5), 'wrong_current_password', 10);
      recordWeb(H(5), 'sign_in_refused_other', 5);
      recordWeb(H(5), 'wrong_code', 2);
      recordWeb(H(5), 'repeated_wrong_code', 1);
      recordWeb(H(5), 'wrong_setup_code', 6);
      // Refusals that never reach the sign-in service cover nothing.
      recordWeb(H(5), 'sign_in_paused', 40);
      recordWeb(H(5), 'code_checks_paused', 40);
      recordWeb(H(5), 'wrong_recovery_code', 40);
      const summary = full(await run());
      expect(h.rpc).not.toHaveBeenCalled();
      expect(summary.hours[1]).toMatchObject({
        reconcile: {
          gateway: { password: 20, code: 9 },
          recorded: { password: 20, code: 9, overflow: 0, complete: true },
          excess: { password: 0, code: 0 },
        },
      });
    });

    describe('a current-password check the phone app asked for through our API is our server sending a password too', () => {
      it('its refusals are recorded with the phone as their source, and are counted as recorded', async () => {
        serverHour(H(5), 9);
        recordWeb(H(5), 'wrong_password', 2);
        recordWeb(H(5), 'wrong_current_password', 4, { source: 'phone' });
        recordWeb(H(5), 'sign_in_refused_other', 3, { source: 'phone' });
        const summary = full(await run());
        expect(h.rpc).not.toHaveBeenCalled();
        expect(summary.hours[1]).toMatchObject({
          reconcile: {
            gateway: { password: 9, code: 0 },
            recorded: { password: 9, code: 0, overflow: 0, complete: true },
            excess: { password: 0, code: 0 },
          },
        });
      });

      it('no other row with the phone as its source counts: not the wrong passwords and codes this job stores, not an overflow row', async () => {
        // The phone app's own sign-ins go straight to the sign-in service;
        // this job stores their refusals with the phone as their source and
        // no organization. Anyone can make those, so counted as "recorded by
        // our server" they would hide refusals in our server's form.
        serverHour(H(5), 9, 6);
        recordWeb(H(5), 'wrong_password', 500, { source: 'phone' });
        recordWeb(H(5), 'repeated_wrong_password', 500, { source: 'phone' });
        recordWeb(H(5), 'wrong_code', 500, { source: 'phone' });
        recordWeb(H(5), 'wrong_setup_code', 500, { source: 'phone' });
        recordWeb(H(5), 'over_minute_cap', 500, { source: 'phone' });
        recordWeb(H(5), 'over_buffer_cap', 500, { source: 'phone' });
        // Nor a row of another source.
        recordWeb(H(5), 'wrong_current_password', 500, { source: 'api' });
        const summary = full(await run());
        expect(summary.hours[1]).toMatchObject({
          reconcile: {
            gateway: { password: 9, code: 6 },
            recorded: { password: 0, code: 0, overflow: 0, complete: true },
            excess: { password: 9, code: 6 },
          },
        });
        expect(written().map((e) => [e.reason, e.count])).toEqual([
          ['unrecorded_server_form_code', 6],
          ['unrecorded_server_form_password', 9],
        ]);
      });

      it('a row of a source that was not asked for fails the read', async () => {
        serverHour(H(5), 9);
        h.recordedAnswer = () => ({
          data: [{ source: 'api', reason: 'wrong_password', event_count: 9 }],
          error: null,
          count: 1,
        });
        const summary = full(await run());
        expect(h.rpc).not.toHaveBeenCalled();
        expect(summary.failure).toMatchObject({ cause: 'reconcile_read_failed', code: 'bad_row' });
      });
    });

    it.each([
      ['wrong_current_password', 'unrecorded_server_form_password'],
      ['sign_in_refused_other', 'unrecorded_server_form_password'],
      ['wrong_setup_code', 'unrecorded_server_form_code'],
    ])(
      '%s is one of the reasons compared: without its rows the hour is flagged',
      async (reason, flag) => {
        serverHour(H(5), 12, 8);
        for (const r of ['wrong_current_password', 'sign_in_refused_other', 'wrong_setup_code']) {
          if (r !== reason) recordWeb(H(5), r, 4);
        }
        recordWeb(H(5), 'wrong_password', 4);
        recordWeb(H(5), 'wrong_code', 4);
        const summary = full(await run());
        expect(written()).toEqual([expect.objectContaining({ reason: flag, count: 4 })]);
        expect(summary.unrecordedFlags).toBe(1);
      },
    );

    it('nine sources filling overflow rows do not hide an excess: the flag is stored, the overflow is only in the log line', async () => {
      serverHour(H(5), 30, 14);
      recordWeb(H(5), 'wrong_password', 12);
      // Refusals past the recorder's listed keys and the writer's minute
      // caps, as nine addresses hammering our own sign-in page would leave.
      for (let source = 0; source < 9; source++) recordWeb(H(5), 'over_buffer_cap', 500);
      recordWeb(H(5), 'over_minute_cap', 2_000);
      const summary = full(await run());
      expect(written()).toEqual([
        expect.objectContaining({
          outcome: 'flagged',
          reason: 'unrecorded_server_form_code',
          count: 14,
        }),
        expect.objectContaining({
          outcome: 'flagged',
          reason: 'unrecorded_server_form_password',
          count: 18,
        }),
      ]);
      expect(summary.hours[1]).toMatchObject({
        reconcile: {
          gateway: { password: 30, code: 14 },
          recorded: { password: 12, code: 0, overflow: 6_500, complete: true },
          excess: { password: 18, code: 14 },
        },
      });
      expect(summary.unrecordedFlags).toBe(2);
    });

    describe("the hour's edge: refusals stamped in one hour and recorded in the next are carried, and nothing else is", () => {
      const flagsOf = (call = 0) =>
        written(call).filter((e) => String(e.reason).startsWith('unrecorded_server_form_'));
      /** The reads of our own record, as [window start, window end]. */
      const windows = () =>
        reconcileReads().map((q) => [
          q.filters.find((f) => f[0] === 'gte')![2],
          q.filters.find((f) => f[0] === 'lt')![2],
        ]);

      it('three wrong passwords in the last moments of an hour, recorded in the first minute of the next: no flag', async () => {
        // The gateway stamps the request; our server stamps its record after
        // the answer. Posted through our own sign-in page just before 06:00,
        // the three are hour 05 at the gateway and 06:00 in our record.
        serverHour(H(5), 3);
        recordWeb(H(6), 'wrong_password', 3, { minute: 0 });
        const summary = full(await run());
        expect(h.rpc).not.toHaveBeenCalled();
        expect(h.report).not.toHaveBeenCalled();
        expect(summary.hours[1]).toMatchObject({
          outcome: 'nothing_to_store',
          reconcile: {
            gateway: { password: 3, code: 0 },
            recorded: { password: 0, code: 0, overflow: 0, complete: true },
            excess: { password: 0, code: 0 },
            carried: { password: 3, code: 0 },
          },
        });
        // Our record of hour 05, then of hour 06, then of its first minute.
        expect(windows()).toEqual([
          [iso(H(5)), iso(H(6))],
          [iso(H(6)), iso(H(7))],
          [iso(H(6)), iso(H(6) + MIN)],
        ]);
        // The next hour's totals are asked for once, and used again for that hour itself.
        expect(
          fetches.filter((f) => sqlOf(f) === AUTH_LOGS_TOTALS_SQL && startOf(f) === iso(H(6))),
        ).toHaveLength(1);
        expect(fetches).toHaveLength(12);
      });

      it('the rule cannot hide a real excess: what the next hour did not record at its edge is still flagged', async () => {
        // Three at the edge through our own page, and three more in our
        // server's form that our server never sent.
        serverHour(H(5), 6);
        recordWeb(H(6), 'wrong_password', 3, { minute: 0 });
        const summary = full(await run());
        expect(flagsOf()).toEqual([
          expect.objectContaining({ reason: 'unrecorded_server_form_password', count: 3 }),
        ]);
        expect(summary.hours[1]).toMatchObject({
          outcome: 'stored',
          reconcile: { excess: { password: 3, code: 0 }, carried: { password: 3, code: 0 } },
        });
      });

      it("the next hour's record is spent on its own gateway lines first: one recorded row never covers two refusals", async () => {
        // Hour 06 holds three refusals of its own in our server's form and
        // three recorded rows in its first minute. Those rows account for
        // hour 06; they cannot also take hour 05's three away.
        serverHour(H(5), 3);
        serverHour(H(6), 3);
        recordWeb(H(6), 'wrong_password', 3, { minute: 0 });
        const summary = full(await run());
        expect(h.rpc).toHaveBeenCalledTimes(1);
        expect(flagsOf()).toEqual([
          expect.objectContaining({
            reason: 'unrecorded_server_form_password',
            count: 3,
            at_ms: H(5) + 59 * MIN,
          }),
        ]);
        expect(summary.hours[1]).toMatchObject({
          reconcile: { excess: { password: 3, code: 0 }, carried: { password: 0, code: 0 } },
        });
        expect(summary.hours[2]).toMatchObject({
          outcome: 'nothing_to_store',
          reconcile: { excess: { password: 0, code: 0 } },
        });
      });

      it('only the first minute of the next hour carries: a later record does not', async () => {
        serverHour(H(5), 3);
        recordWeb(H(6), 'wrong_password', 3, { minute: 1 });
        recordWeb(H(6), 'wrong_password', 40, { minute: 30 });
        await run();
        expect(flagsOf()).toEqual([expect.objectContaining({ count: 3 })]);
      });

      it('only rows whose reason names the kind carry: overflow rows and refusals that never reach the sign-in service do not', async () => {
        serverHour(H(5), 4, 3);
        recordWeb(H(6), 'over_buffer_cap', 500, { minute: 0 });
        recordWeb(H(6), 'over_minute_cap', 500, { minute: 0 });
        recordWeb(H(6), 'sign_in_paused', 500, { minute: 0 });
        // Passwords carry passwords; codes need rows of their own.
        recordWeb(H(6), 'wrong_current_password', 4, { minute: 0 });
        const summary = full(await run());
        expect(flagsOf()).toEqual([
          expect.objectContaining({ reason: 'unrecorded_server_form_code', count: 3 }),
        ]);
        expect(summary.hours[1]).toMatchObject({
          reconcile: { excess: { password: 0, code: 3 }, carried: { password: 4, code: 0 } },
        });
      });

      it('codes at the edge are carried the same way', async () => {
        serverHour(H(5), 0, 3);
        recordWeb(H(6), 'wrong_code', 2, { minute: 0 });
        recordWeb(H(6), 'wrong_setup_code', 1, { minute: 0 });
        const summary = full(await run());
        expect(h.rpc).not.toHaveBeenCalled();
        expect(summary.hours[1]).toMatchObject({
          reconcile: { excess: { password: 0, code: 0 }, carried: { password: 0, code: 3 } },
        });
      });

      it('an excess below the threshold never looks at the next hour', async () => {
        serverHour(H(5), 2);
        recordWeb(H(6), 'wrong_password', 2, { minute: 0 });
        const summary = full(await run());
        expect(windows()).toEqual([[iso(H(5)), iso(H(6))]]);
        expect(summary.hours[1]!.reconcile?.carried).toBeUndefined();
      });

      it("the next hour's totals not whole: nothing is carried (its gateway count could be short), and the flag is stored", async () => {
        serverHour(H(5), 3);
        hourAnswers(H(6), [], [totalsRow({ kind: 'mystery' }, H(6))]);
        recordWeb(H(6), 'wrong_password', 3, { minute: 0 });
        const summary = full(await run());
        expect(flagsOf()).toEqual([expect.objectContaining({ count: 3, at_ms: H(5) + 59 * MIN })]);
        expect(summary.hours[1]!.reconcile?.carried).toBeUndefined();
      });

      it('the newest hour waits one run when it would be flagged: the hour after it is not complete yet', async () => {
        // 09:00 to 10:00 is the newest complete hour at 10:10. Its edge
        // refusals are recorded in hour 10, which is still running.
        hourAnswers(
          H(9),
          [groupRow({ n: 2 }, H(9))],
          [totalsRow({ n: 2 }, H(9)), totalsRow({ ...ours, n: 3 }, H(9))],
        );
        recordWeb(H(10), 'wrong_password', 3, { minute: 0 });
        const first = full(await run());
        expect(h.rpc).not.toHaveBeenCalled();
        expect(h.report).not.toHaveBeenCalled();
        expect(first).toMatchObject({ ok: true, hoursWaiting: 1, hoursStored: 0 });
        expect(first.hours[5]).toMatchObject({
          hour: '2026-11-21T09:00Z',
          outcome: 'waiting',
          events: 0,
          reconcile: { gateway: { password: 3, code: 0 }, excess: { password: 3, code: 0 } },
        });
        // An hour later the hour after it is complete: the three are carried,
        // and the hour's ordinary counts are stored, once.
        const next = full(await run({ nowMs: NOW + HOUR }));
        expect(written()).toEqual([
          expect.objectContaining({ reason: 'wrong_password', count: 2 }),
        ]);
        expect(next).toMatchObject({ hoursWaiting: 0, hoursStored: 1 });
        expect(next.hours[4]).toMatchObject({
          hour: '2026-11-21T09:00Z',
          outcome: 'stored',
          reconcile: { excess: { password: 0, code: 0 }, carried: { password: 3, code: 0 } },
        });
      });

      it('a waiting hour whose totals were not whole is reported in the same run, and flagged by the next', async () => {
        // The newest hour would be flagged (three in our server's form, no
        // record) and one of its totals rows fails its checks.
        hourAnswers(
          H(9),
          [],
          [totalsRow({ ...ours, n: 3 }, H(9)), totalsRow({ kind: 'mystery' }, H(9))],
        );
        const first = full(await run());
        expect(h.rpc).not.toHaveBeenCalled();
        expect(first.hours[5]).toMatchObject({ outcome: 'waiting', totalsIncomplete: true });
        expect(first).toMatchObject({
          hoursWaiting: 1,
          totalsIncomplete: 1,
          totalsIncompleteWaiting: 1,
          totalsRowsDropped: 1,
        });
        expect(reportCauses()).toEqual(['totals_incomplete']);
        expect(reportsOf('totals_incomplete')[0]![1]).toMatchObject({
          extra: { cause: 'totals_incomplete', hours: 1, full: 0, rowsDropped: 1, waiting: 1 },
        });
        // The next run decides the hour: stored with its flagged counts, and
        // reported again, this time as stored.
        h.report.mockClear();
        const next = full(await run({ nowMs: NOW + HOUR }));
        expect(next.hours[4]).toMatchObject({ outcome: 'stored', totalsIncomplete: true });
        expect(written().map((e) => [e.reason, e.count])).toEqual([
          ['too_many_forms_to_count', 3],
          ['unrecorded_server_form_password', 3],
        ]);
        expect(reportsOf('totals_incomplete')[0]![1]).toMatchObject({
          extra: { cause: 'totals_incomplete', hours: 1, waiting: 0 },
        });
      });

      it('the newest hour that would be flagged and has no record at its edge is flagged by the next run', async () => {
        serverHour(H(9), 5);
        const first = full(await run());
        expect(h.rpc).not.toHaveBeenCalled();
        expect(first.hours[5]!.outcome).toBe('waiting');
        await run({ nowMs: NOW + HOUR });
        expect(flagsOf()).toEqual([
          expect.objectContaining({ reason: 'unrecorded_server_form_password', count: 5 }),
        ]);
      });

      it('the newest hour with nothing to flag is stored at once, as before', async () => {
        hourAnswers(
          H(9),
          [groupRow({ n: 2 }, H(9))],
          [totalsRow({ n: 2 }, H(9)), totalsRow({ ...ours, n: 2 }, H(9))],
        );
        const summary = full(await run());
        expect(summary).toMatchObject({ hoursWaiting: 0, hoursStored: 1 });
        expect(summary.hours[5]!.outcome).toBe('stored');
      });

      it('a read for the carry that fails leaves the hour for the next run: no flag is stored on a guess', async () => {
        serverHour(H(5), 3);
        answers.set(`totals@${iso(H(6))}`, status(503));
        const summary = full(await run());
        expect(h.rpc).not.toHaveBeenCalled();
        expect(summary.hours[1]).toMatchObject({
          outcome: 'failed',
          failure: { cause: 'logs_unavailable', status: 503 },
        });
      });
    });

    describe('many recorded rows: read in pages, never skipped', () => {
      const manyRows = (startMs: number, rows: number) => {
        for (let i = 0; i < rows; i++) recordWeb(startMs, 'wrong_password', 1);
      };

      it('1,001 recorded rows: two pages, every row counted, the comparison is made', async () => {
        serverHour(H(5), 1_020);
        manyRows(H(5), 1_001);
        const summary = full(await run());
        // The pages of hour 05 (the hour after it is read too, for the edge).
        const pages = reconcileReads().filter((q) =>
          q.filters.some((f) => f[0] === 'gte' && f[2] === iso(H(5))),
        );
        expect(pages.map((q) => q.range)).toEqual([
          [0, 999],
          [1000, 1999],
        ]);
        // The same read each time, in the same order; the count of rows once.
        expect(pages.map((q) => q.count)).toEqual(['exact', undefined]);
        for (const q of pages) {
          expect(q.order).toEqual(['id', { ascending: true }]);
          expect(q.filters).toEqual(pages[0]!.filters);
        }
        expect(summary.hours[1]).toMatchObject({
          outcome: 'stored',
          reconcile: {
            recorded: { password: 1_001, code: 0, overflow: 0, complete: true },
            excess: { password: 19, code: 0 },
          },
        });
        expect(written()).toEqual([
          expect.objectContaining({ reason: 'unrecorded_server_form_password', count: 19 }),
        ]);
        expect(summary.reconcileIncomplete).toBe(0);
        // Nothing is said about the read; the stored flag has its own report.
        expect(reportCauses()).toEqual(['flagged_stored']);
      });

      it('1,001 recorded rows that cover the gateway count: no flag', async () => {
        serverHour(H(5), 1_003);
        manyRows(H(5), 1_001);
        const summary = full(await run());
        expect(h.rpc).not.toHaveBeenCalled();
        expect(summary.hours[1]!.reconcile?.excess).toEqual({ password: 2, code: 0 });
      });

      it('10,001 recorded rows: the read stops at ten pages and FAILS CLOSED, compared with what it read, and says so', async () => {
        // Honest traffic alone: the gateway and our record agree (10,001 each).
        serverHour(H(5), 10_001);
        manyRows(H(5), 10_001);
        const summary = full(await run());
        expect(reconcileReads()).toHaveLength(AUTH_LOGS_RECONCILE_MAX_PAGES);
        expect(summary.hours[1]).toMatchObject({
          outcome: 'nothing_to_store',
          reconcile: {
            gateway: { password: 10_001, code: 0 },
            recorded: { password: 10_000, code: 0, overflow: 0, complete: false },
            excess: { password: 1, code: 0 },
          },
        });
        expect(summary.reconcileIncomplete).toBe(1);
        expect(h.report).toHaveBeenCalledTimes(1);
        const [err, ctx] = h.report.mock.calls[0]!;
        expect(String(err)).toContain('could not all be read');
        expect(ctx).toMatchObject({
          level: 'warning',
          extra: { cause: 'reconcile_incomplete', hours: 1 },
        });
      });

      it('more recorded rows than the read takes never hide an excess: the comparison is made and the flag stored', async () => {
        // 10,001 rows of our own record, and 40 more refusals on the gateway
        // than we recorded.
        serverHour(H(5), 10_041);
        manyRows(H(5), 10_001);
        const summary = full(await run());
        expect(written()).toEqual([
          {
            category: 'password_guessing',
            outcome: 'flagged',
            reason: 'unrecorded_server_form_password',
            source: 'api',
            // Against the 10,000 that were read: never less than the true excess.
            count: 41,
            at_ms: H(5) + 59 * MIN,
          },
        ]);
        expect(summary.hours[1]).toMatchObject({
          outcome: 'stored',
          reconcile: { recorded: { password: 10_000, complete: false } },
        });
        expect(summary.reconcileIncomplete).toBe(1);
      });

      it('a server that returns fewer rows than asked for: the read goes on from where it stopped', async () => {
        h.serverMaxRows = 400;
        serverHour(H(5), 1_001);
        manyRows(H(5), 1_001);
        const summary = full(await run());
        expect(reconcileReads().map((q) => q.range)).toEqual([
          [0, 999],
          [400, 1399],
          [800, 1799],
        ]);
        expect(summary.hours[1]).toMatchObject({
          reconcile: {
            recorded: { password: 1_001, complete: true },
            excess: { password: 0, code: 0 },
          },
        });
        expect(h.rpc).not.toHaveBeenCalled();
        expect(h.report).not.toHaveBeenCalled();
      });

      it('a count of rows above what the pages hold: fails closed on what was read, said once', async () => {
        hourAnswers(
          H(5),
          [groupRow({ n: 2 }, H(5))],
          [totalsRow({ n: 2 }, H(5)), totalsRow({ ...ours, n: 500 }, H(5))],
        );
        h.recordedAnswer = (q) =>
          q.range?.[0] === 0 && q.filters.some((f) => f[0] === 'gte' && f[2] === iso(H(5)))
            ? {
                data: [{ source: 'web', reason: 'wrong_password', event_count: 3 }],
                error: null,
                count: 5000,
              }
            : { data: [], error: null, count: q.count === 'exact' ? 0 : null };
        const summary = full(await run());
        expect(written()).toEqual([
          expect.objectContaining({ reason: 'wrong_password', count: 2 }),
          expect.objectContaining({ reason: 'unrecorded_server_form_password', count: 497 }),
        ]);
        expect(summary).toMatchObject({ ok: true, reconcileIncomplete: 1 });
        expect(summary.hours[1]).toMatchObject({
          reconcile: {
            gateway: { password: 500, code: 0 },
            recorded: { password: 3, code: 0, overflow: 0, complete: false },
            excess: { password: 497, code: 0 },
          },
        });
        expect(reportCauses().sort()).toEqual(['flagged_stored', 'reconcile_incomplete']);
        expect(String(reportsOf('reconcile_incomplete')[0]![0])).toContain('could not all be read');
      });

      it('a page that fails part way: a failed read, nothing of the hour is written', async () => {
        serverHour(H(5), 2_000);
        h.recordedAnswer = (q) =>
          q.range?.[0] === 0
            ? {
                data: Array.from({ length: 1000 }, () => ({
                  source: 'web',
                  reason: 'wrong_password',
                  event_count: 1,
                })),
                error: null,
                count: 1500,
              }
            : { data: null, error: { code: '57014', message: 'canceling statement' }, count: null };
        const summary = full(await run());
        expect(h.rpc).not.toHaveBeenCalled();
        expect(summary.failure).toMatchObject({ cause: 'reconcile_read_failed', code: '57014' });
        expect(summary.hours[1]!.outcome).toBe('failed');
      });
    });

    it('a failed reconciliation read: reported, nothing of the hour is written, and the hour is read again next run', async () => {
      hourAnswers(
        H(5),
        [groupRow({ n: 2 }, H(5))],
        [totalsRow({ n: 2 }, H(5)), totalsRow({ ...ours, n: 40 }, H(5))],
      );
      h.recordedAnswer = () => ({
        data: null,
        error: { code: '57014', message: 'canceling statement' },
        count: null,
      });
      const summary = full(await run());
      expect(h.rpc).not.toHaveBeenCalled();
      expect(summary).toMatchObject({
        ok: false,
        hoursStored: 0,
        failure: { cause: 'reconcile_read_failed', code: '57014', hour: '2026-11-21T05:00Z' },
      });
      expect(h.report).toHaveBeenCalledTimes(1);
      expect(String(h.report.mock.calls[0]![0])).toContain('could not be read');

      h.recordedAnswer = null;
      recordWeb(H(5), 'wrong_password', 40);
      fetches.length = 0;
      const next = full(await run());
      expect(fetches.map(startOf)).toContain(iso(H(5)));
      expect(written()).toEqual([expect.objectContaining({ reason: 'wrong_password', count: 2 })]);
      expect(next.hours[1]!.outcome).toBe('stored');
    });

    it.each([
      ['no count of rows', () => ({ data: [], error: null, count: null })],
      [
        'a row of another reason',
        () => ({
          data: [{ source: 'web', reason: 'sign_in_paused', event_count: 1 }],
          error: null,
          count: 1,
        }),
      ],
      [
        'a row with no whole count',
        () => ({
          data: [{ source: 'web', reason: 'wrong_password', event_count: 'x' }],
          error: null,
          count: 1,
        }),
      ],
      [
        'a row with no source',
        () => ({ data: [{ reason: 'wrong_password', event_count: 1 }], error: null, count: 1 }),
      ],
      ['no rows list', () => ({ data: null, error: null, count: 0 })],
    ])('%s: a failed reconciliation read', async (_what, answer) => {
      serverHour(H(5), 40);
      h.recordedAnswer = answer;
      const summary = full(await run());
      expect(h.rpc).not.toHaveBeenCalled();
      expect(summary.failure).toMatchObject({ cause: 'reconcile_read_failed' });
    });
  });

  describe('totals that are not whole are never stored as if they were', () => {
    /** 199 rows: as many as the query's limit lets through. */
    const fullTotals = (startMs: number, extra: Raw[] = []) => [
      ...extra,
      ...Array.from({ length: AUTH_LOGS_ROW_LIMIT - extra.length }, () =>
        totalsRow({ kind: 'refresh', caller: 'other', n: 5 }, startMs),
      ),
    ];
    it('a full totals answer: one flagged element for the hour, and one report for the run', async () => {
      hourAnswers(H(5), [groupRow({ n: 4 }, H(5))], fullTotals(H(5), [totalsRow({ n: 4 }, H(5))]));
      const summary = full(await run());
      expect(written()).toEqual([
        {
          category: 'password_guessing',
          outcome: 'flagged',
          reason: 'too_many_forms_to_count',
          source: 'api',
          count: 4 + 198 * 5,
          at_ms: H(5),
        },
        expect.objectContaining({ reason: 'wrong_password', outcome: 'blocked', count: 4 }),
      ]);
      expect(summary).toMatchObject({
        ok: true,
        hoursStored: 1,
        totalsCapped: 1,
        totalsIncomplete: 1,
        totalsRowsDropped: 0,
      });
      expect(summary.hours[1]).toMatchObject({ outcome: 'stored', totalsIncomplete: true });
      expect(summary.hours[0]!.totalsIncomplete).toBeUndefined();
      expect(reportsOf('totals_incomplete')).toHaveLength(1);
      const [err, ctx] = reportsOf('totals_incomplete')[0]!;
      expect(String(err)).toContain('were not whole');
      expect(ctx).toMatchObject({
        tag: 'cron.security-events-auth-logs',
        level: 'warning',
        extra: { cause: 'totals_incomplete', hours: 1, full: 1, rowsDropped: 0, waiting: 0 },
      });
      // The hour is stored: the next run does not read it again.
      fetches.length = 0;
      await run();
      expect(fetches.map(startOf)).not.toContain(iso(H(5)));
    });

    it("our server's row cut off by a flood of other groups still ends in a flag, not in silence", async () => {
      // The answer is full and holds no row of our server's form: whatever
      // that row would have said is not known. Nothing is compared, and the
      // hour is not clean: it carries the flagged count and is reported.
      hourAnswers(H(5), [], fullTotals(H(5)));
      const summary = full(await run());
      expect(written()).toEqual([
        expect.objectContaining({
          outcome: 'flagged',
          reason: 'too_many_forms_to_count',
          count: 199 * 5,
        }),
      ]);
      expect(summary.hours[1]).toMatchObject({
        outcome: 'stored',
        totalsIncomplete: true,
        reconcile: { gateway: { password: 0, code: 0 }, recorded: null },
      });
      expect(reconcileReads()).toEqual([]);
      expect(reportsOf('totals_incomplete')).toHaveLength(1);
    });

    it("a full answer that still holds our server's row is compared with what was read", async () => {
      hourAnswers(H(5), [], fullTotals(H(5), [totalsRow({ ...ours, n: 9 }, H(5))]));
      recordWeb(H(5), 'wrong_password', 2);
      const summary = full(await run());
      expect(written().map((e) => [e.reason, e.count])).toEqual([
        ['too_many_forms_to_count', 9 + 198 * 5],
        ['unrecorded_server_form_password', 7],
      ]);
      expect(summary.hours[1]).toMatchObject({
        totalsIncomplete: true,
        reconcile: { gateway: { password: 9, code: 0 }, excess: { password: 7, code: 0 } },
      });
    });

    it('full answers in several hours are reported once for the run, with how many', async () => {
      for (const hh of [4, 6, 9]) hourAnswers(H(hh), [], fullTotals(H(hh)));
      const summary = full(await run());
      expect(summary).toMatchObject({ totalsCapped: 3, totalsIncomplete: 3, hoursStored: 3 });
      expect(reportsOf('totals_incomplete')).toHaveLength(1);
      expect(reportsOf('totals_incomplete')[0]![1]).toMatchObject({
        extra: { cause: 'totals_incomplete', hours: 3, full: 3, rowsDropped: 0 },
      });
    });

    it('a totals row that fails its checks makes the hour incomplete in the same way: flagged and reported, never only counted', async () => {
      hourAnswers(
        H(5),
        [],
        [
          totalsRow({ kind: 'refresh', n: 6 }, H(5)),
          // Our server's row, with an instant outside the hour: not read.
          totalsRow({ ...ours, n: 50, last_seen: chTime(H(6) + 5_000) }, H(5)),
          totalsRow({ kind: 'mystery' }, H(5)),
        ],
      );
      const summary = full(await run());
      expect(written()).toEqual([
        expect.objectContaining({
          outcome: 'flagged',
          reason: 'too_many_forms_to_count',
          source: 'api',
          count: 6,
        }),
      ]);
      expect(summary).toMatchObject({
        totalsCapped: 0,
        totalsIncomplete: 1,
        totalsRowsDropped: 2,
        dropped: 2,
      });
      expect(summary.hours[1]).toMatchObject({ outcome: 'stored', totalsIncomplete: true });
      expect(reportsOf('totals_incomplete')[0]![1]).toMatchObject({
        level: 'warning',
        extra: { cause: 'totals_incomplete', hours: 1, full: 0, rowsDropped: 2 },
      });
    });

    it('whole totals say nothing', async () => {
      hourAnswers(H(5), [groupRow({ n: 4 }, H(5))]);
      const summary = full(await run());
      expect(summary).toMatchObject({ totalsCapped: 0, totalsIncomplete: 0, totalsRowsDropped: 0 });
      expect(h.report).not.toHaveBeenCalled();
      expect(written().map((e) => e.reason)).toEqual(['wrong_password']);
    });
  });

  describe("a line on the instant an hour ends takes no row away, and is stored with the next hour's", () => {
    const END5 = '2026-11-21 06:00:00.000000000';

    it("our server's row whose last line is on that instant is still compared with our own record", async () => {
      hourAnswers(H(5), [], [totalsRow({ ...ours, n: 9, last_seen: END5 }, H(5))]);
      recordWeb(H(5), 'wrong_password', 2);
      const summary = full(await run());
      expect(written()).toEqual([
        expect.objectContaining({ reason: 'unrecorded_server_form_password', count: 7 }),
      ]);
      expect(summary).toMatchObject({ dropped: 0, totalsIncomplete: 0 });
      expect(summary.hours[1]).toMatchObject({
        reconcile: { gateway: { password: 9, code: 0 }, excess: { password: 7, code: 0 } },
      });
    });

    it('a group row at the minute the hour ends is left to the next hour: not stored here, not counted as dropped', async () => {
      hourAnswers(
        H(5),
        [groupRow({ n: 2 }, H(5)), groupRow({ minute: minuteOf(H(5), 60), n: 1 }, H(5))],
        [totalsRow({ n: 3, last_seen: END5 }, H(5))],
      );
      const summary = full(await run());
      expect(written()).toEqual([
        expect.objectContaining({ reason: 'wrong_password', count: 2, at_ms: H(5) + 5 * MIN }),
      ]);
      expect(summary).toMatchObject({
        dropped: 0,
        atHourEnd: 1,
        totalsIncomplete: 0,
        remainderSkipped: 0,
      });
      // Nothing was stored on a minute of the next hour, so that hour is still read and written.
      expect(h.stored.map((row) => row.hour)).toEqual([iso(H(5))]);
      expect(h.report).not.toHaveBeenCalled();
    });

    it('such a row among full groups does not cancel the remainder', async () => {
      const rows = [
        ...Array.from({ length: AUTH_LOGS_ROW_LIMIT - 1 }, (_, i) =>
          groupRow(
            {
              minute: minuteOf(H(8), i % 60),
              country: ['NL', 'US', 'DE', 'FR'][Math.floor(i / 60)]!,
              n: 2,
            },
            H(8),
          ),
        ),
        groupRow({ minute: minuteOf(H(8), 60), n: 1 }, H(8)),
      ];
      hourAnswers(H(8), rows, [
        totalsRow({ n: 198 * 2 + 1 + 30, last_seen: '2026-11-21 09:00:00.000000000' }, H(8)),
      ]);
      const summary = full(await run());
      const elements = written() as Array<{ reason: string; count: number; at_ms: number }>;
      expect(summary).toMatchObject({ capped: 1, remainderSkipped: 0, atHourEnd: 1, dropped: 0 });
      // The 30 not listed, and the one line on the last instant (counted here
      // as well as in its own hour: one line more is the safe direction).
      expect(elements.filter((e) => e.reason === 'auth_log_over_cap')).toEqual([
        expect.objectContaining({ count: 31 }),
      ]);
      expect(elements.every((e) => e.at_ms < H(9))).toBe(true);
    });
  });

  describe('a flagged count that is stored is also reported: it has no organization, so no page of an organization shows it', () => {
    it('one unknown form: one warning for the run, with the count by reason', async () => {
      hourAnswers(H(5), [], [totalsRow({ kind: 'token_other', n: 4 }, H(5))]);
      const summary = full(await run());
      expect(summary).toMatchObject({
        ok: true,
        flaggedHours: 1,
        flaggedStored: { unclassified_sign_in_refusals: 4 },
      });
      expect(h.report).toHaveBeenCalledTimes(1);
      const [err, ctx] = h.report.mock.calls[0]!;
      expect(String(err)).toContain('Flagged counts of refused sign-ins were stored');
      expect(String(err)).toContain('no organization');
      // The page lists a fixed number of the newest rows, of every
      // organization: the report says so, and names the hour to look for.
      expect(String(err)).toContain(
        "the platform console's Security page shows them among its newest entries",
      );
      expect(String(err)).toContain('The first flagged hour (UTC)');
      expect(summary.firstFlaggedHour).toBe('2026-11-21T05:00Z');
      expect(ctx).toEqual({
        tag: 'cron.security-events-auth-logs',
        level: 'warning',
        extra: {
          cause: 'flagged_stored',
          hours: 1,
          hour: '2026-11-21T05:00Z',
          unclassified_sign_in_refusals: 4,
        },
      });
    });

    it('every kind of flag, over several hours: still one report, the counts added up by reason', async () => {
      // Hour 04: unknown forms from two sources, and our server's form with no record.
      hourAnswers(
        H(4),
        [groupRow({ n: 2 }, H(4))],
        [
          totalsRow({ n: 2 }, H(4)),
          totalsRow({ kind: 'token_other', n: 3 }, H(4)),
          totalsRow({ kind: 'verify_other', status: '422', caller: 'other', n: 2 }, H(4)),
          totalsRow({ ...ours, n: 6 }, H(4)),
          totalsRow({ kind: 'verify', status: '422', ...ours, n: 4 }, H(4)),
        ],
      );
      // Hour 07: an unknown form again, and totals that were not whole.
      hourAnswers(
        H(7),
        [],
        [totalsRow({ kind: 'token_other', n: 1 }, H(7)), totalsRow({ kind: 'mystery' }, H(7))],
      );
      // Hour 08: an ordinary hour.
      hourAnswers(H(8), [groupRow({ n: 9 }, H(8))]);
      const summary = full(await run());
      expect(summary).toMatchObject({
        hoursStored: 3,
        flaggedHours: 2,
        flaggedStored: {
          unclassified_sign_in_refusals: 6,
          unrecorded_server_form_password: 6,
          unrecorded_server_form_code: 4,
          too_many_forms_to_count: 1,
        },
      });
      expect(reportCauses().sort()).toEqual(['flagged_stored', 'totals_incomplete']);
      // The first flagged hour is the oldest (04), not the last one run (07).
      expect(reportsOf('flagged_stored')[0]![1]).toEqual({
        tag: 'cron.security-events-auth-logs',
        level: 'warning',
        extra: {
          cause: 'flagged_stored',
          hours: 2,
          hour: '2026-11-21T04:00Z',
          unclassified_sign_in_refusals: 6,
          unrecorded_server_form_password: 6,
          unrecorded_server_form_code: 4,
          too_many_forms_to_count: 1,
        },
      });
    });

    it('an ordinary run, with wrong passwords and codes stored and no flag, reports nothing', async () => {
      hourAnswers(H(5), [
        groupRow({ n: 40 }, H(5)),
        groupRow({ kind: 'verify', status: '422', caller: 'other', n: 7 }, H(5)),
        groupRow({ status: '429', n: 3 }, H(5)),
      ]);
      hourAnswers(
        H(6),
        [],
        [
          totalsRow({ kind: 'refresh', n: 500 }, H(6)),
          totalsRow({ kind: 'token_other', status: '404', n: 30 }, H(6)),
          totalsRow({ ...ours, n: 2 }, H(6)),
        ],
      );
      const summary = full(await run());
      expect(summary).toMatchObject({
        ok: true,
        hoursStored: 1,
        eventsStored: 50,
        flaggedHours: 0,
        flaggedStored: {},
      });
      expect(h.report).not.toHaveBeenCalled();
    });

    it('a flagged count that was not stored is not reported as stored', async () => {
      hourAnswers(H(5), [], [totalsRow({ kind: 'token_other', n: 4 }, H(5))]);
      h.rpc.mockResolvedValueOnce({ data: null, error: { code: '55P03', message: 'lock' } });
      const summary = full(await run());
      expect(summary).toMatchObject({
        hoursStored: 0,
        flaggedHours: 0,
        firstFlaggedHour: null,
        flaggedStored: {},
      });
      expect(reportCauses()).toEqual(['writer_failed']);
    });

    it('the report holds counts, reason codes and the hour only', async () => {
      hourAnswers(H(5), [], [totalsRow({ kind: 'token_other', n: 4 }, H(5))]);
      await run();
      const [err, ctx] = reportsOf('flagged_stored')[0]!;
      expect(String(err)).not.toMatch(/[0-9]/);
      for (const [key, value] of Object.entries((ctx as { extra: object }).extra)) {
        expect(key).toMatch(/^[a-z_]+$/);
        if (key === 'hour') expect(value).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:00Z$/);
        else expect(typeof value === 'number' || value === 'flagged_stored', key).toBe(true);
      }
    });
  });

  it('past the 199 groups the remainder is stored with the hour', async () => {
    const rows = Array.from({ length: AUTH_LOGS_ROW_LIMIT }, (_, i) =>
      groupRow(
        {
          minute: minuteOf(H(8), i % 60),
          country: ['NL', 'US', 'DE', 'FR'][Math.floor(i / 60)]!,
          n: 1,
        },
        H(8),
      ),
    );
    hourAnswers(H(8), rows, [totalsRow({ n: 199 + 40 }, H(8))]);
    const summary = await run();
    const elements = written() as Array<{ reason: string; count: number }>;
    expect(elements.length).toBeLessThanOrEqual(200);
    expect(elements.reduce((s, e) => s + e.count, 0)).toBe(239);
    expect(elements.filter((e) => e.reason === 'auth_log_over_cap')).toHaveLength(1);
    expect(summary).toMatchObject({ capped: 1, eventsStored: 239 });
  });

  it('a row that fails validation is dropped and counted; the rest is stored', async () => {
    hourAnswers(
      H(4),
      [
        groupRow({ n: 2 }),
        groupRow({ status: 'x' }),
        groupRow({ minute: minuteOf(H(4), 61) }),
        'junk',
      ],
      [totalsRow({ n: 2 }), totalsRow({ kind: 'mystery' })],
    );
    const summary = await run();
    // The wrong passwords (2), and the flagged count of an hour whose totals
    // were not whole (the 2 that were read).
    expect(summary).toMatchObject({ dropped: 4, groups: 1, eventsStored: 4, totalsIncomplete: 1 });
    expect(written().map((e) => [e.reason, e.count])).toEqual([
      ['too_many_forms_to_count', 2],
      ['wrong_password', 2],
    ]);
  });

  it('a group row that fails validation is dropped and counted; the totals stay whole', async () => {
    hourAnswers(
      H(4),
      [groupRow({ n: 2 }), groupRow({ status: 'x' }), 'junk'],
      [totalsRow({ n: 2 })],
    );
    const summary = await run();
    expect(summary).toMatchObject({ dropped: 2, groups: 1, eventsStored: 2, totalsIncomplete: 0 });
    expect(h.report).not.toHaveBeenCalled();
  });

  it("our server's client string: ours from a hosting network, stored as api from any other", async () => {
    hourAnswers(H(4), [
      groupRow({ ...ours, n: 5 }),
      groupRow({ caller: 'server', network: 'other', n: 2, country: 'US' }),
    ]);
    recordWeb(H(4), 'wrong_password', 5);
    const summary = full(await run());
    expect(written()).toEqual([
      expect.objectContaining({ reason: 'wrong_password', source: 'api', count: 2, country: 'US' }),
    ]);
    expect(summary.notStored.our_server).toBe(5);
    expect(summary.seen).toEqual({
      'password 400 server hosting': 5,
      'password 400 server other': 2,
    });
  });

  it('an hour whose rows landed past the minute caps is reported, so a later run storing it again is seen', async () => {
    hourAnswers(H(4), [groupRow()]);
    h.rpc.mockResolvedValue({ data: 1, error: null }); // stored, but nothing the check can find
    const summary = await run();
    expect(summary).toMatchObject({ ok: true, hoursStored: 1 });
    expect(h.report).toHaveBeenCalledTimes(1);
    const [err, ctx] = h.report.mock.calls[0]!;
    expect(String(err)).toContain('landed past the minute caps');
    expect(ctx).toMatchObject({ tag: 'cron.security-events-auth-logs', level: 'warning' });
  });
});

// ── Failures ────────────────────────────────────────────────────────────────

describe('failures: reported once, in plain words and codes, never the token', () => {
  const H = (hh: number) => Date.UTC(2026, 10, 21, hh);
  const echo = `{"message":"Unauthorized","request":{"headers":{"Authorization":"Bearer ${MADE_UP_LOGS_VALUE}"}}}`;

  function expectOneReport(words: string, extra: Record<string, unknown>) {
    expect(h.report).toHaveBeenCalledTimes(1);
    const [err, ctx] = h.report.mock.calls[0]!;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(words);
    expect(ctx).toMatchObject({ tag: 'cron.security-events-auth-logs', extra });
  }

  it.each([401, 403])(
    '%s: the token was refused; the run stops; no hour is written',
    async (code) => {
      answers.set(`groups@${iso(H(4))}`, status(code, echo));
      const summary = await run();
      expectOneReport(
        'the logs token was refused (expired or deleted): the owner makes a new one',
        {
          cause: 'token_refused',
          status: code,
        },
      );
      expect(fetches).toHaveLength(1);
      expect(h.rpc).not.toHaveBeenCalled();
      expect(summary).toMatchObject({
        ok: false,
        failure: { cause: 'token_refused', status: code },
      });
      expect(everythingSaid(summary)).not.toContain(MADE_UP_LOGS_VALUE);
    },
  );

  it.each([400, 429, 500, 502, 503])(
    '%s: reported with the status; the hour is left for the next run',
    async (code) => {
      answers.set(`groups@${iso(H(5))}`, status(code, echo));
      const summary = await run();
      expectOneReport(`status ${code}`, {
        cause: 'logs_unavailable',
        status: code,
        hour: '2026-11-21T05:00Z',
      });
      // The hours after it are still read: 5 hours of two calls, and the one refused call.
      expect(fetches).toHaveLength(11);
      expect(h.rpc).not.toHaveBeenCalled();
      expect(summary).toMatchObject({ ok: false, hoursRead: 5 });
      expect(full(summary).hours.map((x) => x.outcome)).toEqual([
        'nothing_to_store',
        'failed',
        'nothing_to_store',
        'nothing_to_store',
        'nothing_to_store',
        'nothing_to_store',
      ]);
      expect(everythingSaid(summary)).not.toContain(MADE_UP_LOGS_VALUE);
      // The next run reads that hour again.
      answers.delete(`groups@${iso(H(5))}`);
      fetches.length = 0;
      await run();
      expect(fetches.map(startOf)).toContain(iso(H(5)));
    },
  );

  it('a failed totals query leaves the hour too, with nothing written', async () => {
    answers.set(`groups@${iso(H(4))}`, ok([groupRow()]));
    answers.set(`totals@${iso(H(4))}`, status(503));
    const summary = await run();
    expectOneReport('status 503', { cause: 'logs_unavailable', hour: '2026-11-21T04:00Z' });
    expect(h.rpc).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ ok: false, hoursRead: 5, hoursStored: 0 });
    expect(full(summary).hours[0]).toMatchObject({
      outcome: 'failed',
      failure: { cause: 'logs_unavailable', status: 503 },
    });
  });

  describe('a failing hour does not hold up the newer ones', () => {
    it('later hours are still read and stored; the failed hour is read again by the next run', async () => {
      answers.set(`groups@${iso(H(5))}`, () => new Response('not json', { status: 200 }));
      hourAnswers(H(6), [groupRow({ n: 4 }, H(6))]);
      hourAnswers(H(9), [groupRow({ n: 1 }, H(9))]);
      const summary = full(await run());
      expect(summary).toMatchObject({ ok: false, hoursStored: 2, eventsStored: 5, hoursRead: 5 });
      expect(summary.hours.map((x) => x.outcome)).toEqual([
        'nothing_to_store',
        'failed',
        'stored',
        'nothing_to_store',
        'nothing_to_store',
        'stored',
      ]);
      expect(summary.hours[1]).toMatchObject({ failure: { cause: 'logs_bad_answer' } });
      expect(summary.failure).toMatchObject({
        cause: 'logs_bad_answer',
        hour: '2026-11-21T05:00Z',
      });
      expectOneReport('answered in a shape this job does not read', {
        cause: 'logs_bad_answer',
        hour: '2026-11-21T05:00Z',
        hours: 1,
      });
      // Next run: the stored hours are skipped; the failed hour is read, and stored.
      hourAnswers(H(5), [groupRow({ n: 7 }, H(5))]);
      fetches.length = 0;
      const next = full(await run());
      expect([...new Set(fetches.map(startOf))]).toEqual([4, 5, 7, 8].map((hh) => iso(H(hh))));
      expect(next).toMatchObject({ ok: true, hoursStored: 1, eventsStored: 7, hoursSkipped: 2 });
    });

    it('each distinct failure is reported once per run, with the hours it held up', async () => {
      // The same failure in two hours, another in a third.
      answers.set(`groups@${iso(H(4))}`, status(503));
      answers.set(`totals@${iso(H(6))}`, status(503));
      answers.set(`groups@${iso(H(7))}`, status(429));
      hourAnswers(H(8), [groupRow({}, H(8))]);
      h.rpc.mockResolvedValueOnce({ data: null, error: { code: '55P03', message: 'lock' } });
      const summary = full(await run());
      expect(summary.hours.map((x) => x.outcome)).toEqual([
        'failed',
        'nothing_to_store',
        'failed',
        'failed',
        'failed',
        'nothing_to_store',
      ]);
      expect(h.report).toHaveBeenCalledTimes(3);
      expect(h.report.mock.calls.map(([, ctx]) => (ctx as { extra: unknown }).extra)).toEqual([
        {
          cause: 'logs_unavailable',
          status: 503,
          hour: '2026-11-21T04:00Z',
          hours: 2,
          hoursStored: 0,
        },
        {
          cause: 'logs_unavailable',
          status: 429,
          hour: '2026-11-21T07:00Z',
          hours: 1,
          hoursStored: 0,
        },
        {
          cause: 'writer_failed',
          code: '55P03',
          hour: '2026-11-21T08:00Z',
          hours: 1,
          hoursStored: 0,
        },
      ]);
      // The first failure is the run's.
      expect(summary.failure).toEqual({
        cause: 'logs_unavailable',
        status: 503,
        hour: '2026-11-21T04:00Z',
      });
      expect(everythingSaid(summary)).not.toContain(MADE_UP_LOGS_VALUE);
    });

    it.each([
      ['a refused token', status(401), 'token_refused'],
      ['a query the service did not run', ok([]), 'logs_query_error'],
      [
        'a service that cannot be reached',
        () => {
          throw new TypeError('fetch failed');
        },
        'logs_unreachable',
      ],
    ] as Array<[string, Answer, string]>)(
      '%s would fail every hour the same way: the run stops there',
      async (_what, answer, cause) => {
        answers.set(
          `groups@${iso(H(5))}`,
          cause === 'logs_query_error'
            ? () => new Response(JSON.stringify({ error: 'refused' }), { status: 200 })
            : answer,
        );
        const summary = full(await run());
        expect(summary.failure).toMatchObject({ cause, hour: '2026-11-21T05:00Z' });
        expect(fetches).toHaveLength(3);
        expect(summary.hours.map((x) => x.outcome)).toEqual([
          'nothing_to_store',
          'failed',
          'not_tried',
          'not_tried',
          'not_tried',
          'not_tried',
        ]);
        expect(h.report).toHaveBeenCalledTimes(1);
      },
    );
  });

  it('a call that does not answer in 20 seconds is given up, reported once', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    answers.set(`groups@${iso(H(4))}`, never);
    const pending = run({ nowMs: undefined });
    await vi.advanceTimersByTimeAsync(19_999);
    expect(h.report).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const summary = await pending;
    expectOneReport('did not answer within 20 seconds', { cause: 'logs_timeout' });
    expect(everythingSaid(summary)).not.toContain(MADE_UP_LOGS_VALUE);
  });

  it('a failure to connect is reported without its own text (which could carry a header)', async () => {
    answers.set(`groups@${iso(H(4))}`, () => {
      throw new TypeError(`fetch failed: invalid header value "Bearer ${MADE_UP_LOGS_VALUE}"`);
    });
    const summary = await run();
    expectOneReport('could not be reached', { cause: 'logs_unreachable' });
    expect(everythingSaid(summary)).not.toContain(MADE_UP_LOGS_VALUE);
  });

  it.each([
    [
      'an error and no result, with status 200',
      JSON.stringify({ error: `Table "edge_logs" does not exist. Bearer ${MADE_UP_LOGS_VALUE}` }),
    ],
    [
      'an error beside a result',
      JSON.stringify({ result: [], error: { message: `near Bearer ${MADE_UP_LOGS_VALUE}` } }),
    ],
    ['an error that is an empty text', JSON.stringify({ result: [], error: '' })],
  ])('%s: the query was not run; reported as such, never its text', async (_what, body) => {
    answers.set(`groups@${iso(H(4))}`, () => new Response(body, { status: 200 }));
    const summary = await run();
    expectOneReport("did not run this job's query", { cause: 'logs_query_error' });
    expect(h.report.mock.calls[0]![1]).toMatchObject({ level: 'error' });
    expect(h.rpc).not.toHaveBeenCalled();
    expect(everythingSaid(summary)).not.toContain(MADE_UP_LOGS_VALUE);
    expect(everythingSaid(summary)).not.toContain('edge_logs');
  });

  it.each([
    ['a null result', JSON.stringify({ result: null, error: null })],
    ['no result list', JSON.stringify({ rows: [], error: null })],
    ['a result that is not a list', JSON.stringify({ result: {}, error: null })],
    ['an answer that is a list', JSON.stringify([])],
    ['not JSON', `Bearer ${MADE_UP_LOGS_VALUE}`],
    [
      'more rows than the query asks for',
      JSON.stringify({ result: Array.from({ length: 200 }, () => ({})), error: null }),
    ],
  ])('%s: reported as an answer this job does not read, never its text', async (_what, body) => {
    answers.set(`groups@${iso(H(4))}`, () => new Response(body, { status: 200 }));
    const summary = await run();
    expectOneReport('answered in a shape this job does not read', { cause: 'logs_bad_answer' });
    expect(h.rpc).not.toHaveBeenCalled();
    expect(everythingSaid(summary)).not.toContain(MADE_UP_LOGS_VALUE);
  });

  describe('an answer is never read past its size limit', () => {
    /** A body that counts what is pulled from it and whether it was cancelled. */
    function countingBody(chunks: number, chunkBytes: number) {
      const state = { pulled: 0, cancelled: false };
      const stream = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (state.pulled >= chunks) {
              controller.close();
              return;
            }
            state.pulled += 1;
            controller.enqueue(new Uint8Array(chunkBytes).fill(0x20));
          },
          cancel() {
            state.cancelled = true;
          },
        },
        { highWaterMark: 0 },
      );
      return { state, stream };
    }

    it('a declared length above the limit: refused before a byte of it is read', async () => {
      const { state, stream } = countingBody(10, 1024);
      answers.set(
        `groups@${iso(H(4))}`,
        () => new Response(stream, { status: 200, headers: { 'content-length': '2000001' } }),
      );
      const summary = await run();
      expect(summary).toMatchObject({ failure: { cause: 'logs_bad_answer' } });
      expect(state.pulled).toBe(0);
      expect(state.cancelled).toBe(true);
      expect(h.rpc).not.toHaveBeenCalled();
    });

    it.each([['12abc'], ['-5'], ['1e3'], ['']])(
      'a declared length that is not a whole number (%j) is not trusted: the body is read with the cap',
      async (declared) => {
        answers.set(
          `groups@${iso(H(4))}`,
          () =>
            new Response(JSON.stringify({ result: [groupRow()], error: null }), {
              status: 200,
              headers: { 'content-length': declared },
            }),
        );
        answers.set(`totals@${iso(H(4))}`, ok([totalsRow()]));
        const summary = await run();
        expect(summary).toMatchObject({ ok: true, eventsStored: 3 });
      },
    );

    it('no declared length and a body that goes on: the read stops at the limit and the rest is cancelled', async () => {
      // 64 KB a chunk, far more of them than the limit allows.
      const { state, stream } = countingBody(1_000, 64 * 1024);
      answers.set(`groups@${iso(H(4))}`, () => new Response(stream, { status: 200 }));
      const summary = await run();
      expect(summary).toMatchObject({ failure: { cause: 'logs_bad_answer' } });
      // 2,000,000 bytes is 31 chunks; one more may be in hand when it stops.
      expect(state.pulled).toBeLessThanOrEqual(32);
      expect(state.cancelled).toBe(true);
    });

    it('an answer in several pieces under the limit is read whole', async () => {
      const text = JSON.stringify({ result: [groupRow()], error: null });
      const bytes = new TextEncoder().encode(text);
      const pieces = [bytes.slice(0, 7), bytes.slice(7, 40), bytes.slice(40)];
      answers.set(
        `groups@${iso(H(4))}`,
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                const next = pieces.shift();
                if (next) controller.enqueue(next);
                else controller.close();
              },
            }),
            { status: 200 },
          ),
      );
      answers.set(`totals@${iso(H(4))}`, ok([totalsRow()]));
      const summary = await run();
      expect(summary).toMatchObject({ ok: true, eventsStored: 3 });
    });
  });

  describe('the reports cannot carry the run past the limit of its route', () => {
    it('the deadline and the time the reports may take leave room inside 60 seconds', () => {
      expect(AUTH_LOGS_RUN_DEADLINE_MS).toBe(50_000);
      expect(AUTH_LOGS_REPORTS_MAX_MS).toBeLessThanOrEqual(4_000);
      expect(AUTH_LOGS_RUN_DEADLINE_MS + AUTH_LOGS_REPORTS_MAX_MS).toBeLessThanOrEqual(55_000);
    });

    it('reports that never finish are all sent at once and waited for no longer than their limit', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      h.report.mockImplementation(() => new Promise<undefined>(() => undefined));
      // Three distinct failures: three reports.
      answers.set(`groups@${iso(H(4))}`, status(503));
      answers.set(`groups@${iso(H(5))}`, status(429));
      answers.set(`groups@${iso(H(6))}`, () => new Response('not json', { status: 200 }));
      let done = false;
      const pending = run({ nowMs: undefined }).then((s) => {
        done = true;
        return s;
      });
      await vi.advanceTimersByTimeAsync(AUTH_LOGS_REPORTS_MAX_MS - 1);
      expect(done).toBe(false);
      // Every report was started, none waited for the one before it.
      expect(h.report).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toBe(true);
      expect(full(await pending).ok).toBe(false);
    });

    it('a reporter that throws, or whose report fails, never reaches the caller: the run still answers', async () => {
      answers.set(`groups@${iso(H(4))}`, status(503));
      h.report.mockImplementation(() => {
        throw new Error('reporter down');
      });
      await expect(run()).resolves.toMatchObject({ ok: false });
      h.report.mockImplementation(async () => {
        throw new Error('report refused');
      });
      await expect(run()).resolves.toMatchObject({ ok: false });
      await expect(run({ supabaseUrl: 'http://127.0.0.1:54321' })).resolves.toEqual({
        skipped: 'no_project',
      });
    });

    it('a skipped run waits for its one report no longer either', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      h.report.mockImplementation(() => new Promise<undefined>(() => undefined));
      let done = false;
      const pending = run({ supabaseUrl: 'http://127.0.0.1:54321' }).then((s) => {
        done = true;
        return s;
      });
      await vi.advanceTimersByTimeAsync(AUTH_LOGS_REPORTS_MAX_MS - 1);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toEqual({ skipped: 'no_project' });
    });
  });

  it('a result list with no error field is read', async () => {
    answers.set(
      `groups@${iso(H(4))}`,
      () => new Response(JSON.stringify({ result: [groupRow()] }), { status: 200 }),
    );
    answers.set(
      `totals@${iso(H(4))}`,
      () => new Response(JSON.stringify({ result: [totalsRow()] }), { status: 200 }),
    );
    const summary = await run();
    expect(summary).toMatchObject({ ok: true, eventsStored: 3 });
  });

  it('a writer failure is reported with its code; the hour is left and read again next run', async () => {
    hourAnswers(H(4), [groupRow()]);
    h.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: '55P03', message: 'canceling statement due to lock timeout' },
    });
    const summary = await run();
    expectOneReport('could not be stored', {
      cause: 'writer_failed',
      code: '55P03',
      hour: '2026-11-21T04:00Z',
    });
    expect(summary).toMatchObject({ ok: false, hoursStored: 0, eventsStored: 0 });
    // The other five hours are still read.
    expect(fetches).toHaveLength(12);
    // Next run: the hour holds nothing, so it is read and written.
    writerStores();
    const next = await run();
    expect(next).toMatchObject({ ok: true, hoursStored: 1, eventsStored: 3 });
  });

  it('a failed read of the record is reported with its code, before anything is asked of Supabase', async () => {
    h.readAnswer = () => ({ data: null, error: { code: '57014', message: 'canceling statement' } });
    const summary = await run();
    expectOneReport('could not be read', { cause: 'db_read_failed', code: '57014' });
    expect(fetches).toHaveLength(0);
    expect(summary).toMatchObject({ ok: false });
  });

  it('a run that reaches its time limit stops by 50 s, leaves the rest and says so once', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    // Each answer takes 19 s, and ignores being cancelled: the first hour's
    // two calls fit (38 s); the second hour's first call is cut at the run's
    // 50 s deadline.
    for (const hh of [4, 5, 6, 7, 8, 9]) {
      for (const which of ['groups', 'totals']) {
        answers.set(
          `${which}@${iso(H(hh))}`,
          () => new Promise((resolve) => setTimeout(() => resolve(ok([])({})), 19_000)),
        );
      }
    }
    let done = false;
    const pending = run({ nowMs: undefined }).then((s) => {
      done = true;
      return s;
    });
    await vi.advanceTimersByTimeAsync(49_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    const summary = full(await pending);
    expect(fetches).toHaveLength(3);
    expectOneReport('stopped at its time limit', {
      cause: 'out_of_time',
      hour: '2026-11-21T05:00Z',
    });
    expect(summary).toMatchObject({ ok: false, hoursRead: 1 });
    expect(summary.hours.map((x) => x.outcome)).toEqual([
      'nothing_to_store',
      'failed',
      'not_tried',
      'not_tried',
      'not_tried',
      'not_tried',
    ]);
  });

  it('a token that cannot be a header value is not sent at all', async () => {
    const summary = await run({ token: `${MADE_UP_LOGS_VALUE}\nX-Other: 1` });
    expect(fetches).toHaveLength(0);
    expect(summary).toEqual({ skipped: 'token_unusable' });
    expectOneReport('cannot be sent', { cause: 'token_unusable' });
    expect(everythingSaid(summary)).not.toContain(MADE_UP_LOGS_VALUE);
  });

  it('a Supabase URL that names no project: nothing is sent, reported once', async () => {
    const summary = await run({ supabaseUrl: 'http://127.0.0.1:54321' });
    expect(fetches).toHaveLength(0);
    expect(h.reads).toHaveLength(0);
    expect(summary).toEqual({ skipped: 'no_project' });
    expectOneReport('names no project', { cause: 'no_project' });
  });
});
