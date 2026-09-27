import { describe, expect, it } from 'vitest';

import { cartReducer, initialCartState } from '../v2/cart-context';
import type { CartState, CatalogItem } from '../v2/types';

import {
  allocateUnits,
  componentAvailable,
  filterKits,
  kitAvailability,
  kitsForAudit,
  kitsInCart,
  kitStatus,
  maxKits,
  planKitChange,
  releaseUnits,
  shortComponentNames,
  type KitOffer,
} from './storefront-kits';

// The New Hire Bundle as DC4 holds it (production, 2026-09-27): the backpack is
// TWO rows of SKU SP-X6IN2-E84, 16-B with 134 and 18-A with 60, and the bundle
// names 18-A. Mug 235, mouse pad 204, planner 204, one of each per kit.

function row(id: string, overrides: Partial<CatalogItem> = {}): CatalogItem {
  return {
    id,
    sku: `SKU-${id}`,
    name: id,
    warehouseId: 'wh-dc4',
    quantityOnHand: 0,
    reservedQuantity: 0,
    itemType: null,
    categoryId: 'cat-new-hire',
    categoryName: 'New Hire',
    charterId: null,
    charterName: null,
    charterCode: null,
    rackLabel: null,
    imageUrl: null,
    lqip: null,
    price: null,
    reorderPoint: 0,
    ...overrides,
  };
}

const BACKPACK_18A = row('backpack-18a', {
  name: 'L4L - New Hire - Backpack',
  sku: 'SP-X6IN2-E84',
  rackLabel: '18-A',
  quantityOnHand: 60,
});
const BACKPACK_16B = row('backpack-16b', {
  name: 'L4L - New Hire - Backpack',
  sku: 'SP-X6IN2-E84',
  rackLabel: '16-B',
  quantityOnHand: 134,
});
const MUG = row('mug', { name: 'L4L - New Hire - Coffee mug', quantityOnHand: 235 });
const PAD = row('pad', { name: 'L4L - New Hire - Mouse Pad', quantityOnHand: 204 });
const PLANNER = row('planner', { name: 'L4L - New Hire - Planner', quantityOnHand: 204 });

const NEW_HIRE: KitOffer = {
  bundleId: 'bundle-new-hire',
  name: 'New Hire Bundle',
  sku: null,
  components: [
    // The loader lists the named row first, then the SKU's other rows.
    { anchorItemId: BACKPACK_18A.id, itemIds: [BACKPACK_18A.id, BACKPACK_16B.id], perKit: 1 },
    { anchorItemId: MUG.id, itemIds: [MUG.id], perKit: 1 },
    { anchorItemId: PAD.id, itemIds: [PAD.id], perKit: 1 },
    { anchorItemId: PLANNER.id, itemIds: [PLANNER.id], perKit: 1 },
  ],
};

function catalog(...items: CatalogItem[]): Map<string, CatalogItem> {
  return new Map(items.map((i) => [i.id, i]));
}
const DC4 = catalog(BACKPACK_18A, BACKPACK_16B, MUG, PAD, PLANNER);

const empty = (): CartState => initialCartState({ warehouseId: 'wh-dc4', fulfillmentType: 'pickup' });
const qtyOf = (s: CartState) => new Map(s.lines.map((l) => [l.itemId, l.quantity]));
const lineQty = (s: CartState, id: string) => s.lines.find((l) => l.itemId === id)?.quantity ?? 0;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Plans the kit count `target` against the cart and applies it, as the page does. */
function setKits(
  s: CartState,
  target: number,
  kit: KitOffer = NEW_HIRE,
  items: Map<string, CatalogItem> = DC4,
): CartState {
  const plan = planKitChange(kit, target, items, s.kits[kit.bundleId], qtyOf(s));
  if (!plan.ok) throw new Error(`short: ${plan.short.anchorItemId}`);
  return cartReducer(s, { type: 'apply-kit', bundleId: kit.bundleId, changes: plan.changes });
}

describe('kit availability counts every rack of a component SKU', () => {
  it('the backpack counts 134 + 60 = 194, not the 60 on the row the bundle names', () => {
    expect(componentAvailable(NEW_HIRE.components[0]!, DC4)).toBe(194);
  });

  it('kits available is the smallest component total: 194, limited by the backpack', () => {
    const a = kitAvailability(NEW_HIRE, DC4);
    expect(a.kits).toBe(194);
    expect(a.limiting?.component.anchorItemId).toBe(BACKPACK_18A.id);
    expect(a.limiting?.available).toBe(194);
    expect(a.short).toEqual([]);
  });

  it('uses the item cards figure: on hand minus open reservations', () => {
    const items = catalog(
      { ...BACKPACK_18A, reservedQuantity: 10 },
      { ...BACKPACK_16B, reservedQuantity: 34 },
      MUG,
      PAD,
      PLANNER,
    );
    expect(kitAvailability(NEW_HIRE, items).kits).toBe(150);
  });

  it('divides by the units per kit and rounds down', () => {
    const kit: KitOffer = {
      ...NEW_HIRE,
      components: [{ anchorItemId: MUG.id, itemIds: [MUG.id], perKit: 2 }],
    };
    expect(kitAvailability(kit, DC4).kits).toBe(117);
  });

  it('a component with nothing left names itself as short and the kit is out', () => {
    const items = catalog({ ...BACKPACK_18A, quantityOnHand: 0 }, { ...BACKPACK_16B, quantityOnHand: 0 }, MUG, PAD, PLANNER);
    const a = kitAvailability(NEW_HIRE, items);
    expect(a.kits).toBe(0);
    expect(a.short.map((c) => c.anchorItemId)).toEqual([BACKPACK_18A.id]);
    expect(kitStatus(NEW_HIRE, items)).toBe('out');
  });

  it('a kit with no components is never unlimited', () => {
    expect(kitAvailability({ ...NEW_HIRE, components: [] }, DC4).kits).toBe(0);
  });
});

