/**
 * Percentiles for performance samples.
 *
 * Owner rule (performance program 2026-09): report p50 / p75 / p95 / min / max
 * and the sample count, never one run, and NEVER a fabricated cell. So:
 *
 *   - non-finite samples (a scenario that timed out, a metric the browser did
 *     not report) are DROPPED and counted in `dropped`, never coerced to 0;
 *     a real 0 (a CLS of zero) is a sample and is kept;
 *   - an empty set summarizes to `null`, which the report prints as
 *     "not measured";
 *   - the method is nearest-rank. It only ever returns a value that was
 *     actually observed, so a table cell is always a real measurement and
 *     never an interpolation between two of them.
 *
 * Read `n` next to every p95: with nearest-rank, p95 is the maximum until
 * n reaches 20.
 */

export interface Summary {
  n: number;
  /** Samples discarded because they were not finite numbers. */
  dropped: number;
  min: number;
  p50: number;
  p75: number;
  p95: number;
  max: number;
}

/** Nearest-rank percentile of an ASCENDING array. `p` is 0-100. */
export function percentile(sortedAscending: ReadonlyArray<number>, p: number): number | null {
  const n = sortedAscending.length;
  if (n === 0 || !Number.isFinite(p)) return null;
  const clamped = Math.min(100, Math.max(0, p));
  // Multiply before dividing: `(28 / 100) * 25` is 7.000000000000001 in
  // floating point and would round UP a rank that is exactly 7.
  const rank = Math.max(1, Math.ceil((clamped * n) / 100));
  return sortedAscending[rank - 1] ?? null;
}

function finiteAscending(samples: ReadonlyArray<number | null | undefined>): number[] {
  const finite: number[] = [];
  for (const s of samples) {
    if (typeof s === 'number' && Number.isFinite(s)) finite.push(s);
  }
  return finite.sort((a, b) => a - b);
}

export function summarize(samples: ReadonlyArray<number | null | undefined>): Summary | null {
  const finite = finiteAscending(samples);
  if (finite.length === 0) return null;
  const at = (p: number): number => percentile(finite, p) as number;
  return {
    n: finite.length,
    dropped: samples.length - finite.length,
    min: finite[0] as number,
    p50: at(50),
    p75: at(75),
    p95: at(95),
    max: finite[finite.length - 1] as number,
  };
}

/**
 * Percentiles over samples of which some NEVER FINISHED (a navigation that
 * timed out, a photo set that did not complete). "Did not finish" is slower than
 * every sample that did, so those rank last, as +Infinity. A percentile that
 * lands on one is Infinity, which the report prints as "did not finish": still
 * no number is invented, and one timeout in forty no longer voids the row (it
 * simply sits above p95) while ten in forty drags p75 into "did not finish".
 */
export function summarizeWithUnfinished(
  finished: ReadonlyArray<number | null | undefined>,
  unfinished: number,
): Summary | null {
  const finite = finiteAscending(finished);
  if (finite.length === 0 && unfinished === 0) return null;
  const ranked = [...finite, ...new Array<number>(unfinished).fill(Number.POSITIVE_INFINITY)];
  const at = (p: number): number => percentile(ranked, p) as number;
  return {
    n: ranked.length,
    dropped: finished.length - finite.length,
    min: ranked[0] as number,
    p50: at(50),
    p75: at(75),
    p95: at(95),
    max: ranked[ranked.length - 1] as number,
  };
}

/** Change from `before` to `after` as a signed percentage, or null when either side is missing or `before` is 0. */
export function deltaPercent(before: number | null | undefined, after: number | null | undefined) {
  if (typeof before !== 'number' || typeof after !== 'number') return null;
  if (!Number.isFinite(before) || !Number.isFinite(after) || before === 0) return null;
  return ((after - before) / before) * 100;
}

/** mulberry32: tiny, fast, and above all SEEDED, so the same two runs always give the same interval. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface NoiseCheck {
  /** 95% bootstrap interval of (after percentile - before percentile), in the samples' unit. */
  low: number;
  high: number;
  /** False when the interval spans 0: the two runs cannot be told apart at this sample size. */
  distinguishable: boolean;
  /** Share of resampled differences above 0 (the after run slower / larger). 0.5 is a coin toss. */
  shareAbove: number;
  resamples: number;
}

/**
 * Is the difference between two runs bigger than their own scatter?
 *
 * Twenty samples of a web page vary by tens of percent run to run, so "p75
 * moved 12%" on its own proves nothing. This resamples both runs with
 * replacement and looks at where the difference of the chosen percentile lands:
 * if 0 sits inside the central 95%, the honest label is "not distinguishable
 * from noise". This is a DERIVED statistic (the report says so); the p50/p75/p95
 * cells stay raw observations. Needs at least 8 samples a side to say anything.
 */
export function bootstrapPercentileDelta(
  before: ReadonlyArray<number | null | undefined>,
  after: ReadonlyArray<number | null | undefined>,
  p = 75,
  resamples = 2000,
  seed = 20260918,
): NoiseCheck | null {
  const b = finiteAscending(before);
  const a = finiteAscending(after);
  if (b.length < 8 || a.length < 8) return null;
  const random = seeded(seed);
  const draw = (source: number[]): number => {
    const picked = new Array<number>(source.length);
    for (let i = 0; i < source.length; i++)
      picked[i] = source[Math.floor(random() * source.length)] as number;
    picked.sort((x, y) => x - y);
    return percentile(picked, p) as number;
  };
  const deltas = new Array<number>(resamples);
  for (let i = 0; i < resamples; i++) deltas[i] = draw(a) - draw(b);
  deltas.sort((x, y) => x - y);
  const low = percentile(deltas, 2.5) as number;
  const high = percentile(deltas, 97.5) as number;
  const shareAbove = deltas.filter((d) => d > 0).length / resamples;
  return { low, high, distinguishable: low > 0 || high < 0, shareAbove, resamples };
}
