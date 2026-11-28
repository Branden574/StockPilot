import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ALERT_BASELINE_REFUSALS } from '@stockpilot/core';

/**
 * The daily security summary's job (part 5, stage 4a: RECORD ONLY).
 * Security invariant. Pinned: CRON_SECRET fails closed before any call; it calls
 * platform_security_alert_baseline() and nothing else (no summary, no email,
 * no push: 4b adds those); computed and computed_recently answer 200, any
 * other answer is reported once with its code or word only and answers 500;
 * one busy answer is asked again once; a call that never answers is cut and
 * the run ends inside its 60 s; it never throws; its log line says it sent
 * nothing. Made-up data only.
 */

const h = vi.hoisted(() => ({
  env: { CRON_SECRET: 'cron-secret-for-tests' as string | undefined },
  answer: vi.fn() as unknown as (fn: string, args: unknown) => unknown,
  calls: [] as Array<{ fn: string; args: unknown }>,
  report: vi.fn(async (_e: unknown, _c: unknown) => undefined),
  adminThrows: false,
}));

vi.mock('@/lib/env', () => ({ env: h.env }));
vi.mock('@/lib/error-reporter', () => ({ reportError: h.report }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => {
    if (h.adminThrows) throw new Error('supabaseUrl is required');
    return {
      rpc: (fn: string, args?: unknown) => {
        h.calls.push({ fn, args });
        const answer = Promise.resolve().then(() => h.answer(fn, args));
        return { abortSignal: () => answer };
      },
    };
  },
}));

import * as route from './route';
import { __resetAlertJobReportsForTests } from '@/server/security/alerts-reports';

const AUTH = { authorization: 'Bearer cron-secret-for-tests' };
const req = (headers: Record<string, string> = AUTH) =>
  new Request('https://app.example.com/api/cron/security-summary', { headers });

const COMPUTED = {
  computed: true,
  refused: null,
  event_high: 42,
  source_high: 7,
  from: '2026-11-17T15:00:00+00:00',
  to: '2026-11-24T15:00:00+00:00',
  asked_from: '2026-11-17T15:00:00+00:00',
  shortened: false,
  buckets: 1008,
  computed_at: '2026-11-24T15:00:04+00:00',
};
/** A refusal as the contract shapes it: computed_recently also says when it last was. */
const refusedWith = (word: string) =>
  word === 'computed_recently'
    ? { computed: false, refused: word, computed_at: '2026-11-24T12:00:00+00:00' }
    : { computed: false, refused: word };

