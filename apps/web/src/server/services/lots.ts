import 'server-only';

import {
  computeLotExpiry,
  expiryBucket,
  sortLotsFefo,
  type ExpiryBucket,
} from '@stockpilot/core';

import { assertModuleEnabled, ServiceError, withContext, type ServiceContext } from './context';

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
    receipts: { organization_id: string; receipt_number?: string | null } | null;
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
    let q = this.ctx.supabase
      .from('lot_pick_events')
      .select('item_id, lot_number, qty')
      .eq('organization_id', this.ctx.organizationId);
    if (itemId) q = q.eq('item_id', itemId);
    const { data, error } = await q;
    if (error) throw new ServiceError('internal_error', error.message);
    const totals = new Map<string, number>();
    for (const r of (data ?? []) as Array<{ item_id: string; lot_number: string; qty: number }>) {
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
    const { data, error } = await this.ctx.supabase
      .from('receipt_line_lots')
      .select(
        `lot_number, expiration_date, qty_base, created_at,
         receipt_lines:receipt_line_id!inner (
           item_id,
           receipts:receipt_id!inner ( organization_id, receipt_number ),
           inventory_items:item_id ( name, sku, shelf_life_days )
         )`,
      )
      .eq('receipt_lines.receipts.organization_id', this.ctx.organizationId);
    if (error) throw new ServiceError('internal_error', error.message);

    const picks = await this.pickTotals();
    const now = this.now();

    // Aggregate received qty per (item, lot); keep latest item meta + min received date.
    const agg = new Map<string, { row: RawLotRow; received: number; receivedAt: string }>();
    for (const raw of (data ?? []) as unknown as RawLotRow[]) {
      const itemId = raw.receipt_lines?.item_id;
      if (!itemId) continue;
      const key = `${itemId}::${raw.lot_number}`;
      const prev = agg.get(key);
      const received = Number(raw.qty_base);
      if (prev) {
        prev.received += received;
        if (raw.created_at < prev.receivedAt) prev.receivedAt = raw.created_at;
      } else {
        agg.set(key, { row: raw, received, receivedAt: raw.created_at });
      }
    }

    const rows: Array<AgingLotRow & { expiry: Date | null }> = [];
    for (const [key, { row, received, receivedAt }] of agg) {
      const itemId = row.receipt_lines!.item_id;
      const item = row.receipt_lines!.inventory_items;
      const pickedQty = picks.get(key) ?? 0;
      const remaining = Math.max(0, received - pickedQty);
      if (remaining <= 0) continue;
      const expiry = computeLotExpiry(
        { expirationDate: row.expiration_date, receivedAt },
        { shelfLifeDays: item?.shelf_life_days ?? null },
      );
      rows.push({
        itemId,
        itemName: item?.name ?? '—',
        sku: item?.sku ?? null,
        lotNumber: row.lot_number,
        expirationDate: row.expiration_date,
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

  async getFefoSuggestion(itemId: string): Promise<FefoSuggestion[]> {
    assertModuleEnabled(this.ctx, 'lot_serial');
    const all = await this.getAgingInventory();
    return all
      .filter((r) => r.itemId === itemId)
      .map((r) => {
        const expired = r.bucket === 'expired';
        return {
          lotNumber: r.lotNumber,
          expirationDate: r.expirationDate,
          effectiveExpiry: r.effectiveExpiry,
          bucket: r.bucket,
          remaining: r.remaining,
          expired,
          nearExpiry: expired || r.bucket === 'le7',
        };
      });
  }

  async traceLot(lotNumber: string): Promise<LotTraceResult> {
    assertModuleEnabled(this.ctx, 'lot_serial');
    const term = lotNumber.trim();
    if (!term) throw new ServiceError('validation_error', 'Enter a lot number to trace.');

    const { data: lotRows, error: lotErr } = await this.ctx.supabase
      .from('receipt_line_lots')
      .select(
        `lot_number, expiration_date, qty_base, created_at,
         receipt_lines:receipt_line_id (
           item_id,
           receipts:receipt_id ( organization_id, receipt_number ),
           inventory_items:item_id ( name )
         )`,
      )
      .eq('receipt_lines.receipts.organization_id', this.ctx.organizationId)
      .ilike('lot_number', `%${term}%`);
    if (lotErr) throw new ServiceError('internal_error', lotErr.message);

    const { data: pickRows, error: pickErr } = await this.ctx.supabase
      .from('lot_pick_events')
      .select('order_request_id, qty, picked_at, picked_by, lot_number')
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
      picks: ((pickRows ?? []) as Array<{
        order_request_id: string | null; qty: number; picked_at: string; picked_by: string | null;
      }>).map((p) => ({
        orderRequestId: p.order_request_id,
        qty: Number(p.qty),
        pickedAt: p.picked_at,
        pickedBy: p.picked_by,
      })),
    };
  }

  async recordLotPicks(input: {
    orderRequestId: string | null;
    orderRequestLineId: string | null;
    itemId: string;
    picks: Array<{ lotNumber: string; qty: number; expirationDate: string | null }>;
  }): Promise<void> {
    assertModuleEnabled(this.ctx, 'lot_serial');
    const picks = input.picks.filter((p) => p.lotNumber.trim() && p.qty > 0);
    if (picks.length === 0) throw new ServiceError('validation_error', 'No lot picks to record.');

    const { data: item, error: itemErr } = await this.ctx.supabase
      .from('inventory_items')
      .select('expiry_policy, shelf_life_days')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', input.itemId)
      .maybeSingle();
    if (itemErr) throw new ServiceError('internal_error', itemErr.message);
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
