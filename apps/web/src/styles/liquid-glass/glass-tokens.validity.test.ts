// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import postcss, { type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

import {
  COLOUR_PROPERTIES,
  EDITORIAL,
  OUTPUT_PATH,
  TRIPLETS,
  generateTokensCss,
  parseColour,
  readSource,
  SCENE_IMAGE,
  SCENE_IMAGE_NIGHT,
} from '../../../scripts/liquid-glass/gen-tokens.mjs';

import { enclosing, glassSourceFiles } from './glass-css';

/**
 * Glass token validity (Liquid Glass plan 4.2, review finding R6), the unit
 * half; the computed-value half (a probe element in Day, Night, reduced and
 * contrast glass) runs in Playwright on the lab.
 *
 * Eighteen classic sites add their own alpha as hsl(var(--x) / a). An alpha
 * inside a triplet would make those declarations invalid (two slashes) and the
 * browser would drop them, so every semantic token glass overrides must stay an
 * opaque "H S% L%" triplet, and translucency lives on full colour properties.
 */

const GENERATED = readFileSync(OUTPUT_PATH, 'utf8');
const TREE = postcss.parse(GENERATED);
const TRIPLET = /^\d+(\.\d+)? \d+(\.\d+)?% \d+(\.\d+)?%$/;
/** The exempt surfaces carry CLASSIC values (globals.css), checked by glass-material-twins.guard.test.ts. */
const inExempt = (decl: { parent?: unknown }) =>
  ((decl.parent as Rule | undefined)?.selector ?? '').includes('[data-appearance-exempt]');
/** The variant blocks: glass, Reduce Transparency, no backdrop-filter, the low-power attribute, contrast. */
const VARIANT_SELECTOR =
  /^:root\[data-appearance="liquid-glass"\](\[data-lg-material="reduced"\])?(\.dark)?$/;

describe('tokens.generated.css', () => {
  it('is what the generator makes from tokens.source.json (never edited by hand)', () => {
    // The scene files never enter it: scene.css names them in --lg-scene-photo-day and -night.
    expect(GENERATED).toBe(generateTokensCss(readSource()));
  });

  it('keeps every semantic triplet an opaque H S% L% triplet, with no / in any variant', () => {
    const bad: string[] = [];
    let seen = 0;
    TREE.walkDecls((decl) => {
      if (!(decl.prop in TRIPLETS) || inExempt(decl)) return;
      seen += 1;
      if (decl.value.includes('/') || !TRIPLET.test(decl.value))
        bad.push(`${decl.prop}: ${decl.value}`);
    });
    expect(seen).toBe(Object.keys(TRIPLETS).length * 2 * 5);
    expect(bad).toEqual([]);
  });

  it('gives every translucent fill and editorial token a readable colour', () => {
    const bad: string[] = [];
    TREE.walkDecls((decl) => {
      if (!(decl.prop in COLOUR_PROPERTIES) && !(decl.prop in EDITORIAL)) return;
      if (inExempt(decl)) return;
      if (/^(Canvas|CanvasText|Field)$/.test(decl.value)) return;
      if (!parseColour(decl.value)) bad.push(`${decl.prop}: ${decl.value}`);
    });
    expect(bad).toEqual([]);
  });

  it('sets the same properties in every variant block', () => {
    const blocks: { where: string; props: string[] }[] = [];
    TREE.walkRules((rule: Rule) => {
      const selectors = rule.selector.split(',').map((x) => x.trim());
      if (!selectors.every((x) => VARIANT_SELECTOR.test(x))) return;
      const props: string[] = [];
      rule.walkDecls((d) => {
        props.push(d.prop);
      });
      if (props.includes('--lg-accent')) blocks.push({ where: rule.selector, props: props.sort() });
    });
    expect(blocks).toHaveLength(10);
    for (const block of blocks) expect(block.props).toEqual(blocks[0]!.props);
  });

  it('every token an alpha site reads is either left classic or overridden as a triplet', () => {
    const src = join(__dirname, '..', '..');
    const sites = new Set<string>();
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(css|tsx?)$/.test(e.name) && !/\.test\./.test(e.name)) {
          for (const m of readFileSync(p, 'utf8').matchAll(
            /hsl\(var\((--[\w-]+)\)\s*\/\s*[\d.]+\)/g,
          )) {
            sites.add(m[1]!);
          }
        }
      }
    };
    walk(src);
    expect([...sites]).toEqual(expect.arrayContaining(['--accent', '--border', '--muted']));
    const overridden = new Set<string>();
    TREE.walkDecls((d) => {
      if (sites.has(d.prop)) overridden.add(d.prop);
    });
    for (const token of overridden) expect(token in TRIPLETS, token).toBe(true);
  });

  it('defines every --lg-* token the glass stylesheets read', () => {
    const defined = new Set<string>();
    const used = new Set<string>();
    for (const { text } of glassSourceFiles()) {
      for (const m of text.matchAll(/(--lg-[\w-]+)\s*:/g)) defined.add(m[1]!);
      for (const m of text.matchAll(/var\((--lg-[\w-]+)/g)) used.add(m[1]!);
    }
    // The two pictures among them: scene.css declares them (scene-photo.test.ts).
    expect(defined.has('--lg-scene-photo-day')).toBe(true);
    expect(defined.has('--lg-scene-photo-night')).toBe(true);
    expect([...used].filter((t) => !defined.has(t))).toEqual([]);
  });

  it('draws the scene only in the glass material: Day the day picture, Night the night one, and the night picture for the landing’s band in both, each with a none fallback; every opaque material none', () => {
    expect(SCENE_IMAGE).toEqual({
      light: 'var(--lg-scene-photo-day, none)',
      dark: 'var(--lg-scene-photo-night, none)',
    });
    expect(SCENE_IMAGE_NIGHT).toBe('var(--lg-scene-photo-night, none)');
    for (const prop of ['--lg-scene-img', '--lg-scene-img-night']) {
      const values = new Map<string, string[]>();
      TREE.walkDecls(prop, (d) => {
        const rule = d.parent as Rule;
        // Inside @layer lg and @media screen only: a top-level block; inside
        // another media or supports query: an OS-setting (opaque) block.
        const where = enclosing(rule).length > 2 ? 'opaque' : 'top';
        values.set(where, [...(values.get(where) ?? []), `${rule.selector} => ${d.value}`]);
      });
      const glass = (values.get('top') ?? []).filter((v) => !v.includes('data-lg-material'));
      expect(glass, prop).toEqual(
        prop === '--lg-scene-img'
          ? [
              ':root[data-appearance="liquid-glass"] => var(--lg-scene-photo-day, none)',
              ':root[data-appearance="liquid-glass"].dark => var(--lg-scene-photo-night, none)',
            ]
          : [
              ':root[data-appearance="liquid-glass"] => var(--lg-scene-photo-night, none)',
              ':root[data-appearance="liquid-glass"].dark => var(--lg-scene-photo-night, none)',
            ],
      );
      const opaque = [
        ...(values.get('opaque') ?? []),
        ...(values.get('top') ?? []).filter((x) => x.includes('data-lg-material')),
      ];
      // Reduce Transparency, no backdrop-filter, the low-power attribute and
      // contrast (Day and Night each) and forced colours.
      expect(opaque, prop).toHaveLength(9);
      for (const v of opaque) expect(v, prop).toMatch(/=> none$/u);
    }
    expect(GENERATED).not.toMatch(/url\(/u);
  });
});
