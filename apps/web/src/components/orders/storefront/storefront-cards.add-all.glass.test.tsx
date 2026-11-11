import { readFileSync } from 'node:fs';
import path from 'node:path';

import { cleanup, render } from '@testing-library/react';
import type { AtRule } from 'postcss';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cssRules, declaredFor, parse, splitSelectors } from '@/styles/liquid-glass/glass-css';

import type { CatalogItem } from '../v2/types';

import { SfAddControl } from './storefront-cards';

/**
 * "Add all" under Liquid Glass (added when main's Add all was merged into the
 * branch, 2026-11-10). The button carries Classic's two classes, `sf-add
 * sf-add-all`, so storefront.glass.css draws it as the tinted Add with no rule
 * of its own. Two things that rule does not give it are pinned here:
 *
 *  - With everything available already in the cart the button is
 *    `aria-disabled`, not `disabled` (it keeps keyboard focus), so the glass
 *    `.sf-add[disabled]` rule does not reach it and it stayed tinted, as if it
 *    still offered something. It takes the same dimmed look, and the rule sits
 *    after the hover rule, with the same weight, so the pointer does not tint
 *    it again.
 *  - The count beside the button shows whole. Classic's own stylesheet drops
 *    the stepper's IN CART label beside "Add all" (a list row and a grid card
 *    at every width, the quick view at 639.98 px and under), so glass has no
 *    rule for the label any more. What glass still has to do is on a grid
 *    card at 639.98 px and under: Classic's 128 px base leaves the count
 *    38 px between the 44 px buttons, and the 14 px glass figure needs 45 px
 *    for 10000, which drew as "1000" (measured in Chromium, 2026-11-11). The
 *    control keeps 136 px there.
 *
 * Classic is not touched: every rule here starts at the glass root, inside
 * @media screen (glass-scope.guard.test.ts). Synthetic data only.
 */

const ROOT = ":root[data-appearance='liquid-glass'] .sp-storefront:not(.sf-public)";
// One space between a selector's parts, however the stylesheet wraps a long one.
const rules = cssRules('storefront.glass.css').map((r) => ({
  ...r,
  selectors: r.selectors.map((s) => s.replace(/\s+/g, ' ')),
}));
const declared = (el: Element, prop: string) => declaredFor(el, rules, prop);
const PHONE = (media: string[]) => media.length === 1 && media[0] === '(max-width: 639.98px)';

/** Classic's stylesheet: every selector that hides something, with the @media around it ('' at the top). */
const CLASSIC_HIDES: { selector: string; media: string }[] = [];
parse(readFileSync(path.resolve(__dirname, 'storefront.css'), 'utf8'), 'storefront.css').walkRules(
  (rule) => {
    if (!rule.nodes.some((n) => n.type === 'decl' && n.prop === 'display' && n.value === 'none')) {
      return;
    }
    const at = rule.parent?.type === 'atrule' ? (rule.parent as AtRule) : undefined;
    const media = at?.name === 'media' ? at.params : '';
    for (const selector of splitSelectors(rule.selector)) {
      CLASSIC_HIDES.push({ selector: selector.replace(/\s+/g, ' '), media });
    }
  },
);

function item(available: number): CatalogItem {
  return {
    id: 'a',
    sku: 'SKU-A',
    name: 'Graph Paper Pad',
    warehouseId: 'wh-1',
    quantityOnHand: available,
    reservedQuantity: 0,
    itemType: null,
    categoryId: 'c1',
    categoryName: 'Paper',
    charterId: null,
    charterName: null,
    charterCode: null,
    rackLabel: null,
    imageUrl: null,
    lqip: null,
    price: null,
    reorderPoint: 0,
  };
}

/** The control as a grid card draws it, inside a list row, or in the quick view's foot. */
function draw(available: number, qty: number, where: 'card' | 'row' | 'quick view' = 'card') {
  const noop = () => {};
  const control = (
    <SfAddControl item={item(available)} qty={qty} onAdd={noop} onDec={noop} onSetQty={noop} />
  );
  return render(
    <div className="sp-storefront">
      {where === 'row' ? (
        <div className="sf-row">{control}</div>
      ) : where === 'quick view' ? (
        <div className="sf-drawer-foot">{control}</div>
      ) : (
        <div className="sf-card">
          <div className="sf-card-ctl">{control}</div>
        </div>
      )}
    </div>,
  ).container;
}

beforeEach(() => {
  document.documentElement.setAttribute('data-appearance', 'liquid-glass');
});
afterEach(() => {
  document.documentElement.removeAttribute('data-appearance');
  cleanup();
});

