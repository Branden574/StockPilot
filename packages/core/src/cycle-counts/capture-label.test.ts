import { describe, expect, it } from 'vitest';

import { offlineCaptureAt, offlineCaptureLabel } from './capture-label';

/**
 * 0369, D7: an offline capture is accepted however old, and the review shows
 * when it was taken. The web review row and the phone's count screen both
 * build the label here.
 */
describe('offlineCaptureLabel (review, D7)', () => {
  it('labels a line captured well before it was written, in the org timezone', () => {
    expect(
      offlineCaptureLabel(
        { captured_at: '2026-09-24T17:20:00.000Z', counted_at: '2026-09-25T15:00:00.000Z' },
        'America/Los_Angeles',
      ),
    ).toBe('Counted offline Sep 24, 10:20 AM');
  });

  it('shows nothing for an online record (no capture time, or seconds apart)', () => {
    expect(offlineCaptureLabel({ captured_at: null, counted_at: '2026-09-24T17:20:00.000Z' })).toBeNull();
    expect(
      offlineCaptureLabel({
        captured_at: '2026-09-24T17:19:30.000Z',
        counted_at: '2026-09-24T17:20:00.000Z',
      }),
    ).toBeNull();
  });

  it('survives an unreadable value or zone', () => {
    expect(offlineCaptureLabel({ captured_at: 'nope', counted_at: null })).toBeNull();
    expect(
      offlineCaptureLabel({ captured_at: '2026-09-24T17:20:00.000Z', counted_at: null }, 'Not/AZone'),
    ).toMatch(/^Counted offline Sep 2[45], /);
  });
});

describe('offlineCaptureAt (what the phone caches)', () => {
  it('is the capture instant for an offline line, null for an online one', () => {
    expect(
      offlineCaptureAt({ captured_at: '2026-09-24T17:20:00+00:00', counted_at: '2026-09-24T19:00:00+00:00' }),
    ).toBe('2026-09-24T17:20:00.000Z');
    expect(
      offlineCaptureAt({ captured_at: '2026-09-24T17:19:30Z', counted_at: '2026-09-24T17:20:00Z' }),
    ).toBeNull();
    expect(offlineCaptureAt({ captured_at: null, counted_at: '2026-09-24T17:20:00Z' })).toBeNull();
  });

  it('a cached instant (no counted_at) round-trips into the same label', () => {
    const at = offlineCaptureAt({
      captured_at: '2026-09-24T17:20:00.000Z',
      counted_at: '2026-09-25T15:00:00.000Z',
    });
    expect(offlineCaptureLabel({ captured_at: at, counted_at: null }, 'America/Los_Angeles')).toBe(
      'Counted offline Sep 24, 10:20 AM',
    );
  });
});
