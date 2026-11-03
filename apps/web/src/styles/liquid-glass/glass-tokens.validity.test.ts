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
  presentSceneFiles,
  readSource,
} from '../../../scripts/liquid-glass/gen-tokens.mjs';

import { glassSourceFiles } from './glass-css';

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

describe('tokens.generated.css', () => {
  it('is what the generator makes from tokens.source.json (never edited by hand)', () => {
    expect(GENERATED).toBe(generateTokensCss(readSource(), { sceneFiles: presentSceneFiles() }));
  });

  it('keeps every semantic triplet an opaque H S% L% triplet, with no / in any variant', () => {
    const bad: string[] = [];
    let seen = 0;
    TREE.walkDecls((decl) => {
      if (!(decl.prop in TRIPLETS)) return;
      seen += 1;
      if (decl.value.includes('/') || !TRIPLET.test(decl.value))
        bad.push(`${decl.prop}: ${decl.value}`);
    });
    expect(seen).toBe(Object.keys(TRIPLETS).length * 2 * 4);
    expect(bad).toEqual([]);
  });

  it('gives every translucent fill and editorial token a readable colour', () => {
    const bad: string[] = [];
    TREE.walkDecls((decl) => {
      if (!(decl.prop in COLOUR_PROPERTIES) && !(decl.prop in EDITORIAL)) return;
      if (/^(Canvas|CanvasText|Field)$/.test(decl.value)) return;
      if (!parseColour(decl.value)) bad.push(`${decl.prop}: ${decl.value}`);
    });
    expect(bad).toEqual([]);
  });

  it('sets the same properties in every variant block', () => {
    const blocks: { where: string; props: string[] }[] = [];
    TREE.walkRules((rule: Rule) => {
      if (!/^:root\[data-appearance="liquid-glass"\](\.dark)?$/.test(rule.selector)) return;
      const props: string[] = [];
      rule.walkDecls((d) => {
        props.push(d.prop);
      });
      if (props.includes('--lg-accent')) blocks.push({ where: rule.selector, props: props.sort() });
    });
    expect(blocks).toHaveLength(8);
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
    expect([...used].filter((t) => !defined.has(t))).toEqual([]);
  });
});
