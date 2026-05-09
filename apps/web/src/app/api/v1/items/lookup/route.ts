import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Mobile scanner uses this to resolve a scanned code to an inventory_item.
 * Tries barcode + sku in one OR. Returns 404 when nothing matches so the
 * client can branch into the "not in inventory yet → add via ISBN" flow.
 *
 * Query: ?code=<barcode_or_sku>
 */
export async function GET(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  const url = new URL(req.url);
  const code = (url.searchParams.get('code') ?? '').trim();
  if (!code) {
    return NextResponse.json({ error: 'code is required' }, { status: 400 });
  }

  const safe = code.replace(/[%,()]/g, '');
  const { data, error } = await ctx.supabase
    .from('inventory_items')
    .select(
      `id, sku, name, barcode, quantity_on_hand, unit_cost, retail_price,
       reorder_point, warehouse_id, primary_location_id, item_type,
       category_id, supplier_id`,
    )
    .eq('organization_id', ctx.organizationId)
    .is('deleted_at', null)
    .or(`barcode.eq.${safe},sku.eq.${safe}`)
    .limit(1)
    .maybeSingle();

  if (error) {
    void reportError(new Error(error.message), {
      tag: 'items.lookup',
      organizationId: ctx.organizationId,
    });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  return NextResponse.json({
    id: data.id,
    sku: data.sku,
    name: data.name,
    barcode: data.barcode,
    quantityOnHand: Number(data.quantity_on_hand) || 0,
    unitCost: Number(data.unit_cost) || 0,
    retailPrice: Number(data.retail_price) || 0,
    reorderPoint: Number(data.reorder_point) || 0,
    warehouseId: data.warehouse_id,
    locationId: data.primary_location_id,
    itemType: data.item_type,
    categoryId: data.category_id,
    supplierId: data.supplier_id,
  });
}
