import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanup, render } from '@testing-library/react';
import type { AtRule, Declaration, Rule } from 'postcss';
import { afterEach, describe, expect, it } from 'vitest';

import {
  GLASS_DIR,
  GLASS_ROOT,
  cssRules,
  enclosing,
  glassSourceFiles,
  inKeyframes,
  parse,
  type CssRule,
} from '@/styles/liquid-glass/glass-css';

import { renderDashboardWidgets } from './index';
import type { DashboardWidgetProps } from './types';

/**
 * THE MOVEMENTS CARD'S BARS GROW IN ONCE, IN LIQUID GLASS ONLY
 * (styles/liquid-glass/shell.css, its last block). The rules reach today's
 * markup with no hook of their own, so this test renders the card as the
 * Overview does (through the widget renderer, which sets data-widget on the
 * card's cell) and holds the rules to the markup and to what was decided:
 *   - under the glass root they match the thirty bars and the share bars and
 *     nothing else, and without the root (Classic) they match nothing;
 *   - every rule sits inside @media screen and
 *     @media (prefers-reduced-motion: no-preference), so "reduce motion" and
 *     print get no animation at all;
 *   - the keyframes name only the start, and only transform and opacity, and
 *     the fill mode is `backwards`: nothing changes size or place, and when
 *     the motion ends no animated value is left on a bar;
 *   - it runs once (no iteration count, no direction), on the glass motion
 *     tokens, left to right, and all of it is over within 900 ms;
 *   - no Classic stylesheet and no component names the keyframes, and the
 *     chart stays a Server Component with no class or attribute for this;
 *   - while the card carries data-glass-grow="wait" (set by
 *     movements-breakdown-glass-grow.tsx when the card is outside the window;
 *     its own test holds the trigger) two more rules hold the same bars at
 *     the keyframes' start with no animation, so taking the attribute off
 *     starts the motion; without the attribute they match nothing.
 */

const SHELL = 'shell.css';
const KEYFRAMES = ['lg-bar-rise', 'lg-share-grow'] as const;
const MOTION_OK = 'prefers-reduced-motion: no-preference';
const SRC = join(GLASS_DIR, '..', '..');

const BAR_VALUES = Array.from({ length: 30 }, (_, i) => (i % 7 === 4 ? 0 : i + 1));
const ROWS = [
  { label: 'Receive PO', share: 0.41, val: 163 },
  { label: 'Sale', share: 0.27, val: 107 },
  { label: 'Transfer', share: 0.17, val: 68 },
  { label: 'Adjustment', share: 0.1, val: 40 },
  { label: 'Bundle assembly', share: 0.05, val: 19 },
];

function renderCard(overrides: Partial<DashboardWidgetProps> = {}) {
  // The card reads two fields of the bag; the renderer passes the bag through.
  const props = { barValues: BAR_VALUES, breakdownRows: ROWS, ...overrides };
  return render(
    <>{renderDashboardWidgets(['movements-breakdown'], props as DashboardWidgetProps)}</>,
  );
}

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The rules of shell.css that set an animation property naming one of the two keyframes, or a delay for one. */
const all: CssRule[] = cssRules(SHELL);
const isGrowSelector = (s: string) => s.includes("[data-widget='movements-breakdown']");
const cardRules = all.filter((r) => r.selectors.some(isGrowSelector));
const WAIT = "[data-slot='chart-card'][data-glass-grow='wait']";
/** The two rules that hold the bars while the card waits to come into view. */
const waitRules = cardRules.filter((r) => r.selectors.every((s) => flat(s).includes(WAIT)));
/** The rules of the motion itself. */
const growRules = cardRules.filter((r) => !waitRules.includes(r));
const barRules = growRules.filter((r) =>
  r.selectors.every((s) => /div\[aria-hidden='true'\]/.test(s)),
);
const shareRules = growRules.filter((r) =>
  r.selectors.every((s) => /span\[aria-hidden='true'\]/.test(s)),
);

