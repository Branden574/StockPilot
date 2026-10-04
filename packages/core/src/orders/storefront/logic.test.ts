/**
 * The storefront's catalog logic (orders/storefront/logic.ts), moved from
 * apps/web/src/components/orders/storefront/storefront-logic.ts for phone
 * ordering PO-1. These suites are the web file's catalog suites run against
 * core directly; the web's own file still runs unchanged through its re-export
 * shim. Only the item factory differs: core's StorefrontItem has no `price`,
 * `imageUrl`, `lqip`, `warehouseId` or `itemType`. The tests added for PO-1
 * (the long availability form, the prepared catalog) are at the end.
 */
import { describe, expect, it } from 'vitest';

import { cartTotals } from '../cart-totals';

import type { StorefrontItem } from './item';
import {
  availabilityLabel,
  availableOf,
  buildQtyMap,
  clampQty,
  filterCatalog,
  filterPreparedCatalog,
  glyphFor,
  isBrowsingAll,
  prepareCatalog,
  successRefLine,
  sortCatalog,
  statusOf,
  type CatalogFilterInput,
  type StorefrontItemStatus as ItemStatus,
} from './logic';

let seq = 0;
function makeItem(overrides: Partial<StorefrontItem> = {}): StorefrontItem {
  seq += 1;
  return {
    id: overrides.id ?? `item-${seq}`,
    sku: `SKU-${seq}`,
    name: `Item ${seq}`,
    quantityOnHand: 10,
    reservedQuantity: 0,
    categoryId: null,
    categoryName: null,
    charterId: null,
    charterName: null,
    charterCode: null,
    rackLabel: null,
    reorderPoint: 0,
    ...overrides,
  };
}

describe('availableOf / statusOf', () => {
  it('subtracts reserved from on-hand and floors at 0', () => {
    expect(availableOf(makeItem({ quantityOnHand: 10, reservedQuantity: 3 }))).toBe(7);
    expect(availableOf(makeItem({ quantityOnHand: 2, reservedQuantity: 5 }))).toBe(0);
  });

  it('is ok when available exceeds the reorder point', () => {
    const it_ = makeItem({ quantityOnHand: 20, reservedQuantity: 0, reorderPoint: 5 });
    expect(statusOf(it_)).toBe('ok');
  });

  it('is low when available is at or below the reorder point (nonzero avail)', () => {
    expect(
      statusOf(makeItem({ quantityOnHand: 5, reservedQuantity: 0, reorderPoint: 5 })),
    ).toBe('low');
    expect(
      statusOf(makeItem({ quantityOnHand: 3, reservedQuantity: 0, reorderPoint: 5 })),
    ).toBe('low');
  });

  it('is out when nothing is available — including via reservations', () => {
    expect(statusOf(makeItem({ quantityOnHand: 0, reservedQuantity: 0 }))).toBe('out');
    // 4 on hand but all 4 reserved → out, not ok
    expect(
      statusOf(makeItem({ quantityOnHand: 4, reservedQuantity: 4, reorderPoint: 2 })),
    ).toBe('out');
  });

  it('reservations can flip ok → low', () => {
    // 10 on hand, reorder point 5: ok. Reserve 6 → 4 available → low.
    expect(
      statusOf(makeItem({ quantityOnHand: 10, reservedQuantity: 6, reorderPoint: 5 })),
    ).toBe('low');
  });

  it('a zero reorder point never reports low', () => {
    expect(
      statusOf(makeItem({ quantityOnHand: 1, reservedQuantity: 0, reorderPoint: 0 })),
    ).toBe('ok');
  });

  it('availabilityLabel matches the spec copy', () => {
    expect(availabilityLabel('ok', 107)).toBe('107 avail');
    expect(availabilityLabel('low', 8)).toBe('Low · 8 left');
    expect(availabilityLabel('out', 0)).toBe('Out of stock');
  });
});

