import { afterEach, describe, expect, it } from 'vitest';

import { restoreIntl, useHermesLikeIntl } from './__fixtures__/hermes-like-intl';
import {
  ORG_TIMEZONE_DEFAULT,
  formatOrgDateTime,
  resolveOrgTimezone,
  startOfOrgDay,
} from './org-timezone';

/**
 * `resolveOrgTimezone` — the ONE answer to "what zone do we print when the
 * org's zone did not arrive".
 *
 * It exists because there were two answers. Web's `getCachedOrgTimezone`
 * returned a hardcoded 'UTC'; mobile's delivery-request mapping used
 * ORG_TIMEZONE_DEFAULT. One order therefore stated two different needed-by
 * times in mail to the same warehouse. These tests pin the rule and, more
 * importantly, pin the CONSEQUENCE the divergence had — the calendar-day flip —
 * so that a future change to the default has to look at what it costs.
 */
describe('resolveOrgTimezone', () => {
  it('returns a real stored zone untouched — including a deliberately-stored UTC', () => {
    // organizations.timezone is NOT NULL DEFAULT 'UTC', so 'UTC' is a value an
    // org genuinely holds, never a signal that the setting is unset. Resolving
    // it to Pacific would silently relabel every such org's times.
    expect(resolveOrgTimezone('UTC')).toBe('UTC');
    expect(resolveOrgTimezone('America/New_York')).toBe('America/New_York');
    expect(resolveOrgTimezone('America/Los_Angeles')).toBe('America/Los_Angeles');
  });

  it('falls back to the documented default for every shape of "did not arrive"', () => {
    expect(resolveOrgTimezone(null)).toBe(ORG_TIMEZONE_DEFAULT);
    expect(resolveOrgTimezone(undefined)).toBe(ORG_TIMEZONE_DEFAULT);
    expect(resolveOrgTimezone('')).toBe(ORG_TIMEZONE_DEFAULT);
  });

  it('treats whitespace as absent, because a blank zone makes Intl THROW rather than degrade', () => {
    expect(resolveOrgTimezone('   ')).toBe(ORG_TIMEZONE_DEFAULT);
    // The failure this prevents, demonstrated rather than asserted from memory.
    expect(() => new Date(0).toLocaleString('en-US', { timeZone: '   ' })).toThrow(RangeError);
    expect(() => formatOrgDateTime(0, {}, resolveOrgTimezone('   '))).not.toThrow();
  });

  it('the default is Pacific, not UTC — and never returns null or an empty string', () => {
    expect(ORG_TIMEZONE_DEFAULT).toBe('America/Los_Angeles');
    for (const raw of [null, undefined, '', '  ']) {
      const resolved = resolveOrgTimezone(raw);
      expect(resolved).toBe('America/Los_Angeles');
      expect(resolved.length).toBeGreaterThan(0);
    }
  });

  it('THE COST OF DISAGREEING: the two old defaults name a different CALENDAR DAY, not just a different clock', () => {
    // A needed-by of 6pm Pacific on Aug 18. The order is the same; only the
    // zone the surface picked differs.
    const instant = new Date('2026-08-19T01:00:00.000Z');
    const pacific = formatOrgDateTime(instant, { dateStyle: 'medium' }, resolveOrgTimezone(null));
    const utcTheOldWebFallback = formatOrgDateTime(instant, { dateStyle: 'medium' }, 'UTC');

    expect(pacific).toContain('Aug 18');
    expect(utcTheOldWebFallback).toContain('Aug 19');
    expect(pacific).not.toBe(utcTheOldWebFallback);
  });

  it('is idempotent, so a surface that resolves early cannot be re-defaulted into a different zone', () => {
    // The order/new page relies on this: it takes an already-resolved value and
    // must not apply a second `|| ORG_TIMEZONE_DEFAULT` of its own.
    for (const raw of ['UTC', 'America/New_York', '', null]) {
      expect(resolveOrgTimezone(resolveOrgTimezone(raw))).toBe(resolveOrgTimezone(raw));
    }
  });
});

