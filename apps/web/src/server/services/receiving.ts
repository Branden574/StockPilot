import 'server-only';

import { createHash } from 'node:crypto';

import { reportError } from '@/lib/error-reporter';
import { audit } from './audit';
import { assertModuleEnabled, assertPermission, ServiceError, withContext, type ServiceContext } from './context';

import type {
  PostReceiptInput,
  ReverseReceiptInput,
} from '@stockpilot/core';

export interface ReceiptRow {
  id: string;
  organization_id: string;
  purchase_order_id: string;
  warehouse_id: string;
  receipt_number: string;
  status: 'draft' | 'posted' | 'reversed' | 'reversal' | 'canceled';
  reversed_receipt_id: string | null;
  reversal_reason: string | null;
  notes: string | null;
  received_by: string;
  received_at: string;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReceiptLineRow {
  id: string;
  receipt_id: string;
  purchase_order_line_id: string;
  item_id: string;
  qty_received_base: number;
  qty_accepted_base: number;
  qty_rejected_base: number;
  base_uom: string;
  unit_cost: number;
  notes: string | null;
  created_at: string;
}

/**
 * Computes a deterministic SHA-256 of the normalized receipt request, used
 * by the post_receipt_v2 RPC for idempotency-key payload comparison.
 *
 * Normalization: stable sort lines by poLineId, fixed-decimal numeric fields,
 * exclude the idempotency key itself (it's the lookup, not the payload).
 */
export function hashReceiptRequest(input: PostReceiptInput): string {
  const normalized = JSON.stringify({
    purchaseOrderId: input.purchaseOrderId,
    warehouseId: input.warehouseId,
    notes: input.notes ?? null,
    lines: [...input.lines]
      .sort((a, b) => a.poLineId.localeCompare(b.poLineId))
      .map((l) => ({
        poLineId: l.poLineId,
        qtyReceived: Number(l.qtyReceived).toFixed(4),
        qtyAccepted: Number(l.qtyAccepted).toFixed(4),
        qtyRejected: Number(l.qtyRejected ?? 0).toFixed(4),
        unitCost:
          l.unitCost === undefined ? null : Number(l.unitCost).toFixed(4),
        notes: l.notes ?? null,
        lots: (l.lots ?? []).map((lot) => ({
          lotNumber: lot.lotNumber,
          expirationDate: lot.expirationDate ?? null,
          qtyBase: Number(lot.qtyBase).toFixed(4),
        })),
        serials: l.serials ?? [],
      })),
  });
  return createHash('sha256').update(normalized).digest('hex');
}

export class ReceivingService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new ReceivingService(await withContext());
  }

  async listForPurchaseOrder(poId: string): Promise<{
    receipts: ReceiptRow[];
    lines: ReceiptLineRow[];
  }> {
    assertModuleEnabled(this.ctx, 'receiving');
    const { data: receipts, error: rErr } = await this.ctx.supabase
      .from('receipts')
      .select('*')
      .eq('organization_id', this.ctx.organizationId)
      .eq('purchase_order_id', poId)
      .order('received_at', { ascending: false });
    if (rErr) throw new ServiceError('internal_error', rErr.message);

    const ids = (receipts ?? []).map((r) => r.id as string);
    if (ids.length === 0) return { receipts: [], lines: [] };

    const { data: lines, error: lErr } = await this.ctx.supabase
      .from('receipt_lines')
      .select('*')
      .in('receipt_id', ids);
    if (lErr) throw new ServiceError('internal_error', lErr.message);

    return {
      receipts: (receipts ?? []) as unknown as ReceiptRow[],
      lines: (lines ?? []) as unknown as ReceiptLineRow[],
    };
  }

  /**
   * Posts a receipt via the post_receipt_v2 RPC. Idempotency-key-protected:
   * same key + same payload returns the original receipt; same key + different
   * payload throws conflict.
   */
  async postReceipt(input: PostReceiptInput): Promise<ReceiptRow> {
    assertModuleEnabled(this.ctx, 'receiving');
    assertPermission(this.ctx, 'stock:adjust');

    const requestHash = hashReceiptRequest(input);

    const { data, error } = await this.ctx.supabase.rpc('post_receipt_v2', {
      p_purchase_order_id: input.purchaseOrderId,
      p_warehouse_id: input.warehouseId,
      p_lines: input.lines.map((l) => ({
        po_line_id: l.poLineId,
        qty_received: l.qtyReceived,
        qty_accepted: l.qtyAccepted,
        qty_rejected: l.qtyRejected ?? 0,
        unit_cost: l.unitCost ?? 0,
        notes: l.notes ?? null,
        lots: l.lots?.map((lot) => ({
          lot_number: lot.lotNumber,
          expiration_date: lot.expirationDate ?? null,
          qty_base: lot.qtyBase,
        })),
        serials: l.serials,
      })),
      p_idempotency_key: input.idempotencyKey,
      p_request_hash: requestHash,
      p_notes: input.notes ?? null,
    });
    if (error) {
      // Postgres errcode 40001 = serialization_failure, used for
      // idempotency conflict above.
      if (error.message.includes('idempotency_conflict')) {
        await audit(
          {
            event: 'idempotency.conflict',
            entityType: 'receipt',
            extra: { purchaseOrderId: input.purchaseOrderId },
          },
          this.ctx,
        );
        throw new ServiceError(
          'conflict',
          'A different receipt was already submitted with this idempotency key. Refresh and try again.',
        );
      }
      if (error.message.includes('po_already_closed')) {
        throw new ServiceError(
          'conflict',
          'This PO is already closed and cannot accept further receipts.',
        );
      }
      if (error.message.includes('forbidden')) {
        throw new ServiceError('forbidden', 'You cannot post receipts for this PO.');
      }
      if (error.message.includes('po_not_found') || error.message.includes('po_line_not_found')) {
        throw new ServiceError('not_found', 'PO or line not found.');
      }
      throw new ServiceError('internal_error', error.message);
    }

    const receipt = data as unknown as ReceiptRow;
    const totalAccepted = input.lines.reduce((s, l) => s + l.qtyAccepted, 0);
    const totalRejected = input.lines.reduce((s, l) => s + (l.qtyRejected ?? 0), 0);

    await audit(
      {
        event: 'stock.receipt.posted',
        entityType: 'receipt',
        entityId: receipt.id,
        warehouseId: receipt.warehouse_id,
        after: {
          purchaseOrderId: input.purchaseOrderId,
          receiptNumber: receipt.receipt_number,
          lineCount: input.lines.length,
          totalAccepted,
          totalRejected,
        },
      },
      this.ctx,
    );

    // Publish to outbox for downstream consumers (notifications, analytics).
    // Best-effort: a failure here doesn't undo the receipt.
    void this.ctx.supabase.rpc('publish_outbox', {
      p_org_id: this.ctx.organizationId,
      p_topic: 'receipt.posted',
      p_aggregate_type: 'receipt',
      p_aggregate_id: receipt.id,
      p_payload: {
        purchaseOrderId: input.purchaseOrderId,
        warehouseId: receipt.warehouse_id,
        receiptNumber: receipt.receipt_number,
        lineCount: input.lines.length,
        totalAccepted,
        totalRejected,
      },
      p_dedupe_key: `receipt.posted:${receipt.id}`,
    });

    // Auto-unarchive any items that were archived before this receipt. A
    // receipt against an archived item is an implicit "bring it back" —
    // otherwise the stock arrives silently into a SKU that's invisible on
    // the Items list. Only lines that ACCEPTED stock count: a fully-rejected
    // line adds no sellable stock, so it shouldn't revive the SKU.
    //
    // Awaited (not fire-and-forget): the unarchive does several DB
    // round-trips + audit inserts, and on serverless the function context
    // freezes once the response flushes — a bare `void` promise could be
    // dropped mid-flight, leaving the item archived or the audit rows
    // unwritten. It's wrapped in try/catch + reportError, so awaiting can't
    // fail the receipt. 'discontinued' items are left alone (stronger signal).
    await this.maybeAutoUnarchive(
      input.lines.filter((l) => Number(l.qtyAccepted) > 0).map((l) => l.poLineId),
      receipt.id,
    );

    return receipt;
  }

  /**
   * If any items targeted by this receipt's lines are currently
   * `status='archived'`, flip them back to `'active'` and audit each
   * change. Idempotent — only affects rows whose status is still
   * 'archived' at update time.
   */
  private async maybeAutoUnarchive(poLineIds: string[], receiptId: string): Promise<void> {
    try {
      if (poLineIds.length === 0) return;

      // Resolve poLineId → item_id
      const { data: lines } = await this.ctx.supabase
        .from('purchase_order_items')
        .select('id, item_id')
        .in('id', poLineIds);
      const itemIds = Array.from(
        new Set(((lines ?? []) as Array<{ item_id: string | null }>)
          .map((l) => l.item_id)
          .filter((x): x is string => !!x)),
      );
      if (itemIds.length === 0) return;

      // Which of those items are currently archived?
      const { data: archivedRows } = await this.ctx.supabase
        .from('inventory_items')
        .select('id, name')
        .eq('organization_id', this.ctx.organizationId)
        .in('id', itemIds)
        .eq('status', 'archived');
      const archived = (archivedRows ?? []) as Array<{ id: string; name: string }>;
      if (archived.length === 0) return;

      // Flip them back to active. The `eq('status', 'archived')` guard
      // makes this race-safe: if another writer un-archived between the
      // SELECT and the UPDATE we don't accidentally touch 'discontinued'
      // or anything else.
      const { data: flippedRows, error: updErr } = await this.ctx.supabase
        .from('inventory_items')
        .update({ status: 'active' })
        .eq('organization_id', this.ctx.organizationId)
        .in('id', archived.map((a) => a.id))
        .eq('status', 'archived')
        .select('id, name');
      if (updErr) {
        void reportError(new Error(updErr.message), {
          tag: 'receiving.auto_unarchive.update',
          organizationId: this.ctx.organizationId,
        });
        return;
      }

      // One audit row per item THIS call actually flipped — iterate the
      // UPDATE's returned rows, not the earlier SELECT. The
      // eq('status','archived') guard means a concurrent receipt flips a
      // given row only once; auditing the SELECT result would emit a
      // duplicate 'restored' entry for the loser of the race.
      const flipped = (flippedRows ?? []) as Array<{ id: string; name: string }>;
      for (const item of flipped) {
        await audit(
          {
            event: 'inventory.item.restored',
            entityType: 'inventory_item',
            entityId: item.id,
            after: { status: 'active' },
            before: { status: 'archived' },
            extra: { reason: 'receipt_posted', receiptId, itemName: item.name },
          },
          this.ctx,
        );
      }
    } catch (e) {
      void reportError(e, {
        tag: 'receiving.auto_unarchive.unhandled',
        organizationId: this.ctx.organizationId,
      });
    }
  }

  /**
   * Reverses a previously posted receipt: writes a sibling reversal receipt
   * with negative line quantities and stock movements. The original is marked
   * 'reversed' but its row is preserved for audit history.
   */
  async reverseReceipt(input: ReverseReceiptInput): Promise<ReceiptRow> {
    assertModuleEnabled(this.ctx, 'receiving');
    assertPermission(this.ctx, 'stock:adjust');

    const { data, error } = await this.ctx.supabase.rpc('reverse_receipt', {
      p_receipt_id: input.receiptId,
      p_reason: input.reason,
    });
    if (error) {
      if (error.message.includes('receipt_already_reversed')) {
        throw new ServiceError('conflict', 'This receipt has already been reversed.');
      }
      if (error.message.includes('forbidden')) {
        throw new ServiceError('forbidden', 'You cannot reverse this receipt.');
      }
      if (error.message.includes('receipt_not_found')) {
        throw new ServiceError('not_found', 'Receipt not found.');
      }
      throw new ServiceError('internal_error', error.message);
    }

    const reversal = data as unknown as ReceiptRow;
    await audit(
      {
        event: 'stock.receipt.reversed',
        entityType: 'receipt',
        entityId: input.receiptId,
        warehouseId: reversal.warehouse_id,
        after: {
          reversalReceiptId: reversal.id,
          reason: input.reason,
        },
      },
      this.ctx,
    );

    return reversal;
  }
}
