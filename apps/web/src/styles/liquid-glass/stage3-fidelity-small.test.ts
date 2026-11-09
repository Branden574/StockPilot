// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import postcss, { type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

import { enclosing, GLASS_DIR, normaliseQuotes, splitSelectors } from './glass-css';

/**
 * THE BOARD VALUES OF THE STAGE 3 FIDELITY CHECK'S FIVE SMALL FINDINGS
 * (stockpilot-work/liquid-glass/stage3/app-fidelity.md), read from the glass
 * stylesheets, as stage3-board-values.test.ts reads the items lane's:
 *  1. every Thumb takes the glass frame (no white tile at Night);
 *  2. the phone top bar: page title, round search, the picker as an icon;
 *  3. the Books cover card (Books.dc.html 64-72);
 *  4. the Books table's columns and one-line rows, the header actions on the
 *     right (Books.dc.html 20-52);
 *  5. Settings > Appearance: the accent choice and the Theme segments.
 * Geometry is measured on the lab (stage 5, tests/e2e/appearance/
 * fidelity-small.spec.ts); this keeps the values from drifting in CI.
 */

const ROOT = ":root[data-appearance='liquid-glass']";
const PHONE = '(max-width: 760px)';
const DESKTOP = '(min-width: 761px)';
const COARSE = '(pointer: coarse)';
const FORCED = '(forced-colors: active)';

interface Decl {
  media: string;
  selector: string;
  prop: string;
  value: string;
}

/**
 * A selector that ends in a list, `<head> :is(a, b)`, stands for itself and
 * for each of `<head> a` and `<head> b` (as stage3-board-values.test.ts reads
 * it).
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
    if (depth < 0) return [selector];
  }
  return [selector, ...splitSelectors(list).map((member) => `${head} ${member.trim()}`)];
}

/** Every declaration of a glass file, one per selector, with the at-rules around it ("" for none beyond @media screen). */
function declarations(file: string): Decl[] {
  const out: Decl[] = [];
  postcss.parse(readFileSync(join(GLASS_DIR, file), 'utf8')).walkRules((rule: Rule) => {
    if (enclosing(rule).some((a) => /^@(-webkit-)?keyframes /u.test(a))) return;
    const media = enclosing(rule)
      .filter((a) => a !== '@media screen' && !a.startsWith('@layer'))
      .map((a) =>
        a
          .replace(/^@media /u, '')
          .replace(/\s+/gu, ' ')
          .trim(),
      )
      .reverse()
      .join(' / ');
    for (const raw of splitSelectors(rule.selector)) {
      const written = normaliseQuotes(
        raw.replace(/\s+/gu, ' ').replace(/\( /gu, '(').replace(/ \)/gu, ')').trim(),
      );
      for (const selector of withTrailingIsMembers(written)) {
        for (const node of rule.nodes) {
          if (node.type === 'decl')
            out.push({
              media,
              selector,
              prop: node.prop,
              value: node.important ? `${node.value} !important` : node.value,
            });
        }
      }
    }
  });
  return out;
}

const PRIMITIVES = declarations('primitives.css');
const SHELL = declarations('shell.css');
const ITEMS = declarations('pages/items.css');
const ITEM_DETAIL = declarations('pages/item-detail.css');

function value(decls: Decl[], media: string, selector: string, prop: string): string | undefined {
  const hits = decls.filter((d) => d.media === media && d.selector === selector && d.prop === prop);
  return hits.at(-1)?.value.replace(/\s+/gu, ' ').trim();
}

const S = (rest: string) => `${ROOT} ${rest}`;
const BOOKS_GRID = "[data-glass-page='books'] [data-slot='inventory-grid']";
const BOOKS_TABLE = "[data-glass-page='books'] [data-glass='items-table']";

type Entry = [
  what: string,
  decls: Decl[],
  media: string,
  selector: string,
  prop: string,
  want: string,
];