describe('resolveOrgTimezone — a stored zone must never take a screen down', () => {
  it('passes through a zone this runtime recognises', () => {
    expect(resolveOrgTimezone('America/New_York')).toBe('America/New_York');
    expect(resolveOrgTimezone('UTC')).toBe('UTC');
  });

  it('falls back for a zone that does not exist, instead of throwing', () => {
    // 'America/Fresno' is the real shape of this bug: a plausible-looking
    // string a human would type into a settings field. Before this, it threw
    // RangeError out of formatOrgDateTime — and that call sits inside a
    // React.useMemo on the native order screen, so one bad organizations row
    // took the whole screen white rather than mis-formatting one line.
    expect(resolveOrgTimezone('America/Fresno')).toBe(ORG_TIMEZONE_DEFAULT);
    expect(resolveOrgTimezone('Not/AZone')).toBe(ORG_TIMEZONE_DEFAULT);
    expect(resolveOrgTimezone('')).toBe(ORG_TIMEZONE_DEFAULT);
    expect(resolveOrgTimezone(null)).toBe(ORG_TIMEZONE_DEFAULT);
    expect(resolveOrgTimezone(undefined)).toBe(ORG_TIMEZONE_DEFAULT);
  });

  it('formatOrgDateTime does not throw on any of them', () => {
    for (const tz of ['America/Fresno', 'Not/AZone', '', 'Etc/Nope']) {
      expect(() =>
        formatOrgDateTime('2026-08-18T09:00', { dateStyle: 'medium' }, tz),
      ).not.toThrow();
    }
  });

  it('the fallback formats in the DEFAULT zone, not in the rejected one', () => {
    // Proof the fallback is real arithmetic rather than a swallowed error: the
    // bad-zone result must equal the default-zone result for the same instant.
    const instant = '2026-08-18T16:00:00.000Z';
    const opts = { dateStyle: 'medium', timeStyle: 'short' } as const;
    expect(formatOrgDateTime(instant, opts, 'America/Fresno')).toBe(
      formatOrgDateTime(instant, opts, ORG_TIMEZONE_DEFAULT),
    );
    // ...and is genuinely different from another real zone, so the assertion
    // above is not passing because everything renders the same.
    expect(formatOrgDateTime(instant, opts, 'America/New_York')).not.toBe(
      formatOrgDateTime(instant, opts, ORG_TIMEZONE_DEFAULT),
    );
  });
});

describe('startOfOrgDay', () => {
  it('returns local midnight in the org zone, as a UTC instant', () => {
    // 2026-09-23 10:00 UTC is 03:00 PDT (UTC-7): the LA day began 07:00 UTC.
    expect(startOfOrgDay(new Date('2026-09-23T10:00:00Z'), 'America/Los_Angeles').toISOString()).toBe(
      '2026-09-23T07:00:00.000Z',
    );
    // 2026-09-23 03:00 UTC is still Sep 22 in LA (20:00 PDT).
    expect(startOfOrgDay(new Date('2026-09-23T03:00:00Z'), 'America/Los_Angeles').toISOString()).toBe(
      '2026-09-22T07:00:00.000Z',
    );
  });

  it('handles days that start in standard time and days next to a DST change', () => {
    // Winter: PST is UTC-8.
    expect(startOfOrgDay(new Date('2026-01-15T20:00:00Z'), 'America/Los_Angeles').toISOString()).toBe(
      '2026-01-15T08:00:00.000Z',
    );
    // 2026-03-08 is the US spring-forward day; its midnight is still PST.
    expect(startOfOrgDay(new Date('2026-03-08T20:00:00Z'), 'America/Los_Angeles').toISOString()).toBe(
      '2026-03-08T08:00:00.000Z',
    );
    // 2026-11-01 is the fall-back day; its midnight is still PDT.
    expect(startOfOrgDay(new Date('2026-11-01T20:00:00Z'), 'America/Los_Angeles').toISOString()).toBe(
      '2026-11-01T07:00:00.000Z',
    );
  });

  it('works east of UTC and for UTC itself, and falls back on a bad zone', () => {
    expect(startOfOrgDay(new Date('2026-09-23T20:00:00Z'), 'Asia/Tokyo').toISOString()).toBe(
      '2026-09-23T15:00:00.000Z',
    );
    expect(startOfOrgDay(new Date('2026-09-23T20:00:00Z'), 'UTC').toISOString()).toBe(
      '2026-09-23T00:00:00.000Z',
    );
    expect(startOfOrgDay(new Date('2026-09-23T10:00:00Z'), 'Not/AZone').toISOString()).toBe(
      '2026-09-23T07:00:00.000Z',
    );
  });
});

