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
 * log (server/security/auth-logs.ts) keeps the logs token to one place and
 * stores counts only.
 *
 *   - the token is sent only as the Authorization header of a GET to
 *     https://api.supabase.com, and appears in no report, no answer and no
 *     log line, even when the logs service answers with a body that repeats
 *     the header;
 *   - the SQL is two constants with no value in them; the hour travels in the
 *     two timestamp parameters; the query returns a minute, a kind, a status,
 *     a caller class, a network class, a country and a count, never an
 *     address, a raw log line, a path, a query string, a network owner's name
 *     or the raw client string;
 *   - the kind is read the way the sign-in service reads the request: the
 *     path and the grant decoded; anything of an unusual form is never stored
 *     as an attack, and only many of them in one hour are stored, as one
 *     flagged count;
 *   - every returned field is checked before use, and a row that fails is
 *     dropped and counted; a network class that is not exactly `hosting` is
 *     `other` (fail closed);
 *   - an hour is written once: an hour with rows of this job is not read
 *     again, and an hour with nothing to store is read again by the next run;
 *   - our own server's lines (its client string AND a hosting network) are
 *     not stored; our server's client string from any other network is stored
 *     as `api`;
 *   - each failure is reported once, in plain words and codes.
 *
 * Every value here is made up: the project ref, the token, the network owner
 * names (but the one prefix the query compares with), the ids and the counts.
 */

const MADE_UP_LOGS_VALUE = ['made', 'up', 'logs', 'value', '0451', 'never', 'real'].join('-');
const PROJECT_URL = 'https://madeupprojectref0000.supabase.co';
const PROJECT_REF = 'madeupprojectref0000';

const h = vi.hoisted(() => ({
  report: vi.fn(async (_err: unknown, _ctx: unknown) => undefined),
  /** Rows the fake writer stored: the hour start (ISO), the reason and the source. */
  stored: [] as Array<{ hour: string; reason: string; source: string }>,
  /** Every read of security_events, as the filters it was built with. */
  reads: [] as Array<{ table: string; select?: string; filters: unknown[][]; limit?: number }>,
  readAnswer: null as null | ((q: { filters: unknown[][] }) => { data: unknown; error: unknown }),
  rpc: vi.fn(),
}));

