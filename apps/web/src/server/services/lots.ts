import 'server-only';

import {
  computeLotExpiry,
  expiryBucket,
  sortLotsFefo,
  type ExpiryBucket,
} from '@stockpilot/core';

import { assertModuleEnabled, assertPermission, ServiceError, withContext, type ServiceContext } from './context';
import { fetchAllRows } from './lib/paginate';

export interface AgingLotRow {
  itemId: string;
  itemName: string;
  sku: string | null;
  lotNumber: string;
  expirationDate: string | null;
  /** Effective expiry (explicit date or received + shelf life), ISO or null. */
  effectiveExpiry: string | null;
  bucket: ExpiryBucket;
  receivedQty: number;
  pickedQty: number;
  /** receivedQty - pickedQty, floored at 0. Approximate unless picks recorded. */
  remaining: number;
}

export interface FefoSuggestion {
  lotNumber: string;
  expirationDate: string | null;
  effectiveExpiry: string | null;
  bucket: ExpiryBucket;
  remaining: number;
  expired: boolean;
  nearExpiry: boolean;
}

export interface LotTraceResult {
  lotNumber: string;
  receipts: Array<{
    receiptNumber: string | null;
    receivedAt: string;
    itemId: string;
    itemName: string;
    qty: number;
    expirationDate: string | null;
  }>;
  picks: Array<{
    orderRequestId: string | null;
    /** The picking order's number (drives the SO- handle); null on legacy
     *  orders that predate order_number, and when the pick has no order. */
    orderNumber: number | null;
    qty: number;
    pickedAt: string;
    pickedBy: string | null;
  }>;
}

interface RawLotRow {
  lot_number: string;
  expiration_date: string | null;
  qty_base: number;
  created_at: string;
  receipt_lines: {
    item_id: string;
    receipts: { organization_id: string; receipt_number?: string | null; status?: string | null } | null;
    inventory_items: { name: string; sku: string | null; shelf_life_days: number | null } | null;
  } | null;
}

/**
 * LotsService — food vertical lot/expiry/FEFO read + audit. LIGHT model: NO
 * per-lot stock. `remaining` = received − recorded picks (floored at 0), exact
 * only when picks are recorded via the FEFO action. Gated on `lot_serial`.
 */
