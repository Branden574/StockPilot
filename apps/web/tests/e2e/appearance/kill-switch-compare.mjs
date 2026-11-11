#!/usr/bin/env node
/**
 * Plan 8.2 case 11 (D12, R5), the kill switch's verdict after the three
 * phased runs (kill-record, kill-off, kill-back): each phase writes
 * kill-switch-<phase>-done.json to STAGE5_STATE_DIR as its last step, only
 * when all of its checks passed. A phase that skipped (a wrong phase name, a
 * role the spec does not run as) or failed leaves no file, so this script
 * fails where Playwright's exit 0 ("all passed or skipped") would not.
 *
 * Lab command (after the third phase):
 *   node apps/web/tests/e2e/appearance/kill-switch-compare.mjs "$STAGE5_STATE_DIR"
 * Exit 0 pass, 1 a finding, 2 a usage error.
 *
 * Reads file names only. The rule lives in stage5a-records.ts (unit test:
 * src/test/stage5a-records.test.ts), loaded with Node's type stripping.
 */
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const { checkKillSwitch } = await import(`${here}stage5a-records.ts`);

const dir = process.argv[2];
if (!dir || process.argv.length > 3) {
  console.error('usage: kill-switch-compare.mjs <STAGE5_STATE_DIR>');
  process.exit(2);
}

const findings = checkKillSwitch(readdirSync(dir));
if (findings.length) {
  console.info(`FAIL (${findings.length}):`);
  for (const line of findings) console.info(`  ${line}`);
  process.exit(1);
}
console.info('PASS: kill-record, kill-off and kill-back each ran to its end');
