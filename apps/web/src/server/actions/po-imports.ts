'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { revalidateInventoryListForCurrentOrg } from '@/server/loaders/inventory-list';
import { ServiceError, withContext } from '@/server/services/context';
import { InventoryService } from '@/server/services/inventory';
import { PoImportsService } from '@/server/services/po-imports';
import {
  createItemsFromPoLines,
  createItemsFromPoLinesSchema,
  findDuplicatesForPoLines,
  findDuplicatesForPoLinesSchema,
  type DuplicateCandidate,
} from '@/server/services/po-imports-lines';
import type { LineResolution } from '@/server/services/po-imports-variants';
import { VendorItemMappingsService } from '@/server/services/vendor-item-mappings';
import { requireOrgContext } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';

import {
  approvePoImportSchema,
  confirmLineMappingsSchema,
  err,
  ok,
  type ActionResult,
  type AmbiguousColumnMeaning,
} from '@stockpilot/core';

const ALLOWED_MIME = new Set(['application/pdf', 'text/csv', 'application/vnd.ms-excel']);
const MAX_BYTES = 25 * 1024 * 1024;

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
  if (!ALLOWED_MIME.has(parsed.data.fileMimeType)) {
    return err('validation_error', 'Only PDF or CSV files are allowed');
  }
  try {
    const ctx = await requireOrgContext();
    const supabase = await createClient();
    const ext = parsed.data.fileName.split('.').pop()?.toLowerCase() ?? 'bin';
    const storagePath = `${ctx.organizationId}/po-imports/${crypto.randomUUID()}.${ext}`;

    const { data, error } = await supabase.storage
      .from('po-imports')
      .createSignedUploadUrl(storagePath);
    if (error) throw new ServiceError('internal_error', error.message);

    return ok({ uploadUrl: data.signedUrl, storagePath });
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
});

export async function recordPoUploadAction(input: {
  storagePath: string;
  fileName: string;
  fileMimeType: string;
  fileSize: number;
  sha256: string;
  sourceType: 'pdf' | 'csv' | 'xlsx' | 'manual';
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
  if (!parsed.success) return err('validation_error', 'Invalid upload metadata');
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
    const ctx = await requireOrgContext();
    const supabase = await createClient();
    const inventorySvc = await InventoryService.forCurrentUser();
    const mappingsSvc = await VendorItemMappingsService.forCurrentUser();
    // Request-cached, so this is the same context the two services above
    // already built. Needed for the category tracking profile, the org's
    // product groups and the `sports` module flag.
    const serviceCtx = await withContext();

    // Implementation lives in po-imports-lines.ts, SHARED with the
    // /api/v1/po-imports/[id]/create-items Bearer route (via
    // PoImportsService.createItemsFromLines) so web and mobile can never
    // drift. This action keeps its historical auth posture: cookie org
    // context + RLS + InventoryService.create's internal permission gate.
    const result = await createItemsFromPoLines(
      {
        supabase,
        organizationId: ctx.organizationId,
        inventorySvc,
        mappingsSvc,
        ctx: serviceCtx,
      },
      parsed.data,
    );

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
    const ctx = await requireOrgContext();
    const supabase = await createClient();
    const { matches } = await findDuplicatesForPoLines(
      { supabase, organizationId: ctx.organizationId },
      parsed.data,
    );
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
