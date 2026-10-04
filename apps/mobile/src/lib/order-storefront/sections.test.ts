import { describe, expect, it } from 'vitest';

import { prepareCatalog, type KitOffer, type StorefrontItem } from '@stockpilot/core';

import {
  EMPTY_FILTER,
  HOME_SECTION_ROWS,
  activeFilterCount,
  browseHref,
  browseTargetFromParams,
  filterActive,
  homeRows,
  matchingRows,
  phoneSortOptions,
  storefrontRowKey,
  toggleAvailability,
  type CatalogView,
  type SectionWords,
} from './sections';

function item(id: string, name: string, categoryId: string | null, onHand = 10, reorderPoint = 0): StorefrontItem {
  return {
    id,
    sku: `SKU-${id}`,
    name,
    quantityOnHand: onHand,
    reservedQuantity: 0,
    categoryId,
    categoryName: categoryId === 'c1' ? 'Paper' : categoryId === 'c2' ? 'Bags' : null,
    charterId: null,
    charterName: null,
    charterCode: null,
    rackLabel: null,
    reorderPoint,
  };
}

const ITEMS = [
  item('a', 'Planner', 'c1'),
  item('b', 'Notebook', 'c1', 2, 5),
  item('c', 'Backpack', 'c2', 0),
  item('d', 'Mug', null),
  ...Array.from({ length: 8 }, (_, i) => item(`x${i}`, `Pencil ${i}`, 'c1')),
];
const KIT: KitOffer = { bundleId: 'k1', name: 'Starter kit', sku: 'KIT-1', components: [{ anchorItemId: 'a', itemIds: ['a'], perKit: 1 }] };

function view(patch: Partial<CatalogView> = {}): CatalogView {
  return {
    prepared: prepareCatalog(ITEMS),
    itemMap: new Map(ITEMS.map((i) => [i.id, i])),
    aisles: [
      { id: 'c2', name: 'Bags', itemCount: 1 },
      { id: 'c1', name: 'Paper', itemCount: 10 },
      { id: null, name: 'Uncategorized', itemCount: 1 },
    ],
    frequent: [
      { itemId: 'b', orders: 9 },
      { itemId: 'not-mine', orders: 8 },
      { itemId: 'a', orders: 4 },
      ...Array.from({ length: 6 }, (_, i) => ({ itemId: `x${i}`, orders: 3 - i / 10 })),
    ],
    kits: [KIT],
    kitsEnabled: true,
    ...patch,
  };
}

const WORDS: SectionWords = {
  frequentTitle: 'Frequently ordered',
  frequentSubtitle: 'Ordered most here in the last 30 days',
  kitsTitle: 'Kits',
  kitsSubtitle: 'Add every item of a kit to your cart in one step',
  kitsFailed: 'Kits could not be loaded.',
  categoriesTitle: 'Browse by category',
  nothingOrderable: 'Nothing can be ordered from this warehouse right now.',
};

