'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { revalidateInventoryListForCurrentOrg } from '@/server/loaders/inventory-list';
import { ServiceError } from '@/server/services/context';
import { InventoryService } from '@/server/services/inventory';
import { PoImportsService } from '@/server/services/po-imports';
import {
  createItemsFromPoLines,
  createItemsFromPoLinesSchema,
  findDuplicatesForPoLines,
  findDuplicatesForPoLinesSchema,
  type DuplicateCandidate,
} from '@/server/services/po-imports-lines';
import { VendorItemMappingsService } from '@/server/services/vendor-item-mappings';
import { requireOrgContext } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';

import { approvePoImportSchema, err, ok, type ActionResult } from '@stockpilot/core';

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
}): Promise<ActionResult<{ id: string; duplicateOf: string | null }>> {
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
  charterId?: string | null;
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

    // Implementation lives in po-imports-lines.ts, SHARED with the
    // /api/v1/po-imports/[id]/create-items Bearer route (via
    // PoImportsService.createItemsFromLines) so web and mobile can never
    // drift. This action keeps its historical auth posture: cookie org
    // context + RLS + InventoryService.create's internal permission gate.
    const result = await createItemsFromPoLines(
      { supabase, organizationId: ctx.organizationId, inventorySvc, mappingsSvc },
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

/** Re-export for the create-items modal (type-only, erased at runtime). */
export type { DuplicateCandidate };

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
