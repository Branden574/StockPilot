import 'server-only';

import {
  exchangeRail,
  exchangeStatusStaffLabel,
  parseExchangeStatus,
  prepareTakeLine,
  replacementClassOf,
  returnLineLabel,
  type ExchangeStatus,
  type RailStep,
  type ReplacementClass,
  type ReplacementDeliverySite,
} from '@stockpilot/core';

import { exchangeCreateEnabled } from '@/lib/returns/exchange-switch';

import type { ServiceContext } from './context';
import { fetchAllRowsByIds, reportDegradedRead } from './lib/fetch-by-ids';
import { fetchRackHoldingsByItem } from './rack-holdings';

/**
 * The exchange half of the RMA workbench (returns RX-2, plan section 4 RX-2
 * and 3.9): the REPLACEMENT column, the outbound rail and the facts the
 * actions table needs. Reads only; RMAService gates before these run.
 *
 * Tier 2 (beside the RMA's other reads): the RMA's `return_overview` row
 * (the exchange status, the live replacement, the decision-log flags every
 * member reads the same) and its replacement orders, newest first. Tier 3:
 * the live replacement's lines and holds, free stock for every exchange item
 * (on hand minus every active hold: the rule approve_partial uses; advice,
 * the database decides at approval) and, for "Take Large ×1 from 12-B (3 on
 * hand)", the placed rack holdings in the order's warehouse (a label).
 */

export interface ExchangeItem {
  name: string | null;
  sku: string | null;
  variant: string | null;
  deleted: boolean;
  imageUrl: string | null;
  thumbUrl: string | null;
}

export interface ReturnWorkbenchExchangeLine {
  id: string;
  returnLineId: string;
  status: 'requested' | 'approved' | 'declined' | 'cancelled';
  requestedItemId: string | null;
  requestedQuantity: number;
  /** "Warehouse will review": the requester's note (a requester may write one). */
  requestNote: string | null;
  requestedByKind: string;
  requestedItem: ExchangeItem | null;
  /** Free stock of the requested item (null when unknown). */
  requestedFree: number | null;
  approvedItemId: string | null;
  approvedQuantity: number | null;
  approvedItem: ExchangeItem | null;
  approvedFree: number | null;
  /** "Changed by the warehouse": approved differs from the request. */
  changedByWarehouse: boolean;
  revision: number;
}

export interface ReturnWorkbenchReplacementLine {
  orderLineId: string;
  itemId: string;
  label: string;
  item: ExchangeItem | null;
  requested: number;
  fulfilled: number;
  held: number;
  /** "Take Large ×1 from 12-B (3 on hand)" before the prepare tap, or null. */
  take: string | null;
}

export interface ReturnWorkbenchReplacement {
  orderId: string;
  orderNumber: number | null;
  status: string;
  fulfillmentType: 'pickup' | 'delivery';
  /** Not cancelled or denied. */
  live: boolean;
  /** undrawn, drawn (picked, not handed over), handed_over, none (core replacementClassOf). */
  class: ReplacementClass;
  owed: number;
  held: number;
  short: boolean;
  lines: ReturnWorkbenchReplacementLine[];
}

export interface ReturnWorkbenchExchange {
  kind: 'return' | 'exchange';
  status: ExchangeStatus;
  statusLabel: string;
  lines: ReturnWorkbenchExchangeLine[];
  /** The live replacement, else the newest one (cancelled), else null. */
  replacement: ReturnWorkbenchReplacement | null;
  /** Earlier replacements of this RMA (cancelled by a change or a cancel), newest first. */
  history: Array<{ orderId: string; orderNumber: number | null; status: string }>;
  releasedEarly: boolean;
  /** Who released and why (holders of returns:read or returns:manage; else null). */
  release: { byName: string | null; reason: string | null; at: string } | null;
  /** Received at the counter (a received decision with channel counter). */
  counter: boolean;
  rail: RailStep[];
  /** An exchange line was approved at some point (cancel then needs order approval and a reason). */
  hasApprovedExchange: boolean;
  /** The kill switch: "Add a replacement" (a new exchange) is offered only when on. */
  createEnabled: boolean;
  /**
   * The active delivery sites the original order's warehouse serves, by name
   * (desk check F6): offered with "Pickup instead" when an approval, a change
   * or a re-issue is refused replacement_site_not_available.
   */
  deliverySites: ReplacementDeliverySite[];
}

export type RawExchangeLine = {
  id: string;
  return_line_id: string;
  status: string;
  requested_item_id: string | null;
  requested_quantity: number | string;
  request_note: string | null;
  requested_by_kind: string;
  approved_item_id: string | null;
  approved_quantity: number | string | null;
  replacement_order_request_id: string | null;
  revision: number | null;
  created_at: string;
};

