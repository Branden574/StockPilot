import { describe, expect, it } from 'vitest';

import { computeLotExpiry, expiryBucket, sortLotsFefo } from './expiry';

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-06-01T00:00:00.000Z');

describe('computeLotExpiry', () => {
  it('uses the explicit expiration date when present', () => {
    const got = computeLotExpiry(
      { expirationDate: '2026-07-01', receivedAt: '2026-05-01T00:00:00Z' },
      { shelfLifeDays: 10 },
    );
    expect(got?.toISOString().slice(0, 10)).toBe('2026-07-01');
  });

  it('falls back to receivedAt + shelfLifeDays when no explicit date', () => {
    const got = computeLotExpiry(
      { expirationDate: null, receivedAt: '2026-05-01T00:00:00.000Z' },
      { shelfLifeDays: 30 },
    );
    expect(got?.toISOString().slice(0, 10)).toBe('2026-05-31');
  });

  it('returns null when neither an explicit date nor shelf life is available', () => {
    expect(
      computeLotExpiry({ expirationDate: null, receivedAt: '2026-05-01T00:00:00Z' }, { shelfLifeDays: null }),
    ).toBeNull();
  });
});

describe('expiryBucket', () => {
  it('classifies by days to expiry relative to now', () => {
    expect(expiryBucket(new Date(now.getTime() - DAY), now)).toBe('expired');
    expect(expiryBucket(new Date(now.getTime() + 3 * DAY), now)).toBe('le7');
    expect(expiryBucket(new Date(now.getTime() + 20 * DAY), now)).toBe('le30');
    expect(expiryBucket(new Date(now.getTime() + 60 * DAY), now)).toBe('le90');
    expect(expiryBucket(new Date(now.getTime() + 200 * DAY), now)).toBe('ok');
    expect(expiryBucket(null, now)).toBe('unknown');
  });

  it('treats exactly-now as expired (boundary)', () => {
    expect(expiryBucket(new Date(now.getTime()), now)).toBe('expired');
  });
});

describe('sortLotsFefo', () => {
  it('orders earliest expiry first; null/unknown expiry sorts last', () => {
    const lots = [
      { id: 'c', expiry: null },
      { id: 'a', expiry: new Date(now.getTime() + 5 * DAY) },
      { id: 'b', expiry: new Date(now.getTime() + 50 * DAY) },
    ];
    expect(sortLotsFefo(lots).map((l) => l.id)).toEqual(['a', 'b', 'c']);
  });

  it('is a pure, stable sort (does not mutate input)', () => {
    const lots = [{ id: 'x', expiry: new Date(now.getTime() + DAY) }];
    const copy = [...lots];
    sortLotsFefo(lots);
    expect(lots).toEqual(copy);
  });
});
