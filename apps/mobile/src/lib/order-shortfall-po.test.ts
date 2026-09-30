import { describe, expect, it, vi } from 'vitest';

import {
  READINESS_NEEDS_CONNECTION_COPY,
  SHORTFALL_NO_SUPPLIER_COPY,
  SHORTFALL_PO_BUSY_COPY,
  SHORTFALL_PO_BUTTON_ACCESSIBILITY_LABEL,
  SHORTFALL_PO_BUTTON_LABEL,
  SHORTFALL_PO_CHANGED_COPY,
  SHORTFALL_PO_CONFLICT_COPY,
  SHORTFALL_PO_FAILED_COPY,
  SHORTFALL_PO_FORBIDDEN_COPY,
  SHORTFALL_PO_INVALID_COPY,
  SHORTFALL_PO_NOT_APPLICABLE_COPY,
  SHORTFALL_PO_NOTHING_LEFT_COPY,
  SHORTFALL_PO_NOTHING_SHORT_COPY,
  SHORTFALL_PO_PURCHASE_ORDERS_OFF_COPY,
  SHORTFALL_PO_NO_ANSWER_COPY,
  SHORTFALL_PO_SIGN_IN_COPY,
  SHORTFALL_PO_TOO_MANY_COPY,
  SHORTFALL_PO_UNREADABLE_COPY,
  SHORTFALL_SUPPLIER_NOT_FOUND_COPY,
  SHORTFALL_SUPPLIER_UNKNOWN_COPY,
  ShortfallPoResultShapeError,
  shortfallArchivedSupplierCopy,
  shortfallViewWithMaxima,
  type ShortfallSupplierName,
  defaultShortfallSelection,
  shortfallIdempotencyKey,
  shortfallPoCreatedCopy,
  shortfallRowAccessibilityLabel,
  type OrderReadinessResult,
  type ShortfallPoResult,
  type ShortfallPoView,
} from '@stockpilot/core';

import {
  FX_ITEM_A,
  FX_ITEM_B,
  FX_ORDER,
  FX_WH,
  fxFacts,
  fxItem,
  fxLine,
  fxResult,
} from './__fixtures__/readiness-facts';
import {
  adoptShortfallRefusal,
  mintShortfallKey,
  readShortfallSupplierNames,
  setShortfallQuantity,
  shortfallCreatedRows,
  shortfallPoOffer,
  shortfallSheetOpening,
  shortfallSheetView,
  shortfallViewsDiffer,
  submitShortfallPo,
  toggleShortfallChoice,
  type ShortfallPoDeps,
} from './order-shortfall-po';

/**
 * F2-5 ON THE PHONE: the draft sheet's decisions over REAL assessments (core's
 * parser and assessment, readiness-facts.ts), so no test hand-builds a view
 * core would never make. The screen and the sheet are pinned to these in
 * order-f2-5-wiring.test.ts.
 */

const FX_ITEM_C = '0a000000-0000-0000-0000-0000000000e3';
const SUP1 = '0a000000-0000-4000-8000-00000000c001';
const SUP2 = '0a000000-0000-4000-8000-00000000c002';
const PO_A = '0a000000-0000-4000-8000-00000000d001';
const PO_B = '0a000000-0000-4000-8000-00000000d002';
const NAMES: ReadonlyMap<string, ShortfallSupplierName> = new Map([[SUP1, { name: 'Acme School Supply', archived: false }]]);

const EMPTY_PO = { rows: [], hiddenRemaining: 0, truncated: false, truncatedRemaining: 0 };

function none(itemId: string, over: Record<string, unknown> = {}) {
  return fxItem(itemId, {
    onHand: 0,
    here: { rack: 0, site: 0, unplaced: 0, staging: 0 },
    inbound: EMPTY_PO,
    drafts: EMPTY_PO,
    ...over,
  });
}

/**
 * The order: Maus I asks 20 with 10 on the rack (short 10, from Acme);
 * Notebooks asks 15 with none, but PO-2026-0021 brings 40 (covered);
 * the third asks 5 with none and no supplier.
 */
function order(
  over: {
    a?: Record<string, unknown>;
    b?: Record<string, unknown>;
    c?: Record<string, unknown>;
    status?: string;
    phase?: string;
  } = {},
): OrderReadinessResult {
  return fxResult(
    fxFacts({
      status: over.status ?? 'approved',
      phase: over.phase,
      lines: [fxLine('l1', FX_ITEM_A, 20), fxLine('l2', FX_ITEM_B, 15), fxLine('l3', FX_ITEM_C, 5)],
      items: [
        fxItem(FX_ITEM_A, { supplierId: SUP1, sku: 'MAUS-1', inbound: EMPTY_PO, drafts: EMPTY_PO, ...over.a }),
        none(FX_ITEM_B, {
          supplierId: SUP2,
          inbound: {
            rows: [{ poId: PO_B, poNumber: 'PO-2026-0021', status: 'ordered', expectedAt: null, remaining: 40 }],
            hiddenRemaining: 0,
          },
          ...over.b,
        }),
        none(FX_ITEM_C, { name: 'Glue sticks', ...over.c }),
      ],
    }),
  );
}

