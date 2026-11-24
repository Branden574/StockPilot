import { describe, expect, it } from 'vitest';

import {
  isSecurityEventSamplesCountry,
  isSecurityEventSamplesHour,
  readSecurityEventSamplesResult,
  readSecurityEventSamplesView,
  SECURITY_EVENT_SAMPLES_FAILED,
  SECURITY_EVENT_SAMPLES_REFUSED,
  SECURITY_EVENT_SAMPLES_WORDS,
  securityEventSamplesAskFor,
  securityEventSamplesHourOf,
  type SecurityEventSamplesView,
} from './security-event-samples';

/**
 * Security invariant: the browser's reader of "what was asked for" takes
 * exactly the view's keys, each of its kind, and every path and query string
 * in it passes the table's own text rules; anything else is "could not
 * check", never an empty list. The refusal is one fixed answer. Made-up paths
 * only.
 */

const view = (over: Partial<SecurityEventSamplesView> = {}): SecurityEventSamplesView => ({
  country: null,
  windowFrom: null,
  targets: [
    {
      reason: 'env_file',
      target: '/backup/.env',
      events: 12,
      pairs: [
        { method: 'GET', sample: null, events: 10 },
        { method: 'POST', sample: 'debug=1', events: 2 },
      ],
      pairsTruncated: false,
    },
  ],
  targetsTruncated: false,
  listedTargets: 1,
  moreThanListed: [{ reason: 'env_file', events: 40, hours: 1 }],
  ...over,
});

describe('readSecurityEventSamplesResult', () => {
  it('takes a well-formed view', () => {
    expect(readSecurityEventSamplesResult({ ok: true, view: view() })).toEqual({
      ok: true,
      view: view(),
    });
    expect(
      readSecurityEventSamplesResult({
        ok: true,
        view: view({ targets: [], listedTargets: 0, moreThanListed: [] }),
      }),
    ).toMatchObject({ ok: true });
  });

  it('the one refusal, and every failure as could not check', () => {
    expect(readSecurityEventSamplesResult({ ok: false, reason: 'refused' })).toBe(
      SECURITY_EVENT_SAMPLES_REFUSED,
    );
    for (const raw of [
      null,
      'x',
      [],
      { ok: false, reason: 'could_not_check' },
      { ok: false, reason: 'refused', why: 'no session' },
      { ok: true },
      { ok: true, view: null },
      { ok: true, view: view(), extra: 1 },
    ]) {
      expect(readSecurityEventSamplesResult(raw), JSON.stringify(raw)).toBe(
        SECURITY_EVENT_SAMPLES_FAILED,
      );
    }
  });

  it.each([
    ['a key it does not know', { ...view(), organization_id: 'x' }],
    ['a key missing', (({ windowFrom: _w, ...rest }) => rest)(view())],
    [
      'a target that is not a path',
      view({ targets: [{ ...view().targets[0]!, target: 'backup/.env' }] }),
    ],
    [
      'a target the table refuses',
      view({ targets: [{ ...view().targets[0]!, target: '/someone@example.com' }] }),
    ],
    [
      'a query string the table refuses',
      view({
        targets: [
          { ...view().targets[0]!, pairs: [{ method: 'GET', sample: 'id=1234567', events: 1 }] },
        ],
      }),
    ],
    [
      'an empty query string',
      view({
        targets: [{ ...view().targets[0]!, pairs: [{ method: 'GET', sample: '', events: 1 }] }],
      }),
    ],
    [
      'a method outside the seven',
      view({
        targets: [{ ...view().targets[0]!, pairs: [{ method: 'TRACE', sample: null, events: 1 }] }],
      }),
    ],
    [
      'a reason that is not a probe kind',
      view({ targets: [{ ...view().targets[0]!, reason: 'wrong_password' as never }] }),
    ],
    ['no pairs', view({ targets: [{ ...view().targets[0]!, pairs: [] }] })],
    [
      'six pairs',
      view({
        targets: [
          {
            ...view().targets[0]!,
            pairs: Array.from({ length: 6 }, () => ({ method: 'GET', sample: null, events: 1 })),
          },
        ],
      }),
    ],
    ['a count of zero', view({ targets: [{ ...view().targets[0]!, events: 0 }] })],
    ['a count that is not whole', view({ listedTargets: 1.5 })],
    ['51 targets', view({ targets: Array.from({ length: 51 }, () => view().targets[0]!) })],
    ['a country that is not two capitals', view({ country: 'nl' })],
    [
      'an overflow of a kind it does not know',
      view({ moreThanListed: [{ reason: 'bots' as never, events: 1, hours: 1 }] }),
    ],
    [
      'an overflow over 168 hours',
      view({ moreThanListed: [{ reason: 'env_file', events: 1, hours: 169 }] }),
    ],
    [
      'a pair with a key it does not know',
      view({
        targets: [
          {
            ...view().targets[0]!,
            pairs: [{ method: 'GET', sample: null, events: 1, last_seen_at: 'x' } as never],
          },
        ],
      }),
    ],
  ])('%s is could not check', (_what, bad) => {
    expect(readSecurityEventSamplesView(bad)).toBeNull();
    expect(readSecurityEventSamplesResult({ ok: true, view: bad })).toBe(
      SECURITY_EVENT_SAMPLES_FAILED,
    );
  });

  it('a script-shaped and a javascript:-shaped path are data like any other', () => {
    const odd = view({
      targets: [
        { ...view().targets[0]!, target: '/<script>alert(1)</script>/.env' },
        {
          ...view().targets[0]!,
          target: '/javascript:void(0)/.env',
          pairs: [{ method: 'GET', sample: 'x=<img src=x>', events: 1 }],
        },
      ],
    });
    expect(readSecurityEventSamplesView(odd)).toEqual(odd);
  });
});

