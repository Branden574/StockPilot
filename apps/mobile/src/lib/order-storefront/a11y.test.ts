import { describe, expect, it } from 'vitest';

import type { KitOffer, StorefrontItem } from '@stockpilot/core';

import {
  addItemLabel,
  addedAnnouncement,
  cartBarLabel,
  decreaseKitLabel,
  decreaseLabel,
  increaseBlockedHint,
  increaseLabel,
  itemRowLabel,
  kitAnnouncement,
  kitRowLabel,
  quantityAnnouncement,
  quantityButtonLabel,
  submittedAnnouncement,
} from './a11y';

const PLANNER: StorefrontItem = {
  id: 'a',
  sku: 'PL-1',
  name: 'Planner',
  quantityOnHand: 140,
  reservedQuantity: 6,
  categoryId: null,
  categoryName: null,
  charterId: null,
  charterName: null,
  charterCode: null,
  rackLabel: null,
  reorderPoint: 0,
};

describe('what VoiceOver says', () => {
  it('a row is ONE element: name, SKU, availability in the long form, earmark, quantity in the cart', () => {
    expect(itemRowLabel(PLANNER, 0, null)).toBe('Planner, SKU PL-1, 134 available');
    expect(itemRowLabel(PLANNER, 2, 'NC')).toBe('Planner, SKU PL-1, 134 available, earmarked for NC, 2 in your cart');
    expect(itemRowLabel({ ...PLANNER, quantityOnHand: 6 }, 0, null)).toBe('Planner, SKU PL-1, Out of stock');
    expect(itemRowLabel({ ...PLANNER, reorderPoint: 200 }, 0, null)).toBe('Planner, SKU PL-1, Low · 134 left');
  });

  it('every stepper button names its item', () => {
    expect(addItemLabel('Planner')).toBe('Add Planner to your cart');
    expect(increaseLabel('Planner')).toBe('One more Planner');
    expect(decreaseLabel('Planner', 3)).toBe('One fewer Planner');
    expect(decreaseLabel('Planner', 1)).toBe('Remove Planner from your cart');
    expect(quantityButtonLabel('Planner', 3)).toBe('Planner: 3 in your cart. Change the quantity');
    expect(increaseBlockedHint(true)).toBe('All available stock is in your cart');
    expect(increaseBlockedHint(false)).toBeUndefined();
  });

  it('kits', () => {
    const kit: KitOffer = { bundleId: 'k', name: 'Starter', sku: null, components: [{ anchorItemId: 'a', itemIds: ['a'], perKit: 2 }] };
    expect(kitRowLabel(kit, new Map([['a', PLANNER]]), 0)).toBe('Starter, 67 kits available');
    expect(kitRowLabel(kit, new Map([['a', PLANNER]]), 1)).toBe('Starter, 67 kits available, 1 in your cart');
    expect(decreaseKitLabel('Starter', 1)).toBe('Take the Starter kit out of your cart');
    expect(decreaseKitLabel('Starter', 2)).toBe('One fewer Starter kit');
  });

  it('the cart bar', () => {
    expect(cartBarLabel(3, 12)).toBe('Cart, 3 items · 12 units. Check out');
  });

  it('announcements', () => {
    expect(addedAnnouncement('Planner', 1)).toBe('Added Planner. 1 in your cart.');
    expect(quantityAnnouncement('Planner', 4)).toBe('Planner: 4 in your cart.');
    expect(quantityAnnouncement('Planner', 0)).toBe('Removed Planner from your cart.');
    expect(kitAnnouncement('Starter', 2)).toBe('Starter: 2 kits in your cart.');
    expect(kitAnnouncement('Starter', 0)).toBe('Took the Starter kit out of your cart.');
    expect(submittedAnnouncement({ orderNumber: 123, orderLabel: 'SO-000123' })).toBe('Order request submitted: SO-000123.');
    expect(submittedAnnouncement({ orderNumber: 7, orderLabel: null })).toBe('Order request submitted: SO-000007.');
  });
});
