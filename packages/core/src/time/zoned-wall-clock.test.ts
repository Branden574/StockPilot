import { afterEach, describe, expect, it } from 'vitest';

import { restoreIntl, useHermesLikeIntl } from './__fixtures__/hermes-like-intl';
import { startOfOrgDay } from './org-timezone';
import {
  formatWallClock,
  parseWallClock,
  wallClockString,
  wallClockToInstant,
  zonedParts,
  zoneOffsetMs,
} from './zoned-wall-clock';

const LA = 'America/Los_Angeles';
const NY = 'America/New_York';
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

describe('wallClockToInstant: SP-047 cases (moved with the arithmetic from the suggest action)', () => {
  it('reads a winter wall clock in New York as EST, never a fixed -07:00', () => {
    // 13:00 EST (UTC-5) = 18:00Z. SP-047's old "-07:00" gave 20:00Z.
    expect(iso(wallClockToInstant('2027-01-15T13:00', NY))).toBe('2027-01-15T18:00:00.000Z');
  });

  it('uses standard time in winter for Los Angeles (13:00 PST = 21:00Z, not 20:00Z)', () => {
    expect(iso(wallClockToInstant('2027-01-15T13:00', LA))).toBe('2027-01-15T21:00:00.000Z');
  });

  it('uses daylight time in summer for Los Angeles (13:00 PDT = 20:00Z)', () => {
    expect(iso(wallClockToInstant('2027-07-15T13:00', LA))).toBe('2027-07-15T20:00:00.000Z');
  });

  it('reads a date-only answer at the hour the caller names, never UTC midnight', () => {
    const w = parseWallClock('2027-01-15', { dateOnlyHour: 9 });
    expect(w).toEqual({ year: 2027, month: 1, day: 15, hour: 9, minute: 0 });
    expect(iso(wallClockToInstant(w!, NY))).toBe('2027-01-15T14:00:00.000Z');
  });
});

describe('wallClockToInstant across the 2026-11-01 fall-back in Los Angeles', () => {
  it('the day before is PDT (UTC-7)', () => {
    expect(iso(wallClockToInstant('2026-10-31T14:00', LA))).toBe('2026-10-31T21:00:00.000Z');
  });

  it('the day after is PST (UTC-8)', () => {
    expect(iso(wallClockToInstant('2026-11-02T14:00', LA))).toBe('2026-11-02T22:00:00.000Z');
  });

  it('the repeated hour (01:30 happens twice) resolves to its first occurrence, 01:30 PDT', () => {
    expect(iso(wallClockToInstant('2026-11-01T01:30', LA))).toBe('2026-11-01T08:30:00.000Z');
  });

  it('east of UTC (and at UTC+0 in London) the repeated hour resolves to its SECOND occurrence', () => {
    // The two-pass guess lands on the earlier occurrence west of UTC and the
    // later one east of it. Either is a real instant for that wall clock; the
    // service keeps the stored instant when the wall clock sent equals the
    // stored one's, so re-saving an unedited date never shifts it.
    expect(iso(wallClockToInstant('2027-04-04T02:30', 'Pacific/Auckland'))).toBe('2027-04-03T14:30:00.000Z'); // NZST
    expect(iso(wallClockToInstant('2027-04-04T02:30', 'Australia/Sydney'))).toBe('2027-04-03T16:30:00.000Z'); // AEST
    expect(iso(wallClockToInstant('2026-10-25T01:30', 'Europe/London'))).toBe('2026-10-25T01:30:00.000Z'); // GMT
    expect(iso(wallClockToInstant('2026-11-01T00:30', 'America/St_Johns'))).toBe('2026-11-01T03:00:00.000Z'); // NDT, first
  });

  it('after the change the same morning is PST', () => {
    expect(iso(wallClockToInstant('2026-11-01T03:00', LA))).toBe('2026-11-01T11:00:00.000Z');
  });

  it('round-trips every half hour of the week around the change', () => {
    for (let d = 29; d <= 31 + 4; d += 1) {
      const month = d > 31 ? 11 : 10;
      const day = d > 31 ? d - 31 : d;
      for (let h = 0; h < 24; h += 1) {
        for (const minute of [0, 30]) {
          const wall = { year: 2026, month, day, hour: h, minute };
          const t = wallClockToInstant(wall, LA);
          expect(t, wallClockString(wall)).not.toBeNull();
          expect(formatWallClock(t!, LA)).toBe(wallClockString(wall));
        }
      }
    }
  });
});

