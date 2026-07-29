import { describe, expect, it } from 'vitest';

import {
  collectLegacyOrderRefIds,
  collectLegacyRefIdsByKind,
  legacyOrderRefId,
  legacyRefMatch,
  movementOrderRefId,
  movementReasonTeaser,
  orderNumberLabels,
  reasonWithoutRefLabel,
  resolveMovementRefReason,
  returnNumberLabels,
} from './movement-order-ref';

/** The real row the owner reported: prod movement -> SO-000060. */
const ORDER_ID = 'b3c7390a-b114-4839-a100-a008d3f3fde0';
const LEGACY = `Order pick (order_request ${ORDER_ID})`;
const LABELS = new Map([[ORDER_ID, 'SO-000060']]);

/** The shape the SHIPPED return RPCs (0153/0154/0197) write today. */
const RETURN_ID = 'ecbd03b4-2fbe-4e0a-8507-021a9bd3feed';
const LEGACY_RETURN = `Return restock (return ${RETURN_ID})`;
const RETURN_LABELS = new Map([[RETURN_ID, 'RMA-000012']]);

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

  // A return id here would be handed to /dashboard/orders/{id} by every
  // caller of this function — a broken link, and a claim that a return is an
  // order. `legacyRefMatch` is what reads returns.
  it('is null for a RETURN reference even though the module resolves those', () => {
    expect(legacyOrderRefId(LEGACY_RETURN)).toBeNull();
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

describe('legacyRefMatch — the kind matters, not just the id', () => {
  it('reads the return shape the shipped RMA RPCs still write', () => {
    expect(legacyRefMatch(LEGACY_RETURN)).toEqual({ kind: 'return', id: RETURN_ID });
    expect(legacyRefMatch(`Return scrap write-off (return ${RETURN_ID})`)).toEqual({
      kind: 'return',
      id: RETURN_ID,
    });
  });

  it('reads the order shape', () => {
    expect(legacyRefMatch(LEGACY)).toEqual({ kind: 'order_request', id: ORDER_ID });
  });

  it('lowercases the id so it matches a map keyed off the database value', () => {
    expect(legacyRefMatch(`Return restock (return ${RETURN_ID.toUpperCase()})`)?.id).toBe(
      RETURN_ID,
    );
  });

  it('does not invent a kind for reference types with no number to resolve', () => {
    expect(legacyRefMatch(`Something (receipt ${RETURN_ID})`)).toBeNull();
    expect(legacyRefMatch(`Something (cycle_count ${RETURN_ID})`)).toBeNull();
    expect(legacyRefMatch(null)).toBeNull();
  });
});

describe('collectLegacyRefIdsByKind — one lookup per KIND, never per row', () => {
  it('splits the page into its order and return buckets, deduped', () => {
    const other = '1d265b37-4b5c-49bb-bc12-07b0ad270cff';
    expect(
      collectLegacyRefIdsByKind([
        { reason: LEGACY },
        { reason: LEGACY },
        { reason: LEGACY_RETURN },
        { reason: `Order cancelled (order_request ${other})` },
        { reason: 'PO CVW-002201' },
        { reason: null },
      ]),
    ).toEqual({ order_request: [ORDER_ID, other], return: [RETURN_ID] });
  });

  it('always returns both buckets so a caller can hand them straight to a resolver', () => {
    expect(collectLegacyRefIdsByKind([])).toEqual({ order_request: [], return: [] });
  });
});

describe('returnNumberLabels', () => {
  it('keys by lowercased id and keeps the database string verbatim', () => {
    const map = returnNumberLabels([
      { id: RETURN_ID.toUpperCase(), return_number: 'RMA-000012' },
      { id: 'aaaaaaaa-0000-0000-0000-000000000005', return_number: null },
    ]);
    expect(map.get(RETURN_ID)).toBe('RMA-000012');
    expect(map.size).toBe(1);
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

describe('resolveMovementRefReason — the three-state contract', () => {
  it('state 2: renders the human order number', () => {
    expect(resolveMovementRefReason(LEGACY, LABELS)).toBe('Order pick (SO-000060)');
  });

  it('state 2: keeps whatever prose came before the reference', () => {
    expect(
      resolveMovementRefReason(`Order cancelled (order_request ${ORDER_ID})`, LABELS),
    ).toBe('Order cancelled (SO-000060)');
  });

  it('state 3: drops the parenthetical rather than leaking a uuid', () => {
    expect(resolveMovementRefReason(LEGACY, new Map())).toBe('Order pick');
    expect(resolveMovementRefReason(LEGACY, null)).toBe('Order pick');
    expect(resolveMovementRefReason(LEGACY)).toBe('Order pick');
  });

  it('state 3: never returns a bare uuid, whatever the map contains', () => {
    for (const map of [undefined, null, new Map(), new Map([['other-id', 'SO-000001']])]) {
      expect(resolveMovementRefReason(LEGACY, map)).not.toContain(ORDER_ID);
    }
  });

  it('state 1: rows written by migration 0306 onward pass through untouched', () => {
    expect(resolveMovementRefReason('Order pick (SO-000060)', LABELS)).toBe('Order pick (SO-000060)');
  });

  it('state 1: unrelated reasons are not cleaned — that is historyNote’s job', () => {
    expect(resolveMovementRefReason('receipt_line', LABELS)).toBe('receipt_line');
    expect(resolveMovementRefReason('moved to rack 37_B by hand', LABELS)).toBe(
      'moved to rack 37_B by hand',
    );
  });

  it('passes null/empty straight through', () => {
    expect(resolveMovementRefReason(null, LABELS)).toBeNull();
    expect(resolveMovementRefReason(undefined, LABELS)).toBeNull();
    expect(resolveMovementRefReason('', LABELS)).toBeNull();
  });

  // A reason that is ONLY the reference has no prose to keep; returning ''
  // would render as an empty cell that looks like a bug.
  it('returns just the label when there is no leading prose', () => {
    expect(resolveMovementRefReason(`(order_request ${ORDER_ID})`, LABELS)).toBe('SO-000060');
    expect(resolveMovementRefReason(`(order_request ${ORDER_ID})`, new Map())).toBeNull();
  });

  // The RMA RPCs are SHIPPED, not history: these rows keep arriving. Leaving
  // them to print raw hex on the Movements page while historyNote stripped it
  // is the same two-surface split this module exists to close.
  it('state 2: resolves a RETURN reference to its return number', () => {
    expect(resolveMovementRefReason(LEGACY_RETURN, RETURN_LABELS)).toBe(
      'Return restock (RMA-000012)',
    );
    expect(
      resolveMovementRefReason(`Return scrap write-off (return ${RETURN_ID})`, RETURN_LABELS),
    ).toBe('Return scrap write-off (RMA-000012)');
  });

  it('state 3: an unresolvable RETURN drops the parenthetical, never the hex', () => {
    expect(resolveMovementRefReason(LEGACY_RETURN, new Map())).toBe('Return restock');
    expect(resolveMovementRefReason(LEGACY_RETURN)).not.toContain(RETURN_ID);
  });

  it('resolves both kinds from ONE merged map', () => {
    const merged = new Map([...LABELS, ...RETURN_LABELS]);
    expect(resolveMovementRefReason(LEGACY, merged)).toBe('Order pick (SO-000060)');
    expect(resolveMovementRefReason(LEGACY_RETURN, merged)).toBe('Return restock (RMA-000012)');
  });
});

describe('reasonWithoutRefLabel — the handle is printed once, not twice', () => {
  it('drops the trailing label the surface renders as its own chip', () => {
    expect(reasonWithoutRefLabel('Order pick (SO-000060)', 'SO-000060')).toBe('Order pick');
    expect(reasonWithoutRefLabel('Return restock (RMA-000012)', 'RMA-000012')).toBe(
      'Return restock',
    );
  });

  it('leaves a reason that does not end in that label alone', () => {
    expect(reasonWithoutRefLabel('Order pick (SO-000060)', 'SO-000099')).toBe(
      'Order pick (SO-000060)',
    );
    expect(reasonWithoutRefLabel('moved to rack 37_B by hand', 'SO-000060')).toBe(
      'moved to rack 37_B by hand',
    );
    // A generic type label (no number resolved) must not eat real prose.
    expect(reasonWithoutRefLabel('Order pick', 'Order')).toBe('Order pick');
  });

  it('collapses to null when the reason was nothing but the label', () => {
    expect(reasonWithoutRefLabel('(SO-000060)', 'SO-000060')).toBeNull();
  });

  it('passes null/absent through', () => {
    expect(reasonWithoutRefLabel(null, 'SO-000060')).toBeNull();
    expect(reasonWithoutRefLabel('Order pick', null)).toBe('Order pick');
  });
});

describe('movementReasonTeaser — the phone home tab says what the web widget says', () => {
  it('resolves the reference exactly like every other surface', () => {
    expect(movementReasonTeaser(LEGACY, LABELS)).toBe('Order pick (SO-000060)');
    expect(movementReasonTeaser(LEGACY_RETURN, RETURN_LABELS)).toBe('Return restock (RMA-000012)');
  });

  it('keeps the number migration 0306 writes (this used to be stripped away)', () => {
    expect(movementReasonTeaser('Order pick (SO-000060)')).toBe('Order pick (SO-000060)');
  });

  it('never lets a uuid reach the card, resolved or not', () => {
    expect(movementReasonTeaser(LEGACY)).toBe('Order pick');
    expect(movementReasonTeaser(`Scrapped (receipt ${RETURN_ID})`)).toBe('Scrapped');
    // A reason that is nothing but an id is not words — render nothing.
    expect(movementReasonTeaser(RETURN_ID, LABELS)).toBeNull();
  });

  it('clamps a long reason instead of wrapping the row', () => {
    const long = 'Moved because the pallet was blocking the fire door in aisle twelve';
    const out = movementReasonTeaser(long) as string;
    expect(out.length).toBeLessThanOrEqual(38);
    expect(out.endsWith('…')).toBe(true);
    expect(long.startsWith(out.slice(0, -1))).toBe(true);
  });

  it('does not clamp what already fits, and returns null for nothing', () => {
    expect(movementReasonTeaser('Order pick (SO-000060)')).toBe('Order pick (SO-000060)');
    expect(movementReasonTeaser(null)).toBeNull();
    expect(movementReasonTeaser('   ')).toBeNull();
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
