// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

import {
  cssRules,
  GLASS_DIR,
  normaliseQuotes,
  type CssRule,
} from '@/styles/liquid-glass/glass-css';

/**
 * THE PRODUCT-UPDATE CARD IN LIQUID GLASS IS OVERLAY GLASS, NOT CONTENT GLASS.
 *
 * The card (update-card.tsx, [data-update-notice]) is fixed over whatever
 * page is open. Its classic fill is bg-card. Glass draws bg-card as the 46%
 * content fill (--color-card in tokens.generated.css), which is made for
 * cards that sit on the workspace pane's frost and never blur. With no glass
 * rule of its own the card was that 46% fill with no blur over a busy page,
 * and the page's words crossed the card's own (measured in the lab on
 * 2026-11-11: rgba(255,255,255,0.46) by day, rgba(30,35,33,0.46) by night,
 * backdrop-filter none).
 *
 * What these tests pin:
 *  - the card takes the SAME rule as menus, popovers, dialogs and sheets
 *    (materials.css: the strong fill, blur 30 / saturate 160%, the inner
 *    light, the ring and the overlay shadow), so it cannot drift from them;
 *  - it is in each fallback those surfaces have (Reduce Transparency and
 *    Increase Contrast, the low-power material, forced colours);
 *  - through the card's fill alone, before any blur, the page's own ink on
 *    the page's ground is under 3:1 (the WCAG 1.4.11 bound for something to
 *    count as perceivable), where through the 46% content fill it is over;
 *  - Classic is untouched: every rule naming the card starts at the glass
 *    root, on screen, and the component still carries bg-card.
 */

const ROOT = ":root[data-appearance='liquid-glass']";
const HOOK = '[data-update-notice]';
const MATERIALS = cssRules('materials.css');
const PRIMITIVES = cssRules('primitives.css');

const flat = (rule: CssRule) => normaliseQuotes(rule.selectors.join(', ').replace(/\s+/g, ' '));
const names = (rule: CssRule, what: string) => flat(rule).includes(what);
const only = (rules: CssRule[], label: string): CssRule => {
  expect(rules.length, label).toBe(1);
  return rules[0]!;
};

