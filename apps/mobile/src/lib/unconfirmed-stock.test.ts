import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  answerWrite,
  boundWrites,
  readWrites,
  startWrite,
  summarize,
  UNCONFIRMED_SETTLE_MS,
  unconfirmedStock,
  type ItemWrites,
} from './unconfirmed-stock';

/**
 * THE REVIEW FINDINGS THIS FILE PINS:
 *
 * 1. After an unconfirmed adjustment the item screen re-read the item at once
 *    and treated ANY read as the confirmed total. A read that beats a
 *    still-running write to the database shows the pre-write total; the label
 *    cleared and that total was presented as current. A write in doubt may
 *    only end on a read that shows it, or one SENT after it can no longer land.
 *
 * 2. A second write sent while a first was unconfirmed only switched off the
 *    first's "base + delta" proof when its ANSWER arrived. While it was in
 *    flight, a read showing base + delta — which may have been the SECOND
 *    write landing — cleared the first write's label. Each write is now its
 *    own entry, ended only by its own answer, its own proof (while it is the
 *    item's only write) or its own expiry.
 */

const T0 = 1_000_000;
const BOUND = T0 + UNCONFIRMED_SETTLE_MS;
const NONE: ItemWrites = new Map();
const A = 1;
const B = 2;

/** Write A: +1 on a shown total of 10, handed off at T0, answer lost at T0 + 20 s. */
function aInDoubt(): ItemWrites {
  return answerWrite(startWrite(NONE, A, { expectedTotal: 11 }), A, {
    kind: 'unconfirmed',
    settlesAt: BOUND,
    now: T0 + 20_000,
  });
}

describe('readWrites — which reads may end a write in doubt', () => {
  it('a read that still shows the PRE-write total keeps it (the write may still be running)', () => {
    const w = aInDoubt();
    expect(readWrites(w, { total: 10, startedAt: T0 + 20_500 })).toBe(w);
  });

  it('a read that shows the write ends it', () => {
    expect(readWrites(aInDoubt(), { total: 11, startedAt: T0 + 20_500 }).size).toBe(0);
  });

  it('a read showing some OTHER total (someone else adjusted) keeps it', () => {
    const w = aInDoubt();
    expect(readWrites(w, { total: 7, startedAt: T0 + 30_000 })).toBe(w);
  });

  it('a read SENT after the bound ends it, whatever it shows (nothing can still land)', () => {
    expect(readWrites(aInDoubt(), { total: 10, startedAt: BOUND }).size).toBe(0);
    expect(readWrites(aInDoubt(), { total: 10, startedAt: BOUND + 5_000 }).size).toBe(0);
  });

  it('a read sent BEFORE the bound keeps it even if it returns after: it is judged on when it was sent', () => {
    const w = aInDoubt();
    expect(readWrites(w, { total: 10, startedAt: BOUND - 1 })).toBe(w);
  });

  it('a write in flight is ended only by its own answer, never by a read', () => {
    const w = startWrite(NONE, A, { expectedTotal: 11 });
    expect(readWrites(w, { total: 11, startedAt: T0 + 1 })).toBe(w);
    expect(readWrites(w, { total: 10, startedAt: T0 + 10 * UNCONFIRMED_SETTLE_MS })).toBe(w);
  });

  it('no writes, nothing to end', () => {
    expect(readWrites(NONE, { total: 10, startedAt: T0 })).toBe(NONE);
  });
});