describe('wallClockToInstant refuses a wall clock that never happens (strict)', () => {
  it('the spring-forward gap (02:30 on 2027-03-14 in Los Angeles)', () => {
    expect(wallClockToInstant('2027-03-14T02:30', LA)).toBeNull();
    // SP-047's lenient arithmetic is still there for the suggestion: an hour early.
    expect(iso(wallClockToInstant('2027-03-14T02:30', LA, { strict: false }))).toBe(
      '2027-03-14T09:30:00.000Z',
    );
  });

  it('a date or time that does not exist', () => {
    expect(wallClockToInstant('2026-02-30T10:00', LA)).toBeNull();
    expect(wallClockToInstant('2026-10-03T24:00', LA)).toBeNull();
    expect(wallClockToInstant('2026-10-03T10:60', LA)).toBeNull();
    expect(wallClockToInstant('2026-13-01T10:00', LA)).toBeNull();
  });

  it('anything that is not a wall clock, a zoned instant included', () => {
    for (const raw of ['', 'soon', '2026-10-03', '2026-10-03T14:00Z', '2026-10-03T14:00-07:00', '10/3/2026 2pm']) {
      expect(wallClockToInstant(raw, LA), raw).toBeNull();
    }
  });

  it('tolerates seconds and a space separator', () => {
    expect(iso(wallClockToInstant('2026-10-03 14:00:59.5', LA))).toBe('2026-10-03T21:00:00.000Z');
  });
});

describe('the conversion never uses the device zone', () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('answers the same whatever zone the process runs in (mutation: new Date(y, m, d, h, mi))', () => {
    const answers = new Set<string | null>();
    for (const tz of ['UTC', 'Pacific/Auckland', 'Asia/Kolkata', 'America/Los_Angeles']) {
      process.env.TZ = tz;
      answers.add(iso(wallClockToInstant('2026-11-01T14:00', NY)));
      answers.add(formatWallClock(Date.parse('2026-11-01T19:00:00Z'), NY));
    }
    expect([...answers].sort()).toEqual(['2026-11-01T14:00', '2026-11-01T19:00:00.000Z']);
  });
});

/**
 * THE PHONE. Hermes on iOS types only the DATE fields of a formatter that
 * carries both a date and a time: from the joining " at " on, the hour, minute
 * and second come back as untyped literals (measured 2026-09-26, the stand-in
 * is __fixtures__/hermes-like-intl.ts). One combined formatter therefore read
 * every time on the phone as 00:00:00, and every offset, conversion and org
 * midnight built on it was wrong there, silently. The F2-4 phone sheet builds
 * its day chips and time slots from these helpers, so the date and the time
 * are read from two formatters (the rentals fix's rule, rentals/emails.ts).
 */
describe('on a Hermes-like engine (the phone), the same answers as on the web', () => {
  afterEach(() => {
    restoreIntl();
  });

  const INSTANTS = [
    '2026-09-29T17:05:09.000Z',
    '2026-11-01T08:30:00.000Z', // 01:30 PDT, the first of the repeated hour
    '2026-11-01T09:30:00.000Z', // 01:30 PST, the second
    '2026-12-31T23:59:59.000Z',
    '2027-03-14T10:00:00.000Z', // 03:00 PDT, just after the spring-forward gap
  ];

  it('zonedParts, zoneOffsetMs, formatWallClock and wallClockToInstant (mutation: one combined formatter)', () => {
    const answers = () =>
      INSTANTS.flatMap((at) => {
        const ms = Date.parse(at);
        return [
          JSON.stringify(zonedParts(ms, LA)),
          zoneOffsetMs(ms, NY),
          formatWallClock(ms, 'Asia/Kolkata'),
          iso(wallClockToInstant(formatWallClock(ms, LA), LA)),
        ];
      });
    const web = answers();
    useHermesLikeIntl();
    expect(answers()).toEqual(web);
  });

  it('startOfOrgDay (it reads the same parts)', () => {
    const web = startOfOrgDay(new Date('2026-11-01T20:00:00Z'), LA).toISOString();
    expect(web).toBe('2026-11-01T07:00:00.000Z');
    useHermesLikeIntl();
    expect(startOfOrgDay(new Date('2026-11-01T20:00:00Z'), LA).toISOString()).toBe(web);
  });
});

describe('zonedParts and zoneOffsetMs', () => {
  it('reads midnight as hour 0, never 24', () => {
    expect(zonedParts(Date.parse('2026-10-03T07:00:00Z'), LA)).toEqual({
      year: 2026, month: 10, day: 3, hour: 0, minute: 0, second: 0,
    });
  });

  it('gives the zone offset at the instant, daylight saving included', () => {
    expect(zoneOffsetMs(Date.parse('2026-07-01T12:00:00Z'), LA)).toBe(-7 * 3600_000);
    expect(zoneOffsetMs(new Date('2026-12-01T12:00:00Z'), LA)).toBe(-8 * 3600_000);
    expect(zoneOffsetMs(Date.parse('2026-12-01T12:00:00Z'), 'Asia/Kolkata')).toBe(5.5 * 3600_000);
  });

  it('formatWallClock is the browser datetime-local shape', () => {
    expect(formatWallClock(Date.parse('2026-10-03T21:00:00Z'), LA)).toBe('2026-10-03T14:00');
  });
});
