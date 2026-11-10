import { cleanup, render } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cssRules, declaredFor } from '@/styles/liquid-glass/glass-css';

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
 *  - In a list row the stepper sits beside the button in a 210 px cell. Glass
 *    draws 34 px stepper buttons and a 14 px figure, which left about 13 px
 *    for the count beside the IN CART label, less than two digits need. The
 *    label is dropped there, as Classic already drops it at 639.98 px and
 *    under for the same reason.
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

/** The control as a card draws it, or inside a list row. */
function draw(available: number, qty: number, where: 'card' | 'row' = 'card') {
  const noop = () => {};
  const control = (
    <SfAddControl item={item(available)} qty={qty} onAdd={noop} onDec={noop} onSetQty={noop} />
  );
  return render(
    <div className="sp-storefront">
      {where === 'row' ? (
        <div className="sf-row">{control}</div>
      ) : (
        <div className="sf-card-ctl">{control}</div>
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

  it('drops the IN CART label of a list row’s stepper beside the button, and keeps it on a card', () => {
    const row = draw(67, 5, 'row');
    expect(row.querySelector('.sf-row .sf-ctl > .sf-step')).not.toBeNull();
    expect(declared(row.querySelector('.in-lbl')!, 'display')).toBe('none');
    cleanup();
    const card = draw(67, 5, 'card');
    expect(card.querySelector('.sf-ctl > .sf-step')).not.toBeNull();
    expect(declared(card.querySelector('.in-lbl')!, 'display')).toBeUndefined();
  });

  it('leaves an item with fewer than 2 available as it was: no wrapper, no button, the label kept', () => {
    const row = draw(1, 1, 'row');
    expect(row.querySelector('.sf-ctl')).toBeNull();
    expect(row.querySelector('.sf-add-all')).toBeNull();
    expect(declared(row.querySelector('.in-lbl')!, 'display')).toBeUndefined();
  });
});
