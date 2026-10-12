import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  formatOrderNumber,
  orderRequesterOptions,
  parseExchangeStatus,
  requesterAvailability,
  requesterTrackingSentences,
  variantLabel,
  type RequesterExchangeLine,
  type RequesterExchangeLineState,
  type RequesterExchangeOption,
  type RequesterExchangeOptionsAnswer,
  type RequesterPhoto,
  type RequesterReturnableLine,
  type RequesterReturnSheet,
  type RequesterTrackingExchange,
  type RequesterTrackingItem,
  type RequesterTrackingLine,
  type RequesterTrackingReturn,
  type ReturnStatus,
} from '@stockpilot/core';

import { exchangeCreateEnabled } from '@/lib/returns/exchange-switch';

import { ServiceError, type ServiceContext } from './context';
import { ItemImagesService } from './item-images';
import { fetchAllRowsByIds, reportDegradedRead } from './lib/fetch-by-ids';
import {
  loadMemberReturnContext,
  loadPortalReturnContext,
  loadRequesterReturnContext,
  resolveMemberOrder,
  resolvePortalOrder,
  resolveRequesterOrder,
  type RequesterOrderRef,
  type RequesterReturnOrderContext,
} from './returns';

/**
 * The requester's reads (returns RX-3): the sheet a requester fills in (their
 * order's returnable lines with names, sizes and photos), the sizes each line
 * may be exchanged for, and the progress of their own requests. One
 * implementation for the token page, the B2B portal and a member's own order
 * (the web and the phone).
 *
 * WHO ASKS. The caller has already resolved the order through the token
 * (order_request_secrets, never the order row's own token column), the portal
 * principal or the member's own account, and every closed door (unknown,
 * not returnable, module off) answers null. Everything here runs on the
 * service-role client, scoped by the resolved order and its organization;
 * nothing a client sends is ever an item, a group, a warehouse or a path.
 *
 * WHAT LEAVES. Only core's requester types (requester-exchange-types.ts):
 * names, sizes, photo URLs signed for the order's own returnable items and
 * the sizes it may get, the two availability states (the free count never
 * leaves the server), the requester's own quantities, statuses, sentences,
 * RMA and SO numbers. Never a SKU, a cost, a location, Staging, a
 * disposition, a charter, a warehouse, a group, a quantity on record, a note,
 * a reason or a staff member. This module never reads return_decisions or
 * the restock options (a guard test pins it).
 *
 * ROUND TRIPS are constant whatever the line count (brief 44): the resolve,
 * then one predicate call (return_exchange_options) or one return_overview
 * read, then one item read and one photo read beside each other, and one
 * signing batch (chunked at 1,000 paths inside ItemImagesService). None of
 * it runs inside a cached function (pattern 13): the signer's own per-path
 * cache is the only cache.
 */

/** A service-role image context scoped to ONE organization (the order's). */
function requesterImagesContext(admin: SupabaseClient, organizationId: string): ServiceContext {
  return {
    organizationId,
    userId: 'returns-requester',
    role: 'viewer',
    supabase: admin as unknown as ServiceContext['supabase'],
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set(),
  };
}

/**
 * Signed photos for exactly these items of this organization (the order's
 * returnable items, or the sizes it may get): the primary photo's master and
 * its stored thumbnail. A failed read or sign gives no photo for that item,
 * reported, and never blocks the sheet (brief 27).
 */
export async function requesterPhotos(
  admin: SupabaseClient,
  organizationId: string,
  itemIds: readonly string[],
): Promise<Map<string, RequesterPhoto>> {
  const ids = [...new Set(itemIds.filter((id) => typeof id === 'string' && id.length > 0))];
  const out = new Map<string, RequesterPhoto>();
  if (ids.length === 0) return out;
  try {
    const signed = await new ItemImagesService(requesterImagesContext(admin, organizationId)).primaryImagesWithThumbsForItems(ids);
    for (const [itemId, photo] of signed) {
      if (photo.url) out.set(itemId, { url: photo.url, thumbUrl: photo.thumbUrl ?? null });
    }
  } catch (err) {
    reportDegradedRead('returns.requester.photos', err, { items: ids.length });
  }
  return out;
}