describe('two overlapping writes — each ends only by its own answer, proof or expiry', () => {
  it('a read showing the first write while a second is IN FLIGHT does not clear the first', () => {
    // 11 is A landing — or B (+1, sent on the same shown 10) landing with A
    // still running. Until B answers, no single total identifies A.
    const w = startWrite(aInDoubt(), B, { expectedTotal: 11 });
    const after = readWrites(w, { total: 11, startedAt: T0 + 30_000 });
    expect(after.get(A)).toMatchObject({ phase: 'unconfirmed' });
    expect(summarize(after)).toMatchObject({ settlesAt: BOUND, mayStillLand: true });
  });

  it('a write sent while another is outstanding never gets a proof of its own', () => {
    const w = startWrite(aInDoubt(), B, { expectedTotal: 12 });
    expect(w.get(B)).toMatchObject({ phase: 'sending', expectedTotal: null });
    // ...and the first write sent keeps its own.
    expect(startWrite(NONE, A, { expectedTotal: 11 }).get(A)?.expectedTotal).toBe(11);
  });

  it('the second REFUSED (nothing written): the first can be proved again', () => {
    const w = answerWrite(startWrite(aInDoubt(), B, { expectedTotal: 11 }), B, { kind: 'refused' });
    expect(w.get(A)?.expectedTotal).toBe(11);
    expect(readWrites(w, { total: 11, startedAt: T0 + 31_000 }).size).toBe(0);
  });

  it('the second CONFIRMED: the first loses its proof and ends only at its own bound', () => {
    const w = answerWrite(startWrite(aInDoubt(), B, { expectedTotal: 11 }), B, {
      kind: 'confirmed',
    });
    expect([...w.keys()]).toEqual([A]);
    expect(w.get(A)?.expectedTotal).toBeNull();
    expect(readWrites(w, { total: 11, startedAt: T0 + 31_000 })).toBe(w);
    expect(readWrites(w, { total: 12, startedAt: BOUND }).size).toBe(0);
  });

  it('the second UNCONFIRMED too: the first expires at its bound and the second stays until its own', () => {
    const bLater = BOUND + 30_000;
    const w = answerWrite(startWrite(aInDoubt(), B, { expectedTotal: 11 }), B, {
      kind: 'unconfirmed',
      settlesAt: bLater,
      now: T0 + 50_000,
    });
    // Neither 11 (one landed) nor 12 (both) proves either write.
    expect(readWrites(w, { total: 11, startedAt: T0 + 51_000 })).toBe(w);
    expect(readWrites(w, { total: 12, startedAt: T0 + 51_000 })).toBe(w);
    // A read at A's bound ends A only: the label stays for B.
    const afterA = readWrites(w, { total: 12, startedAt: BOUND });
    expect([...afterA.keys()]).toEqual([B]);
    expect(summarize(afterA)).toEqual({
      expectedTotal: null,
      settlesAt: bLater,
      mayStillLand: true,
    });
    // B was sent with A outstanding, so even alone it cannot be proved by a total.
    expect(readWrites(afterA, { total: 12, startedAt: BOUND + 1 })).toBe(afterA);
    expect(readWrites(afterA, { total: 12, startedAt: bLater }).size).toBe(0);
  });

  it('a confirmed write with nothing else outstanding leaves nothing', () => {
    const w = answerWrite(startWrite(NONE, A, { expectedTotal: 11 }), A, { kind: 'confirmed' });
    expect(w.size).toBe(0);
    expect(summarize(w)).toBeNull();
  });
});

describe('summarize — what the screens label', () => {
  it('a write in flight alone is not labelled (every tap is briefly in flight)', () => {
    expect(summarize(startWrite(NONE, A, { expectedTotal: 11 }))).toBeNull();
  });

  it('one write in doubt: its bound and its proof', () => {
    expect(summarize(aInDoubt())).toEqual({
      expectedTotal: 11,
      settlesAt: BOUND,
      mayStillLand: true,
    });
  });

  it('a commit without a total is labelled from its answer, and can no longer land', () => {
    const w = answerWrite(startWrite(NONE, A, { expectedTotal: 11 }), A, {
      kind: 'committedWithoutTotal',
      answeredAt: T0 + 400,
    });
    expect(summarize(w)).toEqual({ expectedTotal: null, settlesAt: T0 + 400, mayStillLand: false });
  });
});

