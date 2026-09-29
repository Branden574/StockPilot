import { NextResponse } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { csvFilename, toCsv } from '@/lib/csv';
import { exportRateLimited } from '@/lib/export-rate-limit';
import { reportExportErrorResponse, reportExportUnauthenticated } from '@/lib/reports/export-errors';
import { type ReportSlug } from '@/lib/reports/report-access';
import { assertPermission, ServiceError, type ServiceContext } from '@/server/services/context';
import { ReportsService } from '@/server/services/reports';

import { isUuid } from '@stockpilot/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RANGE_DEFAULT = 30;

function parseDays(raw: string | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return RANGE_DEFAULT;
  return Math.min(Math.max(Math.floor(n), 1), 365);
}

function csvResponse(slug: string, body: string, suffix?: string) {
  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${csvFilename(slug, suffix)}"`,
      'Cache-Control': 'no-store',
    },
  });
}

/** The reports this dispatcher serves as CSV. */
const CSV_REPORTS: ReadonlySet<string> = new Set<ReportSlug>([
  'inventory-valuation',
  'stock-movements',
  'reorder-forecast',
  'supplier-scorecard',
  'velocity-class',
  'dead-stock',
  'bundle-activity',
  'bundle-shortages',
  'shrinkage',
  'item-cost-history',
]);

