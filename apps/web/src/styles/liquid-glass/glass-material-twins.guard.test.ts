// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import postcss, { type AtRule, type Declaration, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

import {
  COLOUR_PROPERTIES,
  EDITORIAL,
  OUTPUT_PATH,
  TRIPLETS,
} from '../../../scripts/liquid-glass/gen-tokens.mjs';

import { enclosing, GLASS_DIR, normaliseQuotes, splitSelectors } from './glass-css';

/**
 * Two generated or hand-written twins that must never drift
 * (plans/REVISION-DEFAULT.md R6, R7; section 9 items 14, 15, 43):
 *
 *  1. The low-power material. Weak Chromium browsers get
 *     data-lg-material="reduced" on <html>; the reduced set is emitted under
 *     that attribute as well as under the OS media query, and the two are
 *     declaration-for-declaration equal (tokens.generated.css, materials.css,
 *     shell.css and the page compositions that blur: pages/items.css,
 *     pages/item-detail.css, storefront.glass.css, pages/orders.css and
 *     pages/order-detail.css). The contrast and forced-colours sets still win
 *     over it.
 *  2. The exempt surfaces. Inside [data-appearance-exempt] (the signature pad,
 *     the label sheet) every token glass overrides is declared again with its
 *     classic value, read from app/globals.css.
 */

const ROOT = ":root[data-appearance='liquid-glass']";
const REDUCED_ROOT = `${ROOT}[data-lg-material='reduced']`;
const REDUCED_MEDIA = '(prefers-reduced-transparency: reduce)';
const SHARED_MEDIA = '(prefers-reduced-transparency: reduce), (prefers-contrast: more)';

const read = (file: string) => readFileSync(join(GLASS_DIR, file), 'utf8');
const media = (rule: Rule) =>
  enclosing(rule)
    .filter((a) => a.startsWith('@media ') && a !== '@media screen')
    .map((a) => a.slice('@media '.length).replace(/\s+/g, ' ').trim());
const decls = (rule: Rule) =>
  rule.nodes.filter((n): n is Declaration => n.type === 'decl').map((d) => `${d.prop}: ${d.value}`);
const selectorsOf = (rule: Rule) =>
  splitSelectors(normaliseQuotes(rule.selector.replace(/\s+/g, ' ')));

describe('the reduced material under data-lg-material="reduced" (R7)', () => {
  const tokens = postcss.parse(readFileSync(OUTPUT_PATH, 'utf8'));

  it('tokens.generated.css: the attribute block equals the Reduce Transparency block, Day and Night', () => {
    const fromMedia = new Map<string, string[]>();
    const fromAttribute = new Map<string, string[]>();
    tokens.walkRules((rule) => {
      const where = media(rule);
      const selectors = selectorsOf(rule);
      if (where.length === 1 && where[0] === REDUCED_MEDIA) {
        for (const s of selectors) fromMedia.set(s, decls(rule));
      }
      if (where.length === 0) {
        for (const s of selectors) {
          if (s === REDUCED_ROOT || s === `${REDUCED_ROOT}.dark`) fromAttribute.set(s, decls(rule));
        }
      }
    });
    expect([...fromMedia.keys()].sort()).toEqual([ROOT, `${ROOT}.dark`]);
    expect([...fromAttribute.keys()].sort()).toEqual([REDUCED_ROOT, `${REDUCED_ROOT}.dark`]);
    expect(fromAttribute.get(REDUCED_ROOT)).toEqual(fromMedia.get(ROOT));
    expect(fromAttribute.get(`${REDUCED_ROOT}.dark`)).toEqual(fromMedia.get(`${ROOT}.dark`));
    expect(fromAttribute.get(REDUCED_ROOT)!.length).toBeGreaterThan(50);
  });

  it('tokens.generated.css: the attribute block draws no scene photo', () => {
    let seen = 0;
    tokens.walkRules((rule) => {
      if (media(rule).length > 0) return;
      if (!selectorsOf(rule).some((s) => s.startsWith(REDUCED_ROOT))) return;
      seen += 1;
      expect(decls(rule)).toContain('--lg-scene-img: none');
    });
    expect(seen).toBe(2);
  });

  it('tokens.generated.css: Increase Contrast and forced colours still win over the attribute', () => {
    const contrastSelectors: string[] = [];
    const forcedSelectors: string[] = [];
    tokens.walkRules((rule) => {
      const where = media(rule);
      if (where[0] === '(prefers-contrast: more)') contrastSelectors.push(...selectorsOf(rule));
      if (where[0] === '(forced-colors: active)') forcedSelectors.push(...selectorsOf(rule));
    });
    // The same specificity as the attribute block, later in the file.
    expect(contrastSelectors).toEqual(
      expect.arrayContaining([REDUCED_ROOT, `${REDUCED_ROOT}.dark`]),
    );
    expect(forcedSelectors).toEqual(expect.arrayContaining([REDUCED_ROOT]));
    const text = readFileSync(OUTPUT_PATH, 'utf8');
    expect(text.indexOf('(prefers-contrast: more)')).toBeGreaterThan(
      text.indexOf('[data-lg-material="reduced"]'),
    );
  });

  for (const file of [
    'materials.css',
    'shell.css',
    'pages/items.css',
    'pages/item-detail.css',
    'storefront.glass.css',
    'pages/orders.css',
    'pages/order-detail.css',
  ]) {
    it(`${file}: every Reduce Transparency rule has an attribute twin with the same declarations`, () => {
      const root = postcss.parse(read(file));
      const inMedia: { selectors: string[]; decls: string[] }[] = [];
      const twins: { selectors: string[]; decls: string[] }[] = [];
      root.walkRules((rule) => {
        const where = media(rule);
        if (where.length === 1 && where[0] === SHARED_MEDIA) {
          inMedia.push({ selectors: selectorsOf(rule), decls: decls(rule) });
        } else if (
          where.length === 0 &&
          selectorsOf(rule).every((s) => s.startsWith(REDUCED_ROOT))
        ) {
          twins.push({ selectors: selectorsOf(rule), decls: decls(rule) });
        }
      });
      expect(inMedia.length).toBeGreaterThan(0);
      expect(twins).toEqual(
        inMedia.map(({ selectors, decls: d }) => ({
          selectors: selectors.map((s) => s.replace(ROOT, REDUCED_ROOT)),
          decls: d,
        })),
      );
    });
  }
});

