// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security invariant: the cron that reads refused sign-ins from Supabase's
 * gateway log (server/security/auth-logs.ts) answers only the cron secret,
 * does nothing without its token, and its log line and answer hold counts and
 * codes only: never the token, even when the logs service repeats it back.
 *
 * Every value here is made up: the project ref, the token, the secret.
 */

const MADE_UP_LOGS_VALUE = ['made', 'up', 'logs', 'value', '0452', 'never', 'real'].join('-');
const CRON_VALUE = ['cron', 'value', 'for', 'tests'].join('-');

const h = vi.hoisted(() => ({
  env: {
    CRON_SECRET: '' as string | undefined,
    SUPABASE_LOGS_READ_TOKEN: '' as string | undefined,
    NEXT_PUBLIC_SUPABASE_URL: 'https://madeupprojectref0000.supabase.co',
  },
  report: vi.fn(async (_err: unknown, _ctx: unknown) => undefined),
  createAdminClient: vi.fn(),
  rpc: vi.fn(),
  info: vi.fn(),
}));

vi.mock('@/lib/env', () => ({ env: h.env }));
vi.mock('@/lib/error-reporter', () => ({ reportError: h.report }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: h.createAdminClient }));

import * as route from './route';

const NOW = Date.UTC(2026, 10, 21, 10, 10);
const H04 = Date.UTC(2026, 10, 21, 4);

const req = (headers: Record<string, string> = { authorization: `Bearer ${CRON_VALUE}` }) =>
  new Request('https://app.example.com/api/cron/security-events-auth-logs', { headers });

/** The logs service: what each call answers (default: nothing). */
let answer: (url: URL) => Response = () =>
  new Response(JSON.stringify({ result: [], error: null }));
const fetchSpy = vi.fn(async (input: string | URL | Request) => answer(new URL(String(input))));

/** An admin client whose reads find nothing (with a count of none) and whose writer takes everything. */
function adminClient() {
  const builder: Record<string, unknown> = {};
  for (const m of ['select', 'is', 'eq', 'in', 'gte', 'lt', 'limit', 'abortSignal'])
    builder[m] = () => builder;
  builder.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: [], error: null, count: 0 }).then(resolve);
  return {
    from: () => builder,
    rpc: (name: string, args: unknown) => ({ abortSignal: () => h.rpc(name, args) }),
  };
}

async function call(request = req()) {
  const res = await route.GET(request);
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as Record<string, unknown> };
}

/** The one log line of the run, as it was written. */
function logLine(): string {
  const lines = h.info.mock.calls.map((args) => args.map(String).join(' '));
  expect(lines).toHaveLength(1);
  return lines[0]!;
}

beforeEach(() => {
  h.env.CRON_SECRET = CRON_VALUE;
  h.env.SUPABASE_LOGS_READ_TOKEN = MADE_UP_LOGS_VALUE;
  h.report.mockClear();
  h.createAdminClient.mockReset();
  h.createAdminClient.mockImplementation(adminClient);
  h.rpc.mockReset();
  h.rpc.mockImplementation(async (_n: string, args: { p_events: unknown[] }) => ({
    data: args.p_events.length,
    error: null,
  }));
  h.info.mockReset();
  vi.spyOn(console, 'info').mockImplementation(h.info);
  answer = () => new Response(JSON.stringify({ result: [], error: null }));
  fetchSpy.mockClear();
  vi.stubGlobal('fetch', fetchSpy);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the secret', () => {
  it('refuses without CRON_SECRET set, with no secret, and with a wrong one, before anything is read', async () => {
    h.env.CRON_SECRET = undefined;
    expect((await call()).status).toBe(401);
    h.env.CRON_SECRET = '';
    expect((await call()).status).toBe(401);
    h.env.CRON_SECRET = CRON_VALUE;
    expect((await call(req({}))).status).toBe(401);
    expect((await call(req({ authorization: 'Bearer not-the-value' }))).status).toBe(401);
    expect((await call(req({ authorization: CRON_VALUE }))).status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(h.createAdminClient).not.toHaveBeenCalled();
    expect(h.report).not.toHaveBeenCalled();
  });

  it('exports GET only (a Vercel Cron job), on Node, with a 60 s limit', () => {
    const handlers = Object.keys(route).filter((k) => /^[A-Z]+$/.test(k));
    expect(handlers).toEqual(['GET']);
    expect(route.maxDuration).toBe(60);
    expect(route.runtime).toBe('nodejs');
  });
});

describe('the token', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
  ])('%s: answers 200 { skipped: no_token } and does nothing', async (_what, value) => {
    h.env.SUPABASE_LOGS_READ_TOKEN = value;
    expect(await call()).toMatchObject({ status: 200, body: { skipped: 'no_token' } });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(h.createAdminClient).not.toHaveBeenCalled();
    expect(h.report).not.toHaveBeenCalled();
  });

  it('is read only through the env module', () => {
    const source = readFileSync(path.join(__dirname, 'route.ts'), 'utf8');
    expect(source).not.toMatch(/process\.env/);
    expect(source).toMatch(/env\.SUPABASE_LOGS_READ_TOKEN/);
  });
});