/**
 * GET /api/reports/[slug]/csv
 *
 * In order, so a refused caller never spends the shared export budget (and
 * never trips the export-abuse alert): a session (401); reports:export with
 * the MFA step-up (403); a known report (404); reports:read and the modules
 * the report reads, from ReportsService.gate (403); the request itself (400);
 * then the shared export limit (429); then the data, whose service methods
 * check the same gate again. Every refusal keeps its real status: a
 * ServiceError is never answered 500 unless it is an internal error.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const url = new URL(request.url);
  let ctx: ServiceContext | null = null;
  try {
    ctx = await withApiContext(request);
    if (!ctx) return reportExportUnauthenticated();
    assertPermission(ctx, 'reports:export');
    if (!CSV_REPORTS.has(slug)) {
      return NextResponse.json({ error: 'not_found', message: 'Unknown report' }, { status: 404 });
    }
    const svc = new ReportsService(ctx);
    svc.gate(slug as ReportSlug);
    if (slug === 'item-cost-history') {
      const itemId = url.searchParams.get('itemId');
      if (!itemId) throw new ServiceError('validation_error', 'itemId is required');
      if (!isUuid(itemId)) throw new ServiceError('validation_error', 'Choose an item.');
    }
    const limited = await exportRateLimited(ctx.userId, ctx.organizationId);
    if (limited) return limited;

    if (slug === 'inventory-valuation') {
      const charterId = url.searchParams.get('charterId');
      const data = await svc.inventoryValuation({ charterId });
      const csv = toCsv(
        ['SKU', 'Name', 'Warehouse', 'Category', 'Qty on hand', 'Unit cost', 'Value'],
        data.rows.map((r) => ({
          SKU: r.sku,
          Name: r.name,
          Warehouse: r.warehouseName ?? '',
          Category: r.categoryName ?? '',
          'Qty on hand': r.quantityOnHand,
          'Unit cost': r.unitCost.toFixed(4),
          Value: r.value.toFixed(2),
        })),
      );
      return csvResponse(slug, csv, charterId ? 'charter' : undefined);
    }

    if (slug === 'stock-movements') {
      const days = parseDays(url.searchParams.get('days'));
      const data = await svc.movementSummary(days);
      // Two sections concatenated: by-type then top movers.
      const byType = toCsv(
        ['Movement type', 'Movements', 'Total units (gross)'],
        data.byType.map((t) => ({
          'Movement type': t.movementType,
          Movements: t.count,
          'Total units (gross)': t.totalQty,
        })),
      );
      const topMovers = toCsv(
        ['SKU', 'Name', 'Movements', 'Units in', 'Units out', 'Net change'],
        data.topMovers.map((r) => ({
          SKU: r.sku,
          Name: r.name,
          Movements: r.movementCount,
          'Units in': r.totalIn,
          'Units out': r.totalOut,
          'Net change': r.netChange,
        })),
      );
      const body =
        `# Stock movements - last ${days} days\n` +
        `# By type\n${byType}\n\n# Top movers\n${topMovers}\n`;
      return csvResponse(slug, body, `${days}d`);
    }

    if (slug === 'reorder-forecast') {
      const data = await svc.reorderForecast();
      const csv = toCsv(
        [
          'SKU',
          'Name',
          'Warehouse',
          'On hand',
          'Reorder at',
          'Reorder qty',
          'Deficit',
          'Unit cost',
          'Estimated cost',
        ],
        data.rows.map((r) => ({
          SKU: r.sku,
          Name: r.name,
          Warehouse: r.warehouseName ?? '',
          'On hand': r.quantityOnHand,
          'Reorder at': r.reorderPoint,
          'Reorder qty': r.reorderQuantity,
          Deficit: r.deficit,
          'Unit cost': r.unitCost.toFixed(4),
          'Estimated cost': r.estimatedReorderCost.toFixed(2),
        })),
      );
      return csvResponse(slug, csv);
    }

    if (slug === 'supplier-scorecard') {
      const days = parseDays(url.searchParams.get('days'));
      const data = await svc.supplierScorecard(days);
      const csv = toCsv(
        [
          'Supplier',
          'POs',
          'Open POs',
          'Open value',
          'Spend',
          'On-time rate',
          'Avg lead days',
          'Fill rate',
          'Last received',
        ],
        data.rows.map((r) => ({
          Supplier: r.supplierName,
          POs: r.totalPos,
          'Open POs': r.openPos,
          'Open value': r.openValue.toFixed(2),
          Spend: r.totalSpend.toFixed(2),
          'On-time rate':
            r.onTimeRate == null ? '' : (r.onTimeRate * 100).toFixed(1) + '%',
          'Avg lead days':
            r.avgLeadDays == null ? '' : r.avgLeadDays.toFixed(1),
          'Fill rate':
            r.fillRate == null ? '' : (r.fillRate * 100).toFixed(1) + '%',
          'Last received': r.lastReceivedAt ?? '',
        })),
      );
      return csvResponse(slug, csv, `${days}d`);
    }

    if (slug === 'velocity-class') {
      const days = parseDays(url.searchParams.get('days'));
      const data = await svc.velocityClass(days);
      const csv = toCsv(
        [
          'Class',
          'SKU',
          'Name',
          'Warehouse',
          'Category',
          'On hand',
          'Unit cost',
          'Units out',
          'Value out',
          'Last out',
        ],
        data.rows.map((r) => ({
          Class: r.velocityClass,
          SKU: r.sku,
          Name: r.name,
          Warehouse: r.warehouseName ?? '',
          Category: r.categoryName ?? '',
          'On hand': r.quantityOnHand,
          'Unit cost': r.unitCost.toFixed(4),
          'Units out': r.unitsOut,
          'Value out': r.valueOut.toFixed(2),
          'Last out': r.lastOutAt ?? '',
        })),
      );
      return csvResponse(slug, csv, `${days}d`);
    }

    if (slug === 'dead-stock') {
      const days = parseDays(url.searchParams.get('days'));
      const data = await svc.deadStock(days);
      const csv = toCsv(
        [
          'SKU',
          'Name',
          'Warehouse',
          'Category',
          'On hand',
          'Unit cost',
          'Carrying value',
          'Age (days)',
          'Stagnant (days)',
        ],
        data.rows.map((r) => ({
          SKU: r.sku,
          Name: r.name,
          Warehouse: r.warehouseName ?? '',
          Category: r.categoryName ?? '',
          'On hand': r.quantityOnHand,
          'Unit cost': r.unitCost.toFixed(4),
          'Carrying value': r.carryingValue.toFixed(2),
          'Age (days)': r.ageDays,
          'Stagnant (days)': `≥${r.stagnantDays}`,
        })),
      );
      return csvResponse(slug, csv, `${days}d`);
    }

    if (slug === 'bundle-activity') {
      const days = parseDays(url.searchParams.get('days'));
      const data = await svc.bundleActivity(days);
      const csv = toCsv(
        [
          'Bundle',
          'SKU',
          'Runs',
          'Kits out',
          'Component value out',
          'Top warehouse',
          'Last run',
        ],
        data.rows.map((r) => ({
          Bundle: r.bundleName,
          SKU: r.bundleSku ?? '',
          Runs: r.runs,
          'Kits out': r.kitsOut,
          'Component value out': r.componentValueOut.toFixed(2),
          'Top warehouse': r.topWarehouseName ?? '',
          'Last run': r.lastRunAt ?? '',
        })),
      );
      return csvResponse(slug, csv, `${days}d`);
    }

    if (slug === 'bundle-shortages') {
      const days = parseDays(url.searchParams.get('days'));
      const data = await svc.bundleShortages(days);
      const csv = toCsv(
        ['SKU', 'Item', 'Shortage events', 'Units short', 'Last short at'],
        data.rows.map((r) => ({
          SKU: r.itemSku,
          Item: r.itemName,
          'Shortage events': r.events,
          'Units short': r.unitsShort,
          'Last short at': r.lastShortAt ?? '',
        })),
      );
      return csvResponse(slug, csv, `${days}d`);
    }

    if (slug === 'shrinkage') {
      const days = parseDays(url.searchParams.get('days'));
      const data = await svc.shrinkage(days);
      const csv = toCsv(
        ['When', 'SKU', 'Item', 'Units', 'Unit cost', 'Cost impact', 'Reason', 'Notes'],
        data.rows.map((r) => ({
          When: r.createdAt,
          SKU: r.sku,
          Item: r.itemName,
          Units: r.quantityChange,
          'Unit cost': r.unitCost.toFixed(4),
          'Cost impact': r.costImpact.toFixed(2),
          Reason: r.reason ?? '',
          Notes: r.notes ?? '',
        })),
      );
      return csvResponse(slug, csv, `${days}d`);
    }

    if (slug === 'item-cost-history') {
      // Present and a uuid: checked above, before the export budget.
      const itemId = url.searchParams.get('itemId')!;
      const since = url.searchParams.get('since') ?? undefined;
      const until = url.searchParams.get('until') ?? undefined;
      // The report form: the gate, then the item read with the caller's
      // client (another warehouse's or category's item is not_found).
      const data = await svc.itemCostHistoryReport(itemId, { since, until });
      // Flatten per-supplier series into a flat chronological list.
      const rows = data.series
        .flatMap((s) =>
          s.points.map((p) => ({
            Supplier: s.supplierName,
            Date: p.date.slice(0, 10),
            Source: p.source === 'receipt' ? 'Receipt' : 'PO',
            'Unit cost': p.unitCost.toFixed(4),
          })),
        )
        .sort((a, b) => (a.Date < b.Date ? -1 : a.Date > b.Date ? 1 : 0));
      const csv = toCsv(['Supplier', 'Date', 'Source', 'Unit cost'], rows);
      return csvResponse(slug, csv);
    }

    return NextResponse.json({ error: 'not_found', message: 'Unknown report' }, { status: 404 });
  } catch (e) {
    return reportExportErrorResponse(e, 'reports.csv', ctx?.organizationId);
  }
}
