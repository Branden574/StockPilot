// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import tailwindcss from '@tailwindcss/postcss';
import postcss, { type Root, type Rule } from 'postcss';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * A few pattern classes do their work only in a real layout engine, so the
 * component tests can check that a class is there but not what it does. This
 * builds globals.css with the pattern sources alone and checks that each of
 * those classes becomes the rule it is there for (checked on the restyled
 * primitives, P2.6r).
 */

const DIR = __dirname;

interface BuiltRule {
  selector: string;
  /** The at-rules around the rule, innermost first ("@media (pointer: coarse)"). */
  at: string[];
  decls: Record<string, string>;
}

let root: Root;

beforeAll(async () => {
  const globals = join(DIR, '../../app/globals.css');
  const input = readFileSync(globals, 'utf8')
    .replace("@import 'tailwindcss';", "@import 'tailwindcss' source(none);")
    .concat(`\n@source "${DIR}/*.{ts,tsx}";\n@source not "${DIR}/*.test.{ts,tsx}";\n`);
  const { css } = await postcss([tailwindcss({ optimize: false })]).process(input, {
    from: globals,
  });
  root = postcss.parse(css);
}, 60_000);

/** Every rule built for the whole class `cls` (its escaped selector, then a
 *  pseudo-element, a combinator or the end). */
function built(cls: string): BuiltRule[] {
  const sel = `.${cls.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`)}`;
  const out: BuiltRule[] = [];
  root.walkRules((rule: Rule) => {
    if (!rule.selector.startsWith(sel) || /^[\w\\-]/.test(rule.selector.slice(sel.length))) return;
    const at: string[] = [];
    for (let p = rule.parent; p && p.type !== 'root'; p = p.parent) {
      if (p.type === 'atrule' && 'name' in p) at.push(`@${p.name} ${p.params}`);
    }
    const decls: Record<string, string> = {};
    rule.walkDecls((d) => {
      decls[d.prop] = d.value;
    });
    out.push({ selector: rule.selector, at, decls });
  });
  return out;
}

function only(cls: string): BuiltRule {
  const rules = built(cls);
  expect(rules, cls).toHaveLength(1);
  return rules[0]!;
}

describe('pattern classes that only a layout engine can check', () => {
  it('clips without a scroll position where the browser has overflow: clip (focus cannot scroll it)', () => {
    const rule = only('supports-[overflow:clip]:overflow-clip');
    expect(rule.at).toContain('@supports (overflow:clip)');
    expect(rule.decls).toEqual({ overflow: 'clip' });
  });

  it('gives filter triggers and chips the shared 44 px touch target on coarse pointers', () => {
    const coarse = only("pointer-coarse:before:content-['']");
    expect(coarse.at).toContain('@media (pointer: coarse)');
    expect(coarse.selector.endsWith('::before')).toBe(true);
    expect(only('before:min-h-11').decls['min-height']).toBe('calc(var(--spacing) * 11)');
    expect(only('before:min-w-11').decls['min-width']).toBe('calc(var(--spacing) * 11)');
  });

  it('makes the grid card chip the checkbox target, 44 x 44 on phones and coarse pointers', () => {
    const cover = only('[&>[role=checkbox]]:before:-inset-px');
    expect(cover.selector).toMatch(/> \[role=checkbox\]::before$/);
    expect(cover.decls.inset).toBe('-1px');
    expect(only('[&>[role=checkbox]]:before:absolute').decls.position).toBe('absolute');
    for (const cls of [
      'max-sm:[&>[role=checkbox]]:before:-inset-[9px]',
      'pointer-coarse:[&>[role=checkbox]]:before:-inset-[9px]',
    ]) {
      const rule = only(cls);
      expect(rule.selector, cls).toMatch(/> \[role=checkbox\]::before$/);
      // 26 px inside the chip's border plus 9 px each side: 44 px.
      expect(rule.decls.inset, cls).toBe('calc(9px * -1)');
    }
    expect(only('max-sm:[&>[role=checkbox]]:before:-inset-[9px]').at).toContain(
      '@media (width < 40rem)',
    );
    expect(only('pointer-coarse:[&>[role=checkbox]]:before:-inset-[9px]').at).toContain(
      '@media (pointer: coarse)',
    );
  });

  it('keeps 14 px beside an 18 px text action exactly where its touch target is on', () => {
    // textActionTouchGapY and textActionTouchMarginTop (touch-target.ts): the
    // target turns on below sm and on a coarse pointer, and so does the room.
    for (const [cls, prop, media] of [
      ['max-sm:gap-y-3.5', 'row-gap', '@media (width < 40rem)'],
      ['pointer-coarse:gap-y-3.5', 'row-gap', '@media (pointer: coarse)'],
      ['max-sm:mt-3.5', 'margin-top', '@media (width < 40rem)'],
      ['pointer-coarse:mt-3.5', 'margin-top', '@media (pointer: coarse)'],
    ] as const) {
      const rule = only(cls);
      expect(rule.at, cls).toContain(media);
      expect(rule.decls[prop], cls).toBe('calc(var(--spacing) * 3.5)');
    }
    // Wrapped header actions on a fine pointer: 6 px.
    expect(only('gap-y-1.5').decls['row-gap']).toBe('calc(var(--spacing) * 1.5)');
  });

  it('lets a table`s SKU line wrap anywhere inside it (ItemCell wrapSku)', () => {
    expect(only('[overflow-wrap:anywhere]').decls).toEqual({ 'overflow-wrap': 'anywhere' });
  });

  it('lets a segment take the track padding above and below it, and no more', () => {
    expect(only('before:-inset-y-[3px]').decls['inset-block']).toBe('calc(3px * -1)');
    expect(only('before:-inset-y-0.5').decls['inset-block']).toBe('calc(var(--spacing) * -0.5)');
    expect(only('before:inset-x-0').decls['inset-inline']).toBe('0px');
  });
});
