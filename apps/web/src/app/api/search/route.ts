import { NextResponse } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { getWarehouseAccess } from '@/lib/auth/warehouse';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Lightweight cross-entity search for the command palette. Caps results at
 * 5 per group so the dropdown stays readable. Warehouse-scoped users only
 * see items/POs in warehouses they can read; managers+ see everything in
 * the org. Suppliers are org-scoped.
 */
export async function GET(req: Request) {
  const ctx = await withApiContext();
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
  const itemsQ = ctx.supabase
    .from('inventory_items')
    .select('id, name, sku, quantity_on_hand, warehouse_id')
    .eq('organization_id', ctx.organizationId)
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

  const [items, pos, suppliers] = await Promise.all([itemsQ, poQ, supQ]);

  return NextResponse.json({
    items: (items.data ?? []).map((i) => ({
      id: i.id as string,
      name: i.name as string,
      sku: i.sku as string,
      quantity: i.quantity_on_hand as number,
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
  });
}
