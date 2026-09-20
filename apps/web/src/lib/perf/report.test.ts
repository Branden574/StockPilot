import { describe, expect, it } from 'vitest';

import {
  buildComparisonReport,
  buildRunReport,
  compareRuns,
  environmentMismatches,
  formatValue,
  HARNESS_VERSION,
  rotationBetweenRuns,
  rotationWithinRun,
  SCHEMA_VERSION,
  summarizeRun,
  verdict,
  type ImageRecord,
  type RunFile,
  type RunMeta,
  type Sample,
} from './report';

const META: RunMeta = {
  schemaVersion: SCHEMA_VERSION,
  harnessVersion: HARNESS_VERSION,
  label: 'before',
  kind: 'production-synthetic',
  host: 'stockpilotusa.com',
  buildAtStart: 'abc123def456',
  buildAtEnd: 'abc123def456',
  builtAt: '2026-09-18T22:31:26.183Z',
  startedAt: '2026-09-18T23:00:00.000Z',
  finishedAt: '2026-09-18T23:10:00.000Z',
  browser: 'chromium',
  browserVersion: '153.0',
  viewport: '1440x900',
  devicePixelRatio: 2,
  network: 'unthrottled',
  rttMs: 40,
  machine: 'darwin arm64, Apple M3 x8',
  role: 'admin',
  roleLabel: 'admin',
  dataset: 'Demo Co',
  serverState: 'steady',
  iterations: 20,
  coldIterations: 10,
  hoverMs: 150,
  settleMs: 2000,
  usefulTimeoutMs: 30000,
  imageWaitMs: 15000,
  unsupportedMetrics: [],
};

function sample(
  scenario: string,
  iteration: number,
  usefulPaintMs: number | null,
  extra: Partial<Sample> = {},
): Sample {
  return {
    scenario,
    iteration,
    warmup: iteration === 0,
    at: '2026-09-18T23:00:00.000Z',
    ok: true,
    error: null,
    feedbackMs: 10,
    feedbackPaintMs: 28,
    feedbackBy: 'bar',
    clickEventDurationMs: 32,
    clickInputDelayMs: 1,
    hoverLeadMs: 160,
    usefulMs: usefulPaintMs,
    usefulPaintMs,
    shellPaintMs: 60,
    rscRequestStartMs: 5,
    rscFirstByteMs: 300,
    ttfbMs: null,
    fcpMs: null,
    lcpMs: null,
    cls: 0,
    longTaskBlockingMs: 0,
    consoleErrors: 0,
    hydrationErrors: 0,
    listRows: 29,
    network: null,
    photos: null,
    ...extra,
  };
}

/** `values[0]` is the warm-up. */
function run(
  label: string,
  values: Array<number | null>,
  meta: Partial<RunMeta> = {},
  scenario = 'dashboard-to-inventory',
): RunFile {
  return {
    meta: { ...META, label, ...meta },
    scenarios: [
      {
        id: scenario,
        title: 'Dashboard → Inventory',
        kind: 'soft-navigation',
        routes: ['/dashboard', '^/dashboard/inventory$'],
      },
    ],
    samples: values.map((v, i) => sample(scenario, i, v)),
  };
}

const range = (from: number, to: number, stepBy = 1) =>
  Array.from({ length: Math.floor((to - from) / stepBy) + 1 }, (_, i) => from + i * stepBy);
const row = (file: RunFile, id: string) => summarizeRun(file).find((r) => r.spec.id === id)!;
const compared = (before: RunFile, after: RunFile, id = 'nav-inventory') =>
  compareRuns(before, after).find((r) => r.spec.id === id)!;

