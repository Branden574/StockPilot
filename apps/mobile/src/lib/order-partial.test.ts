import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import {
  PARTIAL_ACTION_TITLE,
  PARTIAL_CLOSE_LABEL,
  PARTIAL_COMMIT_UNANSWERED_COPY,
  PARTIAL_PREVIEW_NOTE,
  PARTIAL_PREVIEW_NOTHING_TO_HOLD_COPY,
  PARTIAL_PREVIEW_READ_FAILED_COPY,
  previewPartialFulfilment,
  type OrderReadinessResult,
} from '@stockpilot/core';
import { describe, expect, it, vi } from 'vitest';

import { CONNECTION_FAILURE_COPY, REQUEST_TIMED_OUT_COPY } from './connection-copy';
import {
  FX_ITEM_A,
  FX_ITEM_B,
  FX_ORDER,
  fxFacts,
  fxItem,
  fxLine,
  fxResult,
} from './__fixtures__/readiness-facts';
import {
  describePartialCommitError,
  PARTIAL_COMMIT_FAILED_COPY,
  partialSheetView,
  runPartialFulfilment,
  type PartialCommitDeps,
} from './order-partial';

/**
 * APPROVE PARTIAL AND RESUME, WITH A PREVIEW, ON THE PHONE (F2-3). The sheet's
 * words (core's), and the confirm: the existing transition, then readiness
 * read again, and the message computed from THAT read, never from the
 * preview. Real assessments (core's parser and assessment). Each test names
 * the mutation it catches.
 */

const TZ = { timeZone: 'America/Los_Angeles' };

/** Pending: Maus I asks 40 with 36 free. */
const PENDING = fxResult(
  fxFacts({
    lines: [fxLine('line-1', FX_ITEM_A, 40)],
    items: [fxItem(FX_ITEM_A, { onHand: 36, here: { rack: 36, site: 0, unplaced: 0, staging: 0 } })],
  }),
);
const PREVIEW = previewPartialFulfilment(PENDING, 'approve_partial');

/** After the commit: approved, holding `held` of Maus I's 40. */
function approvedHolding(held: number, over: { orderId?: string; status?: string } = {}): OrderReadinessResult {
  return fxResult(
    fxFacts({
      status: over.status ?? 'approved',
      orderId: over.orderId,
      lines: [fxLine('line-1', FX_ITEM_A, 40)],
      items: [
        fxItem(FX_ITEM_A, {
          onHand: 36,
          heldOwn: held,
          heldOtherOrders: 36 - held,
          here: { rack: 36, site: 0, unplaced: 0, staging: 0 },
        }),
      ],
    }),
  );
}

function deps(reread: OrderReadinessResult | Promise<OrderReadinessResult>) {
  const calls: string[] = [];
  const d = {
    commit: vi.fn(async (orderId: string, action: string) => {
      calls.push(`commit ${orderId} ${action}`);
    }),
    reread: vi.fn(async (orderId: string) => {
      calls.push(`reread ${orderId}`);
      return reread;
    }),
    reload: vi.fn(async () => {
      calls.push('reload');
    }),
  } satisfies PartialCommitDeps;
  return { d, calls };
}

