// @vitest-environment node
import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { glassSourceFiles, isUnlayeredCompanion, parse } from './glass-css';

/**
 * THE GLASS AT-RULE GUARD (Liquid Glass plan 4.7 item 1; the Classic CSS pin's
 * fix round, and one of the checks that stay after the pin's text and compile
 * checks were retired at the release). The scope guard (glass-scope.guard.test.ts) checks the RULES of
 * the glass files: every selector starts with the glass root, inside @media
 * screen. An at-rule that is not a rule acts on every page whatever selector
 * it sits under: @property registers a custom property for Classic too,
 * @font-face redefines a family Classic names, @config and @plugin change
 * Tailwind's theme for the whole of globals.css, @page changes printing,
 * @counter-style, @font-palette-values and @font-feature-values are global by
 * name. So every at-rule of every glass file (the files index.css imports, the
 * unlayered companions and the page compositions) must be one of:
 *   - @import, in index.css only (glass-scope checks it imports glass files);
 *   - @layer lg or a sublayer lg.*, and in a page composition its one layer
 *     order statement (theme, base, components, utilities, lg);
 *   - @media, @supports, @container, @starting-style (they hold rules, and
 *     the rules are the scope guard's);
 *   - @keyframes (or -webkit-keyframes) named lg-*;
 *   - @property for a custom property named --lg-* (no Classic file names one).
 * Anything else fails, and so does a stylesheet under styles/liquid-glass that
 * glassSourceFiles() does not read (a subfolder other than pages/, another
 * extension), so no glass stylesheet is outside the guards. The folder
 * classic-css-pin/ holds no stylesheet (only manifest.json and candidates.dat),
 * so it has no exception here.
 */

const FILES = glassSourceFiles();
const PAGE_ORDER = 'theme, base, components, utilities, lg';
const CONTAINERS = /^(media|supports|container|starting-style)$/;
const isLgLayer = (name: string) => /^lg(\.[\w-]+)*$/.test(name);

/** Every at-rule of a glass file that is not on the list above. */
function atRuleFindings(file: string, text: string): string[] {
  const out: string[] = [];
  parse(text, file).walkAtRules((at) => {
    const name = at.name.toLowerCase();
    const params = at.params.replace(/\s+/g, ' ').trim();
    const where = `${file}: @${at.name} ${params}`.trim();
    if (name === 'import') {
      if (file !== 'index.css') out.push(`${where} (only index.css imports)`);
      return;
    }
    if (CONTAINERS.test(name)) return;
    if (name === 'layer') {
      const names = params.split(',').map((n) => n.trim());
      if (at.nodes && names.length === 1 && isLgLayer(names[0]!)) return;
      if (!at.nodes && file.startsWith('pages/') && params === PAGE_ORDER) return;
      out.push(`${where} (only @layer lg, lg.*, and the page order statement)`);
      return;
    }
    if (/^(-webkit-)?keyframes$/.test(name) && /^lg-[\w-]+$/.test(params)) return;
    if (name === 'property' && /^--lg-[\w-]+$/.test(params)) return;
    out.push(`${where} (acts outside the glass root)`);
  });
  return out;
}

/** Every stylesheet under styles/liquid-glass, by its path there. */
function stylesheetsUnder(dir = __dirname, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    const rel = relative(__dirname, full).split(sep).join('/');
    if (e.isDirectory()) stylesheetsUnder(full, out);
    else if (/\.(css|scss|sass|less|pcss|postcss)$/.test(e.name)) out.push(rel);
  }
  return out;
}

