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
  // .page-h .titles (gap 4) and its title row (.row.g10).
  [
    'way back 4 px above the title',
    OPS,
    '',
    S(`${PAGE} [data-glass='page-header'] > .mb-2:first-child`),
    'margin-bottom',
    '4px',
  ],
  [
    'title row gap',
    OPS,
    '',
    S(`${PAGE} [data-glass='page-header'] div:has(> h1)`),
    'column-gap',
    '10px',
  ],
  [
    'line under the title 4 px down',
    OPS,
    '',
    S(`${PAGE} [data-glass='page-header'] div:has(> h1) + div`),
    'margin-top',
    '4px',
  ],
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
  // The procedures list (Routes-Gallery-2.dc.html panel: the cards 10 px
  // apart, .card col at radius 14 with no drop shadow on the card fill and
  // line, the 86 px .proc-thumb band, its dark chip, sm strong over xs muted).
  [
    'procedure cards apart',
    OPS,
    '',
    S(`${VIEW('procedures')} [data-slot='procedure-grid']`),
    'gap',
    '10px',
  ],
  [
    'procedure card radius',
    OPS,
    '',
    S(`${VIEW('procedures')} [data-slot='procedure-card']`),
    'border-radius',
    '14px',
  ],
  [
    'procedure card fill (not the opaque page fill)',
    OPS,
    '',
    S(`${VIEW('procedures')} [data-slot='procedure-card']`),
    'background-color',
    'var(--lg-card-fill)',
  ],
  [
    'procedure card line',
    OPS,
    '',
    S(`${VIEW('procedures')} [data-slot='procedure-card']`),
    'border-color',
    'var(--lg-card-line)',
  ],
  [
    'procedure card shadow',
    OPS,
    '',
    S(`${VIEW('procedures')} [data-slot='procedure-card']`),
    'box-shadow',
    'none',
  ],
  // That clears Classic's focus ring (a box-shadow), so the card draws the
  // glass ring, an outline (WCAG 2.4.7).
  [
    'procedure card focus ring',
    OPS,
    '',
    S(`${VIEW('procedures')} [data-slot='procedure-card']:focus-visible`),
    'outline',
    'var(--lg-focus-w) solid var(--lg-focus)',
  ],
  [
    'procedure card focus ring offset',
    OPS,
    '',
    S(`${VIEW('procedures')} [data-slot='procedure-card']:focus-visible`),
    'outline-offset',
    '2px',
  ],
  [
    'procedure band height',
    OPS,
    '',
    S(`${VIEW('procedures')} [data-slot='procedure-card-media']`),
    'height',
    '86px',
  ],
  [
    'procedure band with no poster',
    OPS,
    '',
    S(
      `${VIEW('procedures')} [data-slot='procedure-card-media'] > [data-slot='procedure-fallback-band']`,
    ),
    'background',
    'linear-gradient(135deg, var(--lg-accent-wash), var(--lg-surface-3))',
  ],
  [
    'procedure chip at the band foot',
    OPS,
    '',
    S(`${VIEW('procedures')} [data-slot='procedure-card-media'] > span:not([data-slot])`),
    'bottom',
    '6px',
  ],
  [
    'procedure chip radius',
    OPS,
    '',
    S(`${VIEW('procedures')} [data-slot='procedure-card-media'] > span:not([data-slot])`),
    'border-radius',
    '6px',
  ],
  [
    'procedure chip fill',
    OPS,
    '',
    S(`${VIEW('procedures')} [data-slot='procedure-card-media'] > span:not([data-slot])`),
    'background-color',
    'rgba(0, 0, 0, 0.68)',
  ],
  [
    'procedure title size',
    OPS,
    '',
    S(`${VIEW('procedures')} [data-slot='procedure-card'] h3`),
    'font-size',
    '13px',
  ],
  [
    'procedure title weight',
    OPS,
    '',
    S(`${VIEW('procedures')} [data-slot='procedure-card'] h3`),
    'font-weight',
    '600',
  ],
  [
    'procedure meta (xs muted)',
    OPS,
    '',
    S(`${VIEW('procedures')} [data-slot='procedure-card'] h3 ~ p`),
    'color',
    'var(--lg-ink-3)',
  ],
  // The tags list (Routes-Gallery-1.dc.html list rows, .li: 56 px, 12 x 16,
  // the card hover; sm strong over xs muted).
  [
    'tag row height',
    OPS,
    '',
    S(`${VIEW('tags')} ul[aria-label='Tags'] > li`),
    'min-height',
    '56px',
  ],
  [
    'tag row padding',
    OPS,
    '',
    S(`${VIEW('tags')} ul[aria-label='Tags'] > li`),
    'padding',
    '12px 16px',
  ],
  [
    'tag row hover',
    OPS,
    '',
    S(`${VIEW('tags')} ul[aria-label='Tags'] > li:hover`),
    'background-color',
    'var(--lg-card-hover)',
  ],
  [
    'tag name weight',
    OPS,
    '',
    S(`${VIEW('tags')} ul[aria-label='Tags'] > li > button`),
    'font-weight',
    '600',
  ],
  [
    'tag name hover keeps the accent',
    OPS,
    '',
    S(`${VIEW('tags')} ul[aria-label='Tags'] > li > button:hover`),
    'color',
    'var(--lg-accent-text)',
  ],
  [
    'tag count (xs muted)',
    OPS,
    '',
    S(`${VIEW('tags')} ul[aria-label='Tags'] > li > span:not([aria-hidden])`),
    'color',
    'var(--lg-ink-3)',
  ],
  // The exceptions list (Routes-Gallery-1.dc.html panel: mono xs strong, sm
  // strong, xs ink 2).
  [
    'exception title (sm strong)',
    OPS,
    '',
    S(`${VIEW('exceptions')} li a[href^='/dashboard/exceptions/'] > div > p:first-child`),
    'font-weight',
    '600',
  ],
  [
    'exception reference (mono xs strong in ink)',
    OPS,
    '',
    S(
      `${VIEW('exceptions')} li a[href^='/dashboard/exceptions/'] > div > p:first-child > .font-mono`,
    ),
    'color',
    'var(--lg-ink)',
  ],
  [
    'exception detail (xs ink 2)',
    OPS,
    '',
    S(`${VIEW('exceptions')} li a[href^='/dashboard/exceptions/'] > div > p:nth-child(2)`),
    'color',
    'var(--lg-ink-2)',
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
  // A count's summary card (Cycle-Count-Detail.dc.html: .prog at 8 px, 16 px
  // under the figures, on the surface 4 track with the ok fill).
  [
    'count summary bar height',
    COUNTS,
    '',
    S(`${VIEW('cycle-count')} [data-glass='stat-strip'] [data-glass='count-progress']`),
    'height',
    '8px',
  ],
  [
    'count summary bar track',
    COUNTS,
    '',
    S(`${VIEW('cycle-count')} [data-glass='stat-strip'] [data-glass='count-progress']`),
    'background',
    'var(--lg-surface-4)',
  ],
  [
    'count summary bar fill',
    COUNTS,
    '',
    S(`${VIEW('cycle-count')} [data-glass='stat-strip'] [data-glass='count-progress'] > span`),
    'background',
    'var(--lg-ok-fill)',
  ],
  [
    'count summary bar 16 px under the figures (18 px card padding, 8 px bar)',
    COUNTS,
    '',
    S(
      `${VIEW('cycle-count')} [data-glass='stat-strip'] > div:has(> [data-glass='count-progress'])`,
    ),
    'padding-bottom',
    '42px',
  ],
  [
    "Classic's small bar under Counted hidden",
    COUNTS,
    '',
    S(
      `${VIEW('cycle-count')} [data-glass='stat-strip'] [data-slot='stat-strip-item'] > div:has(> [data-slot='count-progress'])`,
    ),
    'display',
    'none',
  ],
  // A count's head (Cycle-Count-Detail.dc.html .page-h: the status after
  // the copy button in the .row.g10 title row, the card head's badge hidden
  // while it is drawn; the subline and the start time as one .sm.ink2 meta
  // line) and its lines toolbar (.toolbar: 8 between, the search .ctrl.search
  // flex 1 1 280px up to 360, the note .xs.muted.ml-a, desk only).
  [
    'count title status after the copy button',
    COUNTS,
    '',
    S(`${VIEW('cycle-count')} [data-glass='page-header'] [data-glass='count-title-status']`),
    'order',
    '1',
  ],
  [
    'card head status hidden while the title shows it',
    COUNTS,
    '',
    S(
      `${VIEW('cycle-count')}:has([data-glass='count-title-status']) .bg-card.rounded-lg.border > .min-h-\\[49px\\] [data-glass-role='status']`,
    ),
    'display',
    'none',
  ],
  [
    'count meta line 4 px under the title row',
    COUNTS,
    '',
    S(`${VIEW('cycle-count')} [data-glass='page-header'] div:has(> h1)`),
    'margin-bottom',
    '4px',
  ],
  [
    'count start time on the meta line',
    COUNTS,
    '',
    S(`${VIEW('cycle-count')} [data-glass='page-header'] div:has(> h1) ~ p`),
    'display',
    'inline',
  ],
  [
    'count lines toolbar from the start',
    COUNTS,
    '',
    S(`${VIEW('cycle-count')} .bg-card.rounded-lg.border > .min-h-\\[49px\\] + div`),
    'justify-content',
    'flex-start',
  ],
  [
    'count lines toolbar gap',
    COUNTS,
    '',
    S(`${VIEW('cycle-count')} .bg-card.rounded-lg.border > .min-h-\\[49px\\] + div`),
    'gap',
    '8px',
  ],
  [
    'count lines search',
    COUNTS,
    '',
    S(
      `${VIEW('cycle-count')} .bg-card.rounded-lg.border > .min-h-\\[49px\\] + div > div:first-child`,
    ),
    'max-width',
    '360px',
  ],
  [
    'count lines note at the end',
    COUNTS,
    '',
    S(
      `${VIEW('cycle-count')} .bg-card.rounded-lg.border > .min-h-\\[49px\\] + div > [data-glass='count-lines-note']`,
    ),
    'margin-left',
    'auto',
  ],
  [
    'count lines note size',
    COUNTS,
    '',
    S(
      `${VIEW('cycle-count')} .bg-card.rounded-lg.border > .min-h-\\[49px\\] + div > [data-glass='count-lines-note']`,
    ),
    'font-size',
    '12px',
  ],
  [
    'count lines note not on a phone',
    COUNTS,
    PHONE,
    S(
      `${VIEW('cycle-count')} .bg-card.rounded-lg.border > .min-h-\\[49px\\] + div > [data-glass='count-lines-note']`,
    ),
    'display',
    'none',
  ],
  [
    'net variance below nothing (t-danger)',
    COUNTS,
    '',
    S(
      `${VIEW('cycle-count')} [data-glass='stat-strip'] [data-testid='count-stat-net-variance'][data-glass-tone='down'] > div:nth-child(2)`,
    ),
    'color',
    'var(--lg-danger)',
  ],
  [
    'net variance above nothing (t-ok)',
    COUNTS,
    '',
    S(
      `${VIEW('cycle-count')} [data-glass='stat-strip'] [data-testid='count-stat-net-variance'][data-glass-tone='up'] > div:nth-child(2)`,
    ),
    'color',
    'var(--lg-ok)',
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
  // A purchase order's receiving summary (section.card.p20.col.g12; .prog
  // 10 px) and the board's line columns (84 / 84 / 96 / 150).
  [
    'summary card padding',
    PO,
    '',
    S(`${VIEW('purchase-order')} [data-glass='po-progress']`),
    'padding',
    '20px',
  ],
  [
    'summary card gap',
    PO,
    '',
    S(`${VIEW('purchase-order')} [data-glass='po-progress']`),
    'gap',
    '12px',
  ],
  [
    'summary drawn first',
    PO,
    '',
    S(`${VIEW('purchase-order')} [data-glass='po-progress']`),
    'order',
    '-1',
  ],
  [
    'summary figures gap',
    PO,
    '',
    S(`${VIEW('purchase-order')} [data-glass='po-progress-figures']`),
    'gap',
    '16px',
  ],
  [
    'summary figure size',
    PO,
    '',
    S(
      `${VIEW('purchase-order')} [data-glass='po-progress-stat'] > span:nth-child(2):not([data-glass='po-progress-day'])`,
    ),
    'font-size',
    '28px',
  ],
  [
    'summary expected day size (.lg.strong)',
    PO,
    '',
    S(`${VIEW('purchase-order')} [data-glass='po-progress-stat'] > [data-glass='po-progress-day']`),
    'font-size',
    '16px',
  ],
  [
    'summary bar height',
    PO,
    '',
    S(`${VIEW('purchase-order')} [data-glass='po-progress-bar']`),
    'height',
    '10px',
  ],
  [
    'ordered column',
    PO,
    '',
    S(
      `${VIEW('purchase-order')} [data-glass='table'] th:is([data-glass='po-line-ordered'], [data-glass='po-line-received'])`,
    ),
    'width',
    '84px',
  ],
  [
    'outstanding column',
    PO,
    '',
    S(`${VIEW('purchase-order')} [data-glass='table'] th[data-glass='po-line-outstanding']`),
    'width',
    '96px',
  ],
  [
    'status column',
    PO,
    '',
    S(`${VIEW('purchase-order')} [data-glass='table'] th[data-glass='po-line-status']`),
    'min-width',
    '150px',
  ],
  [
    'receive dialog width',
    PO,
    '',
    `${ROOT}:has( ${VIEW('purchase-order')} ) [data-glass='dialog']:has(> .max-h-\\[55vh\\])`,
    'max-width',
    '680px',
  ],
  // A return's progress rail (Return-Detail.dc.html .steps.card: 12 x 16,
  // radius 16; .step 13 px with its 20 px mark; .step-sep up to 120 px).
  [
    'rail padding',
    RETURNS,
    '',
    S(`${VIEW('return')} [data-glass='return-rail']`),
    'padding',
    '12px 16px',
  ],
  [
    'rail radius',
    RETURNS,
    '',
    S(`${VIEW('return')} [data-glass='return-rail']`),
    'border-radius',
    '16px',
  ],
  ['rail gap', RETURNS, '', S(`${VIEW('return')} [data-glass='return-rail']`), 'gap', '6px'],
  [
    'step size',
    RETURNS,
    '',
    S(`${VIEW('return')} [data-glass='return-rail'] > li[data-state]`),
    'font-size',
    '13px',
  ],
  [
    'step mark',
    RETURNS,
    '',
    S(`${VIEW('return')} [data-glass='return-rail'] [data-glass='return-step-mark']`),
    'width',
    '20px',
  ],
  [
    'step line',
    RETURNS,
    '',
    S(`${VIEW('return')} [data-glass='return-rail'] > [data-glass='return-step-sep']`),
    'max-width',
    '120px',
  ],
  [
    'rail across the page above the side column',
    RETURNS,
    WIDE,
    S(`${VIEW('return')} > .max-w-\\[1040px\\] > .flex-col > [data-glass='return-rail']`),
    'margin-right',
    '0',
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
