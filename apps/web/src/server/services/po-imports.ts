import 'server-only';

import { createHash } from 'node:crypto';

import { audit } from './audit';
import {
  VendorItemMappingsService,
} from './vendor-item-mappings';
import {
  matchByVendorNumber,
  type MappingRow,
} from './vendor-item-mappings-match';
import {
  assertModuleEnabled,
  assertPermission,
  ServiceError,
  withContext,
  type ServiceContext,
} from './context';
import { buildPoCharges } from '@/lib/po-imports/charges';
import { parsePoFile, type ParseSourceType } from '@/lib/po-parser';
import { extractPoFromMedia, SCAN_MODEL_NAME } from '@/lib/po-scan/extract';
import { createAdminClient } from '@/lib/supabase/admin';

import type {
  ApprovePoImportInput,
  CanonicalPo,
  PoImportLineType,
  PoImportMatchStatus,
  PoImportStatus,
} from '@stockpilot/core';

export interface PoImportRow {
  id: string;
  organization_id: string;
  uploaded_by: string;
  source_type: ParseSourceType | 'xlsx' | 'manual' | 'scan';
  extraction_confidence: number | null;
  extraction_model: string | null;
  vendor_id: string | null;
  warehouse_id: string | null;
  file_name: string;
  file_mime_type: string;
  file_size: number;
  storage_path: string;
  sha256: string;
  status: PoImportStatus;
  parse_error: string | null;
  approved_po_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface PoImportLineRow {
  id: string;
  po_import_id: string;
  line_number: number;
  line_type: PoImportLineType;
  qty_ordered_original: number | null;
  uom_original: string | null;
  description: string | null;
  unit_cost: number | null;
  line_total: number | null;
  vendor_item_number: string | null;
  vendor_product_number: string | null;
  auxiliary_number: string | null;
  coa_code: string | null;
  item_id: string | null;
  /** Advisory "possible existing match" (barcode/ISBN/vendor mapping).
      Informational only — never auto-linked; the user must explicitly
      accept it (decision use_existing) to set item_id. */
  suggested_item_id: string | null;
  match_status: PoImportMatchStatus;
  match_confidence: number | null;
  /** OCR/extraction confidence (0-1). Populated for source_type='scan';
      null for deterministic-parsed CSV/PDF imports (those are 100%). */
  extraction_confidence: number | null;
  exception_reason: string | null;
}

export class PoImportsService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new PoImportsService(await withContext());
  }

  async list(): Promise<PoImportRow[]> {
    assertModuleEnabled(this.ctx, 'po_imports');
    const { data, error } = await this.ctx.supabase
      .from('po_imports')
      .select(
        `id, organization_id, uploaded_by, source_type, vendor_id, warehouse_id,
         file_name, file_mime_type, file_size, storage_path, sha256, status,
         parse_error, approved_po_id, created_at, updated_at,
         extraction_confidence, extraction_model`,
      )
      .eq('organization_id', this.ctx.organizationId)
      .order('created_at', { ascending: false });
    if (error) throw new ServiceError('internal_error', error.message);
    return (data ?? []) as PoImportRow[];
  }

  async get(id: string): Promise<{ header: PoImportRow; lines: PoImportLineRow[] }> {
    assertModuleEnabled(this.ctx, 'po_imports');
    const { data: header, error: hErr } = await this.ctx.supabase
      .from('po_imports')
      .select('*')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .maybeSingle();
    if (hErr) throw new ServiceError('internal_error', hErr.message);
    if (!header) throw new ServiceError('not_found', 'PO import not found');
    const { data: lines, error: lErr } = await this.ctx.supabase
      .from('po_import_lines')
      .select('*')
      .eq('po_import_id', id)
      .order('line_number', { ascending: true });
    if (lErr) throw new ServiceError('internal_error', lErr.message);
    return {
      header: header as unknown as PoImportRow,
      lines: (lines ?? []) as unknown as PoImportLineRow[],
    };
  }

  /**
   * Caller has already PUT the file to Storage (presigned URL).
   * This persists the metadata row at status='uploaded' and trusts the
   * caller-computed sha256.
   */
  async createFromUpload(input: {
    sourceType: ParseSourceType | 'xlsx' | 'manual';
    storagePath: string;
    fileName: string;
    fileMimeType: string;
    fileSize: number;
    sha256: string;
  }): Promise<{ id: string; duplicateOf: string | null }> {
    assertModuleEnabled(this.ctx, 'po_imports');
    assertPermission(this.ctx, 'purchase_orders:manage');

    // Defense-in-depth: the action schema validates storagePath as a
    // bare string. The presign step builds a per-org path, but the
    // client could call recordPoUploadAction with someone else's path.
    // Storage RLS still refuses cross-org downloads, but a pointer row
    // pointing at another org's file has no business existing.
    const requiredPrefix = `${this.ctx.organizationId}/`;
    if (!input.storagePath.startsWith(requiredPrefix)) {
      throw new ServiceError(
        'validation_error',
        'Invalid storage path — wrong org prefix.',
      );
    }

    // Duplicate check: same org + same checksum + status not in failed/canceled/duplicate.
    const { data: dup } = await this.ctx.supabase
      .from('po_imports')
      .select('id, status')
      .eq('organization_id', this.ctx.organizationId)
      .eq('sha256', input.sha256)
      .not('status', 'in', '(failed,canceled,duplicate)')
      .maybeSingle();
    if (dup) {
      return { id: dup.id as string, duplicateOf: dup.id as string };
    }

    const { data, error } = await this.ctx.supabase
      .from('po_imports')
      .insert({
        organization_id: this.ctx.organizationId,
        uploaded_by: this.ctx.userId,
        source_type: input.sourceType,
        file_name: input.fileName,
        file_mime_type: input.fileMimeType,
        file_size: input.fileSize,
        storage_path: input.storagePath,
        sha256: input.sha256,
        status: 'uploaded',
      })
      .select('id')
      .single();
    if (error) throw new ServiceError('internal_error', error.message);
    await audit(
      {
        event: 'po_import.uploaded',
        entityType: 'po_import',
        entityId: data.id as string,
        after: { fileName: input.fileName, sha256: input.sha256 },
      },
      this.ctx,
    );
    return { id: data.id as string, duplicateOf: null };
  }

  /**
   * Phone-scanned PO end-to-end. Accepts raw image/PDF buffers (one or
   * more — multi-page POs supported), uploads them to the po-imports
   * bucket, runs Gemini Flash extraction, persists the header + lines
   * with extraction_confidence per line, applies vendor-mapping
   * resolution, and returns the import id ready for review.
   *
   * Single transaction-ish flow that mirrors createFromUpload +
   * parseImport, except we never call the deterministic parsers.
   */
  async createFromScan(input: {
    files: Array<{ bytes: Uint8Array; mimeType: string; fileName: string }>;
    vendorId?: string | null;
    warehouseId?: string | null;
  }): Promise<{ id: string; duplicateOf: string | null; lowConfidenceLines: number }> {
    assertModuleEnabled(this.ctx, 'po_imports');
    assertPermission(this.ctx, 'purchase_orders:manage');
    if (input.files.length === 0) {
      throw new ServiceError('validation_error', 'No files provided.');
    }
    if (input.files.length > 5) {
      throw new ServiceError(
        'validation_error',
        'Limit is 5 frames per scan — split larger POs into separate scans.',
      );
    }

    // Hash the concatenated bytes for dedup.
    const hash = createHash('sha256');
    let totalSize = 0;
    for (const f of input.files) {
      hash.update(f.bytes);
      totalSize += f.bytes.byteLength;
    }
    const sha256 = hash.digest('hex');

    // Duplicate check on the same scan (re-uploading the same bytes).
    const { data: dup } = await this.ctx.supabase
      .from('po_imports')
      .select('id, status')
      .eq('organization_id', this.ctx.organizationId)
      .eq('sha256', sha256)
      .not('status', 'in', '(failed,canceled,duplicate)')
      .maybeSingle();
    if (dup) {
      return {
        id: dup.id as string,
        duplicateOf: dup.id as string,
        lowConfidenceLines: 0,
      };
    }

    // Upload each file to storage. Use the admin client because the
    // standard po-imports bucket policy expects user-uploaded paths;
    // service-role bypasses RLS for the bulk-upload case.
    const admin = createAdminClient();
    const baseFileName = input.files[0]!.fileName;
    const baseFile = input.files[0]!;
    const ext = baseFile.mimeType === 'application/pdf' ? 'pdf' : 'jpg';
    const storagePath = `${this.ctx.organizationId}/po-imports/${sha256}.${ext}`;

    // Upload only the FIRST file as the canonical record (used for re-display
    // / re-extraction). Multi-frame uploads send all to Gemini but we keep
    // one file tracked. Gemini's extraction merges them.
    const { error: upErr } = await admin.storage
      .from('po-imports')
      .upload(storagePath, baseFile.bytes, {
        contentType: baseFile.mimeType,
        upsert: true,
      });
    if (upErr) {
      throw new ServiceError('internal_error', `Storage upload failed: ${upErr.message}`);
    }

    // Run extraction over every frame.
    const extracted = await extractPoFromMedia(
      input.files.map((f) => ({
        base64: Buffer.from(f.bytes).toString('base64'),
        mimeType: f.mimeType,
      })),
    );

    // Insert the po_imports row at status='needs_review' if any line is
    // low-confidence, else 'parsed'. The review UI surfaces both.
    const lowConfidenceCount = extracted.lines.filter((l) => l.confidence < 0.85).length;
    const status: PoImportStatus =
      lowConfidenceCount > 0 ? 'needs_review' : 'parsed';

    const { data: imp, error: impErr } = await this.ctx.supabase
      .from('po_imports')
      .insert({
        organization_id: this.ctx.organizationId,
        uploaded_by: this.ctx.userId,
        source_type: 'scan',
        vendor_id: input.vendorId ?? null,
        warehouse_id: input.warehouseId ?? null,
        file_name: baseFileName,
        file_mime_type: baseFile.mimeType,
        file_size: totalSize,
        storage_path: storagePath,
        sha256,
        status,
        parsed_json: extracted,
        extraction_confidence: extracted.overallConfidence,
        extraction_model: SCAN_MODEL_NAME,
      })
      .select('id')
      .single();
    if (impErr || !imp) {
      // The DB row insert failed AFTER we already uploaded the scan
      // bytes to the po-imports bucket. Remove the orphaned file
      // best-effort so we don't accumulate storage cost over time.
      // Re-throw with the original error regardless of cleanup result.
      try {
        await admin.storage.from('po-imports').remove([storagePath]);
      } catch {
        // swallow — original DB error is the one the user needs to see.
      }
      throw new ServiceError(
        'internal_error',
        `Could not record the scan: ${impErr?.message ?? 'unknown'}`,
      );
    }
    const importId = imp.id as string;

    // Apply vendor-mapping resolution if a vendor was specified.
    const mappings: MappingRow[] = input.vendorId
      ? await new VendorItemMappingsService(this.ctx).listForVendor(input.vendorId)
      : [];

    const linesPayload = extracted.lines.map((l) => {
      const isInventory = l.lineType === 'inventory';
      let suggested_item_id: string | null = null;
      let match_status: PoImportMatchStatus = isInventory ? 'needs_review' : 'non_inventory';
      let exception_reason: string | null = isInventory
        ? 'No mapping for vendor item number'
        : null;

      if (isInventory && l.vendorSku) {
        const m = matchByVendorNumber(mappings, {
          vendorItemNumber: l.vendorSku,
          vendorProductNumber: null,
          auxiliaryNumber: null,
        });
        if (m) {
          // Advisory only — a vendor-number match is a SUGGESTION, never an
          // auto-link. item_id stays null until the user explicitly accepts
          // it (decision use_existing) in the review UI.
          suggested_item_id = m.itemId;
          match_status = 'suggested';
          exception_reason = null;
        }
      }

      return {
        po_import_id: importId,
        line_number: l.lineNumber,
        line_type: l.lineType,
        qty_ordered_original: l.quantity,
        uom_original: l.uom,
        description: l.description,
        unit_cost: l.unitPrice,
        line_total: l.lineTotal,
        vendor_item_number: l.vendorSku || null,
        item_id: null,
        suggested_item_id,
        match_status,
        match_confidence: null,
        extraction_confidence: l.confidence,
        exception_reason,
        parsed_json: l,
      };
    });

    if (linesPayload.length > 0) {
      const { error: linesErr } = await this.ctx.supabase
        .from('po_import_lines')
        .insert(linesPayload);
      if (linesErr) throw new ServiceError('internal_error', linesErr.message);
    }

    await audit(
      {
        event: 'po_import.uploaded',
        entityType: 'po_import',
        entityId: importId,
        after: {
          sourceType: 'scan',
          fileName: baseFileName,
          sha256,
          overallConfidence: extracted.overallConfidence,
          lineCount: extracted.lines.length,
          lowConfidenceLines: lowConfidenceCount,
        },
      },
      this.ctx,
    );

    return { id: importId, duplicateOf: null, lowConfidenceLines: lowConfidenceCount };
  }

  /**
   * Parses an uploaded import: downloads the file from Storage, runs the
   * parser, persists header fields + lines + initial line classifications +
   * SKU match attempts, transitions status to 'parsed' or 'needs_review'
   * (or 'failed').
   */
  async parseImport(id: string): Promise<void> {
    assertModuleEnabled(this.ctx, 'po_imports');
    assertPermission(this.ctx, 'purchase_orders:manage');

    const { data: header, error: hErr } = await this.ctx.supabase
      .from('po_imports')
      .select('id, source_type, storage_path, vendor_id')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .maybeSingle();
    if (hErr) throw new ServiceError('internal_error', hErr.message);
    if (!header) throw new ServiceError('not_found', 'PO import not found');

    await this.ctx.supabase
      .from('po_imports')
      .update({ status: 'parsing' })
      .eq('id', id);

    let canonical: CanonicalPo;
    let rawText: string | null = null;
    try {
      const { data: blob, error: dlErr } = await this.ctx.supabase.storage
        .from('po-imports')
        .download(header.storage_path as string);
      if (dlErr || !blob) {
        throw new Error(dlErr?.message ?? 'storage download failed');
      }
      const ab = await blob.arrayBuffer();
      const buffer = Buffer.from(ab);
      const sourceType: ParseSourceType =
        (header.source_type as string) === 'pdf' ? 'pdf' : 'csv';
      const parsed = await parsePoFile(buffer, sourceType);
      canonical = parsed;
      // Persist the raw extracted text so the UI can surface it for
      // debugging when the parser yields zero lines on a real-world PO.
      rawText = parsed.rawText ?? null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'parse error';
      await this.ctx.supabase
        .from('po_imports')
        .update({ status: 'failed', parse_error: msg })
        .eq('id', id);
      await audit(
        {
          event: 'po_import.failed',
          entityType: 'po_import',
          entityId: id,
          after: { reason: msg },
        },
        this.ctx,
      );
      return;
    }

    // Pull mappings to attempt SKU resolution for each inventory line.
    const vendorId = (header.vendor_id as string | null) ?? null;
    const mappings: MappingRow[] = vendorId
      ? await new VendorItemMappingsService(this.ctx).listForVendor(vendorId)
      : [];

    const linesPayload = canonical.lines.map((l) => {
      const isInventory = l.lineType === 'inventory';
      let suggested_item_id: string | null = null;
      let match_status: PoImportMatchStatus = isInventory ? 'needs_review' : 'non_inventory';
      let exception_reason: string | null = isInventory
        ? 'No mapping for vendor item number'
        : null;

      if (isInventory) {
        const m = matchByVendorNumber(mappings, {
          vendorItemNumber: l.vendorItemNumber,
          vendorProductNumber: l.vendorProductNumber,
          auxiliaryNumber: l.auxiliaryNumber,
        });
        if (m) {
          // Advisory only — a vendor-number match is a SUGGESTION, never an
          // auto-link. item_id stays null until the user explicitly accepts
          // it (decision use_existing) in the review UI.
          suggested_item_id = m.itemId;
          match_status = 'suggested';
          exception_reason = null;
        }
      }

      return {
        po_import_id: id,
        line_number: l.lineNumber,
        line_type: l.lineType,
        qty_ordered_original: l.qtyOrderedOriginal,
        uom_original: l.uomOriginal,
        description: l.description,
        unit_cost: l.unitCost,
        line_total: l.lineTotal,
        vendor_item_number: l.vendorItemNumber,
        vendor_product_number: l.vendorProductNumber,
        auxiliary_number: l.auxiliaryNumber,
        coa_code: l.coaCode,
        item_id: null,
        suggested_item_id,
        match_status,
        exception_reason,
        parsed_json: l,
      };
    });

    // Re-parse: wipe any prior lines first so we don't accumulate dupes
    // when the user hits Re-parse after a parser fix.
    const { error: delErr } = await this.ctx.supabase
      .from('po_import_lines')
      .delete()
      .eq('po_import_id', id);
    if (delErr) throw new ServiceError('internal_error', delErr.message);

    if (linesPayload.length > 0) {
      const { error: insErr } = await this.ctx.supabase
        .from('po_import_lines')
        .insert(linesPayload);
      if (insErr) throw new ServiceError('internal_error', insErr.message);
    }

    const hasOpenException = linesPayload.some((l) => l.match_status === 'needs_review');
    const newStatus: PoImportStatus = hasOpenException ? 'needs_review' : 'parsed';

    await this.ctx.supabase
      .from('po_imports')
      .update({
        status: newStatus,
        raw_text: rawText,
        parsed_json: canonical,
      })
      .eq('id', id);

    await audit(
      {
        event: 'po_import.parsed',
        entityType: 'po_import',
        entityId: id,
        after: { lineCount: linesPayload.length, status: newStatus },
      },
      this.ctx,
    );
  }

  /**
   * Approves a parsed import: creates a real purchase_orders row in
   * status='expected_inbound' and copies inventory lines into
   * purchase_order_items. Tax / freight / service / fee / discount lines are
   * persisted as FINANCIAL-ONLY purchase_order_charges (they appear on the PO
   * PDF and roll into total, but never become items and never touch stock).
   * Inventory stock is NOT touched.
   */
  async approve(input: ApprovePoImportInput): Promise<{ poId: string }> {
    assertModuleEnabled(this.ctx, 'po_imports');
    assertPermission(this.ctx, 'purchase_orders:manage');

    const { header, lines } = await this.get(input.poImportId);
    if (header.status !== 'parsed' && header.status !== 'needs_review') {
      throw new ServiceError(
        'conflict',
        `Cannot approve import in status '${header.status}'`,
      );
    }

    const overrideMap = new Map(input.lineOverrides.map((o) => [o.lineId, o]));
    const finalLines = lines
      .map((l) => {
        const o = overrideMap.get(l.id);
        return o
          ? {
              ...l,
              item_id: o.itemId !== undefined ? o.itemId : l.item_id,
              line_type: o.lineType ?? l.line_type,
              skip: o.skip === true,
            }
          : { ...l, skip: false };
      })
      .filter((l) => !l.skip);

    const inventoryLines = finalLines.filter(
      (l) => l.line_type === 'inventory' && l.item_id !== null,
    );
    const stillUnresolved = finalLines.find(
      (l) => l.line_type === 'inventory' && l.item_id === null,
    );
    if (stillUnresolved) {
      throw new ServiceError(
        'validation_error',
        `Line ${stillUnresolved.line_number} has no mapped item. Resolve in the exception queue or skip the line.`,
      );
    }

    const { data: nextNum } = await this.ctx.supabase.rpc('next_po_number', {
      p_org_id: this.ctx.organizationId,
    });
    const poNumber = (nextNum as string | null) ?? `PO-${Date.now()}`;

    const subtotal = inventoryLines.reduce(
      (sum, l) => sum + (l.line_total ?? 0),
      0,
    );

    // Non-inventory lines (tax / freight / White Glove service / e-waste fee /
    // discount / unmatched-but-priced) are FINANCIAL-ONLY: they belong on the PO
    // document and roll into its total, but they NEVER become items and NEVER
    // touch stock (owner requirement). Persisted as purchase_order_charges (a
    // table with no item_id and no FK to inventory_items → no path to a stock
    // movement). Everything in finalLines that is not inventory is a charge, so
    // nothing priced is dropped.
    const { chargeRows, chargeTotal } = buildPoCharges(finalLines, this.ctx.organizationId);

    // Receiving posts against a destination location. The user MUST have
    // chosen one at import review — there is deliberately no fallback (the
    // old auto-pick/auto-create path silently spawned junk locations).
    const destinationLocationId = await this.resolveDestinationLocation(
      input.warehouseId,
      input.locationId ?? null,
    );

    // Verify the chosen bill-to charter belongs to this org before tagging the
    // PO with it; a spoofed/cross-tenant id is silently dropped (never written).
    let billToCharterId: string | null = null;
    if (input.charterId) {
      const { data: charter } = await this.ctx.supabase
        .from('charters')
        .select('id')
        .eq('organization_id', this.ctx.organizationId)
        .eq('id', input.charterId)
        .maybeSingle();
      billToCharterId = (charter?.id as string | undefined) ?? null;
    }

    const { data: po, error: poErr } = await this.ctx.supabase
      .from('purchase_orders')
      .insert({
        organization_id: this.ctx.organizationId,
        po_number: poNumber,
        supplier_id: input.vendorId,
        destination_location_id: destinationLocationId,
        charter_id: billToCharterId,
        expected_at: input.expectedAt ?? null,
        notes: `Imported from PO file (po_import ${input.poImportId})`,
        subtotal,
        // Total is the TRUE invoice value: goods + every charge. subtotal stays
        // goods-only so the PDF can print Subtotal → charges → Total.
        total: subtotal + chargeTotal,
        status: 'expected_inbound',
        created_by: this.ctx.userId,
        updated_by: this.ctx.userId,
      })
      .select('id')
      .single();
    if (poErr) throw new ServiceError('internal_error', poErr.message);

    if (inventoryLines.length > 0) {
      const { error: lineErr } = await this.ctx.supabase
        .from('purchase_order_items')
        .insert(
          inventoryLines.map((l) => ({
            organization_id: this.ctx.organizationId,
            purchase_order_id: po.id as string,
            item_id: l.item_id!,
            quantity_ordered: l.qty_ordered_original ?? 1,
            quantity_received: 0,
            unit_cost: l.unit_cost ?? 0,
          })),
        );
      if (lineErr) throw new ServiceError('internal_error', lineErr.message);
    }

    // Persist the financial-only charges (tax/freight/service/fee/discount/other)
    // so they render on the PO PDF and reconcile with total. No stock, no items.
    if (chargeRows.length > 0) {
      const { error: chargeErr } = await this.ctx.supabase
        .from('purchase_order_charges')
        .insert(
          chargeRows.map((c) => ({ ...c, purchase_order_id: po.id as string })),
        );
      if (chargeErr) throw new ServiceError('internal_error', chargeErr.message);
    }

    // Stamp the items THIS import created (not pre-existing items the user
    // linked) with their origin PO, so cancelling the PO archives the unused
    // ones via the normal cleanup (archiveOrphanedCustomItems) — otherwise an
    // imported-then-cancelled PO would strand its auto-created items in stock.
    const { data: createdLines } = await this.ctx.supabase
      .from('po_import_lines')
      .select('item_id')
      .eq('po_import_id', input.poImportId)
      .eq('item_created', true)
      .not('item_id', 'is', null);
    const createdItemIds = ((createdLines ?? []) as Array<{ item_id: string | null }>)
      .map((r) => r.item_id)
      .filter((v): v is string => Boolean(v));
    if (createdItemIds.length > 0) {
      await this.ctx.supabase
        .from('inventory_items')
        .update({ created_from_purchase_order_id: po.id as string })
        .eq('organization_id', this.ctx.organizationId)
        .in('id', createdItemIds);
    }

    await this.ctx.supabase
      .from('po_imports')
      .update({
        status: 'approved',
        approved_at: new Date().toISOString(),
        approved_by: this.ctx.userId,
        approved_po_id: po.id as string,
      })
      .eq('id', input.poImportId);

    await audit(
      {
        event: 'po_import.approved',
        entityType: 'po_import',
        entityId: input.poImportId,
        after: {
          poId: po.id,
          lineCount: inventoryLines.length,
          chargeCount: chargeRows.length,
          chargeTotal,
          total: subtotal + chargeTotal,
          warehouseId: input.warehouseId,
        },
      },
      this.ctx,
    );

    return { poId: po.id as string };
  }

  /**
   * Validates the caller's chosen destination location and returns its id.
   * The location must exist, belong to this org AND the given warehouse, and
   * not be deleted. There is deliberately NO fallback: a missing or foreign
   * id throws instead of silently receiving into an auto-picked — or, worse,
   * auto-created — location. Approval requires an explicit location choice.
   */
  private async resolveDestinationLocation(
    warehouseId: string,
    preferredLocationId: string | null = null,
  ): Promise<string> {
    if (preferredLocationId) {
      const { data: chosen, error } = await this.ctx.supabase
        .from('locations')
        .select('id')
        .eq('organization_id', this.ctx.organizationId)
        .eq('id', preferredLocationId)
        .eq('warehouse_id', warehouseId)
        .is('deleted_at', null)
        .maybeSingle();
      if (error) throw new ServiceError('internal_error', error.message);
      if (chosen?.id) return chosen.id as string;
    }
    throw new ServiceError(
      'validation_error',
      'Pick a destination location for this warehouse.',
    );
  }

  async cancel(id: string): Promise<void> {
    assertModuleEnabled(this.ctx, 'po_imports');
    assertPermission(this.ctx, 'purchase_orders:manage');
    const { data: row, error } = await this.ctx.supabase
      .from('po_imports')
      .update({ status: 'canceled' })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .not('status', 'in', '(approved,canceled)')
      .select('id')
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    // Fail closed: a 0-row update means the import is gone or already
    // approved/canceled — don't audit a cancellation that didn't happen.
    if (!row) throw new ServiceError('conflict', 'Import not found or already finalized.');

    // Cancelling a not-yet-approved import: archive the items it auto-created
    // (during review) that were never used, so they don't linger in inventory.
    await this.archiveImportCreatedItems(id);

    await audit(
      {
        event: 'po_import.canceled',
        entityType: 'po_import',
        entityId: id,
      },
      this.ctx,
    );
  }

  /**
   * Archive catalog items THIS import auto-created (item_created lines) that are
   * still unused — active, zero on-hand, not referenced by any non-cancelled PO.
   * Used when an import is cancelled before approval (no PO exists to hang the
   * created_from marker on). Only touches items the import created, never
   * pre-existing items the user linked. Reversible (archive, not delete) and
   * best-effort — never fails the cancel.
   */
  private async archiveImportCreatedItems(importId: string): Promise<void> {
    try {
      const { data: lines } = await this.ctx.supabase
        .from('po_import_lines')
        .select('item_id')
        .eq('po_import_id', importId)
        .eq('item_created', true)
        .not('item_id', 'is', null);
      const ids = Array.from(
        new Set(
          ((lines ?? []) as Array<{ item_id: string | null }>)
            .map((l) => l.item_id)
            .filter((v): v is string => Boolean(v)),
        ),
      );
      if (ids.length === 0) return;

      const { data: candidates } = await this.ctx.supabase
        .from('inventory_items')
        .select('id, name')
        .eq('organization_id', this.ctx.organizationId)
        .in('id', ids)
        .eq('status', 'active')
        .eq('quantity_on_hand', 0)
        .is('deleted_at', null);
      const cand = (candidates ?? []) as Array<{ id: string; name: string }>;
      if (cand.length === 0) return;

      // Keep any item still referenced by a non-cancelled PO (it may yet receive
      // stock there). The just-cancelled import has no PO, so nothing to exclude
      // on that account.
      const { data: poLines } = await this.ctx.supabase
        .from('purchase_order_items')
        .select('item_id, po:purchase_orders!inner(status)')
        .eq('organization_id', this.ctx.organizationId) // defense-in-depth: keep the keep-check single-org
        .in('item_id', cand.map((c) => c.id));
      const keep = new Set<string>();
      for (const row of (poLines ?? []) as Array<Record<string, unknown>>) {
        const poField = row.po as { status?: string } | { status?: string }[] | null;
        const poStatus = Array.isArray(poField) ? poField[0]?.status : poField?.status;
        if (poStatus && poStatus !== 'cancelled') keep.add(row.item_id as string);
      }
      const toArchive = cand.filter((c) => !keep.has(c.id));
      if (toArchive.length === 0) return;

      const { data: flipped } = await this.ctx.supabase
        .from('inventory_items')
        .update({ status: 'archived' })
        .eq('organization_id', this.ctx.organizationId)
        .in('id', toArchive.map((c) => c.id))
        .eq('status', 'active') // race guard
        .select('id, name');
      for (const item of (flipped ?? []) as Array<{ id: string; name: string }>) {
        await audit(
          {
            event: 'inventory.item.archived',
            entityType: 'inventory_item',
            entityId: item.id,
            before: { status: 'active' },
            after: { status: 'archived' },
            extra: { reason: 'po_import_canceled', poImportId: importId, itemName: item.name },
          },
          this.ctx,
        );
      }
    } catch (e) {
      console.warn(
        '[po-import cancel] archive created items failed',
        e instanceof Error ? e.message : e,
      );
    }
  }
}