describe('styles/liquid-glass at-rules', () => {
  it('reads the layered files, the unlayered companions and the page compositions', () => {
    const names = FILES.map((f) => f.file);
    expect(names).toEqual(expect.arrayContaining(['index.css', 'shell.css', 'globals.glass.css']));
    expect(names.some(isUnlayeredCompanion)).toBe(true);
    expect(names.some((n) => n.startsWith('pages/'))).toBe(true);
  });

  it('every glass at-rule is one that cannot act outside the glass root', () => {
    expect(FILES.flatMap(({ file, text }) => atRuleFindings(file, text))).toEqual([]);
  });

  it('every stylesheet under styles/liquid-glass is one the glass guards read', () => {
    expect(stylesheetsUnder().sort()).toEqual(FILES.map((f) => f.file).sort());
  });

  describe('planted controls fail it', () => {
    it('the at-rules of the review: @property, @font-face and @page inside @layer lg', () => {
      const planted =
        "@layer lg { @property --tw-ring-offset-width { syntax: '<length>'; inherits: false; initial-value: 6px; } " +
        "@font-face { font-family: 'Inter'; src: local('Comic Sans MS'); } @page { margin: 3in; } " +
        "@media screen { :root[data-appearance='liquid-glass'] .x { color: red; } } }";
      expect(atRuleFindings('shell.css', planted)).toEqual([
        'shell.css: @property --tw-ring-offset-width (acts outside the glass root)',
        'shell.css: @font-face (acts outside the glass root)',
        'shell.css: @page (acts outside the glass root)',
      ]);
    });

    it('@property for a Classic custom property, in a layered file and in a companion', () => {
      const prop = "@property --x-pulse { syntax: '<time>'; inherits: true; initial-value: 0s; }";
      expect(atRuleFindings('shell.css', `@layer lg { @media screen { ${prop} } }`)).toEqual([
        'shell.css: @property --x-pulse (acts outside the glass root)',
      ]);
      expect(atRuleFindings('globals.glass.css', prop)).toEqual([
        'globals.glass.css: @property --x-pulse (acts outside the glass root)',
      ]);
    });

    it('@config, @plugin, @reference and the global-by-name at-rules', () => {
      const planted = [
        "@config './lg.config.js';",
        "@plugin 'x';",
        "@reference '../../app/globals.css';",
        '@counter-style lgx { system: cyclic; symbols: a; }',
        '@font-palette-values --lgx { font-family: X; }',
        '@font-feature-values X { @swash { fancy: 1; } }',
        '@namespace svg url(http://www.w3.org/2000/svg);',
        '@scope (.x) { :root { color: red; } }',
        '@view-transition { navigation: auto; }',
      ].join('\n');
      expect(atRuleFindings('globals.glass.css', planted).map((f) => f.split(' ')[1])).toEqual([
        '@config',
        '@plugin',
        '@reference',
        '@counter-style',
        '@font-palette-values',
        '@font-feature-values',
        '@swash',
        '@namespace',
        '@scope',
        '@view-transition',
      ]);
    });

    it('@import outside index.css, a layer other than lg, a keyframes name outside lg-*', () => {
      const planted =
        "@import './shell.css';\n@layer base { :root[data-appearance='liquid-glass'] .x { color: red; } }\n" +
        '@layer theme, base, components, utilities, lg;\n@keyframes pulse { 50% { opacity: 0.1; } }';
      expect(atRuleFindings('shell.css', planted)).toEqual([
        "shell.css: @import './shell.css' (only index.css imports)",
        'shell.css: @layer base (only @layer lg, lg.*, and the page order statement)',
        `shell.css: @layer ${PAGE_ORDER} (only @layer lg, lg.*, and the page order statement)`,
        'shell.css: @keyframes pulse (acts outside the glass root)',
      ]);
    });

    it('what the glass may use passes', () => {
      const allowed =
        `@layer ${PAGE_ORDER};\n@layer lg { @media screen { @supports (color: red) { @container (min-width: 1px) { ` +
        "@starting-style { :root[data-appearance='liquid-glass'] .x { opacity: 0; } } } } } " +
        '@keyframes lg-x { to { opacity: 1; } } @property --lg-x { syntax: "*"; inherits: false; } }\n' +
        '@layer lg.parts { }';
      expect(atRuleFindings('pages/control.css', allowed)).toEqual([]);
    });
  });
});
