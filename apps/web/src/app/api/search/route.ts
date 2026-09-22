import { NextResponse } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { getWarehouseAccess } from '@/lib/auth/warehouse';
import { checkRateLimit } from '@/lib/rate-limit';
import { ItemImagesService } from '@/server/services/item-images';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Lightweight cross-entity search for the command palette. Caps results at
 * 5 per group so the dropdown stays readable. Warehouse-scoped users only
 * see items/POs in warehouses they can read; managers+ see everything in
 * the org. Suppliers are org-scoped.
 */
export async function GET(req: Request) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  // Per-user rate limit before the 4-table ilike fan-out (open mode: an authed
  // convenience endpoint shouldn't hard-fail on a limiter blip).
  const rl = await checkRateLimit(`search:${ctx.userId}`, 120, 60_000);
  if (!rl.allowed) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  const url = new URL(req.url);
  const raw = (url.searchParams.get('q') ?? '').trim();
  if (raw.length < 2) {
    return NextResponse.json({ items: [], purchaseOrders: [], suppliers: [] });
  }
  const q = raw.replace(/[%,()]/g, '');
  const like = `%${q}%`;

  const access = await getWarehouseAccess(ctx);
  // A warehouse-scoped member who can read NO warehouse sees no items and no
  // purchase orders. Row level security would return nothing anyway; the
  // app's own filter says so too instead of dropping the filter (which is
  // what `readableIds.length` being falsy used to do here). Same stance as
  // PurchaseOrdersService.
  const noWarehouses = !access.hasAllAccess && access.readableIds.length === 0;

  // Items: name OR sku OR barcode match.
  // Rentals are a separate inventory class — global search is for
  // sellable/regular items. Rental items are findable via the
  // /dashboard/rentals/items catalog.
  const itemsQ = ctx.supabase
    .from('inventory_items')
    .select('id, name, sku, quantity_on_hand, warehouse_id')
    .eq('organization_id', ctx.organizationId)
    .eq('is_rental', false)
    .or(`name.ilike.${like},sku.ilike.${like},barcode.ilike.${like}`)
    .order('updated_at', { ascending: false })
    .limit(5);
  if (!access.hasAllAccess) {
    itemsQ.in('warehouse_id', access.readableIds);
  }

  // POs: po_number match. A purchase order has NO warehouse column: it
  // reaches a warehouse through its destination location, the same embed
  // PurchaseOrdersService filters on. Until 2026-09-22 this selected
  // `purchase_orders.warehouse_id`, which does not exist, so Postgres
  // refused every PO search and the palette showed no purchase orders at
  // all (since 2026-05). The inner join is only needed to scope a
  // warehouse-limited member.
  // Two literal selects, not one built with a condition: the client is typed
  // from the schema, and a conditional select string defeats that parser (it
  // is also what would have caught the missing column at compile time).
  const poQ = access.hasAllAccess
    ? ctx.supabase
        .from('purchase_orders')
        .select('id, po_number, status')
        .eq('organization_id', ctx.organizationId)
        .ilike('po_number', like)
        .order('created_at', { ascending: false })
        .limit(5)
    : ctx.supabase
        .from('purchase_orders')
        .select('id, po_number, status, destination:locations!destination_location_id!inner (warehouse_id)')
        .eq('organization_id', ctx.organizationId)
        .in('destination.warehouse_id', access.readableIds)
        .ilike('po_number', like)
        .order('created_at', { ascending: false })
        .limit(5);

  // Suppliers: name match.
  const supQ = ctx.supabase
    .from('suppliers')
    .select('id, name')
    .eq('organization_id', ctx.organizationId)
    .ilike('name', like)
    .order('name', { ascending: true })
    .limit(5);

  // Warehouses: name match. RLS gives the user the warehouses they can read,
  // so no extra access filter needed here.
  const whQ = ctx.supabase
    .from('warehouses')
    .select('id, name')
    .eq('organization_id', ctx.organizationId)
    .neq('status', 'archived')
    .ilike('name', like)
    .order('name', { ascending: true })
    .limit(5);

  const none = { data: [], error: null };
  const [items, pos, suppliers, warehouses] = await Promise.all([
    noWarehouses ? none : itemsQ,
    noWarehouses ? none : poQ,
    supQ,
    whQ,
  ]);
  // A group that fails comes back empty, as before, but no longer SILENTLY:
  // that silence is how the PO query stayed broken for four months. A short
  // label only (the SQLSTATE), never the message, which can quote the query.
  for (const [group, res] of [
    ['items', items],
    ['purchaseOrders', pos],
    ['suppliers', suppliers],
    ['warehouses', warehouses],
  ] as const) {
    if (res.error) {
      console.warn(`[search] ${group} query failed: ${(res.error as { code?: string }).code || 'unknown'}`);
    }
  }

  // Batch-fetch primary thumbnails for the matched items (one
  // `item_images IN (...)` + one createSignedUrls call). Skipped when
  // there are zero matches so we don't emit no-op DB traffic.
  const itemRows = items.data ?? [];
  // Thumb for the ⌘K row tile + master for the hover preview.
  const imageMap =
    itemRows.length > 0
      ? await new ItemImagesService(ctx).primaryImagesWithThumbsForItems(
          itemRows.map((i) => i.id as string),
        )
      : new Map<string, { url: string; thumbUrl: string | null; lqip: string | null }>();

  return NextResponse.json({
    items: itemRows.map((i) => {
      const img = imageMap.get(i.id as string);
      return {
        id: i.id as string,
        name: i.name as string,
        sku: i.sku as string,
        quantity: i.quantity_on_hand as number,
        imageUrl: img ? (img.thumbUrl ?? img.url) : null,
        previewUrl: img ? img.url : null,
      };
    }),
    purchaseOrders: (pos.data ?? []).map((p) => ({
      id: p.id as string,
      poNumber: p.po_number as string,
      status: p.status as string,
    })),
    suppliers: (suppliers.data ?? []).map((s) => ({
      id: s.id as string,
      name: s.name as string,
    })),
    warehouses: (warehouses.data ?? []).map((w) => ({
      id: w.id as string,
      name: w.name as string,
    })),
  });
}
