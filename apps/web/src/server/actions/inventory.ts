'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { deriveLocationName } from '@/lib/locations/rack-name';
import { revalidateInventoryListForCurrentOrg } from '@/server/loaders/inventory-list';
import { InventoryService } from '@/server/services/inventory';
import { LocationsService } from '@/server/services/locations';
import { ServiceError, withContext } from '@/server/services/context';

import {
  adjustStockSchema,
  createItemSchema,
  err,
  ok,
  updateItemSchema,
  type ActionResult,
  type AdjustStockInput,
  type CreateItemInput,
  type UpdateItemInput,
} from '@stockpilot/core';

function toResult<T>(error: unknown): ActionResult<T> {
  if (error instanceof ServiceError) {
    return err(error.code, error.message);
  }
  // Never surface a raw exception message (DB / network internals) to the
  // client — log it server-side for diagnosis and return a generic string.
  // Mirrors the S13 boundary sanitization applied to ServiceError
  // internal_errors above.
  console.error(error);
  return err('internal_error', 'Something went wrong. Please try again.');
}

// Validate UUIDs before they hit Postgres. Without this, a malformed string
// passed to set_category/set_supplier/set_location surfaces as an internal_error
// with a raw "invalid input syntax for type uuid" message — both a 500-as-400
// UX bug and a tiny information leak.
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuidOrNull(v: unknown): boolean {
  return v === null || (typeof v === 'string' && UUID_REGEX.test(v));
}

