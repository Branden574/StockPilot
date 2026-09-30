import { describe, expect, it } from 'vitest';

import {
  assessOrderReadiness,
  orderReadinessPhase,
  type OrderReadinessFacts,
  type ReadinessItemFacts,
  type ReadinessVisibleItemFacts,
} from './readiness';
import {
  canDraftShortfallPo,
  checkShortfallSelection,
  defaultShortfallSelection,
  keepShortfallSelection,
  parseShortfallChangedDetail,
  parseShortfallPoResult,
  parseShortfallQuantity,
  SHORTFALL_NO_SUPPLIER_COPY,
  SHORTFALL_PO_BUSY_COPY,
  SHORTFALL_PO_CHANGED_COPY,
  SHORTFALL_PO_CONFLICT_COPY,
  SHORTFALL_PO_FAILED_COPY,
  SHORTFALL_PO_FORBIDDEN_COPY,
  SHORTFALL_PO_INVALID_COPY,
  SHORTFALL_PO_ITEM_NOT_DRAFTABLE_COPY,
  SHORTFALL_PO_LINE_NOT_ON_ORDER_COPY,
  SHORTFALL_PO_LINES_CAPPED_COPY,
  SHORTFALL_PO_NO_WAREHOUSE_ACCESS_COPY,
  SHORTFALL_PO_NOT_APPLICABLE_COPY,
  SHORTFALL_PO_NOT_SENT_COPY,
  SHORTFALL_PO_NOTHING_LEFT_COPY,
  SHORTFALL_PO_NOTHING_SHORT_COPY,
  SHORTFALL_PO_NOTHING_VISIBLE_SHORT_COPY,
  SHORTFALL_PO_PHONE_REVIEW_COPY,
  SHORTFALL_PO_PURCHASE_ORDERS_OFF_COPY,
  SHORTFALL_PO_TIMELINE_LABEL,
  SHORTFALL_SUPPLIER_UNKNOWN_COPY,
  shortfallCoveredByCopy,
  shortfallDraftGroups,
  shortfallIdempotencyKey,
  shortfallPoCreatedCopy,
  shortfallPoCreatedRowCopy,
  shortfallPoFooterCopy,
  shortfallPoRetryable,
  ShortfallPoResultShapeError,
  shortfallPoView,
  shortfallQuantityProblem,
  shortfallQuantityProblemCopy,
  shortfallRequestSignature,
  shortfallRowAccessibilityLabel,
  shortfallSupplierLabel,
  type ShortfallPoView,
  // F2-5 review fixes
  missingShortfallSupplierIds,
  readShortfallSupplierRows,
  SHORTFALL_PO_CANCEL_LABEL,
  SHORTFALL_PO_CLOSE_LABEL,
  SHORTFALL_PO_NO_ANSWER_COPY,
  SHORTFALL_PO_OPEN_DRAFT_HINT,
  SHORTFALL_PO_PHONE_STRIP_HINT,
  SHORTFALL_PO_QUANTITY_LABEL,
  SHORTFALL_PO_TIMEOUT_COPY,
  SHORTFALL_PO_TOO_MANY_COPY,
  SHORTFALL_PO_UNREADABLE_COPY,
  SHORTFALL_SUPPLIER_NOT_FOUND_COPY,
  shortfallArchivedSupplierCopy,
  shortfallPoTimelineDetail,
  shortfallRefusalCopy,
  shortfallSupplierIds,
  shortfallUnchosenCopy,
  shortfallViewWithMaxima,
} from './shortfall-po';

// ── Builders (the readiness facts, as order_readiness_facts returns them) ────

const WH = 'wh-home';
const NOW = '2026-09-30T12:00:00.000Z';
const SUP1 = '00000000-0000-4000-8000-0000000000e1';
const SUP2 = '00000000-0000-4000-8000-0000000000e2';

function item(itemId: string, over: Partial<ReadinessVisibleItemFacts> = {}): ReadinessVisibleItemFacts {
  const here = { rack: 0, site: 0, unplaced: 0, staging: 0, ...over.here };
  const elsewhere = { pickable: 0, staging: 0, ...over.elsewhere };
  return {
    itemId,
    visible: true,
    name: `Item ${itemId}`,
    sku: `SKU-${itemId}`,
    supplierId: SUP1,
    itemWarehouseId: WH,
    deleted: false,
    archived: false,
    isBundle: false,
    heldOwn: 0,
    heldOtherOrders: 0,
    heldRentals: 0,
    stagingSources: [],
    stagingHiddenQty: 0,
    pendingOthers: { orders: 0, units: 0 },
    committedOtherShortfall: 0,
    inbound: { rows: [], hiddenRemaining: 0, truncated: false, truncatedRemaining: 0 },
    drafts: { rows: [], hiddenRemaining: 0, truncated: false, truncatedRemaining: 0 },
    ...over,
    here,
    elsewhere,
    onHand: over.onHand ?? here.rack + here.site + here.unplaced + here.staging + elsewhere.pickable + elsewhere.staging,
  };
}

function facts(
  lines: Array<{ id: string; item: string; requested: number; fulfilled?: number }>,
  items: ReadinessItemFacts[],
  opts: { status?: string; linesCapped?: boolean } = {},
): OrderReadinessFacts {
  const status = opts.status ?? 'pending_approval';
  return {
    v: 1,
    observedAt: NOW,
    phase: orderReadinessPhase(status),
    linesCapped: opts.linesCapped ?? false,
    order: { id: 'order-1', orderNumber: 123, status, warehouseId: WH, neededBy: null, fulfillmentType: 'pickup' },
    lines: lines.map((l, i) => ({
      lineId: l.id,
      itemId: l.item,
      requested: l.requested,
      fulfilled: l.fulfilled ?? 0,
      picked: null,
      createdAt: new Date(Date.UTC(2026, 8, 1, 10, 0, i)).toISOString(),
    })),
    items,
  };
}

