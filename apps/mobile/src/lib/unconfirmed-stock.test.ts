import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  addOutstanding,
  afterBound,
  afterConfirmedWrite,
  afterRead,
  UNCONFIRMED_SETTLE_MS,
  unconfirmedStock,
  type UnconfirmedStock,
} from './unconfirmed-stock';

/**
 * THE REVIEW FINDING THIS FILE PINS: after an unconfirmed adjustment the item
 * screen re-read the item at once and treated ANY read as the confirmed total.
 * A read that beats a still-running write to the database shows the pre-write
 * total; the label cleared and that total was presented as current. The doubt
 * may only end on a read that shows the write, or one SENT after the write can
 * no longer land.
 */

const T0 = 1_000_000;
const BOUND = T0 + UNCONFIRMED_SETTLE_MS;

/** An adjustment of +1 on a shown total of 10, sent at T0, answer lost. */
function oneInDoubt(): UnconfirmedStock {
  return addOutstanding(null, { expectedTotal: 11, settlesAt: BOUND, now: T0 + 20_000 });
}

describe('afterRead — which reads may end the doubt', () => {
  it('a read that still shows the PRE-write total keeps it (the write may still be running)', () => {
    const u = oneInDoubt();
    expect(afterRead(u, { total: 10, startedAt: T0 + 20_500 })).toBe(u);
  });

  it('a read that shows the write ends it', () => {
    expect(afterRead(oneInDoubt(), { total: 11, startedAt: T0 + 20_500 })).toBeNull();
  });

  it('a read showing some OTHER total (someone else adjusted) keeps it', () => {
    const u = oneInDoubt();
    expect(afterRead(u, { total: 7, startedAt: T0 + 30_000 })).toBe(u);
  });

  it('a read SENT after the bound ends it, whatever it shows (nothing can still land)', () => {
    expect(afterRead(oneInDoubt(), { total: 10, startedAt: BOUND })).toBeNull();
    expect(afterRead(oneInDoubt(), { total: 10, startedAt: BOUND + 5_000 })).toBeNull();
  });

  it('a read sent BEFORE the bound keeps it even if it returns after: it is judged on when it was sent', () => {
    const u = oneInDoubt();
    expect(afterRead(u, { total: 10, startedAt: BOUND - 1 })).toBe(u);
  });

  it('no doubt, nothing to end', () => {
    expect(afterRead(null, { total: 10, startedAt: T0 })).toBeNull();
  });
});

describe('addOutstanding / afterConfirmedWrite — more than one write', () => {
  it('two writes in doubt: no single total proves them, and the later bound wins', () => {
    const later = BOUND + 5_000;
    const u = addOutstanding(oneInDoubt(), { expectedTotal: 12, settlesAt: later, now: T0 + 25_000 });
    expect(u).toEqual({ expectedTotal: null, settlesAt: later, mayStillLand: true });
    // 11 (the first alone) and 12 (both) prove nothing: one may land later.
    expect(afterRead(u, { total: 11, startedAt: T0 + 26_000 })).toBe(u);
    expect(afterRead(u, { total: 12, startedAt: T0 + 26_000 })).toBe(u);
    expect(afterRead(u, { total: 12, startedAt: later })).toBeNull();
  });

  it('a confirmed write on top of one in doubt drops the shortcut but keeps the bound', () => {
    const u = afterConfirmedWrite(oneInDoubt());
    expect(u).toEqual({ expectedTotal: null, settlesAt: BOUND, mayStillLand: true });
    expect(afterRead(u, { total: 11, startedAt: T0 + 30_000 })).toBe(u);
  });

  it('a confirmed write with nothing in doubt leaves nothing', () => {
    expect(afterConfirmedWrite(null)).toBeNull();
  });
});

describe('afterBound', () => {
  it('flips the wording once the bound has passed, and not before', () => {
    const u = oneInDoubt();
    expect(afterBound(u, BOUND - 1)).toBe(u);
    expect(afterBound(u, BOUND)).toEqual({ ...u, mayStillLand: false });
  });
});