vi.mock('@/lib/error-reporter', () => ({ reportError: h.report }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from(table: string) {
      const q = { table, filters: [] as unknown[][] } as {
        table: string;
        select?: string;
        filters: unknown[][];
        limit?: number;
      };
      const builder = {
        select(cols: string) {
          q.select = cols;
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
        or(text: string) {
          q.filters.push(['or', text]);
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
        abortSignal() {
          return builder;
        },
        then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
          h.reads.push(q);
          const answer = h.readAnswer
            ? h.readAnswer(q)
            : {
                // A row matches the way the database would: its hour, and its
                // reason and source among the ones the read lists.
                data: h.stored.some((row) => {
                  const listed = (col: string) =>
                    (q.filters.find((f) => f[0] === 'in' && f[1] === col)?.[2] as
                      unknown[] | undefined) ?? [];
                  return (
                    row.hour === String(q.filters.find((f) => f[0] === 'gte')?.[2]) &&
                    listed('reason').includes(row.reason) &&
                    listed('source').includes(row.source)
                  );
                })
                  ? [{ id: '5eed0000-0000-4000-8000-00000000000a' }]
                  : [],
                error: null,
              };
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
  buildHourElements,
  classifyAuthLogLine,
  hoursToRead,
  parseGroupRow,
  parseLogsTime,
  parseTotalsRow,
  readAuthLogs,
  supabaseProjectRef,
} = logs;

const MIN = 60_000;
const HOUR = 3_600_000;
/** 2026-11-21 10:10 UTC: the run reads 04:00 to 10:00. */
const NOW = Date.UTC(2026, 10, 21, 10, 10);
const H04 = Date.UTC(2026, 10, 21, 4);
const hourAt = (startMs: number) => ({ startMs, endMs: startMs + HOUR });
const iso = (ms: number) => new Date(ms).toISOString();
/** A time as the query prints it: toString of a UTC time, '2026-11-21 04:05:00'. */
const chTime = (ms: number) => iso(ms).replace('T', ' ').slice(0, 19);
/** The minute `m` of the hour starting at `startMs`, as the query prints it. */
const minuteOf = (startMs: number, m: number) => chTime(startMs + m * MIN);

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
  status: '400',
  caller: 'phone',
  network: 'other',
  first_seen: chTime(startMs + 10_000),
  last_seen: chTime(startMs + 3_000_000),
  n: 3,
  ...over,
});
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

const run = (over: Partial<Parameters<typeof readAuthLogs>[0]> = {}) =>
  readAuthLogs({
    token: MADE_UP_LOGS_VALUE,
    supabaseUrl: PROJECT_URL,
    nowMs: NOW,
    fetch: fakeFetch,
    ...over,
  });

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
  h.report.mockClear();
  h.stored.length = 0;
  h.reads.length = 0;
  h.readAnswer = null;
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
    ['password', '400', 'browser', 'other', 'password_guessing', 'wrong_password', 'api'],
    ['password', '400', 'other', 'other', 'password_guessing', 'wrong_password', 'api'],
    ['password', '400', 'none', 'other', 'password_guessing', 'wrong_password', 'api'],
    // A hosting network makes only our server's client string ours.
    ['password', '400', 'phone', 'hosting', 'password_guessing', 'wrong_password', 'phone'],
    ['password', '400', 'browser', 'hosting', 'password_guessing', 'wrong_password', 'api'],
    ['password', '400', 'none', 'hosting', 'password_guessing', 'wrong_password', 'api'],
    // Our server's client string from any other network: dressed up as our server.
    ['password', '400', 'server', 'other', 'password_guessing', 'wrong_password', 'api'],
    ['verify', '422', 'phone', 'other', 'password_guessing', 'wrong_code', 'phone'],
    ['verify', '422', 'browser', 'other', 'password_guessing', 'wrong_code', 'api'],
    ['verify', '422', 'server', 'other', 'password_guessing', 'wrong_code', 'api'],
    ['password', '429', 'phone', 'other', 'bots', 'auth_rate_limited', 'phone'],
    ['password', '429', 'server', 'other', 'bots', 'auth_rate_limited', 'api'],
    ['verify', '429', 'none', 'other', 'bots', 'auth_rate_limited', 'api'],
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
    ['password', '401'],
    ['password', '403'],
    ['password', '404'],
    ['password', '422'],
    ['password', '499'],
    // A wrong code is 422 (measured); a 400 there was not seen, so its meaning is not known.
    ['verify', '400'],
    ['verify', '401'],
    ['verify', '403'],
    ['verify', '404'],
  ])('%s %s is not stored: an unknown meaning is not shown as an attack', (kind, st) => {
    expect(classifyAuthLogLine(line(kind, st, 'phone'))).toEqual({
      store: false,
      why: 'other_status',
    });
  });

  it.each([
    ['400', 'phone', 'other'],
    ['429', 'phone', 'other'],
    ['401', 'browser', 'other'],
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
    ['token_other', '400', 'phone'],
    ['token_other', '429', 'browser'],
    ['token_other', '401', 'none'],
    ['verify_other', '422', 'phone'],
    ['verify_other', '429', 'other'],
  ])(
    '%s %s from %s is of an unusual form: counted as unclassified, not stored as an attack',
    (kind, st, caller) => {
      expect(classifyAuthLogLine(line(kind, st, caller))).toEqual({
        store: false,
        why: 'unclassified',
      });
    },
  );

  it('our own server is its client string AND a hosting network: none of its lines is stored or unclassified', () => {
    for (const kind of ['password', 'verify', 'refresh', 'token_other', 'verify_other'])
      for (const st of ['400', '422', '429', '401']) {
        expect(classifyAuthLogLine(line(kind, st, 'server', 'hosting')), `${kind} ${st}`).toEqual({
          store: false,
          why: 'our_server',
        });
      }
    // The same client string from another network is not ours.
    expect(classifyAuthLogLine(line('password', '400', 'server', 'other')).store).toBe(true);
    expect(classifyAuthLogLine(line('token_other', '400', 'server', 'other'))).toEqual({
      store: false,
      why: 'unclassified',
    });
  });

  it('nothing the mapping answers is outside the job reasons and the two sources', () => {
    const reasons = new Set<string>();
    const sources = new Set<string>();
    for (const kind of ['password', 'refresh', 'token_other', 'verify', 'verify_other'])
      for (const st of ['400', '401', '403', '404', '422', '429', '499'])
        for (const caller of ['phone', 'server', 'browser', 'other', 'none'])
          for (const network of ['hosting', 'other']) {
            const v = classifyAuthLogLine(line(kind, st, caller, network));
            if (v.store) {
              reasons.add(v.reason);
              sources.add(v.source);
            }
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
    ['an unknown caller', groupRow({ caller: 'Phone' })],
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
      status: '400',
      caller: 'phone',
      network: 'other',
      n: 3,
    });
    for (const kind of ['password', 'refresh', 'token_other', 'verify', 'verify_other'])
      expect(parseTotalsRow(totalsRow({ kind }), hour)?.kind).toBe(kind);
    expect(
      parseTotalsRow(totalsRow({ first_seen: '2026-11-21 04:00:00.000001' }), hour),
    ).not.toBeNull();
    expect(parseTotalsRow(totalsRow({ first_seen: chTime(H04 - 1_000) }), hour)).toBeNull();
    expect(parseTotalsRow(totalsRow({ last_seen: chTime(H04 + HOUR) }), hour)).toBeNull();
    expect(
      parseTotalsRow(
        totalsRow({ first_seen: chTime(H04 + 50_000), last_seen: chTime(H04 + 40_000) }),
        hour,
      ),
    ).toBeNull();
    expect(parseTotalsRow(totalsRow({ first_seen: H04 / 1000 + 10 }), hour)).toBeNull();
    expect(parseTotalsRow(totalsRow({ kind: 'token' }), hour)).toBeNull();
    expect(parseTotalsRow(totalsRow({ status: '4x9' }), hour)).toBeNull();
    expect(parseTotalsRow(totalsRow({ n: 0 }), hour)).toBeNull();
  });
});