function view(f: OrderReadinessFacts): ShortfallPoView {
  return shortfallPoView(assessOrderReadiness(f, { now: NOW }));
}

const inbound = (rows: Array<[string, number]>, extra: { hidden?: number; truncated?: number } = {}) => ({
  rows: rows.map(([poNumber, remaining], i) => ({
    poId: `po-${i}`,
    poNumber,
    status: 'ordered',
    expectedAt: null,
    remaining,
  })),
  hiddenRemaining: extra.hidden ?? 0,
  truncated: (extra.truncated ?? 0) > 0,
  truncatedRemaining: extra.truncated ?? 0,
});
const drafts = (rows: Array<[string, number]>, hidden = 0) => ({
  rows: rows.map(([poNumber, remaining], i) => ({ poId: `d-${i}`, poNumber, remaining })),
  hiddenRemaining: hidden,
  truncated: false,
  truncatedRemaining: 0,
});

// ── Who may draft ───────────────────────────────────────────────────────────

describe('canDraftShortfallPo (the database floors, for the screens)', () => {
  it('needs a manager, purchase_orders:manage and both modules', () => {
    const all = { isManager: true, canManagePurchaseOrders: true, ordersModule: true, purchaseOrdersModule: true };
    expect(canDraftShortfallPo(all)).toBe(true);
    for (const k of Object.keys(all) as Array<keyof typeof all>) {
      expect(canDraftShortfallPo({ ...all, [k]: false }), k).toBe(false);
    }
    // Staff with a purchase_orders:manage override: not a manager (the
    // database refuses them, manager_required).
    expect(canDraftShortfallPo({ ...all, isManager: false })).toBe(false);
    expect(SHORTFALL_PO_FORBIDDEN_COPY).toBe('Drafting a PO needs a manager with purchase-order access.');
  });
});

// ── The view ────────────────────────────────────────────────────────────────

