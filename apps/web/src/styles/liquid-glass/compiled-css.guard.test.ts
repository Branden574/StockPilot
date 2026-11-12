// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import tailwindcss from '@tailwindcss/postcss';
import postcss, { type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

import { SCENE_OUTPUTS, readManifest } from '../../../../../scripts/liquid-glass/install-scene.mjs';

import {
  GLASS_ROOT,
  enclosing,
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
 * text), or when a rule selects [data-glass...] without the glass root. And
 * the scene illustration's files are named only where scene.css names them:
 * by --lg-scene-photo-day and --lg-scene-photo-night on the glass root once
 * .light or .dark is set, inside the type() test, @media screen and @layer
 * lg, with the URLs the browser fetches (each with its version) left as
 * written. An engine that cannot parse type() inside image-set() (Safari up
 * to 16.x, Chrome and Edge up to 112, inside Next's default targets) must
 * never meet an image-set() with type(): a custom property keeps any value,
 * so every background substituting it would turn invalid at computed-value
 * time and lose its fill colours as well as the picture.
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

/**
 * The scene files the glass stylesheet names, as the browser fetches them, by
 * scheme: the public path, then ?v= and the first 12 hex digits of the
 * file's pinned SHA-256 (scripts/liquid-glass/scene-files.sha256).
 */
const MANIFEST = readManifest();
const SCENE_URLS = Object.fromEntries(
  (['light', 'dark'] as const).map((scheme) => [
    scheme,
    SCENE_OUTPUTS.filter((o) => o.app === 'web' && o.scheme === scheme)
      .map((o) => {
        const path = o.path.split('\\').join('/');
        return `/${path.split('/').slice(3).join('/')}?v=${MANIFEST.get(path)!.slice(0, 12)}`;
      })
      .sort(),
  ]),
) as Record<'light' | 'dark', string[]>;

/** Quotes dropped and the spaces a minifier removes, so source and minified output compare. */
const squash = (text: string) =>
  text
    .replace(/["']/gu, '')
    .replace(/\s+/gu, ' ')
    .replace(/\s*([:,])\s*/gu, '$1')
    .trim();

/**
 * Every rule of a compiled stylesheet that names a scene file, as
 * "<selector> | <property> | <at-rules around it> | <the files it names>",
 * quotes dropped (minifiers drop them).
 */
function sceneNames(css: string): string[] {
  const out: string[] = [];
  postcss.parse(css).walkDecls((decl) => {
    const urls = [...decl.value.matchAll(/url\(\s*['"]?([^'")\s]+)['"]?\s*\)/gu)]
      .map((m) => m[1]!)
      .filter((url) => /scene-(light|dark)[-.]/u.test(url));
    if (urls.length === 0 && !/scene-(light|dark)[-.]/u.test(decl.value)) return;
    const rule = decl.parent as Rule;
    out.push(
      [
        squash(rule.selector),
        decl.prop,
        enclosing(rule).map(squash).join(' < '),
        [...urls].sort().join(' '),
      ].join(' | '),
    );
  });
  return out;
}

/** The at-rule that keeps an image-set() with type() from an engine that cannot parse it. */
const TYPE_SUPPORT = squash(
  "@supports (background-image: image-set(url('data:,') 1x type('image/png')))",
);

/** What sceneNames must give: the two pictures of scene.css, in one rule, nothing else. */
const SCENE_NAMES = [
  `:root[data-appearance=liquid-glass]:is(.light,.dark) | --lg-scene-photo-day | ${TYPE_SUPPORT} < @media screen < @layer lg | ${SCENE_URLS.light.join(' ')}`,
  `:root[data-appearance=liquid-glass]:is(.light,.dark) | --lg-scene-photo-night | ${TYPE_SUPPORT} < @media screen < @layer lg | ${SCENE_URLS.dark.join(' ')}`,
];

/** True when a value holds an image-set() (prefixed or not) with a type() option, which old engines cannot parse. */
const IMAGE_SET_WITH_TYPE = /image-set\([\s\S]*\btype\(/u;

/**
 * Every declaration that an engine without type() support inside image-set()
 * would meet: an image-set() with type() whose rule is not inside a positive
 * @supports test of exactly that.
 */
function unguardedImageSets(css: string): string[] {
  const out: string[] = [];
  postcss.parse(css).walkDecls((decl) => {
    if (!IMAGE_SET_WITH_TYPE.test(decl.value)) return;
    const rule = decl.parent as Rule;
    const guarded = enclosing(rule).some(
      (a) =>
        a.startsWith('@supports ') && IMAGE_SET_WITH_TYPE.test(a) && !/^@supports\s+not\b/u.test(a),
    );
    if (!guarded) out.push(`${squash(rule.selector)} | ${decl.prop}`);
  });
  return out;
}

/**
 * The stylesheet as an engine without type() support inside image-set() reads
 * it (Safari up to 16.x, Chrome and Edge up to 112): every @supports test of
 * an image-set() with type() is false there, so its rules are gone.
 */
function asOldEngine(css: string): string {
  const root = postcss.parse(css);
  root.walkAtRules('supports', (at) => {
    if (IMAGE_SET_WITH_TYPE.test(at.params) && !/^not\b/u.test(at.params.trim())) at.remove();
  });
  return root.toString();
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

  it('names the scene files only in the two pictures of scene.css, inside the type() test, as Tailwind builds globals.css and as the production minifiers leave it', async () => {
    expect(SCENE_URLS.light).toHaveLength(5);
    expect(SCENE_URLS.dark).toHaveLength(5);
    expect(sceneNames(await compileGlobals())).toEqual(SCENE_NAMES);
    const minified = await minifiedForProduction(
      GLOBALS,
      readFileSync(GLOBALS, 'utf8').replace(
        "@import 'tailwindcss';",
        "@import 'tailwindcss' source(none);",
      ),
    );
    expect(sceneNames(minified)).toEqual(SCENE_NAMES);
    // The check can fail: a scene file named by a classic rule, or by a glass rule outside scene.css.
    expect(sceneNames(`.hero{background:url(/liquid-glass/scene-light-1x.avif)}`)).toEqual([
      '.hero | background |  | /liquid-glass/scene-light-1x.avif',
    ]);
  });

  it('an engine that cannot parse type() inside image-set() meets no image-set() with type(), and so names no scene file, as Tailwind builds globals.css and as the production minifiers leave it', async () => {
    const compiled = await compileGlobals();
    const minified = await minifiedForProduction(
      GLOBALS,
      readFileSync(GLOBALS, 'utf8').replace(
        "@import 'tailwindcss';",
        "@import 'tailwindcss' source(none);",
      ),
    );
    for (const css of [compiled, minified]) {
      expect(unguardedImageSets(css)).toEqual([]);
      expect(sceneNames(css)).toEqual(SCENE_NAMES);
      // That engine reads the stylesheet without the type() test's rules:
      // neither picture is declared, so both fall back to none and every
      // background that draws the scene keeps its fills.
      const old = asOldEngine(css);
      expect(sceneNames(old)).toEqual([]);
      expect(old).not.toMatch(/--lg-scene-photo-(day|night)\s*:/u);
      expect(old).toContain('--lg-scene-img');
    }
    // The checks can fail: the same declaration outside the test, or under a
    // test an old engine passes (a negated one, or one without type()).
    const R = ':root[data-appearance=liquid-glass]:is(.light,.dark)';
    const set = "image-set(url('/liquid-glass/scene-light-1x.avif?v=0') 1x type('image/avif'))";
    expect(unguardedImageSets(`@media screen{${R}{--lg-scene-photo-day:${set}}}`)).toEqual([
      `${R} | --lg-scene-photo-day`,
    ]);
    expect(
      unguardedImageSets(
        `@supports not (background-image:image-set(url('data:,') 1x type('image/png'))){${R}{--lg-scene-photo-day:${set}}}`,
      ),
    ).toEqual([`${R} | --lg-scene-photo-day`]);
    expect(
      unguardedImageSets(
        `@supports (background-image:image-set(url('data:,') 1x)){${R}{--x:${set}}}`,
      ),
    ).toEqual([`${R} | --x`]);
    expect(
      unguardedImageSets(
        `@supports (background-image:image-set(url('data:,') 1x type('image/png'))){${R}{--lg-scene-photo-day:${set}}}`,
      ),
    ).toEqual([]);
    expect(sceneNames(asOldEngine(`@media screen{${R}{--lg-scene-photo-day:${set}}}`))).toEqual([
      `${R} | --lg-scene-photo-day | @media screen | /liquid-glass/scene-light-1x.avif?v=0`,
    ]);
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
    const unguarded: string[] = [];
    for (const [from, input] of sheets) {
      const css = await minifiedForProduction(from, input);
      expect(css, from).toContain('data-appearance=liquid-glass');
      leaks.push(...glassLeaks(css).map((l) => `${from}: ${l}`));
      unguarded.push(...unguardedImageSets(css).map((l) => `${from}: ${l}`));
    }
    expect(leaks).toEqual([]);
    expect(unguarded).toEqual([]);
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
  it.runIf(built.length > 0)(
    'next build named the scene files only as scene.css does, with the URLs unchanged',
    () => {
      const names = built.flatMap((f) => sceneNames(readFileSync(f, 'utf8')));
      expect(names.length).toBeGreaterThanOrEqual(SCENE_NAMES.length);
      expect([...new Set(names)].sort()).toEqual([...SCENE_NAMES].sort());
    },
  );
  it.runIf(built.length > 0)(
    'next build left no image-set() with type() where an engine without type() support meets it',
    () => {
      for (const f of built) {
        const css = readFileSync(f, 'utf8');
        expect(unguardedImageSets(css), f).toEqual([]);
        expect(sceneNames(asOldEngine(css)), f).toEqual([]);
      }
    },
  );
});