describe('Add kit allocates each component across its racks', () => {
  it('3 kits: all 3 backpacks from ONE row, the row the bundle names (18-A), although 16-B has more', () => {
    const s = setKits(empty(), 3);
    expect(s.lines).toEqual([
      { itemId: BACKPACK_18A.id, quantity: 3 },
      { itemId: MUG.id, quantity: 3 },
      { itemId: PAD.id, quantity: 3 },
      { itemId: PLANNER.id, quantity: 3 },
    ]);
    expect(kitsInCart(NEW_HIRE, s.kits[NEW_HIRE.bundleId], qtyOf(s))).toBe(3);
  });

  it('150 kits: no row covers 150, so 134 from 16-B (most left) and 16 from 18-A', () => {
    const s = setKits(empty(), 150);
    expect(lineQty(s, BACKPACK_16B.id)).toBe(134);
    expect(lineQty(s, BACKPACK_18A.id)).toBe(16);
    expect(lineQty(s, MUG.id)).toBe(150);
    expect(s.kits[NEW_HIRE.bundleId]).toEqual({
      [BACKPACK_16B.id]: 134,
      [BACKPACK_18A.id]: 16,
      [MUG.id]: 150,
      [PAD.id]: 150,
      [PLANNER.id]: 150,
    });
    expect(kitsInCart(NEW_HIRE, s.kits[NEW_HIRE.bundleId], qtyOf(s))).toBe(150);
  });

  it('one kit at a time: 18-A until it has none left, then the 61st moves the kit onto 16-B, as 61 at once would', () => {
    let s = empty();
    for (let n = 1; n <= 60; n += 1) s = setKits(s, n);
    expect(lineQty(s, BACKPACK_18A.id)).toBe(60);
    // 18-A cannot hold 61 and 16-B can, so the whole count goes to ONE rack
    // (one line, one rack to pick) instead of 60 on 18-A plus 1 on 16-B.
    s = setKits(s, 61);
    expect(lineQty(s, BACKPACK_16B.id)).toBe(61);
    expect(s.lines.some((l) => l.itemId === BACKPACK_18A.id)).toBe(false);
    expect(qtyOf(s)).toEqual(qtyOf(setKits(empty(), 61)));
  });

  it('194 kits takes every backpack on both racks; the 195th is refused whole', () => {
    const s = setKits(empty(), 194);
    expect(lineQty(s, BACKPACK_16B.id) + lineQty(s, BACKPACK_18A.id)).toBe(194);
    expect(maxKits(NEW_HIRE, DC4, s.kits[NEW_HIRE.bundleId], qtyOf(s))).toBe(194);
    const plan = planKitChange(NEW_HIRE, 195, DC4, s.kits[NEW_HIRE.bundleId], qtyOf(s));
    expect(plan.ok).toBe(false);
  });

  it('counts what the cart already holds on a row, from any source', () => {
    // 58 backpacks added by hand on 18-A leave it 2: 3 kits no longer fit
    // there, so the 3 come from 16-B in one line.
    let s = cartReducer(empty(), { type: 'add', itemId: BACKPACK_18A.id, quantity: 58 });
    s = setKits(s, 3);
    expect(lineQty(s, BACKPACK_18A.id)).toBe(58);
    expect(lineQty(s, BACKPACK_16B.id)).toBe(3);
  });

  it('when the named row cannot cover it, the covering row with the most left wins', () => {
    expect(
      allocateUnits(
        10,
        [
          { itemId: 'anchor', left: 4 },
          { itemId: 'x', left: 50 },
          { itemId: 'y', left: 80 },
        ],
        'anchor',
      ),
    ).toEqual([{ itemId: 'y', delta: 10 }]);
  });

  it('a split on equal rows starts with the named row', () => {
    expect(
      allocateUnits(
        12,
        [
          { itemId: 'a', left: 8 },
          { itemId: 'anchor', left: 8 },
        ],
        'anchor',
      ),
    ).toEqual([
      { itemId: 'anchor', delta: 8 },
      { itemId: 'a', delta: 4 },
    ]);
  });

  it('allocation never uses a row with nothing left and answers null when the rows fall short', () => {
    expect(allocateUnits(5, [{ itemId: 'a', left: 0 }], 'a')).toBeNull();
    expect(allocateUnits(5, [{ itemId: 'a', left: 2 }, { itemId: 'b', left: 2 }], 'a')).toBeNull();
  });

  it('two units per kit: 3 kits need 6 of that component', () => {
    const kit: KitOffer = {
      ...NEW_HIRE,
      components: [{ anchorItemId: MUG.id, itemIds: [MUG.id], perKit: 2 }],
    };
    const s = setKits(empty(), 3, kit);
    expect(lineQty(s, MUG.id)).toBe(6);
    expect(kitsInCart(kit, s.kits[kit.bundleId], qtyOf(s))).toBe(3);
  });
});

