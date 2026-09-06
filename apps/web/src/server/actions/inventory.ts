'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import {
  isPositionedCrate,
  PLACE_DEST_COLUMNS,
  plannedPlaceDest,
  toPlaceDest,
  type PlaceDest,
} from '@/lib/locations/destination-option';
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
  newLocationFieldsShape,
  ok,
  planNewLocation,
  refineNewLocation,
  removeStockFromLocationSchema,
  sumPlacementQuantities,
  toBookCratePlacementMoves,
  updateItemSchema,
  type ActionResult,
  type AdjustStockInput,
  type CreateItemInput,
  type GroupKeyParts,
  type NewLocationFields,
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
): Promise<
  ActionResult<{
    id: string;
    /**
     * Present ONLY when a typed rack was asked for and the item's stock did
     * not reach it. The create still succeeded — this says the label and the
     * stock disagree, which is the thing a picker needs to know before they
     * walk to that rack.
     */
    placementFailed?: { rackName: string; count: number };
  }>
> {
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
    return ok({
      id: item.id as string,
      ...(item.placementFailed ? { placementFailed: item.placementFailed } : {}),
    });
  } catch (e) {
    return toResult(e);
  }
}

export async function updateItemAction(
  id: string,
  input: UpdateItemInput,
): Promise<
  ActionResult<{
    id: string;
    /**
     * Present ONLY when the edit set a rack and this item's stock did not
     * reach it. The edit still succeeded — this says the label and the stock
     * disagree, which is the thing a picker needs to know before walking to
     * that rack. Mirrors createItemAction's field of the same name.
     */
    placementFailed?: { rackName: string };
  }>
> {
  const parsed = updateItemSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const svc = await InventoryService.forCurrentUser();
    const updated = (await svc.update(id, parsed.data)) as {
      placementFailed?: { rackName: string };
    } | null;
    revalidatePath('/dashboard/inventory');
    await revalidateInventoryListForCurrentOrg();
    revalidatePath('/dashboard/books');
    revalidatePath(`/dashboard/inventory/${id}`);
    return ok({
      id,
      ...(updated?.placementFailed ? { placementFailed: updated.placementFailed } : {}),
    });
  } catch (e) {
    return toResult(e);
  }
}

/*
 * REMOVED (SP-120, 2026-09): `archiveItemAction` and `deleteItemAction`.
 *
 * Both were scaffold-era exports with ZERO callers anywhere in apps/, packages/
 * or scripts/ — but in a `'use server'` module every export compiles to a
 * server reference the runtime will execute if it is invoked by ID, so they
 * were live, unmaintained surface.
 *
 * Worse, `archiveItemAction` was a SECOND archive path: it called
 * `InventoryService.archive` (guarded by `assertArchivableOrThrow`), while the
 * archive the UI actually performs — components/inventory/bulk-actions.tsx,
 * including archiving a single selected item — goes through
 * `bulkUpdateInventoryAction` -> `svc.bulkUpdate`, guarded by that method's own
 * "bulk twin" of the same check. Two guard implementations for one rule, one of
 * them reachable only through dead code: recurring bug pattern #26, where the
 * next behaviour fix lands on one copy and the other silently keeps the old
 * semantics.
 *
 * If a single-item archive or delete ever needs its own entry point again, wire
 * it to a caller in the same change, and reuse the service guard rather than
 * growing a third copy of it.
 *
 * `src/server/actions/actions-are-reachable.test.ts` now fails on any exported
 * action with no caller, so this cannot silently come back.
 */

export async function removeStockFromLocationAction(
  input: z.input<typeof removeStockFromLocationSchema>,
): Promise<
  ActionResult<{
    /** The stock left, but the book's crate SUMMARY could not be written. */
    crateSyncFailed?: boolean;
    /** The stock left; this title still holds stock in more than one location,
     *  so its crate summary was deliberately left alone. */
    crateSyncSkipped?: boolean;
    /** The stock left; someone else changed the book's crate while it was being
     *  removed, so the summary was left as they set it. */
    crateSyncStale?: boolean;
    /** The stock left, and this title now holds NO stock in any rack or crate,
     *  so there was nothing to synchronize the summary to. It may now name a
     *  crate that holds none of it — the write-off's headline failure mode. */
    crateSyncUnplaced?: boolean;
    /** The summary followed the stock: it now names the one location this title
     *  is left in (or no crate at all). Reported because the operator asked to
     *  remove stock, not to relabel anything. */
    crateSyncUpdated?: boolean;
    /**
     * The crate half followed the stock, but the RACK label was deliberately
     * LEFT AS IT WAS rather than erased.
     *
     * REACHABLE HERE, and it always takes this branch. A write-off draining one
     * of two holdings can leave the book in a single POSITION-LESS crate, whose
     * pair is `(null, null)` — an erasure of a rack a human typed. There is no
     * confirmation gate on a write-off (there is no destination to prompt
     * about), so `rackClearAcknowledged` is never set on this path and the
     * reconciliation ALWAYS preserves. That is the correct outcome; being silent
     * about it was not. The service has reported it in `rackPreservedItemIds`
     * since the rack channel shipped and this boundary discarded it, so the
     * operator was told nothing while the rack label went stale.
     */
    crateSyncRackPreserved?: boolean;
    /**
     * The stock moved and the rack label followed it, but the CRATE label was
     * deliberately LEFT AS IT WAS: the destination is a plain rack, the book
     * records a crate, and nobody was shown that crate being cleared — this
     * request carried no acknowledgement of a clear (an older client, a caller
     * with no confirmation channel, or a race the gate could not predict).
     *
     * Maus I, 2026-08-17: a ten-unit put-away onto rack 38-B erased crate
     * yellow 6 from a book whose crate existed ONLY as that label. Most crates
     * in this warehouse are label-only, so the label is the crate. Kept, not
     * wiped — and reported, because it may now be stale.
     */
    crateSyncCratePreserved?: boolean;
  }>
