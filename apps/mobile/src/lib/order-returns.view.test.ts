import { describe, expect, it } from 'vitest';

import {
  describeLineFulfilment,
  describeReturnLine,
  describeReturnMeta,
  formatOrderReturnSummary,
  ORDER_RETURNS_SELECT,
  orderReturnSummary,
  parseOrderReturns,
  returnLineCountsAsReturned,
  returnLineItemName,
  returnRefsByLine,
  returnStatusLabel,
  RETURN_REASONS,
  RETURN_STATUS_LABELS,
  shouldLoadOrderReturns,
  shouldShowReturnsSection,
  type RawOrderReturnLineRow,
  type RawOrderReturnRow,
} from './order-returns';

/**
 * The order screen's returns view — the decisions the screen renders and
 * nothing else (app/order/[id].tsx only maps rows through these and prints).
 *
 * SO-000085 as prod holds it (read-only, 2026-08-17): three lines 1/1 each,
 * one CLOSED RMA whose single line restocked the Women's Polo S (applied), so
 * that order line carries returned_quantity 1; the swap for a Medium is in the
 * notes only.
 */
const RAW_LINE: RawOrderReturnLineRow = {
  id: 'rl-1',
  order_request_line_id: '5e840bc6-0000-0000-0000-000000000000',
  item_id: 'item-s',
  quantity: 1,
  disposition: 'restock',
  applied: true,
};

const RAW_CLOSED: RawOrderReturnRow = {
  id: '85d6084b-1111-2222-3333-444444444444',
  return_number: 'RMA-20260817-EEF074',
  status: 'closed',
  reason_code: 'other',
  notes: 'Size S New Hire shirt was swapped out for Ladies size M',
  created_at: '2026-08-17T17:10:00Z',
  closed_at: '2026-08-17T17:12:00Z',
  lines: [RAW_LINE],
};

const ORDER_LINES = [
  { orderRequestLineId: '5e840bc6-0000-0000-0000-000000000000', name: "Women's Polo S" },
  { orderRequestLineId: 'line-m', name: "Women's Polo M" },
  { orderRequestLineId: 'line-xl', name: "Men's Polo XL" },
];

describe('parseOrderReturns — the raw read to the shared view', () => {
  it('maps the closed RMA with its applied line', () => {
    expect(parseOrderReturns([RAW_CLOSED])).toEqual([
      {
        id: RAW_CLOSED.id,
        returnNumber: 'RMA-20260817-EEF074',
        status: 'closed',
        reasonCode: 'other',
        notes: 'Size S New Hire shirt was swapped out for Ladies size M',
        createdAt: '2026-08-17T17:10:00Z',
        closedAt: '2026-08-17T17:12:00Z',
        lines: [
          {
            orderRequestLineId: '5e840bc6-0000-0000-0000-000000000000',
            itemId: 'item-s',
            quantity: 1,
            disposition: 'restock',
            applied: true,
          },
        ],
      },
    ]);
  });

  it('applied is the `=== true` latch: null / false / missing read as NOT applied', () => {
    const [r] = parseOrderReturns([
      {
        ...RAW_CLOSED,
        lines: [
          { ...RAW_LINE, applied: null },
          { ...RAW_LINE, id: 'rl-2', applied: false },
        ],
      },
    ]);
    expect(r!.lines.map((l) => l.applied)).toEqual([false, false]);
    expect(r!.lines.every((l) => !returnLineCountsAsReturned(l))).toBe(true);
  });

  it('tolerates a to-one embed (object, not array), a null embed, string quantities and a null input', () => {
    const [obj] = parseOrderReturns([
      { ...RAW_CLOSED, lines: { ...RAW_LINE, quantity: '2' } },
    ]);
    expect(obj!.lines).toHaveLength(1);
    expect(obj!.lines[0]!.quantity).toBe(2);
    const [none] = parseOrderReturns([{ ...RAW_CLOSED, lines: null }]);
    expect(none!.lines).toEqual([]);
    expect(parseOrderReturns(null)).toEqual([]);
    expect(parseOrderReturns(undefined)).toEqual([]);
  });

  it('the select string names every column the parser reads, and the embed', () => {
    for (const col of [
      'id',
      'return_number',
      'status',
      'reason_code',
      'notes',
      'created_at',
      'closed_at',
      'lines:return_lines',
      'order_request_line_id',
      'item_id',
      'quantity',
      'disposition',
      'applied',
    ]) {
      expect(ORDER_RETURNS_SELECT).toContain(col);
    }
  });
});

describe('gates', () => {
  it('shouldLoadOrderReturns: completed + legacy delivered only', () => {
    expect(shouldLoadOrderReturns('completed')).toBe(true);
    expect(shouldLoadOrderReturns('delivered')).toBe(true);
    for (const s of ['approved', 'in_transit', 'backordered', 'cancelled', 'denied', null, undefined, '']) {
      expect(shouldLoadOrderReturns(s)).toBe(false);
    }
  });

  it('shouldShowReturnsSection: any return to list, or the create affordance', () => {
    expect(shouldShowReturnsSection({ returnsCount: 0, canCreateReturn: false })).toBe(false);
    expect(shouldShowReturnsSection({ returnsCount: 1, canCreateReturn: false })).toBe(true);
    expect(shouldShowReturnsSection({ returnsCount: 0, canCreateReturn: true })).toBe(true);
  });
});

