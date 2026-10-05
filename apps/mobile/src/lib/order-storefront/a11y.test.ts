import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import ts from 'typescript';

import {
  ORDER_ADD_WHILE_LOCKED_COPY,
  STOREFRONT_CART_LOCKED_COPY,
  STOREFRONT_LINE_NOT_ORDERABLE_COPY,
  initialCartState,
  type KitOffer,
  type StorefrontItem,
} from '@stockpilot/core';

import * as a11y from './a11y';
import {
  addBlockedHint,
  addItemLabel,
  addKitLabel,
  changeLockedHint,
  lineChangeAnnouncement,
  addedAnnouncement,
  cartBarLabel,
  decreaseKitLabel,
  decreaseLabel,
  increaseBlockedHint,
  increaseLabel,
  itemRowLabel,
  kitAnnouncement,
  kitRowLabel,
  quantityAnnouncement,
  quantityButtonLabel,
  submittedAnnouncement,
} from './a11y';

const PLANNER: StorefrontItem = {
  id: 'a',
  sku: 'PL-1',
  name: 'Planner',
  quantityOnHand: 140,
  reservedQuantity: 6,
  categoryId: null,
  categoryName: null,
  charterId: null,
  charterName: null,
  charterCode: null,
  rackLabel: null,
  reorderPoint: 0,
};

describe('what VoiceOver says', () => {
  it('a row is ONE element: name, SKU, availability in the long form, earmark, quantity in the cart', () => {
    expect(itemRowLabel(PLANNER, 0, null)).toBe('Planner, SKU PL-1, 134 available');
    expect(itemRowLabel(PLANNER, 2, 'NC')).toBe('Planner, SKU PL-1, 134 available, earmarked for NC, 2 in your cart');
    expect(itemRowLabel({ ...PLANNER, quantityOnHand: 6 }, 0, null)).toBe('Planner, SKU PL-1, Out of stock');
    expect(itemRowLabel({ ...PLANNER, reorderPoint: 200 }, 0, null)).toBe('Planner, SKU PL-1, Low · 134 left');
  });

  it('every stepper button names its item', () => {
    expect(addItemLabel('Planner')).toBe('Add Planner to your cart');
    expect(increaseLabel('Planner')).toBe('One more Planner');
    expect(decreaseLabel('Planner', 3)).toBe('One fewer Planner');
    expect(decreaseLabel('Planner', 1)).toBe('Remove Planner from your cart');
    expect(quantityButtonLabel('Planner', 3)).toBe('Planner: 3 in your cart. Change the quantity');
    expect(increaseBlockedHint(true)).toBe('All available stock is in your cart');
    expect(increaseBlockedHint(false)).toBeUndefined();
  });

  it('kits', () => {
    const kit: KitOffer = { bundleId: 'k', name: 'Starter', sku: null, components: [{ anchorItemId: 'a', itemIds: ['a'], perKit: 2 }] };
    expect(kitRowLabel(kit, new Map([['a', PLANNER]]), 0)).toBe('Starter, 67 kits available');
    expect(kitRowLabel(kit, new Map([['a', PLANNER]]), 1)).toBe('Starter, 67 kits available, 1 in your cart');
    expect(decreaseKitLabel('Starter', 1)).toBe('Take the Starter kit out of your cart');
    expect(decreaseKitLabel('Starter', 2)).toBe('One fewer Starter kit');
  });

  it('the cart bar', () => {
    expect(cartBarLabel(3, 12)).toBe('Cart, 3 items · 12 units. Check out');
  });

  it('announcements', () => {
    expect(addedAnnouncement('Planner', 1)).toBe('Added Planner. 1 in your cart.');
    expect(quantityAnnouncement('Planner', 4)).toBe('Planner: 4 in your cart.');
    expect(quantityAnnouncement('Planner', 0)).toBe('Removed Planner from your cart.');
    expect(kitAnnouncement('Starter', 2)).toBe('Starter: 2 kits in your cart.');
    expect(kitAnnouncement('Starter', 0)).toBe('Took the Starter kit out of your cart.');
    expect(submittedAnnouncement({ orderNumber: 123, orderLabel: 'SO-000123' })).toBe('Order request submitted: SO-000123.');
    expect(submittedAnnouncement({ orderNumber: 7, orderLabel: null })).toBe('Order request submitted: SO-000007.');
  });
});