/** A requester item's name and size words. */
export interface RequesterItemLabel {
  name: string;
  /** variantLabel's words ("Size L"), null for an item with none. */
  sizeLabel: string | null;
  /** The stored size, for ordering only (never sent). */
  size: string | null;
}

/** Names and sizes of these items of this organization (batched; throws on a
 *  failed read, so a caller decides what a missing name means). */
export async function requesterItemLabels(
  admin: SupabaseClient,
  organizationId: string,
  itemIds: readonly string[],
): Promise<Map<string, RequesterItemLabel>> {
  const ids = [...new Set(itemIds.filter((id) => typeof id === 'string' && id.length > 0))];
  const out = new Map<string, RequesterItemLabel>();
  if (ids.length === 0) return out;
  const rows = await fetchAllRowsByIds<{
    id: string;
    name: string | null;
    variant_size: string | null;
    variant_width: string | null;
    variant_color: string | null;
    jersey_number: string | null;
  }>(ids, (batch) => (from, to) =>
    admin
      .from('inventory_items')
      .select('id, name, variant_size, variant_width, variant_color, jersey_number')
      .eq('organization_id', organizationId)
      .in('id', batch)
      .order('id')
      .range(from, to),
  );
  for (const r of rows) {
    out.set(r.id, {
      name: (r.name ?? '').trim() || 'Item',
      sizeLabel: variantLabel({ size: r.variant_size, width: r.variant_width, color: r.variant_color, jerseyNumber: r.jersey_number }),
      size: r.variant_size,
    });
  }
  return out;
}

// ── The sizes a line may be exchanged for ───────────────────────────────────

type RawOptionRow = {
  orderRequestLineId?: unknown;
  returnedItemId?: unknown;
  options?: unknown;
};

/**
 * The sizes each returnable line of a resolved order may be exchanged for
 * (plan 3.6.10, through return_exchange_options, the same predicate the
 * create re-runs inside its transaction, so what is offered is what is
 * accepted). A line with no other size is left out: its only exchange is
 * "warehouse will review" with a note. With the kill switch off nothing is
 * read and Exchange is hidden.
 */
export async function exchangeOptionsForOrder(
  admin: SupabaseClient,
  order: Pick<RequesterOrderRef, 'orderRequestId' | 'organizationId'>,
): Promise<RequesterExchangeOptionsAnswer> {
  if (!exchangeCreateEnabled()) return { exchangesEnabled: false, lines: [] };
  const { data, error } = await admin.rpc('return_exchange_options', { p_order_id: order.orderRequestId });
  if (error) {
    throw new ServiceError('internal_error', `return_exchange_options failed: ${error.message ?? 'no message'}`, { reason: 'failed' });
  }
  const rows: Array<{ lineId: string; options: Array<{ itemId: string; free: unknown }> }> = [];
  for (const raw of Array.isArray(data) ? (data as RawOptionRow[]) : []) {
    if (!raw || typeof raw.orderRequestLineId !== 'string' || !Array.isArray(raw.options)) continue;
    const options: Array<{ itemId: string; free: unknown }> = [];
    for (const o of raw.options as Array<Record<string, unknown>>) {
      if (o && typeof o.itemId === 'string') options.push({ itemId: o.itemId, free: o.free });
    }
    if (options.length > 0) rows.push({ lineId: raw.orderRequestLineId, options });
  }
  const itemIds = rows.flatMap((r) => r.options.map((o) => o.itemId));
  if (itemIds.length === 0) return { exchangesEnabled: true, lines: [] };

  const [labels, photos] = await Promise.all([
    requesterItemLabels(admin, order.organizationId, itemIds),
    requesterPhotos(admin, order.organizationId, itemIds),
  ]);
  const lines: RequesterExchangeLine[] = [];
  for (const row of rows) {
    const options: RequesterExchangeOption[] = [];
    for (const o of row.options) {
      const label = labels.get(o.itemId);
      // An option whose item cannot be named is not offered.
      if (!label) continue;
      options.push({
        itemId: o.itemId,
        name: label.name,
        sizeLabel: label.sizeLabel,
        availability: requesterAvailability(o.free),
        photo: photos.get(o.itemId) ?? null,
      });
    }
    if (options.length > 0) {
      lines.push({
        orderRequestLineId: row.lineId,
        options: orderRequesterOptions(options, (opt) => labels.get(opt.itemId)?.size ?? null),
      });
    }
  }
  return { exchangesEnabled: true, lines };
}

