'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { requireOrgContext } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { ServiceError } from '@/server/services/context';
import {
  createPoSchema,
  PurchaseOrdersService,
  type CreatePoInput,
} from '@/server/services/purchase-orders';

import { err, ok, type ActionResult } from '@stockpilot/core';

function toResult<T>(error: unknown): ActionResult<T> {
  if (error instanceof ServiceError) return err(error.code, error.message);
  console.error(error);
  return err('internal_error', error instanceof Error ? error.message : 'Unknown error');
}

export async function createPoAction(input: CreatePoInput): Promise<ActionResult<{ id: string }>> {
  const parsed = createPoSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  try {
    const svc = await PurchaseOrdersService.forCurrentUser();
    const result = await svc.create(parsed.data);
    revalidatePath('/dashboard/purchase-orders');
    return ok({ id: result.id });
  } catch (e) {
    return toResult(e);
  }
}

const setDestinationSchema = z.object({
  poId: z.string().uuid(),
  warehouseId: z.string().uuid(),
});

/**
 * Resolves a destination_location_id for the given warehouse (re-using
 * an existing location or auto-creating one named after the warehouse)
 * and updates the PO. Used to backfill imported POs that were approved
 * before the import flow set this field automatically — the Receive
 * button is gated on this column being non-null.
 */