describe('the home rows', () => {
  it('Frequently ordered (top rows, only my catalog’s items, ranked), Kits, categories with counts, All items', () => {
    const rows = homeRows(view(), WORDS);
    const kinds = rows.map((r) => r.kind);
    expect(kinds[0]).toBe('header');
    const frequent = rows.filter((r) => r.kind === 'item');
    expect(frequent).toHaveLength(HOME_SECTION_ROWS);
    expect(frequent[0]).toMatchObject({ item: { id: 'b' }, rank: { place: 1, orders: 9 } });
    expect(frequent[1]).toMatchObject({ item: { id: 'a' }, rank: { place: 2, orders: 4 } });
    expect(rows.find((r) => r.kind === 'see-all')).toMatchObject({ target: { kind: 'frequent' }, count: 8 });
    expect(rows.find((r) => r.kind === 'kit')).toMatchObject({ kit: { bundleId: 'k1' } });
    expect(rows.filter((r) => r.kind === 'category').map((r) => (r.kind === 'category' ? r.aisle.name : ''))).toEqual([
      'Bags',
      'Paper',
      'Uncategorized',
    ]);
    expect(rows.at(-1)).toEqual({ kind: 'all-items', key: 'all-items', count: ITEMS.length });
  });

  it('a failed kits read says so (never "no kits"); Bundles off shows no kits at all', () => {
    expect(homeRows(view({ kits: null }), WORDS).some((r) => r.kind === 'note' && r.text === WORDS.kitsFailed)).toBe(true);
    expect(homeRows(view({ kitsEnabled: false }), WORDS).some((r) => r.kind === 'kit' || (r.kind === 'header' && r.title === 'Kits'))).toBe(false);
  });

  it('a failed Frequently ordered read leaves the section out', () => {
    expect(homeRows(view({ frequent: null }), WORDS).some((r) => r.kind === 'item')).toBe(false);
  });

  it('an empty catalog says nothing can be ordered', () => {
    expect(homeRows(view({ prepared: prepareCatalog([]) }), WORDS)).toEqual([
      { kind: 'note', key: 'nothing', text: WORDS.nothingOrderable },
    ]);
  });

  it('every row key is unique', () => {
    const keys = homeRows(view(), WORDS).map(storefrontRowKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('matching rows (searched on the device over EVERY row)', () => {
  it('every word must match the name, SKU or category', () => {
    const rows = matchingRows(view(), { kind: 'all' }, { ...EMPTY_FILTER, search: 'pencil 3' });
    expect(rows.map((r) => (r.kind === 'item' ? r.item.id : r.kind))).toEqual(['x3']);
    expect(matchingRows(view(), { kind: 'all' }, { ...EMPTY_FILTER, search: 'paper planner' }).filter((r) => r.kind === 'item')).toHaveLength(1);
  });

  it('a category view lists only that category, and its kits', () => {
    const rows = matchingRows(view(), { kind: 'category', category: 'c2' }, EMPTY_FILTER);
    expect(rows.filter((r) => r.kind === 'item').map((r) => (r.kind === 'item' ? r.item.id : ''))).toEqual(['c']);
    expect(matchingRows(view(), { kind: 'category', category: 'uncategorized' }, EMPTY_FILTER).filter((r) => r.kind === 'item')).toHaveLength(1);
  });

  it('the availability filter and the sort', () => {
    const out = matchingRows(view(), { kind: 'all' }, toggleAvailability(EMPTY_FILTER, 'out'));
    expect(out.filter((r) => r.kind === 'item').map((r) => (r.kind === 'item' ? r.item.id : ''))).toEqual(['c']);
    const sorted = matchingRows(view(), { kind: 'all' }, { ...EMPTY_FILTER, sort: 'stock-asc' });
    expect(sorted.find((r) => r.kind === 'item')).toMatchObject({ item: { id: 'c' } });
  });

  it('Frequently ordered keeps its rank order and its tags', () => {
    const rows = matchingRows(view(), { kind: 'frequent' }, EMPTY_FILTER).filter((r) => r.kind === 'item');
    expect(rows.slice(0, 2)).toMatchObject([{ item: { id: 'b' }, rank: { place: 1 } }, { item: { id: 'a' }, rank: { place: 2 } }]);
  });

  it('the kits view lists kits only', () => {
    expect(matchingRows(view(), { kind: 'kits' }, EMPTY_FILTER).map((r) => r.kind)).toEqual(['kit']);
  });

  it('nothing matching is one empty row', () => {
    expect(matchingRows(view(), { kind: 'all' }, { ...EMPTY_FILTER, search: 'zzz' })).toEqual([{ kind: 'empty', key: 'empty' }]);
  });
});

describe('filters and targets', () => {
  it('counts and toggles', () => {
    expect(filterActive(EMPTY_FILTER)).toBe(false);
    const f = toggleAvailability(EMPTY_FILTER, 'low');
    expect(activeFilterCount(f)).toBe(1);
    expect(activeFilterCount({ ...f, sort: 'name-desc' })).toBe(2);
    expect(toggleAvailability(f, 'low').availability.size).toBe(0);
    expect(filterActive({ ...EMPTY_FILTER, search: ' x ' })).toBe(true);
  });

  it('the phone’s sorts drop Featured, and Most ordered here when it did not load', () => {
    expect(phoneSortOptions(true).map((o) => o.id)).not.toContain('featured');
    expect(phoneSortOptions(true).map((o) => o.id)).toContain('freq');
    expect(phoneSortOptions(false).map((o) => o.id)).not.toContain('freq');
  });

  it('browse targets round-trip through the route', () => {
    for (const t of [{ kind: 'category', category: 'c1' }, { kind: 'frequent' }, { kind: 'kits' }, { kind: 'all' }] as const) {
      const href = browseHref(t);
      const query = Object.fromEntries(new URLSearchParams(href.split('?')[1]).entries());
      expect(browseTargetFromParams(query)).toEqual(t);
    }
    expect(browseTargetFromParams({})).toEqual({ kind: 'all' });
  });
});