describe('Add kit is all or nothing', () => {
  it('a component that cannot supply its share changes NOTHING and is named', () => {
    const items = catalog(BACKPACK_18A, BACKPACK_16B, { ...MUG, quantityOnHand: 2 }, PAD, PLANNER);
    const plan = planKitChange(NEW_HIRE, 3, items, undefined, new Map());
    expect(plan).toEqual({ ok: false, short: NEW_HIRE.components[1] });
    // The old "Add full kit" skipped the short item and added the rest.
  });

  it('the refused plan leaves the cart exactly as it was', () => {
    const items = catalog(BACKPACK_18A, BACKPACK_16B, { ...MUG, quantityOnHand: 2 }, PAD, PLANNER);
    const before = setKits(empty(), 2, NEW_HIRE, items);
    const plan = planKitChange(NEW_HIRE, 3, items, before.kits[NEW_HIRE.bundleId], qtyOf(before));
    expect(plan.ok).toBe(false);
    expect(maxKits(NEW_HIRE, items, before.kits[NEW_HIRE.bundleId], qtyOf(before))).toBe(2);
  });
});

describe('removing a kit takes back only the kit own units', () => {
  it('after the 61st kit moved the kit to 16-B, going back to 60 keeps its one line there', () => {
    let s = empty();
    s = setKits(s, 60);
    s = setKits(s, 61);
    s = setKits(s, 60);
    // Lowering only gives units back; it never moves the kit to another rack.
    expect(lineQty(s, BACKPACK_16B.id)).toBe(60);
    expect(s.lines.some((l) => l.itemId === BACKPACK_18A.id)).toBe(false);
  });

  it('from the 134 + 16 split, one kit less comes off 18-A: 149 still needs both rows, the larger kept whole', () => {
    const s = setKits(setKits(empty(), 150), 149);
    expect(lineQty(s, BACKPACK_18A.id)).toBe(15);
    expect(lineQty(s, BACKPACK_16B.id)).toBe(134);
  });

  it('from the 134 + 16 split down to 3 kits, the 3 stay on 18-A, where a fresh 3 kits would go', () => {
    const s = setKits(setKits(empty(), 150), 3);
    expect(lineQty(s, BACKPACK_18A.id)).toBe(3);
    expect(s.lines.some((l) => l.itemId === BACKPACK_16B.id)).toBe(false);
    expect(s.kits[NEW_HIRE.bundleId]![BACKPACK_18A.id]).toBe(3);
  });

  it('from the 134 + 16 split down to 130 kits, one line of 130 stays on 16-B (fewest lines first)', () => {
    const s = setKits(setKits(empty(), 150), 130);
    expect(lineQty(s, BACKPACK_16B.id)).toBe(130);
    expect(s.lines.some((l) => l.itemId === BACKPACK_18A.id)).toBe(false);
  });

  it('on a tie it takes from the other row before the named one', () => {
    expect(
      releaseUnits(
        1,
        [
          { itemId: 'anchor', held: 5 },
          { itemId: 'b', held: 5 },
        ],
        'anchor',
      ),
    ).toEqual([{ itemId: 'b', delta: -1 }]);
  });

  it('removing every kit leaves the units added by hand on the same line', () => {
    let s = cartReducer(empty(), { type: 'add', itemId: BACKPACK_18A.id, quantity: 2 });
    s = cartReducer(s, { type: 'add', itemId: MUG.id, quantity: 1 });
    s = setKits(s, 3);
    expect(lineQty(s, BACKPACK_18A.id)).toBe(5);
    expect(lineQty(s, MUG.id)).toBe(4);
    s = setKits(s, 0);
    expect(s.lines).toEqual([
      { itemId: BACKPACK_18A.id, quantity: 2 },
      { itemId: MUG.id, quantity: 1 },
    ]);
    expect(s.kits).toEqual({});
  });

  it('a line lowered by hand lowers the kit count, and taking that one kit out takes one of each, not the rest', () => {
    let s = setKits(empty(), 3);
    s = cartReducer(s, { type: 'set-qty', itemId: MUG.id, quantity: 1 });
    expect(kitsInCart(NEW_HIRE, s.kits[NEW_HIRE.bundleId], qtyOf(s))).toBe(1);
    s = setKits(s, 0);
    // Was every line emptied: the card showed 1 kit, and one kit less took 3.
    expect(Object.fromEntries(qtyOf(s))).toEqual({
      [BACKPACK_18A.id]: 2,
      [PAD.id]: 2,
      [PLANNER.id]: 2,
    });
    expect(kitsInCart(NEW_HIRE, s.kits[NEW_HIRE.bundleId], qtyOf(s))).toBe(0);
  });

  it('the same items added by hand are not a kit', () => {
    let s = empty();
    for (const id of [BACKPACK_18A.id, MUG.id, PAD.id, PLANNER.id]) {
      s = cartReducer(s, { type: 'add', itemId: id });
    }
    expect(kitsInCart(NEW_HIRE, s.kits[NEW_HIRE.bundleId], qtyOf(s))).toBe(0);
  });
});

