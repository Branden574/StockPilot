import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Redesign P4.B2: the storefront's --sf-* tokens are the shared semantic
 * tokens of globals.css (P2.1), read through var(), so the New order page,
 * the public order page /r/<token> and the dialogs that borrow
 * .sp-storefront follow the app's light and dark values and cannot drift.
 * Before, the file kept its own hex copies and an oklch mint accent the
 * redesign retired (hand-off from P2.1). It also pins the redesign's rules
 * for this page: no blur, flat cards, the reset in the base layer (so shared
 * primitives inside the page keep their classes), and the phone layout.
 */
const CSS = readFileSync(path.resolve(__dirname, 'storefront.css'), 'utf8');
const CODE = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
const GLOBALS = readFileSync(path.resolve(__dirname, '../../../app/globals.css'), 'utf8');
// The public order page (/r/<token>) reads this stylesheet too.
const PUBLIC_PAGE = readFileSync(
  path.resolve(__dirname, '../public-v2/public-orders-v2.tsx'),
  'utf8',
);

function ruleBody(css: string, selector: string, from = 0): string {
  const at = css.indexOf(`${selector} {`, from);
  expect(at, `${selector} rule`).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf('}', at));
}

/** Every innermost rule of the stylesheet (inside @media and @layer too),
 *  as its selectors and its body. */
function rules(css: string): Array<{ selectors: string[]; body: string }> {
  const out: Array<{ selectors: string[]; body: string }> = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1]!
      .split(',')
      .map((sel) => sel.trim())
      .filter(Boolean);
    out.push({ selectors, body: m[2]! });
  }
  return out;
}

function declarations(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--sf-[a-z0-9-]+):\s*([^;]+);/g)) out.set(m[1]!, m[2]!.trim());
  return out;
}

const COLOUR_TOKENS = [
  '--sf-bg',
  '--sf-bg-elev',
  '--sf-bg-sunk',
  '--sf-ink',
  '--sf-ink-2',
  '--sf-ink-3',
  '--sf-ink-4',
  '--sf-ink-5',
  '--sf-line',
  '--sf-line-2',
  '--sf-line-strong',
  '--sf-hover',
  '--sf-accent',
  '--sf-on-accent',
  '--sf-accent-wash',
  '--sf-warn',
  '--sf-warn-text',
  '--sf-warn-wash',
  '--sf-crit',
  '--sf-crit-text',
  '--sf-crit-wash',
  '--sf-btn',
  '--sf-btn-ink',
];

