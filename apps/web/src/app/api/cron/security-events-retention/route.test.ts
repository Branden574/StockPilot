import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The security events retention cron: CRON_SECRET fail-closed, then
 * purge_security_events() in a loop until both counts are under 5,000, at
 * most 40 calls and 45 s a run, four runs a day. A busy call (55P03) is tried
 * again 500 ms later; three in a row end the run. A run that stops before its
 * work is done (40 calls, 45 s, or busy) is reported once, as a warning, with
 * its counts and why. Any other error is reported and answered 500.
 *
 * Part 3 (sign-in alerts): the same run then calls purge_sign_in_alerts() by
 * the same rule (5,000 a call, 40 calls, a busy call tried again 500 ms
 * later, three in a row end it), within 30 s of its own, and whether or not
 * the first loop failed. Its counts are answered under signInAlerts.
 *
 * Part 5, stage 3 (what scanners asked for): then
 * purge_security_event_samples() by the same rule, within 15 s of its own,
 * whether or not an earlier loop failed; its counts are answered under
 * eventSamples. The function missing (42883, PGRST202) is no silent
 * success: the code ships after migration 0479 is live, so it is reported
 * once per run as a warning (the table and the code only) and answered as
 * `eventSamples: { ok: false, missing: true }`, while the other purges'
 * work and answer stand.
 *
 * The harness answers each function by its name: h.rpc is
 * purge_security_events, h.alerts is purge_sign_in_alerts, h.samples is
 * purge_security_event_samples (nothing to purge unless a test says).
 */

const h = vi.hoisted(() => ({
  env: { CRON_SECRET: 'cron-secret-for-tests' as string | undefined },
  rpc: vi.fn(),
  alerts: vi.fn(),
  samples: vi.fn(),
  report: vi.fn(async () => undefined),
}));

vi.mock('@/lib/env', () => ({ env: h.env }));
vi.mock('@/lib/error-reporter', () => ({ reportError: h.report }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    rpc: (fn: string, ...rest: unknown[]) =>
      fn === 'purge_sign_in_alerts'
        ? h.alerts(fn, ...rest)
        : fn === 'purge_security_event_samples'
          ? h.samples(fn, ...rest)
          : h.rpc(fn, ...rest),
  }),
}));

import * as route from './route';

const AUTH = { authorization: 'Bearer cron-secret-for-tests' };
const req = (headers: Record<string, string> = AUTH) =>
  new Request('https://app.example.com/api/cron/security-events-retention', { headers });

const counts = (deleted: number, hashes_cleared: number) => ({
  data: { deleted, hashes_cleared },
  error: null,
});
const busy = {
  data: null,
  error: { code: '55P03', message: 'canceling statement due to lock timeout' },
};