// ═══ ONE KIT LESS TAKES ONE KIT'S WORTH (verify 2026-09-27) ═══
//
// Lowering used to give back every unit the kit recorded above the new count.
// After a hand edit the kit can record more than its count: 3 kits, the mug
// removed by hand, then Add kit, leaves the card at 1 kit over 3 backpacks,
// pads and planners. One press of minus then emptied the cart, 10 units at
// once. Now a step down of n kits takes, per component, n x per kit of the
// kit's own units, never more, and never a unit added by hand.
describe('one kit less takes exactly one kit of each item', () => {
  /** The plan for `target`, and the cart after it. */
  function lower(s: CartState, target: number, kit: KitOffer = NEW_HIRE, items = DC4) {
    const plan = planKitChange(kit, target, items, s.kits[kit.bundleId], qtyOf(s));
    if (!plan.ok) throw new Error('short');
    return { changes: plan.changes, after: setKits(s, target, kit, items) };
  }
  const count = (s: CartState, kit: KitOffer = NEW_HIRE) =>
    kitsInCart(kit, s.kits[kit.bundleId], qtyOf(s));

  it('3 kits, the mug removed by hand, Add kit, then minus: one of each comes out, not all 10 units', () => {
    let s = setKits(empty(), 3);
    s = cartReducer(s, { type: 'remove', itemId: MUG.id });
    s = setKits(s, 1);
    expect(count(s)).toBe(1);
    expect([...qtyOf(s).values()].reduce((a, b) => a + b, 0)).toBe(10);

    const { changes, after } = lower(s, 0);
    expect([...changes].sort((a, b) => compare(a.itemId, b.itemId))).toEqual(
      [
        { itemId: BACKPACK_18A.id, delta: -1 },
        { itemId: MUG.id, delta: -1 },
        { itemId: PAD.id, delta: -1 },
        { itemId: PLANNER.id, delta: -1 },
      ].sort((a, b) => compare(a.itemId, b.itemId)),
    );
    expect(Object.fromEntries(qtyOf(after))).toEqual({
      [BACKPACK_18A.id]: 2,
      [PAD.id]: 2,
      [PLANNER.id]: 2,
    });
    expect(count(after)).toBe(0);
  });

  it('a typed lower count takes (kits removed x per kit) of each item, however much more the kit holds', () => {
    let s = setKits(empty(), 5);
    s = cartReducer(s, { type: 'set-qty', itemId: MUG.id, quantity: 2 });
    expect(count(s)).toBe(2);
    const { after } = lower(s, 1);
    expect(Object.fromEntries(qtyOf(after))).toEqual({
      [BACKPACK_18A.id]: 4,
      [MUG.id]: 1,
      [PAD.id]: 4,
      [PLANNER.id]: 4,
    });
    expect(count(after)).toBe(1);
  });

  it('each minus from the count shown takes one kit, until the card is back to Add kit', () => {
    let s = setKits(empty(), 4);
    s = cartReducer(s, { type: 'set-qty', itemId: PAD.id, quantity: 2 });
    expect(count(s)).toBe(2);
    s = setKits(s, 1);
    expect(Object.fromEntries(qtyOf(s))).toEqual({
      [BACKPACK_18A.id]: 3,
      [MUG.id]: 3,
      [PAD.id]: 1,
      [PLANNER.id]: 3,
    });
    s = setKits(s, 0);
    expect(Object.fromEntries(qtyOf(s))).toEqual({
      [BACKPACK_18A.id]: 2,
      [MUG.id]: 2,
      [PLANNER.id]: 2,
    });
    expect(count(s)).toBe(0);
  });

  it('two units per kit: one kit less takes two of that item', () => {
    const kit: KitOffer = {
      ...NEW_HIRE,
      components: [
        { anchorItemId: MUG.id, itemIds: [MUG.id], perKit: 2 },
        { anchorItemId: PAD.id, itemIds: [PAD.id], perKit: 1 },
      ],
    };
    let s = setKits(empty(), 3, kit);
    expect(Object.fromEntries(qtyOf(s))).toEqual({ [MUG.id]: 6, [PAD.id]: 3 });
    s = cartReducer(s, { type: 'set-qty', itemId: PAD.id, quantity: 1 });
    expect(count(s, kit)).toBe(1);
    const { after } = lower(s, 0, kit);
    expect(Object.fromEntries(qtyOf(after))).toEqual({ [MUG.id]: 4 });
  });

  it('units added by hand on a kit line are never taken, however far the count goes down', () => {
    let s = cartReducer(empty(), { type: 'add', itemId: BACKPACK_18A.id, quantity: 2 });
    s = setKits(s, 3);
    s = cartReducer(s, { type: 'remove', itemId: MUG.id });
    s = setKits(s, 1);
    // 18-A holds 5: 2 by hand and 3 recorded for the kit.
    expect(lineQty(s, BACKPACK_18A.id)).toBe(5);
    s = setKits(s, 0);
    expect(lineQty(s, BACKPACK_18A.id)).toBe(4);
    expect(lineQty(s, MUG.id)).toBe(0);
  });

  it('as the card left it, lowering is unchanged: 150 down to 3 keeps 3 on 18-A and nothing else', () => {
    const s = setKits(setKits(empty(), 150), 3);
    expect(Object.fromEntries(qtyOf(s))).toEqual({
      [BACKPACK_18A.id]: 3,
      [MUG.id]: 3,
      [PAD.id]: 3,
      [PLANNER.id]: 3,
    });
  });

  it('after any hand edit, a step down of n kits takes at most n x per kit of each item, only the kit own units', () => {
    const edits: Array<(s: CartState) => CartState> = [
      (s) => s,
      (s) => cartReducer(s, { type: 'remove', itemId: MUG.id }),
      (s) => cartReducer(s, { type: 'set-qty', itemId: MUG.id, quantity: 1 }),
      (s) => cartReducer(s, { type: 'set-qty', itemId: PAD.id, quantity: 7 }),
      (s) => cartReducer(s, { type: 'dec', itemId: PLANNER.id }),
      (s) => cartReducer(s, { type: 'add', itemId: BACKPACK_18A.id, quantity: 4 }),
      (s) => cartReducer(s, { type: 'set-qty', itemId: BACKPACK_18A.id, quantity: 1 }),
    ];
    for (const edit of edits) {
      // 6 kits, a hand edit, then Add kit or + back up to 6 where the edit
      // left fewer: the kit may now record more units than its count.
      let s = edit(setKits(empty(), 6));
      if (count(s) < 6) s = setKits(s, Math.max(1, count(s) + 1));
      const shown = count(s);
      for (let target = shown - 1; target >= 0; target -= 1) {
        const before = s;
        const shares = before.kits[NEW_HIRE.bundleId] ?? {};
        s = setKits(before, target);
        expect(count(s)).toBe(target);
        for (const component of NEW_HIRE.components) {
          const unitsBefore = component.itemIds.reduce((n, id) => n + lineQty(before, id), 0);
          const unitsAfter = component.itemIds.reduce((n, id) => n + lineQty(s, id), 0);
          // One kit less per step: exactly one kit's worth when the kit holds
          // it, never more.
          expect(unitsBefore - unitsAfter).toBeLessThanOrEqual(component.perKit);
          for (const id of component.itemIds) {
            // Never below what was on the line apart from the kit's record.
            expect(lineQty(s, id)).toBeGreaterThanOrEqual(lineQty(before, id) - (shares[id] ?? 0));
          }
        }
      }
    }
  });
});

