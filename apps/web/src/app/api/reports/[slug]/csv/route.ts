import { NextResponse } from 'next/server';

import { ServiceError } from '@/server/services/context';
import { ReportsService } from '@/server/services/reports';
import { csvFilename, toCsv } from '@/lib/csv';

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

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const url = new URL(request.url);
  try {
    const svc = await ReportsService.forCurrentUser();

    if (slug === 'inventory-valuation') {
      const data = await svc.inventoryValuation();
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
      return csvResponse(slug, csv);
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

    return NextResponse.json({ error: 'Unknown report' }, { status: 404 });
  } catch (e) {
    if (e instanceof ServiceError) {
      return NextResponse.json({ error: e.message }, { status: 500 });
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Internal error' },
      { status: 500 },
    );
  }
}
