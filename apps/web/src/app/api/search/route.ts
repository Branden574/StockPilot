import { NextResponse } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { getWarehouseAccess } from '@/lib/auth/warehouse';
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

  const url = new URL(req.url);
  const raw = (url.searchParams.get('q') ?? '').trim();
  if (raw.length < 2) {
    return NextResponse.json({ items: [], purchaseOrders: [], suppliers: [] });
  }
  const q = raw.replace(/[%,()]/g, '');
  const like = `%${q}%`;

  const access = await getWarehouseAccess(ctx);

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
  if (!access.hasAllAccess && access.readableIds.length) {
    itemsQ.in('warehouse_id', access.readableIds);
  }

  // POs: po_number match.
  const poQ = ctx.supabase
    .from('purchase_orders')
    .select('id, po_number, status, supplier_id, warehouse_id')
    .eq('organization_id', ctx.organizationId)
    .ilike('po_number', like)
    .order('created_at', { ascending: false })
    .limit(5);
  if (!access.hasAllAccess && access.readableIds.length) {
    poQ.in('warehouse_id', access.readableIds);
  }

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

  const [items, pos, suppliers, warehouses] = await Promise.all([itemsQ, poQ, supQ, whQ]);

  // Batch-fetch primary thumbnails for the matched items (one
  // `item_images IN (...)` + one createSignedUrls call). Skipped when
  // there are zero matches so we don't emit no-op DB traffic.
  const itemRows = items.data ?? [];
  const imageMap =
    itemRows.length > 0
      ? await new ItemImagesService(ctx).primaryImagesForItems(
          itemRows.map((i) => i.id as string),
        )
      : new Map<string, string>();

  return NextResponse.json({
    items: itemRows.map((i) => ({
      id: i.id as string,
      name: i.name as string,
      sku: i.sku as string,
      quantity: i.quantity_on_hand as number,
      imageUrl: imageMap.get(i.id as string) ?? null,
    })),
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
