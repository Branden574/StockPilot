import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { itemListGlyph } from './item-list-glyph';

/**
 * Owner report 2026-09-27: a Chromebook read as a book. The phone Items list
 * gave the book glyph to any category whose name CONTAINED "book".
 */
describe('itemListGlyph', () => {
  it('gives an electronics category that happens to contain "book" the generic glyph', () => {
    expect(itemListGlyph({ item_type: 'product', category_name: 'Chromebooks' })).toBe('generic');
    expect(itemListGlyph({ item_type: 'product', category_name: 'Macbook accessories' })).toBe(
      'generic',
    );
    expect(itemListGlyph({ category_name: 'Chromebook' })).toBe('generic');
    expect(itemListGlyph({ category_name: 'Notebooks' })).toBe('generic');
  });

  it('gives a real book the book glyph, whatever its category', () => {
    expect(itemListGlyph({ item_type: 'book', category_name: null })).toBe('book');
    expect(itemListGlyph({ item_type: 'book', category_name: 'Chromebooks' })).toBe('book');
    expect(itemListGlyph({ item_type: 'book', category_name: 'Supplies' })).toBe('book');
  });

  it('gives a category named for books, as a whole word, the book glyph', () => {
    expect(itemListGlyph({ item_type: 'product', category_name: 'Books' })).toBe('book');
    expect(itemListGlyph({ item_type: 'product', category_name: 'Library books' })).toBe('book');
    expect(itemListGlyph({ category_name: 'book' })).toBe('book');
  });

  it('keeps the equipment and supplies glyphs, and the generic glyph otherwise', () => {
    expect(itemListGlyph({ category_name: 'Sports Equipment' })).toBe('equipment');
    expect(itemListGlyph({ category_name: 'Office Supplies' })).toBe('supplies');
    expect(itemListGlyph({ category_name: 'Supply' })).toBe('supplies');
    expect(itemListGlyph({ category_name: 'Apparel' })).toBe('generic');
    expect(itemListGlyph({ category_name: null })).toBe('generic');
    expect(itemListGlyph({})).toBe('generic');
  });
});

describe('the Items list uses itemListGlyph', () => {
  const inventory = readFileSync(
    path.resolve(__dirname, '../../app/(drawer)/(tabs)/inventory.tsx'),
    'utf8',
  );

  it("chooses the row glyph through the helper, from the row's item type and category", () => {
    expect(inventory).toContain(
      "import { itemListGlyph, type ItemListGlyph } from '@/lib/item-list-glyph';",
    );
    expect(inventory).toMatch(/const Icon = LIST_GLYPH_ICON\[itemListGlyph\(item\)\];/);
    // The row carries its item type, read with the list.
    expect(inventory).toMatch(/const ITEM_COLUMNS = `id, name, sku, [^`]*\bitem_type\b/);
    expect(inventory).toMatch(/item_type: \(r\.item_type as string \| null\) \?\? null,/);
  });

  it('no longer matches "book" anywhere inside a category name', () => {
    expect(inventory).not.toMatch(/\.includes\(\s*['"`]book/i);
    expect(inventory).not.toMatch(/function glyphFromItem/);
  });
});
