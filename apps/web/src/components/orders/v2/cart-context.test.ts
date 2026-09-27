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

// ---------------------------------------------------------------------------
// Kits (New order page). A kit's lines are ordinary lines; CartState.kits only
// remembers how many units of each line a kit put there, so taking the kit out
// never takes units added by hand. The allocation itself is pinned in
// storefront/storefront-kits.test.ts.
// ---------------------------------------------------------------------------
describe('cartReducer — kits', () => {
  const seed = initialCartState({ warehouseId: 'wh-1', fulfillmentType: 'pickup' });
  const kit = (s: ReturnType<typeof initialCartState>, bundleId: string, changes: Array<[string, number]>) =>
    cartReducer(s, {
      type: 'apply-kit',
      bundleId,
      changes: changes.map(([itemId, delta]) => ({ itemId, delta })),
    });

  it('a new cart has no kits', () => {
    expect(seed.kits).toEqual({});
  });

  it('apply-kit adds ordinary lines, merges into an existing one, and records the kit units', () => {
    let s = cartReducer(seed, { type: 'add', itemId: 'mug', quantity: 2 });
    s = kit(s, 'b1', [
      ['mug', 3],
      ['pad', 3],
    ]);
    expect(s.lines).toEqual([
      { itemId: 'mug', quantity: 5 },
      { itemId: 'pad', quantity: 3 },
    ]);
    expect(s.kits).toEqual({ b1: { mug: 3, pad: 3 } });
  });

  it('a negative change takes units off, drops a line at 0, and forgets a kit with nothing left', () => {
    let s = kit(seed, 'b1', [['mug', 3]]);
    s = kit(s, 'b1', [['mug', -3]]);
    expect(s.lines).toEqual([]);
    expect(s.kits).toEqual({});
  });

  it('lowering a line by hand shrinks the kit record to fit; raising it by hand does not grow it', () => {
    let s = kit(seed, 'b1', [['mug', 3]]);
    s = cartReducer(s, { type: 'add', itemId: 'mug', quantity: 4 });
    expect(s.kits).toEqual({ b1: { mug: 3 } });
    s = cartReducer(s, { type: 'set-qty', itemId: 'mug', quantity: 2 });
    expect(s.kits).toEqual({ b1: { mug: 2 } });
    s = cartReducer(s, { type: 'dec', itemId: 'mug' });
    expect(s.kits).toEqual({ b1: { mug: 1 } });
    s = cartReducer(s, { type: 'remove', itemId: 'mug' });
    expect(s.kits).toEqual({});
  });

  it('a line removed by hand and added again by hand is not the kit again', () => {
    let s = kit(seed, 'b1', [['mug', 1]]);
    s = cartReducer(s, { type: 'set-qty', itemId: 'mug', quantity: 0 });
    s = cartReducer(s, { type: 'add', itemId: 'mug' });
    expect(s.kits).toEqual({});
  });

  it('two kits on one line: a line lowered by hand takes from the kit added last', () => {
    let s = kit(seed, 'first', [['mug', 2]]);
    s = kit(s, 'second', [['mug', 2]]);
    s = cartReducer(s, { type: 'set-qty', itemId: 'mug', quantity: 3 });
    expect(s.kits).toEqual({ first: { mug: 2 }, second: { mug: 1 } });
  });

  it('clear and reset forget every kit', () => {
    const s = kit(seed, 'b1', [['mug', 1]]);
    expect(cartReducer(s, { type: 'clear' }).kits).toEqual({});
    expect(cartReducer(s, { type: 'reset' }).kits).toEqual({});
  });

  it('a draft saved before kits existed loads with none', () => {
    const { kits: _omit, ...old } = seed;
    const restored = cartReducer(seed, {
      type: 'hydrate',
      state: { ...old, lines: [{ itemId: 'mug', quantity: 2 }] } as never,
    });
    expect(restored.kits).toEqual({});
    expect(restored.lines).toEqual([{ itemId: 'mug', quantity: 2 }]);
  });

  it('a saved kit record is kept only as far as the saved lines hold it, and junk is dropped', () => {
    const restored = cartReducer(seed, {
      type: 'hydrate',
      state: {
        ...seed,
        lines: [{ itemId: 'mug', quantity: 2 }],
        kits: {
          b1: { mug: 5, gone: 3, frac: 1.5 },
          b2: 'nonsense',
          b3: { mug: -1 },
        },
      } as never,
    });
    expect(restored.kits).toEqual({ b1: { mug: 2 } });
  });

  it('non-whole or zero changes are ignored', () => {
    const s = kit(seed, 'b1', [
      ['mug', 1.5],
      ['pad', 0],
    ]);
    expect(s).toBe(seed);
  });
});
