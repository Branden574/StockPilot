import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Dashboard page titles do not name the product.
 *
 * The (dashboard) group layout gives every page under it the title template
 * '%s · StockPilot', so a page whose own title already ends in StockPilot
 * showed "Location · StockPilot · StockPilot" in the browser tab (seen on the
 * local server for the location, exception and briefing pages). A page gives
 * only its own name ("Location") and the template adds the rest.
 *
 * This reads each page and layout under app/(dashboard)/dashboard and checks
 * the string literal of its static `metadata` title.
 */

const GROUP = path.resolve(__dirname, '../../app/(dashboard)');
const DASH = path.join(GROUP, 'dashboard');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/^(page|layout)\.tsx$/.test(name)) out.push(full);
  }
  return out;
}

/** The title literal of `export const metadata ... = { ... title: '...' }`. */
function staticTitle(source: string): string | null {
  const m = source.match(
    /export const metadata\b[^=]*=\s*\{[^}]*?\btitle:\s*(['"`])((?:(?!\1).)*)\1/s,
  );
  return m ? m[2]! : null;
}

describe('dashboard page titles', () => {
  it('the (dashboard) layout adds " · StockPilot" to every page title', () => {
    const layout = readFileSync(path.join(GROUP, 'layout.tsx'), 'utf8');
    expect(layout).toMatch(/template:\s*'%s · StockPilot'/);
  });

  it('reads the static titles it checks (the pattern still matches the pages)', () => {
    const titled = walk(DASH).filter((f) => staticTitle(readFileSync(f, 'utf8')) !== null);
    expect(titled.length).toBeGreaterThan(20);
    const location = path.join(DASH, 'locations/[id]/page.tsx');
    expect(staticTitle(readFileSync(location, 'utf8'))).toBe('Location');
  });

  it('no page title names StockPilot itself (the template would add it twice)', () => {
    const doubled = walk(DASH)
      .map((f) => ({
        file: path.relative(DASH, f).split(path.sep).join('/'),
        title: staticTitle(readFileSync(f, 'utf8')),
      }))
      .filter((r) => r.title !== null && /stockpilot/i.test(r.title));
    expect(doubled).toEqual([]);
  });
});