/** The token page's options (POST /api/v1/public/returns/options). Null on
 *  every closed door (unknown token, not returnable, module off). */
export async function exchangeOptionsForToken(
  admin: SupabaseClient,
  token: string,
): Promise<RequesterExchangeOptionsAnswer | null> {
  const order = await resolveRequesterOrder(admin, token);
  return order ? exchangeOptionsForOrder(admin, order) : null;
}

/** A portal customer's own order's options (the portal's options action). */
export async function exchangeOptionsForPortal(
  admin: SupabaseClient,
  scope: { organizationId: string; customerId: string; orderRequestId: string },
): Promise<RequesterExchangeOptionsAnswer | null> {
  const order = await resolvePortalOrder(admin, scope);
  return order ? exchangeOptionsForOrder(admin, order) : null;
}

/** A member's own order's options (POST /api/v1/orders/[id]/return-request/options). */
export async function exchangeOptionsForMember(
  admin: SupabaseClient,
  scope: { organizationId: string; userId: string; orderRequestId: string },
): Promise<RequesterExchangeOptionsAnswer | null> {
  const order = await resolveMemberOrder(admin, scope);
  return order ? exchangeOptionsForOrder(admin, order) : null;
}

// ── The requester's own requests (tracking) ─────────────────────────────────

const RETURN_STATUSES: readonly string[] = ['requested', 'approved', 'received', 'closed', 'denied', 'cancelled'];
const EXCHANGE_LINE_STATES: readonly string[] = ['requested', 'approved', 'declined', 'cancelled'];

type OverviewRow = {
  id: string;
  order_request_id: string;
  return_number: string | null;
  status: string;
  created_at: string;
  exchange_status: string | null;
  exchange_lines: Array<{
    return_line_id?: string | null;
    status?: string | null;
    requested_item_id?: string | null;
    requested_quantity?: number | string | null;
    approved_item_id?: string | null;
    approved_quantity?: number | string | null;
  }> | null;
  lines: Array<{ line_id?: string | null; item_id?: string | null; quantity?: number | string | null }> | null;
  replacement_order_number: number | null;
  replacement_status: string | null;
  replacement_owed: number | string | null;
};

/** The return_overview columns tracking reads: never the disposition, the
 *  requester's email, the requested_by account or the reasons. */
const TRACKING_COLUMNS =
  'id, order_request_id, return_number, status, created_at, exchange_status, exchange_lines, lines, replacement_order_number, replacement_status, replacement_owed';