beforeEach(() => {
  h.env.CRON_SECRET = 'cron-secret-for-tests';
  h.rpc.mockReset();
  h.alerts.mockReset();
  h.alerts.mockResolvedValue({ data: 0, error: null });
  h.samples.mockReset();
  h.samples.mockResolvedValue({ data: { deleted: 0 }, error: null });
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
    expect(h.alerts).not.toHaveBeenCalled();
    expect(h.samples).not.toHaveBeenCalled();
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
      body: {
        ok: true,
        deleted: 12,
        hashesCleared: 340,
        calls: 1,
        stoppedEarly: false,
        stop: null,
        signInAlerts: { deleted: 0, calls: 1, stoppedEarly: false, stop: null },
        eventSamples: {
          ok: true,
          deleted: 0,
          calls: 1,
          stoppedEarly: false,
          stop: null,
          missing: false,
        },
      },
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
      signInAlerts: { deleted: 0, calls: 1, stoppedEarly: false, stop: null },
      eventSamples: {
        ok: true,
        deleted: 0,
        calls: 1,
        stoppedEarly: false,
        stop: null,
        missing: false,
      },
    });
  });

  it('stops after 40 calls, saying so, and reports that it could not finish', async () => {
    h.rpc.mockResolvedValue(counts(5000, 5000));
    expect((await run()).body).toEqual({
      ok: true,
      deleted: 200000,
      hashesCleared: 200000,
      calls: 40,
      stoppedEarly: true,
      stop: 'call_limit',
      signInAlerts: { deleted: 0, calls: 1, stoppedEarly: false, stop: null },
      eventSamples: {
        ok: true,
        deleted: 0,
        calls: 1,
        stoppedEarly: false,
        stop: null,
        missing: false,
      },
    });
    expect(h.rpc).toHaveBeenCalledTimes(40);
    // The purge was outrun: more is left than one run takes. Once, as a warning, counts only.
    expect(h.report).toHaveBeenCalledTimes(1);
    const [error, context] = h.report.mock.calls[0] as unknown as [Error, Record<string, unknown>];
    expect(error).toBeInstanceOf(Error);
    expect(context).toEqual({
      tag: 'cron.security-events-retention',
      level: 'warning',
      extra: { calls: 40, deleted: 200000, hashesCleared: 200000, stop: 'call_limit' },
    });
  });

  it('starts no call 45 s into the run, and reports that it could not finish', async () => {
    // Each call takes 10 s: calls start at 0, 10, 20, 30 and 40 s.
    h.rpc.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      return counts(5000, 0);
    });
    expect((await run()).body).toMatchObject({
      calls: 5,
      deleted: 25000,
      stoppedEarly: true,
      stop: 'time_limit',
    });
    expect(h.report).toHaveBeenCalledTimes(1);
    expect(h.report).toHaveBeenCalledWith(expect.any(Error), {
      tag: 'cron.security-events-retention',
      level: 'warning',
      extra: { calls: 5, deleted: 25000, hashesCleared: 0, stop: 'time_limit' },
    });
  });

  it('a run that finishes its work reports nothing', async () => {
    h.rpc.mockResolvedValueOnce(counts(5000, 5000)).mockResolvedValueOnce(counts(1, 2));
    expect((await run()).body).toMatchObject({ stoppedEarly: false, stop: null });
    expect(h.report).not.toHaveBeenCalled();
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
    expect(body).toEqual({
      ok: true,
      deleted: 5003,
      hashesCleared: 4,
      calls: 5,
      stoppedEarly: false,
      stop: null,
      signInAlerts: { deleted: 0, calls: 1, stoppedEarly: false, stop: null },
      eventSamples: {
        ok: true,
        deleted: 0,
        calls: 1,
        stoppedEarly: false,
        stop: null,
        missing: false,
      },
    });
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
      body: {
        ok: true,
        deleted: 5000,
        hashesCleared: 5000,
        calls: 4,
        stoppedEarly: true,
        stop: 'busy',
        signInAlerts: { deleted: 0, calls: 1, stoppedEarly: false, stop: null },
        eventSamples: {
          ok: true,
          deleted: 0,
          calls: 1,
          stoppedEarly: false,
          stop: null,
          missing: false,
        },
      },
    });
    expect(h.rpc).toHaveBeenCalledTimes(4);
    expect(h.report).toHaveBeenCalledTimes(1);
    expect(h.report).toHaveBeenCalledWith(expect.any(Error), {
      tag: 'cron.security-events-retention',
      level: 'warning',
      extra: { calls: 4, deleted: 5000, hashesCleared: 5000, stop: 'busy' },
    });
  });

  it.each([
    [
      'another error',
      {
        data: null,
        error: { code: '57014', message: 'canceling statement due to statement timeout' },
      },
    ],
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

describe('sign-in alerts (part 3): the same run, the same rule', () => {
  const alertsCount = (n: number) => ({ data: n, error: null });

  it('after the security events, purge_sign_in_alerts() is called, with no arguments', async () => {
    h.rpc.mockResolvedValueOnce(counts(1, 1));
    h.alerts.mockResolvedValueOnce(alertsCount(7));
    expect((await run()).body).toMatchObject({
      signInAlerts: { deleted: 7, calls: 1, stoppedEarly: false, stop: null },
    });
    expect(h.alerts).toHaveBeenCalledWith('purge_sign_in_alerts');
    expect(h.rpc.mock.invocationCallOrder[0]!).toBeLessThan(h.alerts.mock.invocationCallOrder[0]!);
  });

  it('calls again while a call removes 5,000, and sums', async () => {
    h.rpc.mockResolvedValueOnce(counts(0, 0));
    h.alerts
      .mockResolvedValueOnce(alertsCount(5000))
      .mockResolvedValueOnce(alertsCount(5000))
      .mockResolvedValueOnce(alertsCount(12));
    expect((await run()).body).toMatchObject({
      signInAlerts: { deleted: 10012, calls: 3, stoppedEarly: false, stop: null },
    });
  });

  it('stops after 40 calls and reports it once, as a warning with counts only', async () => {
    h.rpc.mockResolvedValueOnce(counts(0, 0));
    h.alerts.mockResolvedValue(alertsCount(5000));
    expect((await run()).body).toMatchObject({
      ok: true,
      signInAlerts: { deleted: 200000, calls: 40, stoppedEarly: true, stop: 'call_limit' },
    });
    expect(h.report).toHaveBeenCalledTimes(1);
    expect(h.report).toHaveBeenCalledWith(expect.any(Error), {
      tag: 'cron.security-events-retention',
      level: 'warning',
      extra: { table: 'sign_in_alerts', calls: 40, deleted: 200000, stop: 'call_limit' },
    });
  });

  it('starts no call 30 s into its own part of the run', async () => {
    h.rpc.mockResolvedValueOnce(counts(0, 0));
    h.alerts.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      return alertsCount(5000);
    });
    expect((await run()).body).toMatchObject({
      signInAlerts: { calls: 3, deleted: 15000, stoppedEarly: true, stop: 'time_limit' },
    });
  });

  it('a busy call is tried again 500 ms later; three in a row end its part', async () => {
    h.rpc.mockResolvedValueOnce(counts(0, 0));
    h.alerts.mockResolvedValueOnce(busy).mockResolvedValueOnce(alertsCount(3));
    expect((await run()).body).toMatchObject({
      signInAlerts: { deleted: 3, calls: 2, stoppedEarly: false, stop: null },
    });
    h.rpc.mockResolvedValueOnce(counts(0, 0));
    h.alerts.mockReset();
    h.alerts.mockResolvedValue(busy);
    expect((await run()).body).toMatchObject({
      signInAlerts: { deleted: 0, calls: 3, stoppedEarly: true, stop: 'busy' },
    });
  });

  it.each([
    [
      'another error',
      {
        data: null,
        error: { code: '57014', message: 'canceling statement due to statement timeout' },
      },
    ],
    ['an answer that is not a count', { data: 'many', error: null }],
  ])('%s is reported and answered 500', async (_what, answer) => {
    h.rpc.mockResolvedValueOnce(counts(1, 1));
    h.alerts.mockResolvedValueOnce(answer);
    expect(await run()).toEqual({ status: 500, body: { error: 'internal_error' } });
    expect(h.report).toHaveBeenCalledTimes(1);
    expect(h.report).toHaveBeenCalledWith(expect.any(Error), {
      tag: 'cron.security-events-retention',
      extra: { table: 'sign_in_alerts', calls: 1, deleted: 0 },
    });
  });

  it('a security events purge that stops on its call limit is still reported when the sign-in alerts purge fails; both reports, and 500', async () => {
    h.rpc.mockResolvedValue(counts(5000, 5000));
    h.alerts.mockResolvedValueOnce({
      data: null,
      error: { code: '57014', message: 'canceling statement' },
    });
    expect(await run()).toEqual({ status: 500, body: { error: 'internal_error' } });
    expect(h.report).toHaveBeenCalledTimes(2);
    expect(h.report).toHaveBeenCalledWith(expect.any(Error), {
      tag: 'cron.security-events-retention',
      level: 'warning',
      extra: { calls: 40, deleted: 200000, hashesCleared: 200000, stop: 'call_limit' },
    });
    expect(h.report).toHaveBeenCalledWith(expect.any(Error), {
      tag: 'cron.security-events-retention',
      extra: { table: 'sign_in_alerts', calls: 1, deleted: 0 },
    });
    // The events purge's report comes first, as its loop ends.
    const first = h.report.mock.calls[0] as unknown as [Error, { extra: Record<string, unknown> }];
    expect(first[1].extra).not.toHaveProperty('table');
  });

  it('a security events loop that fails still lets the sign-in alerts be purged, and the run answers 500', async () => {
    h.rpc.mockRejectedValueOnce(new Error('fetch failed'));
    h.alerts.mockResolvedValueOnce(alertsCount(4));
    expect((await run()).status).toBe(500);
    expect(h.alerts).toHaveBeenCalledTimes(1);
  });
});