// ═══ RAISING A KIT ONLY ADDS (walk 2026-09-27, review F1) ═══
//
// The first version planned every component to exactly (count × per kit), so
// after a line was changed by hand, Add kit or + gave units BACK on the other
// lines, silently. Both cases below were reproduced in a real browser.
describe('raising a kit never takes units out of the cart', () => {
  /** The plan for `target`, and the cart after it. */
  function raise(s: CartState, target: number) {
    const plan = planKitChange(NEW_HIRE, target, DC4, s.kits[NEW_HIRE.bundleId], qtyOf(s));
    if (!plan.ok) throw new Error('short');
    return { changes: plan.changes, after: setKits(s, target) };
  }

  it('3 kits, the mug line removed by hand, then Add kit: one mug goes in and nothing comes out', () => {
    let s = setKits(empty(), 3);
    s = cartReducer(s, { type: 'remove', itemId: MUG.id });
    // The card is back to "Add kit": no whole kit is left without the mug.
    expect(kitsInCart(NEW_HIRE, s.kits[NEW_HIRE.bundleId], qtyOf(s))).toBe(0);

    const { changes, after } = raise(s, 1);
    expect(changes).toEqual([{ itemId: MUG.id, delta: 1 }]);
    // Was {backpack 1, mug 1, pad 1, planner 1}: two of each taken back.
    expect(Object.fromEntries(qtyOf(after))).toEqual({
      [BACKPACK_18A.id]: 3,
      [PAD.id]: 3,
      [PLANNER.id]: 3,
      [MUG.id]: 1,
    });
    expect(kitsInCart(NEW_HIRE, after.kits[NEW_HIRE.bundleId], qtyOf(after))).toBe(1);
  });

  it('3 kits, the mug set to 1 by hand, then +: one mug goes in, 10 units become 11, not 8', () => {
    let s = setKits(empty(), 3);
    s = cartReducer(s, { type: 'set-qty', itemId: MUG.id, quantity: 1 });
    expect(kitsInCart(NEW_HIRE, s.kits[NEW_HIRE.bundleId], qtyOf(s))).toBe(1);

    const { changes, after } = raise(s, 2);
    expect(changes).toEqual([{ itemId: MUG.id, delta: 1 }]);
    expect(Object.fromEntries(qtyOf(after))).toEqual({
      [BACKPACK_18A.id]: 3,
      [MUG.id]: 2,
      [PAD.id]: 3,
      [PLANNER.id]: 3,
    });
    expect(kitsInCart(NEW_HIRE, after.kits[NEW_HIRE.bundleId], qtyOf(after))).toBe(2);
  });

  it('the mug set to 1 and then back to 3 by hand, then +: the hand-set mugs stay and one more goes in', () => {
    let s = setKits(empty(), 3);
    s = cartReducer(s, { type: 'set-qty', itemId: MUG.id, quantity: 1 });
    s = cartReducer(s, { type: 'set-qty', itemId: MUG.id, quantity: 3 });
    const { changes, after } = raise(s, 2);
    expect(changes.every((c) => c.delta > 0)).toBe(true);
    expect(lineQty(after, MUG.id)).toBe(4);
    expect(lineQty(after, BACKPACK_18A.id)).toBe(3);
    expect(lineQty(after, PAD.id)).toBe(3);
    expect(lineQty(after, PLANNER.id)).toBe(3);
  });

  it('a typed count above the current one only adds too', () => {
    let s = setKits(empty(), 3);
    s = cartReducer(s, { type: 'remove', itemId: MUG.id });
    const { changes, after } = raise(s, 2);
    expect(changes).toEqual([{ itemId: MUG.id, delta: 2 }]);
    expect(lineQty(after, BACKPACK_18A.id)).toBe(3);
  });

  it('after any hand edit, every raise leaves every line at least where it was', () => {
    const edits: Array<(s: CartState) => CartState> = [
      (s) => s,
      (s) => cartReducer(s, { type: 'remove', itemId: MUG.id }),
      (s) => cartReducer(s, { type: 'set-qty', itemId: MUG.id, quantity: 1 }),
      (s) => cartReducer(s, { type: 'set-qty', itemId: PAD.id, quantity: 7 }),
      (s) => cartReducer(s, { type: 'dec', itemId: PLANNER.id }),
      (s) => cartReducer(s, { type: 'add', itemId: BACKPACK_16B.id, quantity: 4 }),
      (s) => cartReducer(s, { type: 'set-qty', itemId: BACKPACK_18A.id, quantity: 1 }),
    ];
    for (const edit of edits) {
      const before = edit(setKits(empty(), 3));
      const count = kitsInCart(NEW_HIRE, before.kits[NEW_HIRE.bundleId], qtyOf(before));
      for (const target of [count + 1, count + 2, count + 40]) {
        const { changes, after } = raise(before, target);
        // No line holding units added by hand is ever lowered, and here no
        // line at all: the kit sits on 18-A, which covers each of these counts.
        expect(changes.filter((c) => c.delta < 0)).toEqual([]);
        for (const [itemId, quantity] of qtyOf(before)) {
          expect(lineQty(after, itemId)).toBeGreaterThanOrEqual(quantity);
        }
        expect(kitsInCart(NEW_HIRE, after.kits[NEW_HIRE.bundleId], qtyOf(after))).toBe(target);
      }
    }
  });
});