// ── Building the writer's elements ──────────────────────────────────────────

describe("one hour's elements for the writer", () => {
  const hour = hourAt(H04);
  const parsed = (rows: Raw[]) => rows.map((r) => parseGroupRow(r, hour)!);
  const totalsOf = (rows: Raw[]) => rows.map((r) => parseTotalsRow(r, hour)!);
  /** The elements of an hour whose groups were complete. */
  const build = (groups: Raw[], totals: Raw[] = totalsFrom(groups)) =>
    buildHourElements({
      hour,
      groups: parsed(groups),
      groupsCapped: false,
      groupsDropped: 0,
      totals: totalsOf(totals),
    });

  it('counts, a minute, a country when known; never an organization, a city or a source hash', () => {
    const { elements } = build([
      groupRow({ minute: minuteOf(H04, 7), caller: 'phone', country: 'NL', n: 2 }),
      groupRow({ minute: minuteOf(H04, 7), caller: 'browser', country: '', n: 5 }),
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
      groupRow({ caller: 'browser', n: 2 }),
      groupRow({ caller: 'other', n: 3 }),
      groupRow({ caller: 'none', n: 4 }),
      groupRow({ caller: 'server', network: 'other', n: 1 }),
    ]);
    expect(elements).toHaveLength(1);
    expect(elements[0]).toMatchObject({ source: 'api', count: 10, country: 'NL' });
  });

  it("our own server's lines, refreshes and statuses with no known meaning are counted, not stored", () => {
    const out = build(
      [
        groupRow({ caller: 'server', network: 'hosting', n: 11 }),
        groupRow({ status: '404', n: 2 }),
        groupRow({ caller: 'phone', n: 1 }),
      ],
      [
        totalsRow({ caller: 'server', network: 'hosting', n: 11 }),
        totalsRow({ status: '404', n: 2 }),
        totalsRow({ caller: 'phone', n: 1 }),
        totalsRow({ kind: 'refresh', caller: 'browser', n: 40 }),
        totalsRow({ kind: 'token_other', caller: 'server', network: 'hosting', n: 30 }),
      ],
    );
    expect(out.elements.map((e) => [e.source, e.count])).toEqual([['phone', 1]]);
    expect(out.notStored).toEqual({
      our_server: 41,
      other_status: 2,
      refresh: 40,
      unclassified: 0,
    });
    expect(out.seen).toEqual({
      'password 400 phone other': 1,
      'password 400 server hosting': 11,
      'password 404 phone other': 2,
      'refresh 400 browser other': 40,
      'token_other 400 server hosting': 30,
    });
  });

  it("our server's client string from another network is stored as api; from a hosting network it is ours", () => {
    const out = build([
      groupRow({ caller: 'server', network: 'hosting', n: 4 }),
      groupRow({ caller: 'server', network: 'other', n: 6, country: 'US' }),
    ]);
    expect(out.elements).toEqual([
      expect.objectContaining({ reason: 'wrong_password', source: 'api', count: 6, country: 'US' }),
    ]);
    expect(out.notStored.our_server).toBe(4);
  });

  describe('requests of an unusual form: one flagged count when an hour has 20 or more', () => {
    const flaggedOf = (out: logs.AuthLogsHourElements) =>
      out.elements.filter((e) => e.reason === 'unclassified_sign_in_refusals');

    it('19 stores nothing; they are counted in the log line', () => {
      expect(AUTH_LOGS_UNCLASSIFIED_FLAG_AT).toBe(20);
      const out = build(
        [],
        [
          totalsRow({ kind: 'token_other', n: 12 }),
          totalsRow({ kind: 'verify_other', status: '422', caller: 'browser', n: 7 }),
        ],
      );
      expect(out.elements).toEqual([]);
      expect(out.notStored.unclassified).toBe(19);
      expect(out.flagged).toBe(0);
    });

    it('20 stores one flagged element: password_guessing, flagged, the count, source api, no country', () => {
      const out = build(
        [groupRow({ n: 2 })],
        [
          totalsRow({ n: 2 }),
          totalsRow({ kind: 'token_other', n: 12 }),
          totalsRow({ kind: 'verify_other', status: '422', caller: 'browser', n: 7 }),
          // Dressed up as our server: counted.
          totalsRow({ kind: 'token_other', caller: 'server', network: 'other', n: 1 }),
          // Our own server, refreshes and other statuses: never counted here.
          totalsRow({ kind: 'token_other', caller: 'server', network: 'hosting', n: 500 }),
          totalsRow({ kind: 'refresh', n: 500 }),
          totalsRow({ status: '401', n: 500 }),
        ],
      );
      expect(flaggedOf(out)).toEqual([
        {
          category: 'password_guessing',
          outcome: 'flagged',
          reason: 'unclassified_sign_in_refusals',
          source: 'api',
          count: 20,
          at_ms: H04,
        },
      ]);
      expect(out.flagged).toBe(20);
      expect(out.notStored.unclassified).toBe(20);
      // The ordinary elements are unchanged.
      expect(out.elements.filter((e) => e.outcome === 'blocked')).toEqual([
        expect.objectContaining({ reason: 'wrong_password', count: 2 }),
      ]);
    });

    it('the flagged count from phone lines is still source api, and is cut to 999,999', () => {
      const out = build([], [totalsRow({ kind: 'token_other', caller: 'phone', n: 2_000_000 })]);
      expect(flaggedOf(out)).toEqual([
        expect.objectContaining({ source: 'api', count: AUTH_LOGS_MAX_COUNT }),
      ]);
      expect(out.clamped).toBe(1);
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

    it('the remainder is one element per category and source, and the call holds at most 200', () => {
      expect(AUTH_LOGS_ROW_LIMIT).toBe(199);
      expect(AUTH_LOGS_MAX_ELEMENTS).toBe(200);
      const totals = totalsOf([
        totalsRow({ n: listedSum + 50 }),
        totalsRow({ status: '429', caller: 'browser', n: 7 }),
        // Not stored kinds never reach the remainder.
        totalsRow({ caller: 'server', network: 'hosting', n: 900 }),
        totalsRow({ status: '401', n: 300 }),
        totalsRow({ kind: 'refresh', n: 80 }),
      ]);
      const out = buildHourElements({
        hour,
        groups: capped,
        groupsCapped: true,
        groupsDropped: 0,
        totals,
      });
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
        unclassified: 0,
      });
    });

    it('with a flagged count as well, the call still holds at most 200', () => {
      const out = buildHourElements({
        hour,
        groups: capped,
        groupsCapped: true,
        groupsDropped: 0,
        totals: totalsOf([
          totalsRow({ n: listedSum + 50 }),
          totalsRow({ status: '429', caller: 'browser', n: 7 }),
          totalsRow({ kind: 'token_other', n: 25 }),
        ]),
      });
      expect(out.elements).toHaveLength(200);
      expect(out.elements.filter((e) => e.outcome === 'flagged')).toHaveLength(1);
      expect(out.elements.reduce((s, e) => s + e.count, 0)).toBe(listedSum + 50 + 7 + 25);
    });

    it('a remainder is never below zero, and none is added under the limit', () => {
      const out = buildHourElements({
        hour,
        groups: capped,
        groupsCapped: true,
        groupsDropped: 0,
        totals: totalsOf([totalsRow({ n: 10 })]),
      });
      expect(out.elements.some((e) => e.reason === 'auth_log_over_cap')).toBe(false);
      const under = buildHourElements({
        hour,
        groups: capped.slice(0, 10),
        groupsCapped: false,
        groupsDropped: 0,
        totals: totalsOf([totalsRow({ n: 1_000_000 })]),
      });
      expect(under.elements.some((e) => e.reason === 'auth_log_over_cap')).toBe(false);
    });

    it('no remainder when a group row of the hour was dropped (its count would come back through the totals)', () => {
      const out = buildHourElements({
        hour,
        groups: capped,
        groupsCapped: true,
        groupsDropped: 1,
        totals: totalsOf([totalsRow({ n: listedSum + 50 })]),
      });
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

  it('each is one template literal with no placeholder, and the value sent is that text', () => {
    for (const [name, value] of [
      ['AUTH_LOGS_GROUPS_SQL', AUTH_LOGS_GROUPS_SQL],
      ['AUTH_LOGS_TOTALS_SQL', AUTH_LOGS_TOTALS_SQL],
    ] as const) {
      const text = declared(name);
      expect(text, name).not.toContain('${');
      expect(value, name).toBe(text);
    }
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
      'first_seen',
      'last_seen',
      'n',
    ]);
    expect(AUTH_LOGS_GROUPS_SQL).toContain('toString(toStartOfMinute(timestamp)) AS minute');
    expect(AUTH_LOGS_TOTALS_SQL).toContain('toString(min(timestamp)) AS first_seen');
    expect(AUTH_LOGS_TOTALS_SQL).toContain('toString(max(timestamp)) AS last_seen');
  });

  it('both start from the same named values, and the hosting prefix is written once, with when it was measured', () => {
    const head = (sql: string) => sql.slice(0, sql.indexOf('\nSELECT\n'));
    expect(head(AUTH_LOGS_TOTALS_SQL)).toBe(head(AUTH_LOGS_GROUPS_SQL));
    expect(aliases(parseReaderQuery(AUTH_LOGS_GROUPS_SQL).withItems)).toEqual([
      'hosting_owner_prefix',
      'raw_path',
      'decoded_path',
      'raw_search',
      'decoded_search',
      'first_grant',
    ]);
    for (const [name, sql] of BOTH) {
      expect(sql.match(/Amazon/g), name).toHaveLength(1);
      expect(sql, name).toContain("'Amazon' AS hosting_owner_prefix");
      expect(head(sql), name).toMatch(/\/\*[^*]*measured on 2026-11-21[^*]*\*\//);
      expect(sql.match(/hosting_owner_prefix/g), name).toHaveLength(2);
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
    const totals = runReaderQueryOnLine(AUTH_LOGS_TOTALS_SQL, line, ROW_ALIASES);
    // Both class every line the same way.
    for (const a of ROW_ALIASES) expect(groups.values[a], a).toBe(totals.values[a]);
    return { groups, totals, kind: totals.values.kind };
  }
  /** The kind of a line the totals query keeps; null when it is not read at all. */
  const kindOf = (line: ModelLogLine) => {
    const { totals, kind } = bothOn(line);
    return totals.kept ? kind : null;
  };

  describe('the grant is read the way the sign-in service reads it: decoded, exactly one', () => {
    const ofSearch = (search: string) => kindOf(gatewayLine({ search }));

    it.each([
      ['?grant_type=password', 'password'],
      ['grant_type=password', 'password'],
      ['?scope=x&grant_type=password', 'password'],
      ['?grant_type=password&scope=x', 'password'],
      ['?grant_type=refresh_token', 'refresh'],
      ['?scope=x&grant_type=refresh_token', 'refresh'],
    ])('%j -> %s', (search, kind) => {
      expect(ofSearch(search)).toBe(kind);
    });

    it.each([
      ['?grant_type=pass%77ord', 'password'],
      ['?grant_type=%70%61%73%73%77%6F%72%64', 'password'],
      ['?grant_type=%70%61%73%73%77%6f%72%64', 'password'],
      ['?grant%5Ftype=password', 'password'],
      ['?grant%5ftype=pass%77ord', 'password'],
      ['?grant_type=refresh%5Ftoken', 'refresh'],
    ])('an encoded grant %j is decoded as the service decodes it -> %s', (search, kind) => {
      expect(ofSearch(search)).toBe(kind);
    });

    it.each([
      ['?grant_type=password&grant_type=password'],
      ['?grant_type=refresh_token&grant_type=password'],
      ['?grant_type=password&grant_type=refresh_token'],
      ['?grant_type=password&scope=x&grant_type=pkce'],
      ['?grant_type=password&grant%5Ftype=refresh_token'],
      ['?grant_type=password&grant_type='],
    ])('two grant_type values %j -> token_other', (search) => {
      expect(ofSearch(search)).toBe('token_other');
    });

    it.each([
      ['no grant', ''],
      ['an empty query', '?'],
      ['an empty grant', '?grant_type='],
      ['a grant with no value', '?grant_type'],
      ['another grant', '?grant_type=pkce'],
      ['another grant', '?grant_type=id_token'],
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

    it('a line with no query string at all is read, as token_other', () => {
      expect(kindOf(gatewayLine({ search: null }))).toBe('token_other');
    });
  });

  describe('the paths are read decoded, with the case the service routes', () => {
    it.each([
      ['/auth/v1/token', 'password'],
      ['/auth/v1/%74oken', 'token_other'],
      ['/auth/v1/to%6Ben', 'token_other'],
      [`/auth/v1/factors/${UUID}/verify`, 'verify'],
      [`/auth/v1/factors/${UUID.toUpperCase()}/verify`, 'verify'],
      [`/auth/v1/factors/${UUID.replaceAll('-', '')}/verify`, 'verify_other'],
      [`/auth/v1/factors/{${UUID}}/verify`, 'verify_other'],
      ['/auth/v1/factors/not-an-id/verify', 'verify_other'],
      [`/auth/v1/factors/%35${UUID.slice(1)}/verify`, 'verify_other'],
      [`/auth/v1/factors/${UUID}/verif%79`, 'verify_other'],
      [`/auth/v1/factors/${UUID}%2Fverify`, 'verify_other'],
    ])('%s is read, as %s', (p, kind) => {
      expect(kindOf(gatewayLine({ path: p }))).toBe(kind);
    });

    it.each([
      ['/auth/v1/TOKEN'],
      ['/auth/v1/Token'],
      ['/auth/v1/token/'],
      ['/auth/v1/tokens'],
      ['/auth/v1/%54OKEN'],
      ['/auth/v1/verify'],
      ['/auth/v1/user'],
      [`/auth/v1/factors/${UUID}/VERIFY`],
      [`/auth/v1/factors/${UUID}/challenge`],
      [`/auth/v1/factors/${UUID}/verify/more`],
      [`/auth/v1/factors/${UUID}/verify/`],
      ['/auth/v1/factors//verify'],
      [`/auth/v1/factors/a/${UUID}/verify`],
      [`/rest/v1/factors/${UUID}/verify`],
    ])('%s is not read', (p) => {
      expect(kindOf(gatewayLine({ path: p }))).toBeNull();
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
      [gatewayLine({ search: '?grant_type=pkce' }), 'token_other', false],
      [gatewayLine({ path: '/auth/v1/factors/not-an-id/verify' }), 'verify_other', false],
    ];
    for (const [line, kind, listed] of cases) {
      const { groups, totals } = bothOn(line);
      expect(totals.values.kind).toBe(kind);
      expect(totals.kept, kind).toBe(true);
      expect(groups.kept, kind).toBe(listed);
    }
  });

  it('both read the same lines; the groups query keeps only the kinds that can be stored', () => {
    const where = (sql: string) => sql.slice(sql.indexOf('\nWHERE '), sql.indexOf('\nGROUP BY'));
    expect(where(AUTH_LOGS_GROUPS_SQL)).toBe(
      `${where(AUTH_LOGS_TOTALS_SQL)}\n  AND kind IN ('password', 'verify')`,
    );
    for (const [, sql] of BOTH) {
      expect(sql.trimEnd().endsWith(`LIMIT ${AUTH_LOGS_ROW_LIMIT}`)).toBe(true);
      expect(sql).toMatch(/ORDER BY n DESC/);
    }
  });

  describe('the network class: hosting only when the owner name starts with the measured prefix', () => {
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
    ])('%j -> %s', (owner, network) => {
      expect(bothOn(gatewayLine({ owner })).totals.values.network).toBe(network);
    });

    it('a line with no owner name is other', () => {
      expect(bothOn(gatewayLine({ owner: null })).totals.values.network).toBe('other');
    });
  });

  it.each([
    ['supabase-js-react-native/2.50.0', 'phone'],
    ['supabase-ssr/0.6.1 createServerClient', 'server'],
    ['supabase-js/2.50.0; runtime=node', 'server'],
    ['supabase-ssr/0.6.1 createBrowserClient', 'browser'],
    ['supabase-js-web/2.50.0', 'other'],
    ['curl/8.4.0', 'other'],
    ['', 'none'],
  ])('the query classes the client string %j as %s, the same in both', (client, cls) => {
    expect(bothOn(gatewayLine({ client })).totals.values.caller).toBe(cls);
  });

  it('a line with no client string is none', () => {
    expect(bothOn(gatewayLine({ client: null })).totals.values.caller).toBe('none');
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
        path: `/auth/v1/factors/${UUID}/verify`,
        client: `createServerClient ${marker}`,
      }),
    ];
    for (const line of lines) {
      const { groups } = bothOn(line);
      expect(JSON.stringify(groups.values)).not.toContain(marker);
      expect(['password', 'refresh', 'token_other', 'verify', 'verify_other']).toContain(
        groups.values.kind,
      );
      expect(['phone', 'server', 'browser', 'other', 'none']).toContain(groups.values.caller);
      expect(['hosting', 'other']).toContain(groups.values.network);
      expect(groups.values.status).toMatch(/^4[0-9][0-9]$/);
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
    const checks = h.reads.filter((q) => q.table === 'security_events');
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
    expect(full(second).hours.find((x) => x.hour === '2026-11-21T07:00Z')).toEqual({
      hour: '2026-11-21T07:00Z',
      outcome: 'already_stored',
      events: 0,
    });
  });

  describe('requests of an unusual form through a run', () => {
    it('19 in an hour: nothing stored, counted in the log line, the hour read again next run', async () => {
      hourAnswers(H(5), [], [totalsRow({ kind: 'token_other', n: 19 }, H(5))]);
      const summary = full(await run());
      expect(h.rpc).not.toHaveBeenCalled();
      expect(summary.notStored.unclassified).toBe(19);
      expect(summary.flaggedHours).toBe(0);
      expect(summary.seen).toEqual({ 'token_other 400 phone other': 19 });
      expect(summary.hours[1]).toEqual({
        hour: '2026-11-21T05:00Z',
        outcome: 'nothing_to_store',
        events: 0,
      });
      fetches.length = 0;
      await run();
      expect(fetches.map(startOf)).toContain(iso(H(5)));
    });

    it('20 in an hour: one flagged element, and the hour is then already stored (the check counts its reason as the job own)', async () => {
      hourAnswers(
        H(5),
        [],
        [
          totalsRow({ kind: 'token_other', n: 13 }, H(5)),
          totalsRow({ kind: 'verify_other', status: '422', caller: 'browser', n: 7 }, H(5)),
        ],
      );
      const summary = full(await run());
      expect(h.rpc).toHaveBeenCalledTimes(1);
      expect(written()).toEqual([
        {
          category: 'password_guessing',
          outcome: 'flagged',
          reason: 'unclassified_sign_in_refusals',
          source: 'api',
          count: 20,
          at_ms: H(5),
        },
      ]);
      expect(summary).toMatchObject({ flaggedHours: 1, hoursStored: 1, eventsStored: 20 });

      // The next run: the check's reasons include the flagged one, so the hour is not written again.
      fetches.length = 0;
      const next = full(await run());
      expect(h.rpc).toHaveBeenCalledTimes(1);
      expect(fetches.map(startOf)).not.toContain(iso(H(5)));
      expect(next.hours[1]!.outcome).toBe('already_stored');
    });

    it('our own server is never counted toward it', async () => {
      hourAnswers(
        H(5),
        [],
        [totalsRow({ kind: 'token_other', caller: 'server', network: 'hosting', n: 400 }, H(5))],
      );
      const summary = full(await run());
      expect(h.rpc).not.toHaveBeenCalled();
      expect(summary.notStored).toMatchObject({ our_server: 400, unclassified: 0 });
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
    expect(summary).toMatchObject({ dropped: 4, groups: 1, eventsStored: 2 });
  });

  it("our server's client string: ours from a hosting network, stored as api from any other", async () => {
    hourAnswers(H(4), [
      groupRow({ caller: 'server', network: 'hosting', n: 5 }),
      groupRow({ caller: 'server', network: 'other', n: 2, country: 'US' }),
    ]);
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
      expect(fetches).toHaveLength(3);
      expect(h.rpc).not.toHaveBeenCalled();
      expect(summary).toMatchObject({ ok: false, hoursRead: 1 });
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
    expect(summary).toMatchObject({ ok: false, hoursRead: 0, hoursStored: 0 });
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
    expect(fetches).toHaveLength(2);
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