describe('event samples (part 5, stage 3): the same run, the same rule', () => {
  const removed = (n: number) => ({ data: { deleted: n }, error: null });
  const TABLE = 'security_event_samples';

  it('after the sign-in alerts, purge_security_event_samples() is called, with no arguments', async () => {
    h.rpc.mockResolvedValueOnce(counts(1, 1));
    h.samples.mockResolvedValueOnce(removed(9));
    expect((await run()).body).toMatchObject({
      ok: true,
      eventSamples: {
        ok: true,
        deleted: 9,
        calls: 1,
        stoppedEarly: false,
        stop: null,
        missing: false,
      },
    });
    expect(h.samples).toHaveBeenCalledWith('purge_security_event_samples');
    expect(h.alerts.mock.invocationCallOrder[0]!).toBeLessThan(
      h.samples.mock.invocationCallOrder[0]!,
    );
    expect(console.info).toHaveBeenCalledWith(
      '[cron.security-events-retention]',
      JSON.stringify({
        table: TABLE,
        ok: true,
        deleted: 9,
        calls: 1,
        stoppedEarly: false,
        stop: null,
        missing: false,
      }),
    );
  });

  it('calls again while a call removes 5,000, and sums', async () => {
    h.rpc.mockResolvedValueOnce(counts(0, 0));
    h.samples
      .mockResolvedValueOnce(removed(5000))
      .mockResolvedValueOnce(removed(5000))
      .mockResolvedValueOnce(removed(1));
    expect((await run()).body).toMatchObject({
      eventSamples: { deleted: 10001, calls: 3, stoppedEarly: false, stop: null, missing: false },
    });
    expect(h.report).not.toHaveBeenCalled();
  });

  it('stops after 40 calls and reports it once, as a warning with counts only', async () => {
    h.rpc.mockResolvedValueOnce(counts(0, 0));
    h.samples.mockResolvedValue(removed(5000));
    expect((await run()).body).toMatchObject({
      ok: true,
      eventSamples: {
        deleted: 200000,
        calls: 40,
        stoppedEarly: true,
        stop: 'call_limit',
        missing: false,
      },
    });
    expect(h.report).toHaveBeenCalledTimes(1);
    expect(h.report).toHaveBeenCalledWith(expect.any(Error), {
      tag: 'cron.security-events-retention',
      level: 'warning',
      extra: { table: TABLE, calls: 40, deleted: 200000, stop: 'call_limit' },
    });
  });

  it('starts no call 15 s into its own part of the run', async () => {
    h.rpc.mockResolvedValueOnce(counts(0, 0));
    h.samples.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      return removed(5000);
    });
    expect((await run()).body).toMatchObject({
      eventSamples: { calls: 2, deleted: 10000, stoppedEarly: true, stop: 'time_limit' },
    });
  });

  it('a busy call is tried again 500 ms later; three in a row end its part', async () => {
    h.rpc.mockResolvedValueOnce(counts(0, 0));
    h.samples.mockResolvedValueOnce(busy).mockResolvedValueOnce(removed(3));
    expect((await run()).body).toMatchObject({
      eventSamples: { deleted: 3, calls: 2, stoppedEarly: false, stop: null },
    });
    h.rpc.mockResolvedValueOnce(counts(0, 0));
    h.samples.mockReset();
    h.samples.mockResolvedValue(busy);
    h.report.mockClear();
    expect((await run()).body).toMatchObject({
      eventSamples: { deleted: 0, calls: 3, stoppedEarly: true, stop: 'busy' },
    });
    expect(h.report).toHaveBeenCalledWith(expect.any(Error), {
      tag: 'cron.security-events-retention',
      level: 'warning',
      extra: { table: TABLE, calls: 3, deleted: 0, stop: 'busy' },
    });
  });

  it.each(['42883', 'PGRST202'])(
    'the function missing (%s): the other purges stand, the samples half is not ok, reported once as a warning',
    async (code) => {
      h.rpc.mockResolvedValueOnce(counts(2, 3));
      h.alerts.mockResolvedValueOnce({ data: 4, error: null });
      h.samples.mockResolvedValue({ data: null, error: { code, message: 'function not found' } });
      expect(await run()).toEqual({
        status: 200,
        body: {
          ok: true,
          deleted: 2,
          hashesCleared: 3,
          calls: 1,
          stoppedEarly: false,
          stop: null,
          signInAlerts: { deleted: 4, calls: 1, stoppedEarly: false, stop: null },
          eventSamples: {
            ok: false,
            deleted: 0,
            calls: 1,
            stoppedEarly: false,
            stop: null,
            missing: true,
          },
        },
      });
      // One call: a missing function is not tried again in the same run.
      expect(h.samples).toHaveBeenCalledTimes(1);
      expect(h.report).toHaveBeenCalledTimes(1);
      expect(h.report).toHaveBeenCalledWith(expect.any(Error), {
        tag: 'cron.security-events-retention',
        level: 'warning',
        extra: { table: TABLE, code },
      });
      expect(console.info).toHaveBeenCalledWith(
        '[cron.security-events-retention]',
        JSON.stringify({
          table: TABLE,
          ok: false,
          deleted: 0,
          calls: 1,
          stoppedEarly: false,
          stop: null,
          missing: true,
        }),
      );
    },
  );

  it('the function missing is reported once per run: each run reports it again', async () => {
    h.samples.mockResolvedValue({
      data: null,
      error: { code: '42883', message: 'function not found' },
    });
    h.rpc.mockResolvedValue(counts(0, 0));
    await run();
    await run();
    expect(h.report).toHaveBeenCalledTimes(2);
  });

  it('the function missing with the security events purge failing: both reported, and 500', async () => {
    h.rpc.mockRejectedValueOnce(new Error('fetch failed'));
    h.samples.mockResolvedValue({
      data: null,
      error: { code: 'PGRST202', message: 'function not found' },
    });
    expect((await run()).status).toBe(500);
    expect(h.report).toHaveBeenCalledTimes(2);
    expect(h.report).toHaveBeenCalledWith(expect.any(Error), {
      tag: 'cron.security-events-retention',
      level: 'warning',
      extra: { table: TABLE, code: 'PGRST202' },
    });
  });

  it.each([
    [
      'another error',
      {
        data: null,
        error: { code: '57014', message: 'canceling statement due to statement timeout' },
      },
    ],
    ['an answer without its count', { data: { deleted: 'many' }, error: null }],
    ['a bare count', { data: 5, error: null }],
    ['no answer', { data: null, error: null }],
  ])('%s is reported and answered 500', async (_what, answer) => {
    h.rpc.mockResolvedValueOnce(counts(1, 1));
    h.samples.mockResolvedValueOnce(answer);
    expect(await run()).toEqual({ status: 500, body: { error: 'internal_error' } });
    expect(h.report).toHaveBeenCalledTimes(1);
    expect(h.report).toHaveBeenCalledWith(expect.any(Error), {
      tag: 'cron.security-events-retention',
      extra: { table: TABLE, calls: 1, deleted: 0 },
    });
  });

  it('runs whether or not an earlier loop failed, and the run still answers 500', async () => {
    h.rpc.mockRejectedValueOnce(new Error('fetch failed'));
    h.alerts.mockResolvedValueOnce({
      data: null,
      error: { code: '57014', message: 'canceling statement' },
    });
    h.samples.mockResolvedValueOnce(removed(4));
    expect((await run()).status).toBe(500);
    expect(h.samples).toHaveBeenCalledTimes(1);
    expect(console.info).toHaveBeenCalledWith(
      '[cron.security-events-retention]',
      JSON.stringify({
        table: TABLE,
        ok: true,
        deleted: 4,
        calls: 1,
        stoppedEarly: false,
        stop: null,
        missing: false,
      }),
    );
  });

  it("a failure here leaves the earlier loops' summary lines written first", async () => {
    h.rpc.mockResolvedValueOnce(counts(1, 1));
    h.samples.mockRejectedValueOnce(new Error('fetch failed'));
    expect((await run()).status).toBe(500);
    const lines = vi.mocked(console.info).mock.calls.map((c) => String(c[1]));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('"table":"sign_in_alerts"');
  });

  it('the three budgets and a call in flight for each stay inside maxDuration', () => {
    const src = readFileSync(path.join(__dirname, 'route.ts'), 'utf8');
    const budget = (name: string) => {
      const m = new RegExp(`const ${name} = ([0-9_]+);`).exec(src);
      expect(m, name).not.toBeNull();
      return Number(m![1]!.replace(/_/g, ''));
    };
    const budgets = ['RUN_BUDGET_MS', 'SIGN_IN_ALERTS_BUDGET_MS', 'EVENT_SAMPLES_BUDGET_MS'].map(
      budget,
    );
    expect(budgets).toEqual([45_000, 30_000, 15_000]);
    // Each loop's last call may wait 2 s for its lock and then delete 5,000 rows
    // (about 0.1 s measured for this table, CONTRACT.md); 5 s each is far more.
    expect(budgets.reduce((a, b) => a + b, 0) + 3 * 5_000).toBeLessThan(route.maxDuration * 1000);
  });
});

describe('the schedule', () => {
  it('vercel.json runs it four times a day, at half past every sixth hour (UTC)', () => {
    const vercel = JSON.parse(
      readFileSync(path.resolve(__dirname, '../../../../../vercel.json'), 'utf8'),
    ) as { crons: Array<{ path: string; schedule: string }> };
    expect(vercel.crons.filter((c) => c.path === '/api/cron/security-events-retention')).toEqual([
      { path: '/api/cron/security-events-retention', schedule: '30 */6 * * *' },
    ]);
  });

  it('four runs a day take more than the writer can admit with no organization in a day', () => {
    // A run clears at most 40 x 5,000 hashes; the writer admits at most 200
    // ordinary rows a minute with no organization (migration security_events).
    const clearedADay = 4 * 40 * 5000;
    const admittedADay = 200 * 60 * 24;
    expect(clearedADay).toBeGreaterThan(admittedADay);
  });
});
