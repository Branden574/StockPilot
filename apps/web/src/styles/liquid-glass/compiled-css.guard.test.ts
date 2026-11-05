// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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
 *   - globals.css, the companion and every page composition put through the
 *     two minifiers a production build runs (always; see
 *     minifiedForProduction), so a fold the minifiers make is caught before
 *     a build;
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

/**
 * The two minifiers a production build runs on a stylesheet, run here without
 * the build. First Tailwind's PostCSS plugin as the build runs it: with
 * NODE_ENV production it optimizes with Lightning CSS, which joins
 * neighbouring rules that have the same declarations into one list, and it
 * leaves a file with no Tailwind at-rule alone. Then Lightning CSS with Next's
 * default browser targets, which the bundler minifies with (the app sets no
 * browserslist). Firefox 111 is among those targets and has no :has(), so a
 * selector list that holds :has() comes out as one :is() that starts outside
 * the glass root, which also gives every selector in the list the :has()
 * selector's specificity. Lightning CSS is Tailwind's own copy, so the app
 * takes no new dependency.
 */
interface LightningCss {
  transform(options: {
    filename: string;
    code: Uint8Array;
    minify: boolean;
    targets: Record<string, number>;
  }): { code: Uint8Array };
  browserslistToTargets(browsers: string[]): Record<string, number>;
}
const fromWeb = createRequire(join(WEB, 'package.json'));
const fromTailwind = createRequire(fromWeb.resolve('@tailwindcss/postcss'));
const lightningcss = createRequire(fromTailwind.resolve('@tailwindcss/node'))(
  'lightningcss',
) as LightningCss;
const NEXT_DEFAULT_BROWSERS = fromWeb(
  'next/dist/shared/lib/modern-browserslist-target.js',
) as string[];
const PAGES = join(__dirname, 'pages');

async function minifiedForProduction(from: string, input: string): Promise<string> {
  const { css } = await postcss([tailwindcss({ optimize: true })]).process(input, { from });
  const { code } = lightningcss.transform({
    filename: from,
    code: new TextEncoder().encode(css),
    minify: true,
    targets: lightningcss.browserslistToTargets(NEXT_DEFAULT_BROWSERS),
  });
  return new TextDecoder().decode(code);
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

  it('a list holding :has(), or a :has() rule next to one with the same declarations, comes out of the production minifiers as a leak', async () => {
    const R = ":root[data-appearance='liquid-glass']";
    // A path of its own: the plugin caches its compiler by file.
    const planted = join(WEB, 'src', 'app', 'planted-minifier-check.css');
    // A list, in a file Tailwind leaves alone: the bundler's pass folds it.
    const list = await minifiedForProduction(
      planted,
      `@media screen { ${R} [data-glass='a']:has([data-glass='b']), ${R} [data-glass='c'] { color: red } }`,
    );
    // Two neighbours, in a file Tailwind compiles: its pass joins them, the bundler's folds them.
    const neighbours = await minifiedForProduction(
      planted,
      `@import 'tailwindcss' source(none);\n@media screen { ${R} [data-glass='c'] { color: red } ${R} [data-glass='a']:has([data-glass='b']) { color: red } }`,
    );
    for (const css of [list, neighbours]) {
      expect(glassLeaks(css)).toEqual([
        expect.stringMatching(/^:is\(.*\): not scoped to the glass root$/u),
      ]);
    }
  });

  it('every glass stylesheet, minified as a production build minifies it, has no glass leak', async () => {
    // The simulation holds while the app keeps Next's default browser targets.
    const pkg = JSON.parse(readFileSync(join(WEB, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(pkg.browserslist).toBeUndefined();
    expect(existsSync(join(WEB, '.browserslistrc'))).toBe(false);
    const sheets: [string, string][] = [
      [
        GLOBALS,
        readFileSync(GLOBALS, 'utf8').replace(
          "@import 'tailwindcss';",
          "@import 'tailwindcss' source(none);",
        ),
      ],
      [COMPANION, readFileSync(COMPANION, 'utf8')],
      ...readdirSync(PAGES)
        .filter((f) => f.endsWith('.css'))
        .map((f): [string, string] => [join(PAGES, f), readFileSync(join(PAGES, f), 'utf8')]),
    ];
    expect(sheets.length).toBeGreaterThanOrEqual(4);
    const leaks: string[] = [];
    for (const [from, input] of sheets) {
      const css = await minifiedForProduction(from, input);
      expect(css, from).toContain('data-appearance=liquid-glass');
      leaks.push(...glassLeaks(css).map((l) => `${from}: ${l}`));
    }
    expect(leaks).toEqual([]);
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
