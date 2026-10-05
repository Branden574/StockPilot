import { describe, expect, it } from 'vitest';

import { formatMovementDay, formatMovementWhen, MOVEMENT_WHEN_OPTIONS } from './movement-when';

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
