// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * P68-KBD-01: on the item page's two-column grid (1280), Tab from the right
 * column's last link (Being counted in CC-...) went back up to Market price's
 * Refresh, and the browser left it under the 214 px sticky header, so no focus
 * showed. Browsers scroll a focused control only until it is inside the
 * scroller; a scroll margin on the focused control tells them to keep that much
 * room above it. The margin is the header's measured height plus 12 px for the
 * focus ring, and only a focused control below the header gets it: the tab
 * strip keeps the height on the page column (item-detail-tabs.test.tsx), and
 * every tab panel is the header's sibling in that column, so the control
 * inherits it (item-detail.redesign.test.tsx).
 *
 * The first version padded the dashboard's main#main-content scroller instead,
 * behind `#main-content:has([data-item-detail-header] ~ :focus-within)`. That
 * :has() sat in the global stylesheet on the scroller of every dashboard page,
 * so every focus change, and in Chromium every DOM change, re-matched the whole
 * page on every page; and while focus was in a tab panel the padding added to
 * the #physical-count card's own scroll margin, so a jump to the card landed a
 * header height too low, and Page Down moved a header height less. These tests
 * keep the margin on the focused control and the scroller untouched.
 */

const WEB_ROOT = join(__dirname, '..', '..', '..');
// The stylesheet's rules, without its comments (which may name what they replaced).
const GLOBALS = readFileSync(join(WEB_ROOT, 'src/app/globals.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);
const SHELL = readFileSync(join(WEB_ROOT, 'src/components/dashboard/dashboard-shell.tsx'), 'utf8');
const DETAIL = readFileSync(join(WEB_ROOT, 'src/components/inventory/item-detail.tsx'), 'utf8');
const TABS = readFileSync(join(WEB_ROOT, 'src/components/inventory/item-detail-tabs.tsx'), 'utf8');
const CARD = readFileSync(
  join(WEB_ROOT, 'src/components/inventory/item-verification-card.tsx'),
  'utf8',
);

const SELECTOR = '[data-item-detail-header] ~ :focus,\n[data-item-detail-header] ~ * :focus';
const MARGIN = 'scroll-margin-top: calc(var(--item-detail-header-h, 0px) + 0.75rem);';

function ruleBody(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, `${selector} rule`).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf('}', at));
}

describe('a control reached with Tab below the item header is scrolled clear of it', () => {
  it('a focused control below the header takes a scroll margin of the header height plus 12 px', () => {
    expect(ruleBody(GLOBALS, SELECTOR)).toContain(MARGIN);
  });

  it('that is the only scroll margin or padding globals.css sets, and the shell scroller has none', () => {
    expect(GLOBALS.match(/scroll-(?:margin|padding)[\w-]*:[^;]*;/g)).toEqual([MARGIN]);
    expect(SHELL).not.toMatch(/scroll-p[tbxy]?-|scroll-padding|scrollPadding/);
  });

  it('no rule matches the main scroller with :has(), so no other page pays for the item header', () => {
    expect(GLOBALS).not.toMatch(/#main-content[^{}]*:has\(/);
    expect(GLOBALS).not.toMatch(/:has\([^{}]*data-item-detail-header/);
  });

  it('the tab strip writes the height on the page column only, and the #physical-count card keeps its own margin', () => {
    expect(TABS.match(/\b\w+\??\.style\.setProperty\(/g)).toEqual(['page.style.setProperty(']);
    expect(TABS).not.toContain("closest<HTMLElement>('#main-content')");
    expect(CARD).toContain('scroll-mt-[calc(var(--item-detail-header-h,25.25rem)+0.75rem)]');
  });

  it('the names the rule keys on are the ones the item page renders', () => {
    expect(SHELL).toContain('id="main-content"');
    expect(DETAIL).toContain('data-item-detail-header=""');
  });
});
