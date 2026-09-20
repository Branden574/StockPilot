import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { test } from '@playwright/test';

import { buildComparisonReport, type RunFile } from '../../src/lib/perf/report';

/**
 * Before/after report from two saved runs. No browser is opened; this rides on
 * Playwright only because it already runs this repo's TypeScript.
 *
 *   PERF_BEFORE=perf-results/<run> PERF_AFTER=perf-results/<run> pnpm perf:compare
 *
 * Writes comparison.md and comparison.svg into the AFTER folder. If the two
 * runs were not taken in the same environment, the report opens by saying so.
 */
test('before / after comparison', () => {
  const before = process.env.PERF_BEFORE;
  const after = process.env.PERF_AFTER;
  test.skip(!before || !after, 'Set PERF_BEFORE and PERF_AFTER to two results folders.');

  const load = (dir: string) =>
    JSON.parse(readFileSync(path.join(dir, 'results.json'), 'utf8')) as RunFile;
  const report = buildComparisonReport(load(before as string), load(after as string));
  writeFileSync(path.join(after as string, 'comparison.md'), report.markdown);
  writeFileSync(path.join(after as string, 'comparison.svg'), report.chartSvg);
  console.info(`\n${report.markdown}`);
});