describe('filterCatalog', () => {
  const planner = makeItem({
    id: 'planner',
    name: 'L4L Weekly Planner',
    sku: 'PLN-001',
    categoryId: 'cat-office',
    categoryName: 'Office',
    quantityOnHand: 50,
  });
  const poloW = makeItem({
    id: 'polo-w',
    name: "L4L Polo (Women's)",
    sku: 'POL-W',
    categoryId: 'cat-apparel',
    categoryName: 'Apparel',
    quantityOnHand: 3,
    reorderPoint: 5,
  });
  const mug = makeItem({
    id: 'mug',
    name: 'Camp Mug',
    sku: 'MUG-11',
    categoryId: 'cat-office',
    categoryName: 'Office',
    quantityOnHand: 0,
  });
  const loose = makeItem({
    id: 'loose',
    name: 'Loose Item',
    sku: 'LOOSE-1',
    categoryId: null,
    categoryName: null,
  });
  const all = [planner, poloW, mug, loose];
  const none = new Set<ItemStatus>();

  it('passes everything through with no filters', () => {
    expect(
      filterCatalog(all, { category: 'all', search: '', availability: none }),
    ).toHaveLength(4);
  });

  it('filters by category id and by the uncategorized bucket', () => {
    const office = filterCatalog(all, {
      category: 'cat-office',
      search: '',
      availability: none,
    });
    expect(office.map((i) => i.id)).toEqual(['planner', 'mug']);

    const uncat = filterCatalog(all, {
      category: 'uncategorized',
      search: '',
      availability: none,
    });
    expect(uncat.map((i) => i.id)).toEqual(['loose']);
  });

  it('searches across name, SKU, and category (case-insensitive)', () => {
    const byName = filterCatalog(all, {
      category: 'all',
      search: 'planner',
      availability: none,
    });
    expect(byName.map((i) => i.id)).toEqual(['planner']);

    const bySku = filterCatalog(all, {
      category: 'all',
      search: 'pol-w',
      availability: none,
    });
    expect(bySku.map((i) => i.id)).toEqual(['polo-w']);

    const byCategory = filterCatalog(all, {
      category: 'all',
      search: 'apparel',
      availability: none,
    });
    expect(byCategory.map((i) => i.id)).toEqual(['polo-w']);
  });

  it('requires every search token to match', () => {
    const hit = filterCatalog(all, {
      category: 'all',
      search: 'polo women',
      availability: none,
    });
    expect(hit.map((i) => i.id)).toEqual(['polo-w']);

    const miss = filterCatalog(all, {
      category: 'all',
      search: 'polo planner',
      availability: none,
    });
    expect(miss).toHaveLength(0);
  });

  it('filters by availability status set', () => {
    const outOnly = filterCatalog(all, {
      category: 'all',
      search: '',
      availability: new Set<ItemStatus>(['out']),
    });
    expect(outOnly.map((i) => i.id)).toEqual(['mug']);

    const lowOrOut = filterCatalog(all, {
      category: 'all',
      search: '',
      availability: new Set<ItemStatus>(['low', 'out']),
    });
    expect(lowOrOut.map((i) => i.id)).toEqual(['polo-w', 'mug']);
  });

  it('composes category + search + availability', () => {
    const composed = filterCatalog(all, {
      category: 'cat-office',
      search: 'mug',
      availability: new Set<ItemStatus>(['out']),
    });
    expect(composed.map((i) => i.id)).toEqual(['mug']);

    // Same search but availability excludes it → empty
    const excluded = filterCatalog(all, {
      category: 'cat-office',
      search: 'mug',
      availability: new Set<ItemStatus>(['ok']),
    });
    expect(excluded).toHaveLength(0);
  });

  it('does not mutate the input array', () => {
    const before = all.slice();
    filterCatalog(all, { category: 'all', search: 'x', availability: none });
    expect(all).toEqual(before);
  });
});