function viewOf(r: OrderReadinessResult): ShortfallPoView {
  const opened = shortfallSheetOpening(r, null);
  if (!opened) throw new Error('nothing to open');
  return opened.view;
}

const ELIGIBLE = {
  fullPanel: true,
  isManager: true,
  canManagePurchaseOrders: true,
  ordersModule: true,
  purchaseOrdersModule: true,
};

describe('the readiness card: who is offered "Draft PO for what is short" (the web strip’s rule)', () => {
  it('a manager holding purchase_orders:manage with both modules on gets core’s button', () => {
    expect(shortfallPoOffer({ ...ELIGIBLE, readiness: order() })).toEqual({
      kind: 'button',
      label: SHORTFALL_PO_BUTTON_LABEL,
      accessibilityLabel: SHORTFALL_PO_BUTTON_ACCESSIBILITY_LABEL,
    });
  });

  it('anyone else on the full panel reads core’s sentence, only when something may be drafted', () => {
    const needs = { kind: 'needs_permission', message: SHORTFALL_PO_FORBIDDEN_COPY };
    // Staff holding purchase_orders:manage (idempotency keys are manager-only).
    expect(shortfallPoOffer({ ...ELIGIBLE, isManager: false, readiness: order() })).toEqual(needs);
    // A manager whose purchase_orders:manage was revoked.
    expect(shortfallPoOffer({ ...ELIGIBLE, canManagePurchaseOrders: false, readiness: order() })).toEqual(needs);
  });

  // Mutation caught: the sentence (a wrong reason) for a manager whose module
  // set has not loaded.
  it('a module the phone has not confirmed offers nothing, never the wrong reason', () => {
    expect(shortfallPoOffer({ ...ELIGIBLE, purchaseOrdersModule: false, readiness: order() })).toEqual({ kind: 'none' });
    expect(shortfallPoOffer({ ...ELIGIBLE, ordersModule: false, readiness: order() })).toEqual({ kind: 'none' });
  });

  it('nothing when nothing may be drafted, the panel is not the full one, or readiness is not an answer', () => {
    const covered = order({
      a: { drafts: { rows: [{ poId: PO_A, poNumber: 'PO-2026-0043', remaining: 10 }], hiddenRemaining: 0 } },
      c: { inbound: { rows: [{ poId: PO_B, poNumber: 'PO-2026-0021', status: 'ordered', expectedAt: null, remaining: 5 }], hiddenRemaining: 0 } },
    });
    for (const input of [
      { ...ELIGIBLE, readiness: covered },
      { ...ELIGIBLE, isManager: false, readiness: covered },
      { ...ELIGIBLE, fullPanel: false, readiness: order() },
      { ...ELIGIBLE, readiness: null },
      { ...ELIGIBLE, readiness: { state: 'failed', message: 'x' } as OrderReadinessResult },
      { ...ELIGIBLE, readiness: order({ status: 'picking_complete', phase: 'picked' }) },
      // Purchase orders off at the database: readiness reads no POs.
      { ...ELIGIBLE, readiness: order({ a: { inbound: null, drafts: null } }) },
    ]) {
      expect(shortfallPoOffer(input)).toEqual({ kind: 'none' });
    }
  });
});

