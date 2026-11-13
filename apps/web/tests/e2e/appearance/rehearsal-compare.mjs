#!/usr/bin/env node
/**
 * Plan 8.2 case 12 (R15), the rehearsal's verdict: off -> opt-in -> default
 * -> opt-in -> off "leaves device records and the account row
 * byte-identical". Compares, in the folder given:
 *   rehearsal-<n>-<rollout>.json   the device snapshot default-rollout.spec.ts
 *                                  writes at each step (STAGE5_PHASE=rehearsal-<n>)
 *   account-row-<n>-<rollout>.txt  the runner's psql dump of the lab user's
 *                                  public.user_appearance row after that step
 *                                  (empty when there is no row)
 * for n = 1..5 (off, opt-in, default, opt-in, off): every snapshot's compared
 * part (the Design cookie, the device keys, the tab's keys; not the account
 * sync record) and every row dump byte-identical to step 1's.
 *
 * Lab command (run-stage5.sh runs it after the fifth build's step):
 *   node apps/web/tests/e2e/appearance/rehearsal-compare.mjs "$STAGE5_STATE_DIR"
 * Exit 0 pass, 1 a finding, 2 a usage error.
 *
 * Reads files only. The rules live in stage5a-records.ts (unit test:
 * src/test/stage5a-records.test.ts), loaded with Node's type stripping.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const { checkRehearsal } = await import(`${here}stage5a-records.ts`);

const dir = process.argv[2];
if (!dir || process.argv.length > 3) {
  console.error('usage: rehearsal-compare.mjs <STAGE5_STATE_DIR>');
  process.exit(2);
}

const files = new Map();
for (const name of readdirSync(dir)) {
  if (/^(rehearsal|account-row)-\d-[a-z-]+\.(json|txt)$/u.test(name)) {
    files.set(name, readFileSync(join(dir, name), 'utf8'));
  }
}
const findings = checkRehearsal(files);
if (findings.length) {
  console.info(`FAIL (${findings.length}):`);
  for (const line of findings) console.info(`  ${line}`);
  process.exit(1);
}
console.info(
  'PASS: device records and the account row are byte-identical across off, opt-in, default, opt-in, off',
);
