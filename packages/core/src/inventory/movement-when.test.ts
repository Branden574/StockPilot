import { afterEach, describe, expect, it } from 'vitest';

import { REAL_DTF, restoreIntl } from '../time/__fixtures__/hermes-like-intl';
import { resolveOrgTimezone } from '../time/org-timezone';
import {
  formatMovementCardWhen,
  formatMovementClock,
  formatMovementDay,
  formatMovementWhen,
  MOVEMENT_CARD_WHEN_OPTIONS,
  MOVEMENT_WHEN_OPTIONS,
} from './movement-when';

/**
 * L7 (owner decision Q1, 2026-10-05): movement times use the ORGANIZATION's
 * time zone on the web and the phone, like counts, exceptions and orders.
 * They used to print in the viewer's zone, so a movement near midnight showed
 * one day on the Movements page and another on a count card.
 */
describe('movement times in the organization zone (L7)', () => {
  // 05:30 UTC on 5 October is 22:30 on 4 October in Los Angeles and 14:30 on
  // 5 October in Tokyo: the calendar day depends on the zone.
  const LATE = '2026-10-05T05:30:00.000Z';

  it('prints the date and time in the zone it is given, never the runtime zone', () => {
    expect(formatMovementWhen(LATE, 'America/Los_Angeles')).toBe('Oct 4, 2026, 10:30 PM');
    expect(formatMovementWhen(LATE, 'UTC')).toBe('Oct 5, 2026, 5:30 AM');
    expect(formatMovementWhen(LATE, 'Asia/Tokyo')).toBe('Oct 5, 2026, 2:30 PM');
  });

  it('the compact day flips at the organization midnight', () => {
    expect(formatMovementDay(LATE, 'America/Los_Angeles')).toBe('Oct 4');
    expect(formatMovementDay(LATE, 'UTC')).toBe('Oct 5');
  });

  it('a zone that did not arrive, or one the runtime does not know, uses core’s documented default', () => {
    expect(formatMovementWhen(LATE, null)).toBe('Oct 4, 2026, 10:30 PM');
    expect(formatMovementWhen(LATE, undefined)).toBe('Oct 4, 2026, 10:30 PM');
    expect(formatMovementWhen(LATE, 'Not/AZone')).toBe('Oct 4, 2026, 10:30 PM');
    expect(formatMovementDay(LATE, null)).toBe('Oct 4');
  });

  it('a value that is not a date gives null, so a surface renders nothing', () => {
    expect(formatMovementWhen('not a date', 'UTC')).toBeNull();
    expect(formatMovementWhen('', 'UTC')).toBeNull();
    expect(formatMovementDay('not a date', 'UTC')).toBeNull();
  });

  it('keeps the shape the viewer-zone text had, so only the zone changes', () => {
    expect(MOVEMENT_WHEN_OPTIONS).toEqual({
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
    // Plain spaces: Hermes and newer ICU put U+202F before AM/PM.
    expect(formatMovementWhen(LATE, 'UTC')).not.toMatch(/[  ]/);
  });
});

/**
 * Slice 3 review F2: the phone's item screen (MOVEMENTS and ACTIVITY cards) and
 * its home screen (recent movements) print in the organization's zone too, in
 * the shapes their device-zone text had: "Oct 4, 10:30 PM" and "22:30".
 */
describe('the phone item cards and home rows in the organization zone (L7, F2)', () => {
  const LATE = '2026-10-05T05:30:00.000Z';

  it('the item cards print month, day and time with no year, in the zone given', () => {
    expect(formatMovementCardWhen(LATE, 'America/Los_Angeles')).toBe('Oct 4, 10:30 PM');
    expect(formatMovementCardWhen(LATE, 'Asia/Tokyo')).toBe('Oct 5, 2:30 PM');
    expect(formatMovementCardWhen(LATE, 'UTC')).toBe('Oct 5, 5:30 AM');
    expect(MOVEMENT_CARD_WHEN_OPTIONS).toEqual({ month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  });

  it('the home rows print the 24-hour time in the zone given', () => {
    expect(formatMovementClock(LATE, 'America/Los_Angeles')).toBe('22:30');
    expect(formatMovementClock(LATE, 'Asia/Tokyo')).toBe('14:30');
    // Five past midnight in Los Angeles is 00:05, never 24:05.
    expect(formatMovementClock('2026-10-11T07:05:00.000Z', 'America/Los_Angeles')).toBe('00:05');
  });

  it('a missing or unknown zone uses the documented default; a non-date gives null', () => {
    expect(formatMovementCardWhen(LATE, null)).toBe('Oct 4, 10:30 PM');
    expect(formatMovementCardWhen(LATE, 'Not/AZone')).toBe('Oct 4, 10:30 PM');
    expect(formatMovementClock(LATE, undefined)).toBe('22:30');
    expect(formatMovementCardWhen('not a date', 'UTC')).toBeNull();
    expect(formatMovementClock('', 'UTC')).toBeNull();
  });

  it('plain spaces only', () => {
    expect(formatMovementCardWhen(LATE, 'UTC')).not.toMatch(/[\u202f\u00a0]/);
    expect(formatMovementClock(LATE, 'UTC')).not.toMatch(/[\u202f\u00a0]/);
  });
});

/**
 * Slice 3 review (2026-10-24): the web Movements page formats every row of its
 * instant ledger on the server, up to 1,000, through formatMovementWhen. It
 * built two Intl formatters per row (about 50 to 80 ms per visit, measured);
 * the formatters are now built once per zone (core formatOrgDateTime).
 */
describe('a whole ledger builds its formatters once (slice 3 review, 2026-10-24)', () => {
  afterEach(() => {
    restoreIntl();
  });

  it('1,000 movements in the organization zone build two Intl formatters, not two per row', () => {
    const zone = 'Asia/Tokyo';
    resolveOrgTimezone(zone);
    const start = Date.parse('2026-10-05T05:30:00.000Z');
    const isos = Array.from({ length: 1000 }, (_, i) => new Date(start + i * 3_600_000).toISOString());
    let built = 0;
    class CountingDateTimeFormat {
      private readonly real: Intl.DateTimeFormat;
      constructor(locales?: string | string[], options?: Intl.DateTimeFormatOptions) {
        built += 1;
        this.real = new REAL_DTF(locales, options);
      }
      format(date?: Date | number): string {
        return this.real.format(date);
      }
    }
    Object.defineProperty(Intl, 'DateTimeFormat', {
      value: CountingDateTimeFormat,
      configurable: true,
      writable: true,
    });
    const labels = isos.map((iso) => formatMovementWhen(iso, zone));
    expect(built).toBe(2);
    expect(labels[0]).toBe('Oct 5, 2026, 2:30 PM');
    // 999 hours (41 days and 15 hours) later: 5:30 AM on 16 November in
    // Tokyo, which keeps no daylight saving.
    expect(labels[999]).toBe('Nov 16, 2026, 5:30 AM');
  });
});