describe('partialSheetView: the preview, in core’s words', () => {
  it('approve partial: the summary, when checked, one row per item, the note, Approve partial / Cancel', () => {
    const view = partialSheetView(PREVIEW, TZ);
    expect(view).toEqual({
      title: 'Approve partial',
      summary: "Approve what's available: holds 36 of 40 units now. The other 4 ship when they arrive.",
      checkedAt: 'Checked at 10:59 AM. Stock can change after this.',
      items: [
        {
          itemId: FX_ITEM_A,
          label: 'Maus I',
          detail: 'Holds 36 of 40',
          accessibilityLabel: 'Maus I, holds 36 of 40, 4 to ship when they arrive',
        },
      ],
      note: PARTIAL_PREVIEW_NOTE,
      confirmLabel: 'Approve partial',
      cancelLabel: 'Cancel',
      unavailable: null,
    });
  });

  it('duplicate lines of one item are ONE row, never a per-line split', () => {
    // Mutation caught: a row per line (approve_partial's split between two
    // lines of one item is not defined; only the item's total is).
    const dup = fxResult(
      fxFacts({
        lines: [fxLine('line-1', FX_ITEM_A, 3), fxLine('line-2', FX_ITEM_A, 3), fxLine('line-3', FX_ITEM_B, 2)],
        items: [
          fxItem(FX_ITEM_A, { onHand: 5, here: { rack: 5, site: 0, unplaced: 0, staging: 0 } }),
          fxItem(FX_ITEM_B),
        ],
      }),
    );
    const view = partialSheetView(previewPartialFulfilment(dup, 'approve_partial'), TZ);
    expect(view.items.map((i) => [i.label, i.detail])).toEqual([
      ['Maus I (2 lines)', 'Holds 5 of 6'],
      ['Notebooks', 'Holds 2 of 2'],
    ]);
  });

  it('resume: its own title and confirm', () => {
    const backordered = fxResult(
      fxFacts({
        status: 'backordered',
        lines: [fxLine('line-1', FX_ITEM_A, 10, { fulfilled: 6 })],
        items: [fxItem(FX_ITEM_A, { onHand: 3, here: { rack: 3, site: 0, unplaced: 0, staging: 0 } })],
      }),
    );
    const view = partialSheetView(previewPartialFulfilment(backordered, 'resume'), TZ);
    expect(view.title).toBe('Resume fulfillment');
    expect(view.confirmLabel).toBe('Resume fulfillment');
    expect(view.summary).toBe("Resume what's available: holds 3 of 4 units now. The other 1 ships when it arrives.");
  });

  it('unavailable: says why, offers only Close (nothing is committed blind)', () => {
    // Mutation caught: offering Confirm on a preview that could not be made.
    const failed = partialSheetView(
      previewPartialFulfilment({ state: 'failed', message: 'x' }, 'approve_partial'),
      TZ,
    );
    expect(failed).toEqual({
      title: PARTIAL_ACTION_TITLE.approve_partial,
      summary: null,
      checkedAt: null,
      items: [],
      note: null,
      confirmLabel: null,
      cancelLabel: PARTIAL_CLOSE_LABEL,
      unavailable: PARTIAL_PREVIEW_READ_FAILED_COPY,
    });
    const nothingFree = fxResult(
      fxFacts({
        status: 'backordered',
        lines: [fxLine('line-1', FX_ITEM_A, 10, { fulfilled: 6 })],
        items: [fxItem(FX_ITEM_A, { onHand: 0, here: { rack: 0, site: 0, unplaced: 0, staging: 0 } })],
      }),
    );
    const view = partialSheetView(previewPartialFulfilment(nothingFree, 'resume'), TZ);
    expect(view.title).toBe('Resume fulfillment');
    expect(view.confirmLabel).toBeNull();
    expect(view.unavailable).toBe(PARTIAL_PREVIEW_NOTHING_TO_HOLD_COPY);
  });

  it('the titles are the order screen’s buttons (core’s words)', () => {
    expect(PARTIAL_ACTION_TITLE).toEqual({
      approve_partial: 'Approve partial',
      resume: 'Resume fulfillment',
    });
    expect(PARTIAL_CLOSE_LABEL).toBe('Close');
  });
});

