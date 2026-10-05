// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * L63a, L100, L136: the What's New card is fixed bottom-right, and while it
 * was up it covered whatever sat at the bottom of the page: Start count, the
 * exception note box, a report's last column, and the cart's Review order in
 * the storefront's sticky rail. UpdateCenter already publishes the card's
 * height (plus a gap) as --sp-update-card-offset with data-sp-update-card on
 * <html>; the page's scroll area now ends that much lower, and the sticky cart
 * rail is that much shorter, so both scroll clear of the card.
 */

const WEB_ROOT = join(__dirname, '..', '..', '..');
const GLOBALS = readFileSync(join(WEB_ROOT, 'src/app/globals.css'), 'utf8');
const STOREFRONT = readFileSync(
  join(WEB_ROOT, 'src/components/orders/storefront/storefront.css'),
  'utf8',
);
const CENTER = readFileSync(join(WEB_ROOT, 'src/components/updates/update-center.tsx'), 'utf8');
const SHELL = readFileSync(join(WEB_ROOT, 'src/components/dashboard/dashboard-shell.tsx'), 'utf8');

function ruleBody(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, `${selector} rule`).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf('}', at));
}

describe("the What's New card never covers the end of a page", () => {
  it('the scroll area gains bottom padding the height of the card while it is up', () => {
    expect(ruleBody(GLOBALS, 'html[data-sp-update-card] #main-content')).toContain(
      'padding-bottom: var(--sp-update-card-offset, 0px);',
    );
  });

  it("the storefront's sticky cart rail is shorter by the card, so Review order stays above it", () => {
    expect(
      ruleBody(STOREFRONT, 'html[data-sp-update-card] .sp-storefront .sf-rail'),
    ).toContain('max-height: calc(100dvh - var(--sf-topbar-h) - 40px - var(--sp-update-card-offset, 0px));');
  });

  it("below 1280 px the storefront's floating Cart button rises above the card, as the toasts do", () => {
    // The button and the card share the bottom-right corner and z-40, and the
    // card is drawn later, so at 390 px the card covered the whole button
    // (test-stage walk, c01-cart5-fab-phone).
    expect(ruleBody(STOREFRONT, 'html[data-sp-update-card] .sp-storefront .sf-fab')).toContain(
      'bottom: calc(22px + var(--sp-update-card-offset, 0px));',
    );
  });

  it('the names these rules key on are the ones UpdateCenter sets and the shell renders', () => {
    expect(CENTER).toContain("root.setAttribute('data-sp-update-card', '')");
    expect(CENTER).toContain("root.style.setProperty('--sp-update-card-offset'");
    expect(SHELL).toContain('id="main-content"');
  });
});
