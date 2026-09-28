import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * .sp-storefront carries the New order page's full-height min-height (the
 * viewport less the top bar). Dialogs that borrow the class for its tokens
 * and sf-* styles inherited it: the order page's "Send delivery request"
 * dialog and the email Preview stretched to the full window height, with
 * their buttons floating mid-way (owner report 2026-09-28). Embedded hosts
 * add .sf-embedded, which resets the min-height.
 */
const DIR = __dirname;
const CSS = readFileSync(path.resolve(DIR, 'storefront.css'), 'utf8');

function ruleBody(selector: string): string {
  const at = CSS.indexOf(`${selector} {`);
  expect(at, `${selector} rule`).toBeGreaterThanOrEqual(0);
  return CSS.slice(at, CSS.indexOf('}', at));
}

/** Every className in a file that contains the sp-storefront token. */
function storefrontClassNames(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  return [...src.matchAll(/className="([^"]*\bsp-storefront\b[^"]*)"/g)].map((m) => m[1]!);
}

describe('storefront styles borrowed by dialogs', () => {
  it('.sf-embedded resets the page min-height, and outranks the page rule', () => {
    expect(ruleBody('.sp-storefront')).toContain('min-height: calc(100dvh - var(--sf-topbar-h));');
    expect(ruleBody('.sp-storefront.sf-embedded')).toContain('min-height: 0;');
  });

  it.each([
    ['the order page delivery request dialog', '../send-delivery-request-button.tsx'],
    ['the email Preview dialog', 'delivery-request-action.tsx'],
  ])('%s is embedded, so it sizes to its content', (_label, rel) => {
    const names = storefrontClassNames(path.resolve(DIR, rel));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(name.split(/\s+/), name).toContain('sf-embedded');
    }
  });
});
