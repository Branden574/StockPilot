// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import tailwindcss from '@tailwindcss/postcss';
import postcss, { type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

/**
 * Redesign P2.2 guards over every shared primitive in components/ui (the
 * signature pad belongs to P5.1 and is left out).
 *
 * 1. No accent highlight: menus, selects, dates and the outline / ghost buttons
 *    highlight with the neutral fill. Accent text on an accent hover read
 *    1.66:1, and the deeper light accent made it worse.
 * 2. No gradients and no backdrop blur on any overlay (a full-screen
 *    backdrop-filter is repainted on the CPU without GPU acceleration; the
 *    owner measured the lag).
 * 3. Every redesign token class the primitives use is one Tailwind builds from
 *    globals.css, so a renamed or missing token fails here instead of drawing
 *    nothing on the page.
 */

const UI = __dirname;
/** The code without its comments (several comments explain why there is no blur). */
const withoutComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const SOURCES = readdirSync(UI)
  .filter((f) => f.endsWith('.tsx') && !f.endsWith('.test.tsx') && f !== 'signature-pad.tsx')
  .map((f) => ({ file: f, text: withoutComments(readFileSync(join(UI, f), 'utf8')) }));

describe('components/ui redesign guards', () => {
  it('reads the primitives', () => {
    expect(SOURCES.map((s) => s.file)).toEqual(
      expect.arrayContaining([
        'button.tsx',
        'badge.tsx',
        'checkbox.tsx',
        'switch.tsx',
        'radio-group.tsx',
      ]),
    );
  });

  it('no accent highlight anywhere: hovers, focus and open states use the neutral fill', () => {
    // The one accent hover allowed is the accent button darkening its own fill
    // (bg-accent/90); an accent highlight on anything else is not.
    const offenders = SOURCES.flatMap(({ file, text }) =>
      [
        ...text.matchAll(
          /(?:hover|focus|focus-visible|data-\[[^\]]+\]):bg-accent(?!\/9\d\b)(?![\w-])/g,
        ),
      ].map((m) => `${file}: ${m[0]}`),
    );
    expect(offenders).toEqual([]);
  });

  it('no gradient and no backdrop blur', () => {
    const offenders = SOURCES.flatMap(({ file, text }) =>
      [...text.matchAll(/\b(?:bg-gradient-to-\w+|backdrop-blur(?:-\w+)?)\b/g)].map(
        (m) => `${file}: ${m[0]}`,
      ),
    );
    expect(offenders).toEqual([]);
  });

  it('every redesign token utility the primitives use is built from globals.css', async () => {
    const globals = join(UI, '../../app/globals.css');
    // The primitives only: the tests name the same classes, and scanning them
    // would build a class a primitive no longer uses.
    const input = readFileSync(globals, 'utf8')
      .replace("@import 'tailwindcss';", "@import 'tailwindcss' source(none);")
      .concat(`\n@source "${UI}/*.tsx";\n@source not "${UI}/*.test.tsx";\n`);
    const { css } = await postcss([tailwindcss({ optimize: false })]).process(input, {
      from: globals,
    });
    const selectors = new Set<string>();
    postcss.parse(css).walkRules((rule: Rule) => {
      selectors.add(rule.selector);
    });
    // The whole class, then the end or a pseudo-class (`forced-colors:border`
    // must not pass on `forced-colors:border-[ButtonText]` alone).
    const built = (cls: string) => {
      const sel = `.${cls.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`)}`;
      return [...selectors].some((s) => s.startsWith(sel) && !/^[\w\\-]/.test(s.slice(sel.length)));
    };

    for (const cls of [
      'bg-accent',
      'text-accent-ink',
      'bg-success-wash',
      'bg-warning-wash',
      'bg-destructive-wash',
      'bg-sunk',
      'bg-muted',
      'hover:bg-muted',
      'border-[var(--ed-line-strong)]',
      'py-[var(--row-py)]',
      'text-xs/[18px]',
      "max-sm:before:content-['']",
      "pointer-coarse:before:content-['']",
      'max-sm:h-11',
      'max-sm:text-base',
      // The jump-to-page grid's 44 px targets on touch (pagination.tsx).
      'pointer-coarse:h-11',
      'pointer-coarse:grid-cols-5',
      // The toast shadow and focus rings beat sonner's unlayered CSS only as
      // !important classes, and the wash toasts turn the button pair round.
      'shadow-[0_10px_30px_rgba(0,0,0,0.25)]!',
      'focus-visible:shadow-[0_10px_30px_rgba(0,0,0,0.25),0_0_0_2px_hsl(var(--ring))]!',
      'focus-visible:[box-shadow:0_0_0_2px_var(--normal-bg),0_0_0_4px_var(--normal-text)]!',
      '[--normal-bg:hsl(var(--primary-foreground))]',
      '[--normal-text:hsl(var(--primary))]',
      // Forced colors (Windows High Contrast) keep the new controls' states.
      'forced-colors:appearance-auto',
      'forced-colors:border',
      'forced-colors:border-[ButtonText]',
      'forced-colors:forced-color-adjust-none',
      'forced-colors:bg-[ButtonText]',
      'forced-colors:bg-[CanvasText]',
    ]) {
      expect(built(cls), cls).toBe(true);
    }
  });
});