describe('runPartialFulfilment: the message comes from the RE-READ, never the preview', () => {
  it('stock changed after the preview: "2 fewer than shown"', async () => {
    // Mutation caught: echoing the preview ("Holding 36 of 40").
    const { d, calls } = deps(approvedHolding(34));
    const result = await runPartialFulfilment(d, FX_ORDER, 'approve_partial', PREVIEW);
    expect(result.text).toBe(
      'Approved. Holding 34 of 40 units, 2 fewer than shown because stock changed after you looked.',
    );
    expect(result).toMatchObject({ tone: 'warning', held: 34, asked: 40, difference: 2 });
    expect(calls[0]).toBe(`commit ${FX_ORDER} approve_partial`);
    expect(calls.slice(1).sort()).toEqual(['reload', `reread ${FX_ORDER}`]);
  });

  it('as shown: "Holding 36 of 40 units."', async () => {
    const { d } = deps(approvedHolding(36));
    const result = await runPartialFulfilment(d, FX_ORDER, 'approve_partial', PREVIEW);
    expect(result.text).toBe('Approved. Holding 36 of 40 units.');
  });

  it('resume leads with the new pick slip', async () => {
    const backordered = fxResult(
      fxFacts({
        status: 'backordered',
        lines: [fxLine('line-1', FX_ITEM_A, 10, { fulfilled: 6 })],
        items: [fxItem(FX_ITEM_A, { onHand: 3, here: { rack: 3, site: 0, unplaced: 0, staging: 0 } })],
      }),
    );
    const preview = previewPartialFulfilment(backordered, 'resume');
    const after = fxResult(
      fxFacts({
        status: 'pick_slip_generated',
        lines: [fxLine('line-1', FX_ITEM_A, 10, { fulfilled: 6 })],
        items: [
          fxItem(FX_ITEM_A, {
            onHand: 3,
            heldOwn: 3,
            here: { rack: 3, site: 0, unplaced: 0, staging: 0 },
          }),
        ],
      }),
    );
    const { d, calls } = deps(after);
    const result = await runPartialFulfilment(d, FX_ORDER, 'resume', preview);
    expect(result.text).toBe('Resumed. A new pick slip is ready. Holding 3 of 4 units.');
    expect(calls[0]).toBe(`commit ${FX_ORDER} resume`);
  });

  it('a re-read that failed, or is about another order, claims no number', async () => {
    const unchecked = "Approved. What is held now couldn't be checked. Check again on the order.";
    for (const reread of [
      { state: 'failed', message: 'x' } as OrderReadinessResult,
      approvedHolding(36, { orderId: '0a000000-0000-0000-0000-00000000f999' }),
    ]) {
      const { d } = deps(reread);
      const result = await runPartialFulfilment(d, FX_ORDER, 'approve_partial', PREVIEW);
      expect(result.text).toBe(unchecked);
      expect(result.held).toBeNull();
    }
  });

  it('a re-read that rejects (it should not) still says the approval went through, with no number', async () => {
    const { d } = deps(approvedHolding(36));
    d.reread.mockRejectedValueOnce(new Error('boom'));
    const result = await runPartialFulfilment(d, FX_ORDER, 'approve_partial', PREVIEW);
    expect(result.text).toBe("Approved. What is held now couldn't be checked. Check again on the order.");
  });

  it('a failed screen reload never loses the message', async () => {
    const { d } = deps(approvedHolding(34));
    d.reload.mockRejectedValueOnce(new Error('offline'));
    const result = await runPartialFulfilment(d, FX_ORDER, 'approve_partial', PREVIEW);
    expect(result.held).toBe(34);
  });

  it('a refused commit rejects with the refusal; nothing is read or said', async () => {
    // Mutation caught: reading (and reporting holds) after a refusal.
    const { d } = deps(approvedHolding(36));
    const refusal = Object.assign(new Error('This order is no longer waiting for approval.'), { status: 409 });
    d.commit.mockRejectedValueOnce(refusal);
    await expect(runPartialFulfilment(d, FX_ORDER, 'approve_partial', PREVIEW)).rejects.toBe(refusal);
    expect(d.reread).not.toHaveBeenCalled();
    expect(d.reload).not.toHaveBeenCalled();
  });

  it('the re-read and the screen reload run side by side (no serial round trip)', async () => {
    // Mutation caught: awaiting the reload before starting the re-read.
    let releaseReload!: () => void;
    const { d } = deps(approvedHolding(36));
    d.reload.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseReload = resolve;
        }),
    );
    const done = runPartialFulfilment(d, FX_ORDER, 'approve_partial', PREVIEW);
    await vi.waitFor(() => expect(d.reread).toHaveBeenCalledTimes(1));
    expect(d.reload).toHaveBeenCalledTimes(1);
    releaseReload();
    await expect(done).resolves.toMatchObject({ held: 36 });
  });
});

