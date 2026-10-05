import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * L122: on the order success screen the delivery-request notes (".sf-note",
 * a <p> inside the buttons row ".acts") sat beside the buttons, squeezed into
 * a narrow column. ".sf-note" already has flex-basis: 100%, but the more
 * specific ".sp-storefront .sf-success p" capped every paragraph on the
 * screen at max-width: 380px with auto margins, so the note fit beside the
 * buttons. The notes in the row, and the popup-blocked fallback's text, now
 * take the full width.
 */
const CSS = readFileSync(path.resolve(__dirname, 'storefront.css'), 'utf8');

function ruleBody(selector: string): string {
  const at = CSS.indexOf(`${selector} {`);
  expect(at, `${selector} rule`).toBeGreaterThanOrEqual(0);
  return CSS.slice(at, CSS.indexOf('}', at));
}

describe('storefront success screen: notes in the buttons row', () => {
  it('a note in the row is not capped at the paragraph width, and sits on its own line', () => {
    const body = ruleBody('.sp-storefront .sf-success .acts > .sf-note');
    expect(body).toContain('max-width: none;');
    expect(body).toContain('margin: 4px 0 8px;');
  });

  it("the fallback panel's text is not capped either", () => {
    expect(ruleBody('.sp-storefront .sf-success .sf-fallback p')).toContain('max-width: none;');
  });

  it('the paragraph cap that caused it is still there for the screen\'s own text', () => {
    expect(ruleBody('.sp-storefront .sf-success p')).toContain('max-width: 380px;');
  });
});
