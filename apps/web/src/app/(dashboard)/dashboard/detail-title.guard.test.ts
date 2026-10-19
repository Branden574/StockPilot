import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * A DETAIL PAGE'S TITLE IS NEVER SQUEEZED OUT BY ITS ACTIONS (walk after
 * F2-3, found on the order page and then on every page built the same way).
 *
 * These pages put the title column (`min-w-0 flex-1`, holding a truncating
 * h1) beside their actions in a wrapping flex row. With flex-1 alone the
 * column's basis is 0, so the row never wraps: the actions keep their width
 * and the title gets what is left. Measured at 390 px: the order's title read
 * "Or...", a bundle's title had 0 px, a maintenance request's number and a
 * procedure's title were cut; beside the sidebar at 768 px the bundle and the
 * procedure were cut too. `basis-72` makes the column ask for 18rem before the
 * actions may share its line, so they wrap under the title instead.
 *
 * jsdom has no layout: this pins the rule on every such page, and the
 * browser walk measures the widths.
 */
const ROOT = path.resolve(__dirname);

function pages(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...pages(abs));
    else if (name === 'page.tsx') out.push(abs);
  }
  return out;
}

/** Every title column: a `min-w-0 flex-1` div whose first element row holds a truncating h1. */
function titleColumns(src: string): string[] {
  const found: string[] = [];
  const re = /<div className="(min-w-0 flex-1[^"]*)"[^>]*>\s*<div className="[^"]*">\s*<h1 className="truncate /g;
  for (const m of src.matchAll(re)) found.push(m[1]!);
  return found;
}

describe('detail titles have room before their actions share the line', () => {
  const all = pages(ROOT).map((abs) => ({ file: path.relative(ROOT, abs), columns: titleColumns(readFileSync(abs, 'utf8')) }));
  const withColumns = all.filter((p) => p.columns.length > 0);

  it('finds the pages built this way (the sweep is not vacuous)', () => {
    expect(withColumns.map((p) => p.file).sort()).toEqual(
      expect.arrayContaining([
        'bundles/[id]/page.tsx',
        'maintenance/[id]/page.tsx',
        'procedures/[id]/page.tsx',
      ]),
    );
  });

  it('every title column asks for 18rem (basis-72)', () => {
    const wrong = withColumns.flatMap((p) =>
      p.columns.filter((c) => !c.split(/\s+/).includes('basis-72')).map((c) => `${p.file}: "${c}"`),
    );
    expect(wrong).toEqual([]);
  });

  // Pages whose title column moved into the shared PageHeader in the
  // redesign (P4.B1: the order page). PageHeader's title block is not a
  // flex-1 column: it takes its own width and the actions row wraps under it,
  // and its h1 wraps instead of truncating, so the title cannot be squeezed
  // out. This keeps the rule on those pages: the header is PageHeader and no
  // truncating h1 came back beside it.
  const MOVED_TO_PAGE_HEADER_P4_B1 = ['orders/[id]/page.tsx'];

  it('the order page renders its title through PageHeader, never a truncating h1', () => {
    for (const file of MOVED_TO_PAGE_HEADER_P4_B1) {
      const src = readFileSync(path.join(ROOT, file), 'utf8');
      expect(src, file).toMatch(/<PageHeader\b/);
      expect(src, file).not.toMatch(/<h1\b/);
      expect(titleColumns(src), file).toEqual([]);
    }
  });
});
