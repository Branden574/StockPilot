import { describe, expect, it } from 'vitest';

import {
  describeLineFulfilment,
  describeLineReturnRefs,
  describeReturnLine,
  formatOrderReturnSummary,
  isPendingReturn,
  ORDER_RETURN_SUMMARY_NOTE,
  orderReturnSummary,
  returnDispositionLabel,
  returnedFragment,
  returnHandle,
  returnLineCountsAsReturned,
  returnReasonLabel,
  returnRefsByLine,
  returnStatusLabel,
  RETURN_STATUS_LABELS,
  type OrderReturnView,
} from './order-returns-view';

/**
 * SO-000085 as prod holds it (read-only measurement, 2026-08-17): three lines
 * each requested 1 / fulfilled 1; ONE closed RMA whose single line restocked
 * the Women's Polo S (applied = true, returned_quantity on that line = 1). The
 * swap for a Medium exists only in the notes.
 */
const S_LINE = 'line-s';
const M_LINE = 'line-m';
const XL_LINE = 'line-xl';

const CLOSED_RMA: OrderReturnView = {
  id: '85d6084b-0000-0000-0000-000000000000',
  returnNumber: 'RMA-20260817-EEF074',
  status: 'closed',
  reasonCode: 'other',
  notes: 'Size S New Hire shirt was swapped out for Ladies size M',
  createdAt: '2026-08-17T17:10:00Z',
  closedAt: '2026-08-17T17:12:00Z',
  lines: [{ orderRequestLineId: S_LINE, quantity: 1, disposition: 'restock', applied: true }],
};

describe('order-returns-view — the rule: applied is the only thing that counts', () => {
  it('an applied line counts; an unapplied one does not, whatever the header says', () => {
    expect(returnLineCountsAsReturned({ applied: true })).toBe(true);
    expect(returnLineCountsAsReturned({ applied: false })).toBe(false);
  });

  it('refs by line: the closed RMA lands on the S line as APPLIED with its number; M and XL have no refs', () => {
    const refs = returnRefsByLine([CLOSED_RMA]);
    expect(refs.get(S_LINE)).toEqual({
      applied: { quantity: 1, returnNumbers: ['RMA-20260817-EEF074'] },
      pending: { quantity: 0, returnNumbers: [] },
    });
    expect(refs.has(M_LINE)).toBe(false);
    expect(refs.has(XL_LINE)).toBe(false);
  });

  it.each(['requested', 'approved', 'received'] as const)(
    'an in-flight %s return with an unapplied line is PENDING on the line, never applied (mutation: flipping applied moves it)',
    (status) => {
      const inFlight: OrderReturnView = {
        ...CLOSED_RMA,
        id: 'r2',
        returnNumber: 'RMA-2',
        status,
        closedAt: null,
        lines: [{ orderRequestLineId: M_LINE, quantity: 1, disposition: 'restock', applied: false }],
      };
      const refs = returnRefsByLine([inFlight]);
      expect(refs.get(M_LINE)).toEqual({
        applied: { quantity: 0, returnNumbers: [] },
        pending: { quantity: 1, returnNumbers: ['RMA-2'] },
      });
      // Mutation: the same row with applied=true is counted, not pending.
      const applied = returnRefsByLine([
        { ...inFlight, lines: [{ ...inFlight.lines[0]!, applied: true }] },
      ]);
      expect(applied.get(M_LINE)).toEqual({
        applied: { quantity: 1, returnNumbers: ['RMA-2'] },
        pending: { quantity: 0, returnNumbers: [] },
      });
    },
  );

  it.each(['denied', 'cancelled'] as const)(
    'a %s return with an unapplied line is neither applied nor pending on the line — history only',
    (status) => {
      const dead: OrderReturnView = {
        ...CLOSED_RMA,
        id: 'r3',
        returnNumber: 'RMA-3',
        status,
        closedAt: null,
        lines: [{ orderRequestLineId: M_LINE, quantity: 1, disposition: 'scrap', applied: false }],
      };
      const refs = returnRefsByLine([dead]);
      // The line is registered (the panel will list the RMA) but with no
      // quantities on either side.
      expect(refs.get(M_LINE)).toEqual({
        applied: { quantity: 0, returnNumbers: [] },
        pending: { quantity: 0, returnNumbers: [] },
      });
    },
  );

  it('two RMAs on one line accumulate quantity and list both numbers once each', () => {
    const second: OrderReturnView = {
      ...CLOSED_RMA,
      id: 'r4',
      returnNumber: 'RMA-4',
      lines: [
        { orderRequestLineId: S_LINE, quantity: 2, disposition: 'scrap', applied: true },
      ],
    };
    const refs = returnRefsByLine([CLOSED_RMA, second]);
    expect(refs.get(S_LINE)?.applied).toEqual({
      quantity: 3,
      returnNumbers: ['RMA-20260817-EEF074', 'RMA-4'],
    });
  });

  it('zero / negative / non-finite quantities are ignored', () => {
    const refs = returnRefsByLine([
      {
        ...CLOSED_RMA,
        lines: [
          { orderRequestLineId: S_LINE, quantity: 0, disposition: 'restock', applied: true },
          { orderRequestLineId: S_LINE, quantity: -1, disposition: 'restock', applied: true },
          { orderRequestLineId: S_LINE, quantity: Number.NaN, disposition: 'restock', applied: true },
        ],
      },
    ]);
    expect(refs.has(S_LINE)).toBe(false);
  });

  it('isPendingReturn: exactly requested / approved / received', () => {
    expect(isPendingReturn('requested')).toBe(true);
    expect(isPendingReturn('approved')).toBe(true);
    expect(isPendingReturn('received')).toBe(true);
    expect(isPendingReturn('closed')).toBe(false);
    expect(isPendingReturn('denied')).toBe(false);
    expect(isPendingReturn('cancelled')).toBe(false);
    expect(isPendingReturn(null)).toBe(false);
  });
});

