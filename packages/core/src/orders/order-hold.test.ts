import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  describeHoldResult,
  describeHoldTopUp,
  HOLD_AVAILABLE_STOCK_LABEL,
  HOLD_BUSY_COPY,
  HOLD_FAILED_COPY,
  HOLD_MODULE_OFF_COPY,
  HOLD_NO_WAREHOUSE_ACCESS_COPY,
  HOLD_NOT_APPLICABLE_COPY,
  HOLD_NOT_APPROVER_COPY,
  HOLD_ORDER_NOT_FOUND_COPY,
  holdAddedUnits,
  holdStillShortUnits,
  HoldResultShapeError,
  isHoldStatus,
  parseHoldOrderStockResult,
  shouldOfferHoldStock,
  shouldTopUpHolds,
  type HoldOutcome,
} from './order-hold';
import {
  assessOrderReadiness,
  orderReadinessPhase,
  parseOrderReadinessFacts,
  READINESS_HOLD_STATUSES,
} from './readiness';
import { ALLOWED_TRANSITIONS, type OrderStatus } from '../order-state-machine';

const ORDER_STATUSES = Object.keys(ALLOWED_TRANSITIONS) as OrderStatus[];

const A = '03780000-0000-0000-0000-000000000f01';
const B = '03780000-0000-0000-0000-000000000f02';

describe('parseHoldOrderStockResult (hold_order_stock 0378)', () => {
  it('reads the answer, numbers as JSON numbers or numeric strings', () => {
    expect(
      parseHoldOrderStockResult({
        held: [{ itemId: A, added: 8 }],
        stillShort: [{ itemId: B, quantity: '6.0000' }],
      }),
    ).toEqual({ held: [{ itemId: A, added: 8 }], stillShort: [{ itemId: B, quantity: 6 }] });
    expect(parseHoldOrderStockResult({ held: [], stillShort: [] })).toEqual({ held: [], stillShort: [] });
  });

  it('tolerates keys it does not know (a later additive change never breaks an older phone)', () => {
    expect(
      parseHoldOrderStockResult({ held: [{ itemId: A, added: 1, note: 'x' }], stillShort: [], v: 2 }),
    ).toEqual({ held: [{ itemId: A, added: 1 }], stillShort: [] });
  });

  it.each([
    ['null', null],
    ['a list', []],
    ['no held', { stillShort: [] }],
    ['no stillShort', { held: [] }],
    ['held not a list', { held: {}, stillShort: [] }],
    ['an entry not an object', { held: [1], stillShort: [] }],
    ['no item id', { held: [{ added: 1 }], stillShort: [] }],
    ['a zero added', { held: [{ itemId: A, added: 0 }], stillShort: [] }],
    ['a negative quantity', { held: [], stillShort: [{ itemId: A, quantity: -1 }] }],
    ['a non-number', { held: [{ itemId: A, added: 'lots' }], stillShort: [] }],
    ['NaN', { held: [{ itemId: A, added: Number.NaN }], stillShort: [] }],
  ])('refuses a wrong shape: %s (never guesses a number)', (_name, raw) => {
    expect(() => parseHoldOrderStockResult(raw)).toThrow(HoldResultShapeError);
  });

  it('adds up what was held and what is still short', () => {
    const r = { held: [{ itemId: A, added: 8 }, { itemId: B, added: 2 }], stillShort: [{ itemId: B, quantity: 6 }] };
    expect(holdAddedUnits(r)).toBe(10);
    expect(holdStillShortUnits(r)).toBe(6);
  });
});

describe('shouldTopUpHolds (decision D15)', () => {
  it('holds after an add or a raise only for an approver at a hold status', () => {
    const table = ORDER_STATUSES.map((status) => [
      status,
      shouldTopUpHolds({ status, canApproveOrders: true }),
      shouldTopUpHolds({ status, canApproveOrders: false }),
    ]);
    expect(table.filter(([, approver]) => approver).map(([s]) => s)).toEqual([
      'approved',
      'pick_slip_generated',
      'picking_in_progress',
    ]);
    // Mutation "always call": a requester who may not approve would create a
    // commitment. Never.
    expect(table.filter(([, , requester]) => requester)).toEqual([]);
  });

  it('the hold statuses are readiness\'s, and nothing else', () => {
    expect([...READINESS_HOLD_STATUSES]).toEqual(['approved', 'pick_slip_generated', 'picking_in_progress']);
    expect(isHoldStatus('pending_approval')).toBe(false);
    expect(isHoldStatus('backordered')).toBe(false);
    expect(isHoldStatus('picking_complete')).toBe(false);
    expect(isHoldStatus(null)).toBe(false);
    expect(isHoldStatus(undefined)).toBe(false);
    expect(isHoldStatus('')).toBe(false);
  });
});

