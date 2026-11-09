// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import postcss, { type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

import { enclosing, GLASS_DIR, normaliseQuotes, splitSelectors } from './glass-css';

/**
 * THE ITEM AND BOOK PAGE'S COMPOSITION (fidelity lane "detail";
 * Item-Detail.dc.html, Book-Detail.dc.html and the artifact's sp.css), read
 * from pages/item-detail.css. The geometry itself is measured on the lab
 * (stage 5, plan 8.1, tests/e2e/appearance/item-detail-composition.spec.ts);
 * this keeps the board's values and the page's two safety rules from drifting
 * in CI, where no browser runs:
 *
 *   - no Classic control is hidden for good: the only `display: none` rules
 *     are the head photo (the summary draws it), the actions held back while
 *     More actions is closed (and only when one of the kept three is there),
 *     and More itself when there is nothing to hold back;
 *   - the glass-only parts lose their material in forced colours.
 */

const ROOT = ":root[data-appearance='liquid-glass']";
const PAGE = `${ROOT} [data-glass-page='item-detail']`;

interface Decl {
  media: string;
  selector: string;
  prop: string;
  value: string;
}

function declarations(): Decl[] {
  const out: Decl[] = [];
  const text = readFileSync(join(GLASS_DIR, 'pages', 'item-detail.css'), 'utf8');
  postcss.parse(text).walkRules((rule: Rule) => {
    const media = enclosing(rule)
      .filter((a) => a.startsWith('@media ') && a !== '@media screen')
      .map((a) => a.slice('@media '.length).replace(/\s+/gu, ' ').trim())
      .reverse()
      .join(' / ');
    for (const raw of splitSelectors(rule.selector)) {
      const selector = normaliseQuotes(raw.replace(/\s+/gu, ' ').trim());
      for (const node of rule.nodes) {
        if (node.type === 'decl') out.push({ media, selector, prop: node.prop, value: node.value });
      }
    }
  });
  return out;
}

const DECLS = declarations();

/** The value of `prop` for `selector` (written after the page root) under `media` ("" for none). */
function value(selector: string, prop: string, media = ''): string | undefined {
  const full = `${PAGE} ${selector}`.replace(/\s+/gu, ' ').trim();
  const hits = DECLS.filter((d) => d.selector === full && d.prop === prop && d.media === media);
  return hits[hits.length - 1]?.value.replace(/\s+/gu, ' ');
}

describe('the page head (.page-h, .acts)', () => {
  const HEAD = '[data-item-detail-header]';
  it('one grid: back link, then the title with the actions and More on its foot, then the tabs', () => {
    expect(value(HEAD, 'display')).toBe('grid');
    expect(value(HEAD, 'grid-template-columns')).toBe('minmax(0, 1fr) auto auto');
    expect(value(HEAD, 'grid-template-areas')).toBe(
      "'back back back' 'title acts more' 'tabs tabs tabs'",
    );
    expect(value(HEAD, 'align-items')).toBe('end');
    // The title row's wrapper hands its two children to the grid.
    expect(value(`${HEAD} > div:has(> [data-glass='page-header'])`, 'display')).toBe('contents');
    expect(value(`${HEAD} [data-glass='page-header']`, 'grid-area')).toBe('title');
    expect(value(`${HEAD} [data-tour='item-actions']`, 'grid-area')).toBe('acts');
    expect(value(`${HEAD} [data-glass='item-more']`, 'grid-area')).toBe('more');
    expect(value(`${HEAD} > :first-child`, 'grid-area')).toBe('back');
    expect(value(`${HEAD} > :last-child`, 'grid-area')).toBe('tabs');
  });

  it('open: the actions take the row under the title, More at its end; phones stack them from the left', () => {
    expect(
      value(`${HEAD}:has([data-glass='item-more'] [aria-expanded='true'])`, 'grid-template-areas'),
    ).toBe("'back back back' 'title title title' 'acts acts more'");
    expect(value(HEAD, 'grid-template-areas', '(max-width: 760px)')).toBe(
      "'back back' 'title title' 'acts more'",
    );
    expect(value("[data-tour='item-actions'] > div", 'justify-content')).toBe('flex-end');
    expect(value("[data-tour='item-actions'] > div", 'justify-content', '(max-width: 760px)')).toBe(
      'flex-start',
    );
    expect(value("[data-tour='item-actions'] > div", 'flex-wrap')).toBe('wrap');
  });

  it('every action is the board’s secondary button: 36 px, 14 / 600, the field frost', () => {
    const btn = "[data-tour='item-actions'] > div > [data-glass='button']";
    expect(value(btn, 'height')).toBe('36px');
    expect(value(btn, 'font-size')).toBe('14px');
    expect(value(btn, 'font-weight')).toBe('600');
    expect(value(btn, 'background-color')).toBe('var(--lg-field-fill)');
    expect(value(btn, 'border-color')).toBe('var(--lg-field-line)');
    expect(value(btn, 'color')).toBe('var(--lg-ink)');
    expect(value("[data-glass='item-more'] > [data-glass='button']", 'width')).toBe('36px');
  });
});

