import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { test } from '@playwright/test';

import { buildComparisonReport, parseRunFile } from '../../src/lib/perf/report';

/**
 * Before/after report from two saved runs. No browser is opened; this rides on
 * Playwright only because it already runs this repo's TypeScript.
 *
 *   PERF_BEFORE=perf-results/<run> PERF_AFTER=perf-results/<run> \\
 *   PERF_DRIFT_A=perf-results/<baseline A> PERF_DRIFT_B=perf-results/<baseline B> pnpm perf:compare
 *
 * Writes comparison.md and comparison.svg into the AFTER folder. If the two
 * runs were not taken in the same environment, the report opens by saying so.
 */
test('before / after comparison', () => {
  const before = process.env.PERF_BEFORE;
  const after = process.env.PERF_AFTER;
  test.skip(!before || !after, 'Set PERF_BEFORE and PERF_AFTER to two results folders.');

  const load = (dir: string, name: string) =>
    parseRunFile(JSON.parse(readFileSync(path.join(dir, 'results.json'), 'utf8')), name);
  // Optional A/A pair: two runs of ONE build. With it, a change no bigger than
  // the same-build drift of its row is reported as drift, not as a result.
  const driftA = process.env.PERF_DRIFT_A;
  const driftB = process.env.PERF_DRIFT_B;
  const drift =
    driftA && driftB ? { a: load(driftA, 'drift A'), b: load(driftB, 'drift B') } : undefined;
  const report = buildComparisonReport(
    load(before as string, 'before'),
    load(after as string, 'after'),
    drift,
  );
  writeFileSync(path.join(after as string, 'comparison.md'), report.markdown);
  writeFileSync(path.join(after as string, 'comparison.svg'), report.chartSvg);
  console.info(`\n${report.markdown}`);
});
