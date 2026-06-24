'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { ServiceError } from '@/server/services/context';
import { InventoryService } from '@/server/services/inventory';
import { PoImportsService } from '@/server/services/po-imports';
import { VendorItemMappingsService } from '@/server/services/vendor-item-mappings';
import { requireOrgContext } from '@/lib/auth/session';
import { extractIsbnsFromText } from '@/lib/books/isbn-extract';
import { isbnVariants } from '@/lib/books/isbn-variants';
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
  locationId?: string | null;
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

const lineDecisionSchema = z.object({
  mode: z.enum(['create', 'use_existing', 'skip']),
  /** Required when mode === 'use_existing'. */
  itemId: z.string().uuid().optional(),
});

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
  /** Optional charter the new items belong to (sets inventory_items.charter_id). */
  charterId: z.string().uuid().nullable().optional(),
  /** Optional specific location within the warehouse for the new items. */
  locationId: z.string().uuid().nullable().optional(),
  /**
   * Whether to create the new items as regular products (default) or as books
   * (item_type='book' → they appear on the Books tab). Applies to the whole
   * import — a "book PO" creates books, a supply PO creates products.
   */
  itemType: z.enum(['product', 'book']).optional(),
  /**
   * Optional physical placement applied to every created item. Rack applies to
   * items + books; crate applies to books only. Written to the same custom_fields
   * keys the item form uses (rack_number/rack_row for items, book_rack_* and
   * book_crate_* for books). For books the rack also scopes the ISBN auto-match:
   * a line only folds into an existing book at the SAME rack, so the same title
   * on a different (or no) rack stays a separate item with its own on-hand.
   */
  rackNumber: z.string().max(40).optional(),
  rackRow: z.string().max(40).optional(),
  crateColor: z.string().max(40).optional(),
  crateNumber: z.string().max(40).optional(),
  /**
   * Optional per-line name overrides. Keyed by line id. When present we
   * use the user's edited name; when missing/empty we fall back to the
   * cleaned PO line description.
   */
  nameOverrides: z.record(z.string().uuid(), z.string().min(1).max(200)).optional(),
  /**
   * Per-line decision: create a new item (default), link the PO line to
   * an existing item (no creation), or skip the line entirely. Modal
   * uses these when a duplicate match is detected.
   */
  decisions: z.record(z.string().uuid(), lineDecisionSchema).optional(),
});