describe('no Classic control is hidden for good', () => {
  it('the only display: none rules: the head photo, the held-back actions while More is closed, More with nothing to hold', () => {
    const hidden = DECLS.filter((d) => d.prop === 'display' && d.value === 'none').map(
      (d) => d.selector,
    );
    expect(hidden.sort()).toEqual(
      [
        `${PAGE} [data-glass='page-header'] div:has(> [data-slot='thumb'])`,
        `${PAGE} [data-item-detail-header]:has([data-glass='item-more'] [aria-expanded='false']) [data-tour='item-actions'] > div:has(> [data-glass-action]) > :not([data-glass-action])`,
        `${PAGE} [data-item-detail-header]:not(:has([data-tour='item-actions'] [data-glass-action])) [data-glass='item-more']`,
        // Stage 3: the classic middle dot on the meta line (aria-hidden).
        `${PAGE} [data-glass='page-header'] span.text-ink-4[aria-hidden='true']`,
      ].sort(),
    );
  });
});

describe('the Overview (.cols-side) and the summary card', () => {
  const PANEL = "> [role='tabpanel']:has(> [data-glass='item-summary'])";
  it('the summary over the panels, the side column (300 to 360 px) beside both; one column at 1100 px', () => {
    expect(value(PANEL, 'display')).toBe('grid');
    expect(value(PANEL, 'grid-template-columns')).toBe('minmax(0, 1fr) minmax(300px, 360px)');
    expect(value(PANEL, 'grid-template-areas')).toBe("'summary aside' 'main aside'");
    expect(value(PANEL, 'gap')).toBe('16px');
    expect(value(PANEL, 'grid-template-columns', '(max-width: 1100px)')).toBe('minmax(0, 1fr)');
    expect(value(PANEL, 'grid-template-areas', '(max-width: 1100px)')).toBe(
      "'summary' 'aside' 'main'",
    );
    expect(value(`${PANEL} > div:last-child`, 'grid-area')).toBe('main');
    expect(value(`${PANEL} > div:last-child`, 'flex-direction')).toBe('column');
  });

  it('.card.p20.g24 (book p24 g28), radius 20, on the card fill', () => {
    const S = "[data-glass='item-summary']";
    expect(value(S, 'padding')).toBe('20px');
    expect(value(S, 'gap')).toBe('24px');
    expect(value(S, 'border-radius')).toBe('var(--lg-r-lg)');
    expect(value(S, 'background-color')).toBe('var(--lg-card-fill)');
    expect(value(`${S}[data-glass-variant='book']`, 'padding')).toBe('24px');
    expect(value(`${S}[data-glass-variant='book']`, 'gap')).toBe('28px');
  });

  it('the photo is .thumb-2xl (160 px, radius 20); the cover is .cover at --thumb 228 (152 x 228)', () => {
    const P = "[data-glass='item-summary'] [data-glass-part='photo']";
    expect(value(P, 'width')).toBe('160px');
    expect(value(P, 'height')).toBe('160px');
    expect(value(P, 'border-radius')).toBe('20px');
    const C = "[data-glass='item-summary'][data-glass-variant='book'] [data-glass-part='photo']";
    expect(value(C, 'width')).toBe('152px');
    expect(value(C, 'height')).toBe('228px');
    expect(value(C, 'border-radius')).toBe('3px 5px 5px 3px');
  });

  it('the wells: auto-fit 120 px, 10 apart; the figure 28 / 34 at 650 above its 13 / 18 label', () => {
    const W = "[data-glass='item-summary'] [data-glass-part='wells']";
    expect(value(W, 'grid-template-columns')).toBe('repeat(auto-fit, minmax(120px, 1fr))');
    expect(value(W, 'gap')).toBe('10px');
    const well = "[data-glass='item-summary'] [data-glass-part='well']";
    expect(value(well, 'padding')).toBe('12px');
    expect(value(well, 'background-color')).toBe('var(--lg-card-fill-2)');
    expect(value(`${well} > dd`, 'order')).toBe('-1');
    expect(value(`${well} > dd`, 'font-size')).toBe('28px');
    expect(value(`${well} > dd`, 'line-height')).toBe('34px');
    expect(value(`${well} > dd`, 'font-weight')).toBe('650');
    expect(value(`${well} > dt`, 'font-size')).toBe('13px');
    expect(value(`${well} > dt`, 'color')).toBe('var(--lg-ink-3)');
    expect(value(`${well}[data-glass-tone='warn'] > dd`, 'color')).toBe('var(--lg-warn)');
    // A money figure takes two wells (the facts column always holds two).
    expect(value(`${well}[data-glass-span='2']`, 'grid-column')).toBe('span 2');
  });

  it('the side cards: .card.p16.g10, h4 titles (14 / 20, 600), .badge 22 px, .btn-sm 30 px', () => {
    const A = "[data-glass='item-aside-card']";
    expect(value(A, 'padding')).toBe('16px');
    expect(value(A, 'gap')).toBe('10px');
    expect(value(`${A} h2`, 'font-size')).toBe('14px');
    expect(value(`${A} h2`, 'line-height')).toBe('20px');
    expect(value(`${A} h2`, 'font-weight')).toBe('600');
    expect(value(`${A} [data-glass-part='badge']`, 'height')).toBe('22px');
    expect(value(`${A} [data-glass-part='badge'][data-glass-tone='accent']`, 'color')).toBe(
      'var(--lg-accent-text)',
    );
    expect(value(`${A} [data-glass-part='link-button']`, 'height')).toBe('30px');
  });

  it('forced colours: the glass-only cards, wells, alert, badge and link keep an edge on Canvas', () => {
    const forced = DECLS.filter(
      (d) => d.media === '(forced-colors: active)' && d.prop === 'border',
    ).map((d) => d.selector);
    expect(forced.join(' ')).toMatch(/item-summary/u);
    for (const part of ['item-aside-card', 'well', 'alert', 'link-button', 'badge']) {
      expect(forced.join(' '), part).toContain(part);
    }
  });
});
