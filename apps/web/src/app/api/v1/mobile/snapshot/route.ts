import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { getWarehouseAccess } from '@/lib/auth/warehouse';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Bundle of everything the mobile app caches locally for offline use.
 *
 * Query: ?since=<iso>
 *   • Items, warehouses, POs, cycle counts, bundles changed since `since`.
 *   • If `since` is missing or invalid, returns a full snapshot.
 *
 * Scope:
 *   • Warehouses + items + POs are filtered to the user's warehouse access.
 *   • Cycle counts include all in_progress counts in scope.
 *   • Bundles: org-wide active bundles. Mobile only reads them for
 *     distribution; cross-warehouse phantom math happens server-side.
 *
 * Response shape:
 *   {
 *     serverTime: iso,                         // mobile sets next `since` to this
 *     warehouses: [{ id, name }],
 *     items: [{ id, sku, name, barcode, qty, unit_cost, warehouse_id, item_type }],
 *     openPOs: [{ id, po_number, status, expected_at, warehouse_id, lines: [...] }],
 *     openCycleCounts: [{ id, status, warehouse_id, started_at, lines: [...] }],
 *     bundles: [{ id, name, sku, components: [{ item_id, qty, optional }],
 *                 phantom_qty, preassembly_enabled }],
 *     deletedItemIds: string[]                  // for delta cleanup (future)
 *   }
 */
