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
  assertPermission,
  ServiceError,
  withContext,
  type ServiceContext,
} from './context';
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
    assertPermission(this.ctx, 'purchase_orders:manage');

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
    await audit({
      event: 'po_import.uploaded',
      entityType: 'po_import',
      entityId: data.id as string,
      after: { fileName: input.fileName, sha256: input.sha256 },
    });
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
      let item_id: string | null = null;
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
          item_id = m.itemId;
          match_status = 'mapped';
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
        item_id,
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

    await audit({
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
    });

    return { id: importId, duplicateOf: null, lowConfidenceLines: lowConfidenceCount };
  }

  /**
   * Parses an uploaded import: downloads the file from Storage, runs the
   * parser, persists header fields + lines + initial line classifications +
   * SKU match attempts, transitions status to 'parsed' or 'needs_review'
   * (or 'failed').
   */
  async parseImport(id: string): Promise<void> {
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
      await audit({
        event: 'po_import.failed',
        entityType: 'po_import',
        entityId: id,
        after: { reason: msg },
      });
      return;
    }

    // Pull mappings to attempt SKU resolution for each inventory line.
    const vendorId = (header.vendor_id as string | null) ?? null;
    const mappings: MappingRow[] = vendorId
      ? await new VendorItemMappingsService(this.ctx).listForVendor(vendorId)
      : [];

    const linesPayload = canonical.lines.map((l) => {
      const isInventory = l.lineType === 'inventory';
      let item_id: string | null = null;
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
          item_id = m.itemId;
          match_status = 'mapped';
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
        item_id,
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

    await audit({
      event: 'po_import.parsed',
      entityType: 'po_import',
      entityId: id,
      after: { lineCount: linesPayload.length, status: newStatus },
    });
  }

  /**
   * Approves a parsed import: creates a real purchase_orders row in
   * status='expected_inbound' and copies inventory lines into
   * purchase_order_items. Tax / freight / service / non_inventory lines are
   * skipped. Inventory stock is NOT touched.
   */
  async approve(input: ApprovePoImportInput): Promise<{ poId: string }> {
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

    // Receiving posts against a destination location, but the import flow
    // only knows the destination warehouse. Find any existing location in
    // that warehouse; if none exists, auto-create one named after the
    // warehouse so the receive button shows up immediately on the new PO.
    const destinationLocationId = await this.resolveDestinationLocation(
      input.warehouseId,
    );

    const { data: po, error: poErr } = await this.ctx.supabase
      .from('purchase_orders')
      .insert({
        organization_id: this.ctx.organizationId,
        po_number: poNumber,
        supplier_id: input.vendorId,
        destination_location_id: destinationLocationId,
        notes: `Imported from PO file (po_import ${input.poImportId})`,
        subtotal,
        total: subtotal,
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

    await this.ctx.supabase
      .from('po_imports')
      .update({
        status: 'approved',
        approved_at: new Date().toISOString(),
        approved_by: this.ctx.userId,
        approved_po_id: po.id as string,
      })
      .eq('id', input.poImportId);

    await audit({
      event: 'po_import.approved',
      entityType: 'po_import',
      entityId: input.poImportId,
      after: {
        poId: po.id,
        lineCount: inventoryLines.length,
        warehouseId: input.warehouseId,
      },
    });

    return { poId: po.id as string };
  }

  /**
   * Returns a usable destination_location_id for the given warehouse.
   * Tries to find an existing location belonging to that warehouse;
   * if none, creates one named after the warehouse so receiving works
   * out of the box on imported POs.
   */
  private async resolveDestinationLocation(warehouseId: string): Promise<string | null> {
    const { data: existing, error: findErr } = await this.ctx.supabase
      .from('locations')
      .select('id')
      .eq('organization_id', this.ctx.organizationId)
      .eq('warehouse_id', warehouseId)
      .is('deleted_at', null)
      .limit(1)
      .maybeSingle();
    if (findErr) throw new ServiceError('internal_error', findErr.message);
    if (existing?.id) return existing.id as string;

    const { data: warehouse, error: whErr } = await this.ctx.supabase
      .from('warehouses')
      .select('name')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', warehouseId)
      .maybeSingle();
    if (whErr) throw new ServiceError('internal_error', whErr.message);
    if (!warehouse) return null;

    const { data: created, error: insErr } = await this.ctx.supabase
      .from('locations')
      .insert({
        organization_id: this.ctx.organizationId,
        warehouse_id: warehouseId,
        name: warehouse.name as string,
        type: 'warehouse',
      })
      .select('id')
      .single();
    if (insErr) throw new ServiceError('internal_error', insErr.message);
    return created.id as string;
  }

  async cancel(id: string): Promise<void> {
    assertPermission(this.ctx, 'purchase_orders:manage');
    const { error } = await this.ctx.supabase
      .from('po_imports')
      .update({ status: 'canceled' })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .not('status', 'in', '(approved,canceled)');
    if (error) throw new ServiceError('internal_error', error.message);
    await audit({
      event: 'po_import.canceled',
      entityType: 'po_import',
      entityId: id,
    });
  }
}
