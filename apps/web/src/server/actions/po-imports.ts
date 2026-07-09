'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { revalidateInventoryListForCurrentOrg } from '@/server/loaders/inventory-list';
import { ServiceError } from '@/server/services/context';
import { InventoryService } from '@/server/services/inventory';
import { PoImportsService } from '@/server/services/po-imports';
import { VendorItemMappingsService } from '@/server/services/vendor-item-mappings';
import { requireOrgContext } from '@/lib/auth/session';
import { extractIsbnsFromText } from '@/lib/books/isbn-extract';
import { isbnVariants } from '@/lib/books/isbn-variants';
import { createClient } from '@/lib/supabase/server';
import { generateSku } from '@/lib/utils';

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

      // Book ISBN match: for a book import, pull the ISBN off the line
      // (vendor numbers or the description) and look for an existing book whose
      // barcode is that ISBN (in either ISBN-10/13 form). This is ADVISORY
      // ONLY — a hit is recorded as suggested_item_id below for a human to
      // review; it never auto-links the line (matching must never override
      // the charter the user chose for this import).
      let bookIsbn: string | null = null;
      let isbnMatchItemId: string | null = null;
      if (parsed.data.itemType === 'book') {
        const haystack = [vendorItemNumber, vendorProductNumber, auxiliaryNumber, description]
          .filter(Boolean)
          .join(' ');
        bookIsbn = extractIsbnsFromText(haystack)[0] ?? null;
        if (bookIsbn) {
          const variants = isbnVariants(bookIsbn);
          if (variants.length > 0) {
            const { data: candidates, error: isbnErr } = await supabase
              .from('inventory_items')
              .select('id')
              .eq('organization_id', ctx.organizationId)
              .eq('item_type', 'book')
              .in('barcode', variants)
              .is('deleted_at', null)
              .limit(1);
            if (isbnErr) {
              // Fail-closed: fall through to create a new book. Log so a transient
              // DB error doesn't silently spawn duplicate books with no trace.
              console.error(
                'po-imports: ISBN candidate lookup failed; creating new book instead of linking',
                { error: isbnErr.message },
              );
            }
            isbnMatchItemId = (candidates?.[0]?.id as string | undefined) ?? null;
          }
        }
      }

      // Product barcode match: the same courtesy the ISBN block gives books.
      // When the user didn't explicitly decide (mode === 'create') and the
      // line carries vendor numbers, look for an existing item whose barcode
      // EXACTLY matches one of them — vendor_item_number is stored as
      // `barcode` when we create from a PO. ADVISORY ONLY (see decision
      // block below): a hit is recorded as suggested_item_id, never
      // auto-linked, so a re-ordered product still gets its own instance
      // under the chosen charter. NAME matches also never auto-link (same
      // false-positive risk) — those only surface via
      // findDuplicatesForPoLinesAction.
      let barcodeMatchItemId: string | null = null;
      if (parsed.data.itemType !== 'book' && decision.mode === 'create') {
        const vendorNumbers = [vendorItemNumber, vendorProductNumber, auxiliaryNumber].filter(
          (v): v is string => typeof v === 'string' && v.length > 0,
        );
        if (vendorNumbers.length > 0) {
          const { data: byBarcode, error: barcodeErr } = await supabase
            .from('inventory_items')
            .select('id')
            .eq('organization_id', ctx.organizationId)
            .in('barcode', vendorNumbers)
            .is('deleted_at', null)
            .limit(1);
          if (barcodeErr) {
            // Fail-closed: fall through to create a new item. Log so a transient
            // DB error doesn't silently spawn duplicate items with no trace.
            console.error(
              'po-imports: barcode candidate lookup failed; creating new item instead of linking',
              { error: barcodeErr.message },
            );
          }
          barcodeMatchItemId = (byBarcode?.[0]?.id as string | undefined) ?? null;
        }
      }

      // Whether THIS line created a brand-new inventory_items row (vs linking an
      // existing one) — drives `item_created` below so cancel-cleanup only
      // archives items the import actually spawned.
      let didCreate = false;

      if (decision.mode === 'use_existing') {
        if (!decision.itemId) {
          return err(
            'validation_error',
            `Line ${l.line_number} marked use_existing but no itemId provided`,
          );
        }
        // Confirm the chosen item belongs to the caller's org, and read its
        // charter + identity so we can honor the SELECTED charter (below).
        const { data: existing, error: chkErr } = await supabase
          .from('inventory_items')
          .select(
            'id, sku, name, barcode, charter_id, unit_cost, retail_price, category_id, supplier_id, warehouse_id, unit_of_measure, item_type, tracking_type',
          )
          .eq('organization_id', ctx.organizationId)
          .eq('id', decision.itemId)
          .is('deleted_at', null)
          .maybeSingle();
        if (chkErr) throw new ServiceError('internal_error', chkErr.message);
        if (!existing) {
          return err('not_found', `Existing item for line ${l.line_number} not found`);
        }

        const existingCharter = (existing.charter_id as string | null) ?? null;
        if (existingCharter === charterId) {
          // Same charter (both-generic/null counts as same) → link the item.
          resolvedItemId = existing.id as string;
          linked++;
        } else {
          // SELECTED CHARTER WINS (owner decision 2026-07-09): never reuse or
          // re-charter an item under a DIFFERENT charter. Resolve to the
          // same-SKU instance under the SELECTED charter — find it, or create a
          // separate instance, leaving the chosen item untouched. 0234's
          // charter-aware SKU uniqueness makes (org, sku, selectedCharter, null)
          // its own row, so e.g. KVA and CVW stock stay separate.
          const existingSku = existing.sku as string;
          let sibQuery = supabase
            .from('inventory_items')
            .select('id')
            .eq('organization_id', ctx.organizationId)
            .eq('sku', existingSku)
            .is('bin_location', null)
            .is('deleted_at', null);
          sibQuery =
            charterId === null
              ? sibQuery.is('charter_id', null)
              : sibQuery.eq('charter_id', charterId);
          const { data: sibling, error: sibErr } = await sibQuery.maybeSingle();
          if (sibErr) throw new ServiceError('internal_error', sibErr.message);

          if (sibling) {
            resolvedItemId = sibling.id as string;
            linked++;
          } else {
            const siblingItem = await inventorySvc.create({
              name: existing.name as string,
              sku: existingSku,
              barcode: (existing.barcode as string | null) ?? undefined,
              unitCost: Number(existing.unit_cost ?? 0) || 0,
              retailPrice: Number(existing.retail_price ?? 0) || 0,
              quantityOnHand: 0,
              reorderPoint: 0,
              reorderQuantity: 0,
              unitOfMeasure: (existing.unit_of_measure as string | null) ?? 'unit',
              supplierId: (existing.supplier_id as string | null) ?? parsed.data.vendorId,
              warehouseId: (existing.warehouse_id as string | null) ?? parsed.data.warehouseId,
              charterId,
              categoryId: (existing.category_id as string | null) ?? null,
              primaryLocationId,
              trackingType: (existing.tracking_type as 'none' | 'lot' | 'serial' | null) ?? 'none',
              itemType:
                (existing.item_type as 'product' | 'book' | 'asset' | 'consumable' | null) ??
                parsed.data.itemType ??
                'product',
              customFields: {},
              status: 'active',
            });
            resolvedItemId = siblingItem.id as string;
            created++;
            didCreate = true;
          }
        }
      } else {
        // DEFAULT: create a new instance under the CHOSEN charter. A
        // barcode/ISBN hit does NOT link here — matching is advisory only
        // (owner decision: a KVA import must never land on an existing CVW
        // item just because a barcode/ISBN happens to match). The match is
        // recorded as a suggestion on the line below instead, for a human
        // to review later; it never changes what gets created here.
        // Prefer the user-edited name from the modal; otherwise auto-clean
        // by stripping the trailing "(SOMETHING)" part of the PO description
        // since the manufacturer's part number already lives in `barcode`.
        const overrideName = parsed.data.nameOverrides?.[l.id as string]?.trim();
        const cleanedName = description.replace(/\s*\([^)]*\)\s*$/, '').trim();
        const finalName = (
          overrideName && overrideName.length > 0 ? overrideName : cleanedName || description
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
          customFields: {},
          status: 'active',
        });
        created++;
        didCreate = true;
        resolvedItemId = item.id as string;
      }
      // Barcode/ISBN match is advisory only — surfaced for a human to review,
      // never used to change what the line resolved to above.
      const suggestedItemId = barcodeMatchItemId ?? isbnMatchItemId ?? null;

      // Map the line (whether newly created or linked to an explicitly-chosen
      // existing item). Record whether WE created the item (vs linking an
      // existing one) so a later cancel can clean up only the items the
      // import spawned.
      const { error: updErr } = await supabase
        .from('po_import_lines')
        .update({
          item_id: resolvedItemId,
          suggested_item_id: suggestedItemId,
          match_status: 'mapped',
          exception_reason: null,
          // Flag item_created only when WE actually created a new inventory row
          // (the create branch, OR a use_existing line whose selected charter
          // forced a new same-SKU instance). Linking a pre-existing item stays
          // false so cancel-cleanup never archives it.
          item_created: didCreate,
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
    await revalidateInventoryListForCurrentOrg();
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
