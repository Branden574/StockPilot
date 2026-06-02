import { describe, expect, it } from 'vitest';
import { haversineMiles, isStale } from './distance';

describe('haversineMiles', () => {
  it('is 0 for identical points', () => {
    expect(haversineMiles({ lat: 36.7, lng: -119.7 }, { lat: 36.7, lng: -119.7 })).toBe(0);
  });
  it('matches a known distance (LA ~ NYC ≈ 2445 mi, within 1%)', () => {
    const d = haversineMiles({ lat: 34.05, lng: -118.24 }, { lat: 40.71, lng: -74.01 });
    expect(d).toBeGreaterThan(2420);
    expect(d).toBeLessThan(2470);
  });
  it('rounds to one decimal', () => {
    const d = haversineMiles({ lat: 36.70, lng: -119.70 }, { lat: 36.71, lng: -119.70 });
    expect(d).toBeCloseTo(0.7, 1);
  });
});

describe('isStale', () => {
  const now = new Date('2026-06-02T12:00:00Z');
  it('false when recent', () => {
    expect(isStale('2026-06-02T11:59:00Z', now, 300)).toBe(false);
  });
  it('true when older than maxAge', () => {
    expect(isStale('2026-06-02T11:50:00Z', now, 300)).toBe(true);
  });
  it('true for an unparseable timestamp', () => {
    expect(isStale('not-a-date', now, 300)).toBe(true);
  });
});