describe('the store', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    unconfirmedStock.resetForTests();
  });
  afterEach(() => {
    unconfirmedStock.resetForTests();
    vi.useRealTimers();
  });

  it('keeps the label through an immediate re-read of the old total, then settles on the read after the bound', () => {
    unconfirmedStock.markUnconfirmed('item-1', { shownTotal: 10, delta: 1, sentAt: T0 });
    const cb = vi.fn();
    const off = unconfirmedStock.onBoundPassed('item-1', cb);

    // The re-read the screen fires right after the timeout: pre-write total.
    unconfirmedStock.recordRead('item-1', 10, Date.now());
    expect(unconfirmedStock.get('item-1')).toMatchObject({ mayStillLand: true });

    vi.advanceTimersByTime(UNCONFIRMED_SETTLE_MS - 1);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    // The bound passed: the wording changes and the screen is asked to re-read.
    expect(cb).toHaveBeenCalledTimes(1);
    expect(unconfirmedStock.get('item-1')).toMatchObject({ mayStillLand: false });

    // That re-read is sent after the bound, so it settles either way.
    unconfirmedStock.recordRead('item-1', 10, Date.now());
    expect(unconfirmedStock.get('item-1')).toBeNull();
    off();
  });

  it('a read showing the write clears it early, and its timer never fires', () => {
    unconfirmedStock.markUnconfirmed('item-1', { shownTotal: 10, delta: -2, sentAt: T0 });
    const cb = vi.fn();
    unconfirmedStock.onBoundPassed('item-1', cb);

    unconfirmedStock.recordRead('item-1', 8, Date.now());

    expect(unconfirmedStock.get('item-1')).toBeNull();
    vi.advanceTimersByTime(UNCONFIRMED_SETTLE_MS * 2);
    expect(cb).not.toHaveBeenCalled();
  });

  it('is keyed by item: a read of another item changes nothing', () => {
    unconfirmedStock.markUnconfirmed('item-1', { shownTotal: 10, delta: 1, sentAt: T0 });
    unconfirmedStock.recordRead('item-2', 11, BOUND + 1);
    expect(unconfirmedStock.get('item-1')).not.toBeNull();
  });

  it('a commit without a total settles on the next read sent after the answer, not one sent before', () => {
    const answeredAt = T0 + 400;
    unconfirmedStock.markCommittedWithoutTotal('item-1', answeredAt);
    expect(unconfirmedStock.get('item-1')).toMatchObject({ mayStillLand: false });

    unconfirmedStock.recordRead('item-1', 10, answeredAt - 1);
    expect(unconfirmedStock.get('item-1')).not.toBeNull();
    unconfirmedStock.recordRead('item-1', 11, answeredAt);
    expect(unconfirmedStock.get('item-1')).toBeNull();
  });

  it('beginRead judges a read on when it was SENT, not when it returned', () => {
    unconfirmedStock.markUnconfirmed('item-1', { shownTotal: 10, delta: 1, sentAt: T0 });
    vi.setSystemTime(BOUND - 1_000);
    const report = unconfirmedStock.beginRead('item-1');
    // The read returns after the bound, still carrying the old total: it was
    // sent while the write could still land, so it proves nothing.
    vi.setSystemTime(BOUND + 5_000);
    report(10);
    expect(unconfirmedStock.get('item-1')).not.toBeNull();
    // One sent after the bound settles it.
    unconfirmedStock.beginRead('item-1')(10);
    expect(unconfirmedStock.get('item-1')).toBeNull();
  });

  it('an unsubscribed screen is not called at the bound', () => {
    unconfirmedStock.markUnconfirmed('item-1', { shownTotal: 10, delta: 1, sentAt: T0 });
    const cb = vi.fn();
    const off = unconfirmedStock.onBoundPassed('item-1', cb);
    off();
    vi.advanceTimersByTime(UNCONFIRMED_SETTLE_MS + 1_000);
    expect(cb).not.toHaveBeenCalled();
  });
});