describe('describePartialCommitError: what the sheet says in place', () => {
  it("the server's sentence", () => {
    const e = Object.assign(new Error('Some items no longer belong to this warehouse.'), { status: 409 });
    expect(describePartialCommitError(e)).toBe('Some items no longer belong to this warehouse.');
  });

  it('no answer at all: the outcome is unknown, look first (the web dialog’s words; never the network layer’s text)', () => {
    // Mutation caught: "try again" as if nothing happened, when the
    // approval may have gone through.
    for (const e of [
      new TypeError('Network request failed'),
      new Error(REQUEST_TIMED_OUT_COPY),
      new Error(CONNECTION_FAILURE_COPY),
      'boom',
    ]) {
      expect(describePartialCommitError(e)).toBe(PARTIAL_COMMIT_UNANSWERED_COPY);
    }
    expect(PARTIAL_COMMIT_UNANSWERED_COPY).toBe(
      "The request didn't finish. Check the order before trying again.",
    );
  });

  it('a bare code, or too many requests', () => {
    expect(describePartialCommitError(Object.assign(new Error('conflict'), { status: 409 }))).toBe(
      PARTIAL_COMMIT_FAILED_COPY,
    );
    expect(describePartialCommitError(Object.assign(new Error(''), { status: 500 }))).toBe(
      PARTIAL_COMMIT_FAILED_COPY,
    );
    expect(describePartialCommitError(Object.assign(new Error('x y'), { status: 429 }))).toBe(
      'Too many requests. Wait a moment and try again.',
    );
  });
});

/**
 * PATTERN #26 GUARD: the phone sheet and the web dialog take their titles, the
 * Close label and the no-answer sentence from core (partial-fulfilment.ts),
 * never a copy of their own. This reads both sources and fails the moment
 * either one grows its own copy of those words again.
 */
describe('the phone sheet and the web dialog say the same (both read core)', () => {
  const web = readFileSync(
    path.resolve(__dirname, '../../../web/src/components/orders/approve-partial-dialog.tsx'),
    'utf8',
  );
  const phoneLib = readFileSync(path.resolve(__dirname, './order-partial.ts'), 'utf8');
  const phoneSheet = readFileSync(
    path.resolve(__dirname, '../components/approve-partial-sheet.tsx'),
    'utf8',
  );
  const phoneScreen = readFileSync(path.resolve(__dirname, '../../app/order/[id].tsx'), 'utf8');

  it('both import the words from core', () => {
    for (const name of ['PARTIAL_ACTION_TITLE', 'PARTIAL_CLOSE_LABEL', 'PARTIAL_COMMIT_UNANSWERED_COPY']) {
      expect(web).toContain(name);
      expect(phoneLib).toContain(name);
    }
    expect(phoneScreen).toContain('Alert.alert(PARTIAL_ACTION_TITLE[action], result.text)');
  });

  it('neither keeps a copy of its own', () => {
    for (const src of [web, phoneLib, phoneSheet]) {
      // String literals and JSX text (the doc comments may name the buttons).
      expect(src).not.toContain("didn't finish");
      expect(src).not.toMatch(/'(Approve partial|Resume fulfillment)'/);
      expect(src).not.toMatch(/>\s*(Approve partial|Resume fulfillment)\s*</);
    }
    expect(web).not.toMatch(/data-testid="approve-partial-close">\s*Close\s*</);
  });
});
