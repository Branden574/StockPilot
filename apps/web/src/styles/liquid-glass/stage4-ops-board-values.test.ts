// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import postcss, { type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

import { enclosing, GLASS_DIR, normaliseQuotes, splitSelectors } from './glass-css';

/**
 * THE BOARD VALUES OF THE STAGE 4 OPERATIONS LANE, read from its glass
 * stylesheets (pages/ops.css, pages/counts.css, pages/po.css,
 * pages/returns.css). Each entry names the board rule it follows (artifact
 * sp.css, Cycle-Counts.dc.html, Cycle-Count-Detail.dc.html,
 * Purchase-Order.dc.html, Return-Detail.dc.html). The geometry itself is
 * measured on the lab (stage 5, plan 8.1); this keeps the values from
 * drifting back in CI, where no browser runs.
 *
 * Plus the lane's selector rules as a whole: no class-substring selector
 * (DECISIONS: class order is normalised, the token set is not, so a
 * [class*=...] match is no hook), and no :has() inside a selector list (the
 * minifier folds such a list into one :is() that starts outside the glass
 * root; compiled-css.guard.test.ts reads the build).
 */

const ROOT = ":root[data-appearance='liquid-glass']";

interface Decl {
  media: string;
  selector: string;
  prop: string;
  value: string;
}

/**
 * A selector that ends in a list, `<head> :is(a, b)`, stands for itself and
 * for each of `<head> a` and `<head> b` (shell.css names the top-bar pieces
 * that way where a plain list would hold :has()).
 */
function withTrailingIsMembers(selector: string): string[] {
  const match = /^(.*?) :is\((.*)\)$/u.exec(selector);
  const head = match?.[1];
  const list = match?.[2];
  if (head === undefined || list === undefined) return [selector];
  let depth = 0;
  for (const ch of list) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    // The :is( closes before the end: the selector goes on after it.
    if (depth < 0) return [selector];
  }
  return [selector, ...splitSelectors(list).map((member) => `${head} ${member.trim()}`)];
}

/** Every declaration of a glass file, with its selector (one per entry) and the media around it ("" for none). */
function declarations(file: string): Decl[] {
  const out: Decl[] = [];
  const text = readFileSync(join(GLASS_DIR, file), 'utf8');
  postcss.parse(text).walkRules((rule: Rule) => {
    if (enclosing(rule).some((a) => /^@(-webkit-)?keyframes /u.test(a))) return;
    const media = enclosing(rule)
      .filter((a) => a.startsWith('@media ') && a !== '@media screen')
      .map((a) => a.slice('@media '.length).replace(/\s+/gu, ' ').trim())
      .reverse()
      .join(' / ');
    for (const raw of splitSelectors(rule.selector)) {
      const written = normaliseQuotes(raw.replace(/\s+/gu, ' ').trim());
      for (const selector of withTrailingIsMembers(written)) {
        for (const node of rule.nodes) {
          if (node.type === 'decl')
            out.push({ media, selector, prop: node.prop, value: node.value });
        }
      }
    }
  });
  return out;
}

const OPS = declarations('pages/ops.css');
const COUNTS = declarations('pages/counts.css');
const PO = declarations('pages/po.css');
const RETURNS = declarations('pages/returns.css');

/** The value a selector sets for a property inside exactly this media chain (the last one wins). */
function value(decls: Decl[], media: string, selector: string, prop: string): string | undefined {
  return decls
    .filter((d) => d.media === media && d.selector === selector && d.prop === prop)
    .map((d) => d.value)
    .pop();
}

const S = (rest: string) => `${ROOT} ${rest}`;
const PAGE = "[data-glass-page='ops']";
const VIEW = (v: string) => `${PAGE}[data-glass-view='${v}']`;
const WIDE = '(min-width: 1101px)';
const NARROW = '(max-width: 1100px)';
const PHONE = '(max-width: 760px)';

type Entry = [
  what: string,
  decls: Decl[],
  media: string,
  selector: string,
  prop: string,
  want: string,
];