describe('startOfOrgDay where midnight does not exist', () => {
  it('starts the day at the first real instant when clocks spring forward at midnight', () => {
    // 2026-09-06: Santiago moves 00:00 -> 01:00 (UTC-4 -> UTC-3). The day
    // begins at 01:00 local = 04:00 UTC, never on the evening before.
    expect(startOfOrgDay(new Date('2026-09-06T15:00:00Z'), 'America/Santiago').toISOString()).toBe(
      '2026-09-06T04:00:00.000Z',
    );
  });

  it('agrees with a brute-force search on every day of 2026, in zones that change clocks', () => {
    const zones = [
      'America/Los_Angeles', 'America/Santiago', 'America/Havana', 'America/Asuncion',
      'Australia/Lord_Howe', 'Pacific/Chatham', 'Asia/Kolkata', 'Europe/London',
    ];
    for (const z of zones) {
      const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: z, year: 'numeric', month: '2-digit', day: '2-digit' });
      const localDay = (ms: number) => fmt.format(new Date(ms));
      for (let t = Date.UTC(2026, 0, 1, 15); t < Date.UTC(2027, 0, 1); t += 86_400_000) {
        const today = localDay(t);
        // The true start: the earliest minute whose local date is today's.
        // Local dates only move forward, so a binary search over minutes finds it.
        let lo = Math.floor((t - 36 * 3_600_000) / 60_000);
        let hi = Math.floor(t / 60_000);
        while (lo < hi) {
          const mid = Math.floor((lo + hi) / 2);
          if (localDay(mid * 60_000) < today) lo = mid + 1;
          else hi = mid;
        }
        const truth = new Date(lo * 60_000).toISOString();
        const got = startOfOrgDay(new Date(t), z).toISOString();
        if (got !== truth) expect({ z, day: today, got }).toEqual({ z, day: today, got: truth });
      }
    }
  });
});

/**
 * ONE SPELLING OF AN ORG TIME, ON EVERY ENGINE.
 *
 * formatOrgDateTime was `toLocaleString`, which joins a date and a time with
 * its own engine's pattern: "Sep 27, 4:32 PM" on the web (V8), "Sep 27 at
 * 4:32 PM" with a narrow no-break space before PM on the phone (Hermes on
 * iOS). The simulator walk of 2026-09-27 found the verification card's
 * "Checked at" line reading two ways (web occurrence-display.tsx exceptionTime
 * and phone exceptions-api.ts exceptionTimeLabel both call this with the same
 * options). The stand-in is the Hermes the rentals fix measured
 * (__fixtures__/hermes-like-intl.ts).
 */