> {
  const parsed = removeStockFromLocationSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const svc = await InventoryService.forCurrentUser();
    // The reconciliation lives in the SERVICE, not here, so the phone's
    // /api/v1/items/[id]/remove-stock route gets the identical behavior — a
    // derived summary must never depend on which surface the operator used.
    const { crateSync, crateSyncUpdated } = await svc.removeStockFromLocation(parsed.data);
    revalidatePath('/dashboard');
    revalidatePath('/dashboard/inventory');
    await revalidateInventoryListForCurrentOrg();
    revalidatePath('/dashboard/books');
    revalidatePath(`/dashboard/inventory/${parsed.data.itemId}`);
    return ok({
      ...(crateSync && crateSync.failedItemIds.length > 0 ? { crateSyncFailed: true } : {}),
      ...(crateSync && crateSync.skippedItemIds.length > 0 ? { crateSyncSkipped: true } : {}),
      ...(crateSync && crateSync.staleItemIds.length > 0 ? { crateSyncStale: true } : {}),
      ...(crateSync && crateSync.unplacedItemIds.length > 0 ? { crateSyncUnplaced: true } : {}),
      ...(crateSyncUpdated ? { crateSyncUpdated: true } : {}),
      ...(crateSync && crateSync.rackPreservedItemIds.length > 0
        ? { crateSyncRackPreserved: true }
        : {}),
      ...(crateSync && crateSync.cratePreservedItemIds.length > 0
        ? { crateSyncCratePreserved: true }
        : {}),
    });
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
): Promise<
  ActionResult<{
    created: number;
    ids: string[];
    /**
     * Present ONLY when a typed rack was asked for and some of the run's stock
     * did not reach it. Optional and additive so an older client that ignores
     * it still reads `created`/`ids` exactly as before.
     */
    placementFailed?: { rackName: string; count: number };
  }>
> {
  const parsed = bulkCreateSizedVariantsSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const svc = await InventoryService.forCurrentUser();
    const { rows, placementFailed } = await svc.bulkCreateSizedVariants(parsed.data);
    revalidatePath('/dashboard/inventory');
    await revalidateInventoryListForCurrentOrg();
    revalidatePath('/dashboard/books');
    revalidatePath('/dashboard');
    return ok({
      created: rows.length,
      ids: rows.map((r) => r.id),
      ...(placementFailed ? { placementFailed } : {}),
    });
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
}): Promise<
  ActionResult<{
    ok: number;
    skipped: number;
    placed?: number;
    /**
     * Set rack only: items whose stock did NOT reach the rack — every transfer
     * for them was refused, or the rack could not be resolved in their
     * warehouse. Their rack label and pair were still set to what the operator
     * typed, so the label now runs ahead of the stock.
     *
     * A WARNING, and the one the toast could never give: the placement pass is
     * per-holding best-effort and logged its failures to the SERVER console
     * only, while `placed: 0` reads the same as "nothing needed moving". A
     * whole batch could be refused and the operator still saw "Updated N items."
     */
    placeFailed?: number;
    /**
     * Set rack only: BOOKS whose recorded crate was CLEARED because this op
     * moved their stock onto the rack and nowhere else.
     *
     * This action used to declare `{ ok, skipped, placed? }`, which TYPE-ERASED
     * the two counts the service has always returned — so the toolbar could only
     * ever say "Updated N items." for an operation that also wiped a crate label
     * the operator never mentioned. A write nobody asked for and nobody is told
     * about is exactly what the crate gate exists to stop.
     *
     * Every book here is PROVED cleared by a before/after fingerprint on the
     * row. The count drives a sentence, so it may not be inferred from the fact
     * that a write ran.
     */
    crateCleared?: number;
    /**
     * Set rack only: books whose crate label could NOT be reconciled — split
     * holdings, a concurrent re-crate, a failed write, or stock that never
     * reached the rack — plus those the sync rewrote to the crate they already
     * named. Their label still names the old crate while their stock may have
     * moved, so this is a WARNING, not a footnote: it is the picker walking to
     * an empty crate.
     */
    crateUnchanged?: number;
    /**
     * Set rack only: books whose crate label the app REWROTE to a different
     * crate, because their stock never reached the rack and the summary
     * followed it to whatever crate still holds it. Also a warning: the
     * operator typed a rack number, and a value a human recorded changed.
     */
    crateChanged?: number;
    /**
     * Set rack only: books whose crate label was KEPT because their stock
     * reached the plain rack and this op — which has no per-book confirmation
     * channel — could not ask about clearing it (Maus I, 2026-08-17: most
     * crates here are label-only, so the label IS the crate). The label may
     * now be stale; the toast must say so. Where `crateCleared` used to land
     * for these books.
     */
    cratePreserved?: number;
  }>