describe('shortfallPoView', () => {
  it('one row per short item: what is short, what already covers part of it, and what may be drafted (core draftable)', () => {
    const v = view(
      facts(
        [
          { id: 'l1', item: 'a', requested: 12 },
          { id: 'l2', item: 'b', requested: 5 },
          { id: 'l3', item: 'c', requested: 3 },
        ],
        [
          // a: 12 owed, 2 on hand: 10 short; an open PO 3 + a draft 2, other
          // orders' committed shortfall 4 -> 10 - max(0, 5 - 4) = 9.
          item('a', {
            here: { rack: 2, site: 0, unplaced: 0, staging: 0 },
            inbound: inbound([['PO-2026-0021', 3]]),
            drafts: drafts([['PO-2026-0043', 2]]),
            committedOtherShortfall: 4,
          }),
          // b: 5 short, nothing on order.
          item('b', { supplierId: null }),
          // c: not short (5 on the shelf for 3).
          item('c', { here: { rack: 5, site: 0, unplaced: 0, staging: 0 } }),
        ],
      ),
    );
    expect(v.unavailable).toBeNull();
    expect(v.orderNumber).toBe('SO-000123');
    expect(v.rows.map((r) => [r.itemId, r.state, r.short, r.onOrderOrDraft, r.draftable, r.detail])).toEqual([
      // The 4 other orders need is said too (review: the row hid it).
      ['a', 'draftable', 10, 1, 9, 'Short 10 · already on order or draft 1 · 4 more on order or draft are already needed by other orders'],
      ['b', 'draftable', 5, 0, 5, 'Short 5'],
    ]);
    expect(v.draftableCount).toBe(2);
    expect(v.hiddenItems).toBe(0);
    expect(v.hiddenNote).toBeNull();
  });

  // Review (numbers lens): two approved orders each 10 short of X, nothing
  // held. Drafting 10 for SO-A leaves SO-A's draftable at 10 (SO-B's 10 takes
  // that draft first), and the row said only "Short 10": the draft just made
  // was invisible and drafting was offered again.
  it('a row says when what is on order or on a draft is already needed by other orders', () => {
    const v = view(
      facts(
        [
          { id: 'l1', item: 'a', requested: 10 },
          { id: 'l2', item: 'b', requested: 12 },
          { id: 'l3', item: 'c', requested: 5 },
        ],
        [
          // a: 10 short; a draft of 10; another approved order 10 short: 10 - max(0, 10 - 10) = 10.
          item('a', { drafts: drafts([['PO-2026-0001', 10]]), committedOtherShortfall: 10 }),
          // b: 12 short; 6 on order + 2 on a draft; other orders need 3: 12 - max(0, 8 - 3) = 7.
          item('b', {
            inbound: inbound([['PO-2026-0002', 6]]),
            drafts: drafts([['PO-2026-0003', 2]]),
            committedOtherShortfall: 3,
          }),
          // c: 5 short; 1 on order, 1 needed elsewhere: all 5 draftable.
          item('c', { inbound: inbound([['PO-2026-0004', 1]]), committedOtherShortfall: 1 }),
        ],
      ),
    );
    expect(v.rows.map((r) => [r.itemId, r.draftable, r.onOrderOrDraft, r.detail])).toEqual([
      ['a', 10, 0, 'Short 10 · 10 on order or draft are already needed by other orders'],
      ['b', 7, 5, 'Short 12 · already on order or draft 5 · 3 more on order or draft are already needed by other orders'],
      ['c', 5, 0, 'Short 5 · 1 on order or draft is already needed by other orders'],
    ]);
    // Read aloud too (the row's accessibility label carries its detail).
    expect(shortfallRowAccessibilityLabel(v.rows[0]!, 'Acme')).toBe(
      'Item a, SKU-a. Short 10 · 10 on order or draft are already needed by other orders. Up to 10 can be drafted. Supplier: Acme.',
    );
  });

  it('a short item that open POs or drafts already cover is shown, not draftable, with what covers it', () => {
    const v = view(
      facts(
        [
          { id: 'l1', item: 'a', requested: 4 },
          { id: 'l2', item: 'b', requested: 4 },
          { id: 'l3', item: 'c', requested: 4 },
          { id: 'l4', item: 'd', requested: 4 },
          { id: 'l5', item: 'e', requested: 4 },
        ],
        [
          item('a', { inbound: inbound([['PO-2026-0021', 40]]) }),
          item('b', { inbound: inbound([['PO-1', 2], ['PO-2', 3]], { truncated: 1 }) }),
          item('c', { inbound: inbound([], { hidden: 9 }) }),
          item('d', { drafts: drafts([['PO-2026-0043', 4]]) }),
          item('e', { inbound: inbound([['PO-7', 2]]), drafts: drafts([], 2) }),
        ],
      ),
    );
    expect(v.rows.map((r) => [r.itemId, r.state, r.draftable, r.onOrderOrDraft, r.detail])).toEqual([
      ['a', 'covered', 0, 4, 'Already on PO-2026-0021 (40 still to arrive)'],
      ['b', 'covered', 0, 4, 'Already on more than 2 POs (6 still to arrive)'],
      ['c', 'covered', 0, 4, "Already on a PO you can't open"],
      ['d', 'covered', 0, 4, 'Already on draft PO-2026-0043 (not ordered yet)'],
      ['e', 'covered', 0, 4, "Already on PO-7 (2 still to arrive) and a draft you can't open (not ordered yet)"],
    ]);
    expect(v.draftableCount).toBe(0);
    expect(v.unavailable).toBeNull();
  });

  it('kits, deleted items and items of another warehouse are shown with why they are not drafted; hidden items are only counted', () => {
    const v = view(
      facts(
        [
          { id: 'l1', item: 'kit', requested: 2 },
          { id: 'l2', item: 'del', requested: 2 },
          { id: 'l3', item: 'mov', requested: 2 },
          { id: 'l4', item: 'hid', requested: 2 },
          { id: 'l5', item: 'hid2', requested: 2 },
        ],
        [
          item('kit', { isBundle: true }),
          item('del', { deleted: true }),
          item('mov', { itemWarehouseId: 'wh-other' }),
          { itemId: 'hid', visible: false },
          { itemId: 'hid2', visible: false },
        ],
      ),
    );
    expect(v.rows.map((r) => [r.itemId, r.state, r.draftable, r.detail])).toEqual([
      ['kit', 'kit', 0, 'Kits are built from their components, so order the components instead.'],
      ['del', 'deleted', 0, "This item was deleted, so it can't be ordered. Remove the line."],
      ['mov', 'moved', 0, "This item now belongs to another warehouse, so it isn't drafted from this order."],
    ]);
    expect(v.hiddenItems).toBe(2);
    expect(v.hiddenNote).toBe("2 items aren't visible to you, so they can't be drafted.");
    expect(
      view(facts([{ id: 'l1', item: 'h', requested: 1 }], [{ itemId: 'h', visible: false }])).hiddenNote,
    ).toBe("1 item isn't visible to you, so it can't be drafted.");
  });

  it("rows follow the order of each item's first line, and an item on two lines is one row", () => {
    const v = view(
      facts(
        [
          { id: 'l1', item: 'z', requested: 1 },
          { id: 'l2', item: 'a', requested: 1 },
          { id: 'l3', item: 'z', requested: 2 },
        ],
        [item('a'), item('z')],
      ),
    );
    expect(v.rows.map((r) => [r.itemId, r.short])).toEqual([
      ['z', 3],
      ['a', 1],
    ]);
  });

  it('says why there is nothing to draft: picked or closed, capped, the purchase_orders module off, nothing short', () => {
    expect(view(facts([{ id: 'l1', item: 'a', requested: 1 }], [], { status: 'picking_complete' }))).toMatchObject({
      unavailable: 'not_to_pick',
      unavailableCopy: SHORTFALL_PO_NOT_APPLICABLE_COPY,
      rows: [],
    });
    expect(view(facts([], [], { status: 'cancelled' })).unavailable).toBe('not_to_pick');
    expect(view(facts([], [], { linesCapped: true }))).toMatchObject({
      unavailable: 'lines_capped',
      unavailableCopy: SHORTFALL_PO_LINES_CAPPED_COPY,
    });
    expect(
      view(facts([{ id: 'l1', item: 'a', requested: 1 }], [item('a', { inbound: null, drafts: null })])),
    ).toMatchObject({ unavailable: 'po_module_off', unavailableCopy: SHORTFALL_PO_PURCHASE_ORDERS_OFF_COPY });
    expect(
      view(facts([{ id: 'l1', item: 'a', requested: 1 }], [item('a', { here: { rack: 5, site: 0, unplaced: 0, staging: 0 } })])),
    ).toMatchObject({ unavailable: 'nothing_short', unavailableCopy: SHORTFALL_PO_NOTHING_SHORT_COPY, rows: [] });
    expect(
      view(facts([{ id: 'l1', item: 'h', requested: 1 }], [{ itemId: 'h', visible: false }])),
    ).toMatchObject({ unavailable: 'nothing_short', unavailableCopy: SHORTFALL_PO_NOTHING_VISIBLE_SHORT_COPY });
  });

  it('shortfallCoveredByCopy falls back to "Already on order" when no PO or draft is listed', () => {
    expect(shortfallCoveredByCopy(item('x'))).toBe('Already on order');
  });
});

