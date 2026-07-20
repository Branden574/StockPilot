import { describe, expect, it } from 'vitest';

import type { StockStatus } from '@/components/filter-sheet';
import { listStatusPredicate, stockPillFor } from './expected-items';

describe('listStatusPredicate — expected-items visibility (mig 0277)', () => {
  it('every DEFAULT view excludes awaiting-first-receipt phantoms', () => {
    // 'all', 'low' and 'out' are the views where a phantom showing up as
    // "Out of stock" caused the owner-reported misreading — all three must
    // carry awaiting_first_receipt = false.
    for (const status of ['all', 'low', 'out'] as const) {
      expect(listStatusPredicate(status)).toEqual({
        awaitingFirstReceipt: false,
        lifecycle: 'active',
      });
    }
  });

  it('the Archived view also excludes phantoms (they are not "archived stock")', () => {
    expect(listStatusPredicate('archived')).toEqual({
      awaitingFirstReceipt: false,
      lifecycle: 'archived',
    });
  });

  it('the Expected view flips to flagged-ONLY', () => {
    expect(listStatusPredicate('expected').awaitingFirstReceipt).toBe(true);
  });

  it('the Expected view spans lifecycles so a manually-archived phantom stays reachable', () => {
    // Archived excludes flagged rows (above), so if Expected ALSO filtered
    // to status='active', a flagged item someone archived by hand would be
    // invisible on every view — lifecycle must be null (no status filter).
    expect(listStatusPredicate('expected').lifecycle).toBeNull();
  });

  it('is exhaustive over StockStatus (a new option cannot silently skip the flag predicate)', () => {
    const all: StockStatus[] = ['all', 'low', 'out', 'archived', 'expected'];
    for (const status of all) {
      const pred = listStatusPredicate(status);
      expect(typeof pred.awaitingFirstReceipt).toBe('boolean');
      // Only Expected may surface flagged rows.
      expect(pred.awaitingFirstReceipt).toBe(status === 'expected');
    }
  });
});

describe('stockPillFor — EXPECTED replaces OUT for never-received items', () => {
  it('an awaiting-first-receipt phantom at zero reads EXPECTED, never OUT', () => {
    expect(
      stockPillFor({ quantity_on_hand: 0, reorder_point: 0, awaiting_first_receipt: true }),
    ).toEqual({ status: 'warn', label: 'EXPECTED' });
  });

  it('an ESTABLISHED zero-quantity item still reads OUT (the Dell XPS case)', () => {
    expect(
      stockPillFor({ quantity_on_hand: 0, reorder_point: 5, awaiting_first_receipt: false }),
    ).toEqual({ status: 'crit', label: 'OUT' });
  });

  it('LOW and OK derivations are unchanged for unflagged items', () => {
    expect(
      stockPillFor({ quantity_on_hand: 3, reorder_point: 5, awaiting_first_receipt: false }),
    ).toEqual({ status: 'warn', label: 'LOW' });
    expect(
      stockPillFor({ quantity_on_hand: 50, reorder_point: 5, awaiting_first_receipt: false }),
    ).toEqual({ status: 'ok', label: 'OK' });
    // reorder_point 0 disables the LOW band entirely.
    expect(
      stockPillFor({ quantity_on_hand: 1, reorder_point: 0, awaiting_first_receipt: false }),
    ).toEqual({ status: 'ok', label: 'OK' });
  });

  it('the flag wins over stock math (transient-only: the DB trigger clears it on arrival)', () => {
    // quantity > 0 with the flag still set cannot persist — mig 0277's
    // BEFORE UPDATE trigger clears it — but if a stale row is ever rendered
    // mid-refresh, EXPECTED is the safer read than OK.
    expect(
      stockPillFor({ quantity_on_hand: 4, reorder_point: 0, awaiting_first_receipt: true }),
    ).toEqual({ status: 'warn', label: 'EXPECTED' });
  });
});