> {
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
    // The four destination fields and the rule they obey come from ONE place —
    // packages/core/src/inventory/new-location.ts — so the web actions, the
    // mobile transfer route and every dialog refuse the same combinations with
    // the same words. A CRATE SITS ON A RACK: rack fields alongside crate
    // fields are that crate's POSITION, kept and named in full, never resolved
    // by precedence and never dropped (see that header for REPRO A/B).
    ...newLocationFieldsShape,
    parentId: z.string().uuid().optional(),
  })
  .superRefine(refineNewLocation);

const destinationSchema = z.union([
  z.object({ existingLocationId: z.string().uuid() }),
  z.object({ newRack: newRackSchema }),
]);

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
 *
 * Declared here, above every action that uses it, because all three do:
 * Staging put-away, bulk put-away and the Transfer modal.
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

/**
 * `acknowledgedRackChanges` — the answer to the OTHER half of the same
 * confirmation: a rack this placement would ERASE.
 *
 * ═══ ITS PRESENCE IS THE CAPABILITY DECLARATION ═══
 *
 * A client cannot predict a rack erasure locally — only a reader of the live
 * holdings can tell a full move from a split — so a capable client's FIRST
 * request carries an EMPTY array and answers the refusal on the retry. That is
 * why `[]` and `undefined` must stay distinguishable here: `[]` means "ask me",
 * `undefined` means "I cannot be asked", and the server never refuses the
 * second kind. It preserves the rack instead and says so (see
 * `assertBookCratePlacementAllowed`).
 *
 * Additive and separate from `acknowledgedCrateChanges`, which keeps its exact
 * shape and meaning. Widening THAT fingerprint to cover the rack would break
 * every already-shipped client, whose acknowledgement is computed over the crate
 * pair alone — see packages/core/src/inventory/book-rack-placement.ts.
 */
const acknowledgedRackChangesSchema = z
  .array(
    z.object({
      itemId: z.string().uuid(),
      // Opaque here too: produced and compared by bookRackFingerprint.
      currentFingerprint: z.string().min(1).max(256),
    }),
  )
  .max(200)
  .optional();

/**
 * The inline-creation arguments for
 * LocationsService.findOrCreatePlacementDestination.
 * ONE builder, driven by the ONE core planner, so every write path agrees on
 * what a set of fields creates AND on what it is called.
 *
 * The kind, the name and the columns now all come out of the same
 * `planNewLocation` verdict, so they cannot disagree: the fields that named a
 * rack cannot produce `kind:'crate'`, and the confirmation the client rendered
 * from `deriveNewLocationName` is character-for-character the name inserted
 * here (and therefore the one migration 0270's dedupe index matches).
 */
/**
 * ═══ RESOLVE THE DESTINATION WITHOUT MINTING IT ═══
 *
 * The gate must run BEFORE a "+ New rack / crate" row is created, or an operator
 * who taps "Go back" at the confirmation leaves an empty location behind that
 * nothing ever cleans up. (L4L runs 50 racks and zero crates, so the first
 * orphan would be visible clutter in their locations list.)
 *
 * So each placement action now resolves in TWO steps:
 *
 *   1. this — find the existing row this input would REUSE, or describe the row
 *      it would create. Reads only; creates nothing, asserts nothing;
 *   2. `commitNewLocation` below, AFTER the gate has been satisfied — the actual
 *      find-or-create, which re-runs the lookup and so also closes the race with
 *      anyone who created the same name in between.
 *
 * `toLocationId` is null for a row that does not exist yet, which is exactly the
 * truth the sync prediction needs: nothing can be holding stock at a row that
 * does not exist, so every surviving holding really is a rival placement.
 */
async function resolveNewLocation(
  svc: LocationsService,
  n: { warehouseId: string; parentId?: string | null } & NewLocationFields,
): Promise<{ toLocationId: string | null; dest: PlaceDest }> {
  const input = newLocationInput(n);
  const existing = await svc.findRackOrCrate(input);
  if (existing) {
    // From the RESOLVED row, NOT from what the user typed. A case-insensitive
    // reuse ("blue #4" matching the existing "Blue #4") returns the location
    // that already exists, and ITS columns are the truth about that crate.
    return {
      toLocationId: (existing as { id: string }).id,
      dest: toPlaceDest(existing as unknown as Record<string, unknown>),
    };
  }
  // Nothing to reuse: describe the row the insert will hold, from the same ONE
  // planner verdict that will name it. See `plannedPlaceDest`.
  return {
    toLocationId: null,
    dest: plannedPlaceDest({
      kind: input.kind,
      name: input.name,
      rackNumber: input.rackNumber,
      rackRow: input.rackRow,
      crateColor: input.crateColor,
      crateNumber: input.crateNumber,
    }),
  };
}

