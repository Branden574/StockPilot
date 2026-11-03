// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Glass-only and classic-only elements (Liquid Glass plan 4.4, review finding
 * R2). The unit half: the elements never use the HTML `hidden` attribute (which
 * Tailwind's preflight hides with !important in @layer base, beyond the reach
 * of layer lg) and carry no class that sets `display` (an unlayered or later
 * rule would show them in classic), and a stateful leaf is never inside one.
 * The computed-display half (display:none in classic, a visible box in glass)
 * runs in Playwright on the lab with the compiled CSS.
 */

const SRC = join(__dirname, '..', '..');
const DISPLAY_CLASS =
  /(^|\s)(?:[\w-]+:)*(block|inline|inline-block|flex|inline-flex|grid|inline-grid|contents|table|hidden|sr-only)(\s|$)/;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(e.name) && !/\.test\.tsx$/.test(e.name)) out.push(p);
  }
  return out;
}

const ELEMENTS = walk(SRC).flatMap((file) => {
  const text = readFileSync(file, 'utf8');
  return [...text.matchAll(/<[\w.]+\s[^>]*\bdata-(glass|classic)-only\b[^>]*>/g)].map((m) => ({
    file: relative(SRC, file),
    tag: m[0],
  }));
});

describe('glass-only and classic-only elements', () => {
  it('never use the hidden attribute', () => {
    expect(ELEMENTS.filter((e) => /\shidden(\s|=|>)/.test(e.tag))).toEqual([]);
  });

  it('carry no class that sets display', () => {
    const offenders = ELEMENTS.filter((e) => {
      const cls = /className="([^"]*)"/.exec(e.tag)?.[1] ?? '';
      return DISPLAY_CLASS.test(cls);
    });
    expect(offenders).toEqual([]);
  });

  // plans/REVISION-DEFAULT.md item 22: the appearance menu in the external
  // shell's corner (no data action; tests/e2e/appearance/glass-only-allowlist.json).
  it('are listed: the external appearance menu only, so a new one is reviewed here first', () => {
    expect(ELEMENTS.map((e) => e.file)).toEqual(['components/auth/external-shell.tsx']);
  });
});
