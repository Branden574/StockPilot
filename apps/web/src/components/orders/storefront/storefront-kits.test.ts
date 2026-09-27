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

  it('one kit at a time: 18-A until it has none left, then 16-B takes the 61st', () => {
    let s = empty();
    for (let n = 1; n <= 61; n += 1) s = setKits(s, n);
    expect(lineQty(s, BACKPACK_18A.id)).toBe(60);
    expect(lineQty(s, BACKPACK_16B.id)).toBe(1);
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
  it('after the 61st kit went to 16-B, going back to 60 takes it off 16-B (the fewest held first)', () => {
    let s = empty();
    s = setKits(s, 60);
    s = setKits(s, 61);
    s = setKits(s, 60);
    expect(lineQty(s, BACKPACK_18A.id)).toBe(60);
    expect(s.lines.some((l) => l.itemId === BACKPACK_16B.id)).toBe(false);
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

  it('a line lowered by hand lowers the kit count, and removing the kit never goes below zero', () => {
    let s = setKits(empty(), 3);
    s = cartReducer(s, { type: 'set-qty', itemId: MUG.id, quantity: 1 });
    expect(kitsInCart(NEW_HIRE, s.kits[NEW_HIRE.bundleId], qtyOf(s))).toBe(1);
    s = setKits(s, 0);
    expect(s.lines).toEqual([]);
  });

  it('the same items added by hand are not a kit', () => {
    let s = empty();
    for (const id of [BACKPACK_18A.id, MUG.id, PAD.id, PLANNER.id]) {
      s = cartReducer(s, { type: 'add', itemId: id });
    }
    expect(kitsInCart(NEW_HIRE, s.kits[NEW_HIRE.bundleId], qtyOf(s))).toBe(0);
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

  it('keeps the whole names when one would be left empty, and a single name as it is', () => {
    expect(shortComponentNames(['Mug', 'Mug - Large'])).toEqual(['Mug', 'Mug - Large']);
    expect(shortComponentNames(['L4L - New Hire - Backpack'])).toEqual(['L4L - New Hire - Backpack']);
  });
});