describe('opening the sheet', () => {
  it('opens on readiness read again; the same numbers say nothing', () => {
    const opened = shortfallSheetOpening(order(), order());
    expect(opened?.changed).toBe(false);
    expect(opened?.notice).toBeNull();
    expect(opened?.view.rows.map((r) => [r.itemId, r.state, r.draftable])).toEqual([
      [FX_ITEM_A, 'draftable', 10],
      [FX_ITEM_B, 'covered', 0],
      [FX_ITEM_C, 'draftable', 5],
    ]);
    expect(opened?.view.orderNumber).toBe('SO-000017');
  });

  it('numbers that moved since the screen looked: the fresh rows, and core’s sentence saying so', () => {
    const fresh = order({ a: { drafts: { rows: [{ poId: PO_A, poNumber: 'PO-2026-0043', remaining: 6 }], hiddenRemaining: 0 } } });
    const opened = shortfallSheetOpening(order(), fresh);
    expect(opened?.changed).toBe(true);
    expect(opened?.notice).toBe(SHORTFALL_PO_CHANGED_COPY);
    expect(opened?.view.rows[0]).toMatchObject({ itemId: FX_ITEM_A, draftable: 4 });
  });

  it('a failed re-read opens on the rows the screen shows; nothing to open on is null', () => {
    const opened = shortfallSheetOpening(order(), { state: 'failed', message: 'x' });
    expect(opened).toMatchObject({ notice: null, changed: false });
    expect(opened?.view.rows).toHaveLength(3);
    expect(shortfallSheetOpening(null, order())).toBeNull();
    expect(shortfallSheetOpening({ state: 'failed', message: 'x' }, order())).toBeNull();
    expect(shortfallSheetOpening(order({ status: 'picking_complete', phase: 'picked' }), order())).toBeNull();
  });

  it('an order with nothing short when read again says so (the rows go, Draft with them)', () => {
    const stocked = order({
      a: { onHand: 20, here: { rack: 20, site: 0, unplaced: 0, staging: 0 } },
      b: { onHand: 15, here: { rack: 15, site: 0, unplaced: 0, staging: 0 }, inbound: EMPTY_PO },
      c: { onHand: 5, here: { rack: 5, site: 0, unplaced: 0, staging: 0 } },
    });
    const opened = shortfallSheetOpening(order(), stocked)!;
    expect(opened.notice).toBe(SHORTFALL_PO_CHANGED_COPY);
    const sheet = shortfallSheetView({
      view: opened.view,
      selection: defaultShortfallSelection(opened.view),
      supplierNames: NAMES,
      offline: false,
      busy: false,
      closed: false,
    });
    expect(sheet.rows).toEqual([]);
    expect(sheet.unavailable).toBe(SHORTFALL_PO_NOTHING_SHORT_COPY);
    expect(sheet.offersDraft).toBe(false);
    expect(sheet.footer).toBeNull();
  });

  it('views differ exactly when a row’s state or its most differs', () => {
    expect(shortfallViewsDiffer(viewOf(order()), viewOf(order()))).toBe(false);
    expect(
      shortfallViewsDiffer(viewOf(order()), viewOf(order({ c: { onHand: 2, here: { rack: 2, site: 0, unplaced: 0, staging: 0 } } }))),
    ).toBe(true);
  });
});