describe('a dimmed control says why (desk check F7.1)', () => {
  it('Add and Add kit: the lock first (core’s add-while-locked words), then a line that can’t be ordered', () => {
    expect(addBlockedHint({ locked: true, notOrderable: false })).toBe(ORDER_ADD_WHILE_LOCKED_COPY);
    expect(addBlockedHint({ locked: true, notOrderable: true })).toBe(ORDER_ADD_WHILE_LOCKED_COPY);
    expect(addBlockedHint({ locked: false, notOrderable: true })).toBe(STOREFRONT_LINE_NOT_ORDERABLE_COPY);
    expect(addBlockedHint({ locked: false, notOrderable: false })).toBeUndefined();
  });
  it('the steppers, Remove and Clear all: the lock’s words while locked, nothing otherwise', () => {
    expect(changeLockedHint(true)).toBe(STOREFRONT_CART_LOCKED_COPY);
    expect(changeLockedHint(false)).toBeUndefined();
  });
});

describe('the row says what the eye sees (desk check F7.2)', () => {
  it('the Frequently ordered rank and the can’t-be-ordered mark are in the one label', () => {
    expect(itemRowLabel(PLANNER, 0, null, { rank: { place: 1, orders: 12 } })).toBe(
      'Planner, SKU PL-1, 134 available, Frequently ordered #1 · in 12 orders',
    );
    expect(itemRowLabel(PLANNER, 0, null, { notOrderable: true })).toBe(
      `Planner, SKU PL-1, 134 available, ${STOREFRONT_LINE_NOT_ORDERABLE_COPY}`,
    );
    expect(itemRowLabel(PLANNER, 2, 'NC', { rank: { place: 2, orders: 1 }, notOrderable: true })).toBe(
      `Planner, SKU PL-1, 134 available, Frequently ordered #2 · in 1 order, earmarked for NC, 2 in your cart, ${STOREFRONT_LINE_NOT_ORDERABLE_COPY}`,
    );
  });
});

describe('a change in the cart is announced from what it is now (desk check F7.4)', () => {
  const itemMap = new Map([[PLANNER.id, PLANNER]]);
  const cart = (quantity: number) => ({
    ...initialCartState({ warehouseId: 'w', fulfillmentType: 'pickup' as const }),
    lines: quantity > 0 ? [{ itemId: PLANNER.id, quantity }] : [],
  });
  it('the quantity after the change, or removed', () => {
    expect(lineChangeAnnouncement({ itemMap, cart: cart(3) }, PLANNER.id)).toBe('Planner: 3 in your cart.');
    expect(lineChangeAnnouncement({ itemMap, cart: cart(0) }, PLANNER.id)).toBe('Removed Planner from your cart.');
  });
  it('an item the catalog shown does not name: never a uuid', () => {
    expect(lineChangeAnnouncement({ itemMap: new Map(), cart: cart(0) }, 'f3a1c2d4-0000-4000-8000-000000000000')).toBe(
      'Removed this item from your cart.',
    );
    expect(lineChangeAnnouncement({ itemMap: new Map(), cart: { ...cart(0), lines: [{ itemId: 'x', quantity: 2 }] } }, 'x')).toBeNull();
    expect(lineChangeAnnouncement({ itemMap, cart: null }, PLANNER.id)).toBeNull();
  });
});

/**
 * THE WORDS GUARD, EXTENDED TO THE PHONE’S OWN SENTENCES (desk check F7.6).
 * Core’s phone-copy.test.ts walks core’s words; VoiceOver’s labels and
 * announcements are joined here (a11y.ts), and a few literals sit in the
 * storefront’s screens. The same rules apply to every one of them.
 */
