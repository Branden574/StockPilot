import { Readable } from 'node:stream';

import { NextResponse, type NextRequest } from 'next/server';
import { renderToStream } from '@react-pdf/renderer';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { exportRateLimited } from '@/lib/export-rate-limit';
import { getActiveWarehouseFilterFor } from '@/lib/warehouse-filter';
import {
  buildInventoryExportSourceRows,
  type InventoryExportFilters,
} from '@/lib/inventory-export';
import { toInventoryXlsx } from '@/lib/inventory-export-xlsx';
import { toInventoryCsv } from '@/lib/exports/export-csv';
import {
  attachExportImages,
  fetchExportImageBytes,
  EXPORT_TOO_MANY_IMAGES_MESSAGE,
  type EmbeddedImage,
} from '@/lib/exports/export-images';
import { buildExportFilename } from '@/lib/exports/filename';
import {
  exportItemTypeKind,
  inventoryExportRequestSchema,
  resolveExportFields,
} from '@/lib/exports/export-request';
import { computeExportPdfLayout } from '@/lib/exports/pdf-layout';
import { buildExportPdfRows, InventoryExportPdf } from '@/lib/pdf/inventory-export-pdf';
import { ServiceError } from '@/server/services/context';
import type { ItemListSort } from '@/server/services/inventory';

import { can, type Permission } from '@stockpilot/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Large-org CSV/Excel/PDF export can take a while. (api/inventory is not under a
// vercel.json functions glob, so set the budget inline.)
export const maxDuration = 60;

/**
 * Unified inventory export: any scope (selected / filtered / all) x any format
 * (csv / xlsx / pdf) x any field selection. POST (not GET) so a large "export
 * selected" id list isn't capped by URL length, and so the nested options
 * object has somewhere to live.
 *
 * The client's field list is a REQUEST, never an instruction: resolveExportFields
 * re-derives the authoritative list from the registry on this side of the wire.
 */
