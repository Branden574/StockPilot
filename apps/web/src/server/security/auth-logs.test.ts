// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
 *     two timestamp parameters; the query returns a minute, a kind of path, a
 *     status, a caller class, a network number (server-class lines only), a
 *     country and a count, never an address, a raw log line, a full path or
 *     the raw client string;
 *   - every returned field is checked before use, and a row that fails is
 *     dropped and counted;
 *   - an hour is written once: an hour with rows of this job is not read
 *     again, and an hour with nothing to store is read again by the next run;
 *   - our own server's lines are not stored; a line that carries our server's
 *     client string from another network is stored as `api`;
 *   - each failure is reported once, in plain words and codes.
 *
 * Every value here is made up: the project ref, the token, the network
 * numbers (RFC 5398 documentation range) and the counts.
 */

const MADE_UP_LOGS_VALUE = ['made', 'up', 'logs', 'value', '0451', 'never', 'real'].join('-');
const PROJECT_URL = 'https://madeupprojectref0000.supabase.co';
const PROJECT_REF = 'madeupprojectref0000';

const h = vi.hoisted(() => ({
  report: vi.fn(async (_err: unknown, _ctx: unknown) => undefined),
  /** Hour starts (ISO) that already hold rows of this job. */
  storedHours: new Set<string>(),
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
                data: h.storedHours.has(String(q.filters.find((f) => f[0] === 'gte')?.[2]))
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
  OUR_SERVER_NETWORKS,
  buildHourElements,
  classifyAuthLogLine,
  hoursToRead,
  parseGroupRow,
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
/** The minute `m` of the hour starting at `startMs`, in seconds, as the query returns it. */
const minuteOf = (startMs: number, m: number) => (startMs + m * MIN) / 1000;

type Raw = Record<string, unknown>;
const groupRow = (over: Raw = {}, startMs = H04): Raw => ({
  minute: minuteOf(startMs, 5),
  kind: 'token',
  status: '400',
  caller: 'phone',
  asn: '',
  country: 'NL',
  n: 3,
  ...over,
});
const totalsRow = (over: Raw = {}, startMs = H04): Raw => ({
  kind: 'token',
  status: '400',
  caller: 'phone',
  asn: '',
  first_seen: startMs / 1000 + 10,
  last_seen: startMs / 1000 + 3000,
  n: 3,
  ...over,
});

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

/** The writer, faked: stores the hour its elements are in, and answers how many it took. */
function writerStores() {
  h.rpc.mockImplementation(async (_name: string, args: { p_events: Array<{ at_ms: number }> }) => {
    for (const e of args.p_events) h.storedHours.add(iso(Math.floor(e.at_ms / HOUR) * HOUR));
    return { data: args.p_events.length, error: null };
  });
}

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
  h.storedHours.clear();
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
  const line = (kind: string, status: string, caller: string, asn = '') =>
    ({ kind, status, caller, asn }) as logs.AuthLogsLine;

  it.each([
    ['token', '400', 'phone', 'password_guessing', 'wrong_password', 'phone'],
    ['token', '400', 'browser', 'password_guessing', 'wrong_password', 'api'],
    ['token', '400', 'other', 'password_guessing', 'wrong_password', 'api'],
    ['token', '400', 'none', 'password_guessing', 'wrong_password', 'api'],
    ['verify', '422', 'phone', 'password_guessing', 'wrong_code', 'phone'],
    ['verify', '400', 'phone', 'password_guessing', 'wrong_code', 'phone'],
    ['verify', '422', 'browser', 'password_guessing', 'wrong_code', 'api'],
    ['token', '429', 'phone', 'bots', 'auth_rate_limited', 'phone'],
    ['verify', '429', 'none', 'bots', 'auth_rate_limited', 'api'],
  ])('%s %s from %s -> %s / %s / %s', (kind, st, caller, category, reason, source) => {
    expect(classifyAuthLogLine(line(kind, st, caller), [])).toEqual({
      store: true,
      category,
      reason,
      source,
    });
  });

  it.each([
    ['token', '401'],
    ['token', '403'],
    ['token', '404'],
    ['token', '422'],
    ['token', '499'],
    ['verify', '401'],
    ['verify', '403'],
    ['verify', '404'],
  ])('%s %s is not stored: an unknown meaning is not shown as an attack', (kind, st) => {
    expect(classifyAuthLogLine(line(kind, st, 'phone'), [])).toEqual({
      store: false,
      why: 'other_status',
    });
  });

  it('while the network constant is empty, every server-class line is ours and is not stored', () => {
    expect(OUR_SERVER_NETWORKS).toEqual([]);
    for (const asn of ['', '64500', '64510']) {
      expect(classifyAuthLogLine(line('token', '400', 'server', asn), [])).toEqual({
        store: false,
        why: 'our_server',
      });
      expect(classifyAuthLogLine(line('token', '400', 'server', asn))).toEqual({
        store: false,
        why: 'our_server',
      });
    }
  });

  it('once it is set, our server string from another network is someone dressed up as our server: stored as api', () => {
    const ours = ['64500'];
    expect(classifyAuthLogLine(line('token', '400', 'server', '64500'), ours)).toEqual({
      store: false,
      why: 'our_server',
    });
    expect(classifyAuthLogLine(line('token', '400', 'server', '64510'), ours)).toEqual({
      store: true,
      category: 'password_guessing',
      reason: 'wrong_password',
      source: 'api',
    });
    expect(classifyAuthLogLine(line('verify', '429', 'server', '64510'), ours)).toEqual({
      store: true,
      category: 'bots',
      reason: 'auth_rate_limited',
      source: 'api',
    });
    // No network number: unknown, so not shown as an attack.
    expect(classifyAuthLogLine(line('token', '400', 'server', ''), ours)).toEqual({
      store: false,
      why: 'unknown_network',
    });
    // Dressed up, but a status with no known meaning: still not stored.
    expect(classifyAuthLogLine(line('token', '404', 'server', '64510'), ours)).toEqual({
      store: false,
      why: 'other_status',
    });
  });

  it('nothing the mapping answers is outside the job reasons and the two sources', () => {
    const reasons = new Set<string>();
    const sources = new Set<string>();
    for (const kind of ['token', 'verify'])
      for (const st of ['400', '401', '403', '404', '422', '429', '499'])
        for (const caller of ['phone', 'server', 'browser', 'other', 'none'])
          for (const asn of ['', '64500', '64510']) {
            const v = classifyAuthLogLine(line(kind, st, caller, asn), ['64500']);
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

  it('a good row, with numbers or digit strings', () => {
    expect(parseGroupRow(groupRow(), hour)).toEqual({
      minuteMs: H04 + 5 * MIN,
      kind: 'token',
      status: '400',
      caller: 'phone',
      asn: '',
      country: 'NL',
      n: 3,
    });
    expect(
      parseGroupRow(groupRow({ minute: String(minuteOf(H04, 59)), n: '12', country: '' }), hour),
    ).toEqual({
      minuteMs: H04 + 59 * MIN,
      kind: 'token',
      status: '400',
      caller: 'phone',
      asn: '',
      country: '',
      n: 12,
    });
    expect(parseGroupRow(groupRow({ caller: 'server', asn: '64500' }), hour)?.asn).toBe('64500');
  });

  it.each([
    ['not an object', 'row'],
    ['null', null],
    ['an array', [1, 2]],
    ['a minute before the hour', groupRow({ minute: minuteOf(H04, -1) })],
    ['a minute at the hour end', groupRow({ minute: minuteOf(H04, 60) })],
    ['a minute not on a minute', groupRow({ minute: minuteOf(H04, 5) + 30 })],
    ['a minute that is text', groupRow({ minute: 'five past' })],
    ['a minute that is not whole', groupRow({ minute: minuteOf(H04, 5) + 0.5 })],
    ['no minute', groupRow({ minute: undefined })],
    ['another kind', groupRow({ kind: 'refresh' })],
    ['a kind in capitals', groupRow({ kind: 'Token' })],
    ['a two-digit status', groupRow({ status: '40' })],
    ['a four-digit status', groupRow({ status: '4000' })],
    ['a status that is text', groupRow({ status: 'bad' })],
    ['an unknown caller', groupRow({ caller: 'Phone' })],
    ['a network that is not digits', groupRow({ caller: 'server', asn: 'AS64500' })],
    ['a network as a number', groupRow({ caller: 'server', asn: 64500 })],
    ['a lower-case country', groupRow({ country: 'nl' })],
    ['a three-letter country', groupRow({ country: 'NLD' })],
    ['a country with a digit', groupRow({ country: 'T1' })],
    ['a count of zero', groupRow({ n: 0 })],
    ['a negative count', groupRow({ n: -2 })],
    ['a count that is not whole', groupRow({ n: 1.5 })],
    ['a count that is text', groupRow({ n: 'many' })],
    ['no count', groupRow({ n: undefined })],
  ])('dropped: %s', (_what, raw) => {
    expect(parseGroupRow(raw, hour)).toBeNull();
  });

  it('a totals row: first and last inside the hour, or dropped', () => {
    expect(parseTotalsRow(totalsRow(), hour)).toEqual({
      kind: 'token',
      status: '400',
      caller: 'phone',
      asn: '',
      n: 3,
    });
    expect(parseTotalsRow(totalsRow({ first_seen: H04 / 1000 - 1 }), hour)).toBeNull();
    expect(parseTotalsRow(totalsRow({ last_seen: (H04 + HOUR) / 1000 }), hour)).toBeNull();
    expect(
      parseTotalsRow(totalsRow({ first_seen: H04 / 1000 + 50, last_seen: H04 / 1000 + 40 }), hour),
    ).toBeNull();
    expect(parseTotalsRow(totalsRow({ status: '4x9' }), hour)).toBeNull();
    expect(parseTotalsRow(totalsRow({ n: 0 }), hour)).toBeNull();
  });
});

// ── Building the writer's elements ──────────────────────────────────────────

describe("one hour's elements for the writer", () => {
  const hour = hourAt(H04);
  const parsed = (rows: Raw[]) => rows.map((r) => parseGroupRow(r, hour)!);

  it('counts, a minute, a country when known; never an organization, a city or a source hash', () => {
    const { elements } = buildHourElements({
      hour,
      groups: parsed([
        groupRow({ minute: minuteOf(H04, 7), caller: 'phone', country: 'NL', n: 2 }),
        groupRow({ minute: minuteOf(H04, 7), caller: 'browser', country: '', n: 5 }),
      ]),
      groupsCapped: false,
      groupsDropped: 0,
      totals: null,
      networks: [],
    });
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
    const { elements } = buildHourElements({
      hour,
      groups: parsed([
        groupRow({ caller: 'browser', n: 2 }),
        groupRow({ caller: 'other', n: 3 }),
        groupRow({ caller: 'none', n: 4 }),
      ]),
      groupsCapped: false,
      groupsDropped: 0,
      totals: null,
      networks: [],
    });
    expect(elements).toHaveLength(1);
    expect(elements[0]).toMatchObject({ source: 'api', count: 9, country: 'NL' });
  });

  it("our own server's lines and statuses with no known meaning are counted, not stored", () => {
    const out = buildHourElements({
      hour,
      groups: parsed([
        groupRow({ caller: 'server', asn: '', n: 11 }),
        groupRow({ status: '404', n: 2 }),
        groupRow({ caller: 'phone', n: 1 }),
      ]),
      groupsCapped: false,
      groupsDropped: 0,
      totals: null,
      networks: [],
    });
    expect(out.elements.map((e) => [e.source, e.count])).toEqual([['phone', 1]]);
    expect(out.notStored).toEqual({ our_server: 11, other_status: 2, unknown_network: 0 });
    expect(out.seen).toEqual({
      'token 400 phone -': 1,
      'token 400 server -': 11,
      'token 404 phone -': 2,
    });
  });

  it("the dressed-up-server rule: unset, nothing of the server's is stored; set, another network's lines are", () => {
    const rows = parsed([
      groupRow({ caller: 'server', asn: '64500', n: 4 }),
      groupRow({ caller: 'server', asn: '64510', n: 6, country: 'US' }),
    ]);
    const unset = buildHourElements({
      hour,
      groups: rows,
      groupsCapped: false,
      groupsDropped: 0,
      totals: null,
      networks: [],
    });
    expect(unset.elements).toEqual([]);
    expect(unset.notStored.our_server).toBe(10);
    const set = buildHourElements({
      hour,
      groups: rows,
      groupsCapped: false,
      groupsDropped: 0,
      totals: null,
      networks: ['64500'],
    });
    expect(set.elements).toEqual([
      expect.objectContaining({ reason: 'wrong_password', source: 'api', count: 6, country: 'US' }),
    ]);
    expect(set.notStored.our_server).toBe(4);
  });

  it('a count past what the writer reads is cut to 999,999, never stored as 1', () => {
    const out = buildHourElements({
      hour,
      groups: parsed([groupRow({ n: 1_500_000 })]),
      groupsCapped: false,
      groupsDropped: 0,
      totals: null,
      networks: [],
    });
    expect(AUTH_LOGS_MAX_COUNT).toBe(999_999);
    expect(out.elements[0]!.count).toBe(999_999);
    expect(out.clamped).toBe(1);
  });

  describe('past the 199 groups: the cap and the remainder', () => {
    /** 199 distinct groups of phone wrong passwords, counts 200 down to 2. */
    const capped = parsed(
      Array.from({ length: AUTH_LOGS_ROW_LIMIT }, (_, i) =>
        groupRow({
          minute: minuteOf(H04, i % 60),
          country: ['NL', 'US', 'DE', 'FR'][Math.floor(i / 60)]!,
          n: 200 - i,
        }),
      ),
    );
    const listedSum = capped.reduce((s, r) => s + r.n, 0);

    it('the remainder is one element per category and source, and the call holds at most 200', () => {
      expect(AUTH_LOGS_ROW_LIMIT).toBe(199);
      expect(AUTH_LOGS_MAX_ELEMENTS).toBe(200);
      const totals = [
        parseTotalsRow(totalsRow({ n: listedSum + 50 }), hour)!,
        parseTotalsRow(totalsRow({ status: '429', caller: 'browser', n: 7 }), hour)!,
        // Not stored kinds never reach the remainder.
        parseTotalsRow(totalsRow({ caller: 'server', n: 900 }), hour)!,
        parseTotalsRow(totalsRow({ status: '401', n: 300 }), hour)!,
      ];
      const out = buildHourElements({
        hour,
        groups: capped,
        groupsCapped: true,
        groupsDropped: 0,
        totals,
        networks: [],
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
      expect(out.notStored).toEqual({ our_server: 900, other_status: 300, unknown_network: 0 });
    });

    it('a remainder is never below zero, and none is added under the limit', () => {
      const totals = [parseTotalsRow(totalsRow({ n: 10 }), hour)!];
      const out = buildHourElements({
        hour,
        groups: capped,
        groupsCapped: true,
        groupsDropped: 0,
        totals,
        networks: [],
      });
      expect(out.elements.some((e) => e.reason === 'auth_log_over_cap')).toBe(false);
      const under = buildHourElements({
        hour,
        groups: capped.slice(0, 10),
        groupsCapped: false,
        groupsDropped: 0,
        totals: [parseTotalsRow(totalsRow({ n: 1_000_000 }), hour)!],
        networks: [],
      });
      expect(under.elements.some((e) => e.reason === 'auth_log_over_cap')).toBe(false);
    });

    it('no remainder when a group row of the hour was dropped (its count would come back through the totals)', () => {
      const totals = [parseTotalsRow(totalsRow({ n: listedSum + 50 }), hour)!];
      const out = buildHourElements({
        hour,
        groups: capped,
        groupsCapped: true,
        groupsDropped: 1,
        totals,
        networks: [],
      });
      expect(out.elements.some((e) => e.reason === 'auth_log_over_cap')).toBe(false);
      expect(out.remainderSkipped).toBe(true);
    });
  });
});

// ── The SQL ─────────────────────────────────────────────────────────────────

describe('the SQL is two constants that return counts and codes only', () => {
  const source = readFileSync(path.join(__dirname, 'auth-logs.ts'), 'utf8');

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

  /** The SELECT list, cut at its top-level commas, as [expression, alias]. */
  function selectList(sql: string): Array<[string, string]> {
    const body = sql.slice(sql.indexOf('SELECT') + 'SELECT'.length, sql.indexOf('\nFROM logs'));
    const parts: string[] = [];
    let depth = 0;
    let from = 0;
    let quoted = false;
    for (let i = 0; i < body.length; i++) {
      const c = body[i]!;
      if (c === "'") quoted = !quoted;
      else if (!quoted && (c === '(' || c === '[')) depth++;
      else if (!quoted && (c === ')' || c === ']')) depth--;
      else if (!quoted && depth === 0 && c === ',') {
        parts.push(body.slice(from, i));
        from = i + 1;
      }
    }
    parts.push(body.slice(from));
    return parts.map((p) => {
      const m = p.trim().match(/^([\s\S]+)\sAS\s([a-z_]+)$/);
      expect(m, p).not.toBeNull();
      return [m![1]!, m![2]!];
    });
  }

  it('the groups query returns a minute, a kind, a status, a caller class, a network, a country and a count', () => {
    expect(selectList(AUTH_LOGS_GROUPS_SQL).map(([, alias]) => alias)).toEqual([
      'minute',
      'kind',
      'status',
      'caller',
      'asn',
      'country',
      'n',
    ]);
    expect(selectList(AUTH_LOGS_TOTALS_SQL).map(([, alias]) => alias)).toEqual([
      'kind',
      'status',
      'caller',
      'asn',
      'first_seen',
      'last_seen',
      'n',
    ]);
  });

  it('never an address, a raw log line, the raw client string or a full path', () => {
    for (const sql of [AUTH_LOGS_GROUPS_SQL, AUTH_LOGS_TOTALS_SQL]) {
      for (const word of [
        'event_message',
        'connecting_ip',
        'forwarded',
        'real_ip',
        'remote_addr',
        'request.url',
        'user_agent',
        'cf.city',
        'latitude',
        'longitude',
        'id,',
        '*',
      ]) {
        expect(sql.toLowerCase(), word).not.toContain(word);
      }
      // The only header read is the client string, and only inside the class it is reduced to.
      expect(
        sql
          .match(/request\.headers\.[a-z_]+/g)
          ?.every((f) => f === 'request.headers.x_client_info'),
      ).toBe(true);
      const client = "log_attributes['request.headers.x_client_info']";
      for (let at = sql.indexOf(client); at !== -1; at = sql.indexOf(client, at + 1)) {
        const before = sql.slice(Math.max(0, at - 'position('.length), at);
        const after = sql.slice(at + client.length, at + client.length + 5);
        expect(before === 'position(' || after === " = ''", `client string at ${at}`).toBe(true);
      }
      // The path is compared, never returned.
      const pathField = "log_attributes['request.path']";
      for (let at = sql.indexOf(pathField); at !== -1; at = sql.indexOf(pathField, at + 1)) {
        const before = sql.slice(Math.max(0, at - 'match('.length), at);
        const after = sql.slice(
          at + pathField.length,
          at + pathField.length + " = '/auth/v1/token'".length,
        );
        expect(before === 'match(' || after === " = '/auth/v1/token'", `path at ${at}`).toBe(true);
      }
      // The network number only for server-class lines, and only as digits.
      for (const [expr, alias] of selectList(sql)) {
        if (expr.includes("'request.cf.asn'")) {
          expect(alias).toBe('asn');
          expect(expr).toContain("caller = 'server'");
          expect(expr).toContain("'^[0-9]{1,10}$'");
        }
        if (expr.includes("'request.cf.country'")) {
          expect(alias).toBe('country');
          expect(expr).toContain("'^[A-Z]{2}$'");
        }
      }
    }
  });

  it('both read the same lines: refused password sign-ins and code checks sent to Supabase', () => {
    const where = (sql: string) => sql.slice(sql.indexOf('\nFROM logs'), sql.indexOf('\nGROUP BY'));
    expect(where(AUTH_LOGS_TOTALS_SQL)).toBe(where(AUTH_LOGS_GROUPS_SQL));
    const w = where(AUTH_LOGS_GROUPS_SQL);
    expect(w).toContain("source = 'edge_logs'");
    expect(w).toContain("log_attributes['request.method'] = 'POST'");
    expect(w).toContain("match(log_attributes['response.status_code'], '^4[0-9][0-9]$')");
    expect(w).toContain("log_attributes['request.path'] = '/auth/v1/token'");
    expect(w).toContain(
      "match(log_attributes['request.search'], '(^|[?&])grant_type=password(&|$)')",
    );
    expect(w).toContain('/verify$');
    for (const sql of [AUTH_LOGS_GROUPS_SQL, AUTH_LOGS_TOTALS_SQL]) {
      expect(sql.trimEnd().endsWith(`LIMIT ${AUTH_LOGS_ROW_LIMIT}`)).toBe(true);
      expect(sql).toMatch(/ORDER BY n DESC/);
    }
  });

  it('the module reads no setting itself: the token comes in from the route, which reads the env module', () => {
    expect(source).not.toMatch(/process\.env/);
  });
});

// ── The run ─────────────────────────────────────────────────────────────────

describe('a run: six hours, oldest first, each written once', () => {
  const H = (hh: number) => Date.UTC(2026, 10, 21, hh);

  it('asks api.supabase.com only, with the token only in the Authorization header, the SQL constant and the hour', async () => {
    answers.set(`groups@${iso(H(5))}`, ok([groupRow({}, H(5))]));
    const summary = await run();
    expect(fetches).toHaveLength(6);
    for (const [i, f] of fetches.entries()) {
      const u = new URL(f.url);
      expect(u.origin).toBe('https://api.supabase.com');
      expect(u.pathname).toBe(`/v1/projects/${PROJECT_REF}/analytics/endpoints/logs`);
      expect([...u.searchParams.keys()].sort()).toEqual([
        'iso_timestamp_end',
        'iso_timestamp_start',
        'sql',
      ]);
      expect(u.searchParams.get('sql')).toBe(AUTH_LOGS_GROUPS_SQL);
      expect(u.searchParams.get('iso_timestamp_start')).toBe(iso(H(4 + i)));
      expect(u.searchParams.get('iso_timestamp_end')).toBe(iso(H(5 + i)));
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
    answers.set(
      `groups@${iso(H(6))}`,
      ok([groupRow({ n: 2 }, H(6)), groupRow({ status: '429', n: 1 }, H(6))]),
    );
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
          ['wrong_password', 'wrong_code', 'auth_rate_limited', 'auth_log_over_cap'],
        ],
        ['gte', 'minute', iso(H(4))],
        ['lt', 'minute', iso(H(5))],
      ],
      limit: 1,
    });
  });

  it('an hour is written once: the next run skips it and reads only the hours with nothing stored', async () => {
    answers.set(`groups@${iso(H(7))}`, ok([groupRow({ n: 4 }, H(7))]));
    const first = await run();
    expect(first).toMatchObject({ hoursStored: 1, eventsStored: 4 });
    expect(h.rpc).toHaveBeenCalledTimes(1);

    fetches.length = 0;
    const second = await run();
    // Hour 07 holds rows now: not read, not written again. The empty hours are read again.
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(fetches.map((f) => new URL(f.url).searchParams.get('iso_timestamp_start'))).toEqual(
      [4, 5, 6, 8, 9].map((hh) => iso(H(hh))),
    );
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

  it('past the 199 groups the totals are read, and the remainder is stored with the hour', async () => {
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
    answers.set(`groups@${iso(H(8))}`, ok(rows));
    answers.set(`totals@${iso(H(8))}`, ok([totalsRow({ n: 199 + 40 }, H(8))]));
    const summary = await run();
    expect(
      fetches.filter((f) => new URL(f.url).searchParams.get('sql') === AUTH_LOGS_TOTALS_SQL),
    ).toHaveLength(1);
    const elements = (
      h.rpc.mock.calls[0]![1] as { p_events: Array<{ reason: string; count: number }> }
    ).p_events;
    expect(elements.length).toBeLessThanOrEqual(200);
    expect(elements.reduce((s, e) => s + e.count, 0)).toBe(239);
    expect(elements.filter((e) => e.reason === 'auth_log_over_cap')).toHaveLength(1);
    expect(summary).toMatchObject({ capped: 1, eventsStored: 239 });
  });

  it('a row that fails validation is dropped and counted; the rest is stored', async () => {
    answers.set(
      `groups@${iso(H(4))}`,
      ok([
        groupRow({ n: 2 }),
        groupRow({ status: 'x' }),
        groupRow({ minute: minuteOf(H(4), 61) }),
        'junk',
      ]),
    );
    const summary = await run();
    expect(summary).toMatchObject({ dropped: 3, groups: 1, eventsStored: 2 });
  });

  it('the dressed-up-server rule through a run: the constant passed in decides', async () => {
    answers.set(`groups@${iso(H(4))}`, ok([groupRow({ caller: 'server', asn: '64510', n: 5 })]));
    const unset = await run({ networks: [] });
    expect(h.rpc).not.toHaveBeenCalled();
    expect(unset).toMatchObject({
      notStored: { our_server: 5 },
      seen: { 'token 400 server 64510': 5 },
    });
    const set = await run({ networks: ['64500'] });
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(set).toMatchObject({ eventsStored: 5 });
    expect(
      (h.rpc.mock.calls[0]![1] as { p_events: Array<{ source: string }> }).p_events[0]!.source,
    ).toBe('api');
  });

  it('an hour whose rows landed past the minute caps is reported, so a later run storing it again is seen', async () => {
    answers.set(`groups@${iso(H(4))}`, ok([groupRow()]));
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

  it.each([429, 500, 502, 503])(
    '%s: reported with the status; the hour is left for the next run',
    async (code) => {
      answers.set(`groups@${iso(H(5))}`, status(code, echo));
      const summary = await run();
      expectOneReport(`status ${code}`, {
        cause: 'logs_unavailable',
        status: code,
        hour: '2026-11-21T05:00Z',
      });
      expect(fetches).toHaveLength(2);
      expect(h.rpc).not.toHaveBeenCalled();
      expect(summary).toMatchObject({ ok: false, hoursRead: 1 });
      expect(everythingSaid(summary)).not.toContain(MADE_UP_LOGS_VALUE);
      // The next run reads that hour again.
      answers.delete(`groups@${iso(H(5))}`);
      fetches.length = 0;
      await run();
      expect(fetches.map((f) => new URL(f.url).searchParams.get('iso_timestamp_start'))).toContain(
        iso(H(5)),
      );
    },
  );

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
      'an error in the answer',
      JSON.stringify({ result: null, error: { message: `near Bearer ${MADE_UP_LOGS_VALUE}` } }),
    ],
    ['no result list', JSON.stringify({ rows: [] })],
    ['not JSON', `Bearer ${MADE_UP_LOGS_VALUE}`],
  ])('%s: reported as an answer this job does not read, never its text', async (_what, body) => {
    answers.set(`groups@${iso(H(4))}`, () => new Response(body, { status: 200 }));
    const summary = await run();
    expectOneReport('answered in a shape this job does not read', { cause: 'logs_bad_answer' });
    expect(everythingSaid(summary)).not.toContain(MADE_UP_LOGS_VALUE);
  });

  it('a writer failure is reported with its code; the hour is left and read again next run', async () => {
    answers.set(`groups@${iso(H(4))}`, ok([groupRow()]));
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
    expect(fetches).toHaveLength(1);
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
    // Each answer takes 19 s, and ignores being cancelled: two hours fit, the
    // third is cut at the run's 50 s deadline.
    for (const hh of [4, 5, 6, 7, 8, 9]) {
      answers.set(
        `groups@${iso(H(hh))}`,
        () => new Promise((resolve) => setTimeout(() => resolve(ok([])({})), 19_000)),
      );
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
      hour: '2026-11-21T06:00Z',
    });
    expect(summary).toMatchObject({ ok: false, hoursRead: 2 });
    expect(summary.hours.map((x) => x.outcome)).toEqual([
      'nothing_to_store',
      'nothing_to_store',
      'failed',
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