const ENTRIES: Entry[] = [
  // The page (sp.css .page: 6 / 28 / 48, 20 between; the phone's 4 / 16 / 96, 16).
  ['page padding', OPS, '', S(PAGE), 'padding', '6px 28px 48px'],
  ['page gap', OPS, '', S(PAGE), 'gap', '20px'],
  ['page width', OPS, '', S(`${PAGE}:not([data-glass-width='form'])`), 'max-width', '1480px'],
  ['phone page padding', OPS, PHONE, S(PAGE), 'padding', '4px 16px 96px'],
  ['phone page gap', OPS, PHONE, S(PAGE), 'gap', '16px'],
  // The head (.h1 26/32; 24/30 on a phone).
  ['title size', OPS, '', S(`${PAGE} [data-glass='page-header'] h1`), 'font-size', '26px'],
  ['title leading', OPS, '', S(`${PAGE} [data-glass='page-header'] h1`), 'line-height', '32px'],
  ['phone title size', OPS, PHONE, S(`${PAGE} [data-glass='page-header'] h1`), 'font-size', '24px'],
  // The segmented views (.seg: 3 px track, 30 px segments, 13 px, radius 8).
  ['seg track padding', OPS, '', S(`${PAGE} [data-glass='seg']`), 'padding', '3px'],
  ['seg segment height', OPS, '', S(`${PAGE} [data-glass='seg'] > *`), 'height', '30px'],
  ['seg segment padding', OPS, '', S(`${PAGE} [data-glass='seg'] > *`), 'padding', '0 12px'],
  ['seg segment radius', OPS, '', S(`${PAGE} [data-glass='seg'] > *`), 'border-radius', '8px'],
  ['seg segment size', OPS, '', S(`${PAGE} [data-glass='seg'] > *`), 'font-size', '13px'],
  [
    'seg selected weight',
    OPS,
    '',
    S(
      `${PAGE} [data-glass='seg'] > :is([aria-selected='true'], [aria-current='page'], [data-state='active'])`,
    ),
    'font-weight',
    '650',
  ],
  // The table card (.dt: the 38 px header band at 12 px, 52 px rows).
  ['header band height', OPS, '', S(`${PAGE} [data-glass='table'] th`), 'height', '38px'],
  ['header band size', OPS, '', S(`${PAGE} [data-glass='table'] th`), 'font-size', '12px'],
  [
    'row height',
    OPS,
    '',
    S(`${PAGE} [data-glass='table']:where(:not([data-slot='po-list'])) > tbody > tr`),
    'height',
    'var(--lg-row-h)',
  ],
  // Status badges (.badge: 22 px, 0 8, 12 px; the 7 px dot).
  ['badge height', OPS, '', S(`${PAGE} [data-glass='badge']`), 'height', '22px'],
  ['badge padding', OPS, '', S(`${PAGE} [data-glass='badge']`), 'padding', '0 8px'],
  ['badge size', OPS, '', S(`${PAGE} [data-glass='badge']`), 'font-size', '12px'],
  ['status dot', OPS, '', S(`${PAGE} [data-glass-role='status']::before`), 'width', '7px'],
  // Record cards (.card-h 52 px, 12 x 16; .kv).
  [
    'card head height',
    OPS,
    '',
    S(`${PAGE} [data-slot='detail-section-header']`),
    'min-height',
    '52px',
  ],
  [
    'card head padding',
    OPS,
    '',
    S(`${PAGE} [data-slot='detail-section-header']`),
    'padding',
    '12px 16px',
  ],
  [
    'label column',
    OPS,
    '',
    S(`${PAGE} [data-slot='key-value-row']`),
    'grid-template-columns',
    'minmax(110px, 38%) minmax(0, 1fr)',
  ],
  // Empty and failed states (.empty: 56 x 24, the 56 px tile at radius 18).
  ['state padding', OPS, '', S(`${PAGE} [data-glass='state-panel']`), 'padding', '56px 24px'],
  ['state tile', OPS, '', S(`${PAGE} [data-slot='state-panel-icon']`), 'width', '56px'],
  [
    'state tile radius',
    OPS,
    '',
    S(`${PAGE} [data-slot='state-panel-icon']`),
    'border-radius',
    '18px',
  ],
  // Cycle counts (Cycle-Counts.dc.html: 46 px rows; the 380 px search).
  [
    'count rows',
    COUNTS,
    '',
    S(`${VIEW('cycle-counts')} [data-glass='table'] > tbody > tr`),
    'height',
    '46px',
  ],
  [
    'count search',
    COUNTS,
    '',
    S(`${VIEW('cycle-counts')} [role='search']`),
    'width',
    'min(380px, 100%)',
  ],
  // A count (Cycle-Count-Detail.dc.html: the 96 x 34 count field).
  [
    'count field width',
    COUNTS,
    '',
    S(`${VIEW('cycle-count')} [data-glass='table'] > tbody > tr > td [data-glass='input']`),
    'width',
    '96px',
  ],
  [
    'count field height',
    COUNTS,
    '',
    S(`${VIEW('cycle-count')} [data-glass='table'] > tbody > tr > td [data-glass='input']`),
    'height',
    '34px',
  ],
  // A purchase order (sp.css .cols-side; the 680 px Receive dialog).
  [
    'record beside its column',
    PO,
    WIDE,
    S(`${VIEW('purchase-order')} > .\\@container > .grid`),
    'grid-template-columns',
    'minmax(0, 1fr) minmax(300px, 360px)',
  ],
  [
    'one column at 1100 px',
    PO,
    NARROW,
    S(`${VIEW('purchase-order')} > .\\@container > .grid`),
    'grid-template-columns',
    'minmax(0, 1fr)',
  ],
  [
    'receive dialog width',
    PO,
    '',
    `${ROOT}:has( ${VIEW('purchase-order')} ) [data-glass='dialog']:has(> .max-h-\\[55vh\\])`,
    'max-width',
    '680px',
  ],
  // A return (sp.css .cols-side: the 360 px column, 16 between; .btn-lg 44 px).
  [
    'next step column',
    RETURNS,
    WIDE,
    S(`${VIEW('return')} > .max-w-\\[1040px\\] > .flex-col > section[aria-label='Next step']`),
    'width',
    '360px',
  ],
  [
    'record beside it',
    RETURNS,
    WIDE,
    S(`${VIEW('return')} > .max-w-\\[1040px\\] > .flex-col > * + *`),
    'margin-right',
    '376px',
  ],
  [
    'primary action',
    RETURNS,
    WIDE,
    S(
      `${VIEW('return')} section[aria-label='Next step'] > .flex-wrap:first-child > [data-glass='button'][data-glass-variant='default']`,
    ),
    'height',
    '44px',
  ],
];

describe('stage 4 operations lane: the board values', () => {
  for (const [what, decls, media, selector, prop, want] of ENTRIES) {
    it(`${what}: ${prop} is ${want}${media ? ` at ${media}` : ''}`, () => {
      expect(value(decls, media, selector, prop)).toBe(want);
    });
  }

  for (const [file, decls] of [
    ['pages/ops.css', OPS],
    ['pages/counts.css', COUNTS],
    ['pages/po.css', PO],
    ['pages/returns.css', RETURNS],
  ] as const) {
    it(`${file}: no class-substring selector`, () => {
      expect(decls.filter((d) => /\[class[*^$|~]?=/u.test(d.selector))).toEqual([]);
    });

    it(`${file}: no :has() inside a selector list`, () => {
      const lists: string[] = [];
      postcss.parse(readFileSync(join(GLASS_DIR, file), 'utf8')).walkRules((rule: Rule) => {
        const selectors = splitSelectors(rule.selector);
        if (selectors.length > 1 && selectors.some((s) => s.includes(':has('))) {
          lists.push(rule.selector);
        }
      });
      expect(lists).toEqual([]);
    });
  }
});
