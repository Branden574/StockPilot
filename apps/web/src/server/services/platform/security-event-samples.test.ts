// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SECURITY_EVENT_SAMPLES_FAILED } from '@stockpilot/core';

/**
 * "What was asked for" on the platform console: the read (service client).
 *
 * Security invariant. Pinned: one call of platform_security_event_samples
 * with the service client and its own time budget, with the read's highest
 * limit; one kind and one whole UTC hour within 7 days (the hour running now
 * with no end), or every kind in the last 24 hours; every argument checked
 * again here, and a bad one reads nothing; the function missing (42883,
 * PGRST202), the database's cancel (57014), a refused privilege (42501), any
 * other error, a network failure, a refused window and an answer this build
 * does not know (a key too many or missing, a list past its cap, a path or
 * query string the table's own rules refuse) are "could not check", reported
 * once with a code and no value from the answer, never an empty list; what
 * is handed back is exactly core's view (no organization, no row times, none
 * of the table's totals). Made-up paths only.
 */

const NOW = Date.parse('2026-11-24T10:15:05Z');

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  signals: [] as AbortSignal[],
  reportError: vi.fn(async (..._a: unknown[]) => undefined),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/error-reporter', () => ({ reportError: h.reportError }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    rpc: (...args: unknown[]) => {
      const builder = {
        abortSignal(signal: AbortSignal) {
          h.signals.push(signal);
          return builder;
        },
        then(ok?: (v: unknown) => unknown, bad?: (e: unknown) => unknown) {
          let answer: Promise<unknown>;
          try {
            answer = Promise.resolve(h.rpc(...args));
          } catch (e) {
            answer = Promise.reject(e);
          }
          return answer.then(ok, bad);
        },
      };
      return builder;
    },
  }),
}));

import {
  readPlatformSecurityEventSamples,
  securityEventSamplesArgs,
  SECURITY_EVENT_SAMPLES_READ_BUDGET_MS,
} from './security-event-samples';

const T = '2026-11-24T09:12:00+00:00';

const pair = (over: Record<string, unknown> = {}) => ({
  method: 'GET',
  sample: null,
  events: 3,
  last_seen_at: T,
  ...over,
});

const target = (over: Record<string, unknown> = {}) => ({
  reason: 'env_file',
  target: '/backup/.env',
  events: 5,
  first_seen_at: T,
  last_seen_at: T,
  samples: [pair(), pair({ method: 'POST', sample: 'debug=1', events: 2 })],
  samples_truncated: false,
  ...over,
});

/** The contract's answer (ten keys). */
const answer = (over: Record<string, unknown> = {}) => ({
  window: {
    from: '2026-11-24T09:00:00+00:00',
    to: '2026-11-24T10:00:00+00:00',
    asked_from: '2026-11-24T09:00:00+00:00',
  },
  window_shortened: false,
  refused: null,
  generated_at: '2026-11-24T10:15:05+00:00',
  oldest_hour: '2026-11-01T00:00:00+00:00',
  targets: [target()],
  targets_truncated: false,
  listed_targets: 1,
  listed_events: 5,
  more_than_listed: [{ reason: 'env_file', events: 40, hours: 1 }],
  ...over,
});

const ASK = { reason: 'env_file' as const, hour: '2026-11-24T09:00:00.000Z', country: null };

beforeEach(() => {
  h.rpc.mockReset();
  h.rpc.mockResolvedValue({ data: answer(), error: null });
  h.signals = [];
  h.reportError.mockClear();
});

