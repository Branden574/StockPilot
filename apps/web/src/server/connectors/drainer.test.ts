import { describe, expect, it } from 'vitest';

import { MAX_ATTEMPTS, nextBackoff } from './drainer';

describe('nextBackoff', () => {
  it('is exponential and capped, jittered within bounds', () => {
    const b1 = nextBackoff(1),
      b8 = nextBackoff(8);
    expect(b1).toBeGreaterThan(0);
    expect(b8).toBeLessThanOrEqual(60 * 60 * 1000); // cap 1h
    expect(nextBackoff(2)).toBeGreaterThanOrEqual(nextBackoff(1) * 0.5);
  });
  it('MAX_ATTEMPTS is a small finite number', () => {
    expect(MAX_ATTEMPTS).toBeGreaterThan(3);
    expect(MAX_ATTEMPTS).toBeLessThanOrEqual(12);
  });
});
