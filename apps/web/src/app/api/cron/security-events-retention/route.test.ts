import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The security events retention cron: CRON_SECRET fail-closed, then
 * purge_security_events() in a loop until both counts are under 5,000, at
 * most 40 calls and 45 s a run. A busy call (55P03) is tried again 500 ms
 * later; three in a row end the run, reported as a warning. Any other error
 * is reported and answered 500.
 */

const h = vi.hoisted(() => ({
  env: { CRON_SECRET: 'cron-secret-for-tests' as string | undefined },
  rpc: vi.fn(),
  report: vi.fn(async () => undefined),
}));

vi.mock('@/lib/env', () => ({ env: h.env }));
vi.mock('@/lib/error-reporter', () => ({ reportError: h.report }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ rpc: h.rpc }) }));

import * as route from './route';

const AUTH = { authorization: 'Bearer cron-secret-for-tests' };
const req = (headers: Record<string, string> = AUTH) =>
  new Request('https://app.example.com/api/cron/security-events-retention', { headers });

const counts = (deleted: number, hashes_cleared: number) => ({
  data: { deleted, hashes_cleared },
  error: null,
});
const busy = { data: null, error: { code: '55P03', message: 'canceling statement due to lock timeout' } };

beforeEach(() => {
  h.env.CRON_SECRET = 'cron-secret-for-tests';
  h.rpc.mockReset();
  h.report.mockClear();
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Runs GET to the end, letting every pause elapse. */
async function run(request = req()) {
  const pending = route.GET(request);
  await vi.runAllTimersAsync();
  const res = await pending;
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('the secret', () => {
  it('refuses without CRON_SECRET set, with no secret, and with a wrong one, before any call', async () => {
    h.env.CRON_SECRET = undefined;
    expect((await run()).status).toBe(401);
    h.env.CRON_SECRET = '';
    expect((await run()).status).toBe(401);
    h.env.CRON_SECRET = 'cron-secret-for-tests';
    expect((await run(req({}))).status).toBe(401);
    expect((await run(req({ authorization: 'Bearer not-the-secret' }))).status).toBe(401);
    expect((await run(req({ authorization: 'cron-secret-for-tests' }))).status).toBe(401);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('exports GET only (a Vercel Cron job), with a 120 s limit', () => {
    const handlers = Object.keys(route).filter((k) => /^[A-Z]+$/.test(k));
    expect(handlers).toEqual(['GET']);
    expect(route.maxDuration).toBe(120);
  });
});

describe('the loop', () => {
  it('one call when both counts are already under 5,000', async () => {
    h.rpc.mockResolvedValueOnce(counts(12, 340));
    expect(await run()).toEqual({
      status: 200,
      body: { ok: true, deleted: 12, hashesCleared: 340, calls: 1, stoppedEarly: false, stop: null },
    });
    expect(h.rpc).toHaveBeenCalledWith('purge_security_events');
  });

  it('calls again while either count is 5,000, and sums', async () => {
    h.rpc
      .mockResolvedValueOnce(counts(5000, 5000))
      .mockResolvedValueOnce(counts(5000, 10))
      .mockResolvedValueOnce(counts(0, 5000))
      .mockResolvedValueOnce(counts(4999, 4999));
    expect((await run()).body).toEqual({
      ok: true,
      deleted: 14999,
      hashesCleared: 15009,
      calls: 4,
      stoppedEarly: false,
      stop: null,
    });
  });

  it('stops after 40 calls, saying so', async () => {
    h.rpc.mockResolvedValue(counts(5000, 5000));
    expect((await run()).body).toEqual({
      ok: true,
      deleted: 200000,
      hashesCleared: 200000,
      calls: 40,
      stoppedEarly: true,
      stop: 'call_limit',
    });
    expect(h.rpc).toHaveBeenCalledTimes(40);
    expect(h.report).not.toHaveBeenCalled();
  });

  it('starts no call 45 s into the run', async () => {
    // Each call takes 10 s: calls start at 0, 10, 20, 30 and 40 s.
    h.rpc.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      return counts(5000, 0);
    });
    expect((await run()).body).toMatchObject({ calls: 5, deleted: 25000, stoppedEarly: true, stop: 'time_limit' });
  });

  it('a busy call is tried again 500 ms later, and the streak ends at the next answer', async () => {
    h.rpc
      .mockResolvedValueOnce(busy)
      .mockResolvedValueOnce(busy)
      .mockResolvedValueOnce(counts(5000, 0))
      .mockResolvedValueOnce(busy)
      .mockResolvedValueOnce(counts(3, 4));
    const pending = route.GET(req());
    await vi.advanceTimersByTimeAsync(499);
    expect(h.rpc).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.rpc).toHaveBeenCalledTimes(2);
    await vi.runAllTimersAsync();
    const body = await (await pending).json();
    expect(body).toEqual({ ok: true, deleted: 5003, hashesCleared: 4, calls: 5, stoppedEarly: false, stop: null });
    expect(h.report).not.toHaveBeenCalled();
  });

  it('three busy calls in a row end the run, reported as a warning with counts only', async () => {
    h.rpc
      .mockResolvedValueOnce(counts(5000, 5000))
      .mockResolvedValueOnce(busy)
      .mockResolvedValueOnce(busy)
      .mockResolvedValueOnce(busy);
    expect(await run()).toEqual({
      status: 200,
      body: { ok: true, deleted: 5000, hashesCleared: 5000, calls: 4, stoppedEarly: true, stop: 'busy' },
    });
    expect(h.rpc).toHaveBeenCalledTimes(4);
    expect(h.report).toHaveBeenCalledTimes(1);
    expect(h.report).toHaveBeenCalledWith(expect.any(Error), {
      tag: 'cron.security-events-retention',
      level: 'warning',
      extra: { calls: 4, deleted: 5000, hashesCleared: 5000 },
    });
  });

  it.each([
    ['another error', { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }],
    ['an answer without its counts', { data: { deleted: 'many' }, error: null }],
    ['no answer', { data: null, error: null }],
  ])('%s is reported and answered 500', async (_what, answer) => {
    h.rpc.mockResolvedValueOnce(counts(5000, 0)).mockResolvedValueOnce(answer);
    expect(await run()).toEqual({ status: 500, body: { error: 'internal_error' } });
    expect(h.report).toHaveBeenCalledTimes(1);
    expect(h.report).toHaveBeenCalledWith(expect.any(Error), {
      tag: 'cron.security-events-retention',
      extra: { calls: 2, deleted: 5000, hashesCleared: 0 },
    });
  });

  it('a call that throws is reported and answered 500', async () => {
    h.rpc.mockRejectedValueOnce(new Error('fetch failed'));
    expect((await run()).status).toBe(500);
    expect(h.report).toHaveBeenCalledTimes(1);
  });
});

describe('the schedule', () => {
  it('vercel.json runs it once a day at 04:30 UTC', () => {
    const vercel = JSON.parse(
      readFileSync(path.resolve(__dirname, '../../../../../vercel.json'), 'utf8'),
    ) as { crons: Array<{ path: string; schedule: string }> };
    expect(vercel.crons.filter((c) => c.path === '/api/cron/security-events-retention')).toEqual([
      { path: '/api/cron/security-events-retention', schedule: '30 4 * * *' },
    ]);
  });
});