export async function createItemAction(
  input: CreateItemInput,
): Promise<ActionResult<{ id: string }>> {
  const parsed = createItemSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const svc = await InventoryService.forCurrentUser();
    const item = await svc.create(parsed.data);
    revalidatePath('/dashboard');
    revalidatePath('/dashboard/inventory');
    await revalidateInventoryListForCurrentOrg();
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
    await revalidateInventoryListForCurrentOrg();
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
    await revalidateInventoryListForCurrentOrg();
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
    await revalidateInventoryListForCurrentOrg();
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
    await revalidateInventoryListForCurrentOrg();
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
    await revalidateInventoryListForCurrentOrg();
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
    await revalidateInventoryListForCurrentOrg();
    revalidatePath(`/dashboard/inventory/${parsed.data.itemId}`);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

// ---------------------------------------------------------------------------
// Shared inline-destination shape — used by transferStockAction (Transfer
// dialog) and placeStockAction (Staging put-away). Either an existing
// location id, or the fields needed to create a rack/crate on the fly.
// ---------------------------------------------------------------------------

const newRackSchema = z.object({
  warehouseId: z.string().uuid(),
  rackNumber: z.string().min(1).max(64),
  rackRow: z.string().max(64).optional(),
  crateColor: z.string().max(64).optional(),
  crateNumber: z.string().max(64).optional(),
  parentId: z.string().uuid().optional(),
});

const destinationSchema = z.union([
  z.object({ existingLocationId: z.string().uuid() }),
  z.object({ newRack: newRackSchema }),
]);

/**
 * Verify a warehouse id belongs to the caller's org before creating a
 * location under it. TENANT-ISOLATION GUARD: prevents seeding a location
 * (and then moving stock) under another org's warehouse — same class as the
 * Phase 2a 0199 RLS finding. Returns true when the warehouse is in-org.
 */
async function warehouseInOrg(
  ctx: Awaited<ReturnType<typeof withContext>>,
  warehouseId: string,
): Promise<boolean> {
  const { data: wh } = await ctx.supabase
    .from('warehouses')
    .select('id')
    .eq('id', warehouseId)
    .eq('organization_id', ctx.organizationId)
    .maybeSingle();
  return !!wh;
}

// ---------------------------------------------------------------------------
// transferStockAction — move placed stock between locations; destination may
// be an existing location OR a rack/crate created inline (same union as
// placeStockAction). Creating a location goes through LocationsService.create,
// which asserts 'locations:manage' + the 'locations' plan limit; the transfer
// itself stays gated on 'stock:transfer' inside InventoryService.transferStock.
// ---------------------------------------------------------------------------

const transferStockActionSchema = z
  .object({
    itemId: z.string().uuid(),
    fromLocationId: z.string().uuid(),
    quantity: z.coerce.number().positive(),
    notes: z.string().max(2000).optional(),
    destination: destinationSchema,
  })
  .refine(
    (v) =>
      !('existingLocationId' in v.destination) ||
      v.destination.existingLocationId !== v.fromLocationId,
    { message: 'Source and destination must differ', path: ['destination'] },
  );

export type TransferStockActionInput = z.infer<typeof transferStockActionSchema>;

export async function transferStockAction(
  input: TransferStockActionInput,
): Promise<ActionResult<{ toLocationId: string }>> {
  const parsed = transferStockActionSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  const data = parsed.data;
  try {
    // Resolve the org context ONCE and reuse it for the warehouse
    // org-verification + both services (withContext is request-cached).
    const ctx = await withContext();
    let toLocationId: string;

    if ('existingLocationId' in data.destination) {
      // Existing destination: transfer_stock (mig 0201) org-verifies BOTH
      // location ids against the item's org inside the RPC, so no extra
      // app-level lookup is needed here (unchanged from the pre-union path).
      toLocationId = data.destination.existingLocationId;
    } else {
      const n = data.destination.newRack;
      if (!(await warehouseInOrg(ctx, n.warehouseId))) {
        return err('validation_error', 'Warehouse not found in your organization.');
      }
      // Asserts 'locations:manage' + assertPlanLimit('locations') internally.
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

    const svc = new InventoryService(ctx);
    await svc.transferStock({
      itemId: data.itemId,
      fromLocationId: data.fromLocationId,
      toLocationId,
      quantity: data.quantity,
      notes: data.notes,
    });
    revalidatePath('/dashboard/inventory');
    await revalidateInventoryListForCurrentOrg();
    revalidatePath(`/dashboard/inventory/${data.itemId}`);
    return ok({ toLocationId });
  } catch (e) {
    // Same insufficient_stock → friendly-message mapping as placeStockAction
    // (raw RPC text lives on internalDetail post-S13 sanitization).
    if (
      e instanceof ServiceError &&
      e.code === 'internal_error' &&
      (e.internalDetail ?? '').toLowerCase().includes('insufficient_stock')
    ) {
      return err('validation_error', "Can't transfer more than is available.");
    }
    return toResult(e);
  }
}

// Destination info needed to stamp an item's placement label after a put-away.
type PlaceDest = {
  kind: string | null;
  rackNumber: string | null;
  rackRow: string | null;
  name: string | null;
};

/**
 * After a put-away physically moves stock onto a rack/crate (transfer_stock),
 * stamp the item's placement LABEL so it matches the "Set rack" path. Set rack
 * writes bin_location + rack_* custom_fields via inventory_set_rack, but the
 * Staging put-away only moved the holding and left bin_location stale/NULL
 * (owner-reported gap 2026-07-14: a Chromebook put away to rack 1-A kept
 * bin_location NULL). Reuse the SAME RPC so both paths write identically.
 *
 * Best-effort: the stock is already placed, so a label-stamp failure must NOT
 * fail the action — it degrades to the pre-existing no-label state, which the
 * holdings-derived RACK column already covers. inventory_set_rack (mig
 * 0064/0068) only updates inventory_items; it never touches item_stock_levels,
 * so this re-stamps the label without re-moving stock. Multi-rack items get
 * the LAST placement as their single label — same single-label semantics Set
 * rack already has (the accurate per-rack view is the holdings RACK column).
 */
async function stampBinFromDestination(
  supabase: Awaited<ReturnType<typeof withContext>>['supabase'],
  itemIds: string[],
  dest: PlaceDest,
): Promise<void> {
  if (itemIds.length === 0) return;
  const isRack = dest.kind === 'rack';
  const num = isRack ? dest.rackNumber?.trim() || null : null;
  const row = isRack ? dest.rackRow?.trim().toUpperCase() || null : null;
  // Rack → "num-row" (identical to the Set-rack path's composedBin in
  // services/inventory.ts); crate or number-less rack → the location's name.
  const bin =
    isRack && num ? (row ? `${num}-${row}` : num) : dest.name?.trim() || null;
  const { error } = await supabase.rpc('inventory_set_rack', {
    p_item_ids: itemIds,
    p_rack_number: num,
    p_rack_row: row,
    p_bin_location: bin,
    p_scope: 'auto',
  });
  if (error) {
    console.warn('[place] bin_location stamp failed (stock still placed):', error.message);
  }
}

// ---------------------------------------------------------------------------
// placeStockAction — move staged qty onto an existing or inline-created location
// ---------------------------------------------------------------------------

const placeStockSchema = z.object({
  itemId: z.string().uuid(),
  fromLocationId: z.string().uuid(),
  quantity: z.number().positive(),
  notes: z.string().max(2000).optional(),
  destination: destinationSchema,
});

export type PlaceStockInput = z.infer<typeof placeStockSchema>;

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
    let dest: PlaceDest;

    if ('existingLocationId' in data.destination) {
      // TENANT-ISOLATION GUARD: transfer_stock only verifies the ITEM's org, and
      // item_stock_levels RLS scopes the row's OWN organization_id — NOT the
      // referenced location's org. Without this lookup a forged request could
      // place an org-A item's stock at an org-B location_id (a cross-tenant
      // integrity write; same class as the Phase 2a 0199 RLS finding). Verify
      // the destination location belongs to the caller's org before transfer.
      const { data: loc } = await ctx.supabase
        .from('locations')
        .select('id, warehouse_id, kind, rack_number, rack_row, name')
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
      dest = {
        kind: loc.kind,
        rackNumber: (loc as { rack_number: string | null }).rack_number ?? null,
        rackRow: (loc as { rack_row: string | null }).rack_row ?? null,
        name: (loc as { name: string | null }).name ?? null,
      };
    } else {
      const n = data.destination.newRack;
      // TENANT-ISOLATION GUARD: verify the warehouse belongs to the caller's
      // org BEFORE creating a location under it — prevents seeding a location
      // (and then placing stock) under another org's warehouse.
      if (!(await warehouseInOrg(ctx, n.warehouseId))) {
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
      dest = {
        kind: n.crateColor ? 'crate' : 'rack',
        rackNumber: n.rackNumber ?? null,
        rackRow: n.rackRow ?? null,
        name: deriveLocationName(n),
      };
    }

    const invSvc = new InventoryService(ctx);
    await invSvc.transferStock({
      itemId: data.itemId,
      fromLocationId: data.fromLocationId,
      toLocationId,
      quantity: data.quantity,
      notes: data.notes,
    });
    // Stamp the placement label now that the stock physically sits here.
    await stampBinFromDestination(ctx.supabase, [data.itemId], dest);

    revalidatePath('/dashboard/inventory/staging');
    revalidatePath('/dashboard/inventory');
    await revalidateInventoryListForCurrentOrg();
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
      return err('validation_error', "Can't place more than is available.");
    }
    return toResult(e);
  }
}

