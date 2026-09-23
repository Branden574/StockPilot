import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The Items, Books and Orders pages must reveal ONCE.
 *
 * React holds every Suspense reveal until 300 ms after the previous one. With
 * a second <Suspense> around the table, rows could not appear before about
 * skeleton + 600 ms (measured 2026-09-22: minimum 631-663 ms on Dashboard ->
 * Inventory against 345-379 ms on Orders, which reveals once). The dataset
 * adopter's own `fallback={null}` boundary lives inside the table component,
 * not in these pages, and draws nothing.
 *
 * These routes have no loading.tsx either (the same 300 ms hold, applied to
 * their route skeleton): their skeleton is the late skeleton or, on a hard
 * load, the (dashboard) group's fallback. lib/navigation/late-skeleton-routes.guard.test.ts
 * pins which routes have a loading.tsx.
 */

const DASH = path.resolve(__dirname, '../../app/(dashboard)/dashboard');
const PAGES = [
  ['Items', path.join(DASH, 'inventory/page.tsx')],
  ['Books', path.join(DASH, 'books/page.tsx')],
  ['Orders', path.join(DASH, 'orders/page.tsx')],
] as const;

const codeOnly = (t: string) =>
  t.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

describe('list pages reveal once', () => {
  it.each(PAGES)('%s page has no Suspense boundary of its own', (_label, file) => {
    const code = codeOnly(readFileSync(file, 'utf8'));
    expect(code).not.toMatch(/<Suspense\b|<React\.Suspense\b/);
    expect(code).not.toContain('TableBodySkeleton');
  });
});
