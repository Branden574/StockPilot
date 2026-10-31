import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { ORDER_ITEM_HIDDEN_COPY, orderItemRefusalCopy } from '../place-order';

import { initialCartState, type CartState } from './cart';
import type { StorefrontItem } from './item';
import {
  STOREFRONT_LINE_DETAILS_PENDING_COPY,
  STOREFRONT_LINE_NOT_LISTED_COPY,
  STOREFRONT_REMOVE_THIS_ITEM_COPY,
} from './phone-copy';
import {
  cartLineNote,
  cartLineView,
  cartNotOrderableMarks,
  linesNotInCatalog,
  raisesNotOrderable,
  recheckRestoredCart,
  refusedItemIds,
  refusedItemReasons,
} from './stale-cart';

/**
 * STALE CARTS (ordering visibility, design 6.5): a line whose item left the
 * catalog (hidden from Orders, archived, out of scope) or that the server
 * refused stays in the cart, marked; it can be lowered or removed, never
 * raised; Submit is blocked until it is edited. The phone has done this since
 * PO-4; these helpers moved here from apps/mobile/src/lib/order-storefront/
 * checkout.ts (which re-exports them unchanged) so the web storefront applies
 * the same rule.
 */

const WH = '33333333-3333-4333-8333-333333333333';
const A = '44444444-4444-4444-8444-444444444444';
const B = '44444444-4444-4444-8444-444444444445';
const C = '44444444-4444-4444-8444-444444444446';
const BUNDLE = '77777777-7777-4777-8777-777777777777';

function item(id: string, name: string, onHand: number, reserved = 0): StorefrontItem {
  return {
    id,
    sku: `SKU-${name}`,
    name,
    quantityOnHand: onHand,
    reservedQuantity: reserved,
    categoryId: null,
    categoryName: null,
    charterId: null,
    charterName: null,
    charterCode: null,
    rackLabel: null,
    reorderPoint: 0,
  };
}

const base = (patch: Partial<CartState> = {}): CartState => ({
  ...initialCartState({ warehouseId: WH, fulfillmentType: 'pickup' }),
  lines: [{ itemId: A, quantity: 2 }],
  ...patch,
});

describe('which lines are marked', () => {
  it('a line whose item the fresh catalog no longer lists', () => {
    const cart = base({ lines: [{ itemId: A, quantity: 1 }, { itemId: B, quantity: 3 }] });
    expect([...linesNotInCatalog(cart, new Map([[A, item(A, 'Shirt S', 5)]]))]).toEqual([B]);
  });

  it('the refused items and their reasons come from a refusal’s details', () => {
    expect([...refusedItemIds({ items: { [A]: 'hidden_from_orders' } } as never)]).toEqual([A]);
    expect(refusedItemIds(null).size).toBe(0);
    expect(refusedItemReasons({ items: { [A]: 'hidden_from_orders', [B]: 'archived' } } as never)).toEqual(
      new Map([
        [A, 'hidden_from_orders'],
        [B, 'archived'],
      ]),
    );
    expect(refusedItemReasons(null).size).toBe(0);
  });

  it('cartNotOrderableMarks: lines gone from the catalog plus refused lines still in the cart', () => {
    const cart = base({ lines: [{ itemId: A, quantity: 1 }, { itemId: B, quantity: 1 }] });
    const catalog = new Map([
      [A, item(A, 'Shirt S', 5)],
      [B, item(B, 'Shirt M', 5)],
    ]);
    // Nothing gone, nothing refused.
    expect(cartNotOrderableMarks(cart, catalog, new Map())).toEqual({
      notOrderable: new Set(),
      refusals: new Map(),
    });
    // B hidden since the cart was built: the fresh catalog drops it.
    const fresh = new Map([[A, item(A, 'Shirt S', 5)]]);
    expect(cartNotOrderableMarks(cart, fresh, new Map()).notOrderable).toEqual(new Set([B]));
    // The server refused A (a hide between the catalog read and Submit), and
    // a refusal for a line no longer in the cart is dropped.
    const marks = cartNotOrderableMarks(
      cart,
      catalog,
      new Map([
        [A, 'hidden_from_orders'],
        [C, 'archived'],
      ]),
    );
    expect(marks.notOrderable).toEqual(new Set([A]));
    expect(marks.refusals).toEqual(new Map([[A, 'hidden_from_orders']]));
  });

  it('no catalog answer (loading or failed): only refusals mark, nothing is claimed about the rest', () => {
    const cart = base({ lines: [{ itemId: A, quantity: 1 }, { itemId: B, quantity: 1 }] });
    expect(cartNotOrderableMarks(cart, null, new Map()).notOrderable.size).toBe(0);
    expect(cartNotOrderableMarks(cart, null, new Map([[B, 'rental']])).notOrderable).toEqual(new Set([B]));
    expect(cartNotOrderableMarks(null, null, new Map([[B, 'rental']])).notOrderable.size).toBe(0);
  });
});