describe('storefront tokens are the shared semantic tokens', () => {
  const tokens = declarations(ruleBody(CODE, '.sp-storefront'));

  it.each(COLOUR_TOKENS)('%s reads a globals.css token', (name) => {
    const value = tokens.get(name);
    expect(value, name).toBeDefined();
    expect(value).toMatch(/^(var\(--ed-[a-z0-9-]+\)|hsl\(var\(--[a-z-]+\)\))$/);
  });

  it('every token it reads is defined for both themes in globals.css', () => {
    const lightAt = GLOBALS.indexOf('--ed-bg: #fafaf7;');
    const darkAt = GLOBALS.indexOf('--ed-bg: #0c0d0a;');
    expect(lightAt).toBeGreaterThanOrEqual(0);
    expect(darkAt).toBeGreaterThan(lightAt);
    const light = GLOBALS.slice(lightAt, darkAt);
    const dark = GLOBALS.slice(darkAt);
    for (const name of COLOUR_TOKENS) {
      const ref = /var\((--[a-z0-9-]+)\)/.exec(tokens.get(name)!)![1]!;
      expect(light, `${ref} in light`).toMatch(new RegExp(`(^|\\n)\\s*${ref}:`));
      expect(dark, `${ref} in dark`).toMatch(new RegExp(`(^|\\n)\\s*${ref}:`));
    }
  });

  it('keeps no colour of its own: no hex, no oklch, and no dark copy of the tokens', () => {
    const block = ruleBody(CODE, '.sp-storefront');
    expect(block).not.toMatch(/oklch\(/);
    for (const name of COLOUR_TOKENS) expect(tokens.get(name)).not.toMatch(/#[0-9a-f]{3,8}/i);
    expect(CODE).not.toMatch(/\.dark\s+\.sp-storefront\s*\{[^}]*--sf-(?!shadow)/);
    expect(CODE).not.toMatch(/oklch\(/);
  });

  it('keeps the top bar height P2.3 draws (56 px)', () => {
    expect(tokens.get('--sf-topbar-h')).toBe('56px');
  });
});

describe('the redesign rules for this page', () => {
  it('never blurs what is behind (no backdrop-filter anywhere)', () => {
    expect(CODE).not.toMatch(/backdrop-filter/);
  });

  it('draws cards flat, radius 8, with no lift on hover', () => {
    const card = ruleBody(CODE, '.sp-storefront .sf-card');
    expect(card).toContain('border-radius: 8px;');
    expect(card).not.toMatch(/box-shadow/);
    expect(ruleBody(CODE, '.sp-storefront .sf-card:hover')).not.toMatch(/transform|box-shadow/);
  });

  it('puts the button and input reset in the base layer, so shared primitives keep their classes', () => {
    const at = CODE.indexOf('@layer base {');
    expect(at).toBeGreaterThanOrEqual(0);
    const reset = CODE.indexOf('.sp-storefront button {');
    expect(reset).toBeGreaterThan(at);
    // Exactly one reset rule, and it is the layered one.
    expect(CODE.indexOf('.sp-storefront button {', reset + 1)).toBe(-1);
    expect(CODE.indexOf('.sp-storefront :focus-visible {')).toBeGreaterThan(at);
  });

  it('on a phone keeps the 16 px gutter, 16 px text boxes and one setup cell per line', () => {
    const at = CODE.indexOf('@media (max-width: 639.98px) {');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(ruleBody(CODE, '.sp-storefront .sf-page', at)).toContain('padding: 24px 16px 90px;');
    expect(ruleBody(CODE, '.sp-storefront .sf-page > .sf-setup', at)).toContain(
      'grid-template-columns: 1fr;',
    );
    const boxes = CODE.slice(at, CODE.indexOf('font-size: 16px;', at));
    for (const sel of [
      '.sf-search input',
      '.sf-pop .plain-input',
      '.sf-notes textarea',
      '.sf-needed-by input',
    ]) {
      expect(boxes).toContain(`.sp-storefront ${sel}`);
    }
  });
});

describe('the narrow setup bar is the New order page bar only', () => {
  // The two-by-two grid below 1024 px, its dividers and its corners count
  // cells: four on the New order page (Ship from, For, Pickup or delivery,
  // Pick up at or Deliver to). The public order page /r/<token>
  // (public-orders-v2.tsx) draws a bar of three cells (Location, Fulfillment,
  // Pick up at or Deliver to) from this same stylesheet, which public-orders.css
  // keeps as a row of three and stacks below 861 px. A grid rule on the plain
  // .sf-setup drew that bar as a ragged 2 + 1 grid from 640 to 1023 px (review
  // 2, 2026-10-19), so every such rule names .sf-page > .sf-setup, the New
  // order page's own bar (orders-storefront.tsx and its loading skeleton).
  const isBar = (sel: string) => /\.sf-setup(?![\w-])/.test(sel);
  const scoped = (sel: string) => sel.includes('.sf-page > .sf-setup');

  it('no rule on the plain .sf-setup sets a grid or counts its cells', () => {
    const offenders: string[] = [];
    for (const { selectors, body } of rules(CODE)) {
      for (const sel of selectors) {
        if (!isBar(sel) || scoped(sel)) continue;
        if (/display:\s*grid|grid-template/.test(body)) offenders.push(`${sel} (grid)`);
        if (/\.sf-setup\s*>\s*:(nth-child|first-child|last-child)/.test(sel)) {
          offenders.push(`${sel} (counts cells)`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('draws the New order page bar two by two below 1024 px, with its four corners', () => {
    const at = CODE.indexOf('@media (max-width: 1023.98px) {');
    expect(at).toBeGreaterThanOrEqual(0);
    const grid = ruleBody(CODE, '.sp-storefront .sf-page > .sf-setup', at);
    expect(grid).toContain('display: grid;');
    expect(grid).toContain('grid-template-columns: 1fr 1fr;');
    const corners: Array<[string, string]> = [
      [':first-child', '8px 0 0 0'],
      [':nth-child(2)', '0 8px 0 0'],
      [':nth-child(3)', '0 0 0 8px'],
      [':nth-child(4)', '0 0 8px 0'],
    ];
    for (const [child, radius] of corners) {
      expect(ruleBody(CODE, `.sp-storefront .sf-page > .sf-setup > ${child}`, at)).toContain(
        `border-radius: ${radius};`,
      );
    }
  });

  it('only the public page has no .sf-page, so the scoped rules leave its bar alone', () => {
    expect(PUBLIC_PAGE).toContain('<div className="sf-setup">');
    expect(PUBLIC_PAGE).not.toMatch(/\bsf-page\b/);
  });
});

describe('an out-of-stock compact row', () => {
  // The row used to be dimmed whole to 0.62, which took the Out of stock
  // label to 2.5:1 (light) and 3.0:1 (dark) and the SKU under 4.5:1. Now
  // only its photo dims, as on the grid card.
  it('never dims the row itself', () => {
    for (const { selectors, body } of rules(CODE)) {
      for (const sel of selectors) {
        if (/\.sf-row\[data-out='true'\]$/.test(sel)) {
          expect(body, sel).not.toMatch(/opacity|filter/);
        }
      }
    }
  });

  it('dims its photo and placeholder letter as the card does', () => {
    const img = ruleBody(CODE, ".sp-storefront .sf-row[data-out='true'] .th img");
    expect(img).toContain('filter: grayscale(0.85);');
    expect(img).toContain('opacity: 0.7;');
    expect(ruleBody(CODE, ".sp-storefront .sf-row[data-out='true'] .th .glyph")).toContain(
      'opacity: 0.4;',
    );
  });

  it('keeps a blurred preview blurred when it is grey, on the row and on the card', () => {
    for (const sel of [
      ".sp-storefront .sf-row[data-out='true'] .th img.lqip",
      ".sp-storefront .sf-card[data-out='true'] .sf-ph img.lqip",
    ]) {
      expect(ruleBody(CODE, sel)).toContain('filter: blur(6px) grayscale(0.85);');
    }
    expect(ruleBody(CODE, '.sp-storefront .sf-ph img.lqip')).toContain('filter: blur(6px);');
  });
});

describe('the rules the public order page still reads', () => {
  // /r/<token> (app/r/[token]/page.tsx) and public-orders-v2.tsx draw the
  // closed link, the empty catalog and the no-match state as
  // <div class="sf-empty"><div class="big">…<h4>…<p>…, so these rules stay even
  // though the New order page's own no-match state is the shared StatePanel.
  it.each([
    '.sp-storefront .sf-empty',
    '.sp-storefront .sf-empty .big',
    '.sp-storefront .sf-empty h4',
    '.sp-storefront .sf-empty p',
  ])('keeps %s', (selector) => {
    const body = ruleBody(CODE, selector);
    expect(body).toMatch(/[a-z-]+:\s*[^;]+;/);
  });

  it('draws the empty-state frame with a dashed border and the shared radius', () => {
    const body = ruleBody(CODE, '.sp-storefront .sf-empty');
    expect(body).toContain('border: 1px dashed var(--sf-line-strong);');
    expect(body).toContain('padding: 64px 24px;');
  });

  // public-orders-v2.tsx draws the Availability popover's tick box as a bare
  // <span class="sf-cb" data-checked={…} />: the box and its tick must exist,
  // or a visitor cannot see which availability filters are on. They are
  // scoped to [data-checked] so the dashboard's CheckboxGlyph is untouched.
  it('keeps the public availability tick box, scoped to [data-checked]', () => {
    const box = ruleBody(CODE, '.sp-storefront .sf-cb[data-checked]');
    expect(box).toContain('width: 14px;');
    expect(box).toContain('border: 1px solid var(--sf-line-strong);');
    expect(ruleBody(CODE, ".sp-storefront .sf-cb[data-checked='true']")).toContain(
      'background: var(--sf-ink);',
    );
    expect(ruleBody(CODE, ".sp-storefront .sf-cb[data-checked='true']::after")).toContain(
      "content: '';",
    );
    // No unscoped box rule that would also draw on the dashboard's glyph.
    expect(ruleBody(CODE, '.sp-storefront .sf-cb')).not.toMatch(/width|border|background/);
  });
});