describe('sortCatalog', () => {
  const a = makeItem({ id: 'a', name: 'Backpack', quantityOnHand: 5 });
  const b = makeItem({ id: 'b', name: 'Apron', quantityOnHand: 20, reservedQuantity: 2 });
  const c = makeItem({ id: 'c', name: 'Towel', quantityOnHand: 1 });
  const list = [a, b, c];

  it('featured keeps catalog order', () => {
    expect(sortCatalog(list, 'featured').map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('name-asc / name-desc sort alphabetically', () => {
    expect(sortCatalog(list, 'name-asc').map((i) => i.name)).toEqual([
      'Apron',
      'Backpack',
      'Towel',
    ]);
    expect(sortCatalog(list, 'name-desc').map((i) => i.name)).toEqual([
      'Towel',
      'Backpack',
      'Apron',
    ]);
  });

  it('stock-desc / stock-asc sort by AVAILABLE (reserved subtracted)', () => {
    // b has 20 on hand but 2 reserved → 18 available; still the most.
    expect(sortCatalog(list, 'stock-desc').map((i) => i.id)).toEqual(['b', 'a', 'c']);
    expect(sortCatalog(list, 'stock-asc').map((i) => i.id)).toEqual(['c', 'a', 'b']);
  });

  it('freq ranks by the frequency map, unordered items sink, ties stay stable', () => {
    const freq = new Map([
      ['c', 9],
      ['a', 2],
    ]);
    expect(sortCatalog(list, 'freq', freq).map((i) => i.id)).toEqual(['c', 'a', 'b']);
    // No map at all → order unchanged (all zero, stable sort)
    expect(sortCatalog(list, 'freq').map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate the input array', () => {
    const before = list.slice();
    sortCatalog(list, 'name-desc');
    expect(list).toEqual(before);
  });
});

describe('cartTotals / buildQtyMap', () => {
  it('sums line count and unit count', () => {
    const lines = [
      { itemId: 'a', quantity: 3 },
      { itemId: 'b', quantity: 4 },
    ];
    expect(cartTotals(lines)).toEqual({ lineCount: 2, unitCount: 7 });
    expect(cartTotals([])).toEqual({ lineCount: 0, unitCount: 0 });
  });

  it('buildQtyMap maps itemId → qty', () => {
    const map = buildQtyMap([
      { itemId: 'a', quantity: 3 },
      { itemId: 'b', quantity: 1 },
    ]);
    expect(map.get('a')).toBe(3);
    expect(map.get('b')).toBe(1);
    expect(map.get('zzz')).toBeUndefined();
  });
});

describe('clampQty', () => {
  it('floors fractional input and clamps to [0, available]', () => {
    expect(clampQty(5.7, 10)).toBe(5);
    expect(clampQty(99, 10)).toBe(10);
    expect(clampQty(-2, 10)).toBe(0);
    expect(clampQty(0, 10)).toBe(0);
    expect(clampQty(10, 10)).toBe(10);
  });

  it('treats non-finite input as 0 and tolerates non-positive available', () => {
    expect(clampQty(Number.NaN, 10)).toBe(0);
    expect(clampQty(Number.POSITIVE_INFINITY, 10)).toBe(0);
    expect(clampQty(3, 0)).toBe(0);
    expect(clampQty(3, -4)).toBe(0);
  });
});

describe('misc helpers', () => {
  it('glyphFor strips the L4L prefix and takes two initials', () => {
    expect(glyphFor('L4L Water Bottle')).toBe('WB');
    expect(glyphFor('Planner')).toBe('P');
  });

  it('isBrowsingAll only when no category/search/availability filter', () => {
    const none = new Set<ItemStatus>();
    expect(isBrowsingAll({ category: 'all', search: '', availability: none })).toBe(true);
    expect(isBrowsingAll({ category: 'all', search: '  ', availability: none })).toBe(true);
    expect(isBrowsingAll({ category: 'c1', search: '', availability: none })).toBe(false);
    expect(isBrowsingAll({ category: 'all', search: 'x', availability: none })).toBe(false);
    expect(
      isBrowsingAll({
        category: 'all',
        search: '',
        availability: new Set<ItemStatus>(['ok']),
      }),
    ).toBe(false);
  });
});

describe('successRefLine', () => {
  it('leaves out a warehouse with no name, never "SO-000049 ·  · 7 units" (phone desk check F6.4)', () => {
    expect(successRefLine(49, 'b3f1c2d4-0000-0000-0000-000000000000', '', 7)).toBe('SO-000049 · 7 units');
    expect(successRefLine(49, 'b3f1c2d4-0000-0000-0000-000000000000', '   ', 1)).toBe('SO-000049 · 1 unit');
  });

  it('prints the CANONICAL order number, zero-padded, exactly as every other surface does', () => {
    expect(successRefLine(49, 'b3f1c2d4-0000-0000-0000-000000000000', 'DC4', 7)).toBe(
      'SO-000049 · DC4 · 7 units',
    );
  });

  it('singularizes one unit', () => {
    expect(successRefLine(49, 'b3f1c2d4-0000-0000-0000-000000000000', 'DC4', 1)).toBe(
      'SO-000049 · DC4 · 1 unit',
    );
  });

  it('NEVER fabricates an SO- handle from the uuid when the number is missing', () => {
    // The old orderRef() produced "SO-B3F1C2D4", which looks canonical and is
    // not. When the number is genuinely unavailable we fall back to a handle
    // that is visibly NOT an SO number, so nobody searches for it.
    const line = successRefLine(null, 'b3f1c2d4-0000-0000-0000-000000000000', 'DC4', 7);
    expect(line).toBe('Order b3f1c2d4 · DC4 · 7 units');
    expect(line).not.toContain('SO-');
  });

  it('treats 0 as missing — order_number is a 1-based sequence', () => {
    expect(successRefLine(0, 'b3f1c2d4-0000-0000-0000-000000000000', 'DC4', 2)).toBe(
      'Order b3f1c2d4 · DC4 · 2 units',
    );
  });

  it('pads a large number without truncating it', () => {
    expect(successRefLine(1234567, 'b3f1c2d4-0000-0000-0000-000000000000', 'DC4', 1)).toBe(
      'SO-1234567 · DC4 · 1 unit',
    );
  });
});

describe('the fabricated order handle is gone', () => {
  it('logic.ts does not export orderRef', async () => {
    const mod = await import('./logic');
    expect('orderRef' in mod).toBe(false);
  });
});

// ── Added for PO-1 ──────────────────────────────────────────────────────────

describe('availabilityLabel: the long form (the phone)', () => {
  it('says the whole word for an in-stock row', () => {
    expect(availabilityLabel('ok', 134, 'long')).toBe('134 available');
    expect(availabilityLabel('ok', 1, 'long')).toBe('1 available');
  });

  it('keeps the low and out words, which already read in full', () => {
    expect(availabilityLabel('low', 8, 'long')).toBe('Low · 8 left');
    expect(availabilityLabel('out', 0, 'long')).toBe('Out of stock');
  });

  it("the default is still the web card's short form", () => {
    expect(availabilityLabel('ok', 134)).toBe('134 avail');
    expect(availabilityLabel('ok', 134, 'short')).toBe('134 avail');
  });
});

describe('prepareCatalog / filterPreparedCatalog: the same rows as filterCatalog', () => {
  const rows = [
    makeItem({
      id: 'planner',
      name: 'L4L Weekly Planner',
      sku: 'PLN-001',
      categoryId: 'cat-office',
      categoryName: 'Office',
      quantityOnHand: 50,
    }),
    makeItem({
      id: 'polo-w',
      name: "L4L Polo (Women's)",
      sku: 'POL-W',
      categoryId: 'cat-apparel',
      categoryName: 'Apparel',
      quantityOnHand: 3,
      reorderPoint: 5,
    }),
    makeItem({
      id: 'mug',
      name: 'Camp Mug',
      sku: 'MUG-11',
      categoryId: 'cat-office',
      categoryName: 'Office',
      quantityOnHand: 0,
    }),
    makeItem({ id: 'loose', name: 'Loose Item', sku: 'LOOSE-1' }),
    makeItem({
      id: 'held',
      name: 'Held Backpack',
      sku: 'BAG-2',
      categoryId: 'cat-apparel',
      categoryName: 'Apparel',
      quantityOnHand: 4,
      reservedQuantity: 4,
    }),
    makeItem({
      id: 'polo-m',
      name: 'L4L Polo (Men)',
      sku: 'POL-M',
      categoryId: 'cat-apparel',
      categoryName: 'Apparel',
      quantityOnHand: 40,
    }),
  ];
  const prepared = prepareCatalog(rows);
  const statuses: Array<ReadonlySet<ItemStatus>> = [
    new Set(),
    new Set<ItemStatus>(['ok']),
    new Set<ItemStatus>(['low']),
    new Set<ItemStatus>(['out']),
    new Set<ItemStatus>(['ok', 'low']),
    new Set<ItemStatus>(['low', 'out']),
  ];
  const categories = ['all', 'uncategorized', 'cat-office', 'cat-apparel', 'cat-none'];
  const searches = [
    '',
    '  ',
    'polo',
    'POLO w',
    'pol-',
    'office',
    'apparel bag',
    'zzz',
    ' l4l   polo ',
  ];

  it('agrees with filterCatalog on every combination of category, search and availability', () => {
    let checked = 0;
    for (const category of categories) {
      for (const search of searches) {
        for (const availability of statuses) {
          const input: CatalogFilterInput = { category, search, availability };
          expect(
            filterPreparedCatalog(prepared, input).map((r) => r.id),
            JSON.stringify({ category, search, a: [...availability] }),
          ).toEqual(filterCatalog(rows, input).map((r) => r.id));
          checked += 1;
        }
      }
    }
    expect(checked).toBe(categories.length * searches.length * statuses.length);
  });

  it('hands back the same row objects, in catalog order', () => {
    const none = new Set<ItemStatus>();
    const out = filterPreparedCatalog(prepared, {
      category: 'all',
      search: 'polo',
      availability: none,
    });
    expect(out).toEqual([rows[1], rows[5]]);
    expect(out[0]).toBe(rows[1]);
  });

  it('works out each status once, from the same rule', () => {
    expect(prepared.statuses).toEqual(rows.map((r) => statusOf(r)));
    expect(prepared.haystacks[3]).toBe('loose item loose-1 ');
  });
});
