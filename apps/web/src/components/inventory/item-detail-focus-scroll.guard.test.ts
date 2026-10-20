// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * P68-KBD-01: on the item page's two-column grid (1280), Tab from the right
 * column's last link (Being counted in CC-...) went back up to Market price's
 * Refresh, and the browser left it under the 214 px sticky header, so no focus
 * showed. Browsers scroll a focused control only until it is inside the
 * scroller; the scroller's scroll padding is what tells them the header covers
 * its top. The padding is the header's measured height (the tab strip keeps it
 * on main#main-content, item-detail-tabs.test.tsx) plus 12 px for the focus
 * ring, and applies only while focus is in the page BELOW the header: the
 * header's own controls are always in view (with the padding Chromium scrolled
 * the page up each time one took focus), and anchors, the skip link and every
 * other page keep the 0 px they had.
 */

const WEB_ROOT = join(__dirname, '..', '..', '..');
const GLOBALS = readFileSync(join(WEB_ROOT, 'src/app/globals.css'), 'utf8');
const SHELL = readFileSync(join(WEB_ROOT, 'src/components/dashboard/dashboard-shell.tsx'), 'utf8');
const DETAIL = readFileSync(join(WEB_ROOT, 'src/components/inventory/item-detail.tsx'), 'utf8');
const TABS = readFileSync(join(WEB_ROOT, 'src/components/inventory/item-detail-tabs.tsx'), 'utf8');

const SELECTOR = '#main-content:has([data-item-detail-header] ~ :focus-within)';
const PADDING = 'scroll-padding-top: calc(var(--item-detail-header-h, 0px) + 0.75rem);';

function ruleBody(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, `${selector} rule`).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf('}', at));
}

describe('a control reached with Tab below the item header is scrolled clear of it', () => {
  it('the main scroller pads its top by the header height plus 12 px while focus is below the header', () => {
    expect(ruleBody(GLOBALS, SELECTOR)).toContain(PADDING);
  });

  it('that is the only scroll padding the main scroller ever gets, so every other page keeps 0', () => {
    expect(GLOBALS.match(/scroll-padding[\w-]*:[^;]*;/g)).toEqual([PADDING]);
    expect(SHELL).not.toMatch(/scroll-p[tbxy]?-|scroll-padding|scrollPadding/);
  });

  it('the names the rule keys on are the ones the shell and the item page render, and the tab strip writes', () => {
    expect(SHELL).toContain('id="main-content"');
    expect(DETAIL).toContain('data-item-detail-header=""');
    expect(TABS).toContain("header.closest<HTMLElement>('#main-content')");
    expect(TABS).toContain("scroller?.style.setProperty('--item-detail-header-h', height)");
  });
});
