import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { ServiceError } from './context';

export interface DigestLowStockGroup {
  warehouseName: string;
  items: Array<{
    id: string;
    sku: string;
    name: string;
    qty: number;
    reorderPoint: number;
  }>;
}

export interface DigestOpenPo {
  id: string;
  poNumber: string;
  supplierName: string | null;
  expectedAt: string | null;
  status: string;
  isOverdue: boolean;
}

export interface DigestCycleCount {
  id: string;
  warehouseName: string | null;
  startedAt: string;
  totalLines: number;
  countedLines: number;
}

export interface DigestPayload {
  lowStock: DigestLowStockGroup[];
  openPos: DigestOpenPo[];
  openCycleCounts: DigestCycleCount[];
}

const LOW_STOCK_LIMIT = 20;
const PO_LIMIT = 20;

/**
 * Aggregates the data behind the weekly inventory digest email.
 *
 * Three independent queries (all org-scoped) for low stock, open POs,
 * and in-progress cycle counts. Caller passes the Supabase client —
 * the cron uses an admin client to span all orgs; the "Send preview
 * now" action uses the user's ctx.supabase so RLS still applies.
 *
 * Spec: docs/superpowers/specs/2026-05-08-weekly-email-digest-design.md
 */
export async function getDigestData(
  supabase: SupabaseClient,
  orgId: string,
): Promise<DigestPayload> {
  const [lowStock, openPos, openCycleCounts] = await Promise.all([
    getLowStock(supabase, orgId),
    getOpenPos(supabase, orgId),
    getOpenCycleCounts(supabase, orgId),
  ]);
  return { lowStock, openPos, openCycleCounts };
}

export function isDigestEmpty(p: DigestPayload): boolean {
  return p.lowStock.length === 0 && p.openPos.length === 0 && p.openCycleCounts.length === 0;
}

export interface DigestSectionOptIns {
  lowStock: boolean;
  openPos: boolean;
  cycleCounts: boolean;
}

/**
 * Returns a copy of the payload with disabled sections zeroed out, so the
 * email template skips them. Cheaper than re-fetching with section-aware
 * queries — fetch is O(items+POs+CCs) and each section's filter is just
 * an array length 0 vs N.
 */
export function applySectionOptIns(
  payload: DigestPayload,
  optIns: DigestSectionOptIns,
): DigestPayload {
  return {
    lowStock: optIns.lowStock ? payload.lowStock : [],
    openPos: optIns.openPos ? payload.openPos : [],
    openCycleCounts: optIns.cycleCounts ? payload.openCycleCounts : [],
  };
}

async function getLowStock(
  supabase: SupabaseClient,
  orgId: string,
): Promise<DigestLowStockGroup[]> {
  // Pull the lowest-quantity active items, then JS-filter to those at or
  // below reorder_point (or qty <= 0). PostgREST can't compare two
  // columns in a single filter, so we over-pull and narrow.
  const { data, error } = await supabase
    .from('inventory_items')
    .select(
      'id, sku, name, quantity_on_hand, reorder_point, warehouse_id, warehouse:warehouses!warehouse_id (name)',
    )
    .eq('organization_id', orgId)
    .eq('status', 'active')
    .is('deleted_at', null)
    .order('quantity_on_hand', { ascending: true })
    .limit(150);
  if (error) throw new ServiceError('internal_error', error.message);

  type Row = {
    id: string;
    sku: string;
    name: string;
    quantity_on_hand: number;
    reorder_point: number;
    warehouse_id: string | null;
    warehouse: { name: string } | { name: string }[] | null;
  };

  const filtered = (data ?? []).filter((r) => {
    const row = r as Row;
    return (
      row.quantity_on_hand <= 0 ||
      (row.reorder_point > 0 && row.quantity_on_hand <= row.reorder_point)
    );
  }) as Row[];

  // Group by warehouse (or "Unassigned" when null).
  const groups = new Map<string, DigestLowStockGroup>();
  for (const r of filtered.slice(0, LOW_STOCK_LIMIT)) {
    const wh = Array.isArray(r.warehouse) ? r.warehouse[0] : r.warehouse;
    const name = wh?.name ?? 'Unassigned';
    const group = groups.get(name) ?? { warehouseName: name, items: [] };
    group.items.push({
      id: r.id,
      sku: r.sku,
      name: r.name,
      qty: Number(r.quantity_on_hand) || 0,
      reorderPoint: Number(r.reorder_point) || 0,
    });
    groups.set(name, group);
  }
  return [...groups.values()].sort((a, b) =>
    a.warehouseName.localeCompare(b.warehouseName),
  );
}

async function getOpenPos(supabase: SupabaseClient, orgId: string): Promise<DigestOpenPo[]> {
  const { data, error } = await supabase
    .from('purchase_orders')
    .select('id, po_number, status, expected_at, supplier:suppliers!supplier_id (name)')
    .eq('organization_id', orgId)
    .in('status', ['expected_inbound', 'ordered', 'partially_received'])
    .order('expected_at', { ascending: true, nullsFirst: false })
    .limit(PO_LIMIT);
  if (error) throw new ServiceError('internal_error', error.message);

  const now = Date.now();
  return (data ?? []).map((row) => {
    const r = row as {
      id: string;
      po_number: string;
      status: string;
      expected_at: string | null;
      supplier: { name: string } | { name: string }[] | null;
    };
    const sup = Array.isArray(r.supplier) ? r.supplier[0] : r.supplier;
    const expectedAtMs = r.expected_at ? new Date(r.expected_at).getTime() : null;
    return {
      id: r.id,
      poNumber: r.po_number,
      supplierName: sup?.name ?? null,
      expectedAt: r.expected_at,
      status: r.status,
      isOverdue: expectedAtMs != null && expectedAtMs < now,
    };
  });
}

async function getOpenCycleCounts(
  supabase: SupabaseClient,
  orgId: string,
): Promise<DigestCycleCount[]> {
  const { data, error } = await supabase
    .from('cycle_counts')
    .select(
      'id, started_at, warehouse:warehouses!warehouse_id (name), lines:cycle_count_lines (counted_quantity)',
    )
    .eq('organization_id', orgId)
    .eq('status', 'in_progress')
    .order('started_at', { ascending: true });
  if (error) throw new ServiceError('internal_error', error.message);

  return (data ?? []).map((row) => {
    const r = row as {
      id: string;
      started_at: string;
      warehouse: { name: string } | { name: string }[] | null;
      lines: Array<{ counted_quantity: number | null }> | null;
    };
    const wh = Array.isArray(r.warehouse) ? r.warehouse[0] : r.warehouse;
    const lines = r.lines ?? [];
    const counted = lines.filter((l) => l.counted_quantity != null).length;
    return {
      id: r.id,
      warehouseName: wh?.name ?? null,
      startedAt: r.started_at,
      totalLines: lines.length,
      countedLines: counted,
    };
  });
}
