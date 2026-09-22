import { describe, expect, it } from 'vitest';

import {
  belongsToInventoryView,
  inventoryDefaultLifecycle,
  inventoryViewPredicate,
} from './list-visibility';

/**
 * The invariant: web and mobile cannot disagree about what an "item" is.
 *
 * Measured on production 2026-09-22 before this module existed: web listed
 * `item_type = 'product' AND is_rental = false`, mobile listed
 * `item_type <> 'book'` with no rental filter, and two rental items were on
 * mobile's Items tab and missing from web's.
 */

describe('one definition of each tab', () => {
  it('Items is products, never rentals', () => {
    expect(inventoryViewPredicate('items')).toEqual({ itemType: 'product', isRental: false });
  });

  it('Books is books, never rentals', () => {
    expect(inventoryViewPredicate('books')).toEqual({ itemType: 'book', isRental: false });
  });

  it('the default view is active, present and already received', () => {
    expect(inventoryDefaultLifecycle).toEqual({
      awaitingFirstReceipt: false,
      status: 'active',
      deletedAtIsNull: true,
    });
  });
});

describe('the rows that drifted between the two platforms', () => {
  const rentalTable = { item_type: 'product', is_rental: true };
  const product = { item_type: 'product', is_rental: false };
  const book = { item_type: 'book', is_rental: false };

  it('a rental is on NEITHER tab — mobile used to list it on Items', () => {
    expect(belongsToInventoryView(rentalTable, 'items')).toBe(false);
    expect(belongsToInventoryView(rentalTable, 'books')).toBe(false);
  });

  it('a product is on Items only, a book on Books only', () => {
    expect(belongsToInventoryView(product, 'items')).toBe(true);
    expect(belongsToInventoryView(product, 'books')).toBe(false);
    expect(belongsToInventoryView(book, 'books')).toBe(true);
    expect(belongsToInventoryView(book, 'items')).toBe(false);
  });

  it('a NEW item type lands on neither tab, on both platforms alike', () => {
    // The whole point of an exact match: mobile's old `item_type <> 'book'`
    // would have swept an 'asset' or 'consumable' onto Items while web showed
    // nothing, which is the same class of defect as the rentals.
    for (const type of ['asset', 'consumable', 'kit']) {
      expect(belongsToInventoryView({ item_type: type, is_rental: false }, 'items')).toBe(false);
      expect(belongsToInventoryView({ item_type: type, is_rental: false }, 'books')).toBe(false);
    }
  });

  it('treats a missing or null rental flag as not-a-rental, and a missing type as neither', () => {
    expect(belongsToInventoryView({ item_type: 'product', is_rental: null }, 'items')).toBe(true);
    expect(belongsToInventoryView({ item_type: 'product' }, 'items')).toBe(true);
    expect(belongsToInventoryView({ is_rental: false }, 'items')).toBe(false);
    expect(belongsToInventoryView({ item_type: null, is_rental: false }, 'items')).toBe(false);
  });
});