describe('the hour an entry asks about', () => {
  const now = Date.parse('2026-11-24T10:15:05Z');
  it('is the UTC hour its instant falls in', () => {
    expect(securityEventSamplesHourOf(Date.parse('2026-11-24T09:59:59.999Z'))).toBe(
      '2026-11-24T09:00:00.000Z',
    );
    expect(securityEventSamplesHourOf(Date.parse('2026-11-24T10:00:00Z'))).toBe(
      '2026-11-24T10:00:00.000Z',
    );
    expect(securityEventSamplesHourOf(Number.NaN)).toBeNull();
    expect(securityEventSamplesHourOf('2026-11-24T10:00:00Z')).toBeNull();
  });
  it('a whole UTC hour, not after the hour running now, at most 168 hours before it', () => {
    expect(isSecurityEventSamplesHour('2026-11-24T10:00:00.000Z', now)).toBe(true);
    expect(isSecurityEventSamplesHour('2026-11-24T10:00:00Z', now)).toBe(true);
    expect(isSecurityEventSamplesHour('2026-11-17T10:00:00.000Z', now)).toBe(true);
    for (const bad of [
      '2026-11-24T11:00:00.000Z',
      '2026-11-17T09:00:00.000Z',
      '2026-11-24T10:30:00.000Z',
      '2026-11-24T10:00:01.000Z',
      '2026-11-24T10:00:00+01:00',
      '2026-11-24',
      '',
      null,
      1764000000000,
    ]) {
      expect(isSecurityEventSamplesHour(bad, now), String(bad)).toBe(false);
    }
  });
  it('a country is two capitals', () => {
    expect(isSecurityEventSamplesCountry('NL')).toBe(true);
    for (const bad of ['nl', 'NLD', '', null, 1])
      expect(isSecurityEventSamplesCountry(bad)).toBe(false);
  });
});

