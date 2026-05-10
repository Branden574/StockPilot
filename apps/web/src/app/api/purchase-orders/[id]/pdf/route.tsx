import { NextResponse, type NextRequest } from 'next/server';
import { renderToStream } from '@react-pdf/renderer';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { PurchaseOrderPdf, type PoPdfLine } from '@/lib/pdf/po';
import { audit } from '@/server/services/audit';
import { ServiceError } from '@/server/services/context';
import { InventoryService } from '@/server/services/inventory';
import { LocationsService } from '@/server/services/locations';
import { PurchaseOrdersService } from '@/server/services/purchase-orders';
import { SuppliersService } from '@/server/services/suppliers';
import { WarehousesService } from '@/server/services/warehouses';

// @react-pdf/renderer needs Node APIs (Buffer, fs-style streams) — Edge runtime
// is a non-starter and dynamic = force-dynamic prevents Vercel from trying to
// pre-render the route at build time.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const ctx = await withApiContext();
    if (!ctx) {
      return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    }

    const poSvc = new PurchaseOrdersService(ctx);
    const inventorySvc = new InventoryService(ctx);
    const suppliersSvc = new SuppliersService(ctx);
    const locationsSvc = new LocationsService(ctx);
    const warehousesSvc = new WarehousesService(ctx);

    const { po, lines } = await poSvc.get(id);

    // Hydrate item names + SKUs only for the lines on this PO.
    const itemIds = lines
      .map((l) => l.item_id as string | null)
      .filter((v): v is string => Boolean(v));
    const referencedItems = await inventorySvc.byIds(itemIds);
    const itemsById = new Map(referencedItems.map((i) => [i.id, i]));

    const lineRows: PoPdfLine[] = lines.map((l) => {
      const item = itemsById.get(l.item_id as string);
      return {
        sku: item?.sku ?? '',
        name: item?.name ?? 'Unknown item',
        quantityOrdered: Number(l.quantity_ordered) || 0,
        unitCost: Number(l.unit_cost) || 0,
        lineTotal: Number(l.line_total) || 0,
      };
    });

    // Supplier info — list() is fine; orgs typically have a small
    // supplier set and the data is already cached in the dashboard.
    const supplierId = (po as { supplier_id?: string | null }).supplier_id ?? null;
    let supplier:
      | {
          name: string;
          contactName: string | null;
          email: string | null;
          phone: string | null;
          website: string | null;
        }
      | null = null;
    if (supplierId) {
      const all = await suppliersSvc.list();
      const found = all.find((s) => (s.id as string) === supplierId);
      if (found) {
        supplier = {
          name: (found.name as string) ?? '',
          contactName: (found.contact_name as string | null) ?? null,
          email: (found.email as string | null) ?? null,
          phone: (found.phone as string | null) ?? null,
          website: (found.website as string | null) ?? null,
        };
      }
    }

    // Destination location → warehouse name. Both lookups are tiny.
    const destLocId =
      (po as { destination_location_id?: string | null }).destination_location_id ?? null;
    let destination: { warehouseName: string | null; locationName: string | null } | null = null;
    if (destLocId) {
      const [locations, warehouses] = await Promise.all([
        locationsSvc.list(),
        warehousesSvc.list(),
      ]);
      const loc = locations.find((l) => (l.id as string) === destLocId);
      const whId = (loc as { warehouse_id?: string | null } | undefined)?.warehouse_id ?? null;
      const wh = whId ? warehouses.find((w) => w.id === whId) : null;
      destination = {
        warehouseName: wh?.name ?? null,
        locationName: (loc?.name as string | null) ?? null,
      };
    }

    // Org branding — name + logo + PO terms. Best-effort; if the row is
    // missing we still render with placeholders rather than blowing up.
    const { data: org } = await ctx.supabase
      .from('organizations')
      .select('name, logo_url, po_terms')
      .eq('id', ctx.organizationId)
      .maybeSingle();
    const orgName = ((org as { name?: string | null })?.name ?? 'StockPilot') || 'StockPilot';
    const orgLogoUrl = ((org as { logo_url?: string | null })?.logo_url ?? null) || null;
    const orgPoTerms = ((org as { po_terms?: string | null })?.po_terms ?? null) || null;

    const stream = await renderToStream(
      <PurchaseOrderPdf
        po={{
          poNumber: (po as { po_number?: string }).po_number ?? '',
          status: (po as { status?: string }).status ?? '',
          notes: ((po as { notes?: string | null }).notes ?? null) || null,
          expectedAt: ((po as { expected_at?: string | null }).expected_at ?? null) || null,
          createdAt: ((po as { created_at?: string | null }).created_at ?? null) || null,
          subtotal: Number((po as { subtotal?: number }).subtotal) || 0,
          total: Number((po as { total?: number }).total) || 0,
        }}
        lines={lineRows}
        org={{ name: orgName, logoUrl: orgLogoUrl, poTerms: orgPoTerms }}
        supplier={supplier}
        destination={destination}
      />,
    );

    void audit({
      event: 'pdf.exported',
      entityType: 'purchase_order',
      entityId: id,
      extra: { format: 'pdf' },
    });

    const filename = `po-${(po as { po_number?: string }).po_number ?? id}.pdf`;
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
    void reportError(e, { tag: 'pdf.purchase_order' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