/**
 * Mint the destination the gate has now approved — or reuse whatever appeared in
 * the window since `resolveNewLocation` looked. Returns the REAL row's id and
 * columns, which is what every write below uses.
 *
 * UNDER stock:transfer, NOT locations:manage (owner decision D1, 2026-08-17).
 * `findOrCreatePlacementDestination` is the put-away's own resolve-or-create:
 * the same find, and a create that proceeds for anyone who may move stock —
 * through the SECURITY DEFINER `mint_placement_location` (0340), which
 * re-checks the org, the permission and the warehouse inside. Putting stock
 * into the crate the book's label names is a stock operation; the Staff preset
 * holds stock:transfer only, and through `create` (locations:manage) every
 * label-only crated book was unreachable for staff, who were pushed onto the
 * bare rack — the crate-erasing path. Ordinary location creation elsewhere
 * keeps locations:manage; this is the ONLY place the exception applies on the
 * web (the mobile /api/v1 transfer route is its twin).
 */
async function commitNewLocation(
  svc: LocationsService,
  n: { warehouseId: string; parentId?: string | null } & NewLocationFields,
): Promise<{ toLocationId: string; dest: PlaceDest }> {
  const created = await svc.findOrCreatePlacementDestination(newLocationInput(n));
  return {
    toLocationId: (created as { id: string }).id,
    dest: toPlaceDest(created as unknown as Record<string, unknown>),
  };
}

