import { describe, it, expect } from 'vitest';

import { cartReducer, initialCartState } from './cart-context';

describe('cartReducer', () => {
  const seed = initialCartState({
    warehouseId: 'wh-1',
    fulfillmentType: 'pickup',
  });

  it('add appends a new line at quantity 1 by default', () => {
    const next = cartReducer(seed, { type: 'add', itemId: 'i-1' });
    expect(next.lines).toEqual([{ itemId: 'i-1', quantity: 1 }]);
  });

  it('add on an existing item increments instead of duplicating', () => {
    let s = cartReducer(seed, { type: 'add', itemId: 'i-1' });
    s = cartReducer(s, { type: 'add', itemId: 'i-1', quantity: 2 });
    expect(s.lines).toEqual([{ itemId: 'i-1', quantity: 3 }]);
  });

  it('inc and dec adjust quantity; dec at 1 removes the line', () => {
    let s = cartReducer(seed, { type: 'add', itemId: 'i-1' });
    s = cartReducer(s, { type: 'inc', itemId: 'i-1' });
    expect(s.lines[0]!.quantity).toBe(2);
    s = cartReducer(s, { type: 'dec', itemId: 'i-1' });
    s = cartReducer(s, { type: 'dec', itemId: 'i-1' });
    expect(s.lines).toEqual([]);
  });

  it('remove drops the line regardless of quantity', () => {
    let s = cartReducer(seed, { type: 'add', itemId: 'i-1', quantity: 7 });
    s = cartReducer(s, { type: 'remove', itemId: 'i-1' });
    expect(s.lines).toEqual([]);
  });

  it('clear empties lines but keeps setup', () => {
    let s = cartReducer(seed, { type: 'add', itemId: 'i-1' });
    s = cartReducer(s, { type: 'set-notes', value: 'rush' });
    const cleared = cartReducer(s, { type: 'clear' });
    expect(cleared.lines).toEqual([]);
    expect(cleared.notes).toBe('rush');
    expect(cleared.warehouseId).toBe('wh-1');
  });

  it('set-warehouse changes the id and clears lines', () => {
    let s = cartReducer(seed, { type: 'add', itemId: 'i-1' });
    s = cartReducer(s, { type: 'set-warehouse', warehouseId: 'wh-2' });
    expect(s.warehouseId).toBe('wh-2');
    expect(s.lines).toEqual([]);
  });

  it('set-setup patches only specified keys', () => {
    const s = cartReducer(seed, {
      type: 'set-setup',
      patch: { charterId: 'c-1' },
    });
    expect(s.charterId).toBe('c-1');
    expect(s.fulfillmentType).toBe('pickup');
  });

  it('hydrate replaces state wholesale', () => {
    const restored = cartReducer(seed, {
      type: 'hydrate',
      state: {
        ...seed,
        notes: 'from storage',
        lines: [{ itemId: 'i-9', quantity: 4 }],
      },
    });
    expect(restored.notes).toBe('from storage');
    expect(restored.lines[0]!.itemId).toBe('i-9');
  });
});