describe('summarizeRun', () => {
  it('never lets the warm-up iteration into the percentiles', () => {
    // Iteration 0 is 9000 ms (cold). If it leaked, max would be 9000.
    expect(row(run('before', [9000, 400, 500, 600, 700]), 'nav-inventory').summary).toMatchObject({
      n: 4,
      min: 400,
      max: 700,
    });
  });

  it('keeps a failed iteration out of the numbers even when it carries a value, and counts it', () => {
    const file = run('before', [9000, 400, 500, 600, 700]);
    file.samples[2] = sample('dashboard-to-inventory', 2, 30000, {
      ok: false,
      error: 'timeout:useful',
    });
    const out = row(file, 'nav-inventory');
    expect(out).toMatchObject({ attempted: 4, failed: 1, noValue: 0 });
    expect(out.summary).toMatchObject({ n: 3, max: 700 });
  });

  it('separates "finished without this metric" from "failed"', () => {
    const file = run('before', [9000, 400, null, 600]);
    expect(row(file, 'nav-inventory')).toMatchObject({ attempted: 3, failed: 0, noValue: 1 });
  });

  it('keeps a measured zero: a CLS of 0 is a sample, not a gap', () => {
    const file = run('cls', [1, 1, 1, 1], {}, 'hard-load-inventory');
    file.samples.forEach((s, i) => (s.cls = i === 3 ? 0.2 : 0));
    expect(row(file, 'hard-cls').summary).toMatchObject({ n: 3, min: 0, max: 0.2 });
  });

  it('reports p95 as an observed value, and as the maximum only below n=20', () => {
    expect(row(run('twenty', [0, ...range(1, 20)]), 'nav-inventory').summary).toMatchObject({
      n: 20,
      p95: 19,
      max: 20,
    });
    expect(row(run('twenty-one', [0, ...range(1, 21)]), 'nav-inventory').summary).toMatchObject({
      n: 21,
      p95: 20,
      max: 21,
    });
    expect(row(run('nineteen', [0, ...range(1, 19)]), 'nav-inventory').summary).toMatchObject({
      n: 19,
      p95: 19,
      max: 19,
    });
  });

  it('leaves a scenario that did not run as null, and survives a file that lacks a whole branch', () => {
    expect(row(run('before', [9000, 400]), 'nav-orders').summary).toBeNull();
    const old = run('old', [9000, 400, 500]);
    old.samples.forEach((s) => (s.network = { counts: {} } as never));
    expect(() => summarizeRun(old)).not.toThrow();
    expect(row(old, 'bytes-rsc')).toMatchObject({ summary: null, noValue: 2 });
  });
});

describe('formatValue', () => {
  it('prints "not measured" for anything that is not a real number', () => {
    for (const v of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY])
      expect(formatValue(v, 'ms')).toBe('not measured');
  });

  it('formats by unit', () => {
    expect(formatValue(745.4, 'ms')).toBe('745 ms');
    expect(formatValue(0.0481, 'score')).toBe('0.048');
    expect(formatValue(52, 'count')).toBe('52');
    expect(formatValue(0, 'count')).toBe('0');
  });
});

describe('verdict', () => {
  it('judges BOTH p75 and p95, and says when p95 is only the slowest sample', () => {
    expect(verdict(row(run('ok', [0, ...range(100, 480, 20)]), 'nav-inventory'))).toBe(
      'within budget',
    );
    expect(verdict(row(run('slow', [0, ...range(600, 980, 20)]), 'nav-inventory'))).toBe(
      'OVER budget',
    );
    // p75 fine, one spike over the p95 budget: still over.
    expect(verdict(row(run('spiky', [0, 100, 100, 100, 1500]), 'nav-inventory'))).toBe(
      'OVER budget (n=4: p95 is the slowest sample)',
    );
    expect(verdict(row(run('few', [0, 100, 200, 300]), 'nav-inventory'))).toBe(
      'within budget (n=3: p95 is the slowest sample)',
    );
  });

  it('treats a value exactly on the budget as within it', () => {
    expect(verdict(row(run('edge', [0, ...Array(20).fill(500)]), 'nav-inventory'))).toBe(
      'within budget',
    );
  });

  it('refuses to judge a row whose iterations failed: a timeout is the slowest result there is', () => {
    const file = run('broken', [0, ...Array(20).fill(100)]);
    file.samples[5] = sample('dashboard-to-inventory', 5, null, {
      ok: false,
      error: 'timeout:useful',
    });
    expect(verdict(row(file, 'nav-inventory'))).toBe('not judged: 1 of 20 iterations failed');
  });

  it('judges only the side of a budget the owner actually set', () => {
    const file = run('lcp', [1, 1, 1, 1], {}, 'hard-load-inventory');
    file.samples.forEach((s) => (s.lcpMs = 2400));
    expect(buildRunReport(file).markdown).toMatch(
      /Hard-load Inventory: LCP .*\| 2500 ms \/ none \| within budget/,
    );
  });
});

