'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import {
  PLACE_DEST_COLUMNS,
  toPlaceDest,
  type PlaceDest,
} from '@/lib/locations/destination-option';
import { deriveLocationName } from '@/lib/locations/rack-name';
import { revalidateInventoryListForCurrentOrg } from '@/server/loaders/inventory-list';
import { InventoryService } from '@/server/services/inventory';
import { LocationsService } from '@/server/services/locations';
import { ProductGroupsService } from '@/server/services/product-groups';
import { ServiceError, withContext } from '@/server/services/context';

import {
  adjustStockSchema,
  bulkCreateSizedVariantsSchema,
  createItemSchema,
  err,
  isCrateDestination,
  ok,
  removeStockFromLocationSchema,
  updateItemSchema,
  type ActionResult,
  type AdjustStockInput,
  type CreateItemInput,
  type GroupKeyParts,
  type UpdateItemInput,
} from '@stockpilot/core';

function toResult<T>(error: unknown): ActionResult<T> {
  if (error instanceof ServiceError) {
    // `details` is APP-AUTHORED structured metadata (e.g. the book-crate
    // confirmation payload the client retries on) and is forwarded — except
    // for internal_error, whose detail is raw DB/PostgREST text that must stay
    // server-side (S13).
    return err(
      error.code,
      error.message,
      error.code === 'internal_error' ? undefined : error.details,
    );
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

export async function archiveItemAction(
  id: string,
  // Deliberate archive-with-stock (a discontinued line written off wholesale).
  // Omitted/false is the safe default: the service refuses and names the stock.
  opts: { acknowledgeStock?: boolean } = {},
): Promise<ActionResult<void>> {
  try {
    const svc = await InventoryService.forCurrentUser();
    await svc.archive(id, { acknowledgeStock: opts.acknowledgeStock === true });
    revalidatePath('/dashboard/inventory');
    revalidatePath(`/dashboard/inventory/${id}`);
    await revalidateInventoryListForCurrentOrg();
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

export async function removeStockFromLocationAction(
  input: z.input<typeof removeStockFromLocationSchema>,
): Promise<ActionResult<void>> {
  const parsed = removeStockFromLocationSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const svc = await InventoryService.forCurrentUser();
    await svc.removeStockFromLocation(parsed.data);
    revalidatePath('/dashboard');
    revalidatePath('/dashboard/inventory');
    await revalidateInventoryListForCurrentOrg();
    revalidatePath('/dashboard/books');
    revalidatePath(`/dashboard/inventory/${parsed.data.itemId}`);
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

/**
 * The request shape moved to `@stockpilot/core` (Task 10). It is no longer a
 * web-only contract: `POST /api/v1/items/sized-variants` and Expo's Add Item
 * screen parse the SAME object, so a size run valid on one surface is valid on
 * every surface. Nothing about this action's behaviour changed.
 */
export async function bulkCreateSizedVariantsAction(
  input: z.input<typeof bulkCreateSizedVariantsSchema>,
): Promise<ActionResult<{ created: number; ids: string[] }>> {
  const parsed = bulkCreateSizedVariantsSchema.safeParse(input);
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

/**
 * Advisory near-miss lookup for the Add Item grouping preview (Task 11).
 * Wraps `ProductGroupsService.candidates` — matching itself stays entirely
 * server-side and deterministic (see that method's header); this action is
 * just the seam. `name` is deliberately NOT a field on this schema: the
 * requirements are explicit that matching is "never name-string-only", and a
 * name probe is exactly the heuristic that would bake a wrong grouping into
 * persistent identity, so there is nothing here for a client to pass one as.
 */
const groupCandidatesActionSchema = z.object({
  subcategoryKey: z.string().min(1).max(64),
  brand: z.string().max(120).optional().nullable(),
  model: z.string().max(120).optional().nullable(),
  styleNumber: z.string().max(64).optional().nullable(),
  colorway: z.string().max(64).optional().nullable(),
  team: z.string().max(120).optional().nullable(),
  league: z.string().max(120).optional().nullable(),
  season: z.string().max(32).optional().nullable(),
  homeAway: z.string().max(16).optional().nullable(),
  manufacturer: z.string().max(120).optional().nullable(),
  color: z.string().max(64).optional().nullable(),
});

export async function findGroupCandidatesAction(
  input: z.input<typeof groupCandidatesActionSchema>,
): Promise<ActionResult<Array<{ id: string; name: string }>>> {
  const parsed = groupCandidatesActionSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const svc = await ProductGroupsService.forCurrentUser();
    const rows = await svc.candidates(parsed.data as GroupKeyParts);
    // Advisory only — the caller decides whether to link via a separate,
    // explicit click (onUseCandidate). Nothing here writes anything.
    return ok(rows.map((r) => ({ id: r.id, name: r.name })));
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
  // Deliberate archive-with-stock override for a bulk archive / set_status
  // 'archived' batch. Ignored for every other op.
  acknowledgeStock?: boolean;
}): Promise<ActionResult<{ ok: number; skipped: number; placed?: number }>> {
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

const newRackSchema = z
  .object({
    warehouseId: z.string().uuid(),
    // NOT required outright. A CRATE is identified by its color/number, and
    // demanding a rack number for one was an artificial hurdle that also made
    // the crate-vs-rack decision below unreachable for a number-only crate.
    // The refine keeps it mandatory for an actual rack.
    rackNumber: z.string().max(64).optional(),
    rackRow: z.string().max(64).optional(),
    crateColor: z.string().max(64).optional(),
    // FREE TEXT — production holds 0, 1..16, "Bin", "BIN", "Blue Shelf".
    // Never range-validate (see packages/core/src/inventory/book-storage.ts).
    crateNumber: z.string().max(64).optional(),
    parentId: z.string().uuid().optional(),
  })
  .refine(
    (n) =>
      isCrateDestination(n)
        ? // A crate still needs SOMETHING to name it: its own number, or the
          // rack number as the historical fallback deriveLocationName uses.
          !!(n.crateNumber?.trim() || n.rackNumber?.trim())
        : !!n.rackNumber?.trim(),
    {
      message: 'Give the rack a number, or the crate a number.',
      path: ['rackNumber'],
    },
  );

const destinationSchema = z.union([
  z.object({ existingLocationId: z.string().uuid() }),
  z.object({ newRack: newRackSchema }),
]);

/**
 * The inline-creation arguments for LocationsService.findOrCreateRackOrCrate.
 * ONE builder so all four write paths agree on the crate-vs-rack decision —
 * they used to each test `crateColor ? 'crate' : 'rack'` inline, which turned
 * a number-only crate into a rack (wrong kind, wrong dedupe bucket, no crate
 * columns written).
 */
function newLocationInput(n: {
  warehouseId: string;
  rackNumber?: string | null;
  rackRow?: string | null;
  crateColor?: string | null;
  crateNumber?: string | null;
  parentId?: string | null;
}) {
  const isCrate = isCrateDestination(n);
  return {
    name: deriveLocationName(n),
    type: isCrate ? ('bin' as const) : ('shelf' as const),
    kind: isCrate ? ('crate' as const) : ('rack' as const),
    warehouseId: n.warehouseId,
    rackNumber: n.rackNumber ?? null,
    rackRow: n.rackRow ?? null,
    crateColor: n.crateColor ?? null,
    crateNumber: n.crateNumber ?? null,
    parentId: n.parentId ?? null,
  };
}

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
      // findOrCreateRackOrCrate reuses an existing non-deleted rack/crate
      // with the same warehouse+name first (the interactive new-rack path
      // used to always INSERT, minting duplicate locations — see migration
      // 0270). Asserts 'locations:manage' + assertPlanLimit('locations')
      // internally on the create-fallback path only.
      const locationsSvc = new LocationsService(ctx);
      const created = await locationsSvc.findOrCreateRackOrCrate(newLocationInput(n));
      toLocationId = created.id;
    }

    const svc = new InventoryService(ctx);
    // DELIBERATELY NOT SYNCED HERE (yet): the book CRATE summary — the same
    // deferral POST /api/v1/items/[id]/transfer documents, for the same
    // reason, and written down here so the divergence is a decision rather
    // than an omission someone finds later.
    //
    // The Staging put-away (placeStockAction) gates on
    // assertBookCratePlacementAllowed and reconciles with
    // syncBookCratePlacement, because its dialog can ask the question and
    // answer it with `acknowledgedCrateChanges`. THIS action backs the Transfer
    // modal, which has no such affordance: adding the gate would start
    // refusing ordinary transfers, and adding the sync WITHOUT the gate would
    // silently overwrite a crate a person recorded — the exact thing the gate
    // exists to prevent. The consequence is known and bounded: moving a
    // crated book's stock through Transfer leaves its summary describing where
    // it used to be, until the next put-away reconciles it.
    //
    // `dest` already carries the crate columns, so this becomes two calls the
    // moment the Transfer dialog grows the same confirmation step.
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

// ---------------------------------------------------------------------------
// placeStockAction — move staged qty onto an existing or inline-created location
// ---------------------------------------------------------------------------

/**
 * `acknowledgedCrateChanges` — the client's answer to the server's
 * BOOK_CRATE_CHANGE_REQUIRES_CONFIRMATION refusal, SCOPED to the exact changes
 * it displayed: one entry per book, naming the item and a fingerprint of the
 * crate that book was shown to be in.
 *
 * This replaced a bare `acknowledgeCrateChange: boolean`, which the gate read
 * as "do not compare at all" — so a stale client that showed "Blue 4" could
 * pre-acknowledge its first and only request and silently destroy a "Red 7"
 * written after the page rendered. A fingerprint that no longer matches the
 * row is simply not an acknowledgement of the change the server found.
 *
 * Optional, so every existing caller keeps working: a first assignment, a
 * same-crate placement and every non-book placement never reach the gate at
 * all. Capped at 200, matching the bulk placement cap — one entry per
 * placement, never more.
 */
const acknowledgedCrateChangesSchema = z
  .array(
    z.object({
      itemId: z.string().uuid(),
      // Opaque to this layer: produced and compared by bookCrateFingerprint in
      // @stockpilot/core. Length-capped so a forged request cannot post 200
      // unbounded strings.
      currentFingerprint: z.string().min(1).max(256),
    }),
  )
  .max(200)
  .optional();

const placeStockSchema = z.object({
  itemId: z.string().uuid(),
  fromLocationId: z.string().uuid(),
  quantity: z.number().positive(),
  notes: z.string().max(2000).optional(),
  destination: destinationSchema,
  acknowledgedCrateChanges: acknowledgedCrateChangesSchema,
});

export type PlaceStockInput = z.input<typeof placeStockSchema>;

export async function placeStockAction(
  input: PlaceStockInput,
): Promise<
  ActionResult<{
    toLocationId: string;
    /** The stock moved, but the book's crate SUMMARY could not be written. */
    crateSyncFailed?: boolean;
    /**
     * The stock moved, and the summary was deliberately LEFT ALONE because
     * this title now holds stock in more than one location. Not a failure —
     * but the dialog must say so, or a placement that changed no label is
     * indistinguishable from one that did.
     */
    crateSyncSkipped?: boolean;
  }>
> {
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
        .select(PLACE_DEST_COLUMNS)
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
      // Crate metadata comes from THIS row, read moments ago — not from
      // anything the client sent about the destination.
      dest = toPlaceDest(loc as Record<string, unknown>);
    } else {
      const n = data.destination.newRack;
      // TENANT-ISOLATION GUARD: verify the warehouse belongs to the caller's
      // org BEFORE creating a location under it — prevents seeding a location
      // (and then placing stock) under another org's warehouse.
      if (!(await warehouseInOrg(ctx, n.warehouseId))) {
        return err('validation_error', 'Warehouse not found in your organization.');
      }
      // findOrCreateRackOrCrate reuses an existing non-deleted rack/crate
      // with the same warehouse+name first — see migration 0270 (dup-rack
      // fix) and the shared helper's doc comment for why matching stays
      // case-insensitive.
      const locationsSvc = new LocationsService(ctx);
      const created = await locationsSvc.findOrCreateRackOrCrate(newLocationInput(n));
      toLocationId = created.id;
      // From the RESOLVED row, NOT from what the user typed. A
      // case-insensitive reuse ("blue #4" matching the existing "Blue #4")
      // returns the location that already exists, and its columns are the
      // truth about that crate — stamping the typed spelling instead would
      // make the item summary and the location row disagree.
      dest = toPlaceDest(created as Record<string, unknown>);
    }

    const invSvc = new InventoryService(ctx);
    // THE GATE, before anything moves: refuse to silently overwrite a crate a
    // human already recorded, waiving ONLY the specific change the client says
    // it displayed. Throws ServiceError('conflict') carrying
    // BOOK_CRATE_CHANGE_REQUIRES_CONFIRMATION; no stock moves on that path.
    // `moves` lets the gate skip books whose summary the reconciliation will
    // deliberately leave alone (split holdings) instead of asking about a
    // change that cannot happen.
    await invSvc.assertBookCratePlacementAllowed([data.itemId], dest, {
      acknowledged: data.acknowledgedCrateChanges,
      toLocationId,
      moves: new Map([
        [data.itemId, { fromLocationId: data.fromLocationId, quantity: data.quantity }],
      ]),
    });

    await invSvc.transferStock({
      itemId: data.itemId,
      fromLocationId: data.fromLocationId,
      toLocationId,
      quantity: data.quantity,
      notes: data.notes,
    });
    // Stamp the placement label now that the stock physically sits here.
    await invSvc.stampPlacementBin([data.itemId], dest);
    // Re-synchronize the book crate SUMMARY from the holdings that now exist.
    // The stock has already moved, so a failure here is reported, never
    // rolled back — see syncBookCratePlacement's contract.
    const { failedItemIds, skippedItemIds } = await invSvc.syncBookCratePlacement([data.itemId], {
      audit: {
        toLocationId,
        quantityByItemId: new Map([[data.itemId, data.quantity]]),
      },
    });

    revalidatePath('/dashboard/inventory/staging');
    revalidatePath('/dashboard/inventory');
    await revalidateInventoryListForCurrentOrg();
    return ok({
      toLocationId,
      ...(failedItemIds.length > 0 ? { crateSyncFailed: true } : {}),
      ...(skippedItemIds.length > 0 ? { crateSyncSkipped: true } : {}),
    });
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
  // REUSES the shared `destinationSchema`. This used to re-declare the union
  // inline, which meant every field added to the shared one was silently
  // dropped by bulk. There is now exactly one destination shape.
  destination: destinationSchema,
  acknowledgedCrateChanges: acknowledgedCrateChangesSchema,
});

export type BulkPlaceStockInput = z.input<typeof bulkPlaceStockSchema>;

export async function bulkPlaceStockAction(
  input: BulkPlaceStockInput,
): Promise<
  ActionResult<{
    placed: number;
    failed: Array<{ itemId: string; message: string }>;
    /** The stock moved, but some book's crate SUMMARY could not be written. */
    crateSyncFailed?: boolean;
    /** The stock moved; some title holds stock in more than one location, so
     *  its summary was deliberately left alone (see syncBookCratePlacement). */
    crateSyncSkipped?: boolean;
  }>
> {
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
        .select(PLACE_DEST_COLUMNS)
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
      dest = toPlaceDest(loc as Record<string, unknown>);
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
      // findOrCreateRackOrCrate reuses an existing non-deleted rack/crate
      // with the same warehouse+name first — see migration 0270 (dup-rack
      // fix) and the shared helper's doc comment for why matching stays
      // case-insensitive.
      const locationsSvc = new LocationsService(ctx);
      const created = await locationsSvc.findOrCreateRackOrCrate(newLocationInput(n));
      toLocationId = created.id;
      // From the RESOLVED row, not the typed input — see placeStockAction.
      dest = toPlaceDest(created as Record<string, unknown>);
    }

    // Place each item. A single failure (e.g. insufficient_stock if the row's
    // qty moved underneath us) is recorded and skipped — the rest still place.
    const invSvc = new InventoryService(ctx);
    // THE GATE, once for the whole batch and BEFORE any stock moves: if any
    // selected book would have its recorded crate overwritten, the entire
    // batch is refused with the structured payload naming every affected book.
    // All-or-nothing here on purpose — a half-placed batch where the user then
    // confirms would double-move the ones that already went.
    // A batch acknowledgement is per-book, so one stale line refuses the batch
    // and re-asks with fresh truth rather than waiving all 200.
    await invSvc.assertBookCratePlacementAllowed(
      data.placements.map((p) => p.itemId),
      dest,
      {
        acknowledged: data.acknowledgedCrateChanges,
        toLocationId,
        moves: new Map(
          data.placements.map((p) => [
            p.itemId,
            { fromLocationId: p.fromLocationId, quantity: p.quantity },
          ]),
        ),
      },
    );
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
    await invSvc.stampPlacementBin(placedItemIds, dest);
    // ...and one crate-summary reconciliation for the same set. Items that
    // FAILED to transfer are deliberately excluded: their stock never moved,
    // so nothing about their crate changed.
    const { failedItemIds, skippedItemIds } = await invSvc.syncBookCratePlacement(placedItemIds, {
      audit: {
        toLocationId,
        quantityByItemId: new Map(data.placements.map((p) => [p.itemId, p.quantity])),
      },
    });

    revalidatePath('/dashboard/inventory/staging');
    revalidatePath('/dashboard/inventory');
    await revalidateInventoryListForCurrentOrg();
    return ok({
      placed,
      failed,
      ...(failedItemIds.length > 0 ? { crateSyncFailed: true } : {}),
      ...(skippedItemIds.length > 0 ? { crateSyncSkipped: true } : {}),
    });
  } catch (e) {
    return toResult(e);
  }
}
