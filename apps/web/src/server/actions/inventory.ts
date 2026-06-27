'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { InventoryService } from '@/server/services/inventory';
import { LocationsService } from '@/server/services/locations';
import { ServiceError, withContext } from '@/server/services/context';

import {
  adjustStockSchema,
  createItemSchema,
  err,
  ok,
  transferStockSchema,
  updateItemSchema,
  type ActionResult,
  type AdjustStockInput,
  type CreateItemInput,
  type TransferStockInput,
  type UpdateItemInput,
} from '@stockpilot/core';

function toResult<T>(error: unknown): ActionResult<T> {
  if (error instanceof ServiceError) {
    return err(error.code, error.message);
  }
  console.error(error);
  return err('internal_error', error instanceof Error ? error.message : 'Unknown error');
}

// Validate UUIDs before they hit Postgres. Without this, a malformed string
// passed to set_category/set_supplier/set_location surfaces as an internal_error
// with a raw "invalid input syntax for type uuid" message — both a 500-as-400
// UX bug and a tiny information leak.
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuidOrNull(v: unknown): boolean {
  return v === null || (typeof v === 'string' && UUID_REGEX.test(v));
}

export async function createItemAction(input: CreateItemInput): Promise<ActionResult<{ id: string }>> {
  const parsed = createItemSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const svc = await InventoryService.forCurrentUser();
    const item = await svc.create(parsed.data);
    revalidatePath('/dashboard');
    revalidatePath('/dashboard/inventory');
    revalidatePath('/dashboard/books');
    return ok({ id: item.id as string });
  } catch (e) {
    return toResult(e);
  }
}

export async function updateItemAction(
  id: string,
  input: UpdateItemInput,
): Promise<ActionResult<{ id: string }>> {
  const parsed = updateItemSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const svc = await InventoryService.forCurrentUser();
    await svc.update(id, parsed.data);
    revalidatePath('/dashboard/inventory');
    revalidatePath('/dashboard/books');
    revalidatePath(`/dashboard/inventory/${id}`);
    return ok({ id });
  } catch (e) {
    return toResult(e);
  }
}

