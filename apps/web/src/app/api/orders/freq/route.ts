import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { ItemImagesService } from '@/server/services/item-images';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_DAYS = 30;
const DEFAULT_LIMIT = 6;
const MAX_LIMIT = 12;
const MAX_DAYS = 365;

/**
 * Returns the top-N most-ordered items for a warehouse over the last
 * N days, with each row pre-hydrated (sku, name, category, thumbnail,
 * available-to-promise) so the Quick-add component can render in one
 * round-trip.
 *
 * Backs:
 *   • /dashboard/orders/new v2 picker — Quick-add strip
 *   • Future "Most ordered" sort key on the same picker
 *
 * RLS: order_request_top_skus_for_warehouse is security invoker, so
 * the underlying order_requests select honors the caller's warehouse
 * access. A user requesting freq for a warehouse they can't read
 * simply gets an empty list rather than a 403 — matches the spec's
 * "hide gracefully" edge case.
 */
export async function GET(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const url = new URL(req.url);
  const warehouseId = url.searchParams.get('warehouseId');
  if (!warehouseId) {
    return NextResponse.json(
      { error: 'validation_error', message: 'warehouseId is required' },
      { status: 400 },
    );
  }
  const days = clampInt(url.searchParams.get('days'), DEFAULT_DAYS, 1, MAX_DAYS);
  const limit = clampInt(url.searchParams.get('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT);

  const { data: topRows, error: rpcErr } = await ctx.supabase.rpc(
    'order_request_top_skus_for_warehouse',
    { p_warehouse_id: warehouseId, p_days: days, p_limit: limit },
  );
  if (rpcErr) {
    return NextResponse.json(
      { error: 'internal_error', message: rpcErr.message },
      { status: 500 },
    );
  }
  const top = (topRows ?? []) as Array<{ item_id: string; request_count: number }>;
  if (top.length === 0) return NextResponse.json({ items: [] }, { status: 200 });

  const itemIds = top.map((r) => r.item_id);

  // Items + reservations in parallel — both keyed on the same item_id set.
  const [itemsRes, resvRes] = await Promise.all([
    ctx.supabase
      .from('inventory_items')
      .select('id, sku, name, quantity_on_hand, category_id, item_type')
      .eq('organization_id', ctx.organizationId)
      .in('id', itemIds)
      .is('deleted_at', null)
      .eq('status', 'active'),
    ctx.supabase
      .from('stock_reservations')
      .select('item_id, quantity')
      .eq('organization_id', ctx.organizationId)
      .in('item_id', itemIds)
      .is('released_at', null),
  ]);

  type ItemRow = {
    id: string;
    sku: string;
    name: string;
    quantity_on_hand: number;
    category_id: string | null;
    item_type: string | null;
  };
  const items = (itemsRes.data ?? []) as ItemRow[];

  const reservedByItem = new Map<string, number>();
  for (const r of (resvRes.data ?? []) as Array<{ item_id: string; quantity: number }>) {
    reservedByItem.set(r.item_id, (reservedByItem.get(r.item_id) ?? 0) + Number(r.quantity));
  }

  // Category names — one extra round-trip but small (≤12 ids).
  const categoryIds = [...new Set(items.map((i) => i.category_id).filter((v): v is string => Boolean(v)))];
  const categoryNameById = new Map<string, string>();
  if (categoryIds.length > 0) {
    const { data: cats } = await ctx.supabase
      .from('categories')
      .select('id, name')
      .eq('organization_id', ctx.organizationId)
      .in('id', categoryIds);
    for (const c of (cats ?? []) as Array<{ id: string; name: string }>) {
      categoryNameById.set(c.id, c.name);
    }
  }

  // Same thumbnail pipeline the order picker uses — prefers stored
  // thumb_path, falls back to transformed master, falls back to
  // bulk-import custom_fields.thumbnail_url. unstable_cache layer
  // means the second request is near-instant.
  const imagesSvc = new ItemImagesService(ctx);
  const imageUrlByItem = await imagesSvc.primaryImagesForPdfRendering(itemIds, 200);

  // Preserve the RPC's count-desc ordering by walking `top` (not items).
  // Items dropped along the way (archived between RPC + select) just
  // don't appear in the response — the picker tolerates fewer than
  // `limit` rows.
  const out = top
    .map((row) => {
      const it = items.find((i) => i.id === row.item_id);
      if (!it) return null;
      const reserved = reservedByItem.get(it.id) ?? 0;
      const available = Math.max(0, Number(it.quantity_on_hand) - reserved);
      return {
        itemId: it.id,
        sku: it.sku,
        name: it.name,
        categoryName: it.category_id ? categoryNameById.get(it.category_id) ?? null : null,
        imageUrl: imageUrlByItem.get(it.id) ?? null,
        available,
        quantityOnHand: Number(it.quantity_on_hand),
        count: Number(row.request_count),
      };
    })
    .filter((v): v is NonNullable<typeof v> => v !== null);

  return NextResponse.json({ items: out }, { status: 200 });
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(raw ?? '', 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}
