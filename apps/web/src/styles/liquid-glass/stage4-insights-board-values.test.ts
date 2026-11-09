// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import postcss, { type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

import { enclosing, GLASS_DIR, normaliseQuotes, splitSelectors } from './glass-css';

/**
 * THE BOARD VALUES OF THE STAGE 4 INSIGHTS LANE'S OVERLAYS AND STATES, read
 * from the glass stylesheets (pages/insights.css, pages/reports.css,
 * states.css). Each entry names the board rule it follows (artifact sp.css,
 * Book-Order-Totals.dc.html, DS-Components.dc.html, Auth-States.dc.html).
 * The geometry itself is measured on the lab (stage 5); this keeps the
 * values from drifting in CI, where no browser runs.
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
      // Prettier wraps a long :has( ... ) over lines; the space it leaves
      // inside the parentheses is not part of the selector.
      const written = normaliseQuotes(
        raw.replace(/\s+/gu, ' ').replace(/\(\s+/gu, '(').replace(/\s+\)/gu, ')').trim(),
      );
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

const INSIGHTS = declarations('pages/insights.css');
const REPORTS = declarations('pages/reports.css');
const STATES = declarations('states.css');

/** The value a selector sets for a property inside exactly this media chain (the last one wins). */
function value(decls: Decl[], media: string, selector: string, prop: string): string | undefined {
  return decls
    .filter((d) => d.media === media && d.selector === selector && d.prop === prop)
    .map((d) => d.value)
    .pop();
}

/** A portalled overlay of the lane: the page root named on :root. */
const LANE = `${ROOT}:has([data-glass-page='insights'])`;
const BOT = `${ROOT}:has([data-glass-page='insights'][data-glass-view='book-order-totals'])`;
const RANGE = `${BOT} [data-glass-role='bot-date-range']`;
const STATUS = `${BOT} [data-glass-role='bot-status-menu']`;
const DRAWER = `${BOT} [data-glass='sheet'][data-glass-role='bot-orders-drawer']`;

type Entry = [
  what: string,
  decls: Decl[],
  media: string,
  selector: string,
  prop: string,
  want: string,
];

