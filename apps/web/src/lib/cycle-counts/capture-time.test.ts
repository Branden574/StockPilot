import { describe, expect, it } from 'vitest';

import { offlineCaptureLabel, resolveCapturedAt } from './capture-time';

/**
 * 0369 / correction 3: only the ELAPSED device time is trusted. The server
 * places the capture at serverNow - (clientSentAt - capturedAt), which removes
 * any absolute skew of the phone's clock. Correction 1: anything unreadable is
 * DROPPED (an online record), never an error.
 */
describe('resolveCapturedAt', () => {
  const serverNow = Date.parse('2026-09-24T18:00:00.000Z');

  it('puts the capture on the server clock using the elapsed device time', () => {
    // The phone's clock is 3 h behind; it counted 40 min before it sent.
    expect(
      resolveCapturedAt({
        capturedAt: '2026-09-24T14:20:00.000Z',
        clientSentAt: '2026-09-24T15:00:00.000Z',
        serverNow,
      }),
    ).toBe('2026-09-24T17:20:00.000Z');
  });

  it('the absolute device time does not matter, only the gap', () => {
    const ahead = resolveCapturedAt({
      capturedAt: '2027-01-01T00:00:00.000Z',
      clientSentAt: '2027-01-01T00:05:00.000Z',
      serverNow,
    });
    expect(ahead).toBe('2026-09-24T17:55:00.000Z');
  });

  it('accepts offset forms', () => {
    expect(
      resolveCapturedAt({
        capturedAt: '2026-09-24T08:00:00-07:00',
        clientSentAt: '2026-09-24T08:10:00-07:00',
        serverNow,
      }),
    ).toBe('2026-09-24T17:50:00.000Z');
  });

  it('a capture "after" the send (the device clock moved back) is now', () => {
    expect(
      resolveCapturedAt({
        capturedAt: '2026-09-24T15:10:00.000Z',
        clientSentAt: '2026-09-24T15:00:00.000Z',
        serverNow,
      }),
    ).toBe('2026-09-24T18:00:00.000Z');
  });

  it.each([
    ['both missing (an old phone bundle)', undefined, undefined],
    ['no send time', '2026-09-24T14:20:00.000Z', undefined],
    ['no capture time', undefined, '2026-09-24T15:00:00.000Z'],
    ['garbage', 'yesterday-ish', '2026-09-24T15:00:00.000Z'],
    ['a number', 1727190000000, '2026-09-24T15:00:00.000Z'],
    ['an object', { at: 'x' }, '2026-09-24T15:00:00.000Z'],
    ['empty string', '', '2026-09-24T15:00:00.000Z'],
    ['a huge string', `2026-09-24T14:20:00.000Z${' '.repeat(100)}x`, '2026-09-24T15:00:00.000Z'],
  ])('drops %s (the record is an online record)', (_label, capturedAt, clientSentAt) => {
    expect(resolveCapturedAt({ capturedAt, clientSentAt, serverNow })).toBeUndefined();
  });
});

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
