import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * public-orders.css is the public order page's override layer on the
 * storefront base (storefront.css, redesign P4.B2; this layer P5.1 step B).
 * The base already draws the page in the redesign's look, so this layer must
 * never pull it back: it stays scoped to the public page, reads no shadow
 * token (cards are flat), rounds nothing past the base's 8 px, keeps the
 * base's colour tokens, prints words in ink-3 or stronger, and does not
 * repeat a base rule. It is imported after the base, so it can override.
 */
const DIR = __dirname;
const CSS = readFileSync(path.resolve(DIR, 'public-orders.css'), 'utf8');
const CODE = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
const LAYOUT = readFileSync(path.resolve(DIR, '../../../app/r/layout.tsx'), 'utf8');

/** Every innermost rule (inside @media too): its selectors and its body. */
function rules(css: string): Array<{ selectors: string[]; body: string }> {
  const out: Array<{ selectors: string[]; body: string }> = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const head = m[1]!.trim();
    if (head.startsWith('@')) continue;
    out.push({
      selectors: head
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      body: m[2]!,
    });
  }
  return out;
}

function ruleBody(selector: string, from = 0): string {
  const at = CODE.indexOf(`${selector} {`, from);
  expect(at, `${selector} rule`).toBeGreaterThanOrEqual(0);
  return CODE.slice(at, CODE.indexOf('}', at));
}

const ALL = rules(CODE);

describe('public-orders.css is an override layer on the storefront base', () => {
  it('is imported after storefront.css by the /r layout', () => {
    const base = LAYOUT.indexOf("import '@/components/orders/storefront/storefront.css';");
    const layer = LAYOUT.indexOf("import '@/components/orders/public-v2/public-orders.css';");
    expect(base).toBeGreaterThanOrEqual(0);
    expect(layer).toBeGreaterThan(base);
  });

  it('scopes every rule to the public page', () => {
    const loose = ALL.flatMap((r) => r.selectors).filter(
      (sel) => !sel.startsWith('.sf-public ') && sel !== '.sp-storefront.sf-public',
    );
    expect(loose).toEqual([]);
  });

  it('draws cards flat: no shadow token, no lift, no blur', () => {
    expect(CODE).not.toMatch(/--sf-shadow/);
    expect(CODE).not.toMatch(/backdrop-filter|filter:\s*blur/);
    expect(CODE).not.toMatch(/(?<!text-)transform\s*:/);
    // The only shadow is the text box focus ring, as on the base's search.
    const shadows = [...CODE.matchAll(/box-shadow:\s*([^;]+);/g)].map((m) => m[1]!.trim());
    expect(shadows).toEqual(['0 0 0 1px var(--sf-accent)']);
  });

  it('rounds controls and cards at most 8 px (pills and dots excepted)', () => {
    const radii = [...CODE.matchAll(/border-radius:\s*([^;]+);/g)].map((m) => m[1]!.trim());
    expect(radii.length).toBeGreaterThan(0);
    for (const value of radii) {
      if (value === '50%' || value === '999px') continue;
      for (const part of value.split(/\s+/)) {
        expect(part, value).toMatch(/^\d+px$|^0$/);
        expect(Number.parseFloat(part), value).toBeLessThanOrEqual(8);
      }
    }
    expect(ruleBody('.sf-public .sfp-card')).toContain('border-radius: 8px;');
    expect(ruleBody('.sf-public .sfp-success-card')).toContain('border-radius: 8px;');
    const box = ALL.find(
      (r) => r.selectors.includes('.sf-public .sfp-input') && /border-radius/.test(r.body),
    );
    expect(box?.body).toContain('border-radius: 6px;');
  });

  it('keeps the base colour tokens (it only zeroes the top bar height)', () => {
    const defined = [...CODE.matchAll(/(--sf-[a-z0-9-]+)\s*:/g)].map((m) => m[1]);
    expect(defined).toEqual(['--sf-topbar-h']);
  });

  it('prints words in ink-3 or stronger (ink-4 and ink-5 are for glyphs only)', () => {
    const colours = [...CODE.matchAll(/(?:^|[;{\s])color:\s*([^;]+);/g)].map((m) => m[1]!.trim());
    expect(colours.length).toBeGreaterThan(0);
    for (const value of colours) {
      expect(value).toMatch(/^var\(--sf-(ink|ink-2|ink-3|crit-text|btn-ink)\)$/);
    }
    expect(CODE).not.toMatch(/--sf-ink-[45]/);
  });

  it('touches only the base pieces the public page lays out its own way', () => {
    const baseClasses = new Set(
      ALL.flatMap((r) => r.selectors)
        .flatMap((sel) => [...sel.matchAll(/\.(sf-[a-z0-9-]+)/g)].map((m) => m[1]!))
        .filter((c) => c !== 'sf-public'),
    );
    // The toolbar's phone wrap, the page gutters, the 44 px controls and the
    // cards' own look come from the base, so they are not repeated here.
    expect([...baseClasses].sort()).toEqual(
      [
        'sf-card-nm',
        'sf-cart',
        'sf-grid',
        'sf-head',
        'sf-rail',
        'sf-seg-wrap',
        'sf-setup',
        'sf-setup-cell',
        'sf-sub',
        'sf-success',
      ].sort(),
    );
  });

  it('stacks the bar of three at 860 px and narrower, with the bar corners and hairline', () => {
    const at = CODE.indexOf('@media (max-width: 860px) {', CODE.indexOf('.sf-public .sf-setup >'));
    expect(at).toBeGreaterThanOrEqual(0);
    expect(ruleBody('.sf-public .sf-setup', at)).toContain('flex-direction: column;');
    expect(ruleBody('.sf-public .sf-setup > :first-child', at)).toContain(
      'border-radius: 8px 8px 0 0;',
    );
    expect(ruleBody('.sf-public .sf-setup > :last-child', at)).toContain(
      'border-radius: 0 0 8px 8px;',
    );
    expect(CODE.slice(at)).toContain('border-top: 1px solid var(--sf-line);');
    // On a wide screen the last cell takes the bar's right corners.
    expect(ruleBody('.sf-public .sf-setup > :last-child')).toContain('border-radius: 0 8px 8px 0;');
  });

  it('on a phone: 16 px text boxes so iOS does not zoom, a 44 px field and a 44 px track link', () => {
    const at = CODE.indexOf('@media (max-width: 639.98px) {');
    expect(at).toBeGreaterThanOrEqual(0);
    const phone = CODE.slice(at);
    expect(phone).toMatch(
      /\.sf-public \.sfp-input,\s*\.sf-public \.sfp-textarea \{\s*font-size: 16px;/,
    );
    expect(ruleBody('.sf-public .sfp-input', at)).toContain('height: 44px;');
    expect(ruleBody('.sf-public .sfp-track a', at)).toContain('min-height: 44px;');
  });
});
