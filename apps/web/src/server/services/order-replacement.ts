import 'server-only';

import {
  can,
  collectReturnedItemLine,
  exchangeStatusStaffLabel,
  itemQuantityLabel,
  mapReturnError,
  parseExchangeStatus,
  replacementChipState,
  returnLineLabel,
  slipExchangeLine,
  variantLabel,
  type ExchangeStatus,
} from '@stockpilot/core';

import { ServiceError, type ServiceContext } from './context';
import { fetchAllRowsByIds, reportDegradedRead } from './lib/fetch-by-ids';

/**
 * The exchange replacement order as the order screens, the slips, the orders
 * list and the phone read it (returns RX-2, plan 3.6.9).
 *
 * A replacement order is an ordinary order with `replacement_for_return_id`
 * set (migration 0397): it was created and held by the RMA's functions, its
 * lines are fixed, it is cancelled only through its RMA, and while its RMA
 * waits for the returned item it does not go to picking (the return-first
 * gate, unless a manager released it early). Every one of those rules is the
 * database's; this module only reads, words and maps.
 *
 * READS. The banner, the gate and the chip come from `return_overview` (any
 * member reads it, security invoker: the RMA's own rows and the decision-log
 * facts through return_exchange_flags, the same for every member). Who
 * released the order early and why come from `return_decisions`, which only
 * holders of returns:read or returns:manage can read: everyone else sees
 * "Released before the return." without a name or a reason.
 */

// ── Refusals ─────────────────────────────────────────────────────────────────

/** The hints the order paths can meet on a replacement (0397). */
const REPLACEMENT_HINTS: readonly string[] = [
  'replacement_waiting_for_return',
  'replacement_cancel_via_return',
  'replacement_lines_fixed',
  'replacement_link_server_only',
  'replacement_link_immutable',
];

/**
 * A replacement order's refusal (the return-first gate, the cancel guard, the
 * fixed lines, the link guards) as a ServiceError in core's words, mapped by
 * the database HINT, never by message text (pattern 28). Null for any other
 * error, which the caller maps as before.
 */
export function replacementRefusal(
  error: { code?: string | null; hint?: string | null; message?: string | null; details?: string | null } | null | undefined,
): ServiceError | null {
  const hint = (error?.hint ?? '').trim();
  if (!hint || !REPLACEMENT_HINTS.includes(hint)) return null;
  const mapped = mapReturnError(error);
  return new ServiceError(mapped.code, mapped.message, { reason: hint });
}

// ── The order page's replacement block ──────────────────────────────────────

export interface OrderReplacementReturnedItem {
  itemId: string;
  /** "New Hire Shirt, M" (the item's own variant columns, never a name guess). */
  label: string;
  quantity: number;
}

export interface OrderReplacementInfo {
  returnId: string;
  returnNumber: string | null;
  /** The RMA's own status (received or closed opens the gate). */
  returnStatus: string | null;
  originalOrderId: string | null;
  originalOrderNumber: number | null;
  /** This order is the RMA's live replacement (not one cancelled earlier). */
  live: boolean;
  /** The view's exchange status for the RMA ('none' when unreadable). */
  exchangeStatus: ExchangeStatus;
  exchangeStatusLabel: string;
  /** The return-first gate holds this order: approved, the RMA not received, no early release. */
  waitingForReturn: boolean;
  /** A manager released THIS order before the return arrived. */
  releasedEarly: boolean;
  /** Who and why, for holders of returns:read or returns:manage; else null. */
  release: { byName: string | null; reason: string | null; at: string | null } | null;
  returnReceived: boolean;
  returnedItems: OrderReplacementReturnedItem[];
  /** The RMA revision this order was created at (the timeline label), when readable. */
  revision: number | null;
  /** The viewer may open the RMA (returns module on, returns:read or returns:manage). */
  canOpenReturn: boolean;
  /** The viewer may release it early (returns module on, returns:manage and orders:approve). */
  canReleaseEarly: boolean;
  /** "Exchange replacement for RMA-… (returned item: …, received)" for the slips. */
  slipLine: string;
  /** "Collect the returned item: …" for the driver's hand-over (null once received). */
  driverLine: string | null;
}

