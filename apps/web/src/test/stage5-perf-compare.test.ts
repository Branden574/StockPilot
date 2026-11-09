import { describe, expect, it } from 'vitest';

import {
  allPass,
  judge,
  median,
  noiseAllowance,
  NOISE_FLOOR_MS,
  sorted,
  spread,
  type BuildSamples,
  type LoadSample,
} from '../../tests/perf/appearance-compare.mjs';

/**
 * Plan 8.4 and R12: how liquid-glass/verify/stage5/perf-compare.mjs judges
 * the three builds (medians of 3, both sides sorted, the A/A noise
 * allowance, glass LCP within 10%, every R12 budget). A budget that was not
 * measured fails.
 */

function loads(
  build: string,
  values: Record<string, Record<string, number[]>>,
  profile = 'desktop',
): LoadSample[] {
  const out: LoadSample[] = [];
  for (const [route, metrics] of Object.entries(values)) {
    for (const mode of ['cold', 'warm'] as const) {
      const n = Math.max(...Object.values(metrics).map((v) => v.length));
      for (let run = 0; run < n; run += 1) {
        const m: Record<string, number | null> = {};
        for (const [k, v] of Object.entries(metrics)) m[k] = v[run] ?? null;
        out.push({ build, profile, route, mode, run: run + 1, metrics: m });
      }
    }
  }
  return out;
}

const empty = (): BuildSamples => ({ loads: [], scrolls: [], interactions: [], switches: [] });

function passing(): Record<'B' | 'B-repeat' | 'branch-classic' | 'branch-glass', BuildSamples> {
  const timing = {
    ttfb: [100, 110, 105],
    fcp: [400, 420, 410],
    lcp: [900, 950, 920],
    useful: [1000, 1040, 1020],
  };
  const B = { ...empty(), loads: loads('B', { overview: timing }) };
  const BR = { ...empty(), loads: loads('B-repeat', { overview: timing }) };
  const BC = {
    ...empty(),
    loads: loads('branch-classic', { overview: { ...timing, lcp: [910, 940, 925] } }),
  };
  const BG: BuildSamples = {
    loads: [
      ...loads('branch-glass', { overview: { ...timing, lcp: [980, 990, 1000] } }),
      ...loads(
        'branch-glass',
        { landing: { lcp: [2000, 2100, 2050], cls: [0.01, 0.02, 0.01] } },
        'low-end',
      ),
    ],
    scrolls: ['overview', 'items', 'place-order'].flatMap((route) =>
      (
        [
          [4, 'normal', 40],
          [6, 'normal', 90],
          [6, 'reduced', 60],
        ] as const
      ).map(([cpu, material, max]) => ({
        build: 'branch-glass',
        profile: material === 'reduced' ? 'low-end' : 'desktop',
        route,
        cpu,
        material,
        run: 1,
        maxFrameMs: max,
        over50: 0,
        over100: 0,
        loafCount: 0,
      })),
    ),
    interactions: ['row-select', 'open-dialog', 'add-to-cart'].map((interaction) => ({
      build: 'branch-glass',
      profile: 'desktop',
      interaction,
      run: 1,
      inpMs: 120,
    })),
    switches: [
      {
        build: 'branch-glass',
        profile: 'desktop',
        route: 'items',
        run: 1,
        latencyMs: 40,
        dataRequests: 0,
      },
    ],
  };
  // The landing in classic on the branch (low-end): the glass limit is classic + 10%.
  BC.loads.push(...loads('branch-classic', { landing: { lcp: [1950, 2000, 2010] } }, 'low-end'));
  return { B, 'B-repeat': BR, 'branch-classic': BC, 'branch-glass': BG };
}

describe('statistics', () => {
  it('median of odd and even counts, ignoring what is not a number', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([Number.NaN, 5])).toBe(5);
    expect(median([])).toBeNull();
  });
  it('spread and sorted', () => {
    expect(spread([5, 1, 3])).toBe(4);
    expect(sorted([3, 1, 2])).toEqual([1, 2, 3]);
  });
  it('the noise allowance is the A/A drift plus the spread, never below the floor', () => {
    expect(noiseAllowance([100, 101, 102], [100, 101, 102])).toBe(NOISE_FLOOR_MS);
    expect(noiseAllowance([100, 140, 120], [150, 160, 155])).toBe(35 + 40);
  });
});

describe('the verdicts', () => {
  it('a run inside every budget passes', () => {
    const { verdicts } = judge(passing());
    expect(verdicts.filter((v) => !v.pass)).toEqual([]);
    expect(allPass(verdicts)).toBe(true);
  });
  it('lists both sides sorted in the table', () => {
    const { table } = judge(passing());
    const row = table.find(
      (r) => r.route === 'overview' && r.mode === 'cold' && r.metric === 'lcp',
    )!;
    expect(row['branch-glass']).toEqual([980, 990, 1000]);
    expect(row.medianClassic).toBe(925);
  });
  it('FAILS branch-classic slower than B beyond the noise', () => {
    const b = passing();
    b['branch-classic'].loads = b['branch-classic'].loads.map((l) =>
      l.route === 'overview' ? { ...l, metrics: { ...l.metrics, fcp: 600 } } : l,
    );
    expect(
      judge(b)
        .verdicts.filter((v) => !v.pass)
        .map((v) => v.check),
    ).toEqual(['noise fcp cold', 'noise fcp warm']);
  });
  it('FAILS glass LCP more than 10% over classic', () => {
    const b = passing();
    b['branch-glass'].loads = b['branch-glass'].loads.map((l) =>
      l.route === 'overview' ? { ...l, metrics: { ...l.metrics, lcp: 1100 } } : l,
    );
    expect(judge(b).verdicts.some((v) => v.check === 'glass LCP cold' && !v.pass)).toBe(true);
  });
  it('FAILS the R12 landing budget, a long frame, a slow interaction and a refetching switch', () => {
    const b = passing();
    b['branch-glass'].loads = b['branch-glass'].loads.map((l) =>
      l.route === 'landing' ? { ...l, metrics: { ...l.metrics, lcp: 2600 } } : l,
    );
    b['branch-glass'].scrolls[0]!.maxFrameMs = 51;
    b['branch-glass'].interactions[1]!.inpMs = 201;
    b['branch-glass'].switches[0]!.dataRequests = 1;
    const failed = judge(b)
      .verdicts.filter((v) => !v.pass)
      .map((v) => `${v.check}${v.route ? ` ${v.route}` : ''}`);
    expect(failed).toEqual([
      'R12 landing LCP (low-end)',
      'R12 scroll 4x normal overview',
      'R12 INP open-dialog',
      'R12 switch latency',
    ]);
  });
  it('the reduced material must hold the 6x budget with margin', () => {
    const b = passing();
    const reduced = b['branch-glass'].scrolls.find((s) => s.material === 'reduced')!;
    reduced.maxFrameMs = 90; // under 100, but not with margin (80)
    expect(judge(b).verdicts.some((v) => v.check === 'R12 scroll 6x reduced' && !v.pass)).toBe(
      true,
    );
  });
  it('FAILS what was not measured', () => {
    const b = passing();
    b['branch-glass'] = empty();
    const failed = judge(b).verdicts.filter((v) => !v.pass);
    expect(failed.length).toBeGreaterThan(5);
    expect(failed.every((v) => /not measured|glass .* vs classic|n\/a/u.test(v.detail))).toBe(true);
  });
});
