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

function ruleBody(css: string, selector: string, from = 0): string {
  const at = css.indexOf(`${selector} {`, from);
  expect(at, `${selector} rule`).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf('}', at));
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
    expect(ruleBody(CODE, '.sp-storefront .sf-setup', at)).toContain('grid-template-columns: 1fr;');
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
