import { NextResponse, type NextRequest } from 'next/server';
import { Readable } from 'node:stream';
import { renderToStream } from '@react-pdf/renderer';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import {
  ReportTablePdf,
  type ReportSection,
  type ReportRow,
} from '@/lib/pdf/report-table';
import {
  formatCurrencyForPdf,
  formatDateForPdf,
  formatNumberForPdf,
} from '@/lib/pdf/styles';
import { audit } from '@/server/services/audit';
import { ServiceError } from '@/server/services/context';
import { ItemImagesService } from '@/server/services/item-images';
import { ReportsService } from '@/server/services/reports';

import { hasPermission } from '@stockpilot/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RANGE_DEFAULT = 30;

function parseDays(raw: string | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return RANGE_DEFAULT;
  return Math.min(Math.max(Math.floor(n), 1), 365);
}

/** Same filename convention as the CSV dispatcher: `{slug}-{stamp}-{suffix}.pdf`. */
function pdfFilename(slug: string, suffix?: string): string {
  const stamp = new Date().toISOString().slice(0, 10);
  const tail = suffix ? `-${suffix}` : '';
  return `${slug}-${stamp}${tail}.pdf`;
}

/**
 * Single dispatcher mirroring `app/api/reports/[slug]/csv/route.ts`. Each
 * slug builds a list of report sections (columns + rows + optional image
 * column) and the shared `ReportTablePdf` component renders them into a
 * paginated PDF.
 *
 * Per-item reports (inventory-valuation, reorder-forecast, dead-stock,
 * velocity-class, bundle-shortages, shrinkage, and the top-movers section
 * of stock-movements) request the image column AND collect itemIds — the
 * route then batches one signed-URL lookup via ItemImagesService so each
 * row gets its primary thumbnail next to the title.
 *
 * Aggregate reports (supplier-scorecard, bundle-activity, by-type section
 * of stock-movements) omit the image column entirely.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const url = new URL(request.url);

  try {
    const ctx = await withApiContext(request);
    if (!ctx) {
      return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    }
    if (!hasPermission(ctx.role, 'reports:export')) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }

    const reportsSvc = new ReportsService(ctx);
    const imagesSvc = new ItemImagesService(ctx);

    // Org name + logo for the branded header. Same lookup the
    // inventory-snapshot route does; org row is tiny so the extra query
    // is negligible.
    const { data: org } = await ctx.supabase
      .from('organizations')
      .select('name, logo_url')
      .eq('id', ctx.organizationId)
      .maybeSingle();
    const orgName = ((org as { name?: string | null })?.name ?? 'StockPilot') || 'StockPilot';
    const orgLogoUrl = ((org as { logo_url?: string | null })?.logo_url ?? null) || null;

    // ── Slug dispatch ───────────────────────────────────────────────
    let title = '';
    let subtitle = '';
    let footerNote: string | undefined;
    let sections: ReportSection[] = [];
    let suffix: string | undefined;
    let auditExtra: Record<string, unknown> = {};

    if (slug === 'inventory-valuation') {
      const data = await reportsSvc.inventoryValuation();
      title = 'Inventory valuation';
      subtitle = `as of ${formatDateForPdf(new Date())}`;
      const itemIds = data.rows.map((r) => r.itemId);
      const thumbs = await primaryThumbsByItemId(imagesSvc, itemIds);
      sections = [
        {
          imageColumn: true,
          columns: [
            { key: 'sku', label: 'SKU', width: 14 },
            { key: 'name', label: 'Name', width: 32 },
            { key: 'warehouse', label: 'Warehouse', width: 14 },
            { key: 'category', label: 'Category', width: 12 },
            { key: 'qty', label: 'On hand', align: 'right', width: 8 },
            { key: 'unit', label: 'Unit cost', align: 'right', width: 10 },
            { key: 'value', label: 'Value', align: 'right', width: 10 },
          ],
          rows: data.rows.map((r): ReportRow => ({
            imageUrl: thumbs.get(r.itemId) ?? null,
            cells: {
              sku: r.sku,
              name: r.name,
              warehouse: r.warehouseName ?? '',
              category: r.categoryName ?? '',
              qty: formatNumberForPdf(r.quantityOnHand),
              unit: formatCurrencyForPdf(r.unitCost),
              value: formatCurrencyForPdf(r.value),
            },
          })),
        },
      ];
      footerNote = `${formatNumberForPdf(data.itemCount)} items · ${formatNumberForPdf(data.totalUnits)} units · total value ${formatCurrencyForPdf(data.totalValue)}`;
      auditExtra = { item_count: data.itemCount, total_value: data.totalValue };
    } else if (slug === 'stock-movements') {
      const days = parseDays(url.searchParams.get('days'));
      const data = await reportsSvc.movementSummary(days);
      title = 'Stock movements';
      subtitle = `Last ${days} days`;
      suffix = `${days}d`;
      const itemIds = data.topMovers.map((r) => r.itemId);
      const thumbs = await primaryThumbsByItemId(imagesSvc, itemIds);
      sections = [
        {
          title: 'By movement type',
          columns: [
            { key: 'type', label: 'Movement type', width: 30 },
            { key: 'count', label: 'Movements', align: 'right', width: 12 },
            { key: 'total', label: 'Total units (gross)', align: 'right', width: 14 },
          ],
          rows: data.byType.map((t): ReportRow => ({
            cells: {
              type: t.movementType,
              count: formatNumberForPdf(t.count),
              total: formatNumberForPdf(t.totalQty),
            },
          })),
        },
        {
          title: 'Top movers',
          imageColumn: true,
          columns: [
            { key: 'sku', label: 'SKU', width: 14 },
            { key: 'name', label: 'Name', width: 30 },
            { key: 'movements', label: 'Movements', align: 'right', width: 10 },
            { key: 'in', label: 'Units in', align: 'right', width: 10 },
            { key: 'out', label: 'Units out', align: 'right', width: 10 },
            { key: 'net', label: 'Net change', align: 'right', width: 10 },
          ],
          rows: data.topMovers.map((r): ReportRow => ({
            imageUrl: thumbs.get(r.itemId) ?? null,
            cells: {
              sku: r.sku,
              name: r.name,
              movements: formatNumberForPdf(r.movementCount),
              in: formatNumberForPdf(r.totalIn),
              out: formatNumberForPdf(r.totalOut),
              net: formatNumberForPdf(r.netChange),
            },
          })),
        },
      ];
      auditExtra = { days, top_movers: data.topMovers.length };
    } else if (slug === 'reorder-forecast') {
      const data = await reportsSvc.reorderForecast();
      title = 'Reorder forecast';
      subtitle = `as of ${formatDateForPdf(new Date())}`;
      const itemIds = data.rows.map((r) => r.itemId);
      const thumbs = await primaryThumbsByItemId(imagesSvc, itemIds);
      sections = [
        {
          imageColumn: true,
          columns: [
            { key: 'sku', label: 'SKU', width: 14 },
            { key: 'name', label: 'Name', width: 28 },
            { key: 'warehouse', label: 'Warehouse', width: 14 },
            { key: 'qty', label: 'On hand', align: 'right', width: 8 },
            { key: 'reorder_at', label: 'Reorder at', align: 'right', width: 9 },
            { key: 'reorder_qty', label: 'Reorder qty', align: 'right', width: 9 },
            { key: 'deficit', label: 'Deficit', align: 'right', width: 8 },
            { key: 'unit', label: 'Unit cost', align: 'right', width: 9 },
            { key: 'est', label: 'Est. cost', align: 'right', width: 10 },
          ],
          rows: data.rows.map((r): ReportRow => ({
            imageUrl: thumbs.get(r.itemId) ?? null,
            cells: {
              sku: r.sku,
              name: r.name,
              warehouse: r.warehouseName ?? '',
              qty: formatNumberForPdf(r.quantityOnHand),
              reorder_at: formatNumberForPdf(r.reorderPoint),
              reorder_qty: formatNumberForPdf(r.reorderQuantity),
              deficit: formatNumberForPdf(r.deficit),
              unit: formatCurrencyForPdf(r.unitCost),
              est: formatCurrencyForPdf(r.estimatedReorderCost),
            },
          })),
        },
      ];
      footerNote = `${formatNumberForPdf(data.totalItems)} items need restock · total deficit ${formatNumberForPdf(data.totalDeficit)} units`;
      auditExtra = { item_count: data.totalItems, total_deficit: data.totalDeficit };
    } else if (slug === 'supplier-scorecard') {
      const days = parseDays(url.searchParams.get('days'));
      const data = await reportsSvc.supplierScorecard(days);
      title = 'Supplier scorecard';
      subtitle = `Last ${days} days`;
      suffix = `${days}d`;
      sections = [
        {
          columns: [
            { key: 'supplier', label: 'Supplier', width: 22 },
            { key: 'pos', label: 'POs', align: 'right', width: 6 },
            { key: 'open_pos', label: 'Open POs', align: 'right', width: 8 },
            { key: 'open_value', label: 'Open value', align: 'right', width: 11 },
            { key: 'spend', label: 'Spend', align: 'right', width: 11 },
            { key: 'on_time', label: 'On-time', align: 'right', width: 8 },
            { key: 'lead', label: 'Avg lead', align: 'right', width: 8 },
            { key: 'fill', label: 'Fill rate', align: 'right', width: 8 },
            { key: 'last', label: 'Last received', align: 'right', width: 12 },
          ],
          rows: data.rows.map((r): ReportRow => ({
            cells: {
              supplier: r.supplierName,
              pos: r.totalPos,
              open_pos: r.openPos,
              open_value: formatCurrencyForPdf(r.openValue),
              spend: formatCurrencyForPdf(r.totalSpend),
              on_time: r.onTimeRate == null ? '—' : `${(r.onTimeRate * 100).toFixed(1)}%`,
              lead: r.avgLeadDays == null ? '—' : `${r.avgLeadDays.toFixed(1)}d`,
              fill: r.fillRate == null ? '—' : `${(r.fillRate * 100).toFixed(1)}%`,
              last: r.lastReceivedAt
                ? formatDateForPdf(new Date(r.lastReceivedAt))
                : '—',
            },
          })),
        },
      ];
      auditExtra = { days, suppliers: data.rows.length };
    } else if (slug === 'velocity-class') {
      const days = parseDays(url.searchParams.get('days'));
      const data = await reportsSvc.velocityClass(days);
      title = 'Velocity class';
      subtitle = `Last ${days} days · A=${data.summary.A} B=${data.summary.B} C=${data.summary.C} D=${data.summary.D}`;
      suffix = `${days}d`;
      const itemIds = data.rows.map((r) => r.itemId);
      const thumbs = await primaryThumbsByItemId(imagesSvc, itemIds);
      sections = [
        {
          imageColumn: true,
          columns: [
            { key: 'class', label: 'Class', align: 'center', width: 6 },
            { key: 'sku', label: 'SKU', width: 12 },
            { key: 'name', label: 'Name', width: 26 },
            { key: 'warehouse', label: 'Warehouse', width: 12 },
            { key: 'category', label: 'Category', width: 12 },
            { key: 'qty', label: 'On hand', align: 'right', width: 8 },
            { key: 'unit', label: 'Unit cost', align: 'right', width: 9 },
            { key: 'units_out', label: 'Units out', align: 'right', width: 9 },
            { key: 'value_out', label: 'Value out', align: 'right', width: 10 },
            { key: 'last_out', label: 'Last out', align: 'right', width: 10 },
          ],
          rows: data.rows.map((r): ReportRow => ({
            imageUrl: thumbs.get(r.itemId) ?? null,
            cells: {
              class: r.velocityClass,
              sku: r.sku,
              name: r.name,
              warehouse: r.warehouseName ?? '',
              category: r.categoryName ?? '',
              qty: formatNumberForPdf(r.quantityOnHand),
              unit: formatCurrencyForPdf(r.unitCost),
              units_out: formatNumberForPdf(r.unitsOut),
              value_out: formatCurrencyForPdf(r.valueOut),
              last_out: r.lastOutAt ? formatDateForPdf(new Date(r.lastOutAt)) : '—',
            },
          })),
        },
      ];
      auditExtra = { days, items: data.rows.length };
    } else if (slug === 'dead-stock') {
      const days = parseDays(url.searchParams.get('days'));
      const data = await reportsSvc.deadStock(days);
      title = 'Dead stock';
      subtitle = `Stagnant ${days}+ days · total carrying ${formatCurrencyForPdf(data.totalCarryingValue)}`;
      suffix = `${days}d`;
      const itemIds = data.rows.map((r) => r.itemId);
      const thumbs = await primaryThumbsByItemId(imagesSvc, itemIds);
      sections = [
        {
          imageColumn: true,
          columns: [
            { key: 'sku', label: 'SKU', width: 14 },
            { key: 'name', label: 'Name', width: 26 },
            { key: 'warehouse', label: 'Warehouse', width: 12 },
            { key: 'category', label: 'Category', width: 12 },
            { key: 'qty', label: 'On hand', align: 'right', width: 8 },
            { key: 'unit', label: 'Unit cost', align: 'right', width: 9 },
            { key: 'carry', label: 'Carrying value', align: 'right', width: 11 },
            { key: 'age', label: 'Age (days)', align: 'right', width: 8 },
            { key: 'stagnant', label: 'Stagnant', align: 'right', width: 8 },
          ],
          rows: data.rows.map((r): ReportRow => ({
            imageUrl: thumbs.get(r.itemId) ?? null,
            cells: {
              sku: r.sku,
              name: r.name,
              warehouse: r.warehouseName ?? '',
              category: r.categoryName ?? '',
              qty: formatNumberForPdf(r.quantityOnHand),
              unit: formatCurrencyForPdf(r.unitCost),
              carry: formatCurrencyForPdf(r.carryingValue),
              age: formatNumberForPdf(r.ageDays),
              stagnant: `≥${r.stagnantDays}`,
            },
          })),
        },
      ];
      auditExtra = { days, items: data.rows.length, total_carrying: data.totalCarryingValue };
    } else if (slug === 'bundle-activity') {
      const days = parseDays(url.searchParams.get('days'));
      const data = await reportsSvc.bundleActivity(days);
      title = 'Bundle activity';
      subtitle = `Last ${days} days`;
      suffix = `${days}d`;
      sections = [
        {
          columns: [
            { key: 'bundle', label: 'Bundle', width: 28 },
            { key: 'sku', label: 'SKU', width: 14 },
            { key: 'runs', label: 'Runs', align: 'right', width: 8 },
            { key: 'kits', label: 'Kits out', align: 'right', width: 9 },
            { key: 'value', label: 'Component value out', align: 'right', width: 14 },
            { key: 'top', label: 'Top warehouse', width: 14 },
            { key: 'last', label: 'Last run', align: 'right', width: 12 },
          ],
          rows: data.rows.map((r): ReportRow => ({
            cells: {
              bundle: r.bundleName,
              sku: r.bundleSku ?? '—',
              runs: formatNumberForPdf(r.runs),
              kits: formatNumberForPdf(r.kitsOut),
              value: formatCurrencyForPdf(r.componentValueOut),
              top: r.topWarehouseName ?? '—',
              last: r.lastRunAt ? formatDateForPdf(new Date(r.lastRunAt)) : '—',
            },
          })),
        },
      ];
      auditExtra = { days, bundles: data.rows.length };
    } else if (slug === 'bundle-shortages') {
      const days = parseDays(url.searchParams.get('days'));
      const data = await reportsSvc.bundleShortages(days);
      title = 'Bundle shortages';
      subtitle = `Last ${days} days`;
      suffix = `${days}d`;
      const itemIds = data.rows.map((r) => r.itemId);
      const thumbs = await primaryThumbsByItemId(imagesSvc, itemIds);
      sections = [
        {
          imageColumn: true,
          columns: [
            { key: 'sku', label: 'SKU', width: 14 },
            { key: 'item', label: 'Item', width: 34 },
            { key: 'events', label: 'Shortage events', align: 'right', width: 14 },
            { key: 'short', label: 'Units short', align: 'right', width: 12 },
            { key: 'last', label: 'Last short at', align: 'right', width: 12 },
          ],
          rows: data.rows.map((r): ReportRow => ({
            imageUrl: thumbs.get(r.itemId) ?? null,
            cells: {
              sku: r.itemSku,
              item: r.itemName,
              events: formatNumberForPdf(r.events),
              short: formatNumberForPdf(r.unitsShort),
              last: r.lastShortAt ? formatDateForPdf(new Date(r.lastShortAt)) : '—',
            },
          })),
        },
      ];
      auditExtra = { days, items: data.rows.length };
    } else if (slug === 'shrinkage') {
      const days = parseDays(url.searchParams.get('days'));
      const data = await reportsSvc.shrinkage(days);
      title = 'Shrinkage';
      subtitle = `Last ${days} days · total units ${formatNumberForPdf(data.totalUnits)} · cost impact ${formatCurrencyForPdf(data.totalCost)}`;
      suffix = `${days}d`;
      const itemIds = data.rows.map((r) => r.itemId);
      const thumbs = await primaryThumbsByItemId(imagesSvc, itemIds);
      sections = [
        {
          imageColumn: true,
          columns: [
            { key: 'when', label: 'When', width: 12 },
            { key: 'sku', label: 'SKU', width: 12 },
            { key: 'item', label: 'Item', width: 24 },
            { key: 'units', label: 'Units', align: 'right', width: 7 },
            { key: 'unit', label: 'Unit cost', align: 'right', width: 9 },
            { key: 'cost', label: 'Cost impact', align: 'right', width: 11 },
            { key: 'reason', label: 'Reason', width: 12 },
            { key: 'notes', label: 'Notes', width: 16 },
          ],
          rows: data.rows.map((r): ReportRow => ({
            imageUrl: thumbs.get(r.itemId) ?? null,
            cells: {
              when: formatDateForPdf(new Date(r.createdAt)),
              sku: r.sku,
              item: r.itemName,
              units: formatNumberForPdf(r.quantityChange),
              unit: formatCurrencyForPdf(r.unitCost),
              cost: formatCurrencyForPdf(r.costImpact),
              reason: r.reason ?? '—',
              notes: r.notes ?? '—',
            },
          })),
        },
      ];
      auditExtra = { days, events: data.rows.length, total_cost: data.totalCost };
    } else {
      return NextResponse.json({ error: 'unknown_report' }, { status: 404 });
    }

    // ── Render ──────────────────────────────────────────────────────
    const stream = await renderToStream(
      // eslint-disable-next-line react-hooks/error-boundaries -- RSC + react-pdf renderToStream; rule targets client error boundaries which don't apply here
      <ReportTablePdf
        orgName={orgName}
        orgLogoUrl={orgLogoUrl}
        title={title}
        subtitle={subtitle}
        sections={sections}
        footerNote={footerNote}
      />,
    );

    // Await audit before streaming (same rationale as the inventory-
    // snapshot PDF: serverless functions wind down once the response
    // body is consumed, dropping any unawaited promise).
    await audit(
      {
        event: 'pdf.exported',
        entityType: 'report',
        entityId: null,
        extra: { format: 'pdf', slug, ...auditExtra },
      },
      ctx,
    );

    const filename = pdfFilename(slug, suffix);
    const webStream = Readable.toWeb(stream as Readable) as ReadableStream<Uint8Array>;
    return new NextResponse(webStream, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    if (e instanceof ServiceError) {
      const status = e.code === 'not_found' ? 404 : e.code === 'forbidden' ? 403 : 500;
      return NextResponse.json({ error: e.code, message: e.message }, { status });
    }
    void reportError(e, { tag: `reports.pdf.${slug}` });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}

/**
 * Hard cap on how many rows per section get inline thumbnails. Beyond
 * this, rows render the placeholder square. Keeps the PDF generation
 * bounded — react-pdf fetches each <Image src> over HTTP at render
 * time, and a 500-row report with thumbs would otherwise take 30+
 * seconds (and risk hitting the Vercel function timeout).
 *
 * 100 covers a normal page of "top items" reading; beyond it, the PDF
 * is for archival / spreadsheet-y consumption where row thumbs add
 * less value anyway.
 */
