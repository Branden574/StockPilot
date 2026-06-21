import 'server-only';

import ExcelJS from 'exceljs';
import { NextResponse } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { exportRateLimited } from '@/lib/export-rate-limit';
import { reportError } from '@/lib/error-reporter';
import { ServiceError } from '@/server/services/context';
import { ReportsService } from '@/server/services/reports';

import { hasPermission } from '@stockpilot/core';

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
 * Auth/permission gating mirrors the [slug]/csv dispatcher:
 *   - Must be authenticated (withApiContext).
 *   - Must hold reports:export permission.
 *   - Subject to the shared exportRateLimited guard.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  try {
    const ctx = await withApiContext(request);
    const limited = ctx && (await exportRateLimited(ctx.userId, ctx.organizationId));
    if (limited) return limited;
    if (!ctx) {
      return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    }
    if (!hasPermission(ctx.role, 'reports:export')) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }

    const itemId = url.searchParams.get('itemId');
    if (!itemId) {
      return NextResponse.json({ error: 'itemId is required' }, { status: 400 });
    }
    const since = url.searchParams.get('since') ?? undefined;
    const until = url.searchParams.get('until') ?? undefined;

    const svc = new ReportsService(ctx);
    const data = await svc.itemCostHistory(itemId, { since, until });

    // Flatten series into chronological rows, same order as CSV export.
    const rows = data.series
      .flatMap((s) =>
        s.points.map((p) => ({
          Supplier: s.supplierName,
          Date: p.date.slice(0, 10),
          Source: p.source === 'receipt' ? 'Receipt' : 'PO',
          'Unit cost': p.unitCost,
        })),
      )
      .sort((a, b) => (a.Date < b.Date ? -1 : a.Date > b.Date ? 1 : 0));

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
          // Defuse spreadsheet-formula injection on string cells.
          if (typeof v === 'string' && /^[=+\-@]/.test(v)) return `'${v}`;
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
    if (e instanceof ServiceError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: 500 });
    }
    void reportError(e, { tag: 'reports.item-cost-history.xlsx' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