describe('a marked line can be lowered or removed, never raised', () => {
  const cart: CartState = {
    ...initialCartState({ warehouseId: 'w', fulfillmentType: 'pickup' }),
    lines: [
      { itemId: 'a', quantity: 2 },
      { itemId: 'b', quantity: 1 },
    ],
  };
  const marks = new Set(['a']);

  it('+, Add, a higher quantity or a kit that adds to it', () => {
    expect(raisesNotOrderable({ type: 'inc', itemId: 'a' }, cart, marks)).toBe(true);
    expect(raisesNotOrderable({ type: 'add', itemId: 'a' }, cart, marks)).toBe(true);
    expect(raisesNotOrderable({ type: 'set-qty', itemId: 'a', quantity: 3 }, cart, marks)).toBe(true);
    expect(
      raisesNotOrderable(
        { type: 'apply-kit', bundleId: 'k', changes: [{ itemId: 'b', delta: 1 }, { itemId: 'a', delta: 1 }] },
        cart,
        marks,
      ),
    ).toBe(true);
  });

  it('lowering, removing and every unmarked line are allowed', () => {
    expect(raisesNotOrderable({ type: 'dec', itemId: 'a' }, cart, marks)).toBe(false);
    expect(raisesNotOrderable({ type: 'remove', itemId: 'a' }, cart, marks)).toBe(false);
    expect(raisesNotOrderable({ type: 'set-qty', itemId: 'a', quantity: 2 }, cart, marks)).toBe(false);
    expect(raisesNotOrderable({ type: 'set-qty', itemId: 'a', quantity: 0 }, cart, marks)).toBe(false);
    expect(raisesNotOrderable({ type: 'inc', itemId: 'b' }, cart, marks)).toBe(false);
    expect(
      raisesNotOrderable({ type: 'apply-kit', bundleId: 'k', changes: [{ itemId: 'a', delta: -1 }] }, cart, marks),
    ).toBe(false);
    expect(raisesNotOrderable({ type: 'inc', itemId: 'a' }, cart, new Set())).toBe(false);
  });
});

describe('what a cart line says', () => {
  it('over available, all available, marked, or nothing', () => {
    expect(cartLineNote(10, item(A, 'Planner', 8), false)).toEqual({
      kind: 'over',
      message: 'Only 8 available. Reduce the quantity.',
    });
    expect(cartLineNote(8, item(A, 'Planner', 8), false)).toEqual({
      kind: 'at_max',
      message: 'All 8 available are in your cart',
    });
    expect(cartLineNote(1, undefined, true)).toEqual({ kind: 'not_orderable' });
    expect(cartLineNote(1, item(A, 'Planner', 8), false)).toBeNull();
    expect(cartLineNote(1, undefined, false)).toBeNull();
  });

  it('a line the catalog no longer names reads "An item no longer listed here", never a uuid', () => {
    const v = cartLineView({ itemId: A, quantity: 1 }, undefined, true);
    expect(v).toMatchObject({ title: STOREFRONT_LINE_NOT_LISTED_COPY, note: { kind: 'not_orderable' }, stepper: false });
    expect(v.title).not.toContain(A);
    expect(v.removeLabel).toBe(STOREFRONT_REMOVE_THIS_ITEM_COPY);
    expect(cartLineView({ itemId: A, quantity: 1 }, undefined, false).title).toBe(STOREFRONT_LINE_DETAILS_PENDING_COPY);
  });

  it('a line refused as hidden says so, named from the cart, with no stepper', () => {
    const v = cartLineView({ itemId: A, quantity: 1 }, item(A, 'Planner', 8), true, 'hidden_from_orders');
    expect(v.note).toEqual({ kind: 'refused', message: ORDER_ITEM_HIDDEN_COPY });
    expect(v.note).toEqual({ kind: 'refused', message: orderItemRefusalCopy('hidden_from_orders', 'Planner') });
    expect(v.stepper).toBe(false);
    expect(v.removeLabel).toBe('Remove Planner');
  });
});

describe('a restored cart, checked against the catalog as it is now', () => {
  const catalog = new Map([[A, item(A, 'Planner', 3)]]);

  it('nothing is dropped: the line no longer listed is marked, the over line kept, one sentence', () => {
    const r = recheckRestoredCart(base({ lines: [{ itemId: A, quantity: 5 }, { itemId: B, quantity: 1 }] }), catalog);
    expect(r.cart.lines).toEqual([
      { itemId: A, quantity: 5 },
      { itemId: B, quantity: 1 },
    ]);
    expect([...r.notOrderable]).toEqual([B]);
    expect(r.notice).toBe(
      "Since this cart was saved, 1 item can't be ordered from here anymore, and 1 line asks for more than is available now. They are marked in your cart.",
    );
  });

  it('kit records are refitted to the lines', () => {
    const r = recheckRestoredCart(base({ lines: [{ itemId: A, quantity: 1 }], kits: { [BUNDLE]: { [A]: 4 } } }), catalog);
    expect(r.cart.kits).toEqual({ [BUNDLE]: { [A]: 1 } });
    expect(r.notice).toBeNull();
  });
});

describe('importing stale-cart.ts runs nothing (Metro evaluates core on start-up)', () => {
  it('has no call, new or tagged template at its top level, and core exports it', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const file = path.join(here, 'stale-cart.ts');
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const found: string[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isFunctionLike(n) || ts.isClassLike(n)) return;
      if (ts.isCallExpression(n) || ts.isNewExpression(n) || ts.isTaggedTemplateExpression(n)) {
        found.push(n.getText(sf).slice(0, 60));
        return;
      }
      ts.forEachChild(n, visit);
    };
    for (const st of sf.statements) {
      if (ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) continue;
      visit(st);
    }
    expect(found).toEqual([]);
    const index = readFileSync(path.join(here, '../../index.ts'), 'utf8');
    expect(index).toContain("export * from './orders/storefront/stale-cart';");
  });
});
