import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The Kits row on the New order page is ONE horizontal strip at every width,
 * like Frequently ordered, so its height is one kit card and the reserved
 * place drawn while the kits stream in (KitsRowSkeleton) takes exactly that
 * height. As a wrapping grid it grew with the number of kits: five kits made
 * it 2096 px tall at 390 px wide against 469 px reserved, and 727 px against
 * 384 px at 1440 (local, 2026-09-27). Every piece of a kit card that could
 * change its height has a fixed one.
 */
const CSS = readFileSync(path.resolve(__dirname, 'storefront.css'), 'utf8');

function ruleBody(selector: string): string {
  const at = CSS.indexOf(`${selector} {`);
  expect(at, `${selector} rule`).toBeGreaterThanOrEqual(0);
  return CSS.slice(at, CSS.indexOf('}', at));
}

describe('the Kits row strip', () => {
  it('is one line that scrolls sideways and never wraps', () => {
    const track = ruleBody('.sp-storefront .sf-kits-track');
    expect(track).toContain('display: flex;');
    expect(track).toContain('flex-wrap: nowrap;');
    expect(track).toContain('overflow-x: auto;');
    // A card whose Details are open grows alone; the others keep their height.
    expect(track).toContain('align-items: flex-start;');
  });

  it('gives each kit card a fixed width, so its photo, and so its height, is the same at every width', () => {
    expect(ruleBody('.sp-storefront .sf-kits-track > .sf-kit-card')).toContain('flex: 0 0 236px;');
  });

  it('gives the name and the item list a fixed height, whether a kit is in stock or not', () => {
    expect(ruleBody('.sp-storefront .sf-kit-card .sf-card-nm')).toMatch(/\bheight: 2\.64em;/);
    expect(ruleBody('.sp-storefront .sf-kit-desc')).toMatch(/\bheight: \d+px;/);
    expect(ruleBody('.sp-storefront .sf-kit-short')).toContain('white-space: nowrap;');
  });

  it('keeps its header on one line, so a longer kit count never wraps it', () => {
    expect(ruleBody('.sp-storefront .sf-kits .sf-sec-head .sub')).toContain('white-space: nowrap;');
  });

  it('no longer lays the Kits row out as a wrapping grid', () => {
    const code = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/\.sf-kits\s+\.sf-grid/);
  });
});
