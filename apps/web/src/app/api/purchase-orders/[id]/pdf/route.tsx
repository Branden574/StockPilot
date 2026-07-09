import { NextResponse, type NextRequest } from 'next/server';
import { Readable } from 'node:stream';
import { renderToStream } from '@react-pdf/renderer';

import { can } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { humanizeChargeType } from '@/lib/po-imports/charges';
import { exportRateLimited } from '@/lib/export-rate-limit';
import { reportError } from '@/lib/error-reporter';
import {
  PurchaseOrderPdf,
  type PoPdfBillToCharter,
  type PoPdfCharge,
  type PoPdfLine,
  type PoPdfReceipt,
} from '@/lib/pdf/po';
import { audit } from '@/server/services/audit';
import { ServiceError } from '@/server/services/context';
import { InventoryService } from '@/server/services/inventory';
import { LocationsService } from '@/server/services/locations';
import { PurchaseOrdersService } from '@/server/services/purchase-orders';
import { ReceivingService } from '@/server/services/receiving';
import { SuppliersService } from '@/server/services/suppliers';
import { WarehousesService } from '@/server/services/warehouses';

// @react-pdf/renderer needs Node APIs (Buffer, fs-style streams) — Edge runtime
// is a non-starter and dynamic = force-dynamic prevents Vercel from trying to
// pre-render the route at build time.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    // Pass `req` so bearer-token (mobile) callers authenticate the same way
    // as cookie sessions — /api/* bypasses middleware so this is the only
    // place auth is resolved.
    const ctx = await withApiContext(req);
    const limited = ctx && (await exportRateLimited(ctx.userId, ctx.organizationId));
    if (limited) return limited;
    if (!ctx) {
      return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    }
    // Route-level permission gate — defense in depth on top of the
    // service-layer check in `PurchaseOrdersService.get()`. We don't want
    // a permission regression here to let unauthorized users stream a
    // signed PO out of the org.
    if (!can(ctx, 'purchase_orders:read')) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }

    const poSvc = new PurchaseOrdersService(ctx);
    const inventorySvc = new InventoryService(ctx);
    const suppliersSvc = new SuppliersService(ctx);
    const locationsSvc = new LocationsService(ctx);
    const warehousesSvc = new WarehousesService(ctx);

    const { po, lines } = await poSvc.get(id);

    // Hydrate item names + SKUs only for the lines on this PO. includeDeleted:
    // a since-deleted item must still print its name on this historical PO.
    const itemIds = lines
      .map((l) => l.item_id as string | null)
      .filter((v): v is string => Boolean(v));
    const referencedItems = await inventorySvc.byIds(itemIds, { includeDeleted: true });
    const itemsById = new Map(referencedItems.map((i) => [i.id, i]));

    const lineRows: PoPdfLine[] = lines.map((l) => {
      const item = itemsById.get(l.item_id as string);
      return {
        sku: item?.sku ?? '',
        name: item?.name ?? 'Unknown item',
        quantityOrdered: Number(l.quantity_ordered) || 0,
        quantityReceived: Number(l.quantity_received) || 0,
        unitCost: Number(l.unit_cost) || 0,
        lineTotal: Number(l.line_total) || 0,
      };
    });

    // Financial-only charges (tax/freight/service/fee/discount) → line rows on
    // the PDF. Org-scoped via RLS; ordered as captured. Best-effort: a missing
    // table or error just renders the PO without charge lines.
    let chargeRows: PoPdfCharge[] = [];
    try {
      const { data: chargeData } = await ctx.supabase
        .from('purchase_order_charges')
        .select('label, charge_type, quantity, unit_cost, amount, sort_order')
        .eq('organization_id', ctx.organizationId) // defense-in-depth: match the PO header/line queries, don't lean on RLS alone
        .eq('purchase_order_id', id)
        .order('sort_order', { ascending: true });
      chargeRows = ((chargeData ?? []) as Array<Record<string, unknown>>).map((c) => ({
        label:
          ((c.label as string | null) ?? '').trim() ||
          humanizeChargeType((c.charge_type as string | null) ?? 'other'),
        quantity: c.quantity != null ? Number(c.quantity) : null,
        unitCost: c.unit_cost != null ? Number(c.unit_cost) : null,
        amount: Number(c.amount) || 0,
      }));
    } catch {
      chargeRows = [];
    }

    // Receiving history → receipts table on the PDF. Best-effort: if the
    // receiving module is disabled (or the lookup errors) we still render the
    // PO without a receipts section rather than failing the whole export.
    let receiptRows: PoPdfReceipt[] = [];
    try {
      const receivingSvc = new ReceivingService(ctx);
      const { receipts, lines: receiptLines } = await receivingSvc.listForPurchaseOrder(id);
      const totalsByReceipt = new Map<string, { accepted: number; rejected: number }>();
      for (const rl of receiptLines) {
        const t = totalsByReceipt.get(rl.receipt_id) ?? { accepted: 0, rejected: 0 };
        t.accepted += Number(rl.qty_accepted_base) || 0;
        t.rejected += Number(rl.qty_rejected_base) || 0;
        totalsByReceipt.set(rl.receipt_id, t);
      }
      // Oldest-first reads naturally as a chronological receiving log
      // (the service returns newest-first).
      receiptRows = [...receipts]
        .reverse()
        .map((r) => {
          const t = totalsByReceipt.get(r.id) ?? { accepted: 0, rejected: 0 };
          return {
            receiptNumber: r.receipt_number,
            receivedAt: r.received_at ?? null,
            receivedByName: r.received_by_name ?? null,
            status: r.status,
            totalAccepted: t.accepted,
            totalRejected: t.rejected,
          };
        });
    } catch {
      receiptRows = [];
    }

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

    // Bill-to charter → "Bill to" block. Org-scoped fetch by the PO's
    // charter_id; a since-archived charter still prints on this historical PO.
    // Best-effort: a missing/errored charter just omits the block.
    const billToCharterId = (po as { charter_id?: string | null }).charter_id ?? null;
    let billToCharter: PoPdfBillToCharter | null = null;
    if (billToCharterId) {
      const { data: charter } = await ctx.supabase
        .from('charters')
        .select('name, code, address, contact_name, contact_email, contact_phone')
        .eq('organization_id', ctx.organizationId)
        .eq('id', billToCharterId)
        .maybeSingle();
      if (charter) {
        const addr = (charter as { address?: Record<string, string> | null }).address ?? null;
        // Compose mailing lines from the structured jsonb, dropping blanks.
        // "City, Region PostalCode" on one line; street + country on their own.
        const regionZip = [(addr?.region ?? '').trim(), (addr?.postalCode ?? '').trim()]
          .filter(Boolean)
          .join(' ');
        const cityRegionZip = [(addr?.city ?? '').trim(), regionZip].filter(Boolean).join(', ');
        const addressLines = [
          (addr?.line1 ?? '').trim(),
          (addr?.line2 ?? '').trim(),
          cityRegionZip,
          (addr?.country ?? '').trim(),
        ].filter(Boolean);
        billToCharter = {
          name: ((charter as { name?: string | null }).name ?? '') || '',
          code: ((charter as { code?: string | null }).code ?? null) || null,
          addressLines,
          contactName: ((charter as { contact_name?: string | null }).contact_name ?? null) || null,
          contactEmail: ((charter as { contact_email?: string | null }).contact_email ?? null) || null,
          contactPhone: ((charter as { contact_phone?: string | null }).contact_phone ?? null) || null,
        };
      }
    }

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
        charges={chargeRows}
        org={{ name: orgName, logoUrl: orgLogoUrl, poTerms: orgPoTerms }}
        supplier={supplier}
        destination={destination}
        receipts={receiptRows}
        billToCharter={billToCharter}
      />,
    );

    // Await the audit log BEFORE returning the streamed response. On Vercel
    // serverless, the function execution can complete the moment the
    // Response body is consumed by the platform, killing any unawaited
    // promises (`void audit(...)`) before they hit the audit_log insert.
    await audit(
      {
        event: 'pdf.exported',
        entityType: 'purchase_order',
        entityId: id,
        extra: { format: 'pdf' },
      },
      ctx,
    );

    const filename = `po-${(po as { po_number?: string }).po_number ?? id}.pdf`;
    // `renderToStream` is typed as the structural NodeJS.ReadableStream;
    // at runtime it's a `stream.Readable` from node:stream, which is
    // what `Readable.toWeb` accepts. The cast here just bridges the
    // structural type to the concrete one — no shape change.
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
    void reportError(e, { tag: 'pdf.purchase_order' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