export async function GET(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  const url = new URL(req.url);
  const sinceRaw = url.searchParams.get('since');
  const since =
    sinceRaw && !Number.isNaN(Date.parse(sinceRaw))
      ? new Date(sinceRaw).toISOString()
      : null;

  const access = await getWarehouseAccess(ctx);
  const serverTime = new Date().toISOString();

  // ── Warehouses ──────────────────────────────────────────────────
  const whQ = ctx.supabase
    .from('warehouses')
    .select('id, name, updated_at')
    .eq('organization_id', ctx.organizationId)
    .order('name', { ascending: true });
  if (!access.hasAllAccess && access.readableIds.length) {
    whQ.in('id', access.readableIds);
  }
  const { data: warehouses, error: whErr } = await whQ;
  if (whErr) return NextResponse.json({ error: whErr.message }, { status: 500 });

  // ── Items ───────────────────────────────────────────────────────
  let itemQ = ctx.supabase
    .from('inventory_items')
    .select(
      `id, sku, name, barcode, quantity_on_hand, unit_cost, warehouse_id,
       item_type, is_bundle, updated_at`,
    )
    .eq('organization_id', ctx.organizationId)
    .is('deleted_at', null)
    .eq('status', 'active')
    .or('is_bundle.is.null,is_bundle.eq.false')
    .order('updated_at', { ascending: false })
    .limit(2000);
  if (!access.hasAllAccess && access.readableIds.length) {
    itemQ = itemQ.in('warehouse_id', access.readableIds);
  }
  if (since) itemQ = itemQ.gte('updated_at', since);
  const { data: items, error: itemErr } = await itemQ;
  if (itemErr) return NextResponse.json({ error: itemErr.message }, { status: 500 });

  // ── Open POs (and their lines) ──────────────────────────────────
  let poQ = ctx.supabase
    .from('purchase_orders')
    .select(
      `id, po_number, status, expected_at, warehouse_id, updated_at,
       items:purchase_order_items (
         id, item_id, quantity_ordered, quantity_received, unit_cost
       )`,
    )
    .eq('organization_id', ctx.organizationId)
    .in('status', ['ordered', 'partially_received', 'draft'])
    .order('updated_at', { ascending: false })
    .limit(200);
  if (!access.hasAllAccess && access.readableIds.length) {
    poQ = poQ.in('warehouse_id', access.readableIds);
  }
  if (since) poQ = poQ.gte('updated_at', since);
  const { data: pos, error: poErr } = await poQ;
  if (poErr) return NextResponse.json({ error: poErr.message }, { status: 500 });

  // ── Open cycle counts (and their lines) ─────────────────────────
  let ccQ = ctx.supabase
    .from('cycle_counts')
    .select(
      `id, status, warehouse_id, started_at, assigned_to, notes,
       lines:cycle_count_lines (
         id, item_id, expected_quantity, counted_quantity
       )`,
    )
    .eq('organization_id', ctx.organizationId)
    .eq('status', 'in_progress')
    .order('started_at', { ascending: false })
    .limit(50);
  if (!access.hasAllAccess && access.readableIds.length) {
    ccQ = ccQ.or(
      `warehouse_id.is.null,warehouse_id.in.(${access.readableIds.join(',')})`,
    );
  }
  const { data: counts, error: ccErr } = await ccQ;
  if (ccErr) return NextResponse.json({ error: ccErr.message }, { status: 500 });

  // ── Bundles ─────────────────────────────────────────────────────
  let bQ = ctx.supabase
    .from('bundles')
    .select(
      `id, name, sku, preassembly_enabled, phantom_item_id, updated_at,
       components:bundle_components (item_id, quantity, is_optional),
       phantom:inventory_items!phantom_item_id (quantity_on_hand, warehouse_id)`,
    )
    .eq('organization_id', ctx.organizationId)
    .eq('is_active', true)
    .is('archived_at', null)
    .order('name', { ascending: true });
  if (since) bQ = bQ.gte('updated_at', since);
  const { data: bundles, error: bErr } = await bQ;
  if (bErr) return NextResponse.json({ error: bErr.message }, { status: 500 });

  return NextResponse.json({
    serverTime,
    since,
    warehouses: (warehouses ?? []).map((w) => ({
      id: w.id,
      name: w.name,
    })),
    items: (items ?? []).map((i) => ({
      id: i.id,
      sku: i.sku,
      name: i.name,
      barcode: i.barcode,
      quantityOnHand: Number(i.quantity_on_hand) || 0,
      unitCost: Number(i.unit_cost) || 0,
      warehouseId: i.warehouse_id,
      itemType: i.item_type,
    })),
    openPOs: (pos ?? []).map((p) => {
      const lines = ((p as { items?: unknown[] }).items ?? []) as Array<{
        id: string;
        item_id: string;
        quantity_ordered: number;
        quantity_received: number;
        unit_cost: number;
      }>;
      return {
        id: p.id,
        poNumber: p.po_number,
        status: p.status,
        expectedAt: p.expected_at,
        warehouseId: p.warehouse_id,
        lines: lines.map((l) => ({
          id: l.id,
          itemId: l.item_id,
          qtyOrdered: Number(l.quantity_ordered) || 0,
          qtyReceived: Number(l.quantity_received) || 0,
          unitCost: Number(l.unit_cost) || 0,
        })),
      };
    }),
    openCycleCounts: (counts ?? []).map((c) => {
      const lines = ((c as { lines?: unknown[] }).lines ?? []) as Array<{
        id: string;
        item_id: string;
        expected_quantity: number;
        counted_quantity: number | null;
      }>;
      return {
        id: c.id,
        status: c.status,
        warehouseId: c.warehouse_id,
        startedAt: c.started_at,
        assignedTo: c.assigned_to,
        notes: c.notes,
        lines: lines.map((l) => ({
          id: l.id,
          itemId: l.item_id,
          expected: Number(l.expected_quantity) || 0,
          counted:
            l.counted_quantity == null ? null : Number(l.counted_quantity),
        })),
      };
    }),
    bundles: (bundles ?? []).map((b) => {
      const phantomField = (b as {
        phantom?:
          | { quantity_on_hand: number; warehouse_id: string | null }
          | { quantity_on_hand: number; warehouse_id: string | null }[]
          | null;
      }).phantom;
      const phantom = Array.isArray(phantomField) ? phantomField[0] : phantomField;
      const components = ((b as { components?: unknown[] }).components ?? []) as Array<{
        item_id: string;
        quantity: number;
        is_optional: boolean;
      }>;
      return {
        id: b.id,
        name: b.name,
        sku: b.sku,
        preassemblyEnabled: Boolean(b.preassembly_enabled),
        phantomItemId: b.phantom_item_id,
        phantomQty: phantom ? Number(phantom.quantity_on_hand) || 0 : 0,
        phantomWarehouseId: phantom?.warehouse_id ?? null,
        components: components.map((c) => ({
          itemId: c.item_id,
          quantity: Number(c.quantity) || 0,
          isOptional: Boolean(c.is_optional),
        })),
      };
    }),
  });
}