const matching = (rules: CssRule[]) =>
  new Set(
    rules.flatMap((r) => r.selectors.flatMap((s) => [...document.querySelectorAll(flat(s))])),
  );

/** The motion tokens, in milliseconds, as tokens.generated.css gives them to the glass root. */
function tokens(): Record<string, number> {
  const text = readFileSync(join(GLASS_DIR, 'tokens.generated.css'), 'utf8');
  const out: Record<string, number> = {};
  for (const m of text.matchAll(/(--lg-d-\d):\s*(\d+)ms;/g)) {
    const [, name, ms] = m;
    if (out[name!] !== undefined) expect(out[name!], name).toBe(Number(ms)); // the same in every variant
    out[name!] = Number(ms);
  }
  return out;
}

/** A time written with the tokens (a token, a calc of them, or 0s), in milliseconds. */
function ms(value: string, t: Record<string, number>): number {
  const expr = value
    .trim()
    .replace(/^calc\((.*)\)$/s, '$1')
    .replace(/var\((--lg-d-\d)\)/g, (_, name: string) => String(t[name]))
    .replace(/\b0s\b/g, '0');
  expect(expr, value).toMatch(/^[\d\s+*/().-]+$/);
  // Numbers and arithmetic only (checked above).
  return Number(new Function(`return (${expr});`)());
}

/** The last matching rule's value for a property (the later, more specific nth-child rules win). */
function declared(el: Element, rules: CssRule[], prop: string): string | undefined {
  let value: string | undefined;
  for (const r of rules) {
    if (r.decls[prop] !== undefined && r.selectors.some((s) => el.matches(flat(s)))) {
      value = r.decls[prop];
    }
  }
  return value;
}

/** duration and delay of an `animation` shorthand written as "name duration easing delay fill". */
function shorthand(value: string) {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of value.replace(/\s+/g, ' ').trim()) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ' ' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur);
  const [name, duration, easing, delay, fill, ...rest] = parts;
  return { name, duration, easing, delay, fill, rest };
}

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-appearance');
});

