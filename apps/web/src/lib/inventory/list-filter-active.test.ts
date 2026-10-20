import { describe, expect, it } from 'vitest';

import {
  itemsTypeNarrowing,
  listFilterActive,
  otherWarehouseHintApplies,
  type ListFilterParams,
} from './list-filter-active';

/**
 * The Items, Books and Rentals items pages pick their empty state with this
 * (grouping walk 2026-10-20, W4 no-match): a list a filter leaves empty is the
 * table's own no-match state, with the filter bar; "No ... yet" only for a list
 * with nothing in it and no filter at all. Each part is read as the derivation
 * reads it, so what counts as a filter is exactly what narrows the list.
 */
describe('listFilterActive: what narrows a list', () => {
  it.each<[string, ListFilterParams]>([
    ['a search', { q: 'Grade 2' }],
    ['a search padded with spaces', { q: '  tee  ' }],
    ['a search of stripped characters (still a live filter, as in list())', { q: '%%%' }],
    ['a Category', { cat: '5eed0000-0007-4000-8000-000000000001' }],
    ['two Categories', { cat: ['c1', 'c2'] }],
    ['a Location', { loc: 'loc-1' }],
    ['a Charter', { charter: 'generic' }],
    ['a rack', { rack: '1-A' }],
    ['Low + critical', { stock: 'low' }],
    ['Out of stock', { stock: 'out' }],
    ['the Expected chip', { expected: '1' }],
    ['Auto-archived only', { auto: '1' }],
    [
      'Auto-archived only on Active (it leaves nothing, as list() does)',
      { auto: '1', status: 'active' },
    ],
    ['the Discontinued view', { status: 'discontinued' }],
    ['a Category on the Archived view', { status: 'archived', cat: 'c1' }],
    ['a search with a sort and a page', { q: 'x', sort: 'name_asc', page: '2' }],
  ])('%s narrows it', (_label, params) => {
    expect(listFilterActive(params)).toBe(true);
  });

  it.each<[string, ListFilterParams]>([
    ['no address at all', {}],
    ['the Active view', { status: 'active' }],
    ['All', { status: 'all' }],
    ['the Archived view (a list of its own, with its own empty state)', { status: 'archived' }],
    ['a sort', { sort: 'name_asc' }],
    ['a page', { page: '3' }],
    ['an all-whitespace search (list() applies none)', { q: '   ' }],
    ['an all-whitespace rack (list() applies none)', { rack: '  ' }],
    ['an unknown stock value', { stock: 'all' }],
    ['?expected=0', { expected: '0' }],
    ['?auto=0', { auto: '0' }],
    ['empty Category values', { cat: ['', ''] }],
  ])('%s does not', (_label, params) => {
    expect(listFilterActive(params)).toBe(false);
  });
});

/**
 * Review of batch D (2026-10-20): the Items list's ?type= narrows it to another
 * item type, which a saved view keeps and re-applies; with no record of that
 * type the page offered to add a first item, with no filter bar. Products (the
 * default) and every type (?type=all, the dashboard's low-stock links) do not
 * narrow.
 */
describe("itemsTypeNarrowing: the Items list's item type", () => {
  it.each([
    ['asset', 'Asset'],
    ['consumable', 'Consumable'],
    ['book', 'Book'],
  ])('?type=%s narrows it, named "%s"', (type, label) => {
    expect(itemsTypeNarrowing(type)).toBe(label);
  });

  it.each([['product'], ['all'], [''], ['rental'], [null], [undefined]])(
    '?type=%s does not',
    (type) => {
      expect(itemsTypeNarrowing(type)).toBeNull();
    },
  );
});

/**
 * The "Nothing here in <warehouse>" hint counts, in the other warehouses, the
 * active records of the list's type that match the search alone. The page asks
 * for that count only where the hint can answer (review of batch D, 2026-10-20).
 */
describe('otherWarehouseHintApplies: where the count elsewhere answers the view', () => {
  it.each<[string, ListFilterParams & { type?: string }]>([
    ['no address', {}],
    ['a search', { q: 'lanyard' }],
    ['a search on All', { q: 'lanyard', status: 'all' }],
    ['a search with a sort and a page', { q: 'lanyard', sort: 'name_asc', page: '2' }],
    ['the Active view', { status: 'active' }],
    ['every type (?type=all) or products', { type: 'all', q: 'x' }],
  ])('Items, %s: yes', (_l, params) => {
    expect(otherWarehouseHintApplies(params, 'items')).toBe(true);
  });

  it.each<[string, ListFilterParams & { type?: string }]>([
    ['a Category', { cat: 'c1' }],
    ['a search and a Location', { q: 'x', loc: 'l1' }],
    ['a stock view', { stock: 'low' }],
    ['the Expected chip', { expected: '1' }],
    ['a rack', { rack: '1-A' }],
    ['the Archived view (the count is of active records)', { status: 'archived' }],
    ['a search on the Archived view', { status: 'archived', q: 'x' }],
    ['Auto-archived only', { status: 'archived', auto: '1' }],
    ['the Discontinued view', { status: 'discontinued' }],
    ['an Asset type (the count is of products)', { type: 'asset' }],
  ])('Items, %s: no', (_l, params) => {
    expect(otherWarehouseHintApplies(params, 'items')).toBe(false);
  });

  it('Books read no type: the search alone answers, a Category does not', () => {
    expect(otherWarehouseHintApplies({ q: 'x', type: 'asset' }, 'books')).toBe(true);
    expect(otherWarehouseHintApplies({ q: 'x', cat: 'c1' }, 'books')).toBe(false);
    expect(otherWarehouseHintApplies({ status: 'archived' }, 'books')).toBe(false);
  });
});