type OverviewRow = {
  id: string;
  return_number: string | null;
  status: string | null;
  order_request_id: string | null;
  order_number: number | null;
  replacement_order_id: string | null;
  exchange_status: string | null;
  released_early: boolean | null;
  lines: Array<{ line_id: string; item_id: string; quantity: number | string }> | null;
};

type ItemRow = {
  id: string;
  name: string | null;
  variant_size: string | null;
  variant_width: string | null;
  variant_color: string | null;
  jersey_number: string | null;
};

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

const GATED_STATUSES = new Set(['approved', 'backordered']);

/**
 * The replacement block for one order, or null for an ordinary order. Never
 * throws for a failed read of a label: the banner then shows what it has (the
 * gate words still come from the order's own status and the RMA status).
 */
export async function loadReplacementInfo(
  ctx: ServiceContext,
  order: { id: string; status: string; replacement_for_return_id?: string | null },
): Promise<OrderReplacementInfo | null> {
  const returnId = order.replacement_for_return_id ?? null;
  if (!returnId) return null;

  const canReadDecisions =
    ctx.enabledModules.has('returns') && (can(ctx, 'returns:read') || can(ctx, 'returns:manage'));

  const [overviewRes, decisionsRes] = await Promise.all([
    ctx.supabase
      .from('return_overview')
      .select('id, return_number, status, order_request_id, order_number, replacement_order_id, exchange_status, released_early, lines')
      .eq('organization_id', ctx.organizationId)
      .eq('id', returnId)
      .maybeSingle(),
    canReadDecisions
      ? ctx.supabase
          .from('return_decisions')
          .select('kind, revision, reason, actor_user_id, created_at, seq')
          .eq('organization_id', ctx.organizationId)
          .eq('return_id', returnId)
          .eq('order_request_id', order.id)
          // in-list-bound: the two decision kinds that name this order
          .in('kind', ['replacement_issued', 'released_early'])
          .order('seq', { ascending: true })
      : Promise.resolve({ data: null, error: null }),
  ]);

  if (overviewRes.error) reportDegradedRead('orders.replacement.overview', overviewRes.error, { orderId: order.id });
  const ov = (overviewRes.data as OverviewRow | null) ?? null;
  if (decisionsRes.error) reportDegradedRead('orders.replacement.decisions', decisionsRes.error, { orderId: order.id });
  const decisions =
    (decisionsRes.data as Array<{
      kind: string;
      revision: number | null;
      reason: string | null;
      actor_user_id: string | null;
      created_at: string;
    }> | null) ?? [];

  const issued = decisions.find((d) => d.kind === 'replacement_issued') ?? null;
  const released = decisions.find((d) => d.kind === 'released_early') ?? null;
  const live = ov ? ov.replacement_order_id === order.id && order.status !== 'cancelled' && order.status !== 'denied' : false;

  // The returned items (labels) and the releaser's name, in parallel.
  const returned = (ov?.lines ?? []).map((l) => ({ itemId: l.item_id, quantity: num(l.quantity) }));
  const itemIds = [...new Set(returned.map((r) => r.itemId))];
  const [items, releaserName] = await Promise.all([
    itemIds.length > 0
      ? fetchAllRowsByIds<ItemRow>(itemIds, (batch) => (from, to) =>
          ctx.supabase
            .from('inventory_items')
            .select('id, name, variant_size, variant_width, variant_color, jersey_number')
            .eq('organization_id', ctx.organizationId)
            .in('id', batch)
            .order('id')
            .range(from, to),
        ).catch((err) => {
          reportDegradedRead('orders.replacement.items', err, { items: itemIds.length });
          return [] as ItemRow[];
        })
      : Promise.resolve([] as ItemRow[]),
    released?.actor_user_id ? nameOf(ctx, released.actor_user_id) : Promise.resolve(null),
  ]);
  const byId = new Map(items.map((i) => [i.id, i]));
  const returnedItems: OrderReplacementReturnedItem[] = returned.map((r) => {
    const it = byId.get(r.itemId);
    const variant = it
      ? variantLabel({ size: it.variant_size, width: it.variant_width, color: it.variant_color, jerseyNumber: it.jersey_number })
      : null;
    return { itemId: r.itemId, label: returnLineLabel(it?.name ?? null, variant), quantity: r.quantity };
  });

  const returnStatus = ov?.status ?? null;
  const returnReceived = returnStatus === 'received' || returnStatus === 'closed';
  // The view's flag is about the LIVE replacement; the decision row (staff)
  // names this order exactly.
  const releasedEarly = released !== null || (live && ov?.released_early === true);
  const waitingForReturn =
    live && GATED_STATUSES.has(order.status) && returnStatus === 'approved' && !releasedEarly;
  const exchangeStatus = parseExchangeStatus(ov?.exchange_status);
  const returnedWords = returnedItems.length > 0
    ? returnedItems.map((r) => itemQuantityLabel(r.label, r.quantity)).join(', ')
    : null;
  const returnNumber = ov?.return_number ?? null;

  return {
    returnId,
    returnNumber,
    returnStatus,
    originalOrderId: ov?.order_request_id ?? null,
    originalOrderNumber: ov?.order_number ?? null,
    live,
    exchangeStatus,
    exchangeStatusLabel: exchangeStatusStaffLabel(exchangeStatus, { returnStatus }),
    waitingForReturn,
    releasedEarly,
    release: released
      ? { byName: releaserName, reason: released.reason, at: released.created_at }
      : null,
    returnReceived,
    returnedItems,
    revision: issued?.revision ?? null,
    canOpenReturn: canReadDecisions,
    canReleaseEarly:
      ctx.enabledModules.has('returns') && can(ctx, 'returns:manage') && can(ctx, 'orders:approve'),
    slipLine: slipExchangeLine(returnNumber, returnedWords, returnReceived),
    driverLine: returnedWords && !returnReceived ? collectReturnedItemLine(returnedWords, returnNumber) : null,
  };
}

