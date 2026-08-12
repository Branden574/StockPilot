'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import {
  isAllowedPoImportUploadMime,
  PO_IMPORT_UPLOAD_MIME_ERROR,
} from '@/lib/po-imports/mime';
import { revalidateInventoryListForCurrentOrg } from '@/server/loaders/inventory-list';
import { ServiceError } from '@/server/services/context';
import { PoImportsService } from '@/server/services/po-imports';
import {
  createItemsFromPoLinesSchema,
  findDuplicatesForPoLinesSchema,
  type DuplicateCandidate,
} from '@/server/services/po-imports-lines';
import type { LineResolution } from '@/server/services/po-imports-variants';

import {
  approvePoImportSchema,
  confirmLineMappingsSchema,
  err,
  ok,
  optionalPoImportDisplayNameSchema,
  renamePoImportSchema,
  type ActionResult,
  type AmbiguousColumnMeaning,
} from '@stockpilot/core';

const MAX_BYTES = 25 * 1024 * 1024;

/**
 * MED-22 — the boundary half of the PO-import MIME allowlist. The list itself
 * lives in `lib/po-imports/mime.ts` and the SERVICE enforces the same one; see
 * that module's header for why both layers keep a check and why one copy of the
 * list is non-negotiable. Keeping the edge check means a bad request is refused
 * before a service is even instantiated, matching every other action here.
 */

const presignSchema = z.object({
  fileName: z.string().min(1).max(255),
  fileMimeType: z.string().min(1),
  fileSize: z.number().int().positive().max(MAX_BYTES),
});

/**
 * Returns a presigned PUT url for the client to upload the PO file directly
 * to Supabase Storage. We don't accept the file through the server action
 * itself because Next.js server actions have a 1MB body limit by default.
 */