describe('the supplier and the row, in words', () => {
  it('names the supplier, says when there is none, and never invents a name', () => {
    const names = new Map([[SUP1, { name: 'Acme School Supply', archived: false }]]);
    expect(shortfallSupplierLabel(SUP1, names)).toBe('Acme School Supply');
    expect(shortfallSupplierLabel(SUP1, { [SUP1]: { name: 'Acme School Supply', archived: false } })).toBe('Acme School Supply');
    expect(shortfallSupplierLabel(null, names)).toBe(SHORTFALL_NO_SUPPLIER_COPY);
    expect(shortfallSupplierLabel(null, null)).toBe(SHORTFALL_NO_SUPPLIER_COPY);
    expect(SHORTFALL_NO_SUPPLIER_COPY).toBe('No supplier: goes on a draft without one; choose a supplier before ordering.');
  });

  // Review (three lenses): an item whose supplier is archived goes on a draft
  // for that supplier (0385, as the reorder drafts), but the old label said
  // its name "couldn't be loaded", which was not what happened.
  it('says "couldn\'t be loaded" only when the names read failed; an archived supplier is named as archived; an id the read did not return is "not found"', () => {
    expect(shortfallSupplierLabel(SUP1, null)).toBe(SHORTFALL_SUPPLIER_UNKNOWN_COPY);
    expect(SHORTFALL_SUPPLIER_UNKNOWN_COPY).toBe("Its supplier (the name couldn't be loaded).");
    const names = new Map([
      [SUP1, { name: 'Acme School Supply', archived: true }],
    ]);
    expect(shortfallSupplierLabel(SUP1, names)).toBe(shortfallArchivedSupplierCopy('Acme School Supply'));
    expect(shortfallArchivedSupplierCopy('Acme School Supply')).toBe(
      'Acme School Supply (an archived supplier): check the supplier before ordering.',
    );
    expect(shortfallSupplierLabel(SUP2, names)).toBe(SHORTFALL_SUPPLIER_NOT_FOUND_COPY);
    expect(SHORTFALL_SUPPLIER_NOT_FOUND_COPY).toBe('Its supplier (not found).');
    // A blank name is not a name.
    expect(shortfallSupplierLabel(SUP1, new Map([[SUP1, { name: '  ', archived: false }]]))).toBe(
      SHORTFALL_SUPPLIER_NOT_FOUND_COPY,
    );
  });

  it('reads supplier rows (id, name, deleted_at) into names, archived included, and never guesses at a bad row', () => {
    expect(
      readShortfallSupplierRows([
        { id: SUP1, name: 'Acme', deleted_at: null },
        { id: SUP2, name: 'Old Co', deleted_at: '2026-09-01T00:00:00Z' },
        { id: 'x', name: '', deleted_at: null },
        { id: 7, name: 'bad id' },
        null,
      ]),
    ).toEqual({ [SUP1]: { name: 'Acme', archived: false }, [SUP2]: { name: 'Old Co', archived: true } });
    expect(readShortfallSupplierRows('nope')).toBeNull();
  });

  it('lists the suppliers a view names (to read their names by id: no organization-wide list, no row cap) and the ones a read has not answered', () => {
    const v = view(
      facts(
        [
          { id: 'l1', item: 'a', requested: 3 },
          { id: 'l2', item: 'b', requested: 3 },
          { id: 'l3', item: 'c', requested: 3 },
        ],
        [item('a', { supplierId: SUP2 }), item('b', { supplierId: SUP1 }), item('c', { supplierId: null })],
      ),
    );
    expect(shortfallSupplierIds(v)).toEqual([SUP1, SUP2]);
    expect(missingShortfallSupplierIds(v, { [SUP1]: { name: 'Acme', archived: false } })).toEqual([SUP2]);
    expect(missingShortfallSupplierIds(v, new Map([[SUP1, { name: 'A', archived: false }], [SUP2, { name: 'B', archived: true }]]))).toEqual([]);
    expect(missingShortfallSupplierIds(v, null)).toEqual([SUP1, SUP2]);
  });

  it('reads a row aloud in one sentence each, without doubled periods', () => {
    const v = view(facts([{ id: 'l1', item: 'a', requested: 3 }], [item('a', { name: 'Maus I', sku: 'BK-1' })]));
    expect(shortfallRowAccessibilityLabel(v.rows[0]!, 'Acme')).toBe(
      'Maus I, BK-1. Short 3. Up to 3 can be drafted. Supplier: Acme.',
    );
    expect(shortfallRowAccessibilityLabel(v.rows[0]!, SHORTFALL_NO_SUPPLIER_COPY)).toBe(
      'Maus I, BK-1. Short 3. Up to 3 can be drafted. Supplier: No supplier: goes on a draft without one; choose a supplier before ordering.',
    );
    const del = view(facts([{ id: 'l1', item: 'd', requested: 1 }], [item('d', { name: 'Old', sku: null, deleted: true })]));
    expect(shortfallRowAccessibilityLabel(del.rows[0]!, 'Acme')).toBe(
      "Old. This item was deleted, so it can't be ordered. Remove the line.",
    );
  });
});

// ── The selection ───────────────────────────────────────────────────────────