beforeEach(() => {
  h.env.CRON_SECRET = 'cron-secret-for-tests';
  h.calls = [];
  h.adminThrows = false;
  h.answer = vi.fn(() => ({ data: COMPUTED, error: null }));
  h.report.mockReset();
  h.report.mockResolvedValue(undefined);
  __resetAlertJobReportsForTests();
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function run(request = req()) {
  const res = await route.GET(request);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const logLine = () => {
  const call = vi.mocked(console.info).mock.calls.find((c) => c[0] === '[cron.security-summary]');
  return call ? (JSON.parse(String(call[1])) as Record<string, unknown>) : null;
};

describe('the secret', () => {
  it('refuses without CRON_SECRET set, with no secret, and with a wrong one, before any call', async () => {
    // Unset or empty: refused whatever is sent, the words an unset secret would make included.
    for (const secret of [undefined, '']) {
      h.env.CRON_SECRET = secret;
      for (const authorization of [
        'Bearer cron-secret-for-tests',
        'Bearer undefined',
        'Bearer ',
        'Bearer',
      ]) {
        expect((await run(req({ authorization }))).status).toBe(401);
      }
    }
    h.env.CRON_SECRET = 'cron-secret-for-tests';
    expect((await run(req({}))).status).toBe(401);
    expect((await run(req({ authorization: 'Bearer wrong' }))).status).toBe(401);
    expect(h.calls).toEqual([]);
    expect(logLine()).toBeNull();
  });

  it('exports GET only, with a 60 s limit', () => {
    expect(Object.keys(route).filter((k) => /^[A-Z]+$/.test(k))).toEqual(['GET']);
    expect(route.maxDuration).toBe(60);
    expect(route.dynamic).toBe('force-dynamic');
  });

  it('vercel.json runs it daily at 15:00 UTC', () => {
    const vercel = JSON.parse(
      readFileSync(path.resolve(__dirname, '../../../../../vercel.json'), 'utf8'),
    ) as { crons: Array<{ path: string; schedule: string }> };
    expect(vercel.crons.filter((c) => c.path === '/api/cron/security-summary')).toEqual([
      { path: '/api/cron/security-summary', schedule: '0 15 * * *' },
    ]);
  });
});

describe('record only: it computes the baseline and sends nothing', () => {
  it('calls the baseline alone, with no arguments, and answers what it stored', async () => {
    const { status, body } = await run();
    expect(status).toBe(200);
    expect(h.calls).toEqual([{ fn: 'platform_security_alert_baseline', args: undefined }]);
    expect(body).toEqual({
      ok: true,
      sent: 'nothing',
      baseline: 'computed',
      eventHigh: 42,
      sourceHigh: 7,
      buckets: 1008,
      shortened: false,
      calls: 1,
    });
    expect(logLine()).toEqual({
      sent: 'nothing',
      baseline: 'computed',
      eventHigh: 42,
      sourceHigh: 7,
      buckets: 1008,
      shortened: false,
      calls: 1,
    });
    expect(h.report).not.toHaveBeenCalled();
  });

  it('computed_recently is an answer, not a failure', async () => {
    h.answer = vi.fn(() => ({ data: refusedWith('computed_recently'), error: null }));
    const { status, body } = await run();
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, sent: 'nothing', baseline: 'computed_recently', calls: 1 });
    expect(h.report).not.toHaveBeenCalled();
  });

  it('the source names no sender and no other database function', () => {
    const source = readFileSync(path.resolve(__dirname, 'route.ts'), 'utf8');
    expect(source).not.toMatch(
      /\bsend[A-Z]\w*\(|\bresend\b|expo-server-sdk|exp\.host|push-sender|email-sender/i,
    );
    expect([...new Set(source.match(/platform_[a-z_]+/g))]).toEqual([
      'platform_security_alert_baseline',
    ]);
  });
});

describe('every other answer is reported once and answers 500', () => {
  it.each(ALERT_BASELINE_REFUSALS.filter((w) => w !== 'computed_recently'))(
    'refused %s',
    async (word) => {
      h.answer = vi.fn(() => ({ data: refusedWith(word), error: null }));
      const { status, body } = await run();
      expect(status).toBe(500);
      expect(body).toEqual({ error: 'internal_error' });
      expect(h.report).toHaveBeenCalledTimes(1);
      expect(h.report).toHaveBeenCalledWith(expect.any(Error), {
        tag:
          word === 'no_state'
            ? 'cron.security-summary.baseline_no_state'
            : 'cron.security-summary.baseline_refused',
        level: word === 'no_state' ? 'error' : 'warning',
        extra: { refused: word, calls: 1 },
      });
      expect(logLine()).toEqual({ sent: 'nothing', baseline: 'refused', refused: word, calls: 1 });
    },
  );

  it.each([
    ['missing (PGRST202)', { code: 'PGRST202', message: 'not found' }, 'PGRST202'],
    ['missing (42883)', { code: '42883', message: 'function does not exist' }, '42883'],
    ['its own cancel (57014)', { code: '57014', message: 'canceling statement' }, '57014'],
    ['not allowed (42501)', { code: '42501', message: 'permission denied' }, '42501'],
    ['an error with no code', { message: 'fetch failed' }, 'no_code'],
    ['a code that is not a code', { code: 'not a code; drop table', message: 'x' }, 'no_code'],
  ])('failed %s: the code only, never the message', async (_w, error, code) => {
    h.answer = vi.fn(() => ({ data: null, error }));
    const { status } = await run();
    expect(status).toBe(500);
    expect(h.report).toHaveBeenCalledTimes(1);
    expect(h.report).toHaveBeenCalledWith(expect.any(Error), {
      tag: 'cron.security-summary.baseline_failed',
      level: 'warning',
      extra: { code, calls: 1 },
    });
    const [e] = h.report.mock.calls[0]!;
    expect(String((e as Error).message)).not.toContain(error.message);
  });

  it('a key a later migration adds is ignored: computed, nothing reported', async () => {
    h.answer = vi.fn(() => ({ data: { ...COMPUTED, added_later: 3 }, error: null }));
    const { status, body } = await run();
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, baseline: 'computed', eventHigh: 42 });
    expect(h.report).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a key it reads missing',
      (() => {
        const { buckets: _gone, ...rest } = COMPUTED;
        return rest;
      })(),
    ],
    ['a word the contract does not name', refusedWith('maybe')],
    ['no answer at all', null],
  ])('an answer this build cannot read (%s)', async (_w, data) => {
    h.answer = vi.fn(() => ({ data, error: null }));
    const { status } = await run();
    expect(status).toBe(500);
    expect(h.report).toHaveBeenCalledTimes(1);
    expect(logLine()).toMatchObject({ sent: 'nothing', baseline: 'unreadable' });
  });

  it('a busy answer (55P03) is asked once more, 1 s later; a second busy is reported', async () => {
    vi.useFakeTimers();
    let busy = 1;
    h.answer = vi.fn(() =>
      busy-- > 0
        ? { data: null, error: { code: '55P03', message: 'lock timeout' } }
        : { data: COMPUTED, error: null },
    );
    const first = run();
    await vi.advanceTimersByTimeAsync(1_100);
    expect((await first).body).toMatchObject({ ok: true, baseline: 'computed', calls: 2 });
    expect(h.report).not.toHaveBeenCalled();

    h.calls = [];
    h.answer = vi.fn(() => ({ data: null, error: { code: '55P03', message: 'lock timeout' } }));
    const second = run();
    await vi.advanceTimersByTimeAsync(1_100);
    const { status } = await second;
    expect(status).toBe(500);
    expect(h.calls).toHaveLength(2);
    expect(h.report).toHaveBeenCalledWith(expect.any(Error), {
      tag: 'cron.security-summary.baseline_failed',
      level: 'warning',
      extra: { code: '55P03', calls: 2 },
    });
  });
});