describe('the words rules, on what VoiceOver hears and on the storefront’s literals (desk check F7.6)', () => {
  const ROOT = path.resolve(__dirname, '../../..');
  const rules = (s: string, where: string) => {
    expect(s, where).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
    expect(s, where).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
    expect(s, where).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(s, where).not.toMatch(/\bbook\b/i);
    expect(s, where).not.toMatch(/email (was )?sent|sent the email/i);
    expect(s, where).not.toMatch(/try again/i);
  };

  it('every label, hint and announcement a11y.ts makes', () => {
    const kit: KitOffer = { bundleId: 'k', name: 'Starter', sku: null, components: [{ anchorItemId: 'a', itemIds: ['a'], perKit: 2 }] };
    const said: string[] = [
      a11y.ITEM_ROW_HINT,
      itemRowLabel(PLANNER, 2, 'NC', { rank: { place: 1, orders: 3 }, notOrderable: true }),
      addItemLabel('Planner'),
      increaseLabel('Planner'),
      decreaseLabel('Planner', 1),
      decreaseLabel('Planner', 2),
      quantityButtonLabel('Planner', 2),
      increaseBlockedHint(true)!,
      kitRowLabel(kit, new Map([['a', PLANNER]]), 1),
      addKitLabel('Starter'),
      a11y.increaseKitLabel('Starter'),
      decreaseKitLabel('Starter', 1),
      decreaseKitLabel('Starter', 2),
      cartBarLabel(3, 12),
      addedAnnouncement('Planner', 1),
      quantityAnnouncement('Planner', 0),
      quantityAnnouncement('Planner', 2),
      kitAnnouncement('Starter', 0),
      kitAnnouncement('Starter', 2),
      submittedAnnouncement({ orderNumber: 1, orderLabel: null }),
      addBlockedHint({ locked: true, notOrderable: false })!,
      addBlockedHint({ locked: false, notOrderable: true })!,
      changeLockedHint(true)!,
      a11y.kitAddBlockedHint({ locked: false, out: false, full: true })!,
      addKitLabel('QA New Hire Kit'),
      lineChangeAnnouncement({ itemMap: new Map(), cart: { ...initialCartState({ warehouseId: 'w', fulfillmentType: 'pickup' }), lines: [] } }, 'gone')!,
    ];
    // Every export is walked: a new one must be added above.
    const exported = Object.keys(a11y).sort();
    expect(exported).toEqual(
      [
        'ITEM_ROW_HINT', 'addBlockedHint', 'addItemLabel', 'addKitLabel', 'addedAnnouncement', 'cartBarLabel',
        'changeLockedHint', 'decreaseKitLabel', 'decreaseLabel', 'increaseBlockedHint', 'increaseKitLabel', 'kitAddBlockedHint',
        'increaseLabel', 'itemRowLabel', 'kitAnnouncement', 'kitRowLabel', 'lineChangeAnnouncement',
        'quantityAnnouncement', 'quantityButtonLabel', 'submittedAnnouncement',
      ].sort(),
    );
    for (const s of said) rules(s, s);
  });

  it('every string literal in the storefront’s screens and components', () => {
    const files = [
      'app/order/new/index.tsx',
      'app/order/new/browse.tsx',
      'app/order/new/checkout.tsx',
      'app/order/new/placed.tsx',
      ...['cart-panel', 'catalog-screen', 'controls', 'item-row', 'kit-row', 'sheets', 'storefront-sheet', 'storefront-state', 'unconfirmed-panel'].map(
        (n) => `src/components/order-storefront/${n}.tsx`,
      ),
    ];
    let walked = 0;
    for (const rel of files) {
      const file = path.join(ROOT, rel);
      const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const visit = (n: ts.Node): void => {
        if (ts.isImportDeclaration(n)) return;
        if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isJsxText(n)) {
          const text = n.getText(sf);
          // Words a person reads: a capital letter and a space (style keys,
          // routes and ids are neither).
          if (/[A-Z]/.test(text) && /\s/.test(text.trim())) {
            walked += 1;
            rules(text, `${rel}: ${text}`);
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    expect(walked).toBeGreaterThan(0);
  });
});

// iPhone simulator walk, 2026-10-05: with the kit's limiting item already in
// the cart, Add kit was dimmed with nothing said, while its row still read
// "1 kit available"; and a kit named "... Kit" was read "... Kit kit".
describe('a dimmed Add kit says why, and a kit is never read "Kit kit" (simulator walk D2)', () => {
  it('locked: the lock’s words; the cart’s own lines leave no kit: all available stock is in the cart (the web’s title); out of stock or free: nothing', () => {
    expect(a11y.kitAddBlockedHint({ locked: true, out: false, full: true })).toBe(addBlockedHint({ locked: true, notOrderable: false }));
    expect(a11y.kitAddBlockedHint({ locked: false, out: false, full: true })).toBe(increaseBlockedHint(true));
    expect(a11y.kitAddBlockedHint({ locked: false, out: true, full: true })).toBeUndefined();
    expect(a11y.kitAddBlockedHint({ locked: false, out: false, full: false })).toBeUndefined();
  });
  it('a kit whose name already ends in "kit" is not given a second one', () => {
    expect(addKitLabel('QA New Hire Kit')).toBe('Add one QA New Hire Kit to your cart');
    expect(a11y.increaseKitLabel('QA New Hire Kit')).toBe('One more QA New Hire Kit');
    expect(decreaseKitLabel('QA New Hire Kit', 1)).toBe('Take the QA New Hire Kit out of your cart');
    expect(decreaseKitLabel('Science kit', 2)).toBe('One fewer Science kit');
    expect(kitAnnouncement('QA New Hire Kit', 0)).toBe('Took the QA New Hire Kit out of your cart.');
    expect(addKitLabel('Starter')).toBe('Add one Starter kit to your cart');
    expect(addKitLabel('Toolkit')).toBe('Add one Toolkit kit to your cart');
  });
});