describe('the selection', () => {
  const v = view(
    facts(
      [
        { id: 'l1', item: 'a', requested: 12 },
        { id: 'l2', item: 'b', requested: 5 },
        { id: 'l3', item: 'c', requested: 4 },
      ],
      [
        item('a', { here: { rack: 2, site: 0, unplaced: 0, staging: 0 } }),
        item('b', { supplierId: null }),
        item('c', { inbound: inbound([['PO-9', 4]]) }),
      ],
    ),
  );

  it('starts with every draftable row chosen at its most; covered rows are not offered', () => {
    expect(defaultShortfallSelection(v)).toEqual({
      a: { checked: true, quantity: '10' },
      b: { checked: true, quantity: '5' },
    });
  });

  it('checks each quantity: a number, above 0, at most 4 decimals, at most the draftable', () => {
    expect(parseShortfallQuantity(' 5 ')).toBe(5);
    expect(parseShortfallQuantity('2.5')).toBe(2.5);
    expect(parseShortfallQuantity('.5')).toBe(0.5);
    for (const bad of ['', 'abc', '1e3', '-1', '5,5', 'NaN', 'Infinity', '0x10']) {
      expect(parseShortfallQuantity(bad), bad).toBeNull();
    }
    expect(shortfallQuantityProblem('abc', 10)).toBe('not_a_number');
    expect(shortfallQuantityProblem('0', 10)).toBe('not_positive');
    expect(shortfallQuantityProblem('11', 10)).toBe('too_many');
    expect(shortfallQuantityProblem('1.00001', 10)).toBe('too_precise');
    expect(shortfallQuantityProblem('10', 10)).toBeNull();
    expect(shortfallQuantityProblem('0.0001', 10)).toBeNull();
    expect(shortfallQuantityProblemCopy('too_many', 8)).toBe('At most 8 can be drafted now.');
    expect(shortfallQuantityProblemCopy('too_many', 0)).toBe(SHORTFALL_PO_NOTHING_LEFT_COPY);
    expect(shortfallQuantityProblemCopy('not_positive', 8)).toBe('Enter a quantity above 0.');
    expect(shortfallQuantityProblemCopy('not_a_number', 8)).toBe('Enter a number.');
    expect(shortfallQuantityProblemCopy('too_precise', 8)).toBe('Use at most 4 decimal places.');
  });

  it('sends only the chosen draftable rows, in row order, and names every problem instead of sending', () => {
    expect(checkShortfallSelection(v, { b: { checked: true, quantity: '2' }, a: { checked: true, quantity: '4' } })).toEqual({
      lines: [
        { itemId: 'a', quantity: 4 },
        { itemId: 'b', quantity: 2 },
      ],
      problems: {},
      ok: true,
    });
    // An unchosen row is not sent (selected lines stay selected, and only those).
    expect(checkShortfallSelection(v, { a: { checked: false, quantity: '4' }, b: { checked: true, quantity: '5' } }).lines).toEqual([
      { itemId: 'b', quantity: 5 },
    ]);
    expect(checkShortfallSelection(v, { a: { checked: true, quantity: '11' }, b: { checked: true, quantity: '5' } })).toEqual({
      lines: [],
      problems: { a: 'At most 10 can be drafted now.' },
      ok: false,
    });
    expect(checkShortfallSelection(v, { c: { checked: true, quantity: '1' } })).toEqual({
      lines: [],
      problems: { c: SHORTFALL_PO_NOTHING_LEFT_COPY },
      ok: false,
    });
    expect(checkShortfallSelection(v, {}).ok).toBe(false);
  });

  it('after a refusal (409 shortfall_changed) the choices and quantities are KEPT; the new maxima show as problems, never lowered', () => {
    const chosen = { a: { checked: true, quantity: '10' }, b: { checked: true, quantity: '5' } };
    // Meanwhile: another buyer drafted 4 of a, and b is now fully on order.
    const after = view(
      facts(
        [
          { id: 'l1', item: 'a', requested: 12 },
          { id: 'l2', item: 'b', requested: 5 },
          { id: 'l3', item: 'c', requested: 4 },
        ],
        [
          item('a', { here: { rack: 2, site: 0, unplaced: 0, staging: 0 }, drafts: drafts([['PO-10', 4]]) }),
          item('b', { supplierId: null, inbound: inbound([['PO-11', 5]]) }),
          item('c', { inbound: inbound([['PO-9', 2]]) }),
        ],
      ),
    );
    const kept = keepShortfallSelection(chosen, after);
    expect(kept.selection.a).toEqual({ checked: true, quantity: '10' });
    // b has nothing left: it cannot stay chosen, and the screen is told.
    expect(kept.unchosen).toEqual(['b']);
    expect(kept.selection.b).toBeUndefined();
    // c became draftable meanwhile: offered, not chosen for the person.
    expect(kept.selection.c).toEqual({ checked: false, quantity: '2' });
    expect(checkShortfallSelection(after, kept.selection)).toEqual({
      lines: [],
      problems: { a: 'At most 6 can be drafted now.' },
      ok: false,
    });
    expect(SHORTFALL_PO_CHANGED_COPY).toBe(
      'Stock or POs changed since you looked. The most that can be drafted now is shown.',
    );
  });

  it("reads the refusal's current numbers from a string or an object, and nothing else", () => {
    expect(parseShortfallChangedDetail('{"A-1": 0, "b": 6}')).toEqual({ 'a-1': 0, b: 6 });
    expect(parseShortfallChangedDetail({ a: 2.5 })).toEqual({ a: 2.5 });
    expect(parseShortfallChangedDetail('not json')).toBeNull();
    expect(parseShortfallChangedDetail('[1]')).toBeNull();
    expect(parseShortfallChangedDetail({ a: -1 })).toBeNull();
    expect(parseShortfallChangedDetail({ a: '3' })).toBeNull();
    expect(parseShortfallChangedDetail(null)).toBeNull();
  });
});

// ── The drafts a selection makes ────────────────────────────────────────────