async function nameOf(ctx: ServiceContext, userId: string): Promise<string | null> {
  try {
    const { data } = await ctx.supabase.from('user_profiles').select('full_name, email').eq('id', userId).maybeSingle();
    const row = data as { full_name: string | null; email: string | null } | null;
    return row?.full_name?.trim() || row?.email || null;
  } catch {
    return null;
  }
}

// ── The orders list's Exchange chip ─────────────────────────────────────────

export interface OrderExchangeChip {
  returnId: string;
  returnNumber: string | null;
  /** "Waiting for return" or "Ready to pick" while the gate matters, else null. */
  state: string | null;
}

/** The chip's second words (plan 3.6.9): core's, shared with the phone. */
export const exchangeChipState = replacementChipState;

/**
 * The chip for a page of orders: ONE batched `return_overview` read for the
 * page's replacement rows (none when the page has no replacement). A row
 * that is not its RMA's live replacement gets the chip without a state. A
 * failed read leaves the chip without a state (the "Exchange" word comes
 * from the order's own column).
 */
export async function loadOrderExchangeChips(
  ctx: ServiceContext,
  rows: Array<{ id: string; replacementForReturnId: string | null }>,
): Promise<Map<string, OrderExchangeChip>> {
  const out = new Map<string, OrderExchangeChip>();
  const withLink = rows.filter((r) => r.replacementForReturnId);
  if (withLink.length === 0) return out;
  const returnIds = [...new Set(withLink.map((r) => r.replacementForReturnId as string))];
  let overview: Array<{ id: string; return_number: string | null; replacement_order_id: string | null; exchange_status: string | null }> = [];
  try {
    overview = await fetchAllRowsByIds(returnIds, (batch) => (from, to) =>
      ctx.supabase
        .from('return_overview')
        .select('id, return_number, replacement_order_id, exchange_status')
        .eq('organization_id', ctx.organizationId)
        .in('id', batch)
        .order('id')
        .range(from, to),
    );
  } catch (err) {
    reportDegradedRead('orders.list.exchange_chips', err, { returns: returnIds.length });
  }
  const byReturn = new Map(overview.map((o) => [o.id, o]));
  for (const r of withLink) {
    const o = byReturn.get(r.replacementForReturnId as string);
    out.set(r.id, {
      returnId: r.replacementForReturnId as string,
      returnNumber: o?.return_number ?? null,
      state: o && o.replacement_order_id === r.id ? exchangeChipState(parseExchangeStatus(o.exchange_status)) : null,
    });
  }
  return out;
}
