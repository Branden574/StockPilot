import { describe, expect, it } from 'vitest';
import { deriveAgeDays } from './inventory';

describe('deriveAgeDays', () => {
  it('returns whole days since the earliest staged movement', () => {
    const now = new Date('2026-06-25T00:00:00Z').getTime();
    expect(deriveAgeDays('2026-06-22T00:00:00Z', now)).toBe(3);
  });
  it('returns 0 for same-day', () => {
    const now = new Date('2026-06-25T06:00:00Z').getTime();
    expect(deriveAgeDays('2026-06-25T00:00:00Z', now)).toBe(0);
  });
  it('returns null when no received timestamp', () => {
    expect(deriveAgeDays(null, Date.now())).toBeNull();
  });
});
