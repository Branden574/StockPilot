import { NextResponse, type NextRequest } from 'next/server';
import { renderToStream } from '@react-pdf/renderer';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import {
  InventorySnapshotPdf,
  type SnapshotPdfRow,
  type SnapshotPdfWarehouseGroup,
} from '@/lib/pdf/inventory-snapshot';
import { audit } from '@/server/services/audit';
import { ServiceError } from '@/server/services/context';
import { ReportsService } from '@/server/services/reports';

import { hasPermission } from '@stockpilot/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest) {
  try {
    const ctx = await withApiContext();
    if (!ctx) {
      return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    }
    if (!hasPermission(ctx.role, 'reports:export')) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }

    // ReportsService.inventoryValuation() already returns rows enriched
    // with warehouseName + categoryName + value, plus warehouse-access
    // scoping via RLS — exactly the shape we need for the snapshot PDF.
    const reportsSvc = new ReportsService(ctx);
    const data = await reportsSvc.inventoryValuation();

    const groupsByWarehouse = new Map<string, SnapshotPdfRow[]>();
    for (const r of data.rows) {
      const key = r.warehouseName ?? 'Unassigned';
      const list = groupsByWarehouse.get(key) ?? [];
      list.push({
        sku: r.sku,
        name: r.name,
        categoryName: r.categoryName,
        location: null,
        quantityOnHand: r.quantityOnHand,
        unitCost: r.unitCost,
        value: r.value,
      });
      groupsByWarehouse.set(key, list);
    }

    const groups: SnapshotPdfWarehouseGroup[] = [...groupsByWarehouse.entries()]
      .map(([warehouseName, rows]) => {
        const subtotalUnits = rows.reduce((s, r) => s + r.quantityOnHand, 0);
        const subtotalValue = rows.reduce((s, r) => s + r.value, 0);
        // Highest-value rows first inside each warehouse so the page is
        // self-explanatory if it gets truncated/printed partially.
        const sorted = [...rows].sort((a, b) => b.value - a.value);
        return { warehouseName, rows: sorted, subtotalUnits, subtotalValue };
      })
      .sort((a, b) => b.subtotalValue - a.subtotalValue);

    const { data: org } = await ctx.supabase
      .from('organizations')
      .select('name, logo_url')
      .eq('id', ctx.organizationId)
      .maybeSingle();
    const orgName = ((org as { name?: string | null })?.name ?? 'StockPilot') || 'StockPilot';
    const orgLogoUrl = ((org as { logo_url?: string | null })?.logo_url ?? null) || null;

    const asOf = new Date().toISOString();
    const stream = await renderToStream(
      <InventorySnapshotPdf
        org={{ name: orgName, logoUrl: orgLogoUrl }}
        groups={groups}
        totals={{
          units: data.totalUnits,
          value: data.totalValue,
          itemCount: data.itemCount,
        }}
        asOf={asOf}
      />,
    );

    void audit(
      {
        event: 'pdf.exported',
        entityType: 'inventory_snapshot',
        entityId: null,
        extra: {
          format: 'pdf',
          item_count: data.itemCount,
          total_value: data.totalValue,
        },
      },
      ctx,
    );

    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `inventory-snapshot-${stamp}.pdf`;
    return new NextResponse(stream as unknown as ReadableStream<Uint8Array>, {
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
    void reportError(e, { tag: 'pdf.inventory_snapshot' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