// ═══ A TYPED JUMP USES ONE RACK WHEN ONE CAN HOLD IT ALL (review F6) ═══
//
// The stepper only appears after Add kit has put one backpack on 18-A, so the
// first version turned every typed count from 61 to 135 into 18-A plus 16-B,
// although 16-B (134) holds it all.
describe('a raise is planned over the kit whole count', () => {
  it('Add kit, then type 100: all 100 backpacks from 16-B, one line', () => {
    const s = setKits(setKits(empty(), 1), 100);
    expect(lineQty(s, BACKPACK_16B.id)).toBe(100);
    expect(s.lines.some((l) => l.itemId === BACKPACK_18A.id)).toBe(false);
    expect(s.kits[NEW_HIRE.bundleId]![BACKPACK_16B.id]).toBe(100);
    expect(kitsInCart(NEW_HIRE, s.kits[NEW_HIRE.bundleId], qtyOf(s))).toBe(100);
  });

  it('3 kits, then type 100: the same single 16-B line a fresh 100 would give', () => {
    const s = setKits(setKits(empty(), 3), 100);
    expect(qtyOf(s)).toEqual(qtyOf(setKits(empty(), 100)));
    expect(lineQty(s, BACKPACK_16B.id)).toBe(100);
  });

  it('no rack holds 150, so a jump from 3 splits exactly as a fresh 150 does', () => {
    const s = setKits(setKits(empty(), 3), 150);
    expect(lineQty(s, BACKPACK_16B.id)).toBe(134);
    expect(lineQty(s, BACKPACK_18A.id)).toBe(16);
  });

  it('100 on 16-B raised to 150: 134 + 16, the split a fresh 150 gives, not 100 + 50', () => {
    // Walk 2026-09-27 (after the first fix): the top-up put the 50 extra on
    // 18-A, the one rack that could take 50, and kept the jump path-dependent.
    const s = setKits(setKits(setKits(empty(), 1), 100), 150);
    expect(lineQty(s, BACKPACK_16B.id)).toBe(134);
    expect(lineQty(s, BACKPACK_18A.id)).toBe(16);
    expect(qtyOf(s)).toEqual(qtyOf(setKits(empty(), 150)));
  });

  it('a raise stays on the rack the kit already uses when that rack can take it', () => {
    // 100 on 16-B, lowered to 3 (still on 16-B), then one more: the fourth
    // goes on 16-B too, not onto a second line on 18-A.
    let s = setKits(setKits(empty(), 100), 3);
    expect(lineQty(s, BACKPACK_16B.id)).toBe(3);
    s = setKits(s, 4);
    expect(lineQty(s, BACKPACK_16B.id)).toBe(4);
    expect(s.lines.some((l) => l.itemId === BACKPACK_18A.id)).toBe(false);
  });

  it('the kit never moves off a line that also holds backpacks added by hand', () => {
    // Two added by hand on 18-A, then Add kit (18-A: 2 by hand + 1 of the kit),
    // then 100 typed: 18-A keeps its 3, and 16-B takes the other 99.
    let s = cartReducer(empty(), { type: 'add', itemId: BACKPACK_18A.id, quantity: 2 });
    s = setKits(s, 1);
    expect(lineQty(s, BACKPACK_18A.id)).toBe(3);
    const plan = planKitChange(NEW_HIRE, 100, DC4, s.kits[NEW_HIRE.bundleId], qtyOf(s));
    expect(plan.ok && plan.changes.every((c) => c.delta > 0)).toBe(true);
    s = setKits(s, 100);
    expect(lineQty(s, BACKPACK_18A.id)).toBe(3);
    expect(lineQty(s, BACKPACK_16B.id)).toBe(99);
    expect(kitsInCart(NEW_HIRE, s.kits[NEW_HIRE.bundleId], qtyOf(s))).toBe(100);
  });

  it('a line lowered by hand is never emptied by a typed count: it keeps what the person set', () => {
    // 3 kits, then the backpack set to 2 by hand (the kit now counts 2), then
    // 100 typed: 18-A keeps its 2 and 16-B takes the other 98.
    let s = setKits(empty(), 3);
    s = cartReducer(s, { type: 'set-qty', itemId: BACKPACK_18A.id, quantity: 2 });
    expect(kitsInCart(NEW_HIRE, s.kits[NEW_HIRE.bundleId], qtyOf(s))).toBe(2);
    const plan = planKitChange(NEW_HIRE, 100, DC4, s.kits[NEW_HIRE.bundleId], qtyOf(s));
    expect(plan.ok && plan.changes.every((c) => c.delta > 0)).toBe(true);
    s = setKits(s, 100);
    expect(lineQty(s, BACKPACK_18A.id)).toBe(2);
    expect(lineQty(s, BACKPACK_16B.id)).toBe(98);
    expect(kitsInCart(NEW_HIRE, s.kits[NEW_HIRE.bundleId], qtyOf(s))).toBe(100);
  });

  it('a move takes only this kit own units, and the component total never falls', () => {
    const before = setKits(empty(), 60);
    const plan = planKitChange(NEW_HIRE, 61, DC4, before.kits[NEW_HIRE.bundleId], qtyOf(before));
    if (!plan.ok) throw new Error('short');
    const backpack = plan.changes.filter(
      (c) => c.itemId === BACKPACK_18A.id || c.itemId === BACKPACK_16B.id,
    );
    expect(backpack).toEqual([
      { itemId: BACKPACK_18A.id, delta: -60 },
      { itemId: BACKPACK_16B.id, delta: 61 },
    ]);
    expect(backpack.reduce((sum, c) => sum + c.delta, 0)).toBe(1);
  });
});

