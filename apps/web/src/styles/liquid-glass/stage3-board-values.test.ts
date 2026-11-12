// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import postcss, { type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

import { enclosing, GLASS_DIR, normaliseQuotes, splitSelectors } from './glass-css';

/**
 * THE BOARD VALUES THE STAGE 3 ITEMS LANE'S REVIEW FOUND MISSING (the shell,
 * the top bar, the Items and Books table, the toast dock), read from the glass
 * stylesheets. Each entry names the board rule it follows (artifact sp.css,
 * Items.dc.html, Books.dc.html, AppTopbar.dc.html). The geometry itself is
 * measured on the lab (stage 5, plan 8.1); this keeps the values from drifting
 * back in CI, where no browser runs.
 *
 * Plus one rule as a whole: every piece of the top bar that blurs is named
 * again where Reduce Transparency, Increase Contrast, the low-power material
 * and forced colours take the blur away, with the same selector, so no piece
 * keeps a backdrop filter there because a more specific rule gave it one.
 */

const ROOT = ":root[data-appearance='liquid-glass']";
const REDUCED_ROOT = `${ROOT}[data-lg-material='reduced']`;
const SHARED_MEDIA = '(prefers-reduced-transparency: reduce), (prefers-contrast: more)';
const FORCED_MEDIA = '(forced-colors: active)';

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

const SHELL = declarations('shell.css');
const ITEMS = declarations('pages/items.css');
const GLOBALS = declarations('globals.glass.css');

/** The value a selector sets for a property inside exactly this media chain (the last one wins). */
function value(decls: Decl[], media: string, selector: string, prop: string): string | undefined {
  return decls
    .filter((d) => d.media === media && d.selector === selector && d.prop === prop)
    .map((d) => d.value)
    .pop();
}

const S = (rest: string) => `${ROOT} ${rest}`;
const RAIL = '(min-width: 761px) and (max-width: 1180px)';
const PAGE = ":is([data-glass-page='items'], [data-glass-page='books'])";
const TABLE = `${PAGE} [data-glass='items-table']`;
const VISUALLY_HIDDEN = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  overflow: 'hidden',
  'clip-path': 'inset(50%)',
};

type Entry = [
  what: string,
  decls: Decl[],
  media: string,
  selector: string,
  prop: string,
  want: string,
];

const ENTRIES: Entry[] = [
  // The rail (sp.css:468-470 @media (max-width:1180px)): 1180 itself is a rail.
  ['rail width', SHELL, RAIL, S("[data-glass='shell'] > [data-glass='sidebar']"), 'width', '84px'],
  // The board's 300 px search is 200 px at 1180 and under (sp.css:478).
  [
    'search at 1180 and under',
    SHELL,
    '(max-width: 1180px)',
    S("[data-glass='tb-search']"),
    'width',
    '200px',
  ],
  // From 761 px the search is the pill, never the icon (AppTopbar, Overview-Tablet).
  [
    'search pill from 761 px',
    SHELL,
    '(min-width: 761px)',
    S("[data-glass='tb-search']"),
    'display',
    'flex',
  ],
  [
    'no search icon from 761 px',
    SHELL,
    '(min-width: 761px)',
    S("[data-glass='tb-icon'][data-glass-variant='search']"),
    'display',
    'none',
  ],
  // The capsule's hairline (.vr, margin 6px 2px inside the 34 px buttons): 22 px of a 42 px piece.
  [
    'capsule hairline height',
    SHELL,
    '(min-width: 761px)',
    S("[data-glass='tb-search']"),
    'background-size',
    '1px calc(100% - 20px)',
  ],
  // The unread count (.tb-btn .badge-dot): 5 px in on the desktop bar, 2 px on the phone's bell.
  [
    'unread count, desktop',
    SHELL,
    '(min-width: 761px)',
    S("[data-glass='badge-dot']"),
    'top',
    '5px',
  ],
  [
    'unread count, desktop',
    SHELL,
    '(min-width: 761px)',
    S("[data-glass='badge-dot']"),
    'right',
    '5px',
  ],
  ['unread count, phone', SHELL, '', S("[data-glass='badge-dot']"), 'top', '2px'],
  // The wordmark (.wordmark): 17 / 650 at -0.022em.
  [
    'wordmark size',
    SHELL,
    '',
    S("[data-glass='sidebar-brand'] > a > span > span"),
    'font-size',
    '17px',
  ],
  [
    'wordmark weight',
    SHELL,
    '',
    S("[data-glass='sidebar-brand'] > a > span > span"),
    'font-weight',
    '650',
  ],
  // The first group 10 px below what precedes it (.sb-sec margin-top 10), 11 between groups.
  ['nav top room', SHELL, '', S("[data-glass='sidebar-nav']"), 'padding', '10px 6px 6px'],
  ['nav group gap', SHELL, '', S("[data-glass='sidebar-nav']"), 'gap', '11px'],
  // A word in the count's place is the .nav-pill.
  [
    'nav pill fill',
    SHELL,
    '',
    S("[data-glass='nav-ct'][data-glass-tone='pill']"),
    'background-color',
    'var(--lg-info-wash)',
  ],
  [
    'nav pill size',
    SHELL,
    '',
    S("[data-glass='nav-ct'][data-glass-tone='pill']"),
    'font-size',
    '11px',
  ],
  // The identity avatar (.av): 28 px.
  ['avatar size', SHELL, '', S("[data-glass='avatar']"), 'width', '28px'],
  // The current row's icon (.nav-item.on .ic): the accent's text colour.
  [
    'current icon colour',
    SHELL,
    '',
    S("[data-glass='nav-item'][aria-current='page'] svg"),
    'color',
    'var(--lg-accent-text)',
  ],
  // Rows (.dt .td padding var(--row-pad): 8 px, 4 px compact; .dt.compact 13 px).
  ['row padding', ITEMS, '', S(PAGE), '--row-py', 'var(--lg-row-pad)'],
  [
    'compact row padding',
    ITEMS,
    '(min-width: 761px)',
    S(`[data-density='compact'] ${PAGE}`),
    '--row-py',
    '4px',
  ],
  [
    'compact type',
    ITEMS,
    '(min-width: 761px)',
    S(`[data-density='compact'] ${TABLE}`),
    'font-size',
    '13px',
  ],
  // A record in an open group (.dt .tr.kid): no fill, the guide 22 px in.
  [
    'group member fill',
    ITEMS,
    '',
    S(`${TABLE} > tbody > tr[data-row-kind='member']`),
    'background-color',
    'transparent',
  ],
  [
    'group member guide',
    ITEMS,
    '',
    S(
      `${TABLE} > tbody > tr[data-row-kind='member'] > td:has(> [data-slot='item-cell'][data-nested])::before`,
    ),
    'left',
    '22px',
  ],
  // Unplaced (.loc.unp): the info wash.
  [
    'unplaced chip',
    ITEMS,
    '',
    S(`${TABLE} td[data-glass='rack'] > span.font-mono.text-warning[data-glass-tone='unplaced']`),
    'background-color',
    'var(--lg-info-wash)',
  ],
  // Books covers (Books.dc.html --thumb: 44px).
  [
    'book cover height',
    ITEMS,
    '',
    S("[data-glass-page='books'] [data-glass='items-table'] [data-slot='thumb']"),
    'height',
    '44px',
  ],
  // The selection bar rises as Items.dc.html runs it: rise over --d-2.
  [
    'selection bar entrance',
    ITEMS,
    '',
    S(`${PAGE} [data-glass='selbar-layer'][data-glass-state='open'] [data-glass='selbar']`),
    'animation',
    'lg-rise var(--lg-d-2) var(--lg-ease) both',
  ],
  // The toast dock sits bottom right, where Classic puts it (owner 2026-11-12);
  // toast-position.guard.test.ts pins that no glass rule moves it sideways.
  // The pane foot's lift is still added while the selection bar floats.
  [
    'dock: pane foot',
    GLOBALS,
    '(min-width: 761px)',
    `${ROOT}:has([data-glass='shell'])`,
    '--lg-dock-lift',
    '10px',
  ],
];