export async function presignPoUploadAction(input: {
  fileName: string;
  fileMimeType: string;
  fileSize: number;
}): Promise<ActionResult<{ uploadUrl: string; storagePath: string }>> {
  const parsed = presignSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid file metadata');
  if (!isAllowedPoImportUploadMime(parsed.data.fileMimeType)) {
    return err('validation_error', PO_IMPORT_UPLOAD_MIME_ERROR);
  }
  try {
    // Route through the gated service twin — presigning an upload url into the
    // po-imports bucket is import-privileged (po_imports module +
    // purchase_orders:manage), not something any org member may do. The old
    // inline requireOrgContext + createClient path carried NO such gate.
    //
    // MED-22: `fileMimeType` is now PASSED THROUGH, because the service uses it
    // to choose the stored file extension itself instead of parsing it out of
    // the caller's `fileName` (which was a path-injection sink). The service
    // re-checks the allowlist — the check above is the edge, not the gate.
    const svc = await PoImportsService.forCurrentUser();
    const result = await svc.presignUpload({
      fileName: parsed.data.fileName,
      fileMimeType: parsed.data.fileMimeType,
    });
    return ok(result);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}

const recordSchema = z.object({
  storagePath: z.string().min(1),
  fileName: z.string().min(1),
  fileMimeType: z.string().min(1),
  fileSize: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  sourceType: z.enum(['pdf', 'csv', 'xlsx', 'manual']),
  /** Optional human name (mig 0332). Absent/blank → null; the service
   *  re-validates, so this is the edge and not the gate. */
  displayName: optionalPoImportDisplayNameSchema,
});

export async function recordPoUploadAction(input: {
  storagePath: string;
  fileName: string;
  fileMimeType: string;
  fileSize: number;
  sha256: string;
  sourceType: 'pdf' | 'csv' | 'xlsx' | 'manual';
  displayName?: string | null;
}): Promise<
  ActionResult<{
    id: string;
    duplicateOf: string | null;
    /** Set when the file's previous import produced a CANCELLED purchase order
     *  — a legitimate redo (e.g. the original was approved against the wrong
     *  charter), not a duplicate. The cancelled PO + its import are preserved. */
    reimportOfCancelled: {
      predecessorImportId: string;
      cancelledPoId: string | null;
      cancelledPoNumber: string | null;
    } | null;
  }>
> {
  const parsed = recordSchema.safeParse(input);
  if (!parsed.success) {
    // The name is the only field here a HUMAN types, so its message is the one
    // worth surfacing; everything else is client-computed metadata for which
    // the old generic string stays right.
    const nameIssue = parsed.error.issues.find((i) => i.path[0] === 'displayName');
    return err('validation_error', nameIssue?.message ?? 'Invalid upload metadata');
  }
  try {
    const svc = await PoImportsService.forCurrentUser();
    const result = await svc.createFromUpload(parsed.data);
    revalidatePath('/dashboard/purchase-orders/imports');
    return ok(result);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}

export async function parsePoImportAction(id: string): Promise<ActionResult<void>> {
  try {
    const svc = await PoImportsService.forCurrentUser();
    await svc.parseImport(id);
    revalidatePath(`/dashboard/purchase-orders/imports/${id}`);
    revalidatePath('/dashboard/purchase-orders/imports');
    return ok(undefined);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}

export async function approvePoImportAction(input: {
  poImportId: string;
  warehouseId: string;
  vendorId: string;
  /** Required — approval must name the exact location the PO receives against. */
  locationId: string;
  /** BILL-TO charter. Billing metadata: purchase_orders.charter_id → the PO
   *  PDF's "Bill to" block. Never affects placement or ownership. */
  charterId?: string | null;
  /** Item-OWNERSHIP charter. OMIT the key to leave every item's ownership
   *  untouched; null is an explicit "Generic". Never defaulted from charterId. */
  itemCharterId?: string | null;
  expectedAt?: string | null;
  lineOverrides?: Array<{
    lineId: string;
    itemId?: string | null;
    lineType?: 'inventory' | 'tax' | 'freight' | 'service' | 'fee' | 'discount' | 'unknown';
    skip?: boolean;
  }>;
}): Promise<ActionResult<{ poId: string }>> {
  const parsed = approvePoImportSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const svc = await PoImportsService.forCurrentUser();
    const result = await svc.approve(parsed.data);
    revalidatePath(`/dashboard/purchase-orders/imports/${input.poImportId}`);
    revalidatePath('/dashboard/purchase-orders');
    return ok(result);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}

export async function createItemsFromPoLinesAction(input: {
  poImportId: string;
  lineIds: string[];
  vendorId: string;
  warehouseId: string | null;
  charterId?: string | null;
  locationId?: string | null;
  itemType?: 'product' | 'book';
  nameOverrides?: Record<string, string>;
  decisions?: Record<string, { mode: 'create' | 'use_existing' | 'skip'; itemId?: string }>;
  categoryId?: string | null;
  groupDecisions?: Record<string, { mode: 'new' | 'link'; groupId?: string }>;
  variantOverrides?: Record<
    string,
    { size?: string | null; sizeSystem?: string | null; jerseyNumber?: string | null }
  >;
}): Promise<ActionResult<{ created: number; mapped: number; linked: number; skipped: number }>> {
  const parsed = createItemsFromPoLinesSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    // Route through the gated service twin (PoImportsService.createItemsFromLines)
    // — the SAME shared implementation the /api/v1 Bearer route uses. It adds the
    // po_imports module + purchase_orders:manage asserts on top of
    // InventoryService.create's own item-create gate. The old inline path called
    // the shared function directly with only the item-create gate, so a caller
    // with items:create but a REVOKED purchase_orders:manage slipped through.
    const svc = await PoImportsService.forCurrentUser();
    const result = await svc.createItemsFromLines(parsed.data);

    revalidatePath(`/dashboard/purchase-orders/imports/${parsed.data.poImportId}`);
    revalidatePath('/dashboard/inventory');
    await revalidateInventoryListForCurrentOrg();
    revalidatePath('/dashboard');
    return ok(result);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}

/**
 * Looks up existing inventory items that may already represent each PO
 * line — by exact barcode match against vendor_item_number (highest
 * confidence) or case-insensitive name match against the cleaned PO
 * description (lower confidence). Used by the create-items modal to
 * warn before creating dupes. Implementation lives in po-imports-lines.ts,
 * SHARED with the /api/v1/po-imports/[id]/line-matches Bearer route (via
 * PoImportsService.findDuplicatesForLines) so web and mobile can never drift.
 */
export async function findDuplicatesForPoLinesAction(input: {
  poImportId: string;
  lineIds: string[];
}): Promise<ActionResult<{ matches: Record<string, DuplicateCandidate[]> }>> {
  const parsed = findDuplicatesForPoLinesSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid input');
  try {
    // Route through the gated service twin (PoImportsService.findDuplicatesForLines)
    // — reading duplicate candidates exposes catalog rows, so it must carry the
    // po_imports module + purchase_orders:manage gate. The old inline path read
    // the DB directly with no such gate, so any org member could enumerate it.
    const svc = await PoImportsService.forCurrentUser();
    const { matches } = await svc.findDuplicatesForLines(parsed.data);
    return ok({ matches });
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}

/**
 * Record what an ambiguous column actually means, per line.
 *
 * This is the ONLY way a `mapping_review_required` line stops blocking. It
 * never runs automatically and it never picks a meaning — the human does, and
 * the choice is audited (`sports.import.mapping_confirmed`).
 */
export async function confirmPoImportMappingsAction(input: {
  poImportId: string;
  decisions: Record<string, AmbiguousColumnMeaning>;
}): Promise<ActionResult<{ confirmed: number }>> {
  const parsed = confirmLineMappingsSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const svc = await PoImportsService.forCurrentUser();
    const result = await svc.confirmLineMappings(parsed.data);
    revalidatePath(`/dashboard/purchase-orders/imports/${parsed.data.poImportId}`);
    return ok(result);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}

const resolveLineResultsSchema = z.object({
  poImportId: z.string().uuid(),
  /** The category the reviewer picked in the create-items modal, or null. */
  categoryId: z.string().uuid().nullable().optional(),
});

/**
 * Re-resolve every line's verdict against a chosen category.
 *
 * The page renders verdicts server-side, but a line that will CREATE an item
 * has no `item_id` and therefore no category until the reviewer picks one in
 * the create-items modal. Without this the modal showed 'ready' for every
 * sports line and the reviewer met the real verdict as a server throw at
 * create time. The category is a READ input here: nothing is written, linked
 * or merged, so a wrong pick costs a re-render and nothing else.
 */
export async function resolvePoImportLineResultsAction(input: {
  poImportId: string;
  categoryId?: string | null;
}): Promise<ActionResult<Record<string, LineResolution>>> {
  const parsed = resolveLineResultsSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const svc = await PoImportsService.forCurrentUser();
    return ok(
      await svc.resolveLineResults(parsed.data.poImportId, {
        categoryId: parsed.data.categoryId ?? null,
      }),
    );
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}

/**
 * Rename an import — set or change its human `display_name`.
 *
 * Shape follows renamePoNumberAction (actions/purchase-orders.ts:155): the
 * action zod-validates and revalidates, and carries NO gate of its own — the
 * SERVICE asserts the po_imports module and purchase_orders:manage, and reads
 * the organization from its own context. A caller cannot name an org, and a
 * caller without the permission gets the service's error, not a rename.
 */
export async function renamePoImportAction(input: {
  poImportId: string;
  displayName: string;
}): Promise<ActionResult<{ id: string; displayName: string }>> {
  const parsed = renamePoImportSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid import name.');
  }
  try {
    const svc = await PoImportsService.forCurrentUser();
    const result = await svc.rename(parsed.data.poImportId, parsed.data.displayName);
    revalidatePath('/dashboard/purchase-orders/imports');
    revalidatePath(`/dashboard/purchase-orders/imports/${parsed.data.poImportId}`);
    return ok(result);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}

export async function cancelPoImportAction(id: string): Promise<ActionResult<void>> {
  try {
    const svc = await PoImportsService.forCurrentUser();
    await svc.cancel(id);
    revalidatePath(`/dashboard/purchase-orders/imports/${id}`);
    revalidatePath('/dashboard/purchase-orders/imports');
    return ok(undefined);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}