describe('what the screen prints — through THIS module (what web pins against)', () => {
  it('SO-000085 per line: S "fulfilled · 1 returned"; M and XL exactly "fulfilled" (unchanged)', () => {
    expect(describeLineFulfilment({ requested: 1, fulfilled: 1, returned: 1 })).toBe(
      'fulfilled · 1 returned',
    );
    expect(describeLineFulfilment({ requested: 1, fulfilled: 1, returned: 0 })).toBe('fulfilled');
  });

  it('a partial line with no return keeps the pre-feature sub-line byte-for-byte', () => {
    expect(describeLineFulfilment({ requested: 3, fulfilled: 1, returned: 0 })).toBe(
      '1 provided · 2 owed',
    );
    expect(describeLineFulfilment({ requested: 3, fulfilled: 0, returned: 0 })).toBeNull();
  });

  it('SO-000085 summary: "3 provided · 1 returned · net 2 with requester"; null with no returns', () => {
    const s = orderReturnSummary([
      { fulfilled: 1, returned: 1 },
      { fulfilled: 1, returned: 0 },
      { fulfilled: 1, returned: 0 },
    ]);
    expect(formatOrderReturnSummary(s!)).toBe('3 provided · 1 returned · net 2 with requester');
    expect(
      orderReturnSummary([
        { fulfilled: 1, returned: 0 },
        { fulfilled: 1, returned: 0 },
      ]),
    ).toBeNull();
  });

  it('an in-flight (requested) return is PENDING on its line, not returned; a denied one is neither', () => {
    const [closed] = parseOrderReturns([RAW_CLOSED]);
    const [pending] = parseOrderReturns([
      {
        ...RAW_CLOSED,
        id: 'r2',
        return_number: 'RMA-2',
        status: 'requested',
        closed_at: null,
        lines: [{ ...RAW_LINE, order_request_line_id: 'line-m', applied: false }],
      },
    ]);
    const [denied] = parseOrderReturns([
      {
        ...RAW_CLOSED,
        id: 'r3',
        return_number: 'RMA-3',
        status: 'denied',
        closed_at: null,
        lines: [{ ...RAW_LINE, order_request_line_id: 'line-xl', applied: false }],
      },
    ]);
    const refs = returnRefsByLine([closed!, pending!, denied!]);
    expect(refs.get('5e840bc6-0000-0000-0000-000000000000')?.applied).toEqual({
      quantity: 1,
      returnNumbers: ['RMA-20260817-EEF074'],
    });
    expect(refs.get('line-m')).toEqual({
      applied: { quantity: 0, returnNumbers: [] },
      pending: { quantity: 1, returnNumbers: ['RMA-2'] },
    });
    expect(refs.get('line-xl')).toEqual({
      applied: { quantity: 0, returnNumbers: [] },
      pending: { quantity: 0, returnNumbers: [] },
    });
  });

  it('panel row: "1 × Women\'s Polo S — Restock · applied", item name joined from the order lines', () => {
    const [r] = parseOrderReturns([RAW_CLOSED]);
    const l = r!.lines[0]!;
    expect(returnLineItemName(l, ORDER_LINES)).toBe("Women's Polo S");
    expect(
      describeReturnLine({
        quantity: l.quantity,
        itemName: returnLineItemName(l, ORDER_LINES),
        disposition: l.disposition,
        applied: l.applied,
      }),
    ).toBe("1 × Women's Polo S — Restock · applied");
    // Order line gone: id prefix; no item id at all: null (the describer says Unknown item).
    expect(returnLineItemName({ orderRequestLineId: 'nope', itemId: 'abcdef12-xyz' }, ORDER_LINES)).toBe(
      'Item abcdef12',
    );
    expect(returnLineItemName({ orderRequestLineId: 'nope', itemId: null }, ORDER_LINES)).toBeNull();
  });

  it('status words are the web badge words; reason words match RETURN_REASONS', () => {
    expect(returnStatusLabel('closed')).toBe('Closed');
    expect(RETURN_STATUS_LABELS.requested).toBe('Requested');
    for (const r of RETURN_REASONS) {
      expect(describeReturnMeta({ reasonCode: r.value, createdAt: '2026-08-17T17:10:00Z', closedAt: null })).toMatch(
        new RegExp(`^${r.label} · `),
      );
    }
  });

  it('describeReturnMeta prefers the closed date, and passes an unparseable date through', () => {
    const closed = describeReturnMeta({
      reasonCode: 'other',
      createdAt: '2020-01-01T00:00:00Z',
      closedAt: '2026-08-17T17:12:00Z',
    });
    expect(closed.startsWith('Other · ')).toBe(true);
    expect(closed).toContain('2026');
    expect(closed).not.toContain('2020');
    expect(describeReturnMeta({ reasonCode: null, createdAt: 'garbage', closedAt: null })).toBe('— · garbage');
  });
});