describe('the sheet’s rows, footer and Draft', () => {
  const view = viewOf(order());
  const base = { view, supplierNames: NAMES, timeZone: 'America/Los_Angeles', offline: false, busy: false, closed: false };

  it('every short item: the draftable ones chosen at their most, the covered one unchecked with what covers it', () => {
    const sheet = shortfallSheetView({ ...base, selection: defaultShortfallSelection(view) });
    expect(sheet.rows.map((r) => [r.name, r.draftable, r.checked, r.quantity, r.detail, r.supplier])).toEqual([
      ['Maus I', true, true, '10', 'Short 10', 'Acme School Supply'],
      ['Notebooks', false, false, '', 'Already on PO-2026-0021 (40 still to arrive)', null],
      ['Glue sticks', true, true, '5', 'Short 5', SHORTFALL_NO_SUPPLIER_COPY],
    ]);
    // Each checkbox reads core's sentence for its row.
    expect(sheet.rows[0]!.accessibilityLabel).toBe(shortfallRowAccessibilityLabel(view.rows[0]!, 'Acme School Supply'));
    expect(sheet.rows[0]!.accessibilityLabel).toBe(
      'Maus I, MAUS-1. Short 10. Up to 10 can be drafted. Supplier: Acme School Supply.',
    );
    expect(sheet.rows[1]!.accessibilityLabel).toBe('Notebooks. Already on PO-2026-0021 (40 still to arrive).');
    expect(sheet.rows[0]!.quantityAccessibilityLabel).toBe('Quantity, Maus I');
    expect(sheet.rows[0]!.quantityAccessibilityHint).toBe('Up to 10 can be drafted.');
    // The drafts the call makes: Acme's, and one for the item with no supplier.
    expect(sheet.footer).toBe(
      'Creates 2 draft POs, one per supplier and one for the items with no supplier. Drafts are not sent. Set the destination and order them on Purchase orders.',
    );
    expect(sheet.checkedAt).toBe('Checked at 10:59 AM. Stock can change after this.');
    expect(sheet.canDraft).toBe(true);
    expect(sheet.draftBlockedBy).toBeNull();
    expect(sheet.lines).toEqual([
      { itemId: FX_ITEM_A, quantity: 10 },
      { itemId: FX_ITEM_C, quantity: 5 },
    ]);
  });

  // Plan vitest: "The phone sheet is disabled offline".
  it('offline, Draft is off and says it needs a connection (and sends nothing)', () => {
    const sheet = shortfallSheetView({ ...base, offline: true, selection: defaultShortfallSelection(view) });
    expect(sheet.canDraft).toBe(false);
    expect(sheet.draftBlockedBy).toBe(READINESS_NEEDS_CONNECTION_COPY);
    expect(sheet.lines).toEqual([]);
    // Everything else still shows: the person can read what they would draft.
    expect(sheet.rows).toHaveLength(3);
  });

  it('a quantity above the most, or not a number, is named under its field in core’s words and holds Draft', () => {
    let sel = setShortfallQuantity(defaultShortfallSelection(view), view, FX_ITEM_A, '12');
    let sheet = shortfallSheetView({ ...base, selection: sel });
    expect(sheet.rows[0]!.problem).toBe('At most 10 can be drafted now.');
    expect(sheet.canDraft).toBe(false);
    expect(sheet.draftBlockedBy).toBe('At most 10 can be drafted now.');
    sel = setShortfallQuantity(sel, view, FX_ITEM_A, 'ten');
    sheet = shortfallSheetView({ ...base, selection: sel });
    expect(sheet.rows[0]!.problem).toBe('Enter a number.');
    sel = setShortfallQuantity(sel, view, FX_ITEM_A, '0');
    expect(shortfallSheetView({ ...base, selection: sel }).rows[0]!.problem).toBe('Enter a quantity above 0.');
    // Down to what the person wants, not below 1 of anything by the sheet.
    sel = setShortfallQuantity(sel, view, FX_ITEM_A, '3');
    sheet = shortfallSheetView({ ...base, selection: sel });
    expect(sheet.canDraft).toBe(true);
    expect(sheet.lines[0]).toEqual({ itemId: FX_ITEM_A, quantity: 3 });
  });

  it('an unchosen row sends nothing and shows no problem; nothing chosen holds Draft with core’s sentence', () => {
    let sel = toggleShortfallChoice(defaultShortfallSelection(view), view, FX_ITEM_C);
    let sheet = shortfallSheetView({ ...base, selection: sel });
    expect(sheet.lines).toEqual([{ itemId: FX_ITEM_A, quantity: 10 }]);
    expect(sheet.footer).toBe(
      'Creates 1 draft PO. Drafts are not sent. Set its destination and order it on Purchase orders.',
    );
    sel = setShortfallQuantity(sel, view, FX_ITEM_C, 'x');
    // Typed text on an unchosen row is kept, and does not choose it (its
    // field is off until the row is chosen, as on the web).
    expect(sel[FX_ITEM_C]).toEqual({ checked: false, quantity: 'x' });
    sel = toggleShortfallChoice(sel, view, FX_ITEM_A);
    sheet = shortfallSheetView({ ...base, selection: sel });
    expect(sheet.rows.every((r) => r.problem === null)).toBe(true);
    expect(sheet.canDraft).toBe(false);
    expect(sheet.draftBlockedBy).toBe(SHORTFALL_PO_INVALID_COPY);
    expect(sheet.footer).toBe('Choose at least one item to draft.');
  });

  it('a covered row cannot be chosen or typed into', () => {
    const sel = defaultShortfallSelection(view);
    expect(toggleShortfallChoice(sel, view, FX_ITEM_B)).toBe(sel);
    expect(setShortfallQuantity(sel, view, FX_ITEM_B, '3')).toBe(sel);
  });

  // Review: "couldn't be loaded" only for a read that failed; an archived
  // supplier (the draft still goes to it) is named as archived; an id a read
  // that answered did not return is "not found". The web's words exactly.
  it('a supplier: "couldn’t be loaded" only when the read failed, "an archived supplier", or "not found"', () => {
    const sel = defaultShortfallSelection(view);
    expect(shortfallSheetView({ ...base, supplierNames: null, selection: sel }).rows[0]!.supplier).toBe(
      SHORTFALL_SUPPLIER_UNKNOWN_COPY,
    );
    expect(shortfallSheetView({ ...base, supplierNames: new Map(), selection: sel }).rows[0]!.supplier).toBe(
      SHORTFALL_SUPPLIER_NOT_FOUND_COPY,
    );
    const archived = new Map([[SUP1, { name: 'Acme School Supply', archived: true }]]);
    const sheet = shortfallSheetView({ ...base, supplierNames: archived, selection: sel });
    expect(sheet.rows[0]!.supplier).toBe(shortfallArchivedSupplierCopy('Acme School Supply'));
    expect(sheet.rows[0]!.accessibilityLabel).toContain('Supplier: Acme School Supply (an archived supplier): check the supplier before ordering.');
  });

  it('while drafting, and once refused for good, Draft is off', () => {
    const sel = defaultShortfallSelection(view);
    expect(shortfallSheetView({ ...base, busy: true, selection: sel }).canDraft).toBe(false);
    expect(shortfallSheetView({ ...base, closed: true, selection: sel }).canDraft).toBe(false);
  });

  it('nothing left to draft (all covered): no footer, no Draft, no reason to press it', () => {
    const covered = viewOf(
      order({
        a: { drafts: { rows: [{ poId: PO_A, poNumber: 'PO-2026-0043', remaining: 10 }], hiddenRemaining: 0 } },
        c: { drafts: { rows: [{ poId: PO_A, poNumber: 'PO-2026-0043', remaining: 5 }], hiddenRemaining: 0 } },
      }),
    );
    const sheet = shortfallSheetView({ ...base, view: covered, selection: defaultShortfallSelection(covered) });
    expect(sheet.offersDraft).toBe(false);
    expect(sheet.footer).toBeNull();
    expect(sheet.draftBlockedBy).toBeNull();
    expect(sheet.rows.map((r) => r.detail)).toEqual([
      'Already on draft PO-2026-0043 (not ordered yet)',
      'Already on PO-2026-0021 (40 still to arrive)',
      'Already on draft PO-2026-0043 (not ordered yet)',
    ]);
  });
});