export async function createItemsFromPoLinesAction(input: {
  poImportId: string;
  lineIds: string[];
  vendorId: string;
  warehouseId: string | null;
  charterId?: string | null;
  locationId?: string | null;
  itemType?: 'product' | 'book';
  rackNumber?: string;
  rackRow?: string;
  crateColor?: string;
  crateNumber?: string;
  nameOverrides?: Record<string, string>;
  decisions?: Record<string, { mode: 'create' | 'use_existing' | 'skip'; itemId?: string }>;
}): Promise<ActionResult<{ created: number; mapped: number; linked: number; skipped: number }>> {
  const parsed = createItemsFromLinesSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const ctx = await requireOrgContext();
    const supabase = await createClient();
    const inventorySvc = await InventoryService.forCurrentUser();
    const mappingsSvc = await VendorItemMappingsService.forCurrentUser();

    // Resolve a primary_location_id for the new items. Prefer the location the
    // user explicitly chose (verified to belong to this org + the destination
    // warehouse); otherwise fall back to any location in the warehouse.
    // Cosmetic only — the receive flow uses the PO's destination_location_id.
    let primaryLocationId: string | null = null;
    if (parsed.data.locationId && parsed.data.warehouseId) {
      const { data: chosen } = await supabase
        .from('locations')
        .select('id')
        .eq('organization_id', ctx.organizationId)
        .eq('id', parsed.data.locationId)
        .eq('warehouse_id', parsed.data.warehouseId)
        .is('deleted_at', null)
        .maybeSingle();
      primaryLocationId = (chosen?.id as string | undefined) ?? null;
    }
    if (!primaryLocationId && parsed.data.warehouseId) {
      const { data: loc } = await supabase
        .from('locations')
        .select('id')
        .eq('organization_id', ctx.organizationId)
        .eq('warehouse_id', parsed.data.warehouseId)
        .is('deleted_at', null)
        .limit(1)
        .maybeSingle();
      primaryLocationId = (loc?.id as string | undefined) ?? null;
    }

    // Verify the chosen charter belongs to this org before tagging items with it.
    let charterId: string | null = null;
    if (parsed.data.charterId) {
      const { data: charter } = await supabase
        .from('charters')
        .select('id')
        .eq('organization_id', ctx.organizationId)
        .eq('id', parsed.data.charterId)
        .maybeSingle();
      charterId = (charter?.id as string | undefined) ?? null;
    }

    // Confirm the import belongs to the ACTIVE org before creating items in it.
    // RLS on po_import_lines only proves the caller is a member of the import's
    // org — a multi-org user could otherwise pass another of their orgs' import
    // id while the active context is org A, creating org-A items against org-B
    // lines (cross-tenant pollution). This explicit guard fails closed.
    const { data: importHeader } = await supabase
      .from('po_imports')
      .select('id')
      .eq('organization_id', ctx.organizationId)
      .eq('id', parsed.data.poImportId)
      .maybeSingle();
    if (!importHeader) return err('not_found', 'PO import not found');

    // Pull just the lines we're creating items for. RLS guarantees the
    // import belongs to the caller's org.
    const { data: lines, error: lErr } = await supabase
      .from('po_import_lines')
      .select(
        'id, po_import_id, line_number, line_type, description, qty_ordered_original, uom_original, unit_cost, vendor_item_number, vendor_product_number, auxiliary_number, item_id',
      )
      .eq('po_import_id', parsed.data.poImportId)
      .in('id', parsed.data.lineIds);
    if (lErr) throw new ServiceError('internal_error', lErr.message);

    // Physical placement applied to every created item. Rack → items + books;
    // crate → books only. Keys mirror the item form. For books the rack also
    // scopes the ISBN merge below (importRackKey).
    const isBookImport = parsed.data.itemType === 'book';
    const rackNumber = (parsed.data.rackNumber ?? '').trim();
    const rackRow = (parsed.data.rackRow ?? '').trim().toUpperCase();
    const crateColor = (parsed.data.crateColor ?? '').trim();
    const crateNumber = (parsed.data.crateNumber ?? '').trim();
    const placementCustomFields: Record<string, string> = {};
    if (isBookImport) {
      if (rackNumber) placementCustomFields.book_rack_number = rackNumber;
      if (rackRow) placementCustomFields.book_rack_row = rackRow;
      if (crateColor) placementCustomFields.book_crate_color = crateColor;
      if (crateNumber) placementCustomFields.book_crate_number = crateNumber;
    } else {
      if (rackNumber) placementCustomFields.rack_number = rackNumber;
      if (rackRow) placementCustomFields.rack_row = rackRow;
    }
    // "number|row" identity for the book merge ('' = no rack). Same ISBN at a
    // different rack key → not a match → a separate book is created.
    const importRackKey = `${rackNumber}|${rackRow}`;

    let created = 0;
    let mapped = 0;
    let linked = 0;
    let skipped = 0;
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

      const decision = parsed.data.decisions?.[l.id as string] ?? { mode: 'create' };

      if (decision.mode === 'skip') {
        skipped++;
        continue;
      }

      let resolvedItemId: string;
      // Set when a book line auto-links to an existing book by ISBN — that book
      // is pre-existing (not import-created), so it must NOT be flagged
      // item_created (else a later cancel would archive a real book).
      let linkedExistingByIsbn = false;

      // Book ISBN auto-match: for a book import, pull the ISBN off the line
      // (vendor numbers or the description) and look for an existing book whose
      // barcode is that ISBN (in either ISBN-10/13 form). A hit means we link
      // the PO line to that book so RECEIVING adds to its on-hand count instead
      // of creating a duplicate (e.g. 10 on hand + 20 received = 30).
      let bookIsbn: string | null = null;
      let isbnMatchItemId: string | null = null;
      if (parsed.data.itemType === 'book') {
        const haystack = [
          vendorItemNumber,
          vendorProductNumber,
          auxiliaryNumber,
          description,
        ]
          .filter(Boolean)
          .join(' ');
        bookIsbn = extractIsbnsFromText(haystack)[0] ?? null;
        if (bookIsbn) {
          const variants = isbnVariants(bookIsbn);
          if (variants.length > 0) {
            const { data: candidates } = await supabase
              .from('inventory_items')
              .select('id, custom_fields')
              .eq('organization_id', ctx.organizationId)
              .eq('item_type', 'book')
              .in('barcode', variants)
              .is('deleted_at', null)
              .limit(50);
            // Rack-aware merge: only fold into an existing book at the SAME rack
            // (number|row). Same ISBN on a different/blank rack → no match → a
            // separate book is created so its on-hand stays distinct.
            const match = (candidates ?? []).find((c) => {
              const cf = ((c as { custom_fields?: Record<string, unknown> }).custom_fields ??
                {}) as Record<string, unknown>;
              const ck = `${String(cf.book_rack_number ?? '').trim()}|${String(
                cf.book_rack_row ?? '',
              )
                .trim()
                .toUpperCase()}`;
              return ck === importRackKey;
            });
            isbnMatchItemId = (match?.id as string | undefined) ?? null;
          }
        }
      }

      if (decision.mode === 'use_existing') {
        if (!decision.itemId) {
          return err(
            'validation_error',
            `Line ${l.line_number} marked use_existing but no itemId provided`,
          );
        }
        // Defense: confirm the chosen item belongs to the caller's org.
        const { data: existing, error: chkErr } = await supabase
          .from('inventory_items')
          .select('id')
          .eq('organization_id', ctx.organizationId)
          .eq('id', decision.itemId)
          .is('deleted_at', null)
          .maybeSingle();
        if (chkErr) throw new ServiceError('internal_error', chkErr.message);
        if (!existing) {
          return err('not_found', `Existing item for line ${l.line_number} not found`);
        }
        resolvedItemId = existing.id as string;
        linked++;
      } else if (isbnMatchItemId) {
        // Book matched an existing book by ISBN — link so receiving tops up its
        // count instead of creating a duplicate. Not import-created.
        resolvedItemId = isbnMatchItemId;
        linked++;
        linkedExistingByIsbn = true;
      } else {
        // mode === 'create'
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
          // For books, store the ISBN as the barcode so a future book PO with
          // the same ISBN matches this one. Otherwise use the vendor's item
          // number so scanning the physical packaging finds it later.
          barcode: bookIsbn ?? vendorItemNumber ?? vendorProductNumber ?? undefined,
          unitCost: Number(l.unit_cost ?? 0) || 0,
          retailPrice: 0,
          quantityOnHand: 0,
          reorderPoint: 0,
          reorderQuantity: 0,
          unitOfMeasure: (l.uom_original as string | null)?.toLowerCase() ?? 'unit',
          supplierId: parsed.data.vendorId,
          warehouseId: parsed.data.warehouseId,
          charterId,
          categoryId: null,
          primaryLocationId,
          trackingType: 'none',
          itemType: parsed.data.itemType ?? 'product',
          customFields: { ...placementCustomFields },
          status: 'active',
        });
        created++;
        resolvedItemId = item.id as string;
      }

      // Map the line (whether newly created or linked to existing). Record
      // whether WE created the item (vs linking an existing one) so a later
      // cancel can clean up only the items the import spawned.
      const { error: updErr } = await supabase
        .from('po_import_lines')
        .update({
          item_id: resolvedItemId,
          match_status: 'mapped',
          exception_reason: null,
          // Only flag item_created when WE actually created a new item — an
          // ISBN auto-link reuses a pre-existing book, which cancel-cleanup
          // must never archive.
          item_created: decision.mode === 'create' && !linkedExistingByIsbn,
        })
        .eq('id', l.id as string);
      if (updErr) throw new ServiceError('internal_error', updErr.message);

      // Save a vendor_item_mapping so future POs from the same vendor
      // with the same item number auto-match without manual mapping.
      // Best-effort: a mapping failure shouldn't undo the item we just
      // created. Applies whether we created a new item or linked to an
      // existing one — the next PO from this vendor will auto-match.
      if (vendorItemNumber || vendorProductNumber || auxiliaryNumber) {
        try {
          await mappingsSvc.upsert({
            vendorId: parsed.data.vendorId,
            itemId: resolvedItemId,
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
            itemId: resolvedItemId,
            vendorItemNumber,
            error: e instanceof Error ? e.message : e,
          });
        }
      }
    }

    revalidatePath(`/dashboard/purchase-orders/imports/${parsed.data.poImportId}`);
    revalidatePath('/dashboard/inventory');
    revalidatePath('/dashboard');
    return ok({ created, mapped, linked, skipped });
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
 * warn before creating dupes.
 */
