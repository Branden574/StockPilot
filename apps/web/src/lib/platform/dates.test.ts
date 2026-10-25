import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { formatDayInZone, formatMomentInZone } from './dates';

/**
 * B9: the platform console printed its dates with a bare toLocaleDateString()
 * on the server (UTC on Vercel), naming no zone, so anything that happened in
 * a Pacific evening was listed on the next day. An organization's dates are
 * now printed in that organization's zone.
 */

// The server's own zone must not matter. Pinned to one where a local getter
// and a UTC getter disagree, so a getDate() regression cannot pass unnoticed.
const ORIGINAL_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'Asia/Tokyo';
});
afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

// 6:30 PM Pacific on 24 Oct is 01:30 UTC on 25 Oct.
const PACIFIC_EVENING = '2026-10-25T01:30:00Z';

describe('formatDayInZone', () => {
  it("prints the day in the organization's zone, not the server's", () => {
    expect(formatDayInZone(PACIFIC_EVENING, 'America/Los_Angeles')).toBe('24 Oct 2026');
    expect(formatDayInZone(PACIFIC_EVENING, 'UTC')).toBe('25 Oct 2026');
    expect(formatDayInZone(PACIFIC_EVENING, 'Asia/Kolkata')).toBe('25 Oct 2026');
    // Winter time too (PST, UTC-8): 23:30 PST on 1 Dec is 07:30 UTC on 2 Dec.
    expect(formatDayInZone('2026-12-02T07:30:00Z', 'America/Los_Angeles')).toBe('1 Dec 2026');
  });

  it('takes a Date or epoch millis as well as an ISO string', () => {
    expect(formatDayInZone(new Date(PACIFIC_EVENING), 'America/Los_Angeles')).toBe('24 Oct 2026');
    expect(formatDayInZone(Date.parse(PACIFIC_EVENING), 'America/Los_Angeles')).toBe('24 Oct 2026');
  });

  it('falls back to the documented default zone, and never throws', () => {
    expect(formatDayInZone(PACIFIC_EVENING, null)).toBe('24 Oct 2026');
    expect(formatDayInZone(PACIFIC_EVENING, 'Not/AZone')).toBe('24 Oct 2026');
    expect(formatDayInZone(null, 'UTC')).toBe('—');
    expect(formatDayInZone('', 'UTC')).toBe('—');
    expect(formatDayInZone('not-a-date', 'UTC')).toBe('—');
  });
});

describe('formatMomentInZone', () => {
  it("prints the wall clock in the organization's zone and names the zone", () => {
    expect(formatMomentInZone(PACIFIC_EVENING, 'America/Los_Angeles')).toBe(
      '24 Oct 2026, 18:30 PDT',
    );
    expect(formatMomentInZone('2026-12-02T07:30:00Z', 'America/Los_Angeles')).toBe(
      '1 Dec 2026, 23:30 PST',
    );
    expect(formatMomentInZone(PACIFIC_EVENING, 'UTC')).toBe('25 Oct 2026, 01:30 UTC');
  });

  it('prints "—" for no instant', () => {
    expect(formatMomentInZone(undefined, 'UTC')).toBe('—');
    expect(formatMomentInZone('nope', 'UTC')).toBe('—');
  });
});