describe('shortfallDraftGroups and the footer', () => {
  const v = view(
    facts(
      [
        { id: 'l1', item: 'n', requested: 3 },
        { id: 'l2', item: 's2', requested: 4 },
        { id: 'l3', item: 's1b', requested: 2 },
        { id: 'l4', item: 's1', requested: 5 },
      ],
      [item('n', { supplierId: null }), item('s2', { supplierId: SUP2 }), item('s1b'), item('s1')],
    ),
  );

  it("one draft per supplier in supplier-id order, the supplier-less last: the database's grouping", () => {
    const lines = checkShortfallSelection(v, defaultShortfallSelection(v)).lines;
    expect(shortfallDraftGroups(v, lines)).toEqual([
      { supplierId: SUP1, itemIds: ['s1', 's1b'], units: 7 },
      { supplierId: SUP2, itemIds: ['s2'], units: 4 },
      { supplierId: null, itemIds: ['n'], units: 3 },
    ]);
  });

  it('the footer counts the drafts and says they are not sent', () => {
    const lines = checkShortfallSelection(v, defaultShortfallSelection(v)).lines;
    expect(shortfallPoFooterCopy(shortfallDraftGroups(v, lines))).toBe(
      'Creates 3 draft POs, one per supplier and one for the items with no supplier. Drafts are not sent. Set the destination and order them on Purchase orders.',
    );
    const twoSuppliers = lines.filter((l) => l.itemId !== 'n');
    expect(shortfallPoFooterCopy(shortfallDraftGroups(v, twoSuppliers))).toBe(
      `Creates 2 draft POs, one per supplier. ${SHORTFALL_PO_NOT_SENT_COPY}`,
    );
    expect(shortfallPoFooterCopy(shortfallDraftGroups(v, [{ itemId: 's1', quantity: 1 }]))).toBe(
      'Creates 1 draft PO. Drafts are not sent. Set its destination and order it on Purchase orders.',
    );
    expect(shortfallPoFooterCopy(shortfallDraftGroups(v, [{ itemId: 'n', quantity: 1 }]))).toBe(
      'Creates 1 draft PO, with no supplier. Drafts are not sent. Set its supplier and destination and order it on Purchase orders.',
    );
    expect(shortfallPoFooterCopy([])).toBe('Choose at least one item to draft.');
  });
});

// ── The idempotency key ─────────────────────────────────────────────────────

describe('the idempotency key (minted for a request, reused for its retries, replaced on any edit)', () => {
  let n = 0;
  const mint = () => `key-${++n}`;

  it('the same request keeps its key, whatever the line order or 4 vs 4.00001 rounding to the same grid', () => {
    const k1 = shortfallIdempotencyKey(null, 'ORDER-1', [
      { itemId: 'a', quantity: 4 },
      { itemId: 'b', quantity: 2 },
    ], mint);
    const k2 = shortfallIdempotencyKey(k1, 'order-1', [
      { itemId: 'B', quantity: 2 },
      { itemId: 'a', quantity: 4.00001 },
    ], mint);
    expect(k2).toBe(k1);
    expect(k1.signature).toBe('order-1|a:4,b:2');
  });

  it('any edit (a quantity, a line added or removed, another order) mints a new key', () => {
    const k1 = shortfallIdempotencyKey(null, 'o', [{ itemId: 'a', quantity: 4 }], mint);
    const k2 = shortfallIdempotencyKey(k1, 'o', [{ itemId: 'a', quantity: 3 }], mint);
    const k3 = shortfallIdempotencyKey(k2, 'o', [{ itemId: 'a', quantity: 3 }, { itemId: 'b', quantity: 1 }], mint);
    const k4 = shortfallIdempotencyKey(k3, 'o2', [{ itemId: 'a', quantity: 3 }, { itemId: 'b', quantity: 1 }], mint);
    expect(new Set([k1.key, k2.key, k3.key, k4.key]).size).toBe(4);
    // And back to the first request: a new key too (the first key already
    // answered; reusing it would replay that answer, which is right only for
    // the SAME request).
    expect(shortfallIdempotencyKey(k4, 'o', [{ itemId: 'a', quantity: 4 }], mint).key).not.toBe(k1.key);
  });

  it("the signature matches the database's request (item order, the 4-decimal grid)", () => {
    expect(shortfallRequestSignature('O', [{ itemId: 'b', quantity: 1.5 }, { itemId: 'a', quantity: 0.12345 }])).toBe(
      'o|a:0.1235,b:1.5',
    );
  });

  it('refuses a mint that is not a key of 1 to 200 characters', () => {
    expect(() => shortfallIdempotencyKey(null, 'o', [{ itemId: 'a', quantity: 1 }], () => '')).toThrow();
    expect(() => shortfallIdempotencyKey(null, 'o', [{ itemId: 'a', quantity: 1 }], () => 'k'.repeat(201))).toThrow();
  });
});

// ── The answer ──────────────────────────────────────────────────────────────