/** The embed the workbench's tier-1 read adds (hinted: one key to the RMA). */
export const EXCHANGE_LINES_EMBED = `exchange_lines:return_exchange_lines!return_exchange_lines_return_fkey (
         id, return_line_id, status, requested_item_id, requested_quantity, request_note, requested_by_kind,
         approved_item_id, approved_quantity, replacement_order_request_id, revision, created_at)`;

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

export function exchangeItemIds(lines: RawExchangeLine[]): string[] {
  const ids = new Set<string>();
  for (const l of lines) {
    if (l.requested_item_id) ids.add(l.requested_item_id);
    if (l.approved_item_id) ids.add(l.approved_item_id);
  }
  return [...ids];
}

type OverviewFacts = {
  kind: string | null;
  exchange_status: string | null;
  replacement_order_id: string | null;
  released_early: boolean | null;
  counter: boolean | null;
  /** The view's newest replacement (the live one when there is one): status and what it still owes. */
  replacement_status?: string | null;
  replacement_owed?: number | string | null;
};

export type ReplacementRow = {
  id: string;
  order_number: number | null;
  status: string;
  fulfillment_type: 'pickup' | 'delivery' | null;
  warehouse_id: string | null;
  completed_at: string | null;
  created_at: string;
};

/** Tier 2: the RMA's overview row and its replacement orders (none read for a return). */
export async function readExchangeTier2(
  ctx: ServiceContext,
  returnId: string,
  hasExchangeRows: boolean,
): Promise<{ overview: OverviewFacts | null; replacements: ReplacementRow[] }> {
  if (!hasExchangeRows) return { overview: null, replacements: [] };
  const [ovRes, repRes] = await Promise.all([
    ctx.supabase
      .from('return_overview')
      .select('kind, exchange_status, replacement_order_id, released_early, counter, replacement_status, replacement_owed')
      .eq('organization_id', ctx.organizationId)
      .eq('id', returnId)
      .maybeSingle(),
    ctx.supabase
      .from('order_requests')
      .select('id, order_number, status, fulfillment_type, warehouse_id, completed_at, created_at')
      .eq('organization_id', ctx.organizationId)
      .eq('replacement_for_return_id', returnId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(50),
  ]);
  if (ovRes.error) reportDegradedRead('returns.workbench.exchange_overview', ovRes.error, { returnId });
  if (repRes.error) reportDegradedRead('returns.workbench.replacements', repRes.error, { returnId });
  return {
    overview: (ovRes.data as OverviewFacts | null) ?? null,
    replacements: (repRes.data as ReplacementRow[] | null) ?? [],
  };
}

/**
 * The active delivery sites a warehouse serves (desk check F6), under the
 * caller's RLS: the warehouse's charters whose status is active, the pair the
 * database checks for a delivery replacement. A failed read answers [] (the
 * chooser then offers pickup only; the database decides anyway).
 */
export async function readDeliverySites(ctx: ServiceContext, warehouseId: string | null): Promise<ReplacementDeliverySite[]> {
  if (!warehouseId) return [];
  try {
    const { data, error } = await ctx.supabase
      .from('warehouse_charters')
      .select('charter:charters!charter_id (id, name, status)')
      .eq('organization_id', ctx.organizationId)
      .eq('warehouse_id', warehouseId);
    if (error) {
      reportDegradedRead('returns.workbench.delivery_sites', error, { warehouseId });
      return [];
    }
    const out: ReplacementDeliverySite[] = [];
    for (const row of (data ?? []) as Array<{ charter: unknown }>) {
      const c = (Array.isArray(row.charter) ? row.charter[0] : row.charter) as
        | { id?: unknown; name?: unknown; status?: unknown }
        | null
        | undefined;
      if (c && typeof c.id === 'string' && typeof c.name === 'string' && c.status === 'active') out.push({ id: c.id, name: c.name });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  } catch (err) {
    reportDegradedRead('returns.workbench.delivery_sites', err, { warehouseId });
    return [];
  }
}

/** Free stock per item: on hand minus every active hold (advice; never decides). */
export async function readFreeStock(ctx: ServiceContext, itemIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (itemIds.length === 0) return out;
  try {
    const [items, holds] = await Promise.all([
      fetchAllRowsByIds<{ id: string; quantity_on_hand: number | string }>(itemIds, (batch) => (from, to) =>
        ctx.supabase
          .from('inventory_items')
          .select('id, quantity_on_hand')
          .eq('organization_id', ctx.organizationId)
          .in('id', batch)
          .order('id')
          .range(from, to),
      ),
      fetchAllRowsByIds<{ id: string; item_id: string; quantity: number | string }>(itemIds, (batch) => (from, to) =>
        ctx.supabase
          .from('stock_reservations')
          .select('id, item_id, quantity')
          .eq('organization_id', ctx.organizationId)
          .in('item_id', batch)
          .is('released_at', null)
          .order('id')
          .range(from, to),
      ),
    ]);
    const held = new Map<string, number>();
    for (const h of holds) held.set(h.item_id, (held.get(h.item_id) ?? 0) + num(h.quantity));
    for (const i of items) out.set(i.id, Math.max(0, num(i.quantity_on_hand) - (held.get(i.id) ?? 0)));
  } catch (err) {
    reportDegradedRead('returns.workbench.free_stock', err, { items: itemIds.length });
  }
  return out;
}

type ReplacementLineRow = { id: string; item_id: string; quantity_requested: number | string; quantity_fulfilled: number | string | null };

/** Tier 3: the live replacement's lines, holds and (label) rack holdings. */
export async function readReplacementDetail(
  ctx: ServiceContext,
  order: { id: string; warehouse_id: string | null },
): Promise<{
  lines: ReplacementLineRow[];
  heldByItem: Map<string, number>;
  racksByItem: Map<string, Array<{ name: string; quantity: number }>>;
}> {
  const [linesRes, holdsRes] = await Promise.all([
    ctx.supabase
      .from('order_request_lines')
      .select('id, item_id, quantity_requested, quantity_fulfilled')
      .eq('order_request_id', order.id)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true }),
    ctx.supabase
      .from('stock_reservations')
      .select('item_id, quantity')
      .eq('organization_id', ctx.organizationId)
      .eq('order_request_id', order.id)
      .is('released_at', null),
  ]);
  if (linesRes.error) reportDegradedRead('returns.workbench.replacement_lines', linesRes.error, { orderId: order.id });
  if (holdsRes.error) reportDegradedRead('returns.workbench.replacement_holds', holdsRes.error, { orderId: order.id });
  const lines = (linesRes.data as ReplacementLineRow[] | null) ?? [];
  const heldByItem = new Map<string, number>();
  for (const h of (holdsRes.data as Array<{ item_id: string; quantity: number | string }> | null) ?? []) {
    heldByItem.set(h.item_id, (heldByItem.get(h.item_id) ?? 0) + num(h.quantity));
  }
  let racksByItem = new Map<string, Array<{ name: string; quantity: number }>>();
  try {
    const racks = await fetchRackHoldingsByItem(ctx, [...new Set(lines.map((l) => l.item_id))], order.warehouse_id);
    racksByItem = new Map([...racks.entries()].map(([k, v]) => [k, v.map((h) => ({ name: h.name, quantity: num(h.quantity) }))]));
  } catch (err) {
    reportDegradedRead('returns.workbench.replacement_racks', err, { orderId: order.id });
  }
  return { lines, heldByItem, racksByItem };
}