describe('stage 3 items lane: the board values', () => {
  for (const [what, decls, media, selector, prop, want] of ENTRIES) {
    it(`${what}: ${prop} is ${want}${media ? ` at ${media}` : ''}`, () => {
      expect(value(decls, media, selector, prop)).toBe(want);
    });
  }

  it('every rail rule ends at 1180 px, as the board does (never 1179)', () => {
    const rail = SHELL.filter((d) => /max-width: 11\d\dpx/u.test(d.media));
    expect(rail.length).toBeGreaterThan(10);
    for (const d of rail) expect(d.media).toMatch(/max-width: 1180px/u);
  });

  it('the rail hides the wordmark the way it hides the labels, never with display: none (it is the brand link’s name)', () => {
    const selector = S(
      "[data-glass='shell'] > [data-glass='sidebar'] > [data-glass='sidebar-brand'] > a > span > span",
    );
    for (const [prop, want] of Object.entries(VISUALLY_HIDDEN)) {
      expect(value(SHELL, RAIL, selector, prop), prop).toBe(want);
    }
    expect(value(SHELL, RAIL, selector, 'display')).toBeUndefined();
  });

  it('every top-bar piece that blurs is named again, unblurred, under Reduce Transparency, the low-power material and forced colours', () => {
    const blurred = [
      ...new Set(
        SHELL.filter(
          (d) =>
            d.prop === 'backdrop-filter' &&
            d.value.includes('blur(') &&
            d.selector.includes("[data-glass='tb-"),
        ).map((d) => d.selector),
      ),
    ];
    expect(blurred.length).toBeGreaterThanOrEqual(4);
    const missing = blurred.flatMap((selector) => {
      const twin = selector.replace(ROOT, REDUCED_ROOT);
      return [
        value(SHELL, SHARED_MEDIA, selector, 'backdrop-filter') === 'none'
          ? []
          : [`${selector}: not unblurred under ${SHARED_MEDIA}`],
        value(SHELL, '', twin, 'backdrop-filter') === 'none' ? [] : [`${twin}: no low-power twin`],
        value(SHELL, FORCED_MEDIA, selector, 'backdrop-filter') === 'none'
          ? []
          : [`${selector}: not unblurred under ${FORCED_MEDIA}`],
      ].flat();
    });
    expect(missing).toEqual([]);
  });

  it('compact rows start where glass is desktop (761 px): a phone keeps comfortable rows, as classic does', () => {
    const compact = ITEMS.filter((d) => d.selector.includes("[data-density='compact']"));
    expect(compact.length).toBeGreaterThan(0);
    for (const d of compact) expect(d.media, `${d.selector} ${d.prop}`).toBe('(min-width: 761px)');
  });
});
