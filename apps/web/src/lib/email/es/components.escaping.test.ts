import { describe, expect, it } from 'vitest';

import {
  button,
  ctaRow,
  escapeAttr,
  escapeHtml,
  footer,
  heroSlot,
  linkFallback,
} from './components';

/**
 * Security wave E, MED-24 — attribute-context escaping in the shared email
 * component layer.
 *
 * The property under test is "a merge value cannot escape the attribute it is
 * interpolated into": no injected tag, no injected attribute, no stray
 * unescaped quote. Asserted on the rendered HTML of the PARTIALS, because the
 * partials are now what guarantees it — the previous arrangement asked ~29
 * family templates to remember, and most did not.
 */

// The classic double-quoted-attribute breakout: close the value, add an
// attribute, then a tag.
const BREAKOUT = '" onerror="alert(1)" x="';
const TAG_BREAKOUT = '"><script>alert(1)</script><a href="';

/** No raw `"` may appear inside a rendered attribute value. */
function attrValues(html: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`${name}="([^"]*)"`, 'g');
  for (const m of html.matchAll(re)) out.push(m[1]!);
  return out;
}

describe('escapeAttr', () => {
  it('neutralizes every character that can terminate or extend an attribute', () => {
    const out = escapeAttr(BREAKOUT);
    expect(out).not.toContain('"');
    expect(out).not.toContain("'");
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
  });

  it('is idempotent, so pre-escaped family values are not double-escaped', () => {
    const url = 'https://app.test/r?a=1&b=2';
    const once = escapeHtml(url);
    expect(escapeAttr(once)).toBe(once);
    expect(escapeAttr(escapeAttr(url))).toBe(escapeAttr(url));
  });

  it('escapes a bare ampersand but leaves an existing character reference alone', () => {
    expect(escapeAttr('a=1&b=2')).toBe('a=1&amp;b=2');
    expect(escapeAttr('a=1&amp;b=2')).toBe('a=1&amp;b=2');
    // `&amp` with no semicolon is NOT a reference — it must still be escaped,
    // or the recipient's client renders `&` and drops the parameter name.
    expect(escapeAttr('a=1&amp=2')).toBe('a=1&amp;amp=2');
  });

  it('leaves an ordinary asset URL byte-identical', () => {
    const url = 'https://stockpilotusa.com/email/motion/route@2x.gif';
    expect(escapeAttr(url)).toBe(url);
  });
});

describe('button() / ctaRow() — href cannot break out', () => {
  it('escapes a breakout payload in the primary href', () => {
    const html = button({ label: 'Open', href: `https://app.test/x${BREAKOUT}` });
    // The payload survives as inert TEXT (`onerror=&quot;`); what must not
    // exist is a parsed attribute, i.e. `onerror=` followed by a real quote.
    expect(html).not.toMatch(/onerror\s*=\s*"/);
    for (const v of attrValues(html, 'href')) expect(v).not.toContain('"');
  });

  it('escapes a tag-injection payload in the primary href', () => {
    const html = button({ label: 'Open', href: TAG_BREAKOUT });
    expect(html).not.toContain('<script');
  });

  it('escapes a breakout payload in the secondary href', () => {
    const html = ctaRow({
      primary: { label: 'Open', href: 'https://app.test/ok' },
      secondary: { label: 'Contact', href: `mailto:a@b.test${TAG_BREAKOUT}` },
    });
    expect(html).not.toContain('<script');
    for (const v of attrValues(html, 'href')) expect(v).not.toContain('"');
  });

  it('does not alter a clean href with query parameters beyond entity-encoding &', () => {
    const html = button({ label: 'Open', href: 'https://app.test/r/abc?w=1&x=2' });
    expect(html).toContain('href="https://app.test/r/abc?w=1&amp;x=2"');
  });
});

describe('heroSlot() — src and alt cannot break out', () => {
  it('escapes the image src', () => {
    const html = heroSlot({ src: `https://a.test/x.gif${BREAKOUT}`, alt: 'ok' });
    // The payload survives as inert TEXT (`onerror=&quot;`); what must not
    // exist is a parsed attribute, i.e. `onerror=` followed by a real quote.
    expect(html).not.toMatch(/onerror\s*=\s*"/);
    for (const v of attrValues(html, 'src')) expect(v).not.toContain('"');
  });

  it('escapes the alt text, which carries database-derived copy', () => {
    // `alt` is built from real data in several families (destination names,
    // item labels, org names), so a hostile value lands here.
    const html = heroSlot({ src: 'https://a.test/x.gif', alt: TAG_BREAKOUT });
    expect(html).not.toContain('<script');
    for (const v of attrValues(html, 'alt')) expect(v).not.toContain('"');
  });
});

describe('footer() — link urls cannot break out', () => {
  it('escapes a hostile support url', () => {
    const html = footer({
      kind: 'ess',
      reasonHtml: 'Because you asked.',
      urls: { support: `https://app.test/support${TAG_BREAKOUT}` },
    });
    expect(html).not.toContain('<script');
    for (const v of attrValues(html, 'href')) expect(v).not.toContain('"');
  });
});

describe('linkFallback() — the pasted URL cannot inject markup', () => {
  it('escapes a tag payload in the copy-paste link', () => {
    const html = linkFallback('https://app.test/r/abc"><script>alert(1)</script>');
    expect(html).not.toContain('<script');
  });

  it('leaves a clean link readable', () => {
    expect(linkFallback('https://app.test/r/abc')).toContain('https://app.test/r/abc');
  });
});