describe('what an entry asks for', () => {
  const now = Date.parse('2026-11-24T10:15:05Z');
  it("an entry's kind, the UTC hour of its instant, and its country", () => {
    expect(
      securityEventSamplesAskFor(
        { reason: 'git_dir', at: Date.parse('2026-11-24T09:42:00Z'), country: 'NL' },
        now,
      ),
    ).toEqual({
      ok: true,
      ask: { reason: 'git_dir', hour: '2026-11-24T09:00:00.000Z', country: 'NL' },
    });
  });
  it('a card opened from the legend: every kind, the last 24 hours', () => {
    expect(securityEventSamplesAskFor({ reason: null, at: null, country: null }, now)).toEqual({
      ok: true,
      ask: { reason: null, hour: null, country: null },
    });
  });
  it('the hour 7 days back is read; one older is too old, and nothing is asked', () => {
    expect(
      securityEventSamplesAskFor(
        { reason: 'env_file', at: Date.parse('2026-11-17T10:59:59Z'), country: null },
        now,
      ),
    ).toMatchObject({ ok: true });
    expect(
      securityEventSamplesAskFor(
        { reason: 'env_file', at: Date.parse('2026-11-17T09:59:59Z'), country: null },
        now,
      ),
    ).toEqual({ ok: false, why: 'too_old' });
  });
  it("an hour after the browser's own is still asked: the server's clock decides", () => {
    expect(
      securityEventSamplesAskFor(
        { reason: 'env_file', at: Date.parse('2026-11-24T11:01:00Z'), country: null },
        now,
      ),
    ).toMatchObject({ ok: true, ask: { hour: '2026-11-24T11:00:00.000Z' } });
  });
  it('a kind that is not a probe kind, or no instant, reads nothing', () => {
    expect(
      securityEventSamplesAskFor({ reason: 'wrong_password', at: now, country: null }, now),
    ).toEqual({ ok: false, why: 'not_readable' });
    expect(
      securityEventSamplesAskFor({ reason: 'env_file', at: Number.NaN, country: null }, now),
    ).toEqual({ ok: false, why: 'not_readable' });
  });
  it('a country that is not two capitals reads every country', () => {
    expect(
      securityEventSamplesAskFor({ reason: 'env_file', at: now, country: 'nl' }, now),
    ).toMatchObject({ ok: true, ask: { country: null } });
  });
});

describe('the words', () => {
  const W = SECURITY_EVENT_SAMPLES_WORDS;
  it("the contract's overflow line, with its hours and the country filter", () => {
    expect(W.overflow({ events: 40, hours: 1 }, false)).toBe(
      '40 more requests of this kind were counted but not listed. Each hour lists only the first 50 different requests of a kind (a path with one method, one query string and one country); one path asked many ways can use them all.',
    );
    expect(W.overflow({ events: 1200, hours: 3 }, true, 'Request for a settings file')).toBe(
      'Request for a settings file: 1,200 more requests of this kind were counted but not listed in 3 hours (all countries). Each hour lists only the first 50 different requests of a kind (a path with one method, one query string and one country); one path asked many ways can use them all.',
    );
  });
  it('the fixed line and the empty line, as the brief has them', () => {
    // Review 3B S7: the line says the text is the sender's, and "the path",
    // never "the address" (the cards' word for a network address).
    expect(W.removed).toBe(
      "Only the path and the query string of a request the site refused. A request body is never kept. Anything that looked like an email address, an id, a long value, a secret or a parameter the site's own routing uses was removed. The text shown is what the sender of the request typed, not something StockPilot wrote or ran. Do not visit, call or write to anything it names.",
    );
    expect(W.removed).not.toMatch(/\baddress and\b/);
    expect(W.none).toBe('No sample was kept for this entry.');
    expect(W.title).toBe('What was asked for');
    expect(W.sent).toBe('What was sent');
    expect(W.pairsTruncated).toBe('More variations were asked for than are shown.');
  });
  it('counts', () => {
    expect(W.requests(1)).toBe('1 request');
    expect(W.requests(1234)).toBe('1,234 requests');
    expect(W.showAll(12)).toBe('Show all 12');
    expect(W.targetsTruncated(120, 50)).toBe(
      '120 paths were asked for; the 50 asked for most are listed.',
    );
  });
});