describe('shouldOfferHoldStock (the "Hold available stock" button, web and phone)', () => {
  /** An order's readiness: one line per item, each owing 10, `heldOwn` as given. */
  function assessed(status: string, heldOwn: number[], opts: { linesCapped?: boolean } = {}) {
    const items = heldOwn.map((held, i) => ({
      itemId: `i${i}`,
      visible: true,
      name: `Item ${i}`,
      sku: `SKU-${i}`,
      supplierId: null,
      itemWarehouseId: 'wh',
      deleted: false,
      archived: false,
      isBundle: false,
      onHand: 40,
      heldOwn: held,
      heldOtherOrders: 0,
      heldRentals: 0,
      here: { rack: 40, site: 0, unplaced: 0, staging: 0 },
      elsewhere: { pickable: 0, staging: 0 },
      stagingSources: [],
      stagingHiddenQty: 0,
      pendingOthers: null,
      committedOtherShortfall: 0,
      inbound: null,
      drafts: null,
    }));
    return assessOrderReadiness(
      parseOrderReadinessFacts({
        v: 1,
        observedAt: '2026-09-28T12:00:00.000Z',
        phase: orderReadinessPhase(status),
        linesCapped: opts.linesCapped ?? false,
        order: {
          id: 'o1',
          orderNumber: 1,
          status,
          warehouseId: 'wh',
          neededBy: null,
          fulfillmentType: 'pickup',
          timeZone: 'America/Los_Angeles',
        },
        lines: opts.linesCapped
          ? []
          : items.map((it, i) => ({
              lineId: `l${i}`,
              itemId: it.itemId,
              requested: 10,
              fulfilled: 0,
              picked: null,
              createdAt: new Date(Date.UTC(2026, 8, 1, 0, 0, i)).toISOString(),
            })),
        items: opts.linesCapped ? [] : items,
      }),
      { now: '2026-09-28T12:00:00.000Z' },
    );
  }

  it('offers it to an approver at a hold status when a line is not held or partly held', () => {
    for (const status of ['approved', 'pick_slip_generated', 'picking_in_progress']) {
      expect(shouldOfferHoldStock({ assessment: assessed(status, [10, 0]), canApproveOrders: true }), status).toBe(true);
      expect(shouldOfferHoldStock({ assessment: assessed(status, [10, 4]), canApproveOrders: true }), status).toBe(true);
    }
  });

  it('never when every line is held, to someone who may not approve, before approval, or on a capped or failed read', () => {
    expect(shouldOfferHoldStock({ assessment: assessed('approved', [10, 10]), canApproveOrders: true })).toBe(false);
    expect(shouldOfferHoldStock({ assessment: assessed('approved', [0]), canApproveOrders: false })).toBe(false);
    for (const status of ['pending_approval', 'backordered', 'picking_complete', 'in_transit', 'completed']) {
      expect(shouldOfferHoldStock({ assessment: assessed(status, [0]), canApproveOrders: true }), status).toBe(false);
    }
    expect(
      shouldOfferHoldStock({ assessment: assessed('approved', [0], { linesCapped: true }), canApproveOrders: true }),
    ).toBe(false);
    expect(shouldOfferHoldStock({ assessment: null, canApproveOrders: true })).toBe(false);
  });
});