const PDF_IMAGE_ROW_CAP = 100;

/**
 * One signed-URL batch lookup that returns a Map<itemId, thumbUrl>.
 * Empty input → empty map.
 *
 * Important: we ONLY return entries for items that actually have a
 * pre-resized thumb_path (item_images.thumb_path, populated after
 * migration 0122). Items uploaded before 0122 — the bulk of any
 * legacy catalog — have no thumb and would otherwise fall back to
 * the 2048px master URL; react-pdf then tries to fetch + embed the
 * full image, which adds hundreds of MB to the render and hangs the
 * route on long reports. Better to render a clean placeholder than
 * to risk a stuck PDF.
 */
async function primaryThumbsByItemId(
  imagesSvc: ItemImagesService,
  itemIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = Array.from(new Set(itemIds.filter((v): v is string => Boolean(v))));
  if (unique.length === 0) return out;
  // Respect the row cap. Take the FIRST N unique ids so the order
  // matches the report's row order — items at the top of the report
  // are the ones the reader is most likely focused on.
  const capped = unique.slice(0, PDF_IMAGE_ROW_CAP);
  const byId = await imagesSvc.primaryImagesWithThumbsForItems(capped);
  for (const [itemId, img] of byId) {
    if (img.thumbUrl) out.set(itemId, img.thumbUrl);
  }
  return out;
}