const ENTRIES: Entry[] = [
  // The PDF menu (Book-Order-Totals.dc.html Export .menu: width 270; .mi .sub 12 px ink 3).
  ['PDF menu width', INSIGHTS, '', `${LANE} [data-glass-role='report-pdf-menu']`, 'width', '270px'],
  [
    'PDF menu second line',
    INSIGHTS,
    '',
    `${LANE} [data-glass-role='report-pdf-sub']`,
    'font-size',
    '12px',
  ],
  [
    'PDF menu covers note',
    INSIGHTS,
    '',
    `${LANE} [data-glass-role='report-pdf-note']`,
    'padding',
    '4px 10px 6px',
  ],
  // The charter selector (DS-Components: the 240 px .input.select, the 300 px .menu).
  [
    'charter field width',
    INSIGHTS,
    '',
    `${ROOT} [data-glass-page='insights'] [data-glass='select'][data-glass-role='report-charter-select']`,
    'width',
    '240px',
  ],
  [
    'charter field 36 px from 640',
    INSIGHTS,
    '(min-width: 640px)',
    `${ROOT} [data-glass-page='insights'] [data-glass='select'][data-glass-role='report-charter-select']`,
    'height',
    '36px',
  ],
  [
    'charter menu 300 px',
    INSIGHTS,
    '',
    `${LANE} [data-glass='menu'][data-glass-role='report-charter-menu']`,
    'min-width',
    'min(300px, calc(100vw - 32px))',
  ],
  // The Orders placed range (sp.css .dr-pop radius 24 padding 16; .input 36; .cal-d).
  ['range radius', REPORTS, '', RANGE, 'border-radius', '24px'],
  ['range padding', REPORTS, '', `${RANGE} [data-custom-range-body]`, 'padding', '16px 16px 0'],
  ['range field height', REPORTS, '', `${RANGE} [data-typed-date] > input`, 'height', '36px'],
  ['range label', REPORTS, '', `${RANGE} [data-typed-date] > label`, 'font-size', '13px'],
  ['weekday size', REPORTS, '', `${RANGE} [data-glass='calendar'] th`, 'font-size', '11.5px'],
  [
    'day size',
    REPORTS,
    '',
    `${RANGE} [data-glass='calendar'] button[data-day]`,
    'font-size',
    '13.5px',
  ],
  [
    'band fill',
    REPORTS,
    '',
    `${RANGE} [data-glass='calendar'] td[class~='bg-success-wash']`,
    'background-color',
    'var(--lg-accent-wash)',
  ],
  [
    'band words',
    REPORTS,
    '',
    `${RANGE} [data-glass='calendar'] button[data-state='band']`,
    'color',
    'var(--lg-accent-text)',
  ],
  [
    'range end fill',
    REPORTS,
    '',
    `${RANGE} [data-glass='calendar'] button[data-state='selected']`,
    'background-color',
    'var(--lg-accent)',
  ],
  [
    'range end weight',
    REPORTS,
    '',
    `${RANGE} [data-glass='calendar'] button[data-state='selected']`,
    'font-weight',
    '700',
  ],
  [
    'today ring',
    REPORTS,
    '',
    `${RANGE} [data-glass='calendar'] button[data-day][aria-current='date']:not([data-state='selected'])`,
    'box-shadow',
    'inset 0 0 0 1.5px var(--lg-line-3)',
  ],
  [
    'range foot buttons',
    REPORTS,
    '',
    `${RANGE} [data-custom-range-footer] [data-glass='button']`,
    'height',
    '36px',
  ],
  // The Status choice (inferred .menu: .mi 36 px, radius 9).
  ['status row height', REPORTS, '', `${STATUS} fieldset > label`, 'min-height', '36px'],
  ['status row radius', REPORTS, '', `${STATUS} fieldset > label`, 'border-radius', '9px'],
  // The orders drawer (.scrim.to-end padding 10; .drawer 600, radius 24; .dlg-h; .dlg-b; .dt).
  ['drawer inset', REPORTS, '', DRAWER, 'top', '10px'],
  ['drawer width', REPORTS, '', DRAWER, 'width', 'min(600px, calc(100vw - 20px))'],
  ['drawer radius', REPORTS, '', DRAWER, 'border-radius', '24px'],
  [
    'drawer head',
    REPORTS,
    '',
    `${BOT} [data-glass-role='bot-drawer-head']`,
    'padding',
    '20px 48px 14px 24px',
  ],
  [
    'drawer title',
    REPORTS,
    '',
    `${BOT} [data-glass-role='bot-drawer-head'] > h2`,
    'line-height',
    '26px',
  ],
  ['drawer well', REPORTS, '', `${BOT} [data-glass-role='bot-drawer-body']`, 'margin', '0 8px 8px'],
  [
    'drawer well radius',
    REPORTS,
    '',
    `${BOT} [data-glass-role='bot-drawer-body']`,
    'border-radius',
    '16px',
  ],
  ['drawer band', REPORTS, '', `${BOT} [data-glass-role='bot-drawer-table'] th`, 'height', '38px'],
  [
    'drawer rows',
    REPORTS,
    '',
    `${BOT} [data-glass-role='bot-drawer-table'] tbody > tr`,
    'height',
    '44px',
  ],
  // The states (sp.css .empty-ic 56 px radius 18; the 404's 44 px block buttons).
  [
    'error tile',
    STATES,
    '',
    `${ROOT} [data-glass='error-frame'] [data-glass-role='error-card'] > div:first-child > svg`,
    'width',
    '56px',
  ],
  [
    'error tile radius',
    STATES,
    '',
    `${ROOT} [data-glass='error-frame'] [data-glass-role='error-card'] > div:first-child > svg`,
    'border-radius',
    '18px',
  ],
  [
    'error card radius',
    STATES,
    '',
    `${ROOT} [data-glass='error-frame'] [data-glass-role='error-card']`,
    'border-radius',
    '24px',
  ],
];

describe('stage 4 insights board values', () => {
  for (const [what, decls, media, selector, prop, want] of ENTRIES) {
    it(`${what}: ${prop} ${want}`, () => {
      expect(value(decls, media, selector, prop), selector).toBe(want);
    });
  }
});