type Decision = {
  kind: string;
  reason: string | null;
  actorName: string | null;
  createdAt: string;
  orderRequestId?: string | null;
};

/** Assemble the exchange half (pure: every fact was read above). */
export function buildExchangeView(input: {
  returnStatus: string;
  rawLines: RawExchangeLine[];
  overview: OverviewFacts | null;
  replacements: ReplacementRow[];
  detail: Awaited<ReturnType<typeof readReplacementDetail>> | null;
  itemOf: (itemId: string | null) => ExchangeItem | null;
  freeOf: (itemId: string | null) => number | null;
  decisions: Decision[];
  deliverySites?: ReplacementDeliverySite[];
}): ReturnWorkbenchExchange {
  const lines: ReturnWorkbenchExchangeLine[] = [...input.rawLines]
    .sort((a, b) => (a.created_at === b.created_at ? a.id.localeCompare(b.id) : a.created_at.localeCompare(b.created_at)))
    .map((l) => {
      const status = (['requested', 'approved', 'declined', 'cancelled'] as const).find((s) => s === l.status) ?? 'requested';
      const approvedQuantity = l.approved_quantity === null || l.approved_quantity === undefined ? null : num(l.approved_quantity);
      return {
        id: l.id,
        returnLineId: l.return_line_id,
        status,
        requestedItemId: l.requested_item_id,
        requestedQuantity: num(l.requested_quantity),
        requestNote: l.request_note,
        requestedByKind: l.requested_by_kind,
        requestedItem: input.itemOf(l.requested_item_id),
        requestedFree: input.freeOf(l.requested_item_id),
        approvedItemId: l.approved_item_id,
        approvedQuantity,
        approvedItem: input.itemOf(l.approved_item_id),
        approvedFree: input.freeOf(l.approved_item_id),
        changedByWarehouse:
          l.approved_item_id !== null &&
          (l.approved_item_id !== l.requested_item_id || (approvedQuantity !== null && approvedQuantity !== num(l.requested_quantity))),
        revision: l.revision ?? 0,
      };
    });

  const kind: 'return' | 'exchange' = lines.length > 0 ? 'exchange' : 'return';
  const status = parseExchangeStatus(input.overview?.exchange_status ?? (lines.length > 0 ? null : 'none'));
  const liveRow =
    input.replacements.find((r) => r.status !== 'cancelled' && r.status !== 'denied') ?? null;
  const shown = liveRow ?? input.replacements[0] ?? null;

  let replacement: ReturnWorkbenchReplacement | null = null;
  if (shown) {
    const detail = shown === liveRow ? input.detail : null;
    const rLines: ReturnWorkbenchReplacementLine[] = (detail?.lines ?? []).map((l) => {
      const item = input.itemOf(l.item_id);
      const label = returnLineLabel(item?.name ?? null, item?.variant ?? null);
      const requested = num(l.quantity_requested);
      const fulfilled = num(l.quantity_fulfilled);
      const owed = Math.max(0, requested - fulfilled);
      const racks = detail?.racksByItem.get(l.item_id) ?? [];
      const best = [...racks].sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name))[0] ?? null;
      const preparing = shown.status === 'approved' || shown.status === 'pick_slip_generated' || shown.status === 'picking_in_progress';
      return {
        orderLineId: l.id,
        itemId: l.item_id,
        label,
        item,
        requested,
        fulfilled,
        held: detail?.heldByItem.get(l.item_id) ?? 0,
        take: preparing && owed > 0 ? prepareTakeLine(label, owed, best?.name ?? null, best ? best.quantity : null) : null,
      };
    });
    const owed = rLines.reduce((s, l) => s + Math.max(0, l.requested - l.fulfilled), 0);
    const held = rLines.reduce((s, l) => s + l.held, 0);
    const fulfilled = rLines.reduce((s, l) => s + l.fulfilled, 0);
    const live = shown === liveRow;
    replacement = {
      orderId: shown.id,
      orderNumber: shown.order_number,
      status: shown.status,
      fulfillmentType: shown.fulfillment_type === 'delivery' ? 'delivery' : 'pickup',
      live,
      class: live ? replacementClassOf(shown.status, fulfilled > 0) : 'none',
      owed,
      held,
      short: live && shown.status === 'approved' && held < owed,
      lines: rLines,
    };
  }

  const releaseRow = liveRow
    ? (input.decisions.find((d) => d.kind === 'released_early' && d.orderRequestId === liveRow.id) ?? null)
    : null;
  const releasedEarly = releaseRow !== null || input.overview?.released_early === true;

  return {
    kind,
    status,
    // Desk check F9: a replacement closed with part never sent says so.
    statusLabel: exchangeStatusStaffLabel(status, {
      returnStatus: input.returnStatus,
      replacementStatus: input.overview?.replacement_status ?? null,
      replacementOwed: input.overview?.replacement_owed === undefined || input.overview?.replacement_owed === null
        ? null
        : num(input.overview.replacement_owed),
    }),
    lines,
    replacement,
    history: input.replacements
      .filter((r) => r !== shown)
      .map((r) => ({ orderId: r.id, orderNumber: r.order_number, status: r.status })),
    releasedEarly,
    release: releaseRow ? { byName: releaseRow.actorName, reason: releaseRow.reason, at: releaseRow.createdAt } : null,
    counter: input.overview?.counter === true,
    rail: exchangeRail({
      exchangeStatus: status,
      returnStatus: input.returnStatus,
      releasedEarly,
      fulfillmentType: replacement?.fulfillmentType ?? null,
      // Review fix P21: a replacement closed with part never sent ends
      // "Partly handed over", stopped (the same facts as the status label).
      replacementStatus: input.overview?.replacement_status ?? null,
      replacementOwed:
        input.overview?.replacement_owed === undefined || input.overview?.replacement_owed === null
          ? null
          : num(input.overview.replacement_owed),
    }),
    hasApprovedExchange: lines.some((l) => l.approvedItemId !== null) || input.replacements.length > 0,
    createEnabled: exchangeCreateEnabled(),
    deliverySites: input.deliverySites ?? [],
  };
}
