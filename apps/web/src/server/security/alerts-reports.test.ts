// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The security alert jobs' one way to report (server/security/alerts-reports.ts).
 * Security invariant: a report of the two jobs goes out at most once in 6
 * hours per tag on one instance, except the one the database gates itself
 * (report_now), which goes when, and only when, the database says so; and
 * it carries nothing but its tag's fixed sentence, whole-number counts and
 * checked codes. Made-up data only.
 */

const h = vi.hoisted(() => ({
  report: vi.fn(async (_e: unknown, _c: unknown) => undefined),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/error-reporter', () => ({ reportError: h.report }));

import {
  ALERT_JOB_REPORT_GAP_MS,
  ALERT_JOB_REPORTS,
  __resetAlertJobReportsForTests,
  alertWhereCode,
  reportAlertJob,
} from './alerts-reports';

const T0 = Date.UTC(2026, 10, 24, 12, 0, 4);

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  __resetAlertJobReportsForTests();
  h.report.mockReset();
  h.report.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('at most once in 6 hours per tag on this instance', () => {
  it('a tag sent is held for 6 hours, then sent again; another tag is its own', async () => {
    expect(
      await reportAlertJob('cron.security-alerts.cannot_call', { codes: { code: 'PGRST202' } }),
    ).toBe('sent');
    // A run every 10 minutes for just under 6 hours: all held.
    for (let i = 1; i < 36; i += 1) {
      vi.setSystemTime(T0 + i * 10 * 60_000 - 1);
      expect(await reportAlertJob('cron.security-alerts.cannot_call')).toBe('held');
    }
    expect(await reportAlertJob('cron.security-alerts.inputs_unreadable')).toBe('sent');
    vi.setSystemTime(T0 + ALERT_JOB_REPORT_GAP_MS);
    expect(await reportAlertJob('cron.security-alerts.cannot_call')).toBe('sent');
    expect(h.report.mock.calls.map(([, c]) => (c as { tag: string }).tag)).toEqual([
      'cron.security-alerts.cannot_call',
      'cron.security-alerts.inputs_unreadable',
      'cron.security-alerts.cannot_call',
    ]);
  });

  it('every tag but the one the database gates is held the same way', async () => {
    for (const tag of Object.keys(ALERT_JOB_REPORTS) as Array<keyof typeof ALERT_JOB_REPORTS>) {
      if (tag === 'cron.security-alerts.failing') continue;
      expect(await reportAlertJob(tag), tag).toBe('sent');
      expect(await reportAlertJob(tag), tag).toBe('held');
    }
  });

  it("the database's report_now is the authority for the failing report: sent when it says so, never otherwise", async () => {
    expect(
      await reportAlertJob('cron.security-alerts.failing', { counts: { failuresInARow: 3 } }),
    ).toBe('held');
    expect(
      await reportAlertJob('cron.security-alerts.failing', { counts: { failuresInARow: 3 } }, true),
    ).toBe('sent');
    // The database said it again (its own 6 hours passed on its clock): this instance does not overrule it.
    vi.setSystemTime(T0 + ALERT_JOB_REPORT_GAP_MS - 60_000);
    expect(
      await reportAlertJob(
        'cron.security-alerts.failing',
        { counts: { failuresInARow: 40 } },
        true,
      ),
    ).toBe('sent');
    expect(h.report).toHaveBeenCalledTimes(2);
    // Only that tag takes the database's word: another tag keeps its own gap.
    expect(await reportAlertJob('cron.security-alerts.unexpected', {}, true)).toBe('sent');
    expect(await reportAlertJob('cron.security-alerts.unexpected', {}, true)).toBe('held');
  });
});

describe('nothing but a fixed tag, counts and codes', () => {
  it("the message is the tag's fixed sentence; counts are whole numbers; codes are codes", async () => {
    await reportAlertJob('cron.security-alerts.unexpected', {
      counts: {
        claim_not_a_key: 2,
        negative: -1,
        fraction: 1.5,
        'Not a word': 3,
        huge: Number.MAX_SAFE_INTEGER + 2,
      },
      codes: {
        fn: 'platform_security_alert_claim',
        code: '55P03',
        text: 'duplicate key value violates unique constraint "x"',
        who: 'person@example.test',
        org: '0a0a0a0a-0000-4000-8000-00000000000a',
        where: alertWhereCode('open_states[12].subject'),
      },
    });
    expect(h.report).toHaveBeenCalledTimes(1);
    const [err, ctx] = h.report.mock.calls[0]!;
    expect((err as Error).message).toBe(
      ALERT_JOB_REPORTS['cron.security-alerts.unexpected'].message,
    );
    expect(ctx).toEqual({
      tag: 'cron.security-alerts.unexpected',
      level: 'warning',
      extra: {
        claim_not_a_key: 2,
        fn: 'platform_security_alert_claim',
        code: '55P03',
        text: 'not_a_code',
        who: 'not_a_code',
        org: 'not_a_code',
        where: 'open_states.subject',
      },
    });
  });

  it('at most 24 keys', async () => {
    const counts = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, i]));
    await reportAlertJob('cron.security-alerts.unexpected', { counts });
    const [, ctx] = h.report.mock.calls[0]!;
    expect(Object.keys((ctx as { extra: object }).extra)).toHaveLength(24);
  });

  it('a place in an answer becomes a code: no index, no free text', () => {
    expect(alertWhereCode('serious[3].event_key')).toBe('serious.event_key');
    expect(alertWhereCode('buckets (a bucket twice)')).toBe('buckets_a_bucket_twice');
    expect(alertWhereCode('')).toBe('not_a_code');
  });

  it('a reporter that throws is dropped: never a throw', async () => {
    h.report.mockRejectedValueOnce(new Error('webhook down'));
    await expect(reportAlertJob('cron.security-alerts.channel_on')).resolves.toBe('sent');
  });
});
