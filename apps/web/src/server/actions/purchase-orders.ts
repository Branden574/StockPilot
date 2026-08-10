'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { assertWarehouseAccess } from '@/lib/auth/warehouse';
import { revalidateInventoryListForCurrentOrg } from '@/server/loaders/inventory-list';
import {
  assertModuleEnabled,
  assertPermission,
  ServiceError,
  withContext,
} from '@/server/services/context';
import { LocationsService } from '@/server/services/locations';
import {
  createPoSchema,
  PurchaseOrdersService,
  updatePoStatusSchema,
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
    // PO create/update can stamp created_from_purchase_order_id on custom
    // items (bumps updated_at → reorders the default list sort).
    await revalidateInventoryListForCurrentOrg();
    return ok({ id: result.id });
  } catch (e) {
    return toResult(e);
  }
}


export async function updatePoAction(
  id: string,
  input: CreatePoInput,
): Promise<ActionResult<{ id: string; poNumber: string }>> {
  if (!z.string().uuid().safeParse(id).success) {
    return err('validation_error', 'Invalid purchase order id');
  }
  const parsed = createPoSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  try {
    const svc = await PurchaseOrdersService.forCurrentUser();
    const result = await svc.update(id, parsed.data);
    revalidatePath('/dashboard/purchase-orders');
    revalidatePath(`/dashboard/purchase-orders/${id}`);
    revalidatePath(`/dashboard/purchase-orders/${id}/edit`);
    await revalidateInventoryListForCurrentOrg();
    return ok(result);
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
    // Full service context (effective permissions + enabled modules + MFA gate +
    // RLS-bound client), not just requireOrgContext. This action was previously
    // UNGATED — a member with purchase_orders:manage revoked could still re-point
    // a PO's receiving destination. Gate it like every other PO mutation.
    const ctx = await withContext();
    assertModuleEnabled(ctx, 'purchase_orders');
    assertPermission(ctx, 'purchase_orders:manage');

    // Receiving posts stock INTO this warehouse, so the caller must have write
    // access to it — mirror the guard in the create()/update() service paths so
    // this recovery action can't re-point a PO to a warehouse the user can't
    // actually receive into. Map the ForbiddenError to a clean 'forbidden'
    // ServiceError (toResult only special-cases ServiceError).
    await assertWarehouseAccess(parsed.data.warehouseId, 'write', ctx).catch(() => {
      throw new ServiceError('forbidden', 'You do not have access to receive into that warehouse.');
    });

    // Resolve the destination through LocationsService (org-scoped) rather than
    // trusting a raw id: reuse this warehouse's existing SITE location, or create
    // one. `sitesOnly` excludes the staging/unplaced system buckets — those must
    // never be a PO's receiving destination.
    const locationsSvc = new LocationsService(ctx);
    const existing = (await locationsSvc.list({ sitesOnly: true })).find(
      (l) => (l as { warehouse_id: string | null }).warehouse_id === parsed.data.warehouseId,
    );
    let locationId: string;
    if (existing) {
      locationId = (existing as { id: string }).id;
    } else {
      const { data: warehouse } = await ctx.supabase
        .from('warehouses')
        .select('name')
        .eq('organization_id', ctx.organizationId)
        .eq('id', parsed.data.warehouseId)
        .maybeSingle();
      if (!warehouse) {
        return err('not_found', 'Warehouse not found');
      }
      const created = await locationsSvc.create({
        name: (warehouse as { name: string }).name,
        type: 'warehouse',
        warehouseId: parsed.data.warehouseId,
      });
      locationId = (created as { id: string }).id;
    }

    // Fail CLOSED: confirm the PO row was actually re-pointed (.select the row)
    // so a 0-row update — a foreign/deleted PO id, or an RLS refusal — cannot be
    // reported as success (the .update().eq() fail-open lesson).
    const { data: updated, error: updErr } = await ctx.supabase
      .from('purchase_orders')
      .update({ destination_location_id: locationId })
      .eq('organization_id', ctx.organizationId)
      .eq('id', parsed.data.poId)
      .select('id')
      .maybeSingle();
    if (updErr) throw new ServiceError('internal_error', updErr.message);
    if (!updated) throw new ServiceError('not_found', 'Purchase order not found.');

    revalidatePath(`/dashboard/purchase-orders/${parsed.data.poId}`);
    revalidatePath('/dashboard/purchase-orders');
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

export async function renamePoNumberAction(
  id: string,
  poNumber: string,
): Promise<ActionResult<{ id: string; poNumber: string }>> {
  if (!z.string().uuid().safeParse(id).success) {
    return err('validation_error', 'Invalid purchase order id');
  }
  try {
    const svc = await PurchaseOrdersService.forCurrentUser();
    const result = await svc.renamePoNumber(id, poNumber);
    revalidatePath('/dashboard/purchase-orders');
    revalidatePath(`/dashboard/purchase-orders/${id}`);
    return ok(result);
  } catch (e) {
    return toResult(e);
  }
}

export async function updatePoNotesAction(
  id: string,
  notes: string,
): Promise<ActionResult<{ id: string }>> {
  if (!z.string().uuid().safeParse(id).success) {
    return err('validation_error', 'Invalid purchase order id');
  }
  if (typeof notes !== 'string' || notes.length > 2000) {
    return err('validation_error', 'Notes are too long (2000 characters max).');
  }
  try {
    const svc = await PurchaseOrdersService.forCurrentUser();
    const result = await svc.updateNotes(id, notes);
    revalidatePath('/dashboard/purchase-orders');
    revalidatePath(`/dashboard/purchase-orders/${id}`);
    return ok(result);
  } catch (e) {
    return toResult(e);
  }
}

// The status a client may set DIRECTLY. The UI (po-actions.tsx) only ever
// sends 'ordered' or 'cancelled' (and 'draft' as a de-commit), so those three
// are the whole legitimate set. Receivable states — 'expected_inbound',
// 'partially_received', 'received' — are NEVER user-set here (they are reached
// by the import-approval and receiving flows), and 'received' would fabricate a
// fully-received PO with no receipts. The TS union is compile-time only, so a
// forged call could still pass one; zod rejects it at the boundary. The service
// (updateStatus) additionally gates every receivable transition on the approval
// threshold as defense-in-depth.
const updatePoStatusActionSchema = updatePoStatusSchema.extend({
  id: z.string().uuid(),
});

export async function updatePoStatusAction(id: string, status: 'draft' | 'ordered' | 'cancelled'): Promise<ActionResult<void>> {
  const parsed = updatePoStatusActionSchema.safeParse({ id, status });
  if (!parsed.success) {
    return err('validation_error', 'Invalid purchase order status update.');
  }
  try {
    const svc = await PurchaseOrdersService.forCurrentUser();
    await svc.updateStatus(parsed.data.id, parsed.data.status);
    revalidatePath('/dashboard/purchase-orders');
    revalidatePath(`/dashboard/purchase-orders/${id}`);
    // Cancelling auto-archives PO-created custom items (visible status flip).
    await revalidateInventoryListForCurrentOrg();
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
    const svc = await PurchaseOrdersService.forCurrentUser();
    const result = await svc.createDraftsFromItems(itemIds);
    revalidatePath('/dashboard/purchase-orders');
    revalidatePath('/dashboard/inventory');
    revalidatePath('/dashboard/books');
    return ok(result);
  } catch (e) {
    return toResult(e);
  }
}

interface ReorderDraftPosResultData {
  /** IDs of the draft POs that were successfully created. */
  createdPoIds: string[];
  /** Items with no supplier that landed on the unassigned draft PO. */
  unassignedCount: number;
  /** Below-par items that couldn't be processed (a supplier's PO failed). */
  skipped: number;
  /** Per-supplier failures (other suppliers' drafts may still exist). */
  supplierFailures: Array<{ supplierId: string | null; supplierName: string; error: string }>;
  /** Distinct real suppliers attempted (excludes the unassigned bucket). */
  supplierCount: number;
}

/**
 * Reorder automation — the last mile. Recomputes the reorder forecast
 * (items at or below their reorder point), groups them by supplier, and
 * creates one editable DRAFT purchase order per supplier with line
 * quantities pre-filled to the deficit needed to bring each item back to
 * target. Items with no supplier are collected onto a single "unassigned"
 * draft so nothing is dropped.
 *
 * Drafts are NOT auto-sent — the reorder-forecast report routes the user to
 * the created drafts for review/edit. Powers the "Draft PO from reorder
 * suggestions" button. Org-scoped + gated inside the service.
 */
export async function createDraftPosFromReorderForecastAction(): Promise<
  ActionResult<ReorderDraftPosResultData>
> {
  try {
    const svc = await PurchaseOrdersService.forCurrentUser();
    const result = await svc.createDraftsFromReorderForecast();
    revalidatePath('/dashboard/purchase-orders');
    revalidatePath('/dashboard/reports/reorder-forecast');
    return ok(result);
  } catch (e) {
    return toResult(e);
  }
}