describe('the cart never lets a kit take a unit it did not put there', () => {
  it('a kit change that asks for more than the kit recorded on a line takes only the kit units', () => {
    // 2 backpacks by hand, then 3 kits on the same 18-A line: 5, 3 of them the kit's.
    let s = cartReducer(empty(), { type: 'add', itemId: BACKPACK_18A.id, quantity: 2 });
    s = setKits(s, 3);
    expect(lineQty(s, BACKPACK_18A.id)).toBe(5);
    s = cartReducer(s, {
      type: 'apply-kit',
      bundleId: NEW_HIRE.bundleId,
      changes: [{ itemId: BACKPACK_18A.id, delta: -5 }],
    });
    expect(lineQty(s, BACKPACK_18A.id)).toBe(2);
    expect(s.kits[NEW_HIRE.bundleId]?.[BACKPACK_18A.id]).toBeUndefined();
  });

  it('a kit with no record on a line cannot take anything off it', () => {
    const s = cartReducer(
      cartReducer(empty(), { type: 'add', itemId: MUG.id, quantity: 4 }),
      { type: 'apply-kit', bundleId: NEW_HIRE.bundleId, changes: [{ itemId: MUG.id, delta: -4 }] },
    );
    expect(lineQty(s, MUG.id)).toBe(4);
  });

  it('a record larger than its line is cut to the line; a raise then tops up from there', () => {
    // A state whose record says 5 mugs on a 2-mug line (as an old or edited
    // draft could carry): the kit counts the 2 it can see, and + adds one mug.
    const s: CartState = {
      ...empty(),
      lines: [
        { itemId: BACKPACK_18A.id, quantity: 3 },
        { itemId: MUG.id, quantity: 2 },
        { itemId: PAD.id, quantity: 3 },
        { itemId: PLANNER.id, quantity: 3 },
      ],
      kits: {
        [NEW_HIRE.bundleId]: {
          [BACKPACK_18A.id]: 3,
          [MUG.id]: 5,
          [PAD.id]: 3,
          [PLANNER.id]: 3,
        },
      },
    };
    expect(kitsInCart(NEW_HIRE, s.kits[NEW_HIRE.bundleId], qtyOf(s))).toBe(2);
    const after = setKits(s, 3);
    expect(Object.fromEntries(qtyOf(after))).toEqual({
      [BACKPACK_18A.id]: 3,
      [MUG.id]: 3,
      [PAD.id]: 3,
      [PLANNER.id]: 3,
    });
    expect(after.kits[NEW_HIRE.bundleId]![MUG.id]).toBe(3);
  });
});

