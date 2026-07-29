import { describe, expect, it } from 'vitest';

import {
  collectLegacyOrderRefIds,
  legacyOrderRefId,
  movementOrderRefId,
  orderNumberLabels,
  resolveOrderRefReason,
} from './movement-order-ref';

/** The real row the owner reported: prod movement -> SO-000060. */
const ORDER_ID = 'b3c7390a-b114-4839-a100-a008d3f3fde0';
const LEGACY = `Order pick (order_request ${ORDER_ID})`;
const LABELS = new Map([[ORDER_ID, 'SO-000060']]);

describe('legacyOrderRefId', () => {
  it('extracts the order id complete_picking stringified into the reason', () => {
    expect(legacyOrderRefId(LEGACY)).toBe(ORDER_ID);
  });

  it('reads cancel_order_request rows too — same parenthetical, different prose', () => {
    expect(
      legacyOrderRefId('Order cancelled (order_request 1d265b37-4b5c-49bb-bc12-07b0ad270cff)'),
    ).toBe('1d265b37-4b5c-49bb-bc12-07b0ad270cff');
  });

  it('lowercases so the id always matches a map keyed off the database value', () => {
    expect(legacyOrderRefId(`Order pick (order_request ${ORDER_ID.toUpperCase()})`)).toBe(ORDER_ID);
  });

  it('is null for reasons with no order reference', () => {
    expect(legacyOrderRefId(null)).toBeNull();
    expect(legacyOrderRefId(undefined)).toBeNull();
    expect(legacyOrderRefId('')).toBeNull();
    expect(legacyOrderRefId('Cycle count adjustment')).toBeNull();
    expect(legacyOrderRefId('PO CVW-002201')).toBeNull();
  });

  // Other reference types have no order number to resolve to; they are
  // TRAILING_REF_RE's job (strip), never this module's (resolve).
  it('ignores non-order reference types', () => {
    expect(legacyOrderRefId('Return restock (return ecbd03b4-2fbe-4e0a-8507-021a9bd3feed)')).toBeNull();
    expect(legacyOrderRefId('Something (receipt ecbd03b4-2fbe-4e0a-8507-021a9bd3feed)')).toBeNull();
  });

  it('does not match a non-uuid in the parenthetical', () => {
    expect(legacyOrderRefId('Order pick (order_request 60)')).toBeNull();
    expect(legacyOrderRefId('Order pick (SO-000060)')).toBeNull();
  });

  // Anchored to the end so it can never chew a parenthetical out of the
  // middle of prose an operator typed.
  it('only matches at the end of the reason', () => {
    expect(legacyOrderRefId(`Order pick (order_request ${ORDER_ID}) and then some`)).toBeNull();
  });
});

describe('collectLegacyOrderRefIds — one lookup per page, not per row', () => {
  it('dedupes ids across rows and skips rows with no reference', () => {
    const other = '1d265b37-4b5c-49bb-bc12-07b0ad270cff';
    expect(
      collectLegacyOrderRefIds([
        { reason: LEGACY },
        { reason: LEGACY },
        { reason: `Order cancelled (order_request ${other})` },
        { reason: 'PO CVW-002201' },
        { reason: null },
        { reason: undefined },
      ]),
    ).toEqual([ORDER_ID, other]);
  });

  it('is empty for a page with no legacy rows (caller then runs no query)', () => {
    expect(collectLegacyOrderRefIds([{ reason: 'Order pick (SO-000060)' }])).toEqual([]);
    expect(collectLegacyOrderRefIds([])).toEqual([]);
  });
});

