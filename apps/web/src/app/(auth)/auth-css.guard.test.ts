import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The auth shell's own stylesheet (P2.1 moved it out of globals.css; P5.1 owns
 * it). These pins keep the rules that make it work and the redesign's flat
 * ground:
 *  - every animation it names has its @keyframes (CONFLICTS D32: the error
 *    line animated with `auth-err`, which was defined nowhere);
 *  - it stays outside every cascade layer, or Tailwind's layered utilities
 *    would override the auth focus and error rules;
 *  - it is imported once, by the auth layout, and globals.css holds no auth
 *    rule of its own any more;
 *  - the ground is flat: no gradient anywhere in the auth shell.
 */

const HERE = __dirname;
const SRC = join(HERE, '..', '..');
const css = readFileSync(join(HERE, 'auth.css'), 'utf8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const rules = stripComments(css);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|css)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe('app/(auth)/auth.css', () => {
  it('defines a @keyframes for every animation it names (CONFLICTS D32)', () => {
    const defined = new Set([...rules.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]));
    const used = new Set<string>();
    for (const m of rules.matchAll(/animation(?:-name)?\s*:\s*([^;}]+)/g)) {
      for (const part of m[1]!.split(',')) {
        const name = part
          .trim()
          .split(/\s+/)
          .find(
            (t) =>
              /^[a-z][\w-]*$/i.test(t) &&
              !/^(none|infinite|forwards|backwards|both|ease(-in|-out|-in-out)?|linear|alternate|reverse|normal|running|paused|!important)$/.test(
                t,
              ),
          );
        if (name) used.add(name);
      }
    }
    expect(used.has('auth-err')).toBe(true);
    for (const name of used) expect(defined.has(name), `@keyframes ${name}`).toBe(true);
  });

  it('turns the error-line animation off under reduced motion', () => {
    const reduced = [
      ...rules.matchAll(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/g),
    ]
      .map((m) => m[1])
      .join('\n');
    expect(reduced).toMatch(/\.auth-msg:not\(:empty\)[\s\S]*?animation:\s*none/);
  });

  it('stays unlayered', () => {
    expect(rules).not.toMatch(/@layer\b/);
  });

  it('draws a flat ground: no gradient, mesh or blur', () => {
    expect(rules).not.toMatch(/gradient\(|backdrop-filter|blur\(/);
    expect(rules).not.toMatch(/auth-visual-ground/);
  });

  it('is imported once, by the auth layout, and globals.css has no auth rule', () => {
    const importers = walk(SRC).filter((p) =>
      /['"](\.\/|.*\/)auth\.css['"]/.test(readFileSync(p, 'utf8')),
    );
    expect(importers.map((p) => p.slice(SRC.length + 1))).toEqual([
      join('app', '(auth)', 'layout.tsx'),
    ]);
    const globals = stripComments(readFileSync(join(SRC, 'app', 'globals.css'), 'utf8'));
    expect(globals).not.toMatch(/\.(auth|af)-[\w-]+\s*[{,:]/);
  });
});
