import 'server-only';

import ExcelJS from 'exceljs';
import { NextResponse } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { escapeForSpreadsheet } from '@/lib/csv';
import { exportRateLimited } from '@/lib/export-rate-limit';
import { reportExportErrorResponse, reportExportUnauthenticated } from '@/lib/reports/export-errors';
import { costHistoryRows } from '@/lib/reports/row-order';
import { assertPermission, ServiceError, type ServiceContext } from '@/server/services/context';
import { ReportsService } from '@/server/services/reports';

import { isUuid } from '@stockpilot/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/reports/item-cost-history/xlsx
 *
 * Query params:
 *   itemId  — required: the inventory item to report on.
 *   since   — optional ISO date string (YYYY-MM-DD); filters to ordered_at/received_at ≥ since.
 *   until   — optional ISO date string (YYYY-MM-DD); filters to ordered_at/received_at ≤ until.
 *
 * Auth/permission gating mirrors the [slug]/csv dispatcher, in the same
 * order: a session (401), reports:export with the MFA step-up (403),
 * reports:read and the purchase orders module (403), a valid itemId (400),
 * the shared export limit (429), then an item the caller can read (404).
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  let ctx: ServiceContext | null = null;
  try {
    // In order, so a refused caller never spends the shared export budget:
    // a session (401); reports:export with the MFA step-up (403);
    // reports:read and the purchase orders module (403); the item id (400);
    // then the export limit (429); then the item, read with the caller's
    // client (another warehouse's or category's item is 404).
    ctx = await withApiContext(request);
    if (!ctx) return reportExportUnauthenticated();
    assertPermission(ctx, 'reports:export');
    const svc = new ReportsService(ctx);
    svc.gate('item-cost-history');

    const itemId = url.searchParams.get('itemId');
    if (!itemId) throw new ServiceError('validation_error', 'itemId is required');
    if (!isUuid(itemId)) throw new ServiceError('validation_error', 'Choose an item.');
    const since = url.searchParams.get('since') ?? undefined;
    const until = url.searchParams.get('until') ?? undefined;

    const limited = await exportRateLimited(ctx.userId, ctx.organizationId);
    if (limited) return limited;

    const data = await svc.itemCostHistoryReport(itemId, { since, until });

    // Chronological rows in the page's order (costHistoryRows), as the CSV
    // and PDF. This used to sort by the calendar day alone, so two prices on
    // one day could come out in the other order.
    const rows = costHistoryRows(data.series).map((p) => ({
      Supplier: p.supplier,
      Date: p.date.slice(0, 10),
      Source: p.source === 'receipt' ? 'Receipt' : 'PO',
      'Unit cost': p.unitCost,
    }));

    const headers = ['Supplier', 'Date', 'Source', 'Unit cost'] as const;

    const wb = new ExcelJS.Workbook();
    wb.creator = 'StockPilot';
    const ws = wb.addWorksheet('Cost history');

    ws.columns = headers.map((h) => ({
      header: h,
      key: h,
      width: Math.min(Math.max(h.length + 2, 12), 44),
    }));

    for (const r of rows) {
      ws.addRow(
        headers.map((h) => {
          const v = r[h];
          // Defuse spreadsheet-formula injection on string cells through the
          // SHARED guard (lib/csv.ts) that toCsv() and toInventoryXlsx() use.
          // This route used to hand-roll `/^[=+\-@]/`, which misses the TAB
          // and CARRIAGE-RETURN lead-ins Excel also treats as a formula
          // start — one exporter with a weaker guard than every other.
          // Numbers stay numbers: only string cells go through the guard, so
          // 'Unit cost' is still a numeric cell in the sheet.
          if (typeof v === 'string') return escapeForSpreadsheet(v);
          return v ?? '';
        }),
      );
    }

    // Bold + freeze header row for readability on large exports.
    const head = ws.getRow(1);
    head.font = { bold: true };
    head.alignment = { vertical: 'middle' };
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    const buf = await wb.xlsx.writeBuffer();
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `item-cost-history-${stamp}.xlsx`;

    return new NextResponse(new Uint8Array(buf as ArrayBuffer), {
      status: 200,
      headers: {
        'Content-Type':
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    return reportExportErrorResponse(e, 'reports.item-cost-history.xlsx', ctx?.organizationId);
  }
}
