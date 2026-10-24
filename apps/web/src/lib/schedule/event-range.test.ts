import { describe, expect, it } from 'vitest';

import { formatEventRange } from './event-range';

/**
 * A team calendar event's page printed its date and times in Pacific (the
 * formatters' default) whatever the organization's zone (small fixes slice
 * 8, item F, the calendar's sibling). It now prints them in the zone it is
 * given: the organization's.
 */
const plain = (s: string) => s.replace(/[  ]/g, ' ');

describe('formatEventRange prints in the organization zone', () => {
  it('a New York organization: 2 PM there, not 11 AM Pacific', () => {
    expect(plain(formatEventRange('2026-10-07T18:00:00Z', null, false, 'America/New_York'))).toBe(
      'Wed, Oct 7, 2026 · 2:00 PM',
    );
    expect(plain(formatEventRange('2026-10-07T18:00:00Z', null, false, 'America/Los_Angeles'))).toBe(
      'Wed, Oct 7, 2026 · 11:00 AM',
    );
  });

  it("decides one day or two in the organization's zone", () => {
    // 8:30 to 9:30 PM on Oct 7 in Los Angeles; 11:30 PM Oct 7 to 12:30 AM Oct 8 in New York.
    const start = '2026-10-08T03:30:00Z';
    const end = '2026-10-08T04:30:00Z';
    expect(plain(formatEventRange(start, end, false, 'America/Los_Angeles'))).toBe(
      'Wed, Oct 7, 2026 · 8:30 PM – 9:30 PM',
    );
    expect(plain(formatEventRange(start, end, false, 'America/New_York'))).toBe(
      'Wed, Oct 7, 2026 11:30 PM → Thu, Oct 8, 2026 12:30 AM',
    );
  });

  it("an all-day event is the organization's day", () => {
    // Stored at 2 AM UTC on Oct 8: still Oct 7 in Los Angeles, Oct 8 in Sydney.
    expect(formatEventRange('2026-10-08T02:00:00Z', null, true, 'America/Los_Angeles')).toBe(
      'Wed, Oct 7, 2026 · All day',
    );
    expect(formatEventRange('2026-10-08T02:00:00Z', null, true, 'Australia/Sydney')).toBe(
      'Thu, Oct 8, 2026 · All day',
    );
  });
});
