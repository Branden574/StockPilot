import { describe, expect, it } from 'vitest';

import {
  buildReturnPayload,
  initialReturnDraft,
  RETURN_REASONS,
  returnableLines,
  type ReturnableLine,
  type ReturnSourceLine,
} from './order-returns';

function line(over: Partial<ReturnSourceLine> = {}): ReturnSourceLine {
  return {
    orderRequestLineId: 'l-1',
    name: 'Widget',
    sku: 'W-1',
    quantityFulfilled: 4,
    returnedQuantity: 0,
    ...over,
  };
}

describe('returnableLines', () => {
  it('computes remaining = fulfilled − returned on a completed order', () => {
    const out = returnableLines('completed', [
      line({ quantityFulfilled: 4, returnedQuantity: 1 }),
    ]);
    expect(out).toEqual([
      {
        orderRequestLineId: 'l-1',
        name: 'Widget',
        sku: 'W-1',
        quantityFulfilled: 4,
        quantityRemaining: 3,
      },
    ]);
  });

  it('accepts the legacy delivered status (same set the service gates on)', () => {
    expect(returnableLines('delivered', [line()])).toHaveLength(1);
  });

  it('is empty on any non-terminal status — the affordance hides', () => {
    for (const status of ['pending_approval', 'approved', 'picking_in_progress', 'in_transit', 'backordered', 'cancelled', 'denied']) {
      expect(returnableLines(status, [line()])).toEqual([]);
    }
    expect(returnableLines(null, [line()])).toEqual([]);
    expect(returnableLines(undefined, [line()])).toEqual([]);
  });

  it('drops fully-returned lines (remaining 0) and never-fulfilled lines', () => {
    expect(
      returnableLines('completed', [
        line({ orderRequestLineId: 'l-a', quantityFulfilled: 2, returnedQuantity: 2 }),
        line({ orderRequestLineId: 'l-b', quantityFulfilled: 0 }),
        line({ orderRequestLineId: 'l-c', quantityFulfilled: 3, returnedQuantity: 1 }),
      ]).map((l) => l.orderRequestLineId),
    ).toEqual(['l-c']);
  });

  it('drops lines without an id and treats non-finite quantities as 0', () => {
    expect(
      returnableLines('completed', [
        line({ orderRequestLineId: null }),
        line({ orderRequestLineId: 'l-nan', quantityFulfilled: Number.NaN }),
        line({ orderRequestLineId: 'l-neg', quantityFulfilled: 2, returnedQuantity: -1 }),
      ]),
    ).toEqual([
      {
        orderRequestLineId: 'l-neg',
        name: 'Widget',
        sku: 'W-1',
        quantityFulfilled: 2,
        quantityRemaining: 2,
      },
    ]);
  });
});

describe('initialReturnDraft', () => {
  it('starts every line unselected (qty 0) with Restock as the default', () => {
    const lines: ReturnableLine[] = [
      { orderRequestLineId: 'l-1', name: 'A', sku: null, quantityFulfilled: 2, quantityRemaining: 2 },
      { orderRequestLineId: 'l-2', name: 'B', sku: 'B-2', quantityFulfilled: 5, quantityRemaining: 3 },
    ];
    expect(initialReturnDraft(lines)).toEqual({
      'l-1': { quantity: 0, disposition: 'restock' },
      'l-2': { quantity: 0, disposition: 'restock' },
    });
  });
});

describe('buildReturnPayload', () => {
  const lines: ReturnableLine[] = [
    { orderRequestLineId: 'l-1', name: 'Widget', sku: 'W-1', quantityFulfilled: 4, quantityRemaining: 3 },
    { orderRequestLineId: 'l-2', name: 'Gadget', sku: null, quantityFulfilled: 2, quantityRemaining: 2 },
  ];

  it('builds the pinned body: only qty>0 lines, with reason and trimmed notes', () => {
    const res = buildReturnPayload({
      lines,
      draft: {
        'l-1': { quantity: 2, disposition: 'restock' },
        'l-2': { quantity: 0, disposition: 'scrap' },
      },
      reasonCode: 'damaged',
      notes: '  crushed box  ',
    });
    expect(res).toEqual({
      ok: true,
      body: {
        reasonCode: 'damaged',
        notes: 'crushed box',
        lines: [{ orderRequestLineId: 'l-1', quantity: 2, disposition: 'restock' }],
      },
    });
  });

  it('omits reasonCode and notes when absent/blank (both optional server-side)', () => {
    const res = buildReturnPayload({
      lines,
      draft: { 'l-2': { quantity: 1, disposition: 'scrap' } },
      reasonCode: null,
      notes: '   ',
    });
    expect(res).toEqual({
      ok: true,
      body: { lines: [{ orderRequestLineId: 'l-2', quantity: 1, disposition: 'scrap' }] },
    });
  });

  it('keeps the per-line disposition (Restock and Scrap can mix in one return)', () => {
    const res = buildReturnPayload({
      lines,
      draft: {
        'l-1': { quantity: 1, disposition: 'scrap' },
        'l-2': { quantity: 2, disposition: 'restock' },
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.body.lines).toEqual([
        { orderRequestLineId: 'l-1', quantity: 1, disposition: 'scrap' },
        { orderRequestLineId: 'l-2', quantity: 2, disposition: 'restock' },
      ]);
    }
  });

  it('rejects an empty selection', () => {
    const res = buildReturnPayload({ lines, draft: initialReturnDraft(lines) });
    expect(res).toEqual({ ok: false, error: 'Select at least one item to return.' });
  });

  it('rejects a quantity over the remaining budget (cap mirrors the stepper)', () => {
    const res = buildReturnPayload({
      lines,
      draft: { 'l-1': { quantity: 4, disposition: 'restock' } },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Only 3 of "Widget"/);
  });

  it('rejects non-integer quantities', () => {
    const res = buildReturnPayload({
      lines,
      draft: { 'l-1': { quantity: 1.5, disposition: 'restock' } },
    });
    expect(res).toEqual({ ok: false, error: 'Quantities must be whole numbers.' });
  });
});

describe('RETURN_REASONS', () => {
  it('matches the web dialog options (the server enum)', () => {
    expect(RETURN_REASONS.map((r) => r.value)).toEqual([
      'damaged',
      'wrong_item',
      'end_of_year',
      'overage',
      'other',
    ]);
  });
});
