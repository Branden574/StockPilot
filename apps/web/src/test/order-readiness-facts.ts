/**
 * Test helper: order_readiness_facts answers (the SQL shape, v 1) and the
 * readiness results core makes of them, for the web order page's tests.
 *
 * The results go through the REAL core parser and assessment, so a test that
 * renders "Needs put-away" does so because core judged the facts that way,
 * not because a test wrote the state by hand.
 */
import {
  assessOrderReadiness,
  orderReadinessPhase,
  parseOrderReadinessFacts,
  type OrderReadinessResult,
} from '@stockpilot/core';

export const READINESS_NOW = '2026-09-28T17:42:00.000Z'; // 10:42 AM in Los Angeles

type Json = Record<string, unknown>;

/** A visible item's facts: stock on a rack here unless `over` says otherwise.
 *  onHand defaults to the sum of every holding (records agree). */
export function visibleItemFacts(itemId: string, over: Json = {}): Json {
  const here = { rack: 0, site: 0, unplaced: 0, staging: 0, ...(over.here as Json | undefined) };
  const elsewhere = { pickable: 0, staging: 0, ...(over.elsewhere as Json | undefined) };
  const holdings =
    Number(here.rack) +
    Number(here.site) +
    Number(here.unplaced) +
    Number(here.staging) +
    Number(elsewhere.pickable) +
    Number(elsewhere.staging);
  return {
    itemId,
    visible: true,
    name: `Item ${itemId}`,
    sku: `SKU-${itemId}`,
    supplierId: null,
    itemWarehouseId: 'wh-1',
    deleted: false,
    archived: false,
    isBundle: false,
    onHand: holdings,
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
  };
}

/** An item the reader cannot read: no numbers at all. */
export function hiddenItemFacts(itemId: string): Json {
  return { itemId, visible: false };
}

export interface FactsLine {
  lineId: string;
  itemId: string;
  requested: number;
  fulfilled?: number;
  picked?: number | null;
}

/** The facts JSON order_readiness_facts would answer for this order. */
export function orderReadinessFacts(
  orderId: string,
  status: string,
  lines: FactsLine[],
  items: Json[],
  opts: { neededBy?: string | null; linesCapped?: boolean; warehouseId?: string; timeZone?: string | null } = {},
): Json {
  return {
    v: 1,
    observedAt: READINESS_NOW,
    phase: orderReadinessPhase(status),
    linesCapped: opts.linesCapped ?? false,
    order: {
      id: orderId,
      orderNumber: 42,
      status,
      warehouseId: opts.warehouseId ?? 'wh-1',
      neededBy: opts.neededBy ?? null,
      fulfillmentType: 'pickup',
      // The org's zone, as 0377 answers it (organizations.timezone).
      timeZone: opts.timeZone === undefined ? 'America/Los_Angeles' : opts.timeZone,
    },
    lines: opts.linesCapped
      ? []
      : lines.map((l, i) => ({
          lineId: l.lineId,
          itemId: l.itemId,
          requested: l.requested,
          fulfilled: l.fulfilled ?? 0,
          picked: l.picked ?? null,
          createdAt: new Date(Date.UTC(2026, 8, 1, 0, 0, i)).toISOString(),
        })),
    items: opts.linesCapped ? [] : items,
  };
}

/** The settled result the web service's `result()` returns for these facts. */
export function readinessOk(facts: Json): OrderReadinessResult {
  return {
    state: 'ok',
    assessment: assessOrderReadiness(parseOrderReadinessFacts(facts), { now: READINESS_NOW }),
  };
}

export const READINESS_FAILED: OrderReadinessResult = {
  state: 'failed',
  message: 'Could not check readiness.',
};
