// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PoReceivingProgress } from '@/components/po/po-receiving-glass';

import { cssRules, type CssRule } from './glass-css';

/**
 * THE CASCADE OF THE STAGE 4 OPERATIONS LANE'S GLASS RULES on real markup.
 * stage4-ops-board-values.test.ts reads the value each rule declares; a rule
 * can still lose on the element it is written for, to another lane rule of
 * higher specificity that also matches it (the purchase order's expected day
 * was written at 16 / 24, 600, and drew at 28 / 34, 650, because the
 * figures' `> span:nth-child(2)` rule out-ranked its `> [data-glass=...]`).
 * Here the lane's components are rendered under the glass root and each
 * element's value is the one the CSS cascade gives it: among the lane rules
 * (pages/ops.css, then the page's own file, as the pages import them) whose
 * selector matches, the highest specificity wins and, at equal specificity,
 * the later one. All of them sit in layer lg inside @media screen, so this is
 * the browser's order for them; the geometry itself is measured on the lab.
 */

type Specificity = [number, number, number];

const STATE = /:(hover|focus|focus-visible|focus-within|active|checked|disabled)\b/u;
const LEGACY_PSEUDO_ELEMENTS = new Set(['before', 'after', 'first-line', 'first-letter']);

/** Split at top-level commas (not inside parentheses, brackets or quotes). */
function splitList(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (let i = 0; i < list.length; i += 1) {
    const ch = list[i]!;
    if (ch === '\\') {
      current += ch + (list[i + 1] ?? '');
      i += 1;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth -= 1;
    else if (ch === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

const add = (a: Specificity, b: Specificity): Specificity => [
  a[0] + b[0],
  a[1] + b[1],
  a[2] + b[2],
];
const compare = (a: Specificity, b: Specificity) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** Selectors Level 4 specificity of one complex selector (no top-level comma). */
export function specificity(selector: string): Specificity {
  let s: Specificity = [0, 0, 0];
  let i = 0;
  const ident = () => {
    const start = i;
    while (i < selector.length) {
      const ch = selector[i]!;
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (/[\w-]/u.test(ch) || ch.charCodeAt(0) > 127) i += 1;
      else break;
    }
    return selector.slice(start, i);
  };
  /** The text inside the parentheses that open at i, i left after the close. */
  const parens = () => {
    let depth = 0;
    let quote: string | null = null;
    const start = i + 1;
    for (; i < selector.length; i += 1) {
      const ch = selector[i]!;
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) {
          i += 1;
          return selector.slice(start, i - 1);
        }
      }
    }
    throw new Error(`Unclosed parenthesis in ${selector}`);
  };
  const maxOf = (list: string): Specificity =>
    splitList(list)
      .map(specificity)
      .reduce((best, next) => (compare(next, best) > 0 ? next : best), [0, 0, 0]);
  while (i < selector.length) {
    const ch = selector[i]!;
    if (/[\s>+~*]/u.test(ch)) {
      i += 1;
    } else if (ch === '#') {
      i += 1;
      ident();
      s = add(s, [1, 0, 0]);
    } else if (ch === '.') {
      i += 1;
      ident();
      s = add(s, [0, 1, 0]);
    } else if (ch === '[') {
      let quote: string | null = null;
      for (; i < selector.length; i += 1) {
        const c = selector[i]!;
        if (quote) {
          if (c === quote) quote = null;
        } else if (c === '"' || c === "'") quote = c;
        else if (c === ']') break;
      }
      i += 1;
      s = add(s, [0, 1, 0]);
    } else if (ch === ':' && selector[i + 1] === ':') {
      i += 2;
      ident();
      if (selector[i] === '(') parens();
      s = add(s, [0, 0, 1]);
    } else if (ch === ':') {
      i += 1;
      const name = ident().toLowerCase();
      const args = selector[i] === '(' ? parens() : null;
      if (name === 'where') continue;
      if (name === 'is' || name === 'not' || name === 'has' || name === 'matches') {
        s = add(s, maxOf(args ?? ''));
      } else if (LEGACY_PSEUDO_ELEMENTS.has(name)) {
        s = add(s, [0, 0, 1]);
      } else {
        s = add(s, [0, 1, 0]);
        const of = args ? /\bof\s+(.+)$/u.exec(args) : null;
        if ((name === 'nth-child' || name === 'nth-last-child') && of?.[1]) {
          s = add(s, maxOf(of[1]));
        }
      }
    } else {
      ident();
      s = add(s, [0, 0, 1]);
    }
  }
  return s;
}

/** A width-only @media condition at this window width (anything else does not apply here). */
function mediaApplies(media: string[], width: number): boolean {
  return media.every((query) => {
    const parts = query.split(/\s+and\s+/u);
    return parts.every((part) => {
      const min = /^\(min-width:\s*(\d+)px\)$/u.exec(part.trim());
      if (min) return width >= Number(min[1]);
      const max = /^\(max-width:\s*(\d+)px\)$/u.exec(part.trim());
      if (max) return width <= Number(max[1]);
      return false;
    });
  });
}

interface Candidate {
  value: string;
  specificity: Specificity;
  order: number;
  selector: string;
}

/**
 * The value the lane's rules give `prop` on `el` in a window `width` wide:
 * the matching declaration of highest specificity, the later of equals.
 * Selectors with a state or a pseudo-element are left out (none applies to
 * the element at rest).
 */
function cascaded(el: Element, prop: string, files: string[], width = 1440): Candidate | undefined {
  let best: Candidate | undefined;
  let order = 0;
  for (const file of files) {
    for (const rule of cssRules(file) as CssRule[]) {
      const value = rule.decls[prop];
      for (const raw of rule.selectors) {
        order += 1;
        if (value === undefined || !mediaApplies(rule.media, width)) continue;
        const selector = raw.replace(/\s+/gu, ' ');
        if (/::|:(before|after)\b/u.test(selector) || STATE.test(selector)) continue;
        if (!el.matches(selector)) continue;
        const candidate = { value, specificity: specificity(selector), order, selector };
        if (
          !best ||
          compare(candidate.specificity, best.specificity) > 0 ||
          (compare(candidate.specificity, best.specificity) === 0 && candidate.order > best.order)
        ) {
          best = candidate;
        }
      }
    }
  }
  return best;
}

beforeEach(() => {
  document.documentElement.setAttribute('data-appearance', 'liquid-glass');
  vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
});

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-appearance');
  vi.unstubAllEnvs();
});