describe('describeLineFulfilment — fulfilled is never rewritten; returned is appended', () => {
  it('SO-000085 S line: requested 1, fulfilled 1, returned 1 -> "fulfilled · 1 returned"', () => {
    expect(describeLineFulfilment({ requested: 1, fulfilled: 1, returned: 1 })).toBe(
      'fulfilled · 1 returned',
    );
  });

  it('SO-000085 M / XL lines: returned 0 -> exactly the pre-feature string "fulfilled" (golden)', () => {
    expect(describeLineFulfilment({ requested: 1, fulfilled: 1, returned: 0 })).toBe('fulfilled');
    expect(describeLineFulfilment({ requested: 1, fulfilled: 1, returned: null })).toBe('fulfilled');
    expect(describeLineFulfilment({ requested: 1, fulfilled: 1, returned: undefined })).toBe(
      'fulfilled',
    );
  });

  it('partial with no return keeps the pre-feature string byte-for-byte (golden)', () => {
    expect(describeLineFulfilment({ requested: 3, fulfilled: 1, returned: 0 })).toBe(
      '1 provided · 2 owed',
    );
  });

  it('partial WITH a return: owed is untouched (requested − fulfilled), returned appended', () => {
    expect(describeLineFulfilment({ requested: 3, fulfilled: 1, returned: 1 })).toBe(
      '1 provided · 2 owed · 1 returned',
    );
  });

  it('nothing shipped and nothing returned -> null (the row shows no sub-line)', () => {
    expect(describeLineFulfilment({ requested: 2, fulfilled: 0, returned: 0 })).toBeNull();
    expect(describeLineFulfilment({ requested: 0, fulfilled: 0, returned: 0 })).toBeNull();
  });

  it('a returned figure with nothing shipped is still surfaced (data inconsistency, never hidden)', () => {
    expect(describeLineFulfilment({ requested: 1, fulfilled: 0, returned: 1 })).toBe('1 returned');
  });

  it('returnedFragment: null at 0, "N returned" above; negatives / NaN treated as 0', () => {
    expect(returnedFragment(0)).toBeNull();
    expect(returnedFragment(-2)).toBeNull();
    expect(returnedFragment(Number.NaN)).toBeNull();
    expect(returnedFragment(1)).toBe('1 returned');
    expect(returnedFragment(2)).toBe('2 returned');
  });
});