describe('the product-update card is overlay glass in Liquid Glass', () => {
  it('takes the rule menus, popovers, dialogs and sheets take, declaration for declaration', () => {
    const overlay = only(
      MATERIALS.filter(
        (r) => r.media.length === 0 && r.decls['background-color'] === 'var(--lg-glass-strong)',
      ),
      'the overlay glass rule',
    );
    for (const surface of [
      "[data-glass='menu']",
      "[data-glass='popover']",
      "[data-glass='dialog']",
      "[data-glass='sheet']",
      HOOK,
    ]) {
      expect(names(overlay, surface), surface).toBe(true);
    }
    expect(overlay.decls).toMatchObject({
      'background-color': 'var(--lg-glass-strong)',
      'backdrop-filter': 'blur(30px) saturate(160%)',
      '-webkit-backdrop-filter': 'blur(30px) saturate(160%)',
      color: 'var(--lg-ink)',
    });
    expect(overlay.decls['box-shadow']?.replace(/\s+/g, ' ')).toBe(
      'var(--lg-glass-inner), 0 0 0 var(--lg-ring-w) var(--lg-glass-ring), var(--lg-sh-3)',
    );
  });

  it('has the popover radius', () => {
    const radius = (hook: string) =>
      PRIMITIVES.filter(
        (r) => r.media.length === 0 && flat(r) === `${ROOT} ${hook}` && r.decls['border-radius'],
      ).map((r) => r.decls['border-radius']);
    expect(radius(HOOK)).toEqual(['var(--lg-r-lg)']);
    expect(radius(HOOK)).toEqual(radius("[data-glass='popover']"));
  });

  it('drops its blur wherever the other overlays drop theirs, and takes system colours under forced colours', () => {
    const noBlur = MATERIALS.filter((r) => r.decls['backdrop-filter'] === 'none');
    const where = noBlur
      .filter((r) => names(r, HOOK))
      .map((r) => r.media.join(' | ') || 'no media');
    expect(where.sort()).toEqual([
      '(forced-colors: active)',
      '(prefers-reduced-transparency: reduce), (prefers-contrast: more)',
      'no media',
    ]);
    // The rule outside a media query is the low-power material's attribute twin.
    const twin = only(
      noBlur.filter((r) => r.media.length === 0 && names(r, HOOK)),
      'the low-power twin',
    );
    expect(
      twin.selectors.every((s) =>
        normaliseQuotes(s).startsWith(`${ROOT}[data-lg-material='reduced']`),
      ),
    ).toBe(true);
    const forced = only(
      noBlur.filter((r) => r.media.includes('(forced-colors: active)') && names(r, HOOK)),
      'the forced colours rule',
    );
    expect(forced.decls.background).toBe('Canvas');
  });

  it('every glass rule naming the card starts at the glass root, in @layer lg, on screen', () => {
    let seen = 0;
    for (const file of ['materials.css', 'primitives.css']) {
      postcss.parse(readFileSync(join(GLASS_DIR, file), 'utf8')).walkRules((rule) => {
        if (!rule.selector.includes('data-update-notice')) return;
        seen += 1;
        expect(normaliseQuotes(rule.selector).trimStart().startsWith(ROOT), rule.selector).toBe(
          true,
        );
        const around: string[] = [];
        for (let p = rule.parent; p && p.type !== 'root'; p = p.parent) {
          if (p.type === 'atrule') {
            const at = p as postcss.AtRule;
            around.push(`@${at.name} ${at.params}`);
          }
        }
        expect(around, rule.selector).toContain('@layer lg');
        expect(around, rule.selector).toContain('@media screen');
      });
    }
    expect(seen).toBe(5);
  });

  it('Classic keeps its own surface: the component still draws bg-card and names no glass hook', () => {
    const source = readFileSync(join(__dirname, 'update-card.tsx'), 'utf8');
    expect(source).toMatch(
      /data-update-notice\n\s+className=\{cn\(\n\s+'bg-card text-card-foreground /u,
    );
    expect(source).not.toMatch(/data-glass|liquid-glass/u);
  });
});

/* ── The crossing-text bound, from the generated tokens ───────────────────── */

type Rgba = [number, number, number, number];
function colour(value: string): Rgba {
  const c = value.trim();
  let m = /^#([0-9a-f]{6})$/iu.exec(c);
  if (m) return [0, 2, 4].map((i) => parseInt(m![1]!.slice(i, i + 2), 16)).concat(1) as Rgba;
  m = /^rgba?\(([^)]*)\)$/iu.exec(c);
  if (m) {
    const p = m[1]!.split(',').map((x) => Number(x.trim()));
    return [p[0]!, p[1]!, p[2]!, p[3] ?? 1];
  }
  throw new Error(`not a plain colour: ${value}`);
}
const over = (top: Rgba, under: Rgba): Rgba => {
  const a = top[3];
  return [0, 1, 2].map((i) => top[i]! * a + under[i]! * (1 - a)).concat(1) as Rgba;
};
const channel = (v: number) => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (c: Rgba) =>
  0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
const contrast = (a: Rgba, b: Rgba) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

/** The normal (no media query) Day and Night token sets. */
function tokens(): { day: Record<string, string>; night: Record<string, string> } {
  const out = { day: {} as Record<string, string>, night: {} as Record<string, string> };
  const glassRoot = ROOT.replace(/'/g, '"');
  postcss.parse(readFileSync(join(GLASS_DIR, 'tokens.generated.css'), 'utf8')).walkRules((rule) => {
    for (let p = rule.parent; p && p.type !== 'root'; p = p.parent) {
      if (p.type !== 'atrule') continue;
      const at = p as postcss.AtRule;
      if (at.name === 'supports' || (at.name === 'media' && at.params !== 'screen')) return;
    }
    const target =
      rule.selector === glassRoot
        ? out.day
        : rule.selector === `${glassRoot}.dark`
          ? out.night
          : null;
    if (!target) return;
    rule.walkDecls(/^--(lg-|color-card$)/u, (d) => {
      target[d.prop] = d.value;
    });
  });
  return out;
}

describe('words on the page do not read through the card', () => {
  const sets = tokens();

  /** The page's ink and the page's ground (the pane's frost on --lg-bg), both seen through `fill`. */
  const through = (t: Record<string, string>, fill: string) => {
    const ground = over(colour(t['--lg-pane']!), colour(t['--lg-bg']!));
    const f = colour(t[fill]!);
    return contrast(over(f, colour(t['--lg-ink']!)), over(f, ground));
  };

  it('reads the Day and Night token sets', () => {
    for (const t of [sets.day, sets.night]) {
      for (const name of [
        '--lg-bg',
        '--lg-pane',
        '--lg-ink',
        '--lg-glass-strong',
        '--color-card',
      ]) {
        expect(t[name], name).toBeTruthy();
      }
    }
  });

  for (const scheme of ['day', 'night'] as const) {
    it(`${scheme}: through the overlay fill the page's ink is under 3:1 before any blur`, () => {
      expect(through(sets[scheme], '--lg-glass-strong')).toBeLessThan(3);
    });
    it(`${scheme}: through the content fill the card had (bg-card in glass) it is over 3:1, which is the defect`, () => {
      expect(through(sets[scheme], '--color-card')).toBeGreaterThan(3);
    });
  }
});