export async function POST(request: NextRequest) {
  try {
    const ctx = await withApiContext(request);
    if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    if (!can(ctx, 'items:export')) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    // Compute-heavy (up to 10k rows -> in-memory xlsx/pdf render). Cap like
    // every other export route so one account can't sustain a serverless-cost
    // DoS; this also emits the security.export_rate_limited audit event.
    const limited = await exportRateLimited(ctx.userId, ctx.organizationId);
    if (limited) return limited;

    const json = await request.json().catch(() => null);
    const parsed = inventoryExportRequestSchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation_error', message: parsed.error.issues[0]?.message ?? 'Invalid request' },
        { status: 400 },
      );
    }
    const { format, scope, itemType, ids, options: rawOptions } = parsed.data;
    if (scope === 'selected' && (!ids || ids.length === 0)) {
      return NextResponse.json(
        { error: 'validation_error', message: 'Select at least one item to export.' },
        { status: 400 },
      );
    }

    // DEVIATION from the brief (recorded in the Task 13 report): the two
    // pre-Phase-D export triggers (inventory-table.tsx's ExportMenu,
    // bulk-actions.tsx) send neither `fields` nor `options` — exactly the
    // "pre-builder request shape" export-request.test.ts pins as staying
    // valid (Task 17 is what rewires them onto the builder). When that bare
    // request falls back to the Books registry default field list — which
    // leads with the image field (Brief section 8) — it collides with the
    // schema's own imageMode default of 'embedded': resolveExportFields
    // correctly rejects "CSV cannot embed images" (Brief section 15), but the
    // caller never asked for an embedded image; only the DEFAULT field list
    // did. Left as the brief's route.tsx wrote it verbatim, this 400s the
    // existing "Export CSV" button for every books export with no changes on
    // the caller's part — a real regression the plan's own constraint ("every
    // earlier task leaves the product working exactly as it does today")
    // forbids. CSV never embeds bytes regardless of imageMode (the image
    // field's value() always returns a plain URL string — see
    // field-registry.ts), so coercing only in this narrow no-explicit-fields
    // case is behavior-neutral for CSV output and leaves every EXPLICIT
    // request (the future Phase D dialog always sends `fields`) hitting the
    // real rejection, unchanged.
    const options =
      format === 'csv' && !parsed.data.fields
        ? { ...rawOptions, imageMode: 'url' as const }
        : rawOptions;

    const resolved = resolveExportFields({
      fields: parsed.data.fields,
      itemType,
      format,
      options,
      can: (permission: Permission) => can(ctx, permission),
    });
    if (!resolved.ok) {
      return NextResponse.json(
        { error: resolved.status === 403 ? 'forbidden' : 'validation_error', message: resolved.message },
        { status: resolved.status },
      );
    }
    const { fields, imagesRequested } = resolved;
    const itemTypeKind = exportItemTypeKind(itemType);

    // For scope=filtered, honor the active-warehouse cookie just like the
    // legacy route (the UI passes the rest of the visible filters).
    const filters: InventoryExportFilters | undefined =
      scope === 'filtered'
        ? {
            q: parsed.data.filters?.q,
            status: parsed.data.filters?.status,
            stock: parsed.data.filters?.stock ?? null,
            expected: parsed.data.filters?.expected,
            sort: parsed.data.filters?.sort as ItemListSort | undefined,
            categoryIds: parsed.data.filters?.categoryIds,
            locationIds: parsed.data.filters?.locationIds,
            charterIds: parsed.data.filters?.charterIds,
            warehouseId: await getActiveWarehouseFilterFor(ctx),
          }
        : undefined;

    const result = await buildInventoryExportSourceRows(ctx, { scope, itemType, ids, filters });

    // Image resolution is opt-in and happens exactly once, for the whole set.
    if (imagesRequested) {
      await attachExportImages(ctx, result.rows, { imageSize: options.imageSize });
    }

    const filename = buildExportFilename({
      slug: result.slug,
      scope,
      format,
      presetName: options.presetName ?? null,
      count: result.rows.length,
    });
    const truncatedNote = result.truncated
      ? `# truncated at 10000 rows of ${result.total}`
      : undefined;

    // -- CSV ----------------------------------------------------------------
    if (format === 'csv') {
      const body = toInventoryCsv({ fields, rows: result.rows, itemTypeKind, truncatedNote });
      return new NextResponse(body, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Cache-Control': 'no-store',
        },
      });
    }

    // -- Excel (.xlsx) ------------------------------------------------------
    if (format === 'xlsx') {
      let images: Map<string, EmbeddedImage> | undefined;
      let imageTruncated = false;
      if (imagesRequested && (options.imageMode === 'embedded' || options.imageMode === 'both')) {
        const urls = new Map<string, string>();
        for (const row of result.rows) {
          if (row.image) urls.set(row.id, row.image.thumbnailUrl);
        }
        const fetched = await fetchExportImageBytes(urls);
        images = fetched.images;
        imageTruncated = fetched.truncated;
      }
      const buf = await toInventoryXlsx({
        fields,
        rows: result.rows,
        itemTypeKind,
        freezeHeader: options.xlsx.freezeHeader,
        autoFilter: options.xlsx.autoFilter,
        includeSummarySheet: options.xlsx.includeSummarySheet,
        imageMode: imagesRequested ? options.imageMode : null,
        imageSize: options.imageSize,
        images,
        truncatedNote: imageTruncated
          ? `${truncatedNote ? `${truncatedNote} ` : ''}${EXPORT_TOO_MANY_IMAGES_MESSAGE}`
          : truncatedNote,
      });
      return new NextResponse(new Uint8Array(buf), {
        status: 200,
        headers: {
          'Content-Type':
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Cache-Control': 'no-store',
        },
      });
    }

    // -- PDF ----------------------------------------------------------------
    const { data: org } = await ctx.supabase
      .from('organizations')
      .select('name, logo_url')
      .eq('id', ctx.organizationId)
      .maybeSingle();
    const orgName = ((org as { name?: string | null })?.name ?? 'StockPilot') || 'StockPilot';
    const orgLogoUrl = ((org as { logo_url?: string | null })?.logo_url ?? null) || null;

    const layout = computeExportPdfLayout({
      fields,
      itemTypeKind,
      includeImages: imagesRequested && options.includeImages,
      imageSize: options.imageSize,
      orientation: options.pdf.orientation,
      paperSize: options.pdf.paperSize,
      density: options.pdf.density,
      wrapText: options.pdf.wrapText,
      layout: options.pdf.layout,
      catalogColumns: options.pdf.catalogColumns,
    });
    const showImages = layout.imageColumnWidthPt > 0 || options.pdf.layout === 'catalog';
    const pdfRows = buildExportPdfRows(result.rows, layout, fields, {
      showImages: showImages && imagesRequested,
    });

    const titleNoun = result.slug === 'books' ? 'Books' : 'Inventory';
    const stream = await renderToStream(
      // eslint-disable-next-line react-hooks/error-boundaries -- RSC + react-pdf renderToStream; rule targets client error boundaries
      <InventoryExportPdf
        orgName={orgName}
        orgLogoUrl={orgLogoUrl}
        title={`${titleNoun} export`}
        subtitle={`${scope} · ${result.rows.length} item${result.rows.length === 1 ? '' : 's'}${result.truncated ? ` (first 10000 of ${result.total})` : ''}`}
        layout={layout}
        rows={pdfRows}
        repeatHeaders={options.pdf.repeatHeaders}
        pageNumbers={options.pdf.pageNumbers}
        catalog={
          options.pdf.layout === 'catalog'
            ? { columns: options.pdf.catalogColumns, fields, itemTypeKind }
            : null
        }
        footerNote={truncatedNote}
      />,
    );
    const webStream = Readable.toWeb(stream as Readable) as ReadableStream<Uint8Array>;
    return new NextResponse(webStream, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    if (e instanceof ServiceError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: 500 });
    }
    void reportError(e, { tag: 'inventory.export' });
    // Surface the actual message (not just an opaque "internal_error") so a
    // failed export is diagnosable from the toast instead of silently generic.
    return NextResponse.json(
      { error: 'internal_error', message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
