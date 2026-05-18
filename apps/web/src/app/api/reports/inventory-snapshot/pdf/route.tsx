import { NextResponse, type NextRequest } from 'next/server';
import { Readable } from 'node:stream';
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

export async function GET(req: NextRequest) {
  try {
    const ctx = await withApiContext(req);
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

    // Hydrate a location label per item. `bin_location` is the
    // human-readable label set by the rack picker on items; when blank
    // we fall back to the `primary_location_id` -> location.name join.
    // RLS already scopes both tables, so we can batch in a single
    // round-trip per table.
    const itemIds = data.rows.map((r) => r.itemId).filter((v): v is string => Boolean(v));
    const itemLocationMap = new Map<string, string | null>();
    if (itemIds.length > 0) {
      const { data: itemRows } = await ctx.supabase
        .from('inventory_items')
        .select('id, bin_location, primary_location_id')
        .in('id', itemIds);
      const rawItems = (itemRows ?? []) as Array<{
        id: string;
        bin_location: string | null;
        primary_location_id: string | null;
      }>;
      const primaryLocIds = rawItems
        .map((r) => r.primary_location_id)
        .filter((v): v is string => Boolean(v));
      const locNameById = new Map<string, string>();
      if (primaryLocIds.length > 0) {
        const { data: locs } = await ctx.supabase
          .from('locations')
          .select('id, name')
          .in('id', primaryLocIds);
        for (const l of (locs ?? []) as Array<{ id: string; name: string }>) {
          locNameById.set(l.id, l.name);
        }
      }
      for (const r of rawItems) {
        const bin = r.bin_location?.trim() ?? '';
        if (bin) {
          itemLocationMap.set(r.id, bin);
        } else if (r.primary_location_id) {
          itemLocationMap.set(r.id, locNameById.get(r.primary_location_id) ?? null);
        } else {
          itemLocationMap.set(r.id, null);
        }
      }
    }

    const groupsByWarehouse = new Map<string, SnapshotPdfRow[]>();
    for (const r of data.rows) {
      const key = r.warehouseName ?? 'Unassigned';
      const list = groupsByWarehouse.get(key) ?? [];
      list.push({
        sku: r.sku,
        name: r.name,
        categoryName: r.categoryName,
        location: itemLocationMap.get(r.itemId) ?? null,
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

    // Capture a single "now" so the asOf shown in the PDF body matches
    // the date stamped on the filename. Two separate `new Date()` calls
    // could span a midnight boundary and confuse end-users diffing
    // reports.
    const now = new Date();
    const asOf = now.toISOString();
    const stream = await renderToStream(
      // eslint-disable-next-line react-hooks/error-boundaries -- RSC + react-pdf renderToStream; rule targets client error boundaries which don't apply here
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

    // Await before streaming — see PO PDF route for the rationale: on
    // Vercel the function can wind down as soon as the body is consumed,
    // dropping any unawaited audit promise.
    await audit(
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

    const stamp = asOf.slice(0, 10);
    const filename = `inventory-snapshot-${stamp}.pdf`;
    // `renderToStream` is typed as NodeJS.ReadableStream; at runtime it's
    // a Node `stream.Readable` which is what `Readable.toWeb` accepts.
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
    void reportError(e, { tag: 'pdf.inventory_snapshot' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
