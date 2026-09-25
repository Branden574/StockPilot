import { describe, expect, it } from 'vitest';

import { resolveCapturedAt } from './capture-time';

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

  // A pair whose gap is longer than any real offline spell used to resolve to
  // a date Postgres cannot store (a year before 1 AD prints as "-007973-…"):
  // the record then failed with a 500 on every retry, and the phone's drain
  // retries a 5xx forever, so the row never settled and "Sync first" blocked
  // the post. Mutation: drop the floor, and these resolve to such dates.
  it.each([
    ['a gap of millennia', '0001-01-01T00:00:00.000Z', '9999-12-31T00:00:00.000Z'],
    ['a capture in year 1 sent now', '0001-01-01T00:00:00.000Z', '2026-09-24T18:00:00.000Z'],
    ['an extended negative year', '-000100-01-01T00:00:00.000Z', '2026-09-24T18:00:00.000Z'],
    ['a gap reaching before 2020', '2019-06-01T00:00:00.000Z', '2026-09-24T18:00:00.000Z'],
  ])('drops %s instead of resolving before any real count', (_label, capturedAt, clientSentAt) => {
    expect(resolveCapturedAt({ capturedAt, clientSentAt, serverNow })).toBeUndefined();
  });

  it('keeps a long but real offline spell (days)', () => {
    expect(
      resolveCapturedAt({
        capturedAt: '2026-09-20T18:00:00.000Z',
        clientSentAt: '2026-09-24T18:00:00.000Z',
        serverNow,
      }),
    ).toBe('2026-09-20T18:00:00.000Z');
  });
});
