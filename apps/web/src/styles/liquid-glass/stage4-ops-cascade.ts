import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import postcss, { type AtRule, type Rule } from 'postcss';

import { GLASS_DIR, splitSelectors } from './glass-css';

/**
 * THE CSS CASCADE OF THE GLASS RULES ON RENDERED MARKUP, for the stage 4
 * operations lane's tests (stage4-ops-cascade.test.tsx and the lane's page
 * glass tests). A rule can declare the board's value and still lose on the
 * element it was written for, to another glass rule of higher specificity
 * that also matches it (a purchase order's expected day drew at 28 px, not
 * the 16 px its rule declares). `cascaded()` answers what a browser would:
 * among the glass rules whose selector matches the element, the highest
 * specificity wins and, at equal specificity, the later one, the files read
 * in the order the browser gets them (the global glass files as index.css
 * imports them, then the page's own files as its route imports them).
 *
 * All of them sit in cascade layer lg inside @media screen, so this is their
 * order in a browser; what it leaves out on purpose: rules under any other
 * @media than a window width (reduced transparency, contrast, phones), under
 * @supports, in print.css and in keyframes; selectors with a state (:hover,
 * :focus...) or a pseudo-element; and Classic's own CSS (Tailwind's layers
 * lose to lg; an unlayered Classic file would win, and the lane's pages
 * restyle none). The geometry itself is measured on the lab.
 */

export type Specificity = [number, number, number];

/** The global glass files, in index.css's import order (print.css is print only). */
export const GLOBAL_GLASS_FILES = [
  'tokens.generated.css',
  'scene.css',
  'materials.css',
  'primitives.css',
  'shell.css',
  'visibility.css',
];

const STATE =
  /:(hover|focus|focus-visible|focus-within|active|checked|disabled|placeholder-shown)\b/u;
const PSEUDO_ELEMENT = /::|:(before|after|first-line|first-letter)\b/u;
const LEGACY_PSEUDO_ELEMENTS = new Set(['before', 'after', 'first-line', 'first-letter']);

const add = (a: Specificity, b: Specificity): Specificity => [
  a[0] + b[0],
  a[1] + b[1],
  a[2] + b[2],
];

/** Negative, zero or positive as a ranks below, with or above b. */
export const compareSpecificity = (a: Specificity, b: Specificity) =>
  a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

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
  /** The text inside the parentheses that open at i; i is left after the close. */
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
    splitSelectors(list)
      .map(specificity)
      .reduce((best, next) => (compareSpecificity(next, best) > 0 ? next : best), [0, 0, 0]);
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

/** A width-only @media query at this window width (any other query does not apply here). */
function widthApplies(query: string, width: number): boolean {
  return query.split(/\s+and\s+/u).every((part) => {
    const min = /^\(min-width:\s*(\d+(?:\.\d+)?)px\)$/u.exec(part.trim());
    if (min) return width >= Number(min[1]);
    const max = /^\(max-width:\s*(\d+(?:\.\d+)?)px\)$/u.exec(part.trim());
    if (max) return width <= Number(max[1]);
    return false;
  });
}

interface Declaration {
  selector: string;
  prop: string;
  value: string;
  important: boolean;
  /** The @media queries around the rule, apart from `screen`. */
  media: string[];
  order: number;
}

const cache = new Map<string, Declaration[]>();

/** Every declaration of a glass file that can apply on a screen at rest, in source order. */
function declarations(file: string): Declaration[] {
  const hit = cache.get(file);
  if (hit) return hit;
  const out: Declaration[] = [];
  let order = 0;
  postcss.parse(readFileSync(join(GLASS_DIR, file), 'utf8')).walkRules((rule: Rule) => {
    const media: string[] = [];
    for (let p = rule.parent; p && p.type !== 'root'; p = p.parent) {
      if (p.type !== 'atrule') continue;
      const at = p as AtRule;
      if (/keyframes$/u.test(at.name) || at.name === 'supports') return;
      if (at.name === 'media') {
        const query = at.params.replace(/\s+/gu, ' ').trim();
        if (query === 'print') return;
        if (query !== 'screen') media.push(query);
      }
    }
    for (const raw of splitSelectors(rule.selector)) {
      const selector = raw.replace(/\s+/gu, ' ').trim();
      order += 1;
      if (STATE.test(selector) || PSEUDO_ELEMENT.test(selector)) continue;
      for (const node of rule.nodes) {
        if (node.type !== 'decl') continue;
        out.push({
          selector,
          prop: node.prop,
          value: node.value,
          important: node.important,
          media,
          order,
        });
      }
    }
  });
  cache.set(file, out);
  return out;
}

/** The declaration that wins `prop` on `el`, and the selector it came from. */
export interface Cascaded {
  value: string;
  selector: string;
  file: string;
}

/**
 * The value the glass CSS gives `prop` on `el` in a window `width` px wide:
 * the global glass files, then `pageFiles` (paths under styles/liquid-glass,
 * in the route's import order). The caller puts data-appearance on <html>.
 */
export function cascaded(
  el: Element,
  prop: string,
  pageFiles: string[],
  width = 1440,
): Cascaded | undefined {
  let best: (Cascaded & { important: boolean; specificity: Specificity; rank: number }) | undefined;
  let rank = 0;
  for (const file of [...GLOBAL_GLASS_FILES, ...pageFiles]) {
    rank += 1_000_000;
    for (const d of declarations(file)) {
      if (d.prop !== prop || !d.media.every((q) => widthApplies(q, width))) continue;
      if (!el.matches(d.selector)) continue;
      const candidate = {
        value: d.value,
        selector: d.selector,
        file,
        important: d.important,
        specificity: specificity(d.selector),
        rank: rank + d.order,
      };
      const better =
        !best ||
        (candidate.important && !best.important) ||
        (candidate.important === best.important &&
          (compareSpecificity(candidate.specificity, best.specificity) > 0 ||
            (compareSpecificity(candidate.specificity, best.specificity) === 0 &&
              candidate.rank > best.rank)));
      if (better) best = candidate;
    }
  }
  return best ? { value: best.value, selector: best.selector, file: best.file } : undefined;
}
