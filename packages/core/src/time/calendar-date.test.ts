import { afterEach, describe, expect, it } from 'vitest';

import { restoreIntl, useHermesLikeIntl } from './__fixtures__/hermes-like-intl';
import { formatCalendarDate } from './calendar-date';

/**
 * A purchase order's expected date is the DAY the buyer picked, stored as that
 * day's midnight UTC: the web PO form, both PO imports and the phone's
 * normalizeExpectedAt all write `YYYY-MM-DDT00:00:00.000Z` (production
 * 2026-10-06: 34 purchase orders have one, every one at 00:00 UTC).
 *
 * The phone's Purchase orders and Receive POs screens printed it with
 * toLocaleDateString in the device's zone, which west of UTC is still the
 * evening before: Oct 9 for a purchase order expected Oct 10, in every US
 * zone. formatCalendarDate reads the day back in UTC, whatever zone the
 * runtime (a phone, the server, a browser) is in.
 */

const OCT_10 = '2026-10-10T00:00:00.000Z';

describe('formatCalendarDate', () => {
  const previousZone = process.env.TZ;
  afterEach(() => {
    if (previousZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousZone;
    restoreIntl();
  });

  it("is the stored day in Los Angeles, where the device's zone printed the day before", () => {
    process.env.TZ = 'America/Los_Angeles';
    // What the two phone screens printed (their own call, with the locale
    // pinned so the words do not depend on the machine running the test).
    expect(new Date(OCT_10).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })).toBe(
      'Oct 9',
    );
    expect(formatCalendarDate(OCT_10)).toBe('Oct 10');
  });

  it('is the stored day in Sydney, east of UTC, and at UTC itself', () => {
    process.env.TZ = 'Australia/Sydney';
    expect(formatCalendarDate(OCT_10)).toBe('Oct 10');
    process.env.TZ = 'UTC';
    expect(formatCalendarDate(OCT_10)).toBe('Oct 10');
  });

  it('is the stored day in every zone, including across a year end and both daylight-saving changes', () => {
    const days: Array<[string, string]> = [
      ['2026-01-01T00:00:00.000Z', 'Jan 1'],
      ['2026-03-08T00:00:00.000Z', 'Mar 8'], // US clocks spring forward
      ['2026-04-05T00:00:00.000Z', 'Apr 5'], // Sydney's fall back
      ['2026-11-01T00:00:00.000Z', 'Nov 1'], // US clocks fall back
      ['2026-12-31T00:00:00.000Z', 'Dec 31'],
    ];
    for (const zone of [
      'Pacific/Honolulu',
      'America/Los_Angeles',
      'America/New_York',
      'UTC',
      'Europe/London',
      'Asia/Tokyo',
      'Australia/Sydney',
      'Pacific/Kiritimati',
    ]) {
      process.env.TZ = zone;
      for (const [iso, day] of days) expect(formatCalendarDate(iso), `${iso} in ${zone}`).toBe(day);
    }
  });

  it('takes date options, and no option can move the day out of UTC', () => {
    process.env.TZ = 'America/Los_Angeles';
    expect(
      formatCalendarDate('2026-01-01T00:00:00.000Z', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      }),
    ).toBe('Jan 1, 2026');
    expect(formatCalendarDate(OCT_10, { year: 'numeric', month: 'numeric', day: 'numeric' })).toBe(
      '10/10/2026',
    );
    expect(
      formatCalendarDate(OCT_10, {
        month: 'short',
        day: 'numeric',
        timeZone: 'America/Los_Angeles',
      }),
    ).toBe('Oct 10');
  });

  it('takes a Date as well as the stored string', () => {
    process.env.TZ = 'America/Los_Angeles';
    expect(formatCalendarDate(new Date(OCT_10))).toBe('Oct 10');
  });

  it('is a dash for a missing or unreadable date', () => {
    expect(formatCalendarDate(null)).toBe('—');
    expect(formatCalendarDate(undefined)).toBe('—');
    expect(formatCalendarDate('')).toBe('—');
    expect(formatCalendarDate('not a date')).toBe('—');
  });

  it("prints the same words through the phone's engine (the Hermes stand-in)", () => {
    process.env.TZ = 'America/Los_Angeles';
    useHermesLikeIntl();
    expect(formatCalendarDate(OCT_10)).toBe('Oct 10');
    expect(formatCalendarDate(OCT_10, { month: 'short', day: 'numeric', year: 'numeric' })).toBe(
      'Oct 10, 2026',
    );
  });
});