// ---------------------------------------------------------------------------
// bulkPlaceStockAction — place MANY not-yet-placed items into ONE rack/crate
// at once (the Staging "Place selected" flow). Each placement moves the full
// chosen quantity from that item's own staging/unplaced holding into the
// shared destination. The destination is org-verified ONCE; each transfer is
// then org-verified per-item by transfer_stock (item org + assert_location_
// in_org on the source). Returns a per-item success/failure summary so one
// bad row (e.g. stock moved out from under us) never sinks the whole batch.
// ---------------------------------------------------------------------------

const bulkPlaceStockSchema = z.object({
  placements: z
    .array(
      z.object({
        itemId: z.string().uuid(),
        fromLocationId: z.string().uuid(),
        quantity: z.number().positive(),
      }),
    )
    .min(1)
    .max(200),
  notes: z.string().max(2000).optional(),
  destination: z.union([
    z.object({ existingLocationId: z.string().uuid() }),
    z.object({ newRack: newRackSchema }),
  ]),
});

export type BulkPlaceStockInput = z.infer<typeof bulkPlaceStockSchema>;

export async function bulkPlaceStockAction(
  input: BulkPlaceStockInput,
): Promise<ActionResult<{ placed: number; failed: Array<{ itemId: string; message: string }> }>> {
  const parsed = bulkPlaceStockSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  const data = parsed.data;

  try {
    const ctx = await withContext();

    // Resolve + org-verify the destination ONCE — same tenant-isolation guards
    // as placeStockAction (destination location/warehouse must be in the
    // caller's org; can't place INTO a staging/unplaced bucket).
    let toLocationId: string;
    let dest: PlaceDest;
    if ('existingLocationId' in data.destination) {
      const { data: loc } = await ctx.supabase
        .from('locations')
        .select('id, warehouse_id, kind, rack_number, rack_row, name')
        .eq('id', data.destination.existingLocationId)
        .eq('organization_id', ctx.organizationId)
        .is('deleted_at', null)
        .maybeSingle();
      if (!loc) {
        return err('validation_error', 'Destination location not found in your organization.');
      }
      if (loc.kind === 'staging' || loc.kind === 'unplaced') {
        return err('validation_error', 'Pick a rack or crate as the destination.');
      }
      toLocationId = loc.id;
      dest = {
        kind: loc.kind,
        rackNumber: (loc as { rack_number: string | null }).rack_number ?? null,
        rackRow: (loc as { rack_row: string | null }).rack_row ?? null,
        name: (loc as { name: string | null }).name ?? null,
      };
    } else {
      const n = data.destination.newRack;
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
      dest = {
        kind: n.crateColor ? 'crate' : 'rack',
        rackNumber: n.rackNumber ?? null,
        rackRow: n.rackRow ?? null,
        name: deriveLocationName(n),
      };
    }

    // Place each item. A single failure (e.g. insufficient_stock if the row's
    // qty moved underneath us) is recorded and skipped — the rest still place.
    const invSvc = new InventoryService(ctx);
    let placed = 0;
    const placedItemIds: string[] = [];
    const failed: Array<{ itemId: string; message: string }> = [];
    for (const p of data.placements) {
      try {
        await invSvc.transferStock({
          itemId: p.itemId,
          fromLocationId: p.fromLocationId,
          toLocationId,
          quantity: p.quantity,
          notes: data.notes,
        });
        placed += 1;
        placedItemIds.push(p.itemId);
      } catch (e) {
        const insufficient =
          e instanceof ServiceError &&
          e.code === 'internal_error' &&
          (e.internalDetail ?? '').toLowerCase().includes('insufficient_stock');
        failed.push({
          itemId: p.itemId,
          message: insufficient ? 'Not enough available to place.' : 'Could not place this item.',
        });
      }
    }
    // One label-stamp for every item that actually landed on the destination.
    await stampBinFromDestination(ctx.supabase, placedItemIds, dest);

    revalidatePath('/dashboard/inventory/staging');
    revalidatePath('/dashboard/inventory');
    await revalidateInventoryListForCurrentOrg();
    return ok({ placed, failed });
  } catch (e) {
    return toResult(e);
  }
}
