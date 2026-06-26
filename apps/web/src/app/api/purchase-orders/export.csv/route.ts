import { NextResponse } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { exportRateLimited } from '@/lib/export-rate-limit';
import { csvFilename, toCsv } from '@/lib/csv';
import { PurchaseOrdersService } from '@/server/services/purchase-orders';
import { SuppliersService } from '@/server/services/suppliers';

import { can } from '@stockpilot/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Mirror of the list page's tab → status-set mapping so the Export button
// exports exactly the tab the user is viewing. Kept here (not imported from the
// page) to avoid coupling the route to the page's render module.
const TAB_STATUSES: Record<string, string[]> = {
  draft: ['draft'],
  ordered: ['ordered'],
  in_transit: ['expected_inbound', 'partially_received'],
  received: ['received'],
  cancelled: ['cancelled'],
};

const HEADERS = [
  'po_number',
  'supplier',
  'status',
  'placed_at',
  'expected_at',
  'lines',
  'total',
  'created_at',
] as const;

type PoRow = {
  id: string;
  po_number: string;
  status: string;
  supplier_id: string | null;
  expected_at: string | null;
  ordered_at: string | null;
  total: number;
  created_at: string;
  line_count: number;
};

export async function GET(request: Request) {
  try {
    const ctx = await withApiContext(request);
    const limited = ctx && (await exportRateLimited(ctx.userId, ctx.organizationId));
    if (limited) return limited;
    if (!ctx) {
      return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    }
    // Same read gate the service enforces on the detail path. Org-scope +
    // warehouse-scope are additionally enforced inside the service.
    if (!can(ctx, 'purchase_orders:read')) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }

    const params = new URL(request.url).searchParams;
    const tab = params.get('status') ?? 'all';
    const q = (params.get('q') ?? '').trim().toLowerCase();
    // The active warehouse view-filter is passed from the page as a query param.
    // We must NOT call getActiveWarehouseFilter() here: it resolves the session
    // via requireOrgContext(), which throws NEXT_REDIRECT in /api/** routes
    // (those headers aren't set) — turning a valid export into a 500. The
    // service still RLS-scopes to the user's readable warehouses regardless.
    const warehouseFilter = params.get('warehouse') || undefined;
    const poSvc = new PurchaseOrdersService(ctx);
    const supplierSvc = new SuppliersService(ctx);

    const [rawPos, suppliers] = await Promise.all([
      poSvc.list({ warehouseId: warehouseFilter }),
      supplierSvc.list(),
    ]);
    const pos = rawPos as unknown as PoRow[];
    const supplierMap = new Map(suppliers.map((s) => [s.id as string, s.name as string]));
    const supplierName = (id: string | null) => (id ? (supplierMap.get(id) ?? '') : '');

    const statuses = tab in TAB_STATUSES ? TAB_STATUSES[tab] : null;
    const filtered = pos.filter((p) => {
      if (statuses && !statuses.includes(p.status)) return false;
      if (!q) return true;
      return (
        p.po_number.toLowerCase().includes(q) ||
        supplierName(p.supplier_id).toLowerCase().includes(q)
      );
    });

    const rows = filtered.map((p) => ({
      po_number: p.po_number,
      supplier: supplierName(p.supplier_id),
      status: p.status,
      placed_at: p.status === 'draft' ? '' : (p.ordered_at ?? p.created_at),
      expected_at: p.expected_at ?? '',
      lines: p.line_count,
      total: p.total,
      created_at: p.created_at,
    }));

    const csv = toCsv([...HEADERS], rows);
    return new NextResponse(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${csvFilename('purchase-orders', tab === 'all' ? undefined : tab)}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    console.error('[api/purchase-orders/export.csv] failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'export_failed' }, { status: 500 });
  }
}
