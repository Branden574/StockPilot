/**
 * order_readiness_facts answers for the F2-3 phone tests (put away, and the
 * approve-partial preview and result), turned into REAL assessments with
 * core's own parser and assessment (the functions the web server and the
 * phone run), so no test hand-builds an assessment core would never make.
 */
import {
  assessOrderReadiness,
  parseOrderReadinessFacts,
  type OrderReadinessResult,
} from '@stockpilot/core';

export const FX_ORDER = '0a000000-0000-0000-0000-00000000f301';
export const FX_WH = '0a000000-0000-0000-0000-0000000000a1';
export const FX_ITEM_A = '0a000000-0000-0000-0000-0000000000e1';
export const FX_ITEM_B = '0a000000-0000-0000-0000-0000000000e2';
export const FX_NOW = new Date('2026-09-28T18:00:00Z');

const NAMES: Record<string, string> = { [FX_ITEM_A]: 'Maus I', [FX_ITEM_B]: 'Notebooks' };

/** One visible item as the function answers it: 10 on a rack unless told. */
export function fxItem(itemId: string, over: Record<string, unknown> = {}) {
  return {
    itemId,
    visible: true,
    name: NAMES[itemId] ?? 'Item',
    sku: null,
    supplierId: null,
    itemWarehouseId: FX_WH,
    deleted: false,
    archived: false,
    isBundle: false,
    onHand: 10,
    heldOwn: 0,
    heldOtherOrders: 0,
    heldRentals: 0,
    here: { rack: 10, site: 0, unplaced: 0, staging: 0 },
    elsewhere: { pickable: 0, staging: 0 },
    stagingSources: [],
    stagingHiddenQty: 0,
    pendingOthers: null,
    committedOtherShortfall: 0,
    inbound: null,
    drafts: null,
    ...over,
  };
}

export function fxLine(
  lineId: string,
  itemId: string,
  requested: number,
  over: Record<string, unknown> = {},
) {
  return {
    lineId,
    itemId,
    requested,
    fulfilled: 0,
    picked: null,
    createdAt: `2026-09-27T10:00:0${lineId.slice(-1)}Z`,
    ...over,
  };
}

export function fxFacts(over: {
  status?: string;
  phase?: string;
  orderId?: string;
  linesCapped?: boolean;
  lines: unknown[];
  items: unknown[];
}) {
  return {
    v: 1,
    observedAt: '2026-09-28T17:59:58Z',
    phase: over.phase ?? 'to_pick',
    linesCapped: over.linesCapped ?? false,
    order: {
      id: over.orderId ?? FX_ORDER,
      orderNumber: 17,
      status: over.status ?? 'pending_approval',
      warehouseId: FX_WH,
      neededBy: null,
      fulfillmentType: 'pickup',
    },
    lines: over.lines,
    items: over.items,
  };
}

/** A readiness result, as the phone's readOrderReadiness makes it. */
export function fxResult(facts: unknown): OrderReadinessResult {
  return { state: 'ok', assessment: assessOrderReadiness(parseOrderReadinessFacts(facts), { now: FX_NOW }) };
}