describe('hold words', () => {
  it('what "Hold available stock" says', () => {
    expect(HOLD_AVAILABLE_STOCK_LABEL).toBe('Hold available stock');
    expect(describeHoldResult({ held: [{ itemId: A, added: 8 }, { itemId: B, added: 2 }], stillShort: [] })).toBe(
      'Held 10 more units for this order.',
    );
    expect(describeHoldResult({ held: [{ itemId: A, added: 1 }], stillShort: [{ itemId: B, quantity: 6 }] })).toBe(
      'Held 1 more unit for this order. 6 units are still short: there is no free stock to hold for them.',
    );
    expect(describeHoldResult({ held: [], stillShort: [{ itemId: B, quantity: 1 }] })).toBe(
      '1 unit is still short: there is no free stock to hold for it.',
    );
    expect(describeHoldResult({ held: [], stillShort: [] })).toBe('Nothing more to hold for this order.');
    expect(describeHoldResult({ held: [{ itemId: A, added: 16693 }], stillShort: [] })).toBe(
      'Held 16,693 more units for this order.',
    );
  });

  it('after an add or a raise: the failure always says so and points to the button', () => {
    const failed: HoldOutcome = { ok: false, reason: 'failed', message: HOLD_FAILED_COPY };
    expect(describeHoldTopUp(failed, 'added')).toBe('Added. Stock was not held for it; use Hold available stock.');
    expect(describeHoldTopUp(failed, 'raised')).toBe(
      'Changed. Stock was not held for the extra units; use Hold available stock.',
    );
    expect(describeHoldTopUp({ ok: false, reason: 'forbidden', message: HOLD_NOT_APPROVER_COPY }, 'added')).toBe(
      'Added. Stock was not held for it; use Hold available stock.',
    );
  });

  it('after an add or a raise: what was held, what could not be, or nothing to say', () => {
    expect(describeHoldTopUp(null, 'added')).toBeNull();
    expect(describeHoldTopUp({ ok: true, held: [], stillShort: [] }, 'raised')).toBeNull();
    expect(describeHoldTopUp({ ok: true, held: [{ itemId: A, added: 8 }], stillShort: [] }, 'added')).toBe(
      'Held 8 units for this order.',
    );
    expect(
      describeHoldTopUp({ ok: true, held: [{ itemId: A, added: 2 }], stillShort: [{ itemId: A, quantity: 6 }] }, 'raised'),
    ).toBe('Held 2 units for this order. 6 units could not be held: there is no free stock for them.');
    expect(describeHoldTopUp({ ok: true, held: [], stillShort: [{ itemId: A, quantity: 1 }] }, 'added')).toBe(
      '1 unit could not be held: there is no free stock for it.',
    );
  });

  it('honest words: no "book", no percentage, nothing guaranteed or reserved for sure', () => {
    const words = [
      HOLD_AVAILABLE_STOCK_LABEL,
      HOLD_NOT_APPROVER_COPY,
      HOLD_NO_WAREHOUSE_ACCESS_COPY,
      HOLD_NOT_APPLICABLE_COPY,
      HOLD_BUSY_COPY,
      HOLD_ORDER_NOT_FOUND_COPY,
      HOLD_MODULE_OFF_COPY,
      HOLD_FAILED_COPY,
      describeHoldResult({ held: [{ itemId: A, added: 2 }], stillShort: [{ itemId: B, quantity: 3 }] }),
      describeHoldResult({ held: [], stillShort: [] }),
      describeHoldTopUp({ ok: false, reason: 'busy', message: HOLD_BUSY_COPY }, 'added')!,
      describeHoldTopUp({ ok: false, reason: 'busy', message: HOLD_BUSY_COPY }, 'raised')!,
      describeHoldTopUp({ ok: true, held: [{ itemId: A, added: 2 }], stillShort: [{ itemId: B, quantity: 3 }] }, 'added')!,
    ];
    expect(words.filter((w) => /\bbooks?\b|%|guarantee|verified|reserved/i.test(w))).toEqual([]);
  });
});

describe('order-hold source literals', () => {
  it('says no "book", no "%", no "guarantee"', () => {
    const HERE = path.dirname(fileURLToPath(import.meta.url));
    const file = 'order-hold.ts';
    const source = ts.createSourceFile(file, readFileSync(path.join(HERE, file), 'utf8'), ts.ScriptTarget.Latest, true);
    const out: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node)) return;
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push(node.text);
      else if (ts.isTemplateExpression(node)) {
        out.push(node.head.text + node.templateSpans.map((s) => '${…}' + s.literal.text).join(''));
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(out.length).toBeGreaterThan(10);
    expect(out.filter((t) => /\bbooks?\b|%|guarantee|verified/i.test(t))).toEqual([]);
  });
});
