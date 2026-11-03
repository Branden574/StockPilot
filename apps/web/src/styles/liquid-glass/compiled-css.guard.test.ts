// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import tailwindcss from '@tailwindcss/postcss';
import postcss, { type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

import {
  GLASS_ROOT,
  inKeyframes,
  inMedia,
  isClassicHideRule,
  normaliseQuotes,
  splitSelectors,
} from './glass-css';

/**
 * THE COMPILED-CSS GUARD (Liquid Glass plan 4.7 item 1, review finding R5).
 * The source guard reads styles/liquid-glass; this one reads what the browser
 * gets, so glass styling that reached the output by any other route fails too:
 *   - globals.css compiled through Tailwind exactly as the app builds it, plus
 *     the unlayered companion globals.glass.css (always);
 *   - every stylesheet `next build` emitted under .next/static (webpack writes
 *     them to css/, Turbopack to chunks/; when a build is present: run it
 *     after `pnpm --filter web build`).
 * It fails when a rule that selects data-appearance or data-glass is outside
 * @media screen (the print rule: @media print; the classic hide rule: by
 * text), or when a rule selects [data-glass...] without the glass root.
 */

const WEB = join(__dirname, '..', '..', '..');
const GLOBALS = join(WEB, 'src', 'app', 'globals.css');
const COMPANION = join(__dirname, 'globals.glass.css');
const NEXT_STATIC = join(WEB, '.next', 'static');
const NEXT_CSS_DIRS = ['css', 'chunks'].map((d) => join(NEXT_STATIC, d));

/** Every offending selector in a compiled stylesheet, with why. */
function glassLeaks(css: string): string[] {
  const out: string[] = [];
  postcss.parse(css).walkRules((rule: Rule) => {
    if (inKeyframes(rule)) return;
    for (const raw of splitSelectors(rule.selector)) {
      const selector = normaliseQuotes(raw);
      if (!/data-appearance|data-glass|data-classic-only/.test(selector)) continue;
      if (isClassicHideRule(selector)) continue;
      if (selector === '[data-glass-only]') {
        if (!inMedia(rule, 'print')) out.push(`${selector}: outside @media print`);
        continue;
      }
      if (!GLASS_ROOT.test(selector)) out.push(`${selector}: not scoped to the glass root`);
      else if (!inMedia(rule, 'screen')) out.push(`${selector}: outside @media screen`);
    }
  });
  return out;
}

async function compileGlobals(): Promise<string> {
  const input = readFileSync(GLOBALS, 'utf8').replace(
    "@import 'tailwindcss';",
    "@import 'tailwindcss' source(none);",
  );
  const { css } = await postcss([tailwindcss({ optimize: false })]).process(input, {
    from: GLOBALS,
  });
  return `${css}\n${readFileSync(COMPANION, 'utf8')}`;
}

describe('compiled CSS guard', () => {
  it('a planted leak fails it', () => {
    expect(
      glassLeaks(
        '[data-glass=card]{color:red}' +
          '@media print{:root[data-appearance=liquid-glass] .x{color:red}}' +
          '[data-glass-only]{display:none}' +
          // The classic hide rule as a minifier writes it (no quotes) is allowed.
          ':root:not([data-appearance=liquid-glass]) [data-glass-only]{display:none}',
      ),
    ).toEqual([
      '[data-glass=card]: not scoped to the glass root',
      ':root[data-appearance=liquid-glass] .x: outside @media screen',
      '[data-glass-only]: outside @media print',
    ]);
  });

  it('globals.css as Tailwind builds it, plus the unlayered companion, has no glass leak', async () => {
    const css = await compileGlobals();
    expect(css).toContain('data-appearance');
    expect(glassLeaks(css)).toEqual([]);
  });

  it('the glass layer comes after Tailwind’s utilities layer', async () => {
    const css = await compileGlobals();
    const order = css.indexOf('@layer theme, base, components, utilities;');
    const lg = css.indexOf('@layer lg');
    expect(order).toBeGreaterThanOrEqual(0);
    expect(lg).toBeGreaterThan(order);
  });

  const built = NEXT_CSS_DIRS.flatMap((dir) =>
    existsSync(dir)
      ? readdirSync(dir, { recursive: true })
          .map(String)
          .filter((f) => f.endsWith('.css'))
          .map((f) => join(dir, f))
      : [],
  );
  it.runIf(built.length > 0)(
    `every stylesheet next build emitted (.next/static, ${built.length} files) has no glass leak`,
    () => {
      const leaks = built.flatMap((f) =>
        glassLeaks(readFileSync(f, 'utf8')).map((l) => `${f}: ${l}`),
      );
      expect(leaks).toEqual([]);
      const all = built.map((f) => readFileSync(f, 'utf8')).join('\n');
      expect(all).toMatch(/data-appearance=["']?liquid-glass/);
    },
  );
});
