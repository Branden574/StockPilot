import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { classicHash, projectionLeaks } from '../__fixtures__/classic-projection';

/**
 * CLASSIC IS UNCHANGED WHERE LIQUID GLASS DRAWS SOMETHING ELSE (stage 4).
 *
 * Every phone file that draws a Liquid Glass difference reads the look once
 * as `const lg = useGlass();` and writes each difference as a branch on it.
 * For each such file, this pins the hash of its CLASSIC PROJECTION (every
 * `lg` branch folded to Classic; lib/__fixtures__/classic-projection.ts, with
 * its own tests in lib/classic-projection.test.ts) to the hash of the same
 * file before Liquid Glass, at b64bd37cc (feat/liquid-glass, stage 3 merged,
 * where this lane started). Equal hashes mean the code Classic runs is that
 * very code: the same elements, props, styles, strings and order, so Classic
 * (the Classic design under the rollout's default, and every phone under
 * EXPO_PUBLIC_LIQUID_GLASS=off) draws as it did.
 *
 * A pin changes only when Classic itself is meant to change (a fix that
 * lands on main and is merged here): recompute it then, with the reason in
 * the commit. Never to make a glass change pass.
 */

const MOBILE_ROOT = path.resolve(__dirname, '../../..');

/** File (from apps/mobile) -> classic-projection SHA-256 of that file at b64bd37cc. */
export const CLASSIC_PINS: Readonly<Record<string, string>> = {};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

const rel = (f: string) => path.relative(MOBILE_ROOT, f).split(path.sep).join('/');
const code = (f: string) =>
  readFileSync(f, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const SOURCES = [...walk(path.join(MOBILE_ROOT, 'app')), ...walk(path.join(MOBILE_ROOT, 'src'))]
  .filter((f) => !f.includes(`${path.sep}__fixtures__${path.sep}`))
  .map(rel);

describe('Classic projection pins', () => {
  it('every file that draws a Liquid Glass difference is pinned (none escapes the proof)', () => {
    const drawers = SOURCES.filter((f) => /\buseGlass\(\)/.test(code(path.join(MOBILE_ROOT, f))))
      .filter((f) => f !== 'src/components/ui/glass/use-glass.ts')
      // The glass primitives draw only glass; Classic never renders them.
      .filter((f) => !f.startsWith('src/components/ui/glass/'))
      .sort();
    expect(drawers).toEqual(Object.keys(CLASSIC_PINS).sort());
  });

  it('the look is read one way only: const lg = useGlass()', () => {
    for (const f of Object.keys(CLASSIC_PINS)) {
      const src = code(path.join(MOBILE_ROOT, f));
      const calls = src.match(/\buseGlass\(\)/g) ?? [];
      const bound = src.match(/\bconst lg = useGlass\(\);/g) ?? [];
      expect(bound.length, f).toBe(calls.length);
      expect(calls.length, f).toBeGreaterThan(0);
    }
  });

  for (const [file, pinned] of Object.entries(CLASSIC_PINS)) {
    it(`${file}: Classic is the code it was before Liquid Glass`, () => {
      const src = readFileSync(path.join(MOBILE_ROOT, file), 'utf8');
      expect(projectionLeaks(src, file)).toEqual([]);
      expect(classicHash(src, file)).toBe(pinned);
    });
  }
});