const ENTRIES: Entry[] = [
  // 1. Thumbnails (sp.css:302 .thumb).
  [
    'thumb: third surface, not white',
    PRIMITIVES,
    '',
    S("[data-slot='thumb']"),
    'background-color',
    'var(--lg-surface-3)',
  ],
  [
    'thumb: no classic hairline',
    PRIMITIVES,
    '',
    S("[data-slot='thumb']"),
    'border-color',
    'transparent',
  ],
  [
    'thumb: the 6% inner line',
    PRIMITIVES,
    '',
    S("[data-slot='thumb']"),
    'box-shadow',
    'inset 0 0 0 1px rgba(0, 0, 0, 0.06)',
  ],
  [
    'thumb: the hatch on the glass line',
    PRIMITIVES,
    '',
    S("[data-slot='thumb']"),
    '--ed-line',
    'var(--lg-line)',
  ],
  // 2. The phone top bar (Overview-Mobile; AppTopbar .mob pieces).
  ['title: not drawn from 761 px', SHELL, '', S("[data-glass='tb-title']"), 'display', 'none'],
  ['title: drawn on a phone', SHELL, PHONE, S("[data-glass='tb-title']"), 'display', 'block'],
  ['title: takes the room left', SHELL, PHONE, S("[data-glass='tb-title']"), 'flex', '1 1 0'],
  ['title: .h3 size', SHELL, PHONE, S("[data-glass='tb-title']"), 'font-size', '16px'],
  ['title: .h3 weight', SHELL, PHONE, S("[data-glass='tb-title']"), 'font-weight', '600'],
  ['title: one line', SHELL, PHONE, S("[data-glass='tb-title']"), 'white-space', 'nowrap'],
  ['title: ellipsis', SHELL, PHONE, S("[data-glass='tb-title']"), 'text-overflow', 'ellipsis'],
  [
    'title: gives way where the trail is on screen',
    SHELL,
    `${PHONE} / @container (min-width: 520px)`,
    S("[data-glass='topbar']:has(> [data-slot='topbar-trail']) > [data-glass='tb-title']"),
    'display',
    'none',
  ],
  [
    'round search shown on a phone',
    SHELL,
    PHONE,
    S("[data-glass='tb-icon'][data-glass-variant='search']"),
    'display',
    'grid',
  ],
  [
    'round search hidden from 761 px (the pill)',
    SHELL,
    DESKTOP,
    S("[data-glass='tb-icon'][data-glass-variant='search']"),
    'display',
    'none',
  ],
  [
    'picker: a 36 px round button on a phone',
    SHELL,
    PHONE,
    S("[data-glass='tb-btn'][data-glass-variant='warehouse']"),
    'width',
    '36px',
  ],
  [
    'picker: its 64 px classic floor yields',
    SHELL,
    PHONE,
    S("[data-glass='tb-btn'][data-glass-variant='warehouse']"),
    'min-width',
    '36px',
  ],
  [
    'picker: no padding',
    SHELL,
    PHONE,
    S("[data-glass='tb-btn'][data-glass-variant='warehouse']"),
    'padding',
    '0',
  ],
  [
    'picker: words and chevron not drawn',
    SHELL,
    PHONE,
    S("[data-glass='tb-btn'][data-glass-variant='warehouse'] > :not(svg:first-child)"),
    'display',
    'none',
  ],
  [
    'picker: the warehouse icon drawn, even under 358 px',
    SHELL,
    PHONE,
    S("[data-glass='tb-btn'][data-glass-variant='warehouse'] > svg:first-child"),
    'display',
    'block',
  ],
  [
    'phone bar: 4 px between its pieces at 390 px and under, as classic',
    SHELL,
    '(max-width: 390px)',
    S("[data-glass='topbar']"),
    'gap',
    '4px',
  ],
  [
    'phone bar: the icon cluster has no padding',
    SHELL,
    PHONE,
    S("[data-glass='tb-cap']"),
    'padding',
    '0',
  ],
  ['phone bar: the icon cluster has no gap', SHELL, PHONE, S("[data-glass='tb-cap']"), 'gap', '0'],
  [
    'phone bar: the account button drops its 4 px margin',
    SHELL,
    PHONE,
    S("[data-glass='tb-cap'] > #user-menu-trigger"),
    'margin-left',
    '0',
  ],
  [
    'phone bar: What’s New leaves the bar for the account menu',
    SHELL,
    PHONE,
    S("[data-glass='tb-cap'] > [data-glass='tb-whats-new']"),
    'display',
    'none',
  ],
  [
    'account menu: its What’s New is not drawn from 761 px',
    SHELL,
    DESKTOP,
    S("[data-glass='um-whats-new']"),
    'display',
    'none',
  ],
  // 3. The Books cover card (Books.dc.html 64-72).
  [
    'covers: auto-fill 170 px columns',
    ITEMS,
    '(min-width: 640px)',
    S(`${BOOKS_GRID} [data-slot='card-grid']`),
    'grid-template-columns',
    'repeat(auto-fill, minmax(170px, 1fr))',
  ],
  [
    'covers: 16 px apart',
    ITEMS,
    '(min-width: 640px)',
    S(`${BOOKS_GRID} [data-slot='card-grid']`),
    'gap',
    '16px',
  ],
  [
    'cover card: padding 12',
    ITEMS,
    '',
    S(`${BOOKS_GRID} [data-glass='grid-card']`),
    'padding',
    '12px',
  ],
  [
    'cover card: radius 18',
    ITEMS,
    '',
    S(`${BOOKS_GRID} [data-glass='grid-card']`),
    'border-radius',
    '18px',
  ],
  [
    'cover card: 8 px between parts',
    ITEMS,
    '',
    S(`${BOOKS_GRID} [data-glass='grid-card']`),
    'gap',
    '8px',
  ],
  [
    'cover: 2:3',
    ITEMS,
    '',
    S(`${BOOKS_GRID} [data-slot='grid-card-media']`),
    'aspect-ratio',
    '2 / 3',
  ],
  [
    'cover: spine corners',
    ITEMS,
    '',
    S(`${BOOKS_GRID} [data-slot='grid-card-media']`),
    'border-radius',
    '3px 5px 5px 3px',
  ],
  [
    'cover: photo fills the cover',
    ITEMS,
    '',
    S(`${BOOKS_GRID} [data-slot='grid-card-media'] img`),
    'object-fit',
    'cover !important',
  ],
  [
    'cover card: grade and figure share a row',
    ITEMS,
    '',
    S(`${BOOKS_GRID} [data-card-kind='record'] [data-glass='grid-card-body']`),
    'grid-template-columns',
    'minmax(0, 1fr) auto',
  ],
  [
    'cover card: the figure on the right',
    ITEMS,
    '',
    S(`${BOOKS_GRID} [data-card-kind='record'] [data-glass='grid-card-figures']`),
    'grid-column',
    '2',
  ],
  [
    'cover card: the grade on the left',
    ITEMS,
    '',
    S(`${BOOKS_GRID} [data-card-kind='record'] [data-glass='grid-card-foot']`),
    'grid-column',
    '1',
  ],
  [
    'cover card: no category line',
    ITEMS,
    '',
    S(`${BOOKS_GRID} [data-slot='grid-card-meta']`),
    'display',
    'none',
  ],
  [
    'cover card: no coverage bar',
    ITEMS,
    '',
    S(`${BOOKS_GRID} [data-glass='grid-card-coverage']`),
    'display',
    'none',
  ],
  [
    'cover card: no rack fact',
    ITEMS,
    '',
    S(`${BOOKS_GRID} [data-glass-fact='Rack']`),
    'display',
    'none',
  ],
  [
    'cover card: no crate fact',
    ITEMS,
    '',
    S(`${BOOKS_GRID} [data-glass-fact='Crate']`),
    'display',
    'none',
  ],
  [
    'cover card: "Grade" then the number, from the left',
    ITEMS,
    '',
    S(`${BOOKS_GRID} [data-glass-fact='Grade']`),
    'justify-content',
    'flex-start',
  ],
  [
    'cover card: classic’s "Gr 9" not drawn',
    ITEMS,
    '',
    S(`${BOOKS_GRID} [data-glass-fact='Grade'] [data-glass='book-grade-classic']`),
    'display',
    'none',
  ],
  [
    'cover card: the bare number drawn',
    ITEMS,
    '',
    S(`${BOOKS_GRID} [data-glass-fact='Grade'] [data-glass='book-grade-bare']`),
    'display',
    'inline',
  ],
  [
    'the bare number is drawn nowhere else',
    PRIMITIVES,
    '',
    S("[data-glass='book-grade-bare']"),
    'display',
    'none',
  ],
  // 4. The Books table and its header.
  [
    'books table: the title on one line',
    ITEMS,
    '',
    S(`${BOOKS_TABLE} [data-slot='item-cell-name']`),
    'white-space',
    'nowrap',
  ],
  [
    'books table: the title ends in an ellipsis',
    ITEMS,
    '',
    S(`${BOOKS_TABLE} [data-slot='item-cell-name']`),
    'text-overflow',
    'ellipsis',
  ],
  [
    'books table: the title column gives way first',
    ITEMS,
    '',
    S(`${BOOKS_TABLE} [data-slot='item-cell'] > :last-child`),
    'grid-template-columns',
    'minmax(0, 1fr)',
  ],
  [
    'books table: on hand notes on one line',
    ITEMS,
    '',
    S(
      `${BOOKS_TABLE} > tbody > tr > :is(:nth-child(6), :nth-child(7), :nth-child(8), :nth-child(9), :nth-child(12))`,
    ),
    'white-space',
    'nowrap',
  ],
  [
    'books header: the title grows from 240 px',
    ITEMS,
    DESKTOP,
    S(
      "[data-glass-page='books'] [data-glass='page-header'] > div:has(> [data-slot='page-header-actions']) > :first-child",
    ),
    'flex',
    '1 1 240px',
  ],
  [
    'books header: the actions on the right',
    ITEMS,
    DESKTOP,
    S("[data-glass-page='books'] [data-glass='page-header'] [data-slot='page-header-actions']"),
    'margin-left',
    'auto',
  ],
  // 5. Settings > Appearance (sp.css .choice, .rb, .seg).
  [
    'design option: .choice radius 12',
    PRIMITIVES,
    '',
    S("[data-glass='appearance-choice']"),
    'border-radius',
    '12px',
  ],
  [
    'design option: the glass .choice field line (sp.css:995), not the dark line 2',
    PRIMITIVES,
    '',
    S("[data-glass='appearance-choice']"),
    'border-color',
    'var(--lg-field-line)',
  ],
  [
    'chosen design: accent edge',
    PRIMITIVES,
    '',
    S("[data-glass='appearance-choice'][data-glass-state='on']"),
    'border-color',
    'var(--lg-accent)',
  ],
  [
    'chosen design: selection wash',
    PRIMITIVES,
    '',
    S("[data-glass='appearance-choice'][data-glass-state='on']"),
    'background-color',
    'var(--lg-sel-fill)',
  ],
  [
    'chosen design: the 1 px inset accent ring',
    PRIMITIVES,
    '',
    S("[data-glass='appearance-choice'][data-glass-state='on']"),
    'box-shadow',
    'inset 0 0 0 1px var(--lg-accent)',
  ],
  [
    'chosen design keeps its edge on hover',
    PRIMITIVES,
    '',
    S("[data-glass='appearance-choice'][data-glass-state='on']:hover"),
    'border-color',
    'var(--lg-accent)',
  ],
  ['radio: 18 px', PRIMITIVES, '', S("[data-glass='radio-dot']"), 'width', '18px'],
  ['radio: 24 px for a finger', PRIMITIVES, COARSE, S("[data-glass='radio-dot']"), 'width', '24px'],
  [
    'radio: empty edge in ink 4',
    PRIMITIVES,
    '',
    S("[data-glass='radio-dot']"),
    'border-color',
    'var(--lg-ink-4)',
  ],
  [
    'chosen radio: accent fill',
    PRIMITIVES,
    '',
    S("[data-glass='radio-dot'][data-glass-state='on']"),
    'background-color',
    'var(--lg-accent)',
  ],
  [
    'chosen radio: on-accent dot',
    PRIMITIVES,
    '',
    S("[data-glass='radio-dot'] > span"),
    'background-color',
    'var(--lg-on-accent)',
  ],
  [
    'theme: a segmented track',
    PRIMITIVES,
    '',
    S("[data-glass='appearance-seg']"),
    'display',
    'inline-flex',
  ],
  ['theme: the 3 px track', PRIMITIVES, '', S("[data-glass='appearance-seg']"), 'padding', '3px'],
  [
    'theme: track on the third surface',
    PRIMITIVES,
    '',
    S("[data-glass='appearance-seg']"),
    'background-color',
    'var(--lg-surface-3)',
  ],
  [
    'theme: 30 px segments',
    PRIMITIVES,
    '',
    S("[data-glass='appearance-seg-item']"),
    'min-height',
    '30px',
  ],
  [
    'theme: 44 px segments for a finger',
    PRIMITIVES,
    COARSE,
    S("[data-glass='appearance-seg-item']"),
    'min-height',
    '44px',
  ],
  [
    'theme: no dot in a segment',
    PRIMITIVES,
    '',
    S("[data-glass='appearance-seg-item'] > [data-glass='radio-dot']"),
    'display',
    'none',
  ],
  [
    'theme: the chosen segment lifts',
    PRIMITIVES,
    '',
    S("[data-glass='appearance-seg-item'][data-glass-state='on']"),
    'font-weight',
    '650',
  ],
  [
    'theme: forced colours show the dots again',
    PRIMITIVES,
    FORCED,
    S("[data-glass='appearance-seg-item'] > [data-glass='radio-dot']"),
    'display',
    'flex',
  ],
  [
    'forced colours: a chosen dot in the text colour',
    PRIMITIVES,
    FORCED,
    S("[data-glass='radio-dot'] > span"),
    'background-color',
    'CanvasText',
  ],
];