describe('filterKits', () => {
  const SPORTS = row('football', { categoryId: 'cat-sports', categoryName: 'Sports', quantityOnHand: 5 });
  const KITCHEN = row('board', { categoryId: 'cat-kitchen', categoryName: 'Home & Kitchen', quantityOnHand: 5 });
  const GAME_DAY: KitOffer = {
    bundleId: 'bundle-game-day',
    name: 'Game Day Kit',
    sku: 'KIT-GD',
    components: [
      { anchorItemId: SPORTS.id, itemIds: [SPORTS.id], perKit: 1 },
      { anchorItemId: KITCHEN.id, itemIds: [KITCHEN.id], perKit: 1 },
    ],
  };
  const items = catalog(BACKPACK_18A, BACKPACK_16B, MUG, PAD, PLANNER, SPORTS, KITCHEN);
  const none = new Set<'ok' | 'low' | 'out'>();

  it('a category view leads with every kit that has an item in that category', () => {
    const names = (category: string) =>
      filterKits([NEW_HIRE, GAME_DAY], items, { category, search: '', availability: none }).map((k) => k.name);
    expect(names('all')).toEqual(['New Hire Bundle', 'Game Day Kit']);
    expect(names('cat-new-hire')).toEqual(['New Hire Bundle']);
    expect(names('cat-kitchen')).toEqual(['Game Day Kit']);
    expect(names('uncategorized')).toEqual([]);
  });

  it('search matches every word against the kit name and SKU', () => {
    const names = (search: string) =>
      filterKits([NEW_HIRE, GAME_DAY], items, { category: 'all', search, availability: none }).map((k) => k.name);
    expect(names('new hire')).toEqual(['New Hire Bundle']);
    expect(names('kit-gd')).toEqual(['Game Day Kit']);
    expect(names('hire game')).toEqual([]);
  });

  it('an availability filter keeps kits whose status it names', () => {
    const out = catalog({ ...BACKPACK_18A, quantityOnHand: 0 }, { ...BACKPACK_16B, quantityOnHand: 0 }, MUG, PAD, PLANNER);
    expect(
      filterKits([NEW_HIRE], out, { category: 'all', search: '', availability: new Set(['out'] as const) }),
    ).toHaveLength(1);
    expect(
      filterKits([NEW_HIRE], out, { category: 'all', search: '', availability: new Set(['ok'] as const) }),
    ).toHaveLength(0);
  });
});

describe('kitsForAudit', () => {
  it('records the kits in the cart and their counts, nothing for a kit not used', () => {
    const s = setKits(empty(), 3);
    const other: KitOffer = { ...NEW_HIRE, bundleId: 'bundle-other' };
    expect(kitsForAudit([NEW_HIRE, other], s.kits, s.lines)).toEqual([
      { bundleId: NEW_HIRE.bundleId, count: 3 },
    ]);
  });
});

describe('shortComponentNames', () => {
  it('drops the words every name starts with', () => {
    expect(
      shortComponentNames([
        'L4L - New Hire - Backpack',
        'L4L - New Hire - Coffee mug',
        'L4L - New Hire - Mouse Pad',
        'L4L - New Hire - Planner',
      ]),
    ).toEqual(['Backpack', 'Coffee mug', 'Mouse Pad', 'Planner']);
  });

  it('never cuts a word in half and keeps names with nothing in common', () => {
    expect(shortComponentNames(['Football', 'Basketball', 'Chopping Board'])).toEqual([
      'Football',
      'Basketball',
      'Chopping Board',
    ]);
    expect(shortComponentNames(['Planner', 'Plant pot'])).toEqual(['Planner', 'Plant pot']);
  });

  it('drops only a prefix that ends at a separator, never a shared word: two sizes keep their item name', () => {
    // Local walk 2026-09-27: a kit of both polo sizes read "2 items: (M), (L)"
    // and, when one ran out, "Out of stock: (L)".
    expect(
      shortComponentNames(['L4L - New Hire - Polo (M)', 'L4L - New Hire - Polo (L)']),
    ).toEqual(['Polo (M)', 'Polo (L)']);
    expect(shortComponentNames(['Polo Shirt (M)', 'Polo Shirt (L)'])).toEqual([
      'Polo Shirt (M)',
      'Polo Shirt (L)',
    ]);
  });

  it('keeps the whole names when one would be left empty, and a single name as it is', () => {
    expect(shortComponentNames(['Mug', 'Mug - Large'])).toEqual(['Mug', 'Mug - Large']);
    expect(shortComponentNames(['L4L - New Hire - Backpack'])).toEqual(['L4L - New Hire - Backpack']);
  });
});