describe('the exempt surfaces (R6)', () => {
  const globals = postcss.parse(
    readFileSync(join(GLASS_DIR, '..', '..', 'app', 'globals.css'), 'utf8'),
  );
  const tokens = postcss.parse(readFileSync(OUTPUT_PATH, 'utf8'));

  /** The classic custom properties of one block of globals.css's base layer. */
  function classic(selector: ':root' | '.dark'): Map<string, string> {
    const out = new Map<string, string>();
    globals.walkRules((rule) => {
      if (rule.selector !== selector) return;
      const layer = enclosing(rule).find((a) => a.startsWith('@layer '));
      if (layer !== '@layer base') return;
      rule.walkDecls(/^--/u, (d) => {
        if (!out.has(d.prop)) out.set(d.prop, d.value);
      });
    });
    return out;
  }

  /** @theme's custom properties that are formulas over other variables. */
  function themeFormulas(): Map<string, string> {
    const out = new Map<string, string>();
    globals.walkAtRules('theme', (at: AtRule) => {
      at.walkDecls(/^--/u, (d) => {
        if (d.value.includes('var(--')) out.set(d.prop, d.value);
      });
    });
    return out;
  }

  function exemptBlock(selector: string): Map<string, string> {
    const out = new Map<string, string>();
    let rules = 0;
    tokens.walkRules((rule) => {
      if (media(rule).length > 0) return;
      if (!selectorsOf(rule).includes(selector)) return;
      rules += 1;
      for (const d of rule.nodes) if (d.type === 'decl') out.set(d.prop, d.value);
    });
    expect(rules, selector).toBe(1);
    return out;
  }

  const overridden = [...Object.keys(TRIPLETS), ...Object.keys(EDITORIAL)];

  it('Day: every classic value glass overrides is declared again, as globals.css :root has it', () => {
    const light = classic(':root');
    const block = exemptBlock(`${ROOT} [data-appearance-exempt]`);
    expect(overridden.length).toBeGreaterThan(30);
    for (const name of overridden) {
      expect(light.has(name), `${name} in globals.css :root`).toBe(true);
      expect(block.get(name), name).toBe(light.get(name));
    }
  });

  it('Night: every value globals.css .dark declares for those tokens', () => {
    const dark = classic('.dark');
    const block = exemptBlock(`${ROOT}.dark [data-appearance-exempt]`);
    const names = overridden.filter((name) => dark.has(name));
    expect(names.length).toBeGreaterThan(20);
    expect([...block.keys()].sort()).toEqual([...names].sort());
    for (const name of names) expect(block.get(name), name).toBe(dark.get(name));
  });

  it('the Tailwind colour properties are computed again from the classic values', () => {
    const block = exemptBlock(`${ROOT} [data-appearance-exempt]`);
    const formulas = themeFormulas();
    for (const name of Object.keys(COLOUR_PROPERTIES)) {
      expect(formulas.has(name), `${name} in @theme`).toBe(true);
    }
    for (const [name, value] of formulas) expect(block.get(name), name).toBe(value);
  });

  it('the type stacks are the classic next/font faces again', () => {
    const block = exemptBlock(`${ROOT} [data-appearance-exempt]`);
    expect(block.get('--font-sans')).toBe('var(--lg-font-inter)');
    expect(block.get('--font-display')).toBe('var(--lg-font-display)');
    expect(block.get('--font-serif')).toBe('var(--lg-font-serif)');
    expect(block.get('--font-mono')).toBe('var(--lg-font-jetbrains)');
  });
});
