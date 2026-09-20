import { describe, expect, it } from 'vitest';

import { bootstrapPercentileDelta, deltaPercent, percentile, summarize } from './stats';

describe('percentile (nearest rank)', () => {
  const twenty = Array.from({ length: 20 }, (_, i) => (i + 1) * 10); // 10..200

  it('returns a value that was actually observed, never an interpolation', () => {
    for (const p of [0, 1, 50, 75, 90, 95, 99, 100])
      expect(twenty).toContain(percentile(twenty, p));
    expect(percentile([100, 200], 50)).toBe(100);
  });

  it('matches the textbook nearest-rank answers', () => {
    expect(percentile(twenty, 50)).toBe(100);
    expect(percentile(twenty, 75)).toBe(150);
    expect(percentile(twenty, 95)).toBe(190);
    expect(percentile(twenty, 100)).toBe(200);
    expect(percentile(twenty, 0)).toBe(10);
  });

  it('p95 is the maximum until there are 20 samples', () => {
    const nineteen = twenty.slice(0, 19);
    expect(percentile(nineteen, 95)).toBe(190);
    expect(percentile(nineteen, 95)).toBe(Math.max(...nineteen));
  });

  it('computes the rank without floating-point drift', () => {
    // (28 / 100) * 25 is 7.000000000000001, which would round the rank up to 8.
    const twentyFive = Array.from({ length: 25 }, (_, i) => i + 1);
    expect(percentile(twentyFive, 28)).toBe(7);
  });

  it('has no answer for an empty set', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([1], Number.NaN)).toBeNull();
  });
});

describe('summarize', () => {
  it('reports the owner-required columns', () => {
    expect(summarize([300, 100, 200, 400])).toEqual({
      n: 4,
      dropped: 0,
      min: 100,
      p50: 200,
      p75: 300,
      p95: 400,
      max: 400,
    });
  });

  it('drops a missing sample and says so; it never counts it as zero', () => {
    const out = summarize([120, null, undefined, Number.NaN, Number.POSITIVE_INFINITY, 80]);
    expect(out).toMatchObject({ n: 2, dropped: 4, min: 80, max: 120 });
  });

  it('says nothing at all when nothing was measured', () => {
    expect(summarize([])).toBeNull();
    expect(summarize([null, undefined])).toBeNull();
  });

  it('does not reorder the caller’s array', () => {
    const input = [3, 1, 2];
    summarize(input);
    expect(input).toEqual([3, 1, 2]);
  });
});

describe('deltaPercent', () => {
  it('is negative when things got faster', () => {
    expect(deltaPercent(1000, 600)).toBe(-40);
    expect(deltaPercent(500, 550)).toBeCloseTo(10);
  });

  it('refuses to invent a delta from a missing side', () => {
    expect(deltaPercent(null, 100)).toBeNull();
    expect(deltaPercent(100, undefined)).toBeNull();
    expect(deltaPercent(0, 100)).toBeNull();
    expect(deltaPercent(Number.NaN, 100)).toBeNull();
  });
});

describe('bootstrapPercentileDelta', () => {
  const around = (base: number) => Array.from({ length: 20 }, (_, i) => base + ((i * 37) % 60));

  it('tells two clearly different runs apart', () => {
    const out = bootstrapPercentileDelta(around(800), around(500))!;
    expect(out.distinguishable).toBe(true);
    expect(out.high).toBeLessThan(0);
  });

  it('cannot tell a run from itself', () => {
    const out = bootstrapPercentileDelta(around(800), around(800))!;
    expect(out.distinguishable).toBe(false);
    expect(out.low).toBeLessThanOrEqual(0);
    expect(out.high).toBeGreaterThanOrEqual(0);
  });

  it('is seeded: the same two runs always give the same interval', () => {
    expect(bootstrapPercentileDelta(around(800), around(760))).toEqual(
      bootstrapPercentileDelta(around(800), around(760)),
    );
  });

  it('says nothing from too few samples, and ignores missing ones', () => {
    expect(bootstrapPercentileDelta([1, 2, 3], around(5))).toBeNull();
    expect(
      bootstrapPercentileDelta([...around(800), null, undefined, Number.NaN], around(500))
        ?.distinguishable,
    ).toBe(true);
  });
});
