#!/usr/bin/env node
/**
 * Plan 8.5-6: the `next build` route table of the branch against the merge
 * base's (classic at B, 7dacbd7aa). Fails on any existing route whose
 * static/dynamic marker changed or that the branch lost; lists the routes
 * the branch adds (the glass-site twins and /api/appearance/style are
 * expected; anything else is printed as unexpected for a person to read).
 *
 * Lab command (run-stage5.sh runs it on the saved build logs):
 *   node apps/web/tests/e2e/appearance/route-table-compare.mjs <B build log> <branch build log> [--json <out>]
 * Exit 0 pass, 1 a finding, 2 a usage error.
 *
 * Reads two files and nothing else (no network, no build). The rules live in
 * stage5a-route-table.ts (unit test: src/test/stage5a-route-table.test.ts),
 * loaded with Node's type stripping (Node 22.18 and later).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const { parseRouteTable, compareRouteTables, routeTableFails } = await import(
  `${here}stage5a-route-table.ts`
);

const args = process.argv.slice(2);
const jsonAt = args.indexOf('--json');
const jsonOut = jsonAt >= 0 ? args[jsonAt + 1] : undefined;
const files = jsonAt >= 0 ? args.filter((_, i) => i !== jsonAt && i !== jsonAt + 1) : args;
if (files.length !== 2 || (jsonAt >= 0 && !jsonOut)) {
  console.error('usage: route-table-compare.mjs <B build log> <branch build log> [--json <out>]');
  process.exit(2);
}

const base = parseRouteTable(readFileSync(files[0], 'utf8'));
const branch = parseRouteTable(readFileSync(files[1], 'utf8'));
const comparison = compareRouteTables(base, branch);
const findings = routeTableFails(base, branch, comparison);

console.info(`routes: B ${base.size}, branch ${branch.size}`);
console.info(`added on the branch (${comparison.added.length}):`);
for (const route of comparison.added) {
  console.info(`  ${route}${comparison.unexpectedAdded.includes(route) ? '   (unexpected)' : ''}`);
}
if (findings.length) {
  console.info(`FAIL (${findings.length}):`);
  for (const line of findings) console.info(`  ${line}`);
} else {
  console.info('PASS: every existing route keeps its marker');
}
if (jsonOut) {
  writeFileSync(
    jsonOut,
    `${JSON.stringify({ baseRoutes: base.size, branchRoutes: branch.size, ...comparison, findings }, null, 2)}\n`,
  );
}
process.exit(findings.length ? 1 : 0);
