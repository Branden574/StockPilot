/**
 * Guard for SP-107 (2026-09 codebase sweep).
 *
 * WHY: packages/config/package.json shipped from the initial scaffold declaring
 * `"main": "./index.js"`, `"types": "./index.d.ts"` and a `files` entry for
 * `tailwind-preset.ts` — three paths that never existed in this repo
 * (`git log --all -- packages/config/index.js packages/config/tailwind-preset.ts`
 * is empty). Nothing resolved through them (both consumers use the `exports`
 * subpaths `./tsconfig` and `./eslint`, and the package is `private: true` so
 * `files` is never packed), so the lie sat there for months.
 *
 * WHAT STOPS IT NOW: every path this manifest advertises — main, types, each
 * `files` entry and each `exports` target — must exist on disk. Re-adding a
 * pointer to a file that isn't there fails this test instead of waiting for a
 * confusing MODULE_NOT_FOUND (or a silently-wrong `npm pack`) later.
 *
 * Runner is node:test, not vitest, on purpose: this package has no dependencies
 * and adding a test framework to it would be more machinery than the guard.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));

/** Every string an `exports` map can bottom out in, whatever shape it uses. */
function collectExportTargets(node, out = []) {
  if (typeof node === 'string') {
    out.push(node);
  } else if (Array.isArray(node)) {
    for (const entry of node) collectExportTargets(entry, out);
  } else if (node && typeof node === 'object') {
    for (const entry of Object.values(node)) collectExportTargets(entry, out);
  }
  return out;
}

function declaredPaths() {
  const declared = [];
  if (pkg.main) declared.push(['main', pkg.main]);
  if (pkg.types) declared.push(['types', pkg.types]);
  if (pkg.module) declared.push(['module', pkg.module]);
  for (const entry of pkg.files ?? []) declared.push(['files', entry]);
  for (const target of collectExportTargets(pkg.exports)) declared.push(['exports', target]);
  return declared;
}

test('every path package.json advertises actually exists', () => {
  const missing = declaredPaths()
    .filter(([, p]) => !p.includes('*') && !existsSync(join(here, p)))
    .map(([field, p]) => `${field}: ${p}`);

  assert.deepEqual(
    missing,
    [],
    `packages/config/package.json points at files that do not exist:\n  ${missing.join('\n  ')}`,
  );
});

test('the subpath exports consumers actually extend are present', () => {
  // apps/web/tsconfig.json and packages/core/tsconfig.json both do
  // `extends: "@stockpilot/config/tsconfig"`. Dropping either subpath breaks
  // typecheck across the monorepo, so pin them literally.
  assert.equal(pkg.exports['./tsconfig'], './tsconfig.base.json');
  assert.equal(pkg.exports['./eslint'], './eslint-preset.js');
});