describe('buildRunReport', () => {
  const report = buildRunReport(run('before', [9000, ...range(400, 780, 20)]));

  it('labels the result type so lab, preview, production and field data are never confused', () => {
    expect(report.markdown).toContain('PRODUCTION SYNTHETIC');
    expect(report.markdown).toContain('not field/RUM data');
    expect(buildRunReport(run('lab', [1, 2], { kind: 'lab' })).markdown).toContain(
      'LAB (a machine we control)',
    );
    expect(buildRunReport(run('pre', [1, 2], { kind: 'preview-synthetic' })).markdown).toContain(
      'PREVIEW SYNTHETIC',
    );
    expect(buildRunReport(run('?', [1, 2], { kind: 'unknown-target' })).markdown).toContain(
      'UNKNOWN TARGET',
    );
  });

  it('prints real sample counts, failures and gaps on every row', () => {
    expect(report.markdown).toContain(
      '| Dashboard → Inventory | 20 / 20 | 0 | 0 | 580 ms | 680 ms | 760 ms | 400 ms | 780 ms | 500 ms / 1000 ms | OVER budget |',
    );
  });

  it('writes "not measured" for every cell of a scenario that has no data', () => {
    const line = report.markdown.split('\n').find((l) => l.startsWith('| Dashboard → Orders '))!;
    expect(line.match(/not measured/g)?.length).toBe(6);
  });

  it('reports the warm-up on its own, as a single observation', () => {
    expect(report.markdown).toContain('## First request of each scenario');
    expect(report.markdown).toMatch(
      /\| Dashboard → Inventory \| first request to a route in this run \(server: steady\) \| 9000 ms \|/,
    );
  });

  it('shouts when a deploy landed in the middle of the run', () => {
    expect(buildRunReport(run('mixed', [1, 2], { buildAtEnd: 'ffff' })).markdown).toContain(
      'BUILD CHANGED DURING THE RUN',
    );
  });

  it('says "not measured", never 0, for a metric the browser cannot report', () => {
    const file = run(
      'webkit',
      [1, 1, 1],
      { browser: 'webkit', unsupportedMetrics: ['layout-shift', 'longtask'] },
      'hard-load-inventory',
    );
    file.samples.forEach((s) => (s.cls = null));
    const out = buildRunReport(file).markdown;
    expect(out).toContain('This browser cannot report: layout-shift, longtask');
    expect(
      out.split('\n').find((l) => l.startsWith('| Hard-load Inventory: layout shift')),
    ).toContain('not measured');
  });

  it('draws no bar for a row without data, so a gap can never look like a fast result', () => {
    const BAR = /<rect x="400" y="\d+" width="[\d.]+" height="14"/g;
    expect(report.chartSvg.match(BAR)?.length).toBeGreaterThan(0);
    expect(report.chartSvg).toContain('not measured');
    expect(buildRunReport(run('empty', [])).chartSvg.match(BAR)).toBeNull();
  });

  it('gives each panel its own scale, so a 28 ms click is not an invisible sliver next to a 760 ms load', () => {
    const afterLabel = report.chartSvg.slice(
      report.chartSvg.indexOf('Click → visible response (sidebar, Inventory)'),
    );
    const width = Number(
      /<rect x="400" y="\d+" width="([\d.]+)" height="14"/.exec(afterLabel)?.[1],
    );
    // On one shared 0-780 ms axis this bar would be about 21 px wide.
    expect(width).toBeGreaterThan(80);
  });

  it('escapes text it puts into the SVG', () => {
    expect(buildRunReport(run('<script>&"', [1, 2])).chartSvg).not.toContain('<script>');
  });
});