describe('Add all under Liquid Glass', () => {
  it('offers as the tinted Add, with no rule of its own', () => {
    const root = draw(67, 5);
    const all = root.querySelector('.sf-add-all')!;
    expect(all.className).toBe('sf-add sf-add-all');
    expect(all.getAttribute('aria-disabled')).toBeNull();
    expect(declared(all, 'background')).toBe('var(--lg-accent-wash)');
    expect(declared(all, 'color')).toBe('var(--lg-accent-text)');
    expect(declared(all, 'border-color')).toBe('transparent');
    expect(declared(all, 'height')).toBe('34px');
  });

  it('is dimmed like a disabled Add once everything available is in the cart', () => {
    const root = draw(67, 67);
    const all = root.querySelector('.sf-add-all')!;
    expect(all.getAttribute('aria-disabled')).toBe('true');
    // Still a live element: aria-disabled, never the disabled attribute.
    expect(all.hasAttribute('disabled')).toBe(false);
    expect(declared(all, 'background')).toBe('var(--lg-surface-2)');
    expect(declared(all, 'color')).toBe('var(--lg-ink-4)');
    expect(declared(all, 'border-color')).toBe('var(--lg-line-2)');
    // The look of the disabled Add (Out of stock), value for value.
    const disabled = rules.find((r) => r.selectors.includes(`${ROOT} .sf-add[disabled]`))!;
    const dimmed = rules.find((r) =>
      r.selectors.includes(`${ROOT} .sf-add-all[aria-disabled='true']`),
    )!;
    expect(dimmed.decls).toEqual(disabled.decls);
  });

  it('stays dimmed under the pointer: its rule follows the hover rule and weighs the same', () => {
    const at = (selector: string) => rules.findIndex((r) => r.selectors.includes(selector));
    const hover = at(`${ROOT} .sf-add:hover`);
    const dimmed = at(`${ROOT} .sf-add-all[aria-disabled='true']`);
    expect(hover).toBeGreaterThan(-1);
    expect(dimmed).toBeGreaterThan(hover);
    // One class-weight part each after `.sf-add` / `.sf-add-all`: a pseudo
    // class on one side, an attribute on the other, so source order decides.
    expect(rules[dimmed]!.selectors).toEqual([`${ROOT} .sf-add-all[aria-disabled='true']`]);
    expect(rules[dimmed]!.media).toEqual([]);
    expect(rules[hover]!.media).toEqual([]);
  });

  it('leaves the IN CART label to Classic, which drops it beside the button: no glass rule names it', () => {
    expect(rules.filter((r) => r.selectors.some((s) => s.includes('.in-lbl')))).toEqual([]);
    // Classic's rules reach the label under glass too (same DOM, same classes).
    const classicHides = (el: Element, media: string) =>
      CLASSIC_HIDES.some((h) => (h.media === '' || h.media === media) && el.matches(h.selector));
    const phone = '(max-width: 639.98px)';
    for (const where of ['row', 'card'] as const) {
      const label = draw(67, 5, where).querySelector('.sf-ctl > .sf-step .in-lbl')!;
      expect(classicHides(label, ''), where).toBe(true);
      cleanup();
    }
    const quick = draw(67, 5, 'quick view').querySelector('.sf-ctl > .sf-step .in-lbl')!;
    expect(classicHides(quick, '')).toBe(false);
    expect(classicHides(quick, phone)).toBe(true);
  });

  it('keeps 136 px for a grid card’s control beside the button at 639.98 px and under', () => {
    // 136 - 2 x 44 (the buttons) - 2 (the border) = 46 px for the count; 10000
    // is 44.95 px wide in the glass figure (600 14 px, tabular figures).
    const columns = (el: Element) => declared(el, 'grid-template-columns');
    const card = draw(10000, 10000, 'card');
    const step = card.querySelector('.sf-ctl > .sf-step')!;
    expect(declaredFor(step, rules, 'grid-template-columns', PHONE)).toBe('44px 1fr 44px');
    expect(declaredFor(step, rules, 'min-width', PHONE)).toBe('136px');
    expect(136 - 2 * 44 - 2).toBeGreaterThanOrEqual(44.95);
    // Above 639.98 px the buttons are 34 px and Classic's 128 px base is enough.
    expect(columns(step)).toBe('34px 1fr 34px');
    expect(declared(step, 'min-width')).toBeUndefined();
    // "Add all" itself keeps its own width.
    const all = card.querySelector('.sf-add-all')!;
    expect(declaredFor(all, rules, 'min-width', PHONE)).toBeUndefined();
    cleanup();
    // Add to cart takes the same width, so the button does not jump when one
    // turns into the other.
    const add = draw(67, 0, 'card').querySelector('.sf-ctl > .sf-add:not(.sf-add-all)')!;
    expect(declaredFor(add, rules, 'min-width', PHONE)).toBe('136px');
    cleanup();
    // A list row (a column there, where a width would be a height) and the
    // quick view (51 px or more for the count as it is) are left alone.
    for (const where of ['row', 'quick view'] as const) {
      const other = draw(10000, 10000, where).querySelector('.sf-ctl > .sf-step')!;
      expect(declaredFor(other, rules, 'min-width', PHONE), where).toBeUndefined();
      cleanup();
    }
    // A card's control with no "Add all" (1 available) is not in .sf-ctl.
    const alone = draw(1, 1, 'card').querySelector('.sf-step')!;
    expect(alone.closest('.sf-ctl')).toBeNull();
    expect(declaredFor(alone, rules, 'min-width', PHONE)).toBeUndefined();
  });

  it('leaves an item with fewer than 2 available as it was: no wrapper, no button, the label kept', () => {
    const row = draw(1, 1, 'row');
    expect(row.querySelector('.sf-ctl')).toBeNull();
    expect(row.querySelector('.sf-add-all')).toBeNull();
    expect(declared(row.querySelector('.in-lbl')!, 'display')).toBeUndefined();
  });
});