describe('parseShortfallPoResult', () => {
  const answer = {
    orderId: 'o-1',
    orderNumber: 123,
    replay: false,
    created: [
      {
        purchaseOrderId: 'po-1',
        poNumber: 'PO-2026-0005',
        supplierId: SUP1,
        lineCount: 2,
        units: 7,
        lines: [
          { itemId: 'a', quantity: 5 },
          { itemId: 'b', quantity: 2 },
        ],
      },
      { purchaseOrderId: 'po-2', poNumber: 'PO-2026-0006', supplierId: null, lineCount: 1, units: 1, lines: [{ itemId: 'n', quantity: 1 }] },
    ],
  };

  it('reads the answer, tolerating keys it does not know', () => {
    const r = parseShortfallPoResult({ ...answer, later: 'additive' });
    expect(r.created.map((c) => [c.poNumber, c.supplierId, c.lineCount, c.units, c.lines.length])).toEqual([
      ['PO-2026-0005', SUP1, 2, 7, 2],
      ['PO-2026-0006', null, 1, 1, 1],
    ]);
    expect(r.replay).toBe(false);
    expect(parseShortfallPoResult({ ...answer, replay: true }).replay).toBe(true);
  });

  it('never guesses at a wrong shape', () => {
    const bad: unknown[] = [
      null,
      [],
      { ...answer, replay: 'no' },
      { ...answer, created: {} },
      { ...answer, orderId: '' },
      { ...answer, orderNumber: 'SO-1' },
      { ...answer, created: [{ ...answer.created[0], poNumber: '' }] },
      { ...answer, created: [{ ...answer.created[0], units: 0 }] },
      { ...answer, created: [{ ...answer.created[0], lineCount: 0 }] },
      { ...answer, created: [{ ...answer.created[0], supplierId: 5 }] },
      { ...answer, created: [{ ...answer.created[0], lines: [{ itemId: 'a', quantity: -1 }] }] },
    ];
    for (const b of bad) expect(() => parseShortfallPoResult(b), JSON.stringify(b)).toThrow(ShortfallPoResultShapeError);
  });

  it('says what was created, from the answer', () => {
    const r = parseShortfallPoResult(answer);
    expect(shortfallPoCreatedCopy(r)).toBe(
      'Created 2 draft POs: PO-2026-0005, PO-2026-0006. Drafts are not sent: set their destinations and order them on Purchase orders.',
    );
    expect(shortfallPoCreatedCopy({ ...r, created: r.created.slice(0, 1) })).toBe(
      'Created draft PO-2026-0005. Drafts are not sent: set its destination and order it on Purchase orders.',
    );
    expect(shortfallPoCreatedRowCopy(r.created[0]!)).toBe('PO-2026-0005 · 2 lines, 7 units');
    expect(shortfallPoCreatedRowCopy(r.created[1]!)).toBe('PO-2026-0006 · 1 line, 1 unit');
  });
});

describe('refusals', () => {
  it('only a busy database or a fault is worth pressing Draft again for the same request', () => {
    expect(shortfallPoRetryable('busy')).toBe(true);
    expect(shortfallPoRetryable('failed')).toBe(true);
    for (const r of ['shortfall_changed', 'item_not_draftable', 'line_not_on_order', 'not_applicable', 'idempotency_conflict', 'forbidden', 'not_found', 'module_disabled', 'invalid'] as const) {
      expect(shortfallPoRetryable(r), r).toBe(false);
    }
  });
});

// ── Honest words ────────────────────────────────────────────────────────────

describe('every sentence (honest words)', () => {
  const sentences = [
    SHORTFALL_PO_FORBIDDEN_COPY,
    SHORTFALL_PO_NO_WAREHOUSE_ACCESS_COPY,
    SHORTFALL_PO_CHANGED_COPY,
    SHORTFALL_PO_BUSY_COPY,
    SHORTFALL_PO_NOT_APPLICABLE_COPY,
    SHORTFALL_PO_LINES_CAPPED_COPY,
    SHORTFALL_PO_ITEM_NOT_DRAFTABLE_COPY,
    SHORTFALL_PO_LINE_NOT_ON_ORDER_COPY,
    SHORTFALL_PO_CONFLICT_COPY,
    SHORTFALL_PO_INVALID_COPY,
    SHORTFALL_PO_FAILED_COPY,
    SHORTFALL_PO_PHONE_REVIEW_COPY,
    SHORTFALL_PO_TIMELINE_LABEL,
    SHORTFALL_PO_NOT_SENT_COPY,
    SHORTFALL_NO_SUPPLIER_COPY,
    shortfallPoFooterCopy([{ supplierId: null, itemIds: ['a'], units: 1 }]),
  ];

  it('never the accounting word for a quantity, never a percentage, nothing "guaranteed", nothing claims a draft was sent', () => {
    for (const s of sentences) {
      expect(s, s).not.toMatch(/\bbooks?\b|%|guarantee|verified/i);
      // "sent" only as "not sent".
      expect(s.replace(/\bnot sent\b/g, ''), s).not.toMatch(/\bsent\b|\bemailed\b|\bnotified\b/i);
    }
  });
});

// ── Review fixes (F2-5 review: one rule and one sentence on both platforms) ──

describe('shortfallViewWithMaxima (the database\'s current most, laid over the rows when readiness cannot be read again)', () => {
  const v = view(
    facts(
      [
        { id: 'l1', item: 'a', requested: 6 },
        { id: 'l2', item: 'b', requested: 4 },
        { id: 'l3', item: 'c', requested: 3 },
        { id: 'l4', item: 'd', requested: 2 },
      ],
      [item('a'), item('b'), item('c'), item('d', { inbound: inbound([['PO-2026-0009', 5]]) })],
    ),
  );

  it('lowers a most, never raises one, and a row with nothing left is no longer offered', () => {
    const out = shortfallViewWithMaxima(v, { a: 2, b: 9, c: 0 });
    expect(out.rows.map((r) => [r.itemId, r.state, r.draftable, r.detail])).toEqual([
      ['a', 'draftable', 2, 'Short 6'],
      // 9 is more than the 4 the row offered: the row keeps 4.
      ['b', 'draftable', 4, 'Short 4'],
      ['c', 'covered', 0, SHORTFALL_PO_NOTHING_LEFT_COPY],
      // Not draftable before: untouched.
      ['d', 'covered', 0, v.rows[3]!.detail],
    ]);
    expect(out.draftableCount).toBe(2);
    expect(out.rows.find((r) => r.itemId === 'c')!.onOrderOrDraft).toBe(3);
  });

  it('an item the database did not answer for is treated as nothing left (never more than it said)', () => {
    const out = shortfallViewWithMaxima(v, { a: 6 });
    expect(out.rows.map((r) => [r.itemId, r.state, r.draftable])).toEqual([
      ['a', 'draftable', 6],
      ['b', 'covered', 0],
      ['c', 'covered', 0],
      ['d', 'covered', 0],
    ]);
  });
});