function whole(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** One of the requester's requests with the ids a server page keys it by
 *  (never sent to a public page). */
export interface RequesterTrackingRow {
  returnId: string;
  orderId: string;
  tracking: RequesterTrackingReturn;
}

/**
 * The requester's own requests on these orders, newest first (plan RX-3
 * "trackingForOrder"; D15: requester-made RMAs only, never a return staff
 * created). One return_overview read (the exchange status and the
 * replacement as every member reads them) and one item read for names and
 * sizes, whatever the number of orders or lines. A failed read shows no
 * tracking, reported (pattern 1: a read fails closed, never throws).
 */
export async function trackingRowsForOrders(
  admin: SupabaseClient,
  organizationId: string,
  orderIds: readonly string[],
): Promise<RequesterTrackingRow[]> {
  const ids = [...new Set(orderIds.filter((id) => typeof id === 'string' && id.length > 0))];
  if (ids.length === 0) return [];
  try {
    const rows = await fetchAllRowsByIds<OverviewRow>(ids, (batch) => (from, to) =>
      admin
        .from('return_overview')
        .select(TRACKING_COLUMNS)
        .eq('organization_id', organizationId)
        .eq('source', 'requester')
        .in('order_request_id', batch)
        .order('created_at', { ascending: false })
        .order('id')
        .range(from, to),
    );
    if (rows.length === 0) return [];

    const itemIds: string[] = [];
    for (const r of rows) {
      for (const l of r.lines ?? []) if (l.item_id) itemIds.push(l.item_id);
      for (const x of r.exchange_lines ?? []) {
        if (x.requested_item_id) itemIds.push(x.requested_item_id);
        if (x.approved_item_id) itemIds.push(x.approved_item_id);
      }
    }
    const labels = await requesterItemLabels(admin, organizationId, itemIds);
    const item = (id: string | null | undefined, quantity: unknown): RequesterTrackingItem | null => {
      if (!id) return null;
      const label = labels.get(id);
      return { name: label?.name ?? 'Item', sizeLabel: label?.sizeLabel ?? null, quantity: whole(quantity) };
    };

    const out: RequesterTrackingRow[] = [];
    for (const r of rows) {
      if (!RETURN_STATUSES.includes(r.status)) continue;
      const returnStatus = r.status as ReturnStatus;
      const exchangeStatus = parseExchangeStatus(r.exchange_status);
      const byLine = new Map((r.exchange_lines ?? []).filter((x) => x.return_line_id).map((x) => [x.return_line_id as string, x]));
      const lines: RequesterTrackingLine[] = [];
      for (const l of r.lines ?? []) {
        const returning = item(l.item_id, l.quantity);
        if (!returning) continue;
        const x = l.line_id ? byLine.get(l.line_id) : undefined;
        let exchange: RequesterTrackingExchange | null = null;
        if (x && x.status && EXCHANGE_LINE_STATES.includes(x.status)) {
          const state = x.status as RequesterExchangeLineState;
          // Approved (or cancelled after an approval): what the warehouse
          // approved; otherwise what was asked for; null while the warehouse
          // reviews a request made with a note.
          const approvedShown = (state === 'approved' || state === 'cancelled') && Boolean(x.approved_item_id);
          const replacement = approvedShown
            ? item(x.approved_item_id, x.approved_quantity ?? x.requested_quantity)
            : item(x.requested_item_id, x.requested_quantity);
          exchange = {
            state,
            replacement,
            substituted: approvedShown && Boolean(x.requested_item_id) && x.approved_item_id !== x.requested_item_id,
          };
        }
        lines.push({ returning, exchange });
      }
      const replacementLive =
        r.replacement_order_number !== null &&
        r.replacement_status !== null &&
        r.replacement_status !== 'cancelled' &&
        r.replacement_status !== 'denied';
      out.push({
        returnId: r.id,
        orderId: r.order_request_id,
        tracking: {
          returnNumber: r.return_number,
          createdAt: r.created_at,
          returnStatus,
          exchangeStatus,
          sentences: requesterTrackingSentences({
            returnStatus,
            exchangeStatus,
            replacementStatus: r.replacement_status,
            replacementOwed: r.replacement_owed === null || r.replacement_owed === undefined ? null : Number(r.replacement_owed),
          }),
          replacementOrderNumber: replacementLive ? formatOrderNumber(r.replacement_order_number) : null,
          lines,
        },
      });
    }
    // Newest first, whatever order the batches came back in.
    out.sort((a, b) =>
      a.tracking.createdAt < b.tracking.createdAt ? 1 : a.tracking.createdAt > b.tracking.createdAt ? -1 : 0,
    );
    return out;
  } catch (err) {
    reportDegradedRead('returns.requester.tracking', err, { orders: ids.length });
    return [];
  }
}

/** The requester's own requests per order, newest first (no ids). */
export async function trackingForOrders(
  admin: SupabaseClient,
  organizationId: string,
  orderIds: readonly string[],
): Promise<Map<string, RequesterTrackingReturn[]>> {
  const out = new Map<string, RequesterTrackingReturn[]>();
  for (const row of await trackingRowsForOrders(admin, organizationId, orderIds)) {
    const list = out.get(row.orderId) ?? [];
    list.push(row.tracking);
    out.set(row.orderId, list);
  }
  return out;
}

/** One order's requester tracking (the token page, a member's order). */
export async function trackingForOrder(
  admin: SupabaseClient,
  organizationId: string,
  orderId: string,
): Promise<RequesterTrackingReturn[]> {
  return (await trackingForOrders(admin, organizationId, [orderId])).get(orderId) ?? [];
}

// ── The sheet ───────────────────────────────────────────────────────────────

/**
 * The requester sheet for a resolved order: its returnable lines with names,
 * sizes and photos, the kill switch, and the requester's own requests. The
 * labels, the photos and the tracking run beside each other.
 */
export async function requesterReturnSheet(
  admin: SupabaseClient,
  ctx: RequesterReturnOrderContext,
): Promise<RequesterReturnSheet> {
  const itemIds = ctx.lines.map((l) => l.itemId);
  const [labels, photos, tracking] = await Promise.all([
    requesterItemLabels(admin, ctx.organizationId, itemIds).catch((err: unknown) => {
      reportDegradedRead('returns.requester.sheet_labels', err, { items: itemIds.length });
      return new Map<string, RequesterItemLabel>();
    }),
    requesterPhotos(admin, ctx.organizationId, itemIds),
    trackingForOrder(admin, ctx.organizationId, ctx.orderRequestId),
  ]);
  const lines: RequesterReturnableLine[] = ctx.lines.map((l) => {
    const label = labels.get(l.itemId);
    return {
      orderRequestLineId: l.orderRequestLineId,
      name: label?.name ?? ((l.itemName ?? '').trim() || 'Item'),
      sizeLabel: label?.sizeLabel ?? null,
      photo: photos.get(l.itemId) ?? null,
      quantityFulfilled: l.quantityFulfilled,
      quantityRemaining: l.quantityRemaining,
    };
  });
  return {
    orderNumber: formatOrderNumber(ctx.orderNumber),
    requesterName: ctx.requesterName,
    exchangesEnabled: exchangeCreateEnabled(),
    lines,
    tracking,
  };
}

/** The token page's sheet. Null on every closed door. */
export async function loadRequesterReturnSheet(admin: SupabaseClient, token: string): Promise<RequesterReturnSheet | null> {
  const ctx = await loadRequesterReturnContext(admin, token);
  return ctx ? requesterReturnSheet(admin, ctx) : null;
}

/** A portal customer's own order's sheet (the portal's sheet action). */
export async function loadPortalReturnSheet(
  admin: SupabaseClient,
  scope: { organizationId: string; customerId: string; orderRequestId: string },
): Promise<RequesterReturnSheet | null> {
  const ctx = await loadPortalReturnContext(admin, scope);
  return ctx ? requesterReturnSheet(admin, ctx) : null;
}

/** A member's own order's sheet (GET /api/v1/orders/[id]/return-request). */
export async function loadMemberReturnSheet(
  admin: SupabaseClient,
  scope: { organizationId: string; userId: string; orderRequestId: string },
): Promise<RequesterReturnSheet | null> {
  const ctx = await loadMemberReturnContext(admin, scope);
  return ctx ? requesterReturnSheet(admin, ctx) : null;
}