describe('stage 3 fidelity, small lane: the board values', () => {
  it.each(ENTRIES)('%s', (_what, decls, media, selector, prop, want) => {
    expect(value(decls, media, selector, prop)).toBe(want);
  });

  it('the Items/Books table and the item page still size and round their own thumbs, with rules more specific than the shared one', () => {
    const items = ITEMS.filter(
      (d) => d.selector.endsWith("[data-slot='thumb']") && d.prop === 'width' && d.media === '',
    );
    expect(items.map((d) => d.value)).toEqual(['40px', 'calc(44px * 0.667)']);
    expect(
      value(
        ITEM_DETAIL,
        '',
        S("[data-glass-page='item-detail'] [data-glass='page-header'] [data-slot='thumb']"),
        'border-color',
      ),
    ).toBe('var(--lg-card-line)');
  });

  it('the cover card draws the Grade fact’s own label (never visually hidden), so it reads "Grade 9"', () => {
    const hidden = ITEMS.filter(
      (d) =>
        d.selector.includes("[data-glass-fact='Grade'] > dt") &&
        ((d.prop === 'position' && d.value === 'absolute') ||
          (d.prop === 'display' && d.value === 'none') ||
          d.prop === 'clip-path'),
    );
    expect(hidden).toEqual([]);
  });

  // The phone bar's room for the page title on a touch phone (pointer:
  // coarse: every control 44 px), from the values this file declares: the
  // bar's side padding and gap, the icon cluster's padding and gap, the
  // account button's margin and whether What's New is in the bar. The bar
  // holds the menu button, the title, the warehouse picker, the round search
  // and the cluster (the bell, What's New, the account menu): four gaps. At
  // 16 / 600 "Overview" is about 72 px; the review asked for about 90 at 375.
  it.each([
    [390, 90],
    [375, 90],
    [360, 72],
  ])('phone bar at %i px on touch: the title has at least %i px', (width, floor) => {
    const px = (v: string | undefined, fallback: number) =>
      v === undefined ? fallback : Number.parseFloat(v.split(' ')[0]!);
    const sidePadding = (() => {
      const parts = value(SHELL, PHONE, S("[data-glass='topbar']"), 'padding')!.split(' ');
      return Number.parseFloat(parts[1] ?? parts[0]!);
    })();
    const gap =
      width <= 390
        ? px(
            value(SHELL, '(max-width: 390px)', S("[data-glass='topbar']"), 'gap'),
            px(value(SHELL, PHONE, S("[data-glass='topbar']"), 'gap'), 8),
          )
        : px(value(SHELL, PHONE, S("[data-glass='topbar']"), 'gap'), 8);
    const touch = px(value(SHELL, COARSE, S("[data-glass='tb-cap'] button"), 'min-width'), 0);
    expect(touch).toBe(44);
    const capPadding = px(
      value(SHELL, PHONE, S("[data-glass='tb-cap']"), 'padding'),
      px(value(SHELL, '', S("[data-glass='tb-cap']"), 'padding'), 0),
    );
    const capGap = px(
      value(SHELL, PHONE, S("[data-glass='tb-cap']"), 'gap'),
      px(value(SHELL, '', S("[data-glass='tb-cap']"), 'gap'), 0),
    );
    // Classic's ml-1 (user-menu.tsx) unless glass sets the margin.
    const accountMargin = px(
      value(SHELL, PHONE, S("[data-glass='tb-cap'] > #user-menu-trigger"), 'margin-left'),
      4,
    );
    const whatsNewInBar =
      value(SHELL, PHONE, S("[data-glass='tb-cap'] > [data-glass='tb-whats-new']"), 'display') !==
      'none';
    const capButtons = whatsNewInBar ? 3 : 2;
    const cap = 2 * capPadding + capButtons * touch + (capButtons - 1) * capGap + accountMargin;
    const room = width - 2 * sidePadding - 3 * touch - cap - 4 * gap;
    expect(room).toBeGreaterThanOrEqual(floor);
  });

  it('every Books column glass leaves out has its own key on the table hook, and the six keys are distinct', () => {
    const hidden = ITEMS.filter(
      (d) => d.prop === 'display' && d.value === 'none' && /data-glass-cols~=/u.test(d.selector),
    ).map((d) => /data-glass-cols~='(\w+)'\]\) > \* > tr > :nth-child\((\d+)\)$/u.exec(d.selector));
    expect(hidden.every(Boolean)).toBe(true);
    const pairs = hidden.map((m) => [m![1], Number(m![2])] as const);
    expect(pairs).toEqual([
      ['category', 3],
      ['charter', 4],
      ['location', 5],
      ['coverage', 10],
      ['trend', 11],
      ['updated', 13],
    ]);
  });
});
