import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { ServiceError } from './context';
import { fetchAllRows } from './lib/paginate';

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
  type Row = {
    id: string;
    sku: string;
    name: string;
    quantity_on_hand: number;
    reorder_point: number;
    warehouse_id: string | null;
    warehouse: { name: string } | { name: string }[] | null;
  };

  // PostgREST can't compare two columns in a single filter, so the
  // `quantity_on_hand <= reorder_point` half of the predicate has to run in JS
  // over a candidate pull.
  //
  // WHY PAGINATED, NOT `.limit(150)` (bug SP-132): the old query took the 150
  // LOWEST-quantity active items and only then narrowed. Whether a genuinely
  // low item made that window depended on how many OTHER items sat below it by
  // raw quantity, not on whether it was below its own reorder point — so an org
  // with >150 healthy slow movers at qty 1-5 (plain books are exactly that
  // shape) could have a fast mover at qty 300 / reorder_point 500 and get a
  // digest reporting NO low stock at all. Nothing about the data warned you;
  // the section just came back empty. Pattern #7 (silent caps that bound
  // coverage) and #3 (any candidate SELECT must paginate — PostgREST clamps
  // every response to 1000 rows, so raising the limit would not have fixed it).
  //
  // Two changes stop it: `.or(...)` narrows the pull server-side to rows that
  // COULD qualify (qty <= 0, or a reorder point is set at all), and
  // fetchAllRows walks 1000-row windows so no candidate is left behind. The
  // rendered slice is still LOW_STOCK_LIMIT, but it is now the 20 lowest of the
  // real low-stock set rather than of an arbitrary window.
  //
  // NB the `.or` is NULL-safe by construction: `reorder_point.gt.0` drops rows
  // whose reorder_point is NULL (pattern #23), but such a row can only qualify
  // via `quantity_on_hand <= 0`, which the first disjunct already keeps. The
  // column is `not null default 0` (0002_inventory.sql) anyway.
  const rows = await fetchAllRows<Row>((from, to) =>
    supabase
      .from('inventory_items')
      .select(
        'id, sku, name, quantity_on_hand, reorder_point, warehouse_id, warehouse:warehouses!warehouse_id (name)',
      )
      .eq('organization_id', orgId)
      .eq('status', 'active')
      .is('deleted_at', null)
      .or('quantity_on_hand.lte.0,reorder_point.gt.0')
      // Quantity-ascending keeps the neediest items in the rendered slice; the
      // id tiebreak is what makes the paging windows stable (see paginate.ts).
      .order('quantity_on_hand', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  );

  const filtered = rows.filter(
    (row) =>
      row.quantity_on_hand <= 0 ||
      (row.reorder_point > 0 && row.quantity_on_hand <= row.reorder_point),
  );

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
  // Load cycle counts PAGINATED (PostgREST caps any query at 1000 rows) and
  // WITHOUT the lines embed (embeds are capped too, which would silently
  // truncate large counts). Stable order (started_at, then unique id) so pages
  // don't overlap or skip.
  const counts = await fetchAllRows<{
    id: string;
    started_at: string;
    warehouse: { name: string } | { name: string }[] | null;
  }>((from, to) =>
    supabase
      .from('cycle_counts')
      .select('id, started_at, warehouse:warehouses!warehouse_id (name)')
      .eq('organization_id', orgId)
      .eq('status', 'in_progress')
      .order('started_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  );

  if (counts.length === 0) return [];

  const countIds = counts.map((c) => c.id);

  // Fetch ALL lines for the open cycle counts, paginated to avoid the 1000-row
  // PostgREST cap. NB: the FK column on cycle_count_lines is `cycle_count_id`
  // (migration 0023), not `count_id`.
  type LineRow = { cycle_count_id: string; counted_quantity: number | null };
  const lines = await fetchAllRows<LineRow>((from, to) =>
    supabase
      .from('cycle_count_lines')
      .select('cycle_count_id, counted_quantity')
      .in('cycle_count_id', countIds)
      .order('cycle_count_id', { ascending: true })
      .range(from, to),
  );

  // Group line stats by cycle_count_id.
  const statsMap = new Map<string, { total: number; counted: number }>();
  for (const id of countIds) statsMap.set(id, { total: 0, counted: 0 });
  for (const line of lines) {
    const stats = statsMap.get(line.cycle_count_id);
    if (!stats) continue;
    stats.total += 1;
    if (line.counted_quantity != null) stats.counted += 1;
  }

  return counts.map((row) => {
    const wh = Array.isArray(row.warehouse) ? row.warehouse[0] : row.warehouse;
    const stats = statsMap.get(row.id) ?? { total: 0, counted: 0 };
    return {
      id: row.id,
      warehouseName: wh?.name ?? null,
      startedAt: row.started_at,
      totalLines: stats.total,
      countedLines: stats.counted,
    };
  });
}
