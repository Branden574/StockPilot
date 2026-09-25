import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The storefront card grid (.sf-grid) must use auto-FILL.
 *
 * Each category on the New order page (and on the B2B portal, which shares the
 * class) is its own .sf-grid. With `repeat(auto-fit, ...)` the empty columns
 * collapse to 0px, so a category with fewer items than fit on a row stretched
 * its cards: measured on production 2026-09-25 at 1920px, 4+ cards were 265px
 * wide, 2 cards 543px, and a lone card about 1100px with an 825px photo.
 * `auto-fill` keeps the empty columns, so every card is one column wide.
 */
const CSS = readFileSync(path.resolve(__dirname, 'storefront.css'), 'utf8');

function ruleBody(selector: string): string {
  const at = CSS.indexOf(`${selector} {`);
  expect(at, `${selector} rule`).toBeGreaterThanOrEqual(0);
  return CSS.slice(at, CSS.indexOf('}', at));
}

describe('storefront card grid', () => {
  it('uses auto-fill, so a category with few items keeps normal-size cards', () => {
    expect(ruleBody('.sp-storefront .sf-grid')).toContain(
      'grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));',
    );
  });

  it('no storefront grid uses auto-fit', () => {
    const code = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/auto-fit/);
  });
});