describe('orderNumberLabels — formatting lives in core, once', () => {
  it('zero-pads to six through formatOrderNumber', () => {
    const map = orderNumberLabels([
      { id: ORDER_ID, order_number: 60 },
      { id: 'aaaaaaaa-0000-0000-0000-000000000001', order_number: 1 },
      { id: 'aaaaaaaa-0000-0000-0000-000000000002', order_number: 1234567 },
    ]);
    expect(map.get(ORDER_ID)).toBe('SO-000060');
    expect(map.get('aaaaaaaa-0000-0000-0000-000000000001')).toBe('SO-000001');
    // Past six digits it stops padding rather than truncating a real number.
    expect(map.get('aaaaaaaa-0000-0000-0000-000000000002')).toBe('SO-1234567');
  });

  // Absent from the map => the caller lands on the "drop the parenthetical"
  // path, which is the whole point: never render "SO-" with nothing after it.
  it('omits rows with no usable number rather than inventing a label', () => {
    const map = orderNumberLabels([
      { id: 'aaaaaaaa-0000-0000-0000-000000000003', order_number: null },
      { id: 'aaaaaaaa-0000-0000-0000-000000000004', order_number: 0 },
    ]);
    expect(map.size).toBe(0);
  });
});

describe('resolveOrderRefReason — the three-state contract', () => {
  it('state 2: renders the human order number', () => {
    expect(resolveOrderRefReason(LEGACY, LABELS)).toBe('Order pick (SO-000060)');
  });

  it('state 2: keeps whatever prose came before the reference', () => {
    expect(
      resolveOrderRefReason(`Order cancelled (order_request ${ORDER_ID})`, LABELS),
    ).toBe('Order cancelled (SO-000060)');
  });

  it('state 3: drops the parenthetical rather than leaking a uuid', () => {
    expect(resolveOrderRefReason(LEGACY, new Map())).toBe('Order pick');
    expect(resolveOrderRefReason(LEGACY, null)).toBe('Order pick');
    expect(resolveOrderRefReason(LEGACY)).toBe('Order pick');
  });

  it('state 3: never returns a bare uuid, whatever the map contains', () => {
    for (const map of [undefined, null, new Map(), new Map([['other-id', 'SO-000001']])]) {
      expect(resolveOrderRefReason(LEGACY, map)).not.toContain(ORDER_ID);
    }
  });

  it('state 1: rows written by migration 0306 onward pass through untouched', () => {
    expect(resolveOrderRefReason('Order pick (SO-000060)', LABELS)).toBe('Order pick (SO-000060)');
  });

  it('state 1: unrelated reasons are not cleaned — that is historyNote’s job', () => {
    expect(resolveOrderRefReason('receipt_line', LABELS)).toBe('receipt_line');
    expect(resolveOrderRefReason('moved to rack 37_B by hand', LABELS)).toBe(
      'moved to rack 37_B by hand',
    );
  });

  it('passes null/empty straight through', () => {
    expect(resolveOrderRefReason(null, LABELS)).toBeNull();
    expect(resolveOrderRefReason(undefined, LABELS)).toBeNull();
    expect(resolveOrderRefReason('', LABELS)).toBeNull();
  });

  // A reason that is ONLY the reference has no prose to keep; returning ''
  // would render as an empty cell that looks like a bug.
  it('returns just the label when there is no leading prose', () => {
    expect(resolveOrderRefReason(`(order_request ${ORDER_ID})`, LABELS)).toBe('SO-000060');
    expect(resolveOrderRefReason(`(order_request ${ORDER_ID})`, new Map())).toBeNull();
  });
});

describe('movementOrderRefId — what the link points at', () => {
  it('prefers the reference columns (0306+ rows)', () => {
    expect(
      movementOrderRefId({
        reason: 'Order pick (SO-000060)',
        reference_type: 'order_request',
        reference_id: ORDER_ID,
      }),
    ).toBe(ORDER_ID);
  });

  it('falls back to the legacy reason for the rows already in the ledger', () => {
    expect(
      movementOrderRefId({ reason: LEGACY, reference_type: null, reference_id: null }),
    ).toBe(ORDER_ID);
  });

  it('ignores reference columns of another type', () => {
    expect(
      movementOrderRefId({
        reason: 'Return restock (return ecbd03b4-2fbe-4e0a-8507-021a9bd3feed)',
        reference_type: 'return',
        reference_id: 'ecbd03b4-2fbe-4e0a-8507-021a9bd3feed',
      }),
    ).toBeNull();
  });

  it('is null when there is nothing to link to', () => {
    expect(movementOrderRefId({ reason: 'PO CVW-002201' })).toBeNull();
    expect(movementOrderRefId({})).toBeNull();
  });
});
