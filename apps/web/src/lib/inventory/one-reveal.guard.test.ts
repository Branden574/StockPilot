import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The Items and Books pages must reveal ONCE under their loading.tsx.
 *
 * React holds every Suspense reveal until 300 ms after the previous one. With
 * a second <Suspense> around the table, rows could not appear before about
 * skeleton + 600 ms (measured 2026-09-22: minimum 631-663 ms on Dashboard ->
 * Inventory against 345-379 ms on Orders, which reveals once). The dataset
 * adopter's own `fallback={null}` boundary lives inside the table component,
 * not in these pages, and draws nothing.
 */

const DASH = path.resolve(__dirname, '../../app/(dashboard)/dashboard');
const PAGES = [
  ['Items', path.join(DASH, 'inventory/page.tsx')],
  ['Books', path.join(DASH, 'books/page.tsx')],
] as const;

const codeOnly = (t: string) =>
  t.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

describe('list pages reveal once', () => {
  it.each(PAGES)('%s page has no Suspense boundary of its own', (_label, file) => {
    const code = codeOnly(readFileSync(file, 'utf8'));
    expect(code).not.toMatch(/<Suspense\b|<React\.Suspense\b/);
    expect(code).not.toContain('TableBodySkeleton');
  });

  it.each(PAGES)('%s keeps its loading.tsx (the one reveal)', (_label, file) => {
    const loading = readFileSync(path.join(path.dirname(file), 'loading.tsx'), 'utf8');
    expect(loading).toContain('TablePageSkeleton');
  });
});