describe('the call', () => {
  it('one kind and one past hour: that hour to the next, the kind, the highest limit', async () => {
    await readPlatformSecurityEventSamples(ASK, NOW);
    expect(h.rpc.mock.calls).toEqual([
      [
        'platform_security_event_samples',
        {
          p_from: '2026-11-24T09:00:00.000Z',
          p_to: '2026-11-24T10:00:00.000Z',
          p_reason: 'env_file',
          p_category: null,
          p_country: null,
          p_limit: 50,
        },
      ],
    ]);
    expect(h.signals).toHaveLength(1);
    expect(SECURITY_EVENT_SAMPLES_READ_BUDGET_MS).toBe(6000);
  });

  it('the hour running now: no end (the database counts up to now)', () => {
    expect(
      securityEventSamplesArgs({ ...ASK, hour: '2026-11-24T10:00:00.000Z' }, NOW),
    ).toMatchObject({ p_from: '2026-11-24T10:00:00.000Z', p_to: null });
  });

  it('a country, when the entry names one', () => {
    expect(securityEventSamplesArgs({ ...ASK, country: 'NL' }, NOW)).toMatchObject({
      p_country: 'NL',
    });
  });

  it('a card opened from the legend: every kind, the database’s own 24 hours', () => {
    expect(securityEventSamplesArgs({ reason: null, hour: null, country: null }, NOW)).toEqual({
      p_from: null,
      p_to: null,
      p_reason: null,
      p_category: null,
      p_country: null,
      p_limit: 50,
    });
  });

  it.each([
    ['a reason that is not a probe kind', { ...ASK, reason: 'wrong_password' as never }],
    ['an hour that is not whole', { ...ASK, hour: '2026-11-24T09:30:00.000Z' }],
    ['an hour after the hour running now', { ...ASK, hour: '2026-11-24T11:00:00.000Z' }],
    ['an hour more than 7 days back', { ...ASK, hour: '2026-11-17T09:00:00.000Z' }],
    ['an hour that is not a time', { ...ASK, hour: 'yesterday' }],
    ['a country that is not two capitals', { ...ASK, country: 'nl' }],
  ])('%s reads nothing and is could not check', async (_what, ask) => {
    await expect(readPlatformSecurityEventSamples(ask, NOW)).resolves.toBe(
      SECURITY_EVENT_SAMPLES_FAILED,
    );
    expect(h.rpc).not.toHaveBeenCalled();
  });
});

describe('what leaves the server', () => {
  it('exactly the view: paths, counts, pairs, flags, overflow; no row times, no totals, no organization', async () => {
    const result = await readPlatformSecurityEventSamples({ ...ASK, country: 'NL' }, NOW);
    expect(result).toEqual({
      ok: true,
      view: {
        country: 'NL',
        windowFrom: null,
        targets: [
          {
            reason: 'env_file',
            target: '/backup/.env',
            events: 5,
            pairs: [
              { method: 'GET', sample: null, events: 3 },
              { method: 'POST', sample: 'debug=1', events: 2 },
            ],
            pairsTruncated: false,
          },
        ],
        targetsTruncated: false,
        listedTargets: 1,
        moreThanListed: [{ reason: 'env_file', events: 40, hours: 1 }],
      },
    });
    const text = JSON.stringify(result);
    for (const word of [
      'first_seen',
      'last_seen',
      'oldest_hour',
      'generated_at',
      'listed_events',
      T,
    ]) {
      expect(text.includes(word), word).toBe(false);
    }
  });

  it('a shortened window says where it was read from', async () => {
    h.rpc.mockResolvedValueOnce({
      data: answer({
        window_shortened: true,
        window: {
          from: '2026-11-20T03:00:00+00:00',
          to: '2026-11-24T10:00:00+00:00',
          asked_from: '2026-11-17T10:00:00+00:00',
        },
      }),
      error: null,
    });
    const result = await readPlatformSecurityEventSamples(
      { reason: null, hour: null, country: null },
      NOW,
    );
    expect(result).toMatchObject({ ok: true, view: { windowFrom: '2026-11-20T03:00:00.000Z' } });
  });

  it('nothing was asked for: an empty list, which only a read with no refusal can give', async () => {
    h.rpc.mockResolvedValueOnce({
      data: answer({ targets: [], listed_targets: 0, listed_events: 0, more_than_listed: [] }),
      error: null,
    });
    await expect(readPlatformSecurityEventSamples(ASK, NOW)).resolves.toMatchObject({
      ok: true,
      view: { targets: [], listedTargets: 0 },
    });
  });
});