describe('the specificity this test ranks rules by', () => {
  it.each([
    ['h1', [0, 0, 1]],
    ['.a.b', [0, 2, 0]],
    ['#x .a', [1, 1, 0]],
    ["[data-glass='x'] > span:nth-child(2)", [0, 2, 1]],
    [":root[data-appearance='liquid-glass'] a", [0, 2, 1]],
    [':is(.a, #b) span', [1, 0, 1]],
    [':where(.a, #b) span', [0, 0, 1]],
    [':not([data-x]) > td:first-child', [0, 2, 1]],
    ['div:has(> [data-glass=y])::before', [0, 1, 2]],
    ['.\\@container > .max-w-\\[1040px\\]', [0, 2, 0]],
  ] as const)('%s is %j', (selector, want) => {
    expect(specificity(selector)).toEqual(want);
  });
});

describe('a purchase order (Purchase-Order.dc.html receiving card)', () => {
  const FILES = ['pages/ops.css', 'pages/po.css'];

  function card() {
    const view = render(
      <div data-glass-page="ops" data-glass-view="purchase-order">
        <PoReceivingProgress
          status="partially_received"
          lines={[
            { quantityOrdered: 30, quantityReceived: 26 },
            { quantityOrdered: 20, quantityReceived: 10 },
          ]}
          expectedAt="2026-10-30"
        />
      </div>,
    );
    const q = (sel: string) => view.container.querySelector(sel)!;
    return {
      day: q("[data-glass='po-progress-day']"),
      received: q("[data-glass='po-progress-stat'] > span:nth-child(2)"),
    };
  }

  it('draws the expected day as the board does (.lg.strong: 16 / 24, 600, the body face), not as a 28 px figure', () => {
    const { day } = card();
    expect(day.textContent).toBe('Fri, Oct 30');
    expect(cascaded(day, 'font-size', FILES)?.value).toBe('16px');
    expect(cascaded(day, 'line-height', FILES)?.value).toBe('24px');
    expect(cascaded(day, 'font-weight', FILES)?.value).toBe('600');
    expect(cascaded(day, 'font-family', FILES)?.value).toBe('inherit');
    expect(cascaded(day, 'letter-spacing', FILES)?.value).toBe('0');
  });

  it('keeps the figures beside it at the board .stat-v (28 / 34, 650)', () => {
    const { received } = card();
    expect(received.textContent).toBe('36 of 50 units');
    expect(cascaded(received, 'font-size', FILES)?.value).toBe('28px');
    expect(cascaded(received, 'line-height', FILES)?.value).toBe('34px');
    expect(cascaded(received, 'font-weight', FILES)?.value).toBe('650');
  });
});
