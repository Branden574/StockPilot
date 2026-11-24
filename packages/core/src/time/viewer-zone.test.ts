import { describe, expect, it } from 'vitest';

import { securityMapZonedClock } from '../security/security-map';
import {
  dayStartInZone,
  nextDayStartInZone,
  runtimeTimeZone,
  usableTimeZone,
  zoneLongWords,
  zoneShortName,
} from './viewer-zone';

/**
 * THE VIEWER'S ZONE. Pinned: a zone is the viewer's only when this runtime
 * accepts it (anything else is none, never a guessed default); a time names
 * its zone's short name at that very instant, so the same wall clock on the
 * night the clocks go back reads PDT then PST; a day starts at the zone's own
 * midnight, and the day the clocks go back is 25 hours long. Made-up instants;
 * America/Los_Angeles, and Europe/Berlin east of UTC.
 */

const LA = 'America/Los_Angeles';
const BERLIN = 'Europe/Berlin';
const iso = (ms: number) => new Date(ms).toISOString();

describe('which zone', () => {
  it('a zone this runtime accepts is used; blank, unknown or not a string is none', () => {
    expect(usableTimeZone(LA)).toBe(LA);
    expect(usableTimeZone(` ${BERLIN} `)).toBe(BERLIN);
    expect(usableTimeZone('UTC')).toBe('UTC');
    for (const raw of ['', '   ', 'America/Nowhere', 'Not a zone', 42, null, undefined, {}]) {
      expect(usableTimeZone(raw), String(raw)).toBeNull();
    }
    expect(usableTimeZone(runtimeTimeZone())).toBe(runtimeTimeZone());
  });
});

describe('a time names its zone at that instant', () => {
  it('Pacific, across the night the clocks go back: the same wall clock, PDT then PST', () => {
    // 1 Nov 2026: 02:00 PDT becomes 01:00 PST at 09:00 UTC.
    const before = Date.parse('2026-11-01T08:30:00Z');
    const after = Date.parse('2026-11-01T09:30:00Z');
    expect(zoneShortName(before, LA)).toBe('PDT');
    expect(zoneShortName(after, LA)).toBe('PST');
    expect(securityMapZonedClock(before, LA)).toBe('01:30 PDT');
    expect(securityMapZonedClock(after, LA)).toBe('01:30 PST');
    expect(securityMapZonedClock('2026-11-23T21:58:00Z', LA)).toBe('13:58 PST');
  });

  it('east of UTC, across its own change: an offset where English has no short name', () => {
    // 25 Oct 2026: 03:00 CEST becomes 02:00 CET at 01:00 UTC.
    const before = Date.parse('2026-10-25T00:30:00Z');
    const after = Date.parse('2026-10-25T01:30:00Z');
    expect(securityMapZonedClock(before, BERLIN)).toBe(`02:30 ${zoneShortName(before, BERLIN)}`);
    expect(securityMapZonedClock(after, BERLIN)).toBe(`02:30 ${zoneShortName(after, BERLIN)}`);
    expect(zoneShortName(before, BERLIN)).toBe('GMT+2');
    expect(zoneShortName(after, BERLIN)).toBe('GMT+1');
    expect(securityMapZonedClock('2026-11-23T21:58:00Z', BERLIN)).toBe('22:58 GMT+1');
  });

  it('UTC is named UTC; the line under a list names the zone in full', () => {
    expect(securityMapZonedClock('2026-11-23T21:58:00Z', 'UTC')).toBe('21:58 UTC');
    const nov = Date.parse('2026-11-23T21:58:00Z');
    expect(zoneLongWords(nov, LA)).toBe('Pacific Standard Time (America/Los_Angeles)');
    expect(zoneLongWords(Date.parse('2026-07-01T12:00:00Z'), LA)).toBe(
      'Pacific Daylight Time (America/Los_Angeles)',
    );
    expect(zoneLongWords(nov, 'UTC')).toBe('UTC');
    expect(zoneLongWords(nov, BERLIN)).toMatch(/\(Europe\/Berlin\)$/);
  });
});

describe("a day starts at the zone's own midnight", () => {
  const now = Date.parse('2026-11-23T22:00:05Z');

  it('the same instant is a different day in each zone', () => {
    expect(iso(dayStartInZone(now, LA))).toBe('2026-11-23T08:00:00.000Z');
    // 23:00 on the 23rd in Berlin: its day began at 23:00 UTC the day before.
    expect(iso(dayStartInZone(now, BERLIN))).toBe('2026-11-22T23:00:00.000Z');
    expect(iso(dayStartInZone(now, 'UTC'))).toBe('2026-11-23T00:00:00.000Z');
  });

  it('the day the clocks go back is 25 hours long, and the next day starts at its own midnight', () => {
    const start = dayStartInZone(Date.parse('2026-11-01T20:00:00Z'), LA);
    expect(iso(start)).toBe('2026-11-01T07:00:00.000Z');
    const next = nextDayStartInZone(start, LA);
    expect(iso(next)).toBe('2026-11-02T08:00:00.000Z');
    expect((next - start) / 3_600_000).toBe(25);
    expect(iso(nextDayStartInZone(dayStartInZone(now, BERLIN), BERLIN))).toBe(
      '2026-11-23T23:00:00.000Z',
    );
  });
});