describe('could not check, never an empty list', () => {
  it.each(['42883', 'PGRST202', '57014', '42501', 'XX000'])(
    'an error %s: reported once with its code only',
    async (code) => {
      h.rpc.mockResolvedValueOnce({ data: null, error: { code, message: 'made-up failure' } });
      await expect(readPlatformSecurityEventSamples(ASK, NOW)).resolves.toBe(
        SECURITY_EVENT_SAMPLES_FAILED,
      );
      expect(h.reportError).toHaveBeenCalledTimes(1);
      expect(h.reportError).toHaveBeenCalledWith(expect.any(Error), {
        tag: 'platform.security-event-samples.platform_security_event_samples',
        level: 'warning',
        extra: { code },
      });
    },
  );

  it('a call that throws or runs past its time', async () => {
    h.rpc.mockRejectedValueOnce(new Error('fetch failed'));
    await expect(readPlatformSecurityEventSamples(ASK, NOW)).resolves.toBe(
      SECURITY_EVENT_SAMPLES_FAILED,
    );
    const abort = new Error('The operation was aborted');
    abort.name = 'TimeoutError';
    h.rpc.mockRejectedValueOnce(abort);
    await expect(readPlatformSecurityEventSamples(ASK, NOW)).resolves.toBe(
      SECURITY_EVENT_SAMPLES_FAILED,
    );
    expect(h.reportError).toHaveBeenCalledTimes(2);
  });

  it.each([
    'not_a_time',
    'not_whole_hours',
    'to_in_the_future',
    'from_not_before_to',
    'longer_than_7_days',
    'not_a_reason',
    'not_a_category',
    'not_a_country',
    'too_many_rows_in_one_hour',
  ])('a refused window (%s)', async (word) => {
    h.rpc.mockResolvedValueOnce({
      data: { window: null, refused: word, generated_at: '2026-11-24T10:15:05+00:00' },
      error: null,
    });
    await expect(readPlatformSecurityEventSamples(ASK, NOW)).resolves.toBe(
      SECURITY_EVENT_SAMPLES_FAILED,
    );
    expect(h.reportError).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['no answer', null],
    ['a key too many', answer({ organization_id: 'x' })],
    ['a key missing', (({ oldest_hour: _o, ...rest }) => rest)(answer())],
    ['51 paths', answer({ targets: Array.from({ length: 51 }, () => target()) })],
    [
      'six pairs',
      answer({ targets: [target({ samples: Array.from({ length: 6 }, () => pair()) })] }),
    ],
    ['no pair', answer({ targets: [target({ samples: [] })] })],
    ['a path the table refuses', answer({ targets: [target({ target: '/someone@example.com' })] })],
    ['a path that is not one', answer({ targets: [target({ target: 'backup/.env' })] })],
    [
      'a query string the table refuses',
      answer({ targets: [target({ samples: [pair({ sample: 'n=1234567' })] })] }),
    ],
    [
      'a method outside the seven',
      answer({ targets: [target({ samples: [pair({ method: 'TRACE' })] })] }),
    ],
    ['a reason outside the six', answer({ targets: [target({ reason: 'wrong_password' })] })],
    ['a count of zero', answer({ targets: [target({ events: 0 })] })],
    ['a time with no offset', answer({ targets: [target({ last_seen_at: '2026-11-24 09:12' })] })],
    [
      'an overflow of a kind it does not know',
      answer({ more_than_listed: [{ reason: 'bots', events: 1, hours: 1 }] }),
    ],
  ])('%s', async (_what, data) => {
    h.rpc.mockResolvedValueOnce({ data, error: null });
    await expect(readPlatformSecurityEventSamples(ASK, NOW)).resolves.toBe(
      SECURITY_EVENT_SAMPLES_FAILED,
    );
    expect(h.reportError).toHaveBeenCalledTimes(1);
    // Where the shape differs, never a value from the answer.
    expect(JSON.stringify(h.reportError.mock.calls)).not.toMatch(/backup|someone|1234567|TRACE/);
  });

  it('a report that fails changes nothing', async () => {
    h.reportError.mockImplementationOnce(async () => {
      throw new Error('made-up failure');
    });
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: '57014', message: 'x' } });
    await expect(readPlatformSecurityEventSamples(ASK, NOW)).resolves.toBe(
      SECURITY_EVENT_SAMPLES_FAILED,
    );
  });
});