describe('formatOrgDateTime: the same words on the web and the phone', () => {
  afterEach(() => {
    restoreIntl();
  });

  // Sun Sep 27 2026, 4:32:05 PM PDT.
  const AT = '2026-09-27T23:32:05.000Z';
  const PT = 'America/Los_Angeles';

  it('"Checked at": the web words on a Hermes-like engine (simulator walk 2026-09-27)', () => {
    const opts = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' } as const;
    expect(formatOrgDateTime(AT, opts, PT)).toBe('Sep 27, 4:32 PM');
    useHermesLikeIntl();
    // The stand-in is the engine that printed the phone's words.
    expect(new Date(AT).toLocaleString('en-US', { ...opts, timeZone: PT })).toBe(
      'Sep 27 at 4:32\u202fPM',
    );
    expect(formatOrgDateTime(AT, opts, PT)).toBe('Sep 27, 4:32 PM');
  });

  // Every option shape a caller passes today. The web's words must not change,
  // and the phone must print exactly them.
  const CALLERS: Array<[string, Intl.DateTimeFormatOptions, string]> = [
    [
      'exception times (web exceptionTime, phone exceptionTimeLabel, capture copy)',
      { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
      'Sep 27, 4:32 PM',
    ],
    [
      'cycle counts, PO imports, order needed-by, delivery request, phone count list',
      { dateStyle: 'medium', timeStyle: 'short' },
      'Sep 27, 2026, 4:32 PM',
    ],
    [
      'maintenance request submitted email',
      { dateStyle: 'long', timeStyle: 'short' },
      'September 27, 2026 at 4:32 PM',
    ],
    [
      'maintenance resolved email',
      {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
      },
      'Sep 27, 2026, 4:32 PM PDT',
    ],
    [
      'rental times with the year (the no-parts fallback)',
      { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' },
      'Sep 27, 2026, 4:32 PM',
    ],
    [
      'verification count date',
      { month: 'short', day: 'numeric', year: 'numeric' },
      'Sep 27, 2026',
    ],
    ['verification capture time', { hour: 'numeric', minute: '2-digit' }, '4:32 PM'],
    ['open since', { month: 'short', day: 'numeric' }, 'Sep 27'],
    ['a date style alone', { dateStyle: 'medium' }, 'Sep 27, 2026'],
    ['no options (the engine default)', {}, '9/27/2026, 4:32:05 PM'],
  ];

  it.each(CALLERS)(
    '%s: the web words are unchanged, and the phone prints them',
    (_, opts, words) => {
      const web = formatOrgDateTime(AT, opts, PT);
      expect(web).toBe(words);
      // What this engine (the web's) printed before: toLocaleString itself.
      expect(web).toBe(new Date(AT).toLocaleString('en-US', { timeZone: PT, ...opts }));
      useHermesLikeIntl();
      const phone = formatOrgDateTime(AT, opts, PT);
      expect(phone).toBe(words);
      expect(phone).not.toMatch(/[\u202f\u00a0]/);
    },
  );

  // The web's words must not move for any shape a future caller might pass:
  // on this engine the new formatter reads exactly as toLocaleString did.
  it('on this engine, every date-and-time shape reads as toLocaleString did', () => {
    const plain = (s: string) => s.replace(/[\u202f\u00a0]/g, ' ');
    const instants = [new Date(AT), new Date('2026-01-03T08:05:00.000Z')];
    const shapes: Intl.DateTimeFormatOptions[] = [];
    for (const weekday of [undefined, 'short', 'long'] as const)
      for (const year of [undefined, 'numeric'] as const)
        for (const month of [undefined, 'numeric', 'short', 'long'] as const)
          for (const day of [undefined, 'numeric'] as const)
            for (const hour of [undefined, 'numeric', '2-digit'] as const)
              for (const minute of [undefined, '2-digit'] as const)
                for (const second of [undefined, '2-digit'] as const)
                  for (const timeZoneName of [undefined, 'short'] as const)
                    for (const hour12 of [undefined, false] as const) {
                      const o: Intl.DateTimeFormatOptions = {};
                      if (weekday) o.weekday = weekday;
                      if (year) o.year = year;
                      if (month) o.month = month;
                      if (day) o.day = day;
                      if (hour) o.hour = hour;
                      if (minute) o.minute = minute;
                      if (second) o.second = second;
                      if (timeZoneName) o.timeZoneName = timeZoneName;
                      if (hour12 !== undefined) o.hour12 = hour12;
                      shapes.push(o);
                    }
    for (const dateStyle of [undefined, 'full', 'long', 'medium', 'short'] as const)
      for (const timeStyle of [undefined, 'full', 'long', 'medium', 'short'] as const) {
        if (dateStyle || timeStyle) shapes.push({ dateStyle, timeStyle });
      }
    const mismatches: string[] = [];
    for (const o of shapes) {
      for (const d of instants) {
        for (const tz of [PT, 'Asia/Tokyo']) {
          const want = plain(d.toLocaleString('en-US', { timeZone: tz, ...o }));
          const got = formatOrgDateTime(d, o, tz);
          if (got !== want) mismatches.push(`${JSON.stringify(o)} ${tz}: ${got} != ${want}`);
        }
      }
    }
    expect(shapes.length).toBeGreaterThan(1000);
    expect(mismatches).toEqual([]);
  });

  it('a long month joins with " at " on both engines, as the web always has', () => {
    const opts = { month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' } as const;
    expect(formatOrgDateTime(AT, opts, PT)).toBe('September 27 at 4:32 PM');
    useHermesLikeIntl();
    expect(formatOrgDateTime(AT, opts, PT)).toBe('September 27 at 4:32 PM');
  });

  it("with no Intl formatter at all, the engine's own words with plain spaces, never nothing", () => {
    useHermesLikeIntl(
      class {
        constructor() {
          throw new RangeError('Intl.DateTimeFormat is not supported');
        }
      },
    );
    const printed = formatOrgDateTime(
      AT,
      { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
      PT,
    );
    expect(printed).toBe('Sep 27 at 4:32 PM');
    expect(printed).not.toMatch(/[\u202f\u00a0]/);
  });

  it('a bad value is still an em dash, and a bad zone still degrades', () => {
    expect(formatOrgDateTime('garbage', { dateStyle: 'medium', timeStyle: 'short' }, PT)).toBe('—');
    useHermesLikeIntl();
    expect(
      formatOrgDateTime(AT, { dateStyle: 'medium', timeStyle: 'short' }, 'America/Fresno'),
    ).toBe('Sep 27, 2026, 4:32 PM');
  });
});