export class LotsService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new LotsService(await withContext());
  }

  /** Effective "now" — single source so tests/usage stay consistent. */
  private now(): Date {
    return new Date();
  }

  /** Sum recorded picks keyed by `${itemId}::${lotNumber}` (optionally one item). */
  private async pickTotals(itemId?: string): Promise<Map<string, number>> {
    // PostgREST clamps any single response to `[api] max_rows = 1000`, so an
    // un-paginated scan would SILENTLY drop pick events past the first 1000 —
    // under-counting picked qty and over-stating the remaining-on-hand used for
    // aging/FEFO (a food-safety hazard: the soonest-expiring lot could look
    // healthier than it is). Paginate in 1000-row `.range()` windows with a
    // stable `.order('id')` and accumulate the full set.
    const rows = await fetchAllRows<{ item_id: string; lot_number: string; qty: number }>(
      (from, to) => {
        let q = this.ctx.supabase
          .from('lot_pick_events')
          .select('item_id, lot_number, qty')
          .eq('organization_id', this.ctx.organizationId);
        if (itemId) q = q.eq('item_id', itemId);
        return q.order('id', { ascending: true }).range(from, to);
      },
    );
    const totals = new Map<string, number>();
    for (const r of rows) {
      const key = `${r.item_id}::${r.lot_number}`;
      totals.set(key, (totals.get(key) ?? 0) + Number(r.qty));
    }
    return totals;
  }

  async getAgingInventory(): Promise<AgingLotRow[]> {
    assertModuleEnabled(this.ctx, 'lot_serial');
    // `!inner` on the embeds is REQUIRED for the nested org filter to actually
    // constrain top-level rows (a PostgREST gotcha — without it the filter on an
    // embedded column is a no-op). The user-scoped client also enforces RLS on
    // receipt_line_lots (org membership via the receipts join), so org scoping is
    // belt-and-suspenders. If PostgREST rejects the nested filter at runtime, drop
    // the `.eq(...)` and rely on RLS alone (rows are already org-scoped).
    // PostgREST clamps any single response to `[api] max_rows = 1000`, so an
    // un-paginated scan SILENTLY drops lot rows past the first 1000 — and a
    // truncated scan can omit the soonest-expiring lot entirely, corrupting the
    // aging buckets + FEFO suggestion (food-safety hazard). Paginate in 1000-row
    // `.range()` windows with a stable `.order('id')` (orders by the top-level
    // receipt_line_lots.id) and accumulate the full rowset before aggregating.
    const data = await fetchAllRows<RawLotRow>(
      (from, to) =>
        this.ctx.supabase
          .from('receipt_line_lots')
          .select(
            `lot_number, expiration_date, qty_base, created_at,
             receipt_lines:receipt_line_id!inner (
               item_id,
               receipts:receipt_id!inner ( organization_id, receipt_number, status ),
               inventory_items:item_id ( name, sku, shelf_life_days )
             )`,
          )
          .eq('receipt_lines.receipts.organization_id', this.ctx.organizationId)
          // Exclude reversed/canceled/draft receipts — only posted receipts
          // represent real on-hand stock. (receipt_line_lots rows are NOT
          // removed on reversal, so without this they'd inflate aging.)
          .eq('receipt_lines.receipts.status', 'posted')
          .order('id', { ascending: true })
          // PostgREST types nested embeds as arrays; the runtime shape is the
          // single related row we expect, hence the same `unknown` cast the
          // pre-pagination code used.
          .range(from, to) as unknown as PromiseLike<{ data: RawLotRow[] | null; error: { message: string } | null }>,
    );

    const picks = await this.pickTotals();
    const now = this.now();

    // Aggregate received qty per (item, lot); keep latest item meta, min
    // received date, and the EARLIEST non-null explicit expiration date across
    // merged rows (FEFO is only safe if we treat the soonest-expiring sibling
    // as the lot's expiry — keeping the first-seen row's date arbitrarily could
    // under-state urgency).
    const agg = new Map<
      string,
      { row: RawLotRow; received: number; receivedAt: string; expirationDate: string | null }
    >();
    for (const raw of data) {
      const itemId = raw.receipt_lines?.item_id;
      if (!itemId) continue;
      const key = `${itemId}::${raw.lot_number}`;
      const prev = agg.get(key);
      const received = Number(raw.qty_base);
      if (prev) {
        prev.received += received;
        if (raw.created_at < prev.receivedAt) prev.receivedAt = raw.created_at;
        // Keep the earliest non-null expiration date.
        if (
          raw.expiration_date &&
          (prev.expirationDate === null || raw.expiration_date < prev.expirationDate)
        ) {
          prev.expirationDate = raw.expiration_date;
        }
      } else {
        agg.set(key, {
          row: raw,
          received,
          receivedAt: raw.created_at,
          expirationDate: raw.expiration_date,
        });
      }
    }

    const rows: Array<AgingLotRow & { expiry: Date | null }> = [];
    for (const [key, { row, received, receivedAt, expirationDate }] of agg) {
      const itemId = row.receipt_lines!.item_id;
      const item = row.receipt_lines!.inventory_items;
      const pickedQty = picks.get(key) ?? 0;
      const remaining = Math.max(0, received - pickedQty);
      if (remaining <= 0) continue;
      const expiry = computeLotExpiry(
        { expirationDate, receivedAt },
        { shelfLifeDays: item?.shelf_life_days ?? null },
      );
      rows.push({
        itemId,
        itemName: item?.name ?? '—',
        sku: item?.sku ?? null,
        lotNumber: row.lot_number,
        expirationDate,
        effectiveExpiry: expiry ? expiry.toISOString() : null,
        bucket: expiryBucket(expiry, now),
        receivedQty: received,
        pickedQty,
        remaining,
        expiry,
      });
    }
    return sortLotsFefo(rows).map(({ expiry: _expiry, ...rest }) => rest);
  }

  /**
   * Batch FEFO suggestions for many items in ONE aging scan (avoids the
   * pick-page N+1 of calling getAgingInventory once per item). Returns a map
   * keyed by itemId; items with no remaining lots are simply absent.
   */
  async getFefoSuggestionsByItems(itemIds: string[]): Promise<Record<string, FefoSuggestion[]>> {
    assertModuleEnabled(this.ctx, 'lot_serial');
    const wanted = new Set(itemIds);
    const all = await this.getAgingInventory();
    const out: Record<string, FefoSuggestion[]> = {};
    for (const r of all) {
      if (!wanted.has(r.itemId)) continue;
      const expired = r.bucket === 'expired';
      (out[r.itemId] ??= []).push({
        lotNumber: r.lotNumber,
        expirationDate: r.expirationDate,
        effectiveExpiry: r.effectiveExpiry,
        bucket: r.bucket,
        remaining: r.remaining,
        expired,
        nearExpiry: expired || r.bucket === 'le7',
      });
    }
    return out;
  }

  async getFefoSuggestion(itemId: string): Promise<FefoSuggestion[]> {
    return (await this.getFefoSuggestionsByItems([itemId]))[itemId] ?? [];
  }

  async traceLot(lotNumber: string): Promise<LotTraceResult> {
    assertModuleEnabled(this.ctx, 'lot_serial');
    const term = lotNumber.trim();
    if (!term) throw new ServiceError('validation_error', 'Enter a lot number to trace.');

    const { data: lotRows, error: lotErr } = await this.ctx.supabase
      .from('receipt_line_lots')
      .select(
        `lot_number, expiration_date, qty_base, created_at,
         receipt_lines:receipt_line_id!inner (
           item_id,
           receipts:receipt_id!inner ( organization_id, receipt_number, status ),
           inventory_items:item_id ( name )
         )`,
      )
      .eq('receipt_lines.receipts.organization_id', this.ctx.organizationId)
      // Only trace through posted receipts — reversed/canceled receipts leave
      // their receipt_line_lots rows behind and would otherwise show as live.
      .eq('receipt_lines.receipts.status', 'posted')
      .ilike('lot_number', `%${term}%`);
    if (lotErr) throw new ServiceError('internal_error', lotErr.message);

    // The parent order's number rides along: lot_pick_events snapshots no order
    // handle, and the trace report shows WHICH order consumed the lot — it must
    // print the same SO- number the order page does, not an id prefix.
    // order_requests is readable by every accepted org member under RLS.
    const { data: pickRows, error: pickErr } = await this.ctx.supabase
      .from('lot_pick_events')
      .select(
        `order_request_id, qty, picked_at, picked_by, lot_number,
         order_request:order_requests!order_request_id (order_number)`,
      )
      .eq('organization_id', this.ctx.organizationId)
      .ilike('lot_number', `%${term}%`);
    if (pickErr) throw new ServiceError('internal_error', pickErr.message);

    return {
      lotNumber: term,
      receipts: ((lotRows ?? []) as unknown as RawLotRow[]).map((r) => ({
        receiptNumber: r.receipt_lines?.receipts?.receipt_number ?? null,
        receivedAt: r.created_at,
        itemId: r.receipt_lines?.item_id ?? '',
        itemName: (r.receipt_lines?.inventory_items as { name?: string } | null)?.name ?? '—',
        qty: Number(r.qty_base),
        expirationDate: r.expiration_date,
      })),
      picks: ((pickRows ?? []) as unknown as Array<{
        order_request_id: string | null; qty: number; picked_at: string; picked_by: string | null;
        order_request:
          | { order_number: number | null }
          | { order_number: number | null }[]
          | null;
      }>).map((p) => {
        const order = Array.isArray(p.order_request)
          ? (p.order_request[0] ?? null)
          : (p.order_request ?? null);
        return {
          orderRequestId: p.order_request_id,
          orderNumber: order?.order_number ?? null,
          qty: Number(p.qty),
          pickedAt: p.picked_at,
          pickedBy: p.picked_by,
        };
      }),
    };
  }

  async recordLotPicks(input: {
    orderRequestId: string | null;
    orderRequestLineId: string | null;
    itemId: string;
    picks: Array<{ lotNumber: string; qty: number; expirationDate: string | null }>;
  }): Promise<void> {
    assertModuleEnabled(this.ctx, 'lot_serial');
    // Recording a lot pick is part of the picking activity — mirror the pick
    // flow's permission (OrderRequestsService.recordPickedLine uses
    // 'items:update', which staff can perform). Migration 0162's
    // lot_pick_events_write RLS floor is set to 'staff' to match.
    assertPermission(this.ctx, 'items:update');
    const picks = input.picks.filter((p) => p.lotNumber.trim() && p.qty > 0);
    if (picks.length === 0) throw new ServiceError('validation_error', 'No lot picks to record.');

    const { data: item, error: itemErr } = await this.ctx.supabase
      .from('inventory_items')
      .select('expiry_policy, shelf_life_days')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', input.itemId)
      .maybeSingle();
    if (itemErr) throw new ServiceError('internal_error', itemErr.message);
    if (!item) throw new ServiceError('not_found', 'Item not found.');
    const policy = (item as { expiry_policy?: string } | null)?.expiry_policy ?? 'warn';
    const shelfLifeDays = (item as { shelf_life_days?: number | null } | null)?.shelf_life_days ?? null;

    if (policy === 'block') {
      const now = this.now();
      for (const p of picks) {
        const expiry = computeLotExpiry(
          { expirationDate: p.expirationDate, receivedAt: now.toISOString() },
          { shelfLifeDays },
        );
        if (expiry && expiry.getTime() <= now.getTime()) {
          throw new ServiceError(
            'validation_error',
            `Lot ${p.lotNumber} is expired and this item blocks picking expired stock.`,
          );
        }
      }
    }

    const { error: insErr } = await this.ctx.supabase.from('lot_pick_events').insert(
      picks.map((p) => ({
        organization_id: this.ctx.organizationId,
        order_request_id: input.orderRequestId,
        order_request_line_id: input.orderRequestLineId,
        item_id: input.itemId,
        lot_number: p.lotNumber.trim(),
        expiration_date: p.expirationDate,
        qty: p.qty,
        picked_by: this.ctx.userId,
      })),
    );
    if (insErr) throw new ServiceError('internal_error', insErr.message);
  }
}