describe('compareRuns', () => {
  const tight = (base: number) => [9000, ...range(base, base + 38, 2)];

  it('calls a clear p75 drop an improvement and a clear rise a regression', () => {
    expect(compared(run('b', tight(800)), run('a', tight(500)))).toMatchObject({
      result: 'improved',
    });
    expect(compared(run('b', tight(500)), run('a', tight(800)))).toMatchObject({
      result: 'regressed',
    });
  });

  it('flags a p95 that got 10% worse even when p75 improved (the owner trigger)', () => {
    const before = run('b', [0, ...Array(18).fill(800), 900, 900]);
    const after = run('a', [0, ...Array(18).fill(600), 1500, 1500]);
    // Never "improved". With 2 slow samples in 20 the tail cannot be proven, so
    // it is raised as a candidate to re-measure rather than asserted or dropped.
    expect(compared(before, after).result).toMatch(/^regression candidate \(p95\)/);
    // With enough samples for the tail to be unmistakable, it is asserted:
    // p75 still IMPROVES here (800 → 600), and the verdict is still "regressed".
    const bigBefore = run('b', [0, ...Array(36).fill(800), ...Array(4).fill(900)]);
    const bigAfter = run('a', [0, ...Array(30).fill(600), ...Array(10).fill(1500)]);
    expect(compared(bigBefore, bigAfter)).toMatchObject({
      result: 'regressed (p95)',
      deltaP75: -25,
    });
  });

  it('does not label two samples of the same noisy page', () => {
    const noisy = [
      656, 660, 677, 677, 695, 698, 703, 708, 715, 731, 740, 740, 756, 795, 819, 848, 935, 1022,
      2334, 4071,
    ];
    const shuffled = [...noisy.slice(7), ...noisy.slice(0, 7)].map(
      (v, i) => v + (i % 2 === 0 ? 45 : -35),
    );
    const out = compared(run('b', [0, ...noisy]), run('a', [0, ...shuffled]));
    expect(out.result).not.toBe('improved');
    expect(out.result).not.toMatch(/^regressed/);
  });

  it('ignores a change smaller than one frame, however large it is in percent', () => {
    const before = run('b', [0, ...Array(20).fill(20)], {}, 'dashboard-to-inventory');
    const after = run('a', [0, ...Array(20).fill(30)], {}, 'dashboard-to-inventory');
    expect(compared(before, after, 'click-inventory').result).toBeDefined();
    before.samples.forEach((s) => (s.feedbackPaintMs = 20));
    after.samples.forEach((s) => (s.feedbackPaintMs = 30));
    expect(compared(before, after, 'click-inventory').result).toBe('no material change');
  });

  it('reports a rise from a zero baseline as a regression, not as "not measured"', () => {
    const withPrefetches = (n: number) => {
      const file = run('x', [0, ...Array(20).fill(400)], {}, 'dashboard-to-orders');
      file.samples.forEach(
        (s) => (s.network = { prefetchRoutes: { '/dashboard/orders/[id]': n } } as never),
      );
      return file;
    };
    const out = compared(withPrefetches(0), withPrefetches(14), 'prefetch-order-rows');
    expect(out.result).toBe('regressed');
    expect(buildComparisonReport(withPrefetches(0), withPrefetches(14)).markdown).toContain(
      '+14 from 0',
    );
  });

  it('refuses a verdict when either side had failures, and says how many', () => {
    const after = run('a', tight(500));
    after.samples[3] = sample('dashboard-to-inventory', 3, null, {
      ok: false,
      error: 'timeout:useful',
    });
    expect(compared(run('b', tight(800)), after).result).toBe(
      'not comparable: 0 of 20 before and 1 of 20 after iterations failed',
    );
  });

  it('refuses to compute anything when one side was not measured, whichever side', () => {
    expect(compared(run('b', tight(800)), run('a', []))).toMatchObject({
      deltaP75: null,
      result: 'not measured',
    });
    expect(compared(run('b', []), run('a', tight(800)))).toMatchObject({
      deltaP75: null,
      result: 'not measured',
    });
  });

  it('does not call a wide interval "no change": it says what it cannot exclude', () => {
    const noisy = [
      0, 400, 420, 450, 480, 500, 520, 560, 600, 640, 700, 760, 820, 900, 980, 1050, 1150, 1300,
      1500, 1900, 2600,
    ];
    expect(compared(run('b', noisy), run('a', noisy)).result).toMatch(
      /^no change detected \(cannot exclude ±\d+%/,
    );
    const tightRun = [0, ...range(800, 838, 2)];
    expect(compared(run('b', tightRun), run('a', tightRun)).result).toBe('no material change');
  });

  it('refuses to compare click rows whose feedback was detected by different elements', () => {
    const after = run('a', [0, ...Array(20).fill(500)]);
    after.samples.forEach((s) => (s.feedbackBy = 'url-changed'));
    const before = run('b', [0, ...Array(20).fill(500)]);
    before.samples.forEach((s) => (s.feedbackBy = 'div > div[class*="nav-progress-climb"]'));
    expect(compared(before, after, 'click-inventory').result).toBe(
      'not comparable: click feedback was detected by progress bar before and URL change after',
    );
  });

  it('will not claim a change from too few samples to check for noise', () => {
    expect(compared(run('b', [0, 800, 810, 820]), run('a', [0, 400, 410, 420])).result).toMatch(
      /too few samples/,
    );
  });

  it('prints each row’s REAL n and failures, not the configured iteration count', () => {
    const after = run('a', tight(500).slice(0, 11), { iterations: 20 });
    const line = buildComparisonReport(run('b', tight(800)), after)
      .markdown.split('\n')
      .find((l) => l.startsWith('| Dashboard → Inventory |'))!;
    expect(line).toMatch(/^\| Dashboard → Inventory \| 20 \| .* \| 10 \|/);
  });
});

describe('environment parity', () => {
  it('passes when both runs were taken the same way', () => {
    expect(
      environmentMismatches(META, {
        ...META,
        label: 'after',
        buildAtStart: 'ffff',
        buildAtEnd: 'ffff',
        startedAt: 'x',
        finishedAt: 'y',
        rttMs: 46,
      }),
    ).toEqual({ hard: [], soft: [] });
  });

  it.each([
    'schemaVersion',
    'harnessVersion',
    'kind',
    'host',
    'browser',
    'viewport',
    'devicePixelRatio',
    'network',
    'role',
    'roleLabel',
    'dataset',
    'serverState',
    'hoverMs',
    'settleMs',
    'usefulTimeoutMs',
    'imageWaitMs',
  ] as const)('treats a different %s as unfair', (key) => {
    const out = environmentMismatches(META, { ...META, [key]: 'something-else' } as RunMeta);
    expect(out.hard.join(' ')).toContain(key);
  });

  it('goes by the MEASURED round trip, not only the typed network label', () => {
    expect(environmentMismatches(META, { ...META, rttMs: 140 }).hard.join(' ')).toMatch(
      /round trip/,
    );
    expect(environmentMismatches(META, { ...META, rttMs: 48 }).hard).toEqual([]);
    expect(environmentMismatches(META, { ...META, rttMs: null }).soft.join(' ')).toMatch(
      /not measured on both sides/,
    );
  });

  it('never accepts two unverified roles as "the same account"', () => {
    const out = environmentMismatches({ ...META, role: null }, { ...META, role: null });
    expect(out.hard.join(' ')).toMatch(/before run's account role was not verified/);
    expect(out.hard.join(' ')).toMatch(/after run's account role was not verified/);
  });

  it('treats a dataset that changed size as unfair, going by the MEASURED row count', () => {
    const before = run('before', [0, ...Array(10).fill(500)]);
    const after = run('after', [0, ...Array(10).fill(500)]);
    after.samples.forEach((s) => (s.listRows = 443));
    expect(buildComparisonReport(before, after).markdown).toMatch(
      /NOT A FAIR COMPARISON.*rows in the Inventory list: before 29, after 443/,
    );
  });

  it('mentions softer differences without voiding the comparison', () => {
    const out = environmentMismatches(META, { ...META, browserVersion: '154.0', iterations: 30 });
    expect(out.hard).toEqual([]);
    expect(out.soft.join(' ')).toMatch(/browserVersion/);
    expect(out.soft.join(' ')).toMatch(/iterations/);
  });

  it('opens the comparison with the warning, and names an A/A comparison for what it is', () => {
    const unfair = buildComparisonReport(
      run('before', [1, 2, 3]),
      run('after', [1, 2, 3], { host: 'localhost:3000', kind: 'lab' }),
    );
    expect(unfair.markdown).toContain('NOT A FAIR COMPARISON');
    expect(unfair.chartSvg).toContain('NOT A FAIR COMPARISON');
    const aa = buildComparisonReport(run('before', [1, 2, 3]), run('again', [1, 2, 3]));
    expect(aa.markdown).toContain('Same environment on both sides');
    expect(aa.markdown).toContain('This is an A/A comparison');
  });
});

describe('signed-URL stability', () => {
  const image = (object: string, token: string): ImageRecord =>
    ({
      objectFingerprint: object,
      tokenFingerprint: token,
      klass: { delivery: 'storage-signed', variant: 'thumb' },
    }) as ImageRecord;
  const withImages = (label: string, perSample: ImageRecord[][]): RunFile => {
    const file = run(label, [0, ...perSample.map(() => 500)]);
    perSample.forEach((images, i) => (file.samples[i + 1]!.photos = { images } as never));
    return file;
  };

  it('counts photos whose signed URL changed during one run', () => {
    const file = withImages('r', [
      [image('a', 't1'), image('b', 't1')],
      [image('a', 't2'), image('b', 't1')],
    ]);
    expect(rotationWithinRun(file)).toEqual({ objects: 2, rotated: 1 });
    expect(buildRunReport(file).markdown).toContain(
      'the signed URL of 1 of them CHANGED during the run',
    );
  });

  it('counts photos whose signed URL changed between two runs, and ignores photos seen in only one', () => {
    const before = withImages('b', [[image('a', 't1'), image('b', 't1'), image('c', 't1')]]);
    const after = withImages('a', [[image('a', 't1'), image('b', 't9'), image('z', 't1')]]);
    expect(rotationBetweenRuns(before, after)).toEqual({ shared: 2, sameToken: 1, rotated: 1 });
  });

  it('ignores the warm-up and unsigned images', () => {
    const file = withImages('r', [[image('a', 't1')]]);
    file.samples[0]!.photos = { images: [image('a', 'OTHER')] } as never;
    file.samples[1]!.photos!.images.push({ ...image('b', 't1'), tokenFingerprint: null });
    expect(rotationWithinRun(file)).toEqual({ objects: 1, rotated: 0 });
  });
});