export async function setPoDestinationWarehouseAction(input: {
  poId: string;
  warehouseId: string;
}): Promise<ActionResult<void>> {
  const parsed = setDestinationSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid input');
  try {
    const ctx = await requireOrgContext();
    const supabase = await createClient();

    // Reuse an existing location for the warehouse, or auto-create one.
    let locationId: string | null = null;
    const { data: existing, error: findErr } = await supabase
      .from('locations')
      .select('id')
      .eq('organization_id', ctx.organizationId)
      .eq('warehouse_id', parsed.data.warehouseId)
      .is('deleted_at', null)
      .limit(1)
      .maybeSingle();
    if (findErr) throw new ServiceError('internal_error', findErr.message);
    if (existing?.id) {
      locationId = existing.id as string;
    } else {
      const { data: warehouse } = await supabase
        .from('warehouses')
        .select('name')
        .eq('organization_id', ctx.organizationId)
        .eq('id', parsed.data.warehouseId)
        .maybeSingle();
      if (!warehouse) {
        return err('not_found', 'Warehouse not found');
      }
      const { data: created, error: insErr } = await supabase
        .from('locations')
        .insert({
          organization_id: ctx.organizationId,
          warehouse_id: parsed.data.warehouseId,
          name: warehouse.name as string,
          type: 'warehouse',
        })
        .select('id')
        .single();
      if (insErr) throw new ServiceError('internal_error', insErr.message);
      locationId = created.id as string;
    }

    const { error: updErr } = await supabase
      .from('purchase_orders')
      .update({ destination_location_id: locationId })
      .eq('organization_id', ctx.organizationId)
      .eq('id', parsed.data.poId);
    if (updErr) throw new ServiceError('internal_error', updErr.message);

    revalidatePath(`/dashboard/purchase-orders/${parsed.data.poId}`);
    revalidatePath('/dashboard/purchase-orders');
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

export async function updatePoStatusAction(id: string, status: 'draft' | 'ordered' | 'cancelled'): Promise<ActionResult<void>> {
  try {
    const svc = await PurchaseOrdersService.forCurrentUser();
    await svc.updateStatus(id, status);
    revalidatePath('/dashboard/purchase-orders');
    revalidatePath(`/dashboard/purchase-orders/${id}`);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

interface DraftPosResultData {
  /** IDs of the draft POs that were successfully created. */
  createdPoIds: string[];
  /** Selected items that had no supplier_id and were skipped. */
  skipped: number;
  /** Per-supplier failures (other suppliers' POs may still have been created). */
  supplierFailures: Array<{ supplierId: string; supplierName: string; error: string }>;
  /** How many distinct suppliers were attempted. */
  supplierCount: number;
}

const MAX_DRAFT_POS_BATCH = 200;

/**
 * Bulk-creates draft purchase orders from a list of selected inventory item
 * IDs (typically from the inventory or books table's BulkActions bar after
 * the user filters to ?stock=low). Items are grouped by supplier_id, one
 * draft PO is created per supplier, and line quantities are pre-filled from
 * each item's reorder_quantity (fallback: max(1, reorder_point - on_hand)).
 *
 * Items without a supplier_id are skipped and reported back as `skipped`.
 * Per-supplier failures are reported as `supplierFailures` so the caller
 * can toast a partial-success message; we deliberately do NOT roll back
 * already-created drafts.
 *
 * Spec: docs/superpowers/specs/2026-05-08-draft-pos-from-low-stock-design.md
 */
export async function createDraftPosFromItemsAction(
  itemIds: string[],
): Promise<ActionResult<DraftPosResultData>> {
  if (!Array.isArray(itemIds) || itemIds.length === 0) {
    return err('validation_error', 'Select at least one item.');
  }
  if (itemIds.length > MAX_DRAFT_POS_BATCH) {
    return err(
      'validation_error',
      `Select ${MAX_DRAFT_POS_BATCH} items or fewer per batch.`,
    );
  }
  try {
    const ctx = await requireOrgContext();
    const supabase = await createClient();

    // Fetch only the columns the line builder needs; RLS scopes by
    // org + warehouse access, so cross-org / unreadable items are
    // silently dropped (treated the same as skipped).
    const { data: rows, error: fetchErr } = await supabase
      .from('inventory_items')
      .select(
        'id, supplier_id, reorder_quantity, reorder_point, quantity_on_hand, unit_cost',
      )
      .eq('organization_id', ctx.organizationId)
      .in('id', itemIds);
    if (fetchErr) throw new ServiceError('internal_error', fetchErr.message);

    type Row = {
      id: string;
      supplier_id: string | null;
      reorder_quantity: number | null;
      reorder_point: number | null;
      quantity_on_hand: number | null;
      unit_cost: number | null;
    };
    const items = (rows ?? []) as Row[];

    const noSupplier = items.filter((r) => !r.supplier_id);
    const withSupplier = items.filter((r) => !!r.supplier_id);
    const skipped = noSupplier.length + (itemIds.length - items.length);

    if (withSupplier.length === 0) {
      return err(
        'validation_error',
        'No items had a supplier set. Assign suppliers and try again.',
      );
    }

    // Group by supplier_id.
    const bySupplier = new Map<string, Row[]>();
    for (const r of withSupplier) {
      const key = r.supplier_id as string;
      const list = bySupplier.get(key) ?? [];
      list.push(r);
      bySupplier.set(key, list);
    }

    // Resolve supplier names so failure messages name the offender.
    const supplierIds = [...bySupplier.keys()];
    const { data: suppliersData } = await supabase
      .from('suppliers')
      .select('id, name')
      .eq('organization_id', ctx.organizationId)
      .in('id', supplierIds);
    const supplierName = new Map<string, string>();
    for (const s of (suppliersData ?? []) as Array<{ id: string; name: string }>) {
      supplierName.set(s.id, s.name);
    }

    const svc = await PurchaseOrdersService.forCurrentUser();
    const createdPoIds: string[] = [];
    const supplierFailures: DraftPosResultData['supplierFailures'] = [];

    for (const [supplierId, group] of bySupplier) {
      const lines = group.map((r) => {
        const reorderQty = Number(r.reorder_quantity ?? 0);
        const reorderPoint = Number(r.reorder_point ?? 0);
        const onHand = Number(r.quantity_on_hand ?? 0);
        const qty =
          reorderQty > 0 ? reorderQty : Math.max(1, reorderPoint - onHand);
        return {
          itemId: r.id,
          quantityOrdered: qty,
          unitCost: Number(r.unit_cost ?? 0),
        };
      });
      try {
        const po = await svc.create({ supplierId, lines });
        createdPoIds.push(po.id);
      } catch (e) {
        const msg =
          e instanceof ServiceError
            ? e.message
            : e instanceof Error
              ? e.message
              : 'Unknown error';
        supplierFailures.push({
          supplierId,
          supplierName: supplierName.get(supplierId) ?? 'Unknown supplier',
          error: msg,
        });
      }
    }

    revalidatePath('/dashboard/purchase-orders');
    revalidatePath('/dashboard/inventory');
    revalidatePath('/dashboard/books');

    return ok({
      createdPoIds,
      skipped,
      supplierFailures,
      supplierCount: bySupplier.size,
    });
  } catch (e) {
    return toResult(e);
  }
}