describe('orderReturnSummary — null with no returns, net = provided − returned', () => {
  it('SO-000085: 3 provided, 1 returned, net 2', () => {
    const s = orderReturnSummary([
      { fulfilled: 1, returned: 1 },
      { fulfilled: 1, returned: 0 },
      { fulfilled: 1, returned: 0 },
    ]);
    expect(s).toEqual({ totalFulfilled: 3, totalReturned: 1, netHeld: 2 });
    expect(formatOrderReturnSummary(s!)).toBe('3 provided · 1 returned · net 2 with requester');
  });

  it('no returns anywhere -> null (mutation: a single returned unit flips it to a summary)', () => {
    expect(
      orderReturnSummary([
        { fulfilled: 1, returned: 0 },
        { fulfilled: 1, returned: 0 },
      ]),
    ).toBeNull();
    expect(
      orderReturnSummary([
        { fulfilled: 1, returned: 0 },
        { fulfilled: 1, returned: 1 },
      ]),
    ).toEqual({ totalFulfilled: 2, totalReturned: 1, netHeld: 1 });
  });

  it('net floors at zero if records ever say more came back than shipped', () => {
    expect(orderReturnSummary([{ fulfilled: 1, returned: 2 }])).toEqual({
      totalFulfilled: 1,
      totalReturned: 2,
      netHeld: 0,
    });
  });

  it('the caveat names the exchange gap and points at the notes', () => {
    expect(ORDER_RETURN_SUMMARY_NOTE).toContain('received and closed');
    expect(ORDER_RETURN_SUMMARY_NOTE).toContain('not counted');
    expect(ORDER_RETURN_SUMMARY_NOTE).toContain('return notes');
  });
});

describe('labels + panel wording', () => {
  it('status labels are the six 0153 statuses, Title-cased like the web badge', () => {
    expect(RETURN_STATUS_LABELS).toEqual({
      requested: 'Requested',
      approved: 'Approved',
      received: 'Received',
      closed: 'Closed',
      denied: 'Denied',
      cancelled: 'Cancelled',
    });
    expect(returnStatusLabel('closed')).toBe('Closed');
    expect(returnStatusLabel('weird')).toBe('weird');
    expect(returnStatusLabel(null)).toBe('—');
  });

  it('reason + disposition labels', () => {
    expect(returnReasonLabel('other')).toBe('Other');
    expect(returnReasonLabel('wrong_item')).toBe('Wrong item');
    expect(returnReasonLabel(null)).toBe('—');
    expect(returnDispositionLabel('restock')).toBe('Restock');
    expect(returnDispositionLabel('scrap')).toBe('Scrap');
  });

  it('describeReturnLine: "1 × Women\'s Polo S — Restock · applied" / pending', () => {
    expect(
      describeReturnLine({ quantity: 1, itemName: "Women's Polo S", disposition: 'restock', applied: true }),
    ).toBe("1 × Women's Polo S — Restock · applied");
    expect(
      describeReturnLine({ quantity: 2, itemName: null, disposition: 'scrap', applied: false }),
    ).toBe('2 × Unknown item — Scrap · pending');
  });

  it('returnHandle: the number, else an id prefix', () => {
    expect(returnHandle(CLOSED_RMA)).toBe('RMA-20260817-EEF074');
    expect(returnHandle({ id: 'abcdef12-3456', returnNumber: null })).toBe('Return abcdef12');
  });

  it('describeLineReturnRefs names the RMA behind the figure, and any pending one', () => {
    const refs = returnRefsByLine([CLOSED_RMA]);
    expect(describeLineReturnRefs(1, refs.get(S_LINE))).toBe('1 returned on RMA-20260817-EEF074');
    expect(describeLineReturnRefs(0, refs.get(S_LINE))).toBeNull();
    // Number without any refs loaded (returns read failed / not loaded).
    expect(describeLineReturnRefs(1, undefined)).toBe('1 returned');
    const withPending = returnRefsByLine([
      CLOSED_RMA,
      {
        ...CLOSED_RMA,
        id: 'r9',
        returnNumber: 'RMA-9',
        status: 'requested',
        closedAt: null,
        lines: [{ orderRequestLineId: S_LINE, quantity: 1, disposition: 'restock', applied: false }],
      },
    ]);
    expect(describeLineReturnRefs(1, withPending.get(S_LINE))).toBe(
      '1 returned on RMA-20260817-EEF074; 1 pending on RMA-9',
    );
  });
});
