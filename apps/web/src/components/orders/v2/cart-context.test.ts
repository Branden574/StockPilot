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

// ---------------------------------------------------------------------------
// A NEW ORDER MUST NOT INHERIT THE LAST ONE'S REQUESTER — owner report
// 2026-08-19: "I placed an order for Raymond Allen and put his email in; next
// time I go to place an order his name is still saved."
//
// `case 'clear'` only ever emptied `lines`, so onBehalfOf / neededBy / charterId
// survived it — even though initialCartState's own docstring calls itself "the
// post-`clear` shape". The doc described the intent; the code did not implement
// it.
//
// This is not cosmetic. onBehalfOf is who the order is FOR: it becomes
// `requestedFor` + `requesterEmail` on the submitted order, which is who gets
// notified and who the warehouse hands the goods to. Silently carrying it into
// the next person's order sends someone else's delivery confirmation to Raymond.
// neededBy is the same shape of hazard one step further on — it drives the
// auto-created schedule event on approve, so a stale date books a delivery for
// a day nobody chose.
// ---------------------------------------------------------------------------
describe('cartReducer — reset', () => {
  const dirty = {
    warehouseId: 'wh-1',
    charterId: 'charter-9',
    fulfillmentType: 'delivery' as const,
    onBehalfOf: { name: 'Raymond Allen', email: 'rallen@example.org' },
    notes: 'leave at the front desk',
    neededBy: '2026-09-01',
    lines: [{ itemId: 'i1', quantity: 3 }],
  } as never;

  it('drops the requester, the date, the charter, the notes and the lines', () => {
    const next = cartReducer(dirty, { type: 'reset' });
    expect(next.onBehalfOf).toBeNull();
    expect(next.neededBy).toBe('');
    expect(next.notes).toBe('');
    expect(next.charterId).toBeNull();
    expect(next.lines).toEqual([]);
  });

  it('keeps the warehouse and the fulfillment mode', () => {
    // The warehouse is route context, not a form answer, and pickup-vs-delivery
    // is a MODE rather than anybody's identity — clearing those would just make
    // the next order tedious without protecting anyone.
    const next = cartReducer(dirty, { type: 'reset' });
    expect(next.warehouseId).toBe('wh-1');
    expect(next.fulfillmentType).toBe('delivery');
  });

  it("'clear' still only empties lines — reset is the one that wipes identity", () => {
    // Pinned so nobody 'fixes' this by widening `clear`, which the cart's own
    // remove-everything button uses mid-order: wiping the requester when a
    // shopper empties their basket would be its own surprise.
    const next = cartReducer(dirty, { type: 'clear' });
    expect(next.lines).toEqual([]);
    expect(next.onBehalfOf).toEqual({ name: 'Raymond Allen', email: 'rallen@example.org' });
  });
});