function newLocationInput(
  n: { warehouseId: string; parentId?: string | null } & NewLocationFields,
) {
  const plan = planNewLocation(n);
  if (plan.kind === 'invalid') {
    // Unreachable through `newRackSchema`, which refuses the same combination
    // with the same message before this runs. Kept as a fail-closed assertion
    // rather than a cast: this helper is one import away from a caller that
    // forgot to validate, and guessing a destination is the whole defect.
    throw new ServiceError('validation_error', plan.message);
  }
  const isCrate = plan.kind === 'crate';
  return {
    name: plan.name,
    type: isCrate ? ('bin' as const) : ('shelf' as const),
    kind: isCrate ? ('crate' as const) : ('rack' as const),
    warehouseId: n.warehouseId,
    // DECOMPOSED by the planner ("22-B" typed into the number box → "22"/"B").
    // LocationsService.create normalises again; passing the parsed pair keeps
    // the confirmation label and the stored columns provably identical.
    rackNumber: plan.rackNumber,
    rackRow: plan.rackRow,
    crateColor: plan.crateColor,
    crateNumber: plan.crateNumber,
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
// placeStockAction). Creating a location goes through
// LocationsService.findOrCreatePlacementDestination, which proceeds under
// 'stock:transfer' (or 'locations:manage') via the SECURITY DEFINER
// mint_placement_location (0340) — racks/crates never consumed the site plan
// limit; the transfer itself stays gated on 'stock:transfer' inside
// InventoryService.transferStock.
// ---------------------------------------------------------------------------

const transferStockActionSchema = z
  .object({
    itemId: z.string().uuid(),
    fromLocationId: z.string().uuid(),
    quantity: z.coerce.number().positive(),
    notes: z.string().max(2000).optional(),
    destination: destinationSchema,
    // The Transfer modal answers the book-crate gate too — see the action body.
    acknowledgedCrateChanges: acknowledgedCrateChangesSchema,
    acknowledgedRackChanges: acknowledgedRackChangesSchema,
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
): Promise<
  ActionResult<{
    toLocationId: string;
    /** The stock moved, but the book's crate SUMMARY could not be written. */
    crateSyncFailed?: boolean;
    /** The stock moved; this title now holds stock in more than one location,
     *  so its crate summary was deliberately left alone. */
    crateSyncSkipped?: boolean;
    /** The stock moved; someone else changed the book's crate while it was
     *  moving, so the summary was left alone. */
    crateSyncStale?: boolean;
    /** The stock moved, and afterwards this title holds NO stock in any rack or
     *  crate, so there was nothing to synchronize the summary to and it was left
     *  alone. It may now name a crate that holds none of it. */
    crateSyncUnplaced?: boolean;
    /**
     * The stock moved and the crate label followed it, but the RACK label was
     * deliberately LEFT AS IT WAS: the reconciliation would have ERASED a rack
     * a human recorded, and nobody was shown that erasure — an older client, a
     * request that did not carry the rack acknowledgement, or a placement whose
     * rack outcome the gate could not predict in time to ask about.
     *
     * Reported rather than swallowed, and that reporting is the whole trade: a
     * stale rack label is visibly wrong and recoverable (the audit row says what
     * it was), a wiped one is gone. The label may now name a rack this stock has
     * left.
     */
    crateSyncRackPreserved?: boolean;
    /**
     * The stock moved and the rack label followed it, but the CRATE label was
     * deliberately LEFT AS IT WAS: the destination is a plain rack, the book
     * records a crate, and nobody was shown that crate being cleared — this
     * request carried no acknowledgement of a clear (an older client, a caller
     * with no confirmation channel, or a race the gate could not predict).
     *
     * Maus I, 2026-08-17: a ten-unit put-away onto rack 38-B erased crate
     * yellow 6 from a book whose crate existed ONLY as that label. Most crates
     * in this warehouse are label-only, so the label is the crate. Kept, not
     * wiped — and reported, because it may now be stale.
     */
    crateSyncCratePreserved?: boolean;
  }>
> {
  const parsed = transferStockActionSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  const data = parsed.data;
  try {
    // Resolve the org context ONCE and reuse it for the warehouse
    // org-verification + both services (withContext is request-cached).
    const ctx = await withContext();
    let toLocationId: string | null;
    let dest: PlaceDest;
    // Set only on the "+ New" branch, and only while the row is still
    // hypothetical — it is what the gate-approved mint below is built from.
    let pendingNewRack: NewLocationFields & { warehouseId: string } | null = null;

    if ('existingLocationId' in data.destination) {
      // The destination's own crate columns are now needed here — the gate
      // below has to know what the book's summary would BECOME, and the
      // reconciliation after the move reads the same row. Read it rather than
      // taking anything the client says about the destination, exactly as
      // placeStockAction does; pinning it to ctx.organizationId at the same
      // time is defense in depth over transfer_stock's own item-org check
      // (mig 0201), and turns a cross-tenant id into a clean 400.
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
      // ═══ STAGING IS NOT A DESTINATION. UNPLACED IS — rack 100-A ═══
      //
      // These two buckets were refused TOGETHER, and lumping them cost 220
      // books on 2026-07-23. Andrew created a test rack (100-A, a rack number
      // the DC4 floor does not have), moved 242 units onto it from Staging,
      // and then had to get them off again. Every destination list filtered
      // BOTH buckets out, so the only two affordances were "transfer to
      // another REAL rack" and "Remove from rack" — which is a WRITE-OFF. He
      // wrote off four lots (Persepolis -140, Maus I -40, Hunger Games -20,
      // The distance between us -20) with reason "test", two hours after a
      // physical cycle count had verified those exact balances. They were real
      // PO receipts (CVW-002199/002200/002201). Nothing brought them back, and
      // 22 units of a fifth lot are stranded on 100-A to this day.
      //
      // The two buckets were never the same thing:
      //
      //   STAGING is the RECEIVING workflow's inbox. Moving stock back into it
      //   forges the appearance of an unprocessed receipt, and this dialog
      //   already says so when the SOURCE is staged ("placement is handled in
      //   the staging workflow"). Still refused, and the acknowledgement is
      //   still not a bypass.
      //
      //   UNPLACED means "on hand, on no rack" — the exact inverse of a
      //   put-away and the honest home for stock coming off a rack that should
      //   never have existed. It is non-destructive and fully reversible,
      //   which is precisely what the write-off it replaces is not.
      //
      // WHAT ACTUALLY JUSTIFIED THE BLANKET REFUSAL WAS SILENCE, NOT THE
      // DESTINATION. The Outsiders case reads: the gate promised "Placing it
      // here will change that to no crate", the operator acknowledged exactly
      // that, the stock left Blue 4 — and the reconciliation, which classifies
      // both buckets out of the placement set, found nothing to synchronize to
      // and wrote nothing, with NO FLAG ON THE RESPONSE AT ALL. The promise
      // was not kept and nothing said so.
      //
      // That silence is over. `crateSyncUnplaced` is reported by this action
      // and surfaced as a warning by both clients ("... has no stock in a rack
      // or crate now — its crate label was left unchanged and may be wrong").
      // The operator is now TOLD the label may be stale, which is the outcome
      // the refusal was standing in for. Refusing the move as well only leaves
      // them the write-off, and the write-off is not recoverable.
      //
      // placeStockAction and bulkPlaceStockAction still refuse BOTH — a
      // put-away's whole contract is that it lands on a placement.
      if (loc.kind === 'staging') {
        return err(
          'validation_error',
          'Staging is the receiving workflow — pick a rack, a crate, or Unplaced.',
        );
      }
      toLocationId = loc.id;
      // Crate metadata from THIS row, read moments ago.
      dest = toPlaceDest(loc as Record<string, unknown>);
    } else {
      const n = data.destination.newRack;
      if (!(await warehouseInOrg(ctx, n.warehouseId))) {
        return err('validation_error', 'Warehouse not found in your organization.');
      }
      // RESOLVED, NOT MINTED — see resolveNewLocation. Creating the row here and
      // gating afterwards is what left an empty crate behind whenever the
      // operator answered "Go back" to the confirmation.
      ({ toLocationId, dest } = await resolveNewLocation(new LocationsService(ctx), n));
      pendingNewRack = n;
    }

    const svc = new InventoryService(ctx);
    // ═══ THE CRATE SUMMARY FOLLOWS THE STOCK HERE TOO — DEFECT 3(1)(2) ═══
    //
    // This action used to move stock and never touch `book_crate_*`, with a
    // comment saying so. That was wrong in both directions. A book recorded
    // "Blue 4" with all 40 units in crate Blue 4, transferred onto rack 28-A,
    // went on reading "Blue 4" in the Books list, on printed labels, in the CSV
    // and in Export Builder — and a picker walked to an empty crate. Worse, the
    // dialog's own "+ New location" branch could MINT a crate and move every
    // unit into it while the summary still named the old one, so the item named
    // one crate and physically occupied another.
    //
    // The comment's mitigation ("until the next put-away reconciles it") was
    // never true for stock that is transferred rack-to-rack and never staged
    // again, and never true at all for a mobile-first warehouse.
    //
    // So this now runs the SAME two calls the Staging put-away runs, and the
    // Transfer dialog grew the SAME confirmation step to answer the gate with —
    // that was the actual missing piece, not a reason to skip the gate.
    //
    // The rack LABEL (stampPlacementBin) is still deliberately not written
    // here for a rack or a position-less crate: a transfer is not a put-away,
    // and that asymmetry predates this and is unchanged. The crate summary is
    // different — book-crate-placement.ts makes it a derived view of the
    // holdings, so leaving it describing a location the stock has left is a
    // falsehood, not a stale convenience. The ONE narrowing is a POSITIONED
    // crate; see the call below.
    const verified = await svc.assertBookCratePlacementAllowed([data.itemId], dest, {
      acknowledged: data.acknowledgedCrateChanges,
      acknowledgedRacks: data.acknowledgedRackChanges,
      toLocationId,
      moves: new Map([
        [data.itemId, { fromLocationId: data.fromLocationId, quantity: data.quantity }],
      ]),
    });
    // THE GATE IS SATISFIED — now the row may be minted. Nothing above this line
    // creates a location, so every refusal path leaves the warehouse exactly as
    // it found it.
    if (toLocationId === null) {
      // Unreachable with no pending row: `null` is set on the "+ New" branch and
      // nowhere else. Refuse rather than guess a destination — guessing one is
      // the whole defect this family of changes keeps closing.
      if (!pendingNewRack) {
        return err('validation_error', 'Pick a rack or crate as the destination.');
      }
      const minted = await commitNewLocation(new LocationsService(ctx), pendingNewRack);
      toLocationId = minted.toLocationId;
      dest = minted.dest;
    }
    await svc.transferStock({
      itemId: data.itemId,
      fromLocationId: data.fromLocationId,
      toLocationId,
      quantity: data.quantity,
      notes: data.notes,
    });
    // ═══ A POSITIONED CRATE WRITES BOTH SUMMARIES, ON A TRANSFER TOO ═══
    //
    // A crate that sits on a rack describes ONE physical place with TWO item
    // keys, so writing the crate pair and not the rack pair publishes a row
    // that contradicts itself: "recorded in Blue 13, on no rack" — the exact
    // half-empty row this change exists to fix. `isPositionedCrate` keeps the
    // narrowing honest: a rack destination and a crate with no position still
    // write no label here, exactly as before.
    if (isPositionedCrate(dest)) {
      await svc.stampPlacementBin([data.itemId], dest);
    }
    const {
      failedItemIds,
      skippedItemIds,
      staleItemIds,
      unplacedItemIds,
      rackPreservedItemIds,
      cratePreservedItemIds,
    } =
      await svc.syncBookCratePlacement([data.itemId], {
        verified,
        audit: {
          toLocationId,
          quantityByItemId: new Map([[data.itemId, data.quantity]]),
        },
      });
    revalidatePath('/dashboard/inventory');
    await revalidateInventoryListForCurrentOrg();
    revalidatePath(`/dashboard/inventory/${data.itemId}`);
    return ok({
      toLocationId,
      ...(failedItemIds.length > 0 ? { crateSyncFailed: true } : {}),
      ...(skippedItemIds.length > 0 ? { crateSyncSkipped: true } : {}),
      ...(staleItemIds.length > 0 ? { crateSyncStale: true } : {}),
      ...(unplacedItemIds.length > 0 ? { crateSyncUnplaced: true } : {}),
      ...(rackPreservedItemIds.length > 0 ? { crateSyncRackPreserved: true } : {}),
      ...(cratePreservedItemIds.length > 0 ? { crateSyncCratePreserved: true } : {}),
    });
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

const placeStockSchema = z.object({
  itemId: z.string().uuid(),
  fromLocationId: z.string().uuid(),
  quantity: z.number().positive(),
  notes: z.string().max(2000).optional(),
  destination: destinationSchema,
  acknowledgedCrateChanges: acknowledgedCrateChangesSchema,
  acknowledgedRackChanges: acknowledgedRackChangesSchema,
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
    /**
     * The stock moved, and the book's crate was CHANGED BY SOMEONE ELSE while
     * it was moving (or the item was deleted / stopped being a book). The
     * summary was left alone: the confirmation this request carried was about a
     * different crate, so honouring it would be the silent overwrite the gate
     * exists to refuse.
     */
    crateSyncStale?: boolean;
    /**
     * The stock moved, and afterwards this title holds NO stock in any rack or
     * crate — everything it still has sits in a staging/unplaced bucket, or it
     * has no positive holding left. There was nothing authoritative to
     * synchronize the summary to, so it was left alone and may now name a crate
     * that holds none of it. Reported rather than swallowed: this bucket used to
     * be a bare `continue` inside the reconciliation.
     */
    crateSyncUnplaced?: boolean;
    /**
     * The stock moved and the crate label followed it, but the RACK label was
     * deliberately LEFT AS IT WAS: the reconciliation would have ERASED a rack
     * a human recorded, and nobody was shown that erasure — an older client, a
     * request that did not carry the rack acknowledgement, or a placement whose
     * rack outcome the gate could not predict in time to ask about.
     *
     * Reported rather than swallowed, and that reporting is the whole trade: a
     * stale rack label is visibly wrong and recoverable (the audit row says what
     * it was), a wiped one is gone. The label may now name a rack this stock has
     * left.
     */
    crateSyncRackPreserved?: boolean;
    /**
     * The stock moved and the rack label followed it, but the CRATE label was
     * deliberately LEFT AS IT WAS: the destination is a plain rack, the book
     * records a crate, and nobody was shown that crate being cleared — this
     * request carried no acknowledgement of a clear (an older client, a caller
     * with no confirmation channel, or a race the gate could not predict).
     *
     * Maus I, 2026-08-17: a ten-unit put-away onto rack 38-B erased crate
     * yellow 6 from a book whose crate existed ONLY as that label. Most crates
     * in this warehouse are label-only, so the label is the crate. Kept, not
     * wiped — and reported, because it may now be stale.
     */
    crateSyncCratePreserved?: boolean;
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
    let toLocationId: string | null;
    let dest: PlaceDest;
    // Set only on the "+ New" branch, and only while the row is still
    // hypothetical — see resolveNewLocation.
    let pendingNewRack: (NewLocationFields & { warehouseId: string }) | null = null;

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
      // RESOLVED, NOT MINTED. The row is only created once the gate below is
      // satisfied, so "Go back" at the confirmation cannot leave an empty
      // rack/crate behind. An EXISTING match still wins and still supplies its
      // own columns — a case-insensitive reuse ("blue #4" matching the existing
      // "Blue #4") is the row that already exists, and stamping the typed
      // spelling instead would make the item summary and the location row
      // disagree. See resolveNewLocation.
      ({ toLocationId, dest } = await resolveNewLocation(new LocationsService(ctx), n));
      pendingNewRack = n;
    }

    const invSvc = new InventoryService(ctx);
    // THE GATE, before anything moves: refuse to silently overwrite a crate a
    // human already recorded, waiving ONLY the specific change the client says
    // it displayed. Throws ServiceError('conflict') carrying
    // BOOK_CRATE_CHANGE_REQUIRES_CONFIRMATION; no stock moves on that path.
    // `moves` lets the gate skip books whose summary the reconciliation will
    // deliberately leave alone (split holdings) instead of asking about a
    // change that cannot happen.
    const verified = await invSvc.assertBookCratePlacementAllowed([data.itemId], dest, {
      acknowledged: data.acknowledgedCrateChanges,
      acknowledgedRacks: data.acknowledgedRackChanges,
      toLocationId,
      moves: new Map([
        [data.itemId, { fromLocationId: data.fromLocationId, quantity: data.quantity }],
      ]),
    });

    // THE GATE IS SATISFIED — only now may the row be minted. Nothing above this
    // line creates a location, so every refusal path leaves the warehouse
    // exactly as it found it.
    if (toLocationId === null) {
      if (!pendingNewRack) {
        return err('validation_error', 'Pick a rack or crate as the destination.');
      }
      const minted = await commitNewLocation(new LocationsService(ctx), pendingNewRack);
      toLocationId = minted.toLocationId;
      dest = minted.dest;
    }

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
    // rolled back — see syncBookCratePlacement's contract. `verified` is the
    // gate's own pre-move read: the sync re-reads and writes only where the two
    // agree, so a crate edited while the stock was moving is left alone rather
    // than overwritten by an acknowledgement that named a different crate.
    const {
      failedItemIds,
      skippedItemIds,
      staleItemIds,
      unplacedItemIds,
      rackPreservedItemIds,
      cratePreservedItemIds,
    } =
      await invSvc.syncBookCratePlacement([data.itemId], {
        verified,
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
      ...(staleItemIds.length > 0 ? { crateSyncStale: true } : {}),
      ...(unplacedItemIds.length > 0 ? { crateSyncUnplaced: true } : {}),
      ...(rackPreservedItemIds.length > 0 ? { crateSyncRackPreserved: true } : {}),
      ...(cratePreservedItemIds.length > 0 ? { crateSyncCratePreserved: true } : {}),
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
  acknowledgedRackChanges: acknowledgedRackChangesSchema,
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
    /** The stock moved; some title's crate was edited by someone else while the
     *  batch was placing, so its summary was left alone. */
    crateSyncStale?: boolean;
    /** The stock moved; some title now holds NO stock in any rack or crate, so
     *  there was nothing to synchronize its summary to and it was left alone —
     *  possibly naming a crate that holds none of it. */
    crateSyncUnplaced?: boolean;
    /**
     * The stock moved and the crate label followed it, but the RACK label was
     * deliberately LEFT AS IT WAS: the reconciliation would have ERASED a rack
     * a human recorded, and nobody was shown that erasure — an older client, a
     * request that did not carry the rack acknowledgement, or a placement whose
     * rack outcome the gate could not predict in time to ask about.
     *
     * Reported rather than swallowed, and that reporting is the whole trade: a
     * stale rack label is visibly wrong and recoverable (the audit row says what
     * it was), a wiped one is gone. The label may now name a rack this stock has
     * left.
     */
    crateSyncRackPreserved?: boolean;
    /**
     * The stock moved and the rack label followed it, but the CRATE label was
     * deliberately LEFT AS IT WAS: the destination is a plain rack, the book
     * records a crate, and nobody was shown that crate being cleared — this
     * request carried no acknowledgement of a clear (an older client, a caller
     * with no confirmation channel, or a race the gate could not predict).
     *
     * Maus I, 2026-08-17: a ten-unit put-away onto rack 38-B erased crate
     * yellow 6 from a book whose crate existed ONLY as that label. Most crates
     * in this warehouse are label-only, so the label is the crate. Kept, not
     * wiped — and reported, because it may now be stale.
     */
    crateSyncCratePreserved?: boolean;
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
    let toLocationId: string | null;
    let dest: PlaceDest;
    let pendingNewRack: (NewLocationFields & { warehouseId: string }) | null = null;
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
      // RESOLVED, NOT MINTED — the batch gate runs first, so a "Go back" over
      // 200 rows cannot leave an orphaned crate behind either. See
      // resolveNewLocation.
      ({ toLocationId, dest } = await resolveNewLocation(new LocationsService(ctx), n));
      pendingNewRack = n;
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
    const verified = await invSvc.assertBookCratePlacementAllowed(
      data.placements.map((p) => p.itemId),
      dest,
      {
        acknowledged: data.acknowledgedCrateChanges,
        acknowledgedRacks: data.acknowledgedRackChanges,
        toLocationId,
        // NOT `new Map(...)`: that keeps the LAST entry per item, so a book
        // listed in two placements is described to the gate by only one of its
        // moves. The gate then reasons "its other holding survives, so it stays
        // split, so the sync writes nothing" and asks nothing — while both
        // transfers run and the sync, reading live post-move state, overwrites
        // the recorded crate. toBookCratePlacementMoves fails CLOSED instead:
        // an item whose full move set cannot be described is omitted, so the
        // gate asks about it rather than waiving it.
        moves: toBookCratePlacementMoves(data.placements),
      },
    );
    // THE GATE IS SATISFIED — only now may the row be minted.
    if (toLocationId === null) {
      if (!pendingNewRack) {
        return err('validation_error', 'Pick a rack or crate as the destination.');
      }
      const minted = await commitNewLocation(new LocationsService(ctx), pendingNewRack);
      toLocationId = minted.toLocationId;
      dest = minted.dest;
    }
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
    const {
      failedItemIds,
      skippedItemIds,
      staleItemIds,
      unplacedItemIds,
      rackPreservedItemIds,
      cratePreservedItemIds,
    } =
      await invSvc.syncBookCratePlacement(placedItemIds, {
        verified,
        audit: {
          toLocationId,
          // Also not `new Map(...)`, for a reason that needs no forged request:
          // the staging table keys rows `${itemId}::${sourceLocationId}` because
          // one book can hold stock in BOTH staging and unplaced, and Select-all
          // takes both rows. Last-wins would record only the second quantity
          // (7 instead of 8 + 7) in the audit trail.
          quantityByItemId: sumPlacementQuantities(data.placements),
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
      ...(staleItemIds.length > 0 ? { crateSyncStale: true } : {}),
      ...(unplacedItemIds.length > 0 ? { crateSyncUnplaced: true } : {}),
      ...(rackPreservedItemIds.length > 0 ? { crateSyncRackPreserved: true } : {}),
      ...(cratePreservedItemIds.length > 0 ? { crateSyncCratePreserved: true } : {}),
    });
  } catch (e) {
    return toResult(e);
  }
}