describe('the items unticked after a refusal, named (screen readers heard only the generic sentence)', () => {
  const before = view(
    facts(
      [
        { id: 'l1', item: 'a', requested: 3 },
        { id: 'l2', item: 'b', requested: 3 },
      ],
      [item('a', { name: 'Maus I' }), item('b', { name: 'Maus II' })],
    ),
  );

  it('says which chosen items are no longer chosen, and nothing when none', () => {
    expect(shortfallUnchosenCopy(before, [])).toBeNull();
    expect(shortfallUnchosenCopy(before, ['a'])).toBe('No longer chosen: Maus I. Nothing is left to draft for it.');
    expect(shortfallUnchosenCopy(before, ['a', 'b'])).toBe(
      'No longer chosen: Maus I, Maus II. Nothing is left to draft for them.',
    );
    // An id the view does not know is not named.
    expect(shortfallUnchosenCopy(before, ['zz'])).toBeNull();
  });

  it('adds it to the refusal, so it is announced with it', () => {
    expect(shortfallRefusalCopy(SHORTFALL_PO_CHANGED_COPY, before, ['b'])).toBe(
      `${SHORTFALL_PO_CHANGED_COPY} No longer chosen: Maus II. Nothing is left to draft for it.`,
    );
    expect(shortfallRefusalCopy(SHORTFALL_PO_CHANGED_COPY, before, [])).toBe(SHORTFALL_PO_CHANGED_COPY);
  });

  it('keepShortfallSelection lists exactly the chosen rows it unticks', () => {
    const after = shortfallViewWithMaxima(before, { a: 0, b: 3 });
    const sel = { a: { checked: true, quantity: '3' }, b: { checked: true, quantity: '3' } };
    expect(keepShortfallSelection(sel, after).unchosen).toEqual(['a']);
    expect(keepShortfallSelection({ ...sel, a: { checked: false, quantity: '3' } }, after).unchosen).toEqual([]);
  });
});

describe('the timeline entry (moved from the web page into core)', () => {
  it('names the drafts, how many items and units, and that drafts are not sent; says nothing it cannot read', () => {
    expect(
      shortfallPoTimelineDetail({
        po_numbers: ['PO-2026-0052'],
        lines: [{ item_id: 'A', quantity: 1, purchase_order_id: 'p1' }],
      }),
    ).toBe('Draft PO-2026-0052 for 1 item, 1 unit. Drafts are not sent.');
    expect(
      shortfallPoTimelineDetail({
        po_numbers: ['PO-2026-0052', 'PO-2026-0053'],
        lines: [
          { item_id: 'a', quantity: 10, purchase_order_id: 'p1' },
          { item_id: 'b', quantity: 5.5, purchase_order_id: 'p1' },
          { item_id: 'c', quantity: 0, purchase_order_id: 'p2' },
          { item_id: 'A', quantity: 0.0001 },
        ],
      }),
    ).toBe('2 draft POs for 2 items, 15.5001 units: PO-2026-0052, PO-2026-0053. Drafts are not sent.');
    expect(shortfallPoTimelineDetail({ po_numbers: [], lines: [{ item_id: 'a', quantity: 1 }] })).toBeNull();
    expect(shortfallPoTimelineDetail({ po_numbers: ['PO-1'], lines: 'x' })).toBeNull();
    expect(shortfallPoTimelineDetail(null)).toBeNull();
  });
});

describe('words both platforms say (were phone-only or missing)', () => {
  it('the controls, the hints, and the sentences for an answer that never came, a timeout, an unreadable answer and the rate limit', () => {
    expect(SHORTFALL_PO_QUANTITY_LABEL).toBe('Quantity');
    expect(SHORTFALL_PO_CANCEL_LABEL).toBe('Cancel');
    expect(SHORTFALL_PO_CLOSE_LABEL).toBe('Close');
    expect(SHORTFALL_PO_OPEN_DRAFT_HINT).toBe('Opens this draft PO');
    expect(SHORTFALL_PO_PHONE_STRIP_HINT).toBe('Opens a sheet to draft purchase orders for what this order is short');
    // A lost answer: the drafts may exist; the same request again shows them.
    expect(SHORTFALL_PO_NO_ANSWER_COPY).toBe(
      'No answer came back, so the drafts may or may not have been made. Press Draft again: if they were made, it shows them instead of making more.',
    );
    // A statement timeout rolls the whole call back.
    expect(SHORTFALL_PO_TIMEOUT_COPY).toBe('Drafting took too long, so nothing was drafted. Try again.');
    expect(SHORTFALL_PO_UNREADABLE_COPY).toBe(
      "The drafts may have been created, but the answer couldn't be read. What is already on a draft is shown; check it before drafting again.",
    );
    expect(SHORTFALL_PO_TOO_MANY_COPY).toBe('Too many requests. Wait a moment and try again.');
    for (const t of [SHORTFALL_PO_NO_ANSWER_COPY, SHORTFALL_PO_TIMEOUT_COPY, SHORTFALL_PO_UNREADABLE_COPY]) {
      expect(t, t).not.toMatch(/\bbooks?\b|%|guarantee|verified|\bsent\b|emailed|notified/i);
    }
  });
});