describe('time, and never throwing', () => {
  it('a call that never answers is cut at 25 s and reported as a timeout', async () => {
    vi.useFakeTimers();
    h.answer = vi.fn(() => new Promise(() => undefined));
    const started = Date.now();
    let endedAt = 0;
    const pending = run().then((r) => {
      endedAt = Date.now();
      return r;
    });
    await vi.advanceTimersByTimeAsync(30_000);
    const { status } = await pending;
    expect(status).toBe(500);
    expect(endedAt - started).toBe(25_000);
    expect(h.report).toHaveBeenCalledWith(expect.any(Error), {
      tag: 'cron.security-summary.baseline_failed',
      level: 'warning',
      extra: { code: 'timeout', calls: 1 },
    });
  });

  it('a call that throws, or a client that cannot be made, answers 500 and never throws', async () => {
    h.answer = vi.fn(() => {
      throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    });
    expect((await run()).status).toBe(500);
    expect(h.report).toHaveBeenLastCalledWith(expect.any(Error), {
      tag: 'cron.security-summary.baseline_failed',
      level: 'warning',
      extra: { code: 'ECONNRESET', calls: 1 },
    });
    h.adminThrows = true;
    expect((await run()).status).toBe(500);
    expect(logLine()).toMatchObject({ sent: 'nothing', baseline: 'failed' });
  });

  it('a baseline that fails on every call is reported once in 6 hours on this instance', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 24, 15), toFake: ['Date'] });
    h.answer = vi.fn(() => ({ data: null, error: { code: 'XX000', message: 'boom' } }));
    for (let i = 0; i < 5; i += 1) expect((await run()).status).toBe(500);
    expect(h.report).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.UTC(2026, 10, 24, 21));
    await run();
    expect(h.report).toHaveBeenCalledTimes(2);
    for (const [e, c] of h.report.mock.calls) {
      expect(String((e as Error).message)).not.toContain('boom');
      expect(c).toEqual({
        tag: 'cron.security-summary.baseline_failed',
        level: 'warning',
        extra: { code: 'XX000', calls: 1 },
      });
    }
  });

  it('a report that throws or hangs still answers, inside 4 s', async () => {
    h.answer = vi.fn(() => ({ data: refusedWith('no_state'), error: null }));
    h.report.mockRejectedValue(new Error('webhook down'));
    expect((await run()).status).toBe(500);
    vi.useFakeTimers();
    // A new instance: the tag was sent above, and is held for 6 hours on this one.
    __resetAlertJobReportsForTests();
    h.report.mockImplementation(() => new Promise(() => undefined));
    const started = Date.now();
    let endedAt = 0;
    const pending = run().then((r) => {
      endedAt = Date.now();
      return r;
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await pending).status).toBe(500);
    expect(endedAt - started).toBe(4_000);
  });
});