export async function archiveItemAction(id: string): Promise<ActionResult<void>> {
  try {
    const svc = await InventoryService.forCurrentUser();
    await svc.archive(id);
    revalidatePath('/dashboard/inventory');
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

export async function deleteItemAction(id: string): Promise<ActionResult<void>> {
  try {
    const svc = await InventoryService.forCurrentUser();
    await svc.softDelete(id);
    revalidatePath('/dashboard/inventory');
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

const bulkCreateSizedSchema = z.object({
  baseName: z.string().min(1).max(200),
  baseSku: z.string().max(120).nullable(),
  baseBarcode: z.string().max(120).nullable(),
  description: z.string().max(2000).nullable(),
  categoryId: z.string().uuid(),
  supplierId: z.string().uuid().nullable(),
  warehouseId: z.string().uuid(),
  charterId: z.string().uuid().nullable(),
  primaryLocationId: z.string().uuid().nullable(),
  binLocation: z.string().max(120).nullable(),
  retailPrice: z.coerce.number().min(0),
  unitCost: z.coerce.number().min(0),
  reorderPoint: z.coerce.number().int().min(0),
  reorderQuantity: z.coerce.number().int().min(0),
  unitOfMeasure: z.string().min(1).max(40),
  rackNumber: z.string().max(50).nullable().optional(),
  rackRow: z.string().max(10).nullable().optional(),
  // Per-org custom field values applied to every created variant. The service
  // strips reserved keys and runs the authoritative validator (assertCustomFieldsValid).
  customFields: z.record(z.string(), z.unknown()).nullable().optional(),
  variants: z
    .array(
      z.object({
        size: z.enum(['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', 'XXXXL', 'XXXXXL']),
        quantity: z.coerce.number().int().min(0),
      }),
    )
    .min(1)
    .max(7),
});

export async function bulkCreateSizedVariantsAction(
  input: z.input<typeof bulkCreateSizedSchema>,
): Promise<ActionResult<{ created: number; ids: string[] }>> {
  const parsed = bulkCreateSizedSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const svc = await InventoryService.forCurrentUser();
    const rows = await svc.bulkCreateSizedVariants(parsed.data);
    revalidatePath('/dashboard/inventory');
    revalidatePath('/dashboard/books');
    revalidatePath('/dashboard');
    return ok({ created: rows.length, ids: rows.map((r) => r.id) });
  } catch (e) {
    return toResult(e);
  }
}

export type BulkInventoryOp =
  | { kind: 'archive' }
  | { kind: 'unarchive' }
  | { kind: 'set_category'; categoryId: string | null }
  | { kind: 'set_supplier'; supplierId: string | null }
  | { kind: 'set_location'; locationId: string | null }
  | { kind: 'set_status'; status: 'active' | 'archived' | 'discontinued' }
  | { kind: 'add_tags'; tagIds: string[] }
  | { kind: 'remove_tags'; tagIds: string[] }
  | { kind: 'set_rack'; rackNumber: string | null; rackRow: string | null };

export async function bulkUpdateInventoryAction(input: {
  ids: string[];
  op: BulkInventoryOp;
}): Promise<ActionResult<{ ok: number; skipped: number }>> {
  if (!Array.isArray(input.ids) || input.ids.length === 0) {
    return err('validation_error', 'No items selected');
  }
  if (input.ids.some((id) => typeof id !== 'string' || id.length === 0)) {
    return err('validation_error', 'Invalid item id in selection');
  }
  if (input.op.kind === 'set_category' && !isUuidOrNull(input.op.categoryId)) {
    return err('validation_error', 'Invalid category id.');
  }
  if (input.op.kind === 'set_supplier' && !isUuidOrNull(input.op.supplierId)) {
    return err('validation_error', 'Invalid supplier id.');
  }
  if (input.op.kind === 'set_location' && !isUuidOrNull(input.op.locationId)) {
    return err('validation_error', 'Invalid location id.');
  }
  if (input.op.kind === 'set_rack') {
    const rn = input.op.rackNumber;
    const rr = input.op.rackRow;
    if (rn !== null && (typeof rn !== 'string' || rn.length > 50)) {
      return err('validation_error', 'Rack number must be 50 characters or fewer.');
    }
    if (rr !== null && (typeof rr !== 'string' || rr.length > 10)) {
      return err('validation_error', 'Rack row must be 10 characters or fewer.');
    }
  }
  try {
    const svc = await InventoryService.forCurrentUser();
    const result = await svc.bulkUpdate(input);
    revalidatePath('/dashboard/inventory');
    revalidatePath('/dashboard/books');
    revalidatePath('/dashboard');
    return ok(result);
  } catch (e) {
    return toResult(e);
  }
}

export async function adjustStockAction(input: AdjustStockInput): Promise<ActionResult<void>> {
  const parsed = adjustStockSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const svc = await InventoryService.forCurrentUser();
    await svc.adjustStock(parsed.data);
    revalidatePath('/dashboard');
    revalidatePath('/dashboard/inventory');
    revalidatePath(`/dashboard/inventory/${parsed.data.itemId}`);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

export async function transferStockAction(input: TransferStockInput): Promise<ActionResult<void>> {
  const parsed = transferStockSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const svc = await InventoryService.forCurrentUser();
    await svc.transferStock(parsed.data);
    revalidatePath('/dashboard/inventory');
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

// ---------------------------------------------------------------------------
// placeStockAction — move staged qty onto an existing or inline-created location
// ---------------------------------------------------------------------------

const newRackSchema = z.object({
  warehouseId: z.string().uuid(),
  rackNumber: z.string().min(1).max(64),
  rackRow: z.string().max(64).optional(),
  crateColor: z.string().max(64).optional(),
  crateNumber: z.string().max(64).optional(),
  parentId: z.string().uuid().optional(),
});

const placeStockSchema = z.object({
  itemId: z.string().uuid(),
  fromLocationId: z.string().uuid(),
  quantity: z.number().positive(),
  notes: z.string().max(2000).optional(),
  destination: z.union([
    z.object({ existingLocationId: z.string().uuid() }),
    z.object({ newRack: newRackSchema }),
  ]),
});

export type PlaceStockInput = z.infer<typeof placeStockSchema>;

/** Derive a human-readable name for an inline-created rack or crate. */
function deriveLocationName(n: z.infer<typeof newRackSchema>): string {
  if (n.crateColor) {
    return `${n.crateColor} #${n.crateNumber ?? n.rackNumber}`;
  }
  return n.rackRow ? `${n.rackNumber}-${n.rackRow}` : n.rackNumber;
}

export async function placeStockAction(
  input: PlaceStockInput,
): Promise<ActionResult<{ toLocationId: string }>> {
  const parsed = placeStockSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  const data = parsed.data;

  try {
    // Resolve the org context ONCE and reuse its supabase client for the
    // destination org-verification below. `withContext` is request-cached, so
    // the services constructed from it below share the same context.
    const ctx = await withContext();
    let toLocationId: string;

    if ('existingLocationId' in data.destination) {
      // TENANT-ISOLATION GUARD: transfer_stock only verifies the ITEM's org, and
      // item_stock_levels RLS scopes the row's OWN organization_id — NOT the
      // referenced location's org. Without this lookup a forged request could
      // place an org-A item's stock at an org-B location_id (a cross-tenant
      // integrity write; same class as the Phase 2a 0199 RLS finding). Verify
      // the destination location belongs to the caller's org before transfer.
      const { data: loc } = await ctx.supabase
        .from('locations')
        .select('id, warehouse_id, kind')
        .eq('id', data.destination.existingLocationId)
        .eq('organization_id', ctx.organizationId)
        .is('deleted_at', null)
        .maybeSingle();
      if (!loc) {
        return err('validation_error', 'Destination location not found in your organization.');
      }
      // You can't "place" stock INTO a staging/unplaced bucket — those are
      // system holding locations, not pickable destinations.
      if (loc.kind === 'staging' || loc.kind === 'unplaced') {
        return err('validation_error', 'Pick a rack or crate as the destination.');
      }
      toLocationId = loc.id;
    } else {
      const n = data.destination.newRack;
      // TENANT-ISOLATION GUARD: verify the warehouse belongs to the caller's
      // org BEFORE creating a location under it — prevents seeding a location
      // (and then placing stock) under another org's warehouse.
      const { data: wh } = await ctx.supabase
        .from('warehouses')
        .select('id')
        .eq('id', n.warehouseId)
        .eq('organization_id', ctx.organizationId)
        .maybeSingle();
      if (!wh) {
        return err('validation_error', 'Warehouse not found in your organization.');
      }
      const locationsSvc = new LocationsService(ctx);
      const created = await locationsSvc.create({
        name: deriveLocationName(n),
        type: n.crateColor ? 'bin' : 'shelf',
        kind: n.crateColor ? 'crate' : 'rack',
        warehouseId: n.warehouseId,
        rackNumber: n.rackNumber,
        rackRow: n.rackRow ?? null,
        crateColor: n.crateColor ?? null,
        crateNumber: n.crateNumber ?? null,
        parentId: n.parentId ?? null,
      });
      toLocationId = created.id;
    }

    const invSvc = new InventoryService(ctx);
    await invSvc.transferStock({
      itemId: data.itemId,
      fromLocationId: data.fromLocationId,
      toLocationId,
      quantity: data.quantity,
      notes: data.notes,
    });

    revalidatePath('/dashboard/inventory/staging');
    revalidatePath('/dashboard/inventory');
    return ok({ toLocationId });
  } catch (e) {
    // transfer_stock raises `insufficient_stock` as a P0001 exception whose
    // text surfaces verbatim in the RPC error. The service wraps any RPC error
    // as ServiceError('internal_error', error.message); the raw text now lives
    // on `internalDetail` (the public `message` is sanitized to a generic string
    // for internal_error — S13), so match against internalDetail. Case-
    // insensitive so a bare RPC message ("INSUFFICIENT_STOCK") still matches.
    if (
      e instanceof ServiceError &&
      e.code === 'internal_error' &&
      (e.internalDetail ?? '').toLowerCase().includes('insufficient_stock')
    ) {
      return err('validation_error', "Can't place more than is staged.");
    }
    return toResult(e);
  }
}