describe('the run', () => {
  it('answers 200 with counts, and writes one log line of counts and codes', async () => {
    const lines = [
      // The phone app: stored.
      { kind: 'password', status: '400', caller: 'phone', network: 'other', country: 'NL', n: 3 },
      // Our own server (its client string from a hosting network): not stored.
      {
        kind: 'password',
        status: '400',
        caller: 'server',
        network: 'hosting',
        country: 'US',
        n: 9,
      },
      // Its client string from another network: stored as api.
      { kind: 'password', status: '400', caller: 'server', network: 'other', country: 'US', n: 2 },
    ];
    answer = (url) => {
      const totals = url.searchParams.get('sql')!.includes(' AS first_seen');
      const inHour = url.searchParams.get('iso_timestamp_start') === new Date(H04).toISOString();
      const result = !inHour
        ? []
        : totals
          ? lines.map(({ country: _c, ...l }) => ({
              ...l,
              form: 'plain',
              first_seen: '2026-11-21 04:05:00',
              last_seen: '2026-11-21 04:05:00',
            }))
          : lines.map((l) => ({ ...l, minute: '2026-11-21 04:05:00' }));
      return new Response(JSON.stringify({ result, error: null }));
    };
    const { status, text, body } = await call();
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, hoursRead: 6, hoursStored: 1, eventsStored: 5 });
    expect(h.rpc).toHaveBeenCalledTimes(1);

    const line = logLine();
    expect(line.startsWith('[cron.security-events-auth-logs] {')).toBe(true);
    const logged = JSON.parse(line.slice(line.indexOf(' ') + 1)) as Record<string, unknown>;
    expect(logged).toEqual(body);
    expect(logged).toMatchObject({
      notStored: { our_server: 9, other_status: 0, refresh: 0, known_other: 0 },
      seen: {
        'password 400 phone other': 3,
        'password 400 server hosting': 9,
        'password 400 server other': 2,
      },
    });
    // Our server's 9 are reconciled with what it recorded (nothing here): an
    // excess of 9 is in the log line, and below 10 nothing is stored for it.
    expect((logged.hours as unknown[])[0]).toMatchObject({
      reconcile: {
        gateway: { password: 9, code: 0 },
        recorded: { password: 0, code: 0, overflow: 0 },
        excess: { password: 9, code: 0 },
      },
    });
    // Counts and codes only: every text in it is a code, a status or an hour.
    const texts: string[] = [];
    const walk = (v: unknown, key = ''): void => {
      if (typeof v === 'string') {
        texts.push(v);
      } else if (Array.isArray(v)) {
        for (const x of v) walk(x, key);
      } else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) {
          texts.push(k);
          walk(x, k);
        }
      } else if (v !== null && typeof v !== 'number' && typeof v !== 'boolean') {
        throw new Error(`${key}: ${String(v)}`);
      }
    };
    walk(logged);
    for (const t of texts) expect(t, t).toMatch(/^[A-Za-z0-9_ :.-]{1,40}$/);
    for (const said of [line, text]) {
      expect(said).not.toContain(MADE_UP_LOGS_VALUE);
      expect(said).not.toContain('madeupprojectref0000');
    }
  });

  it('a refused token is reported once; the answer and the log line never hold it, even when the service echoes it', async () => {
    answer = () =>
      new Response(`{"error":"Unauthorized","authorization":"Bearer ${MADE_UP_LOGS_VALUE}"}`, {
        status: 401,
      });
    const { status, text, body } = await call();
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: false, failure: { cause: 'token_refused', status: 401 } });
    expect(h.report).toHaveBeenCalledTimes(1);
    expect(h.rpc).not.toHaveBeenCalled();
    const said = JSON.stringify([
      text,
      logLine(),
      h.report.mock.calls.map(([e, c]) => [String(e), (e as Error).stack, c]),
    ]);
    expect(said).not.toContain(MADE_UP_LOGS_VALUE);
  });
});

describe('the schedule', () => {
  it('vercel.json runs it at ten past every hour (UTC)', () => {
    const vercel = JSON.parse(
      readFileSync(path.resolve(__dirname, '../../../../../vercel.json'), 'utf8'),
    ) as { crons: Array<{ path: string; schedule: string }> };
    expect(vercel.crons.filter((c) => c.path === '/api/cron/security-events-auth-logs')).toEqual([
      { path: '/api/cron/security-events-auth-logs', schedule: '10 * * * *' },
    ]);
  });
});
