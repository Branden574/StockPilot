import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * RECURRENCE GUARD (Liquid Glass plan 2.2, 4.6): no page branches its render on
 * the appearance. A page that rendered one tree in classic and another in glass
 * would unmount every stateful leaf (typed values, selection, open dialogs) on
 * a switch, and a server read of the cookie would make static pages dynamic.
 * So useAppearance() may be imported only by the appearance modules, the
 * selectors and the error-boundary recovery; no file outside
 * components/theme reads the sp_appearance cookie or the data-appearance
 * attribute, except the dashboard's own sidebar breakpoint helper when it
 * arrives (stage 3) and the error boundaries through components/theme.
 */

const SRC = join(__dirname, '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** The code without its comments (several comments explain the appearance). */
const withoutComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const FILES = walk(SRC).map((f) => ({
  file: relative(SRC, f),
  text: withoutComments(readFileSync(f, 'utf8')),
}));

const MAY_USE_APPEARANCE = new Set([
  'components/theme/appearance-provider.tsx',
  'components/theme/appearance-select.tsx',
  'components/theme/appearance-recovery.tsx',
]);

describe('appearance render guard', () => {
  it('finds the source tree', () => {
    expect(FILES.length).toBeGreaterThan(500);
  });

  it('useAppearance() is used only by the appearance modules, the selectors and the recovery', () => {
    const users = FILES.filter(({ text }) => /\buseAppearance\b/.test(text)).map((f) => f.file);
    expect(users.filter((f) => !MAY_USE_APPEARANCE.has(f))).toEqual([]);
  });

  it('no server code or page reads the appearance cookie or attribute', () => {
    const readers = FILES.filter(
      ({ file, text }) =>
        !file.startsWith('components/theme/') &&
        !file.startsWith('styles/liquid-glass/') &&
        (/sp_appearance/.test(text) || /data-appearance/.test(text)),
    ).map((f) => f.file);
    expect(readers).toEqual([]);
  });

  it('no layout or page reads cookies() for the appearance', () => {
    const offenders = FILES.filter(
      ({ file, text }) =>
        /(^|\/)(layout|page)\.tsx$/.test(file) &&
        /cookies\(\)/.test(text) &&
        /appearance/i.test(text),
    ).map((f) => f.file);
    expect(offenders).toEqual([]);
  });

  it('appearance is never part of a data read, query key or channel name', () => {
    const offenders = FILES.filter(
      ({ file, text }) =>
        (file.startsWith('lib/') || file.startsWith('server/')) &&
        file !== 'server/actions/appearance.ts' &&
        /appearance/i.test(text),
    ).map((f) => f.file);
    expect(offenders).toEqual([]);
  });
});