describe("the Movements card's grow-in (Liquid Glass only)", () => {
  it('has its rules: one base rule and thirty delays for the bars, one base rule and four delays for the share bars', () => {
    expect(barRules).toHaveLength(31);
    expect(shareRules).toHaveLength(5);
    expect(growRules).toHaveLength(36);
    expect(waitRules).toHaveLength(2);
    expect(cardRules).toHaveLength(38);
  });

  it('every rule starts with the glass root and sits inside @media screen and the motion-allowed condition', () => {
    for (const r of cardRules) {
      for (const s of r.selectors) expect(flat(s)).toMatch(GLASS_ROOT);
      // cssRules leaves `screen` out of .media; what remains is the motion condition alone.
      expect(r.media).toEqual([`(${MOTION_OK})`]);
    }
    // And read straight from the file: every rule that sets an animation for these keyframes.
    let seen = 0;
    parse(readFileSync(join(GLASS_DIR, SHELL), 'utf8'), SHELL).walkDecls(/^animation/, (d) => {
      const rule = d.parent as Rule;
      if (!isGrowSelector(rule.selector)) return;
      seen += 1;
      const around = enclosing(rule).map(flat);
      expect(around).toContain('@media screen');
      expect(around).toContain(`@media (${MOTION_OK})`);
      expect(around).toContain('@layer lg');
    });
    expect(seen).toBe(38);
  });

  it('under the glass root the rules match the thirty bars and the five share bars, and nothing else', () => {
    document.documentElement.setAttribute('data-appearance', 'liquid-glass');
    const { container } = renderCard();
    const chart = container.querySelector('[data-slot="chart-card"] div[aria-hidden="true"]')!;
    const bars = [...chart.children];
    const shares = [...container.querySelectorAll('span[aria-hidden="true"] > span')];
    expect(bars).toHaveLength(30);
    expect(shares).toHaveLength(5);
    expect(matching(barRules)).toEqual(new Set(bars));
    expect(matching(shareRules)).toEqual(new Set(shares));
    // The same card beside the value card's cell (the default layout) is reached the same way.
    expect(container.querySelector('[data-widget="movements-breakdown"]')).not.toBeNull();
  });

  it('without the glass root (Classic) no rule matches anything', () => {
    const { container } = renderCard();
    expect(
      container.querySelectorAll('[data-slot="chart-card"] div[aria-hidden="true"] > div'),
    ).toHaveLength(30);
    expect(matching(cardRules).size).toBe(0);
    document.documentElement.setAttribute('data-appearance', 'classic');
    expect(matching(cardRules).size).toBe(0);
    // Nor with the trigger's attribute on the card (it is never set in Classic; were it, nothing reads it).
    container.querySelector('[data-slot="chart-card"]')!.setAttribute('data-glass-grow', 'wait');
    expect(matching(cardRules).size).toBe(0);
  });

  it('while the card waits, two rules hold the same bars at the keyframes’ start with no animation; without the attribute they match nothing', () => {
    document.documentElement.setAttribute('data-appearance', 'liquid-glass');
    const { container } = renderCard();
    const card = container.querySelector('[data-slot="chart-card"]')!;
    expect(matching(waitRules).size).toBe(0);

    card.setAttribute('data-glass-grow', 'wait');
    expect(matching(waitRules)).toEqual(matching(growRules));
    expect(matching(waitRules).size).toBe(35);

    // The start each keyframe names is the transform the hold sets, so the
    // motion begins exactly where the hold left the bar.
    const starts: Record<string, string> = {};
    parse(readFileSync(join(GLASS_DIR, SHELL), 'utf8'), SHELL).walkAtRules(
      'keyframes',
      (at: AtRule) => {
        at.walkDecls('transform', (d: Declaration) => {
          starts[at.params] = d.value;
        });
      },
    );
    const [bars, shares] = waitRules;
    expect(bars!.decls).toEqual({ animation: 'none', transform: starts['lg-bar-rise'] });
    expect(shares!.decls).toEqual({ animation: 'none', transform: starts['lg-share-grow'] });
    expect(starts).toEqual({ 'lg-bar-rise': 'scaleY(0)', 'lg-share-grow': 'scaleX(0)' });

    // The hold wins over the motion on the same element: one more attribute, so a higher specificity.
    for (const r of waitRules) {
      for (const s of r.selectors) {
        expect(flat(s).replace(WAIT, "[data-slot='chart-card']")).toBe(
          flat((r === bars ? barRules : shareRules)[0]!.selectors[0]!),
        );
      }
    }

    // Any other value, or the attribute anywhere but on the card, holds nothing.
    card.setAttribute('data-glass-grow', 'go');
    expect(matching(waitRules).size).toBe(0);
    card.removeAttribute('data-glass-grow');
    container
      .querySelector('[data-widget="movements-breakdown"]')!
      .setAttribute('data-glass-grow', 'wait');
    expect(matching(waitRules).size).toBe(0);
  });

  it('an empty chart and an empty list give the rules nothing to move', () => {
    document.documentElement.setAttribute('data-appearance', 'liquid-glass');
    renderCard({ barValues: [], breakdownRows: [] });
    expect(matching(cardRules).size).toBe(0);
  });

  it('the bars start left to right on the motion tokens, run once, and all is over within 900 ms', () => {
    document.documentElement.setAttribute('data-appearance', 'liquid-glass');
    const { container } = renderCard({ barValues: [...BAR_VALUES, 5] }); // a thirty-first bar
    const t = tokens();
    expect(Object.keys(t).sort()).toEqual(['--lg-d-1', '--lg-d-2', '--lg-d-3', '--lg-d-4']);

    const timing = (el: Element, rules: CssRule[], keyframes: string) => {
      const a = shorthand(declared(el, rules, 'animation')!);
      expect(a.name).toBe(keyframes);
      expect(a.easing).toBe('var(--lg-ease)');
      expect(a.fill).toBe('backwards');
      expect(a.rest).toEqual([]); // no iteration count, no direction: once, forwards in time
      const delay = ms(declared(el, rules, 'animation-delay') ?? a.delay!, t);
      return { delay, end: delay + ms(a.duration!, t) };
    };

    const bars = [
      ...container.querySelector('[data-slot="chart-card"] div[aria-hidden="true"]')!.children,
    ];
    const barTimes = bars.map((b) => timing(b, barRules, 'lg-bar-rise'));
    expect(barTimes[0]!.delay).toBe(0);
    for (let i = 1; i < 30; i++) expect(barTimes[i]!.delay).toBeGreaterThan(barTimes[i - 1]!.delay);
    expect(barTimes[30]!.delay).toBeGreaterThanOrEqual(barTimes[29]!.delay); // an extra bar goes with the last

    const shares = [...container.querySelectorAll('span[aria-hidden="true"] > span')];
    const shareTimes = shares.map((s) => timing(s, shareRules, 'lg-share-grow'));
    for (let i = 1; i < shareTimes.length; i++)
      expect(shareTimes[i]!.delay).toBeGreaterThan(shareTimes[i - 1]!.delay);

    for (const x of [...barTimes, ...shareTimes]) expect(x.end).toBeLessThanOrEqual(900);
  });

  it('the rules set nothing but the animation and its origin, and the keyframes move transform and opacity from a start only', () => {
    const props = new Set(growRules.flatMap((r) => Object.keys(r.decls)));
    expect([...props].sort()).toEqual(['animation', 'animation-delay', 'transform-origin']);
    // The hold adds transform alone: no size, no place, no display, no opacity.
    const held = new Set(waitRules.flatMap((r) => Object.keys(r.decls)));
    expect([...held].sort()).toEqual(['animation', 'transform']);

    const found: Record<string, { steps: string[]; props: string[] }> = {};
    parse(readFileSync(join(GLASS_DIR, SHELL), 'utf8'), SHELL).walkAtRules(
      'keyframes',
      (at: AtRule) => {
        if (!(KEYFRAMES as readonly string[]).includes(at.params)) return;
        const steps: string[] = [];
        const moved: string[] = [];
        at.walkRules((step) => {
          expect(inKeyframes(step)).toBe(true);
          steps.push(step.selector);
          step.walkDecls((d: Declaration) => {
            moved.push(d.prop);
          });
        });
        found[at.params] = { steps, props: moved.sort() };
      },
    );
    expect(found).toEqual({
      'lg-bar-rise': { steps: ['from'], props: ['opacity', 'transform'] },
      'lg-share-grow': { steps: ['from'], props: ['transform'] },
    });
  });

  it('only shell.css names the keyframes: no other glass sheet, no Classic stylesheet', () => {
    const names = new RegExp(KEYFRAMES.join('|'));
    const glassFiles = glassSourceFiles()
      .filter((f) => names.test(f.text))
      .map((f) => f.file);
    expect(glassFiles).toEqual([SHELL]);
    expect(readFileSync(join(SRC, 'app', 'globals.css'), 'utf8')).not.toMatch(names);
  });

  it('the chart and the card carry nothing for it: still Server Components, no class, no attribute, no animation in the markup', () => {
    for (const file of [
      'components/dashboard/mini-bar-chart.tsx',
      'components/dashboard/widgets/movements-breakdown.tsx',
    ]) {
      const text = readFileSync(join(SRC, file), 'utf8');
      expect(text, file).not.toMatch(/['"]use client['"]/);
      expect(text, file).not.toMatch(/\buse[A-Z]\w*\(/);
      expect(text, file).not.toMatch(/animat|transition|data-glass/i);
    }
    const { container } = renderCard();
    for (const el of container.querySelectorAll('[aria-hidden="true"], [aria-hidden="true"] *')) {
      for (const name of el.getAttributeNames())
        expect(['aria-hidden', 'class', 'style']).toContain(name);
      expect(el.getAttribute('style') ?? '').not.toMatch(/animation|transform|transition/);
    }
  });
});
