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

// P68-02 (DESIGN-SPEC 8: no page-wide sideways scroll, and lay out on the
// space after navigation, not on the window): the catalog toolbar wrapped
// only below 640 px of window, so beside the pinned 228 px sidebar the view
// switch ran 54 px past the column's edge at 768 px (12 at 810, 2 at 820) and
// the whole column scrolled sideways. The sticky bar is now a size container,
// and below 640 px of its own width (the toolbar needs about 632 px in one
// row at its widest) the search takes its own row and Availability, sort and
// the view switch share the next, on the New order page and the public page.
describe('the catalog toolbar wraps on its own width, not the window', () => {
  it('makes the sticky bar a named inline-size container', () => {
    expect(ruleBody(CODE, '.sp-storefront .sf-sticky')).toContain(
      'container: sf-toolbar / inline-size;',
    );
  });

  it('below 640 px of that width, wraps the toolbar and gives the search its own row', () => {
    const at = CODE.indexOf('@container sf-toolbar (max-width: 639.98px) {');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(ruleBody(CODE, '.sp-storefront .sf-tools', at)).toContain('flex-wrap: wrap;');
    const search = ruleBody(CODE, '.sp-storefront .sf-search', at);
    expect(search).toContain('flex: 1 1 100%;');
    expect(search).toContain('min-width: 0;');
  });

  it('keys neither rule to the window width any more', () => {
    const phone = CODE.slice(
      CODE.indexOf('@media (max-width: 639.98px) {'),
      CODE.indexOf('@media (hover: none) {'),
    );
    // The slice is the phone block (its 44 px tool buttons are still there).
    expect(phone).toContain('.sp-storefront .sf-tools > .sf-popwrap {');
    expect(phone).not.toContain('.sp-storefront .sf-tools {');
    expect(phone).not.toContain('.sp-storefront .sf-search {');
    // The container rule is the only one that wraps the toolbar.
    const wraps = rules(CODE).filter(
      ({ selectors, body }) =>
        selectors.includes('.sp-storefront .sf-tools') && /flex-wrap/.test(body),
    );
    expect(wraps).toHaveLength(1);
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

  it('the public order page draws its bar outside any .sf-page, so the four-cell rules leave it alone', () => {
    expect(PUBLIC_PAGE).toContain('<div className="sf-setup">');
    expect(
      PUBLIC_PAGE,
      'the public bar has three cells: if it gains an .sf-page frame, scope the four-cell rules another way',
    ).not.toMatch(/\bsf-page\b/);
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

describe('the public order page draws its states with the shared primitives', () => {
  // Since P5.1 step B, /r/<token> draws its closed link, empty catalog and
  // no-match state with ExternalStatusCard and StatePanel, and its Availability
  // ticks with the shared CheckboxGlyph (className="sf-cb"), as the New order
  // page does. The old .sf-empty frame and the bare [data-checked] tick box
  // are gone; keep them gone, so nothing styles markup that no longer exists.
  it.each(['.sp-storefront .sf-empty', '.sp-storefront .sf-cb[data-checked]'])(
    'has no %s rule',
    (selector) => {
      expect(CODE).not.toContain(selector);
    },
  );

  it('draws the Availability ticks with the shared CheckboxGlyph on both pages', () => {
    expect(PUBLIC_PAGE).toContain(
      '<CheckboxGlyph checked={availability.has(id)} className="sf-cb" />',
    );
    expect(PUBLIC_PAGE).not.toMatch(/sf-empty|data-checked/);
  });

  // .sf-cb only holds the glyph's width: a box rule here would draw over the
  // shared glyph on both pages.
  it('keeps .sf-cb a width holder only', () => {
    expect(ruleBody(CODE, '.sp-storefront .sf-cb')).not.toMatch(/width|border|background/);
  });
});

describe('product photos', () => {
  // The redesign (#369) drew every photo whole (object-fit: contain) on a
  // white backing, so a tall warehouse photo in the 4:3 box showed white bars
  // down both sides, in dark mode too. Photos fill their box again, as they
  // did before the redesign; only the blurred LQIP preview was ever cropped
  // on purpose.
  it('fill their box, with no white backing behind them', () => {
    const body = ruleBody(CODE, '.sp-storefront .sf-ph img');
    expect(body).toMatch(/object-fit:\s*cover;/);
    expect(body).not.toMatch(/object-fit:\s*contain/);
    expect(body).not.toMatch(/background:\s*#fff/i);
  });
});