// Plan vitest: "Key lifecycle: the same payload keeps its key; an edit mints a new one."
describe('the idempotency key, through the sheet’s own lines', () => {
  const view = viewOf(order());
  const base = { view, supplierNames: NAMES, offline: false, busy: false, closed: false };
  let n = 0;
  const mint = () => `k${++n}`;

  it('the same request keeps its key (a double tap, a retry after no answer); any edit mints a new one', () => {
    const sel = defaultShortfallSelection(view);
    const first = shortfallIdempotencyKey(null, FX_ORDER, shortfallSheetView({ ...base, selection: sel }).lines, mint);
    const again = shortfallIdempotencyKey(first, FX_ORDER, shortfallSheetView({ ...base, selection: sel }).lines, mint);
    expect(again).toBe(first);
    const edited = setShortfallQuantity(sel, view, FX_ITEM_A, '9');
    const next = shortfallIdempotencyKey(again, FX_ORDER, shortfallSheetView({ ...base, selection: edited }).lines, mint);
    expect(next.key).not.toBe(first.key);
  });

  it('a minted key is a fresh id, short enough for the route', () => {
    const a = mintShortfallKey();
    const b = mintShortfallKey();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^shortfall-[0-9a-f-]{36}$/);
    expect(a.length).toBeLessThanOrEqual(200);
  });

  it('without crypto.randomUUID it still mints a v4-shaped id', () => {
    const real = globalThis.crypto;
    vi.stubGlobal('crypto', {});
    try {
      expect(mintShortfallKey()).toMatch(/^shortfall-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(globalThis.crypto).toBe(real);
  });
});

// ── Drafting ────────────────────────────────────────────────────────────────

const RESULT: ShortfallPoResult = {
  orderId: FX_ORDER,
  orderNumber: 17,
  created: [
    { purchaseOrderId: PO_A, poNumber: 'PO-2026-0044', supplierId: SUP1, lineCount: 1, units: 10, lines: [{ itemId: FX_ITEM_A, quantity: 10 }] },
    { purchaseOrderId: PO_B, poNumber: 'PO-2026-0045', supplierId: null, lineCount: 1, units: 5, lines: [{ itemId: FX_ITEM_C, quantity: 5 }] },
  ],
  replay: false,
};

function refusal(status: number, message: string, details?: unknown) {
  return Object.assign(new Error(message), { status, details });
}

function deps(over: Partial<ShortfallPoDeps> = {}): ShortfallPoDeps & {
  draft: ReturnType<typeof vi.fn>;
  reread: ReturnType<typeof vi.fn>;
} {
  return {
    draft: vi.fn(async () => RESULT),
    reread: vi.fn(async () => order()),
    ...over,
  } as never;
}

describe('submitShortfallPo: what a Draft press says', () => {
  const view = viewOf(order());
  const lines = [
    { itemId: FX_ITEM_A, quantity: 10 },
    { itemId: FX_ITEM_C, quantity: 5 },
  ];
  const key = { signature: 's', key: 'shortfall-k1' };
  const input = { orderId: FX_ORDER, lines, key, shown: view };

  it('created: core’s sentence from the ANSWER, the lines and the key as sent', async () => {
    const d = deps();
    const out = await submitShortfallPo(d, input);
    expect(d.draft).toHaveBeenCalledWith(FX_ORDER, { lines, idempotencyKey: 'shortfall-k1' });
    expect(out).toEqual({ kind: 'created', result: RESULT, message: shortfallPoCreatedCopy(RESULT) });
    expect(out.kind === 'created' && out.message).toBe(
      'Created 2 draft POs: PO-2026-0044, PO-2026-0045. Drafts are not sent: set their destinations and order them on Purchase orders.',
    );
    // A replay (the same request's key) reads the same: the same drafts.
    const replay = await submitShortfallPo(deps({ draft: vi.fn(async () => ({ ...RESULT, replay: true })) }), input);
    expect(replay.kind === 'created' && replay.message).toBe(shortfallPoCreatedCopy(RESULT));
  });

  // Plan vitest: "A 409 keeps the selection".
  it('shortfall_changed: readiness read again, the choices KEPT and the new most shown as a problem (never lowered)', async () => {
    // Another buyer drafted 6 of Maus I meanwhile: 4 may be drafted now.
    const moved = order({ a: { drafts: { rows: [{ poId: PO_A, poNumber: 'PO-2026-0043', remaining: 6 }], hiddenRemaining: 0 } } });
    const d = deps({
      draft: vi.fn(async () => {
        throw refusal(409, SHORTFALL_PO_CHANGED_COPY, { reason: 'shortfall_changed', current: { [FX_ITEM_A]: 4, [FX_ITEM_C]: 5 } });
      }),
      reread: vi.fn(async () => moved),
    });
    const out = await submitShortfallPo(d, input);
    expect(out).toMatchObject({
      kind: 'refused',
      reason: 'shortfall_changed',
      message: SHORTFALL_PO_CHANGED_COPY,
      dropKey: true,
      closed: false,
      refresh: true,
    });
    if (out.kind !== 'refused' || !out.view) throw new Error('expected a view');
    const kept = adoptShortfallRefusal(defaultShortfallSelection(view), view, out);
    expect(kept.selection[FX_ITEM_A]).toEqual({ checked: true, quantity: '10' });
    // Nothing was unticked (A still has 4, C still 5): the refusal as sent.
    expect(kept.message).toBe(SHORTFALL_PO_CHANGED_COPY);
    const sheet = shortfallSheetView({ view: kept.view, selection: kept.selection, supplierNames: NAMES, offline: false, busy: false, closed: false });
    expect(sheet.rows[0]!.detail).toBe('Short 10 · already on order or draft 6');
    expect(sheet.rows[0]!.problem).toBe('At most 4 can be drafted now.');
    expect(sheet.canDraft).toBe(false);
  });

  it('shortfall_changed with readiness unreadable: the server’s own maxima laid over the rows', async () => {
    const d = deps({
      draft: vi.fn(async () => {
        throw refusal(409, SHORTFALL_PO_CHANGED_COPY, { reason: 'shortfall_changed', current: { [FX_ITEM_A]: 4, [FX_ITEM_C]: 0 } });
      }),
      reread: vi.fn(async () => ({ state: 'failed', message: 'x' }) as OrderReadinessResult),
    });
    const out = await submitShortfallPo(d, input);
    if (out.kind !== 'refused' || !out.view) throw new Error('expected a view');
    expect(out.view.rows.map((r) => [r.itemId, r.state, r.draftable])).toEqual([
      [FX_ITEM_A, 'draftable', 4],
      [FX_ITEM_B, 'covered', 0],
      [FX_ITEM_C, 'covered', 0],
    ]);
    expect(out.view.rows[2]!.detail).toBe(SHORTFALL_PO_NOTHING_LEFT_COPY);
    // Review: the unticked item is named in the refusal, as on the web.
    const kept = adoptShortfallRefusal(defaultShortfallSelection(view), view, out);
    expect(kept.selection[FX_ITEM_C]).toBeUndefined();
    expect(kept.message).toBe(`${SHORTFALL_PO_CHANGED_COPY} No longer chosen: Glue sticks. Nothing is left to draft for it.`);
    expect(kept.view).toBe(out.view);
  });

  it('a refusal that leaves nothing to draft at all is said alone (no list of every item)', async () => {
    const d = deps({
      draft: vi.fn(async () => {
        throw refusal(409, SHORTFALL_PO_NOT_APPLICABLE_COPY, { reason: 'not_applicable', status: 'picking_complete' });
      }),
      reread: vi.fn(async () => order({ status: 'picking_complete', phase: 'picked' })),
    });
    const out = await submitShortfallPo(d, input);
    if (out.kind !== 'refused') throw new Error('expected a refusal');
    expect(adoptShortfallRefusal(defaultShortfallSelection(view), view, out).message).toBe(SHORTFALL_PO_NOT_APPLICABLE_COPY);
  });

  it('a refusal with no fresh rows keeps the rows and the choice as they were', () => {
    const sel = defaultShortfallSelection(view);
    const kept = adoptShortfallRefusal(sel, view, {
      kind: 'refused',
      reason: 'busy',
      message: SHORTFALL_PO_BUSY_COPY,
      dropKey: false,
      closed: false,
      refresh: false,
    });
    expect(kept).toEqual({ view, selection: sel, message: SHORTFALL_PO_BUSY_COPY });
  });

  it('the order moved past drafting: the refusal closes the sheet, with the fresh rows (none)', async () => {
    const d = deps({
      draft: vi.fn(async () => {
        throw refusal(409, SHORTFALL_PO_NOT_APPLICABLE_COPY, { reason: 'not_applicable', status: 'picking_complete' });
      }),
      reread: vi.fn(async () => order({ status: 'picking_complete', phase: 'picked' })),
    });
    const out = await submitShortfallPo(d, input);
    expect(out).toMatchObject({ kind: 'refused', reason: 'not_applicable', message: SHORTFALL_PO_NOT_APPLICABLE_COPY, closed: true, refresh: true });
    expect(out.kind === 'refused' && out.view?.unavailableCopy).toBe(SHORTFALL_PO_NOT_APPLICABLE_COPY);
  });

  // Plan iOS walk: "airplane mode mid-request, then a retry with the same key, gives one draft".
  it('no answer: core’s sentence for exactly that (the drafts may exist; the web’s words), the key KEPT so the retry is the same request', async () => {
    const d = deps({
      draft: vi.fn(async () => {
        throw new TypeError('Network request failed');
      }),
    });
    const out = await submitShortfallPo(d, input);
    expect(out).toEqual({ kind: 'refused', reason: 'failed', message: SHORTFALL_PO_NO_ANSWER_COPY, dropKey: false, closed: false, refresh: false });
    expect(d.reread).not.toHaveBeenCalled();
  });

  it('busy keeps the key; a used key is dropped; the closing refusals take Draft away', async () => {
    const run = async (status: number, message: string, details: unknown) =>
      submitShortfallPo(deps({ draft: vi.fn(async () => { throw refusal(status, message, details); }) }), input);
    expect(await run(409, SHORTFALL_PO_BUSY_COPY, { reason: 'busy', retryable: true })).toMatchObject({
      reason: 'busy', message: SHORTFALL_PO_BUSY_COPY, dropKey: false, closed: false,
    });
    expect(await run(409, SHORTFALL_PO_CONFLICT_COPY, { reason: 'idempotency_conflict' })).toMatchObject({
      reason: 'idempotency_conflict', message: SHORTFALL_PO_CONFLICT_COPY, dropKey: true, closed: false,
    });
    expect(await run(403, SHORTFALL_PO_FORBIDDEN_COPY, { reason: 'forbidden' })).toMatchObject({
      reason: 'forbidden', message: SHORTFALL_PO_FORBIDDEN_COPY, closed: true, refresh: true,
    });
    expect(await run(403, SHORTFALL_PO_PURCHASE_ORDERS_OFF_COPY, { reason: 'module_disabled', module: 'purchase_orders' })).toMatchObject({
      reason: 'module_disabled', closed: true,
    });
    expect(await run(400, SHORTFALL_PO_INVALID_COPY, { reason: 'invalid' })).toMatchObject({
      reason: 'invalid', message: SHORTFALL_PO_INVALID_COPY, closed: false,
    });
    // A named refusal with no sentence gets core's for it.
    expect(await run(409, 'conflict', { reason: 'busy' })).toMatchObject({ message: SHORTFALL_PO_BUSY_COPY });
  });

  it('the route’s own answers: rate limit, signed out, the MFA step-up, a fault (never raw server text)', async () => {
    const run = async (status: number, message: string, details?: unknown) =>
      submitShortfallPo(deps({ draft: vi.fn(async () => { throw refusal(status, message, details); }) }), input);
    expect(await run(429, 'Too many requests — slow down.')).toMatchObject({ reason: 'rate_limited', message: SHORTFALL_PO_TOO_MANY_COPY, dropKey: false });
    expect(await run(401, 'unauthenticated')).toMatchObject({ reason: 'unauthenticated', message: SHORTFALL_PO_SIGN_IN_COPY, closed: true });
    expect(await run(403, 'Re-authenticate with MFA before performing this action.', { reason: 'aal2_required' })).toMatchObject({
      reason: 'forbidden',
      message: 'Re-authenticate with MFA before performing this action.',
      closed: true,
    });
    expect(await run(500, SHORTFALL_PO_FAILED_COPY, { reason: 'failed' })).toMatchObject({ reason: 'failed', message: SHORTFALL_PO_FAILED_COPY, dropKey: false });
    expect(await run(502, 'The server had a problem. Try again in a moment.')).toMatchObject({ reason: 'failed', message: SHORTFALL_PO_FAILED_COPY });
  });

  it('an answer this build cannot read: the drafts may exist, so it says so and shows what is on a draft now', async () => {
    const drafted = order({ a: { drafts: { rows: [{ poId: PO_A, poNumber: 'PO-2026-0044', remaining: 10 }], hiddenRemaining: 0 } } });
    const d = deps({
      draft: vi.fn(async () => {
        throw new ShortfallPoResultShapeError('created is not a list');
      }),
      reread: vi.fn(async () => drafted),
    });
    const out = await submitShortfallPo(d, input);
    expect(out).toMatchObject({ kind: 'refused', reason: 'unreadable', message: SHORTFALL_PO_UNREADABLE_COPY, dropKey: false, refresh: true });
    expect(out.kind === 'refused' && out.view?.rows[0]?.detail).toBe('Already on draft PO-2026-0044 (not ordered yet)');
  });

  it('never throws, even when reading readiness again throws', async () => {
    const d = deps({
      draft: vi.fn(async () => {
        throw refusal(400, 'x', { reason: 'item_not_draftable' });
      }),
      reread: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    await expect(submitShortfallPo(d, input)).resolves.toMatchObject({ kind: 'refused', reason: 'item_not_draftable' });
  });
});

describe('after drafting: each draft opens on the phone’s PO screen', () => {
  it('a failed names read says "couldn’t be loaded" under a draft with a supplier', () => {
    expect(shortfallCreatedRows(RESULT, null)[0]!.supplier).toBe(SHORTFALL_SUPPLIER_UNKNOWN_COPY);
  });

  it('its row (core’s words), its supplier as the web shows it, and a typed route', () => {
    expect(shortfallCreatedRows(RESULT, NAMES)).toEqual([
      {
        purchaseOrderId: PO_A,
        label: 'PO-2026-0044 · 1 line, 10 units',
        supplier: 'Acme School Supply',
        accessibilityLabel: 'PO-2026-0044 · 1 line, 10 units. Acme School Supply.',
        route: { pathname: '/po/[id]', params: { id: PO_A } },
      },
      {
        purchaseOrderId: PO_B,
        label: 'PO-2026-0045 · 1 line, 5 units',
        supplier: SHORTFALL_NO_SUPPLIER_COPY,
        accessibilityLabel: 'PO-2026-0045 · 1 line, 5 units. No supplier: goes on a draft without one; choose a supplier before ordering.',
        route: { pathname: '/po/[id]', params: { id: PO_B } },
      },
    ]);
  });
});

describe('the server’s maxima over the rows: core’s shortfallViewWithMaxima (the web’s rule too)', () => {
  it('never raises a most; an item missing from the answer has nothing left', () => {
    const view = viewOf(order());
    const out = shortfallViewWithMaxima(view, { [FX_ITEM_A]: 99 });
    expect(out.rows.map((r) => [r.state, r.draftable])).toEqual([
      ['draftable', 10],
      ['covered', 0],
      ['covered', 0],
    ]);
    expect(out.draftableCount).toBe(1);
  });
});

describe('readShortfallSupplierNames (by id, archived included: the web’s read)', () => {
  function client(answer: { data: unknown; error: unknown } | Error) {
    const calls: unknown[][] = [];
    const chain = {
      select: (...a: unknown[]) => (calls.push(['select', ...a]), chain),
      eq: (...a: unknown[]) => (calls.push(['eq', ...a]), chain),
      in: async (...a: unknown[]) => {
        calls.push(['in', ...a]);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    };
    return { calls, from: vi.fn((table: string) => (calls.push(['from', table]), chain)) };
  }

  it('reads only the suppliers asked for, by id, archived ones marked, and names them by id', async () => {
    const c = client({
      data: [
        { id: SUP1, name: 'Acme School Supply', deleted_at: null },
        { id: SUP2, name: 'Old Paper Co', deleted_at: '2026-09-01T00:00:00Z' },
        { id: 7, name: 'x' },
      ],
      error: null,
    });
    const names = await readShortfallSupplierNames(c, { organizationId: 'org-1', supplierIds: [SUP2, SUP1, SUP1] });
    expect(names && [...names]).toEqual([
      [SUP1, { name: 'Acme School Supply', archived: false }],
      [SUP2, { name: 'Old Paper Co', archived: true }],
    ]);
    expect(c.calls).toEqual([
      ['from', 'suppliers'],
      ['select', 'id, name, deleted_at'],
      ['eq', 'organization_id', 'org-1'],
      ['in', 'id', [SUP1, SUP2]],
    ]);
  });

  it('whatever the Suppliers module says (a record’s label), nothing read for no ids, and null on a failed read (never throws)', async () => {
    const none = client({ data: [], error: null });
    expect(await readShortfallSupplierNames(none, { organizationId: 'o', supplierIds: [] })).toEqual(new Map());
    expect(none.from).not.toHaveBeenCalled();
    expect(await readShortfallSupplierNames(client({ data: null, error: { message: 'x' } }), { organizationId: 'o', supplierIds: [SUP1] })).toBeNull();
    expect(await readShortfallSupplierNames(client(new Error('offline')), { organizationId: 'o', supplierIds: [SUP1] })).toBeNull();
  });

  it('more than 100 ids are read in batches of 100 (a bounded URL; no row cap either way)', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `0a000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const c = client({ data: [], error: null });
    await readShortfallSupplierNames(c, { organizationId: 'o', supplierIds: ids });
    const batches = c.calls.filter((x) => x[0] === 'in').map((x) => (x[2] as string[]).length);
    expect(batches).toEqual([100, 50]);
  });
});

it('fixture sanity: the order is in the warehouse the items belong to', () => {
  const r = order();
  expect(r.state === 'ok' && r.assessment.order.warehouseId).toBe(FX_WH);
});