const findDuplicatesSchema = z.object({
  poImportId: z.string().uuid(),
  lineIds: z.array(z.string().uuid()).min(1).max(200),
});

export interface DuplicateCandidate {
  id: string;
  name: string;
  sku: string;
  barcode: string | null;
  quantityOnHand: number;
  matchType: 'barcode' | 'name';
}

export async function findDuplicatesForPoLinesAction(input: {
  poImportId: string;
  lineIds: string[];
}): Promise<ActionResult<{ matches: Record<string, DuplicateCandidate[]> }>> {
  const parsed = findDuplicatesSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid input');
  try {
    const ctx = await requireOrgContext();
    const supabase = await createClient();

    const { data: lines, error: lErr } = await supabase
      .from('po_import_lines')
      .select('id, description, vendor_item_number, vendor_product_number, auxiliary_number')
      .eq('po_import_id', parsed.data.poImportId)
      .in('id', parsed.data.lineIds);
    if (lErr) throw new ServiceError('internal_error', lErr.message);

    const matches: Record<string, DuplicateCandidate[]> = {};
    for (const l of lines ?? []) {
      const lineId = l.id as string;
      const description = (l.description as string | null)?.trim();
      const vendorNumbers = [
        l.vendor_item_number,
        l.vendor_product_number,
        l.auxiliary_number,
      ].filter((v): v is string => typeof v === 'string' && v.length > 0);

      const candidates = new Map<string, DuplicateCandidate>();

      // Barcode match: high confidence. Exact match against any of the
      // vendor numbers — vendor_item_number gets stored as `barcode` when
      // we create from a PO, so that's the primary hit.
      if (vendorNumbers.length > 0) {
        const { data: byBarcode } = await supabase
          .from('inventory_items')
          .select('id, name, sku, barcode, quantity_on_hand')
          .eq('organization_id', ctx.organizationId)
          .is('deleted_at', null)
          .in('barcode', vendorNumbers);
        for (const r of byBarcode ?? []) {
          candidates.set(r.id as string, {
            id: r.id as string,
            name: r.name as string,
            sku: r.sku as string,
            barcode: (r.barcode as string | null) ?? null,
            quantityOnHand: Number(r.quantity_on_hand ?? 0) || 0,
            matchType: 'barcode',
          });
        }
      }

      // Name match: lower confidence. Case-insensitive equal on the
      // cleaned description (strip trailing parentheses) — broad ILIKE
      // would be noisy for short generic names.
      if (description) {
        const cleaned = description.replace(/\s*\([^)]*\)\s*$/, '').trim();
        if (cleaned.length >= 4) {
          const { data: byName } = await supabase
            .from('inventory_items')
            .select('id, name, sku, barcode, quantity_on_hand')
            .eq('organization_id', ctx.organizationId)
            .is('deleted_at', null)
            .ilike('name', cleaned);
          for (const r of byName ?? []) {
            if (candidates.has(r.id as string)) continue; // barcode wins
            candidates.set(r.id as string, {
              id: r.id as string,
              name: r.name as string,
              sku: r.sku as string,
              barcode: (r.barcode as string | null) ?? null,
              quantityOnHand: Number(r.quantity_on_hand ?? 0) || 0,
              matchType: 'name',
            });
          }
        }
      }

      const list = [...candidates.values()];
      if (list.length > 0) matches[lineId] = list;
    }

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
