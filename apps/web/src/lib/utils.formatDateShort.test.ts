import { afterEach, describe, expect, it } from 'vitest';

import { formatDateShort } from './utils';

// A PO's expected date is the day the buyer picked, stored as that day's UTC
// midnight. Without a zone the runtime's is used, which west of UTC is the day
// before; with 'UTC' it is the picked day in every runtime (the server's UTC
// and the viewer's zone alike), so a server render and its hydration agree.
describe('formatDateShort', () => {
  const previous = process.env.TZ;
  afterEach(() => {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  });

  it("prints the runtime's day by default: the day before for UTC midnight in Los Angeles", () => {
    process.env.TZ = 'America/Los_Angeles';
    expect(formatDateShort('2026-10-10T00:00:00.000Z')).toBe('Oct 9');
    process.env.TZ = 'UTC';
    expect(formatDateShort('2026-10-10T00:00:00.000Z')).toBe('Oct 10');
  });

  it("with timeZone 'UTC' prints the stored day in every runtime zone", () => {
    for (const zone of ['UTC', 'America/Los_Angeles', 'America/New_York', 'Asia/Tokyo']) {
      process.env.TZ = zone;
      expect(formatDateShort('2026-10-10T00:00:00.000Z', 'en-US', 'UTC')).toBe('Oct 10');
    }
  });

  it('keeps its dash for a missing or unreadable date', () => {
    expect(formatDateShort(null, 'en-US', 'UTC')).toBe('—');
    expect(formatDateShort('not a date', 'en-US', 'UTC')).toBe('—');
  });
});
