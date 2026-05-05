'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { ServiceError } from '@/server/services/context';
import { InventoryService } from '@/server/services/inventory';
import { PoImportsService } from '@/server/services/po-imports';
import { VendorItemMappingsService } from '@/server/services/vendor-item-mappings';
import { requireOrgContext } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { generateSku } from '@/lib/utils';

import {
  approvePoImportSchema,
  err,
  ok,
  type ActionResult,
} from '@stockpilot/core';

const ALLOWED_MIME = new Set([
  'application/pdf',
  'text/csv',
  'application/vnd.ms-excel',
]);
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

const createItemsFromLinesSchema = z.object({
  poImportId: z.string().uuid(),
  lineIds: z.array(z.string().uuid()).min(1).max(200),
  /**
   * Vendor (supplier) the new items will be tagged with — also drives the
   * vendor_item_mappings rows we create alongside, so future POs from the
   * same vendor with the same vendor_item_number auto-match.
   */
  vendorId: z.string().uuid(),
  /** Destination warehouse the new items will be created at. */
  warehouseId: z.string().uuid().nullable(),
  /**
   * Optional per-line name overrides. Keyed by line id. When present we
   * use the user's edited name; when missing/empty we fall back to the
   * cleaned PO line description.
   */
  nameOverrides: z.record(z.string().uuid(), z.string().min(1).max(200)).optional(),
});

export async function createItemsFromPoLinesAction(input: {
  poImportId: string;
  lineIds: string[];
  vendorId: string;
  warehouseId: string | null;
  nameOverrides?: Record<string, string>;
}): Promise<ActionResult<{ created: number; mapped: number }>> {
  const parsed = createItemsFromLinesSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    await requireOrgContext();
    const supabase = await createClient();
    const inventorySvc = await InventoryService.forCurrentUser();
    const mappingsSvc = await VendorItemMappingsService.forCurrentUser();

    // Pull just the lines we're creating items for. RLS guarantees the
    // import belongs to the caller's org.
    const { data: lines, error: lErr } = await supabase
      .from('po_import_lines')
      .select(
        'id, po_import_id, line_type, description, qty_ordered_original, uom_original, unit_cost, vendor_item_number, vendor_product_number, auxiliary_number, item_id',
      )
      .eq('po_import_id', parsed.data.poImportId)
      .in('id', parsed.data.lineIds);
    if (lErr) throw new ServiceError('internal_error', lErr.message);

    let created = 0;
    let mapped = 0;
    for (const l of lines ?? []) {
      // Skip lines that aren't inventory or already have an item — caller
      // shouldn't pass them but be defensive.
      if (l.line_type !== 'inventory') continue;
      if (l.item_id) continue;
      const description = (l.description as string | null)?.trim();
      if (!description) continue;

      const vendorItemNumber = (l.vendor_item_number as string | null) ?? null;
      const vendorProductNumber = (l.vendor_product_number as string | null) ?? null;
      const auxiliaryNumber = (l.auxiliary_number as string | null) ?? null;

      // Prefer the user-edited name from the modal; otherwise auto-clean
      // by stripping the trailing "(SOMETHING)" part of the PO description
      // since the manufacturer's part number already lives in `barcode`.
      const overrideName = parsed.data.nameOverrides?.[l.id as string]?.trim();
      const cleanedName = description.replace(/\s*\([^)]*\)\s*$/, '').trim();
      const finalName = (overrideName && overrideName.length > 0
        ? overrideName
        : cleanedName || description
      ).slice(0, 200);

      const item = await inventorySvc.create({
        name: finalName,
        sku: generateSku(),
        // Use the vendor's item number as the barcode so scanning the
        // physical packaging finds it later.
        barcode: vendorItemNumber ?? vendorProductNumber ?? undefined,
        unitCost: Number(l.unit_cost ?? 0) || 0,
        retailPrice: 0,
        quantityOnHand: 0,
        reorderPoint: 0,
        reorderQuantity: 0,
        unitOfMeasure: (l.uom_original as string | null)?.toLowerCase() ?? 'unit',
        supplierId: parsed.data.vendorId,
        warehouseId: parsed.data.warehouseId,
        charterId: null,
        categoryId: null,
        primaryLocationId: null,
        trackingType: 'none',
        itemType: 'product',
        customFields: {},
        status: 'active',
      });
      created++;

      // Map this line to the new item.
      const { error: updErr } = await supabase
        .from('po_import_lines')
        .update({
          item_id: item.id,
          match_status: 'mapped',
          exception_reason: null,
        })
        .eq('id', l.id as string);
      if (updErr) throw new ServiceError('internal_error', updErr.message);

      // Save a vendor_item_mapping so future POs from the same vendor
      // with the same item number auto-match without manual mapping.
      // Best-effort: a mapping failure shouldn't undo the item we just
      // created. The user can still pick the new item from the dropdown
      // even if the mapping didn't save.
      if (vendorItemNumber || vendorProductNumber || auxiliaryNumber) {
        try {
          await mappingsSvc.upsert({
            vendorId: parsed.data.vendorId,
            itemId: item.id as string,
            vendorItemNumber,
            vendorProductNumber,
            auxiliaryNumber,
            vendorDescription: description,
            vendorUom: (l.uom_original as string | null) ?? null,
            packQty: null,
            conversionFactor: null,
          });
          mapped++;
        } catch (e) {
          console.error('vendor mapping upsert failed', {
            itemId: item.id,
            vendorItemNumber,
            error: e instanceof Error ? e.message : e,
          });
        }
      }
    }

    revalidatePath(`/dashboard/purchase-orders/imports/${parsed.data.poImportId}`);
    revalidatePath('/dashboard/inventory');
    revalidatePath('/dashboard');
    return ok({ created, mapped });
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
