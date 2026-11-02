import { describe, expect, it } from 'vitest';

import { instantStateFromPageParams } from './instant-mode';
import { listEmptyMessage, type ListEmptyKind } from './list-empty-message';
import type { ListFilterParams } from './list-filter-active';

/**
 * The Items, Books and Rentals items pages' own empty messages, kept word for
 * word (integrator decision 1, 2026-10-20): since batch D the table answers
 * every filtered empty view, with the filter bar on screen, and these are its
 * words when one narrowing left nothing. The words are the pages' as of
 * 378765ba7 (inventory/page.tsx, books/page.tsx, rentals/items/page.tsx).
 */

const state = (params: ListFilterParams) => instantStateFromPageParams(params);
const message = (kind: ListEmptyKind, params: ListFilterParams) =>
  listEmptyMessage(kind, state(params));

describe('listEmptyMessage: each list keeps its own words', () => {
  it.each<[string, ListFilterParams, string, string, string]>([
    [
      'the Expected chip',
      { expected: '1' },
      'No expected items',
      'Items created from purchase orders appear here until their first stock is received.',
      'Back to all items',
    ],
    [
      'Low + critical',
      { stock: 'low' },
      'No low-stock items',
      'Nothing is at or below its reorder point right now. Nice.',
      'Show all items',
    ],
    [
      'Out of stock',
      { stock: 'out' },
      'Nothing is out of stock',
      'No active items have a quantity of zero. Clear the filter to see all items.',
      'Show all items',
    ],
    [
      'a search',
      { q: 'zzqqxx' },
      'No items match your search',
      'Nothing matched "zzqqxx". Try a different SKU, name, or barcode.',
      'Clear search',
    ],
  ])('Items, %s', (_l, params, title, description, label) => {
    expect(message('items', params)).toEqual({
      title,
      description,
      cta: { label, href: '/dashboard/inventory' },
    });
  });

  it.each<[string, ListFilterParams, string, string, string]>([
    [
      'the Expected chip',
      { expected: '1' },
      'No expected books',
      'Books created from purchase orders appear here until their first stock is received.',
      'Back to all books',
    ],
    [
      'Low + critical',
      { stock: 'low' },
      'No low-stock books',
      'No books are at or below their reorder point right now. Clear the filter to see all books.',
      'Show all books',
    ],
    [
      'Out of stock',
      { stock: 'out' },
      'No out-of-stock books',
      'Nothing is at zero quantity right now. Clear the filter to see all books.',
      'Show all books',
    ],
  ])('Books, %s', (_l, params, title, description, label) => {
    expect(message('books', params)).toEqual({
      title,
      description,
      cta: { label, href: '/dashboard/books' },
    });
  });

  it('Books never had a search message: a search alone is the general line', () => {
    expect(message('books', { q: 'zzqqxx' })).toBeNull();
  });

  it('Rentals items, a search', () => {
    expect(message('rentals', { q: 'zzqqxx' })).toEqual({
      title: 'No rental items match your search',
      description: 'Nothing matched "zzqqxx". Try a different name or SKU.',
      cta: { label: 'Clear search', href: '/dashboard/rentals/items' },
    });
  });

  it('Rentals items had no stock or Expected message: the general line', () => {
    expect(message('rentals', { stock: 'low' })).toBeNull();
    expect(message('rentals', { stock: 'out' })).toBeNull();
    expect(message('rentals', { expected: '1' })).toBeNull();
  });
});

describe('listEmptyMessage: only when that narrowing is the only one', () => {
  it.each<[string, ListFilterParams]>([
    ['a Category alone (it never had a message)', { cat: 'c1' }],
    ['a Location alone', { loc: 'l1' }],
    ['a Charter alone', { charter: 'generic' }],
    ['a rack alone', { rack: '1-A' }],
    ['Auto-archived only alone', { status: 'archived', auto: '1' }],
    ['the Discontinued view alone', { status: 'discontinued' }],
    ['nothing at all', {}],
    ['a search and a Category', { q: 'zz', cat: 'c1' }],
    ['a search and a stock view', { q: 'zz', stock: 'low' }],
    ['a stock view and a Location', { stock: 'out', loc: 'l1' }],
    ['the Expected chip and a search', { expected: '1', q: 'zz' }],
    ['the Expected chip and a rack', { expected: '1', rack: '1-A' }],
    ['a search on the Auto-archived only view', { q: 'zz', status: 'archived', auto: '1' }],
  ])('Items, %s: the general line', (_l, params) => {
    expect(message('items', params)).toBeNull();
  });

  it.each<[string, ListFilterParams, string]>([
    [
      'a search on the Archived view',
      { q: 'zz', status: 'archived' },
      'No items match your search',
    ],
    [
      'a search on the Discontinued view',
      { q: 'zz', status: 'discontinued' },
      'No items match your search',
    ],
    ['Low + critical on All', { stock: 'low', status: 'all' }, 'No low-stock items'],
    [
      'the Expected chip on the Archived view',
      { expected: '1', status: 'archived' },
      'No expected items',
    ],
    [
      'a search with a sort and a page',
      { q: 'zz', sort: 'name_asc', page: '2' },
      'No items match your search',
    ],
  ])('Items, %s: the lifecycle view, a sort or a page is the list itself', (_l, params, title) => {
    expect(message('items', params)?.title).toBe(title);
  });

  it('Rentals items count only what their list applies (no charter, rack, Expected or Auto-archived only)', () => {
    for (const params of [
      { q: 'zz', charter: 'generic' },
      { q: 'zz', rack: '1-A' },
      { q: 'zz', expected: '1' },
      { q: 'zz', status: 'archived', auto: '1' },
    ]) {
      expect(message('rentals', params)?.title).toBe('No rental items match your search');
    }
    expect(message('rentals', { q: 'zz', cat: 'c1' })).toBeNull();
    expect(message('rentals', { q: 'zz', stock: 'low' })).toBeNull();
  });

  it('a search counts as list() counts it: an all-whitespace one is none, a stripped one is one', () => {
    expect(message('items', { q: '   ' })).toBeNull();
    expect(message('items', { q: '   ', stock: 'low' })?.title).toBe('No low-stock items');
    expect(message('items', { q: '%%%' })?.description).toBe(
      'Nothing matched "%%%". Try a different SKU, name, or barcode.',
    );
  });

  it('quotes the search trimmed, at most 40 characters', () => {
    const long = `  ${'x'.repeat(50)}  `;
    expect(message('items', { q: long })?.description).toBe(
      `Nothing matched "${'x'.repeat(40)}". Try a different SKU, name, or barcode.`,
    );
    expect(message('rentals', { q: ' tent ' })?.description).toBe(
      'Nothing matched "tent". Try a different name or SKU.',
    );
  });
});
