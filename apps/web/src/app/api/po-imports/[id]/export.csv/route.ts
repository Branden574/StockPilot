import { NextResponse } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { csvFilename, toCsv } from '@/lib/csv';
import { exportRateLimited } from '@/lib/export-rate-limit';
import { reportError } from '@/lib/error-reporter';
import { ServiceError, serviceErrorStatus } from '@/server/services/context';
import { PoImportsService, type PoImportLineRow } from '@/server/services/po-imports';

import { can } from '@stockpilot/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Full recordkeeping export of a single PO import. Unlike inventory CREATION
// (which deliberately copies ONLY line_type='inventory' rows into the real PO),
// this is a paper/audit artifact and MUST include EVERY line — tax, freight,
// service, fee, discount, unknown — plus the header money totals. It is a
// distinct read path with NO line_type filter; the creation filters
// (actions/po-imports.ts + services/po-imports.ts approve()) are untouched.
const LINE_HEADERS = [
  'Line #',
  'Type',
  'Description',
  'Qty',
  'UoM',
  'Unit Cost',
  'Line Total',
  'Vendor #',
  'Product #',
  'Aux #',
  'COA',
] as const;

/** parsed_json is stored on po_imports but omitted from the typed PoImportRow
 *  (get() does select('*')). Two producers write it:
 *   - deterministic parser → CanonicalPo: poNumber, vendorName, poDate, totalAmount
 *   - AI scan → ExtractedPo: poNumber, vendorName, orderDate, subtotal, tax,
 *     freight, grandTotal
 *  Read every field defensively so one export path handles both shapes. */
interface ParsedJsonHeader {
  poNumber?: unknown;
  vendorName?: unknown;
  poDate?: unknown;
  orderDate?: unknown;
  totalAmount?: unknown;
  subtotal?: unknown;
  tax?: unknown;
  freight?: unknown;
  grandTotal?: unknown;
}

function asText(v: unknown): string {
  return typeof v === 'string' && v.trim().length > 0 ? v : '';
}
function asMoney(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function lineRow(l: PoImportLineRow): Record<string, string | number | null> {
  return {
    'Line #': l.line_number,
    Type: l.line_type,
    Description: l.description ?? '',
    Qty: l.qty_ordered_original ?? '',
    UoM: l.uom_original ?? '',
    'Unit Cost': l.unit_cost ?? '',
    'Line Total': l.line_total ?? '',
    'Vendor #': l.vendor_item_number ?? '',
    'Product #': l.vendor_product_number ?? '',
    'Aux #': l.auxiliary_number ?? '',
    COA: l.coa_code ?? '',
  };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await withApiContext(request);
    const limited = ctx && (await exportRateLimited(ctx.userId, ctx.organizationId));
    if (limited) return limited;
    if (!ctx) {
      return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    }
    // Gate on purchase_orders:MANAGE — the floor for the whole po_imports
    // surface (module registry, the imports list/detail pages, and every
    // PoImportsService read all require :manage; staff/viewer hold :read but
    // NOT :manage). Gating this export on :read would let those roles pull the
    // full PO-import financials via URL despite the UI hiding imports from them
    // (recurring bug #4 — service gate must match the surface's RLS/UI floor).
    // Org-scope is additionally enforced inside PoImportsService.get() via the
    // RLS-bound client + explicit organization_id filter (foreign id → 404).
    if (!can(ctx, 'purchase_orders:manage')) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }

    const { id } = await params;

    // get() returns ALL line types (no line_type filter) — exactly what a
    // recordkeeping export needs. It throws 'not_found' for an id outside the
    // caller's org, which we map to 404 below.
    const { header, lines } = await new PoImportsService(ctx).get(id);

    // Line-item block: every line, every type.
    let body = toCsv([...LINE_HEADERS], lines.map(lineRow));

    // Summary block from parsed_json. Blank line separates the two sections so
    // a spreadsheet import reads them as distinct tables.
    const parsed =
      (header as unknown as { parsed_json?: ParsedJsonHeader | null }).parsed_json ?? {};
    const summary: Array<{ Field: string; Value: string | number }> = [
      { Field: 'PO Number', Value: asText(parsed.poNumber) },
      { Field: 'Vendor', Value: asText(parsed.vendorName) },
      { Field: 'PO Date', Value: asText(parsed.poDate) || asText(parsed.orderDate) },
    ];
    // Money totals: emit whichever the producer recorded. Scan imports carry the
    // Subtotal/Tax/Freight/Grand Total breakdown; deterministic imports carry a
    // single Total Amount.
    const subtotal = asMoney(parsed.subtotal);
    const tax = asMoney(parsed.tax);
    const freight = asMoney(parsed.freight);
    const grandTotal = asMoney(parsed.grandTotal);
    const totalAmount = asMoney(parsed.totalAmount);
    if (subtotal !== undefined) summary.push({ Field: 'Subtotal', Value: subtotal.toFixed(2) });
    if (tax !== undefined) summary.push({ Field: 'Tax', Value: tax.toFixed(2) });
    if (freight !== undefined) summary.push({ Field: 'Freight', Value: freight.toFixed(2) });
    if (grandTotal !== undefined) {
      summary.push({ Field: 'Grand Total', Value: grandTotal.toFixed(2) });
    }
    if (totalAmount !== undefined) {
      summary.push({ Field: 'Total Amount', Value: totalAmount.toFixed(2) });
    }
    body += `\n\n${toCsv(['Field', 'Value'], summary)}`;

    // Filename: sanitize the uploaded file name (or fall back to the id) into a
    // safe suffix — csvFilename() only slugifies its first arg, not the suffix.
    const base = (header.file_name || header.id).replace(/\.[^.]+$/, '');
    const suffix =
      base
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || header.id.slice(0, 8);

    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${csvFilename('po-import', suffix)}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    if (e instanceof ServiceError) {
      // not_found → 404, module_disabled/forbidden → 403, etc.
      return NextResponse.json(
        { error: e.code, message: e.message },
        { status: serviceErrorStatus(e.code) },
      );
    }
    void reportError(e, { tag: 'po-imports.export-csv' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
