import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The id-list modules are PURE: vitest imports them directly, and they are the
 * only place the fail-closed rules for these reads are proven. If one of them
 * (or anything it imports, transitively) pulled in ./supabase, the tests would
 * crash on expo-secure-store; if it pulled in ./image-cache, the same through
 * ./supabase. Screens pass `supabase` in; these modules never import it.
 */

const LIB = __dirname;

const PURE_MODULES = ['id-batches.ts', 'id-reads.ts', 'list-thumbnails.ts', 'order-stock-check.ts'];

const FORBIDDEN = [
  /^\.\/supabase$/,
  /^\.\/image-cache$/,
  /^@\/lib\/supabase$/,
  /^@\/lib\/image-cache$/,
  /^react-native($|\/)/,
  /^expo($|-)/,
  /^@react-native/,
];

function importsOf(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const out: string[] = [];
  for (const m of src.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/gm)) {
    out.push(m[1]!);
  }
  for (const m of src.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) out.push(m[1]!);
  return out;
}

function resolveRelative(from: string, spec: string): string | null {
  if (!spec.startsWith('./') && !spec.startsWith('../') && !spec.startsWith('@/')) return null;
  const base = spec.startsWith('@/')
    ? path.resolve(LIB, '..', spec.slice(2))
    : path.resolve(path.dirname(from), spec);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Every import reachable from `entry` through relative / @/ paths. */
function transitiveImports(entry: string): { file: string; spec: string }[] {
  const seen = new Set<string>();
  const out: { file: string; spec: string }[] = [];
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of importsOf(file)) {
      out.push({ file: path.relative(LIB, file), spec });
      const next = resolveRelative(file, spec);
      if (next) stack.push(next);
    }
  }
  return out;
}

describe('id-list modules stay pure', () => {
  for (const mod of PURE_MODULES) {
    it(`${mod} never reaches ./supabase, ./image-cache or a native module`, () => {
      const entry = path.join(LIB, mod);
      expect(existsSync(entry)).toBe(true);
      const bad = transitiveImports(entry).filter(({ spec }) => FORBIDDEN.some((re) => re.test(spec)));
      expect(bad).toEqual([]);
    });
  }

  it('the check itself sees a forbidden import (it would pass vacuously otherwise)', () => {
    const bad = transitiveImports(path.join(LIB, 'image-cache.ts')).filter(({ spec }) =>
      FORBIDDEN.some((re) => re.test(spec)),
    );
    expect(bad.map((b) => b.spec)).toContain('./supabase');
  });
});