describe('boundWrites', () => {
  it('flips the wording of a write once its bound has passed, and not before', () => {
    const w = aInDoubt();
    expect(boundWrites(w, BOUND - 1)).toBe(w);
    expect(boundWrites(w, BOUND).get(A)).toMatchObject({ mayStillLand: false });
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

  /** Sends a write of `delta` on `shown` and loses its answer now, handed off at `sentAt`. */
  function lose(itemId: string, shown: number, delta: number, sentAt = Date.now()) {
    unconfirmedStock.beginWrite(itemId, { shownTotal: shown, delta }).unconfirmed(sentAt);
  }

  it('keeps the label through an immediate re-read of the old total, then settles on the read after the bound', () => {
    lose('item-1', 10, 1, T0);
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
    lose('item-1', 10, -2, T0);
    const cb = vi.fn();
    unconfirmedStock.onBoundPassed('item-1', cb);

    unconfirmedStock.recordRead('item-1', 8, Date.now());

    expect(unconfirmedStock.get('item-1')).toBeNull();
    vi.advanceTimersByTime(UNCONFIRMED_SETTLE_MS * 2);
    expect(cb).not.toHaveBeenCalled();
  });

  it('is keyed by item: a read of another item changes nothing', () => {
    lose('item-1', 10, 1, T0);
    unconfirmedStock.recordRead('item-2', 11, BOUND + 1);
    expect(unconfirmedStock.get('item-1')).not.toBeNull();
  });

  it('a commit without a total settles on the next read sent after the answer, not one sent before', () => {
    const answeredAt = T0 + 400;
    unconfirmedStock
      .beginWrite('item-1', { shownTotal: 10, delta: 1 })
      .committedWithoutTotal(answeredAt);
    expect(unconfirmedStock.get('item-1')).toMatchObject({ mayStillLand: false });

    unconfirmedStock.recordRead('item-1', 10, answeredAt - 1);
    expect(unconfirmedStock.get('item-1')).not.toBeNull();
    unconfirmedStock.recordRead('item-1', 11, answeredAt);
    expect(unconfirmedStock.get('item-1')).toBeNull();
  });

  it('beginRead judges a read on when it was SENT, not when it returned', () => {
    lose('item-1', 10, 1, T0);
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
    lose('item-1', 10, 1, T0);
    const cb = vi.fn();
    const off = unconfirmedStock.onBoundPassed('item-1', cb);
    off();
    vi.advanceTimersByTime(UNCONFIRMED_SETTLE_MS + 1_000);
    expect(cb).not.toHaveBeenCalled();
  });

  it('a write in flight is not labelled, but blocks the proof of one in doubt until it answers', () => {
    const solo = unconfirmedStock.beginWrite('item-2', { shownTotal: 3, delta: 1 });
    expect(unconfirmedStock.get('item-2')).toBeNull();
    solo.refused();
    expect(unconfirmedStock.writes('item-2').size).toBe(0);

    lose('item-1', 10, 1, T0);
    vi.setSystemTime(T0 + 30_000);
    const second = unconfirmedStock.beginWrite('item-1', { shownTotal: 10, delta: 1 });
    expect(unconfirmedStock.writes('item-1').size).toBe(2);

    // A pull-to-refresh lands while the second is in flight, showing 11.
    unconfirmedStock.recordRead('item-1', 11, Date.now());
    expect(unconfirmedStock.get('item-1')).toMatchObject({ settlesAt: BOUND, mayStillLand: true });

    // The second is confirmed: the first still cannot be proved by a total.
    second.confirmed();
    unconfirmedStock.recordRead('item-1', 11, Date.now());
    expect(unconfirmedStock.get('item-1')).toMatchObject({ settlesAt: BOUND });
  });

  it('two writes in doubt: one re-read at EACH bound, and the label ends only after the later one', () => {
    const bLater = T0 + 30_000 + UNCONFIRMED_SETTLE_MS;
    lose('item-1', 10, 1, T0);
    vi.setSystemTime(T0 + 30_000);
    lose('item-1', 10, 1, T0 + 30_000);
    const cb = vi.fn();
    unconfirmedStock.onBoundPassed('item-1', cb);

    vi.advanceTimersByTime(BOUND - Date.now() + 1_000);
    expect(cb).toHaveBeenCalledTimes(1);
    // A can no longer land, B still can.
    expect(unconfirmedStock.get('item-1')).toMatchObject({ settlesAt: bLater, mayStillLand: true });
    unconfirmedStock.recordRead('item-1', 12, Date.now());
    expect(unconfirmedStock.writes('item-1').size).toBe(1);
    expect(unconfirmedStock.get('item-1')).not.toBeNull();

    vi.advanceTimersByTime(bLater - Date.now() + 1_000);
    expect(cb).toHaveBeenCalledTimes(2);
    unconfirmedStock.recordRead('item-1', 12, Date.now());
    expect(unconfirmedStock.get('item-1')).toBeNull();
  });

  it('a write answers once: a second report is ignored', () => {
    const w = unconfirmedStock.beginWrite('item-1', { shownTotal: 10, delta: 1 });
    w.unconfirmed(T0);
    w.confirmed();
    expect(unconfirmedStock.get('item-1')).toMatchObject({ expectedTotal: 11 });
  });

  it('recordUnconfirmed (a queued adjustment the drain sent): labelled from its send, never proved by a total, re-read at the bound', () => {
    const cb = vi.fn();
    unconfirmedStock.onBoundPassed('item-1', cb);
    unconfirmedStock.recordUnconfirmed('item-1', T0);
    expect(unconfirmedStock.get('item-1')).toEqual({
      expectedTotal: null,
      settlesAt: BOUND,
      mayStillLand: true,
    });

    // Whatever total a read sent before the bound shows, it cannot tell
    // whether the write landed or is still running.
    for (const total of [10, 11, 15]) unconfirmedStock.recordRead('item-1', total, BOUND - 1);
    expect(unconfirmedStock.get('item-1')).not.toBeNull();

    vi.advanceTimersByTime(UNCONFIRMED_SETTLE_MS + 1_000);
    expect(cb).toHaveBeenCalledTimes(1);
    unconfirmedStock.recordRead('item-1', 11, Date.now());
    expect(unconfirmedStock.get('item-1')).toBeNull();
  });

  it('recordUnconfirmed takes the proof away from a write of the same item already in doubt', () => {
    lose('item-1', 10, 1, T0);
    unconfirmedStock.recordUnconfirmed('item-1', T0 + 5_000);
    // 11 was "the first write landed"; with a second write that may have
    // moved the stock, it proves nothing.
    unconfirmedStock.recordRead('item-1', 11, T0 + 6_000);
    expect(unconfirmedStock.writes('item-1').size).toBe(2);
    expect(unconfirmedStock.get('item-1')).toMatchObject({ expectedTotal: null });
  });

  it('the label a screen holds keeps its reference while a write only goes out', () => {
    lose('item-1', 10, 1, T0);
    const before = unconfirmedStock.get('item-1');
    unconfirmedStock.beginWrite('item-1', { shownTotal: 10, delta: 1 });
    // The proof went (two writes), so the summary did change...
    expect(unconfirmedStock.get('item-1')).not.toBe(before);
    const during = unconfirmedStock.get('item-1');
    // ...but a read that changes nothing leaves the same object for React.
    unconfirmedStock.recordRead('item-1', 99, Date.now());
    expect(unconfirmedStock.get('item-1')).toBe(during);
  });
});
