import { describe, expect, it } from 'vitest';

import { buildRentalItemRows, rentalItemsEyebrow } from './rental-items';

describe('buildRentalItemRows', () => {
  it('available = on hand minus every open reservation for that item', () => {
    const rows = buildRentalItemRows(
      [
        { id: 'table', name: '6 foot table', sku: 'T-1', quantity_on_hand: 10 },
        { id: 'audio', name: 'Audiometer', sku: null, quantity_on_hand: '2' },
      ],
      [
        { item_id: 'table', quantity: 3 },
        { item_id: 'table', quantity: 2 },
        { item_id: 'audio', quantity: '1' },
      ],
    );
    expect(rows).toEqual([
      { id: 'table', name: '6 foot table', sku: 'T-1', onHand: 10, reserved: 5, available: 5, overReserved: false },
      { id: 'audio', name: 'Audiometer', sku: null, onHand: 2, reserved: 1, available: 1, overReserved: false },
    ]);
  });

  it('an item nobody has borrowed is fully available', () => {
    const [row] = buildRentalItemRows([{ id: 'a', name: 'Canopy', sku: 'C', quantity_on_hand: 4 }], []);
    expect(row).toMatchObject({ onHand: 4, reserved: 0, available: 4, overReserved: false });
  });

  it('never shows a negative availability, and flags the broken promise instead', () => {
    const [row] = buildRentalItemRows(
      [{ id: 'a', name: 'Canopy', sku: 'C', quantity_on_hand: 1 }],
      [{ item_id: 'a', quantity: 3 }],
    );
    expect(row).toMatchObject({ available: 0, overReserved: true });
  });

  it('ignores reservations for items not on the list, and unreadable quantities', () => {
    const [row] = buildRentalItemRows(
      [{ id: 'a', name: 'Canopy', sku: 'C', quantity_on_hand: 5 }],
      [
        { item_id: 'someone-else', quantity: 5 },
        { item_id: 'a', quantity: null },
        { item_id: 'a', quantity: 'not a number' },
        { item_id: 'a', quantity: 1 },
      ],
    );
    // null reads as 0 (Number(null)), a non-number is skipped, never NaN.
    expect(row).toMatchObject({ reserved: 1, available: 4 });
  });

  it('keeps the fetched order (the query sorts it, like web)', () => {
    const rows = buildRentalItemRows(
      [
        { id: 'b', name: 'B', sku: null, quantity_on_hand: 1 },
        { id: 'a', name: 'A', sku: null, quantity_on_hand: 1 },
      ],
      [],
    );
    expect(rows.map((r) => r.id)).toEqual(['b', 'a']);
  });
});

describe('rentalItemsEyebrow', () => {
  it('counts the items', () => {
    expect(rentalItemsEyebrow(2, 2)).toBe('RENTALS · 2 ITEMS');
    expect(rentalItemsEyebrow(1, 1)).toBe('RENTALS · 1 ITEM');
    expect(rentalItemsEyebrow(0, 0)).toBe('RENTALS · 0 ITEMS');
  });

  it('says when the list is only the first part of the fleet', () => {
    expect(rentalItemsEyebrow(200, 240)).toBe('RENTALS · SHOWING 200 OF 240 ITEMS');
  });

  it('falls back to what it has when the count is unknown', () => {
    expect(rentalItemsEyebrow(3, null)).toBe('RENTALS · 3 ITEMS');
  });
});
