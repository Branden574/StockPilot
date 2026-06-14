import 'server-only';

import { withContext, type ServiceContext } from './context';
import { fetchAllRows } from './lib/paginate';

export interface ValuationRow {
  itemId: string;
  sku: string;
  name: string;
  warehouseName: string | null;
  categoryName: string | null;
  quantityOnHand: number;
  unitCost: number;
  value: number;
}

export interface ValuationReport {
  rows: ValuationRow[];
  totalValue: number;
  totalUnits: number;
  itemCount: number;
  byWarehouse: Array<{ warehouseId: string | null; warehouseName: string; value: number; units: number }>;
  byCategory: Array<{ categoryId: string | null; categoryName: string; value: number; units: number }>;
}

export interface MovementSummaryRow {
  itemId: string;
  sku: string;
  name: string;
  totalIn: number;
  totalOut: number;
  netChange: number;
  movementCount: number;
}

export interface MovementSummary {
  rangeDays: number;
  byType: Array<{ movementType: string; count: number; totalQty: number }>;
  topMovers: MovementSummaryRow[];
  totalMovements: number;
}

export interface ReorderRow {
  itemId: string;
  sku: string;
  name: string;
  warehouseName: string | null;
  quantityOnHand: number;
  reorderPoint: number;
  reorderQuantity: number;
  deficit: number;
  unitCost: number;
  estimatedReorderCost: number;
}

export interface ReorderForecast {
  rows: ReorderRow[];
  totalItems: number;
  totalDeficit: number;
  totalEstimatedCost: number;
}

export interface ShrinkageRow {
  movementId: string;
  createdAt: string;
  itemId: string;
  sku: string;
  itemName: string;
  quantityChange: number;
  unitCost: number;
  costImpact: number;
  reason: string | null;
  notes: string | null;
}

export interface ShrinkageReport {
  rangeDays: number;
  rows: ShrinkageRow[];
  totalUnits: number;
  totalCost: number;
}

export interface SupplierScorecardRow {
  supplierId: string;
  supplierName: string;
  totalPos: number;
  receivedPos: number;
  openPos: number;
  totalSpend: number;
  openValue: number;
  onTimeRate: number | null; // 0..1, null when no comparable POs
  avgLeadDays: number | null; // null when nothing fully received
  fillRate: number | null; // 0..1, null when nothing ordered
  lastReceivedAt: string | null;
}

export interface VelocityClassRow {
  itemId: string;
  sku: string;
  name: string;
  warehouseName: string | null;
  categoryName: string | null;
  quantityOnHand: number;
  unitCost: number;
  /** Total units leaving this item (movements with quantity_change < 0) in window. */
  unitsOut: number;
  /** unitsOut × unit_cost — the metric ABC ranks by. */
  valueOut: number;
  /** Most recent out-movement in window. Null = no movements. */
  lastOutAt: string | null;
  /** A = top 80% of value, B = next 15%, C = bottom 5%, D = no movement (dead). */
  velocityClass: 'A' | 'B' | 'C' | 'D';
}

export interface VelocityClassReport {
  rangeDays: number;
  rows: VelocityClassRow[];
  summary: { A: number; B: number; C: number; D: number };
  totalValueOut: number;
}

export interface DeadStockRow {
  itemId: string;
  sku: string;
  name: string;
  warehouseName: string | null;
  categoryName: string | null;
  quantityOnHand: number;
  unitCost: number;
  /** Carrying cost: qty × unit_cost. The dollars sitting on the shelf. */
  carryingValue: number;
  /** Days since the item was created in the system. */
  ageDays: number;
  /** Days the item has been stagnant in the dead-stock window — capped
   *  to the window length since older history isn't queried. */
  stagnantDays: number;
}

export interface DeadStockReport {
  rangeDays: number;
  rows: DeadStockRow[];
  totalCarryingValue: number;
  itemCount: number;
}

export interface SupplierScorecardReport {
  rangeDays: number;
  rows: SupplierScorecardRow[];
  totalPos: number;
  totalSpend: number;
  totalOpenValue: number;
}

export interface CostHistoryPoint {
  /** ISO timestamp this unit cost was committed/observed. */
  date: string;
  /** Unit cost we paid (or committed to pay), in org currency. */
  unitCost: number;
  /** Where the price came from: a PO line we ordered, or a posted receipt. */
  source: 'purchase_order' | 'receipt';
}

export interface SupplierCostSeries {
  /** Supplier id, or '__none' when a PO/receipt carried no supplier. */
  supplierId: string;
  supplierName: string;
  /** Chronological (oldest → newest) unit-cost observations. */
  points: CostHistoryPoint[];
}

export interface ItemCostHistory {
  itemId: string;
  series: SupplierCostSeries[];
  /** Most recent unit cost across all suppliers (null when no history). */
  lastUnitCost: number | null;
  /** Simple mean of every observed unit cost (null when no history). */
  avgUnitCost: number | null;
  /** Total number of price observations across all suppliers. */
  pointCount: number;
}

export class ReportsService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new ReportsService(await withContext());
  }

  /**
   * Inventory valuation: per-item cost basis, plus rollups by warehouse
   * and category. All non-deleted, active items count.
   */
  async inventoryValuation(): Promise<ValuationReport> {
    // PostgREST hard-caps every response at `[api] max_rows` (1000), so a
    // single `.limit(10_000)` silently truncates any org with >1000 items —
    // corrupting the totals/rollups. Page through the full set instead.
    type ValuationItemRow = {
      id: string;
      sku: string;
      name: string;
      quantity_on_hand: number;
      unit_cost: number;
      warehouse_id: string | null;
      category_id: string | null;
      warehouse: { name: string } | { name: string }[] | null;
      category: { name: string } | { name: string }[] | null;
    };
    const data = await fetchAllRows<ValuationItemRow>(
      (from, to) =>
        this.ctx.supabase
          .from('inventory_items')
          .select(
            `id, sku, name, quantity_on_hand, unit_cost, warehouse_id, category_id,
         warehouse:warehouses!warehouse_id (name),
         category:categories!category_id (name)`,
          )
          .eq('organization_id', this.ctx.organizationId)
          .is('deleted_at', null)
          .eq('status', 'active')
          // Rentals (canopies, supplies) circulate rather than sell —
          // excluded from every report so valuations and forecasts
          // reflect only sellable inventory.
          .eq('is_rental', false)
          // Stable order for range pagination; the report re-sorts by
          // quantity_on_hand below.
          .order('id', { ascending: true })
          .range(from, to),
      { cap: 10_000 },
    );

    // Hold each raw row alongside the warehouse_id / category_id needed to
    // bucket by id (not name). Two warehouses with the same name —
    // e.g. "Main" in two regions — must NOT collapse into one row.
    type Enriched = ValuationRow & { warehouseId: string | null; categoryId: string | null };
    const enriched: Enriched[] = data
      // Preserve the original quantity_on_hand-descending row order.
      .sort((a, b) => (Number(b.quantity_on_hand) || 0) - (Number(a.quantity_on_hand) || 0))
      .map((r) => {
      const rec = r as unknown as {
        id: string;
        sku: string;
        name: string;
        quantity_on_hand: number;
        unit_cost: number;
        warehouse_id: string | null;
        category_id: string | null;
        warehouse: { name: string } | { name: string }[] | null;
        category: { name: string } | { name: string }[] | null;
      };
      const wh = Array.isArray(rec.warehouse) ? rec.warehouse[0] : rec.warehouse;
      const cat = Array.isArray(rec.category) ? rec.category[0] : rec.category;
      const qty = Number(rec.quantity_on_hand) || 0;
      const cost = Number(rec.unit_cost) || 0;
      return {
        itemId: rec.id,
        sku: rec.sku,
        name: rec.name,
        warehouseId: rec.warehouse_id ?? null,
        warehouseName: wh?.name ?? null,
        categoryId: rec.category_id ?? null,
        categoryName: cat?.name ?? null,
        quantityOnHand: qty,
        unitCost: cost,
        value: qty * cost,
      };
    });

    const rows: ValuationRow[] = enriched.map(
      ({ warehouseId: _w, categoryId: _c, ...rest }) => rest,
    );

    // Key buckets by id ('__none' for null) so same-named warehouses /
    // categories stay distinct. Preserve both id and name on the bucket
    // so consumers can deep-link.
    const byWh = new Map<
      string,
      { warehouseId: string | null; warehouseName: string; value: number; units: number }
    >();
    const byCat = new Map<
      string,
      { categoryId: string | null; categoryName: string; value: number; units: number }
    >();
    let totalValue = 0;
    let totalUnits = 0;
    for (const r of enriched) {
      totalValue += r.value;
      totalUnits += r.quantityOnHand;
      const whKey = r.warehouseId ?? '__none';
      const whEntry = byWh.get(whKey) ?? {
        warehouseId: r.warehouseId,
        warehouseName: r.warehouseName ?? 'Unassigned',
        value: 0,
        units: 0,
      };
      whEntry.value += r.value;
      whEntry.units += r.quantityOnHand;
      byWh.set(whKey, whEntry);

      const catKey = r.categoryId ?? '__none';
      const catEntry = byCat.get(catKey) ?? {
        categoryId: r.categoryId,
        categoryName: r.categoryName ?? 'Uncategorized',
        value: 0,
        units: 0,
      };
      catEntry.value += r.value;
      catEntry.units += r.quantityOnHand;
      byCat.set(catKey, catEntry);
    }

    return {
      rows,
      totalValue,
      totalUnits,
      itemCount: rows.length,
      byWarehouse: [...byWh.values()].sort((a, b) => b.value - a.value),
      byCategory: [...byCat.values()].sort((a, b) => b.value - a.value),
    };
  }

  /**
   * Stock movement summary over the last `days` days. Aggregates by
   * movement_type and identifies the top items by gross qty moved.
   */
  async movementSummary(days = 30): Promise<MovementSummary> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    // 50k row cap. A high-volume org with millions of movements in a
    // 90-day window would otherwise pull the whole result set into
    // Node memory and aggregate in JS. The cap is now the TRUE bound on
    // rows considered — without paging, PostgREST's max_rows = 1000 would
    // silently truncate the aggregate. Order is irrelevant here (pure
    // type/per-item sums + JS top-N), so we page by id.
    type MovementRow = {
      id: string;
      item_id: string;
      movement_type: string;
      quantity_change: number;
      created_at: string;
      item: { id: string; sku: string; name: string } | { id: string; sku: string; name: string }[] | null;
    };
    const data = await fetchAllRows<MovementRow>(
      (from, to) =>
        this.ctx.supabase
          .from('stock_movements')
          .select(
            `id, item_id, movement_type, quantity_change, created_at,
         item:inventory_items!item_id (id, sku, name)`,
          )
          .eq('organization_id', this.ctx.organizationId)
          .gte('created_at', since)
          .order('id', { ascending: true })
          .range(from, to),
      { cap: 50_000 },
    );

    const byType = new Map<string, { count: number; totalQty: number }>();
    const perItem = new Map<
      string,
      { sku: string; name: string; totalIn: number; totalOut: number; movementCount: number }
    >();

    for (const r of data) {
      const t = r.movement_type;
      const change = Number(r.quantity_change) || 0;
      const typeEntry = byType.get(t) ?? { count: 0, totalQty: 0 };
      typeEntry.count++;
      typeEntry.totalQty += Math.abs(change);
      byType.set(t, typeEntry);

      const item = Array.isArray(r.item) ? r.item[0] : r.item;
      if (!item) continue;
      const key = item.id;
      const entry = perItem.get(key) ?? {
        sku: item.sku,
        name: item.name,
        totalIn: 0,
        totalOut: 0,
        movementCount: 0,
      };
      entry.movementCount++;
      if (change >= 0) entry.totalIn += change;
      else entry.totalOut += -change;
      perItem.set(key, entry);
    }

    const topMovers: MovementSummaryRow[] = [...perItem.entries()]
      .map(([itemId, v]) => ({
        itemId,
        sku: v.sku,
        name: v.name,
        totalIn: v.totalIn,
        totalOut: v.totalOut,
        netChange: v.totalIn - v.totalOut,
        movementCount: v.movementCount,
      }))
      .sort((a, b) => b.totalIn + b.totalOut - (a.totalIn + a.totalOut))
      .slice(0, 50);

    return {
      rangeDays: days,
      byType: [...byType.entries()]
        .map(([movementType, v]) => ({ movementType, count: v.count, totalQty: v.totalQty }))
        .sort((a, b) => b.count - a.count),
      topMovers,
      totalMovements: data.length,
    };
  }

  /**
   * Items at or below their reorder_point. Includes the deficit (how many
   * units to bring back to the reorder quantity) and an estimated cost
   * to do so.
   */
  async reorderForecast(): Promise<ReorderForecast> {
    // PostgREST caps responses at 1000 rows; page the full set so the
    // forecast covers every below-reorder-point item, not just the first
    // 1000. The final rows are re-sorted by deficit, so fetch order is
    // irrelevant — page by id.
    type ReorderItemRow = {
      id: string;
      sku: string;
      name: string;
      quantity_on_hand: number;
      reorder_point: number;
      reorder_quantity: number;
      unit_cost: number;
      warehouse_id: string | null;
      warehouse: { name: string } | { name: string }[] | null;
    };
    const data = await fetchAllRows<ReorderItemRow>(
      (from, to) =>
        this.ctx.supabase
          .from('inventory_items')
          .select(
            `id, sku, name, quantity_on_hand, reorder_point, reorder_quantity, unit_cost, warehouse_id,
         warehouse:warehouses!warehouse_id (name)`,
          )
          .eq('organization_id', this.ctx.organizationId)
          .is('deleted_at', null)
          .eq('status', 'active')
          .eq('is_rental', false)
          .gt('reorder_point', 0)
          .order('id', { ascending: true })
          .range(from, to),
      { cap: 5_000 },
    );

    const rows: ReorderRow[] = [];
    let totalDeficit = 0;
    let totalEstimatedCost = 0;
    for (const r of data) {
      const qty = Number(r.quantity_on_hand) || 0;
      const reorderPoint = Number(r.reorder_point) || 0;
      if (qty > reorderPoint) continue;
      const reorderQty = Number(r.reorder_quantity) || 0;
      const unitCost = Number(r.unit_cost) || 0;
      const targetQty = Math.max(reorderQty, reorderPoint);
      const deficit = Math.max(0, targetQty - qty);
      const estimatedCost = deficit * unitCost;
      totalDeficit += deficit;
      totalEstimatedCost += estimatedCost;
      const wh = Array.isArray(r.warehouse) ? r.warehouse[0] : r.warehouse;
      rows.push({
        itemId: r.id,
        sku: r.sku,
        name: r.name,
        warehouseName: wh?.name ?? null,
        quantityOnHand: qty,
        reorderPoint,
        reorderQuantity: reorderQty,
        deficit,
        unitCost,
        estimatedReorderCost: estimatedCost,
      });
    }

    return {
      rows: rows.sort((a, b) => b.deficit - a.deficit),
      totalItems: rows.length,
      totalDeficit,
      totalEstimatedCost,
    };
  }

  /**
   * Shrinkage report: negative adjustments over the last `days` days.
   * "Adjust" type movements with quantity_change < 0 are losses; we sum
   * the implied cost using the item's current unit_cost.
   */
  async shrinkage(days = 30): Promise<ShrinkageReport> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    // 50k cap — see movementSummary() for the rationale. Page the full set
    // (PostgREST max_rows = 1000 would otherwise silently truncate) ordered
    // by id; the rows are re-sorted by created_at desc below to preserve the
    // original newest-first display order.
    type ShrinkageMoveRow = {
      id: string;
      item_id: string;
      quantity_change: number;
      reason: string | null;
      notes: string | null;
      created_at: string;
      item:
        | { id: string; sku: string; name: string; unit_cost: number }
        | { id: string; sku: string; name: string; unit_cost: number }[]
        | null;
    };
    const data = await fetchAllRows<ShrinkageMoveRow>(
      (from, to) =>
        this.ctx.supabase
          .from('stock_movements')
          .select(
            `id, item_id, movement_type, quantity_change, reason, notes, created_at,
         item:inventory_items!item_id (id, sku, name, unit_cost)`,
          )
          .eq('organization_id', this.ctx.organizationId)
          .eq('movement_type', 'adjust')
          .lt('quantity_change', 0)
          .gte('created_at', since)
          .order('id', { ascending: true })
          .range(from, to),
      { cap: 50_000 },
    );

    const rows: ShrinkageRow[] = [];
    let totalUnits = 0;
    let totalCost = 0;
    for (const r of data) {
      const item = Array.isArray(r.item) ? r.item[0] : r.item;
      if (!item) continue;
      const change = Number(r.quantity_change) || 0;
      const unitCost = Number(item.unit_cost) || 0;
      const lostUnits = Math.abs(change);
      const cost = lostUnits * unitCost;
      totalUnits += lostUnits;
      totalCost += cost;
      rows.push({
        movementId: r.id,
        createdAt: r.created_at,
        itemId: item.id,
        sku: item.sku,
        itemName: item.name,
        quantityChange: change,
        unitCost,
        costImpact: cost,
        reason: r.reason,
        notes: r.notes,
      });
    }

    // Preserve the original newest-first display order (the query used to
    // order by created_at desc before paginating by id).
    rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));

    return { rangeDays: days, rows, totalUnits, totalCost };
  }

  /**
   * Per-supplier performance over the last `days` days. Aggregates
   * purchase_orders + purchase_order_items into:
   *   - PO count (total, received, still open)
   *   - Spend (committed total + open dollar value)
   *   - On-time rate (received_at <= expected_at, only POs where both
   *     are set)
   *   - Avg lead time in days (ordered_at → received_at, full receipts)
   *   - Fill rate (sum quantity_received / sum quantity_ordered) across
   *     all PO items, weighted by qty
   *   - Last received_at
   *
   * Only includes suppliers that had at least one PO in the window.
   */
  async supplierScorecard(days = 90): Promise<SupplierScorecardReport> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    // PostgREST caps every response at 1000 rows; page the full PO set so
    // the scorecard aggregates over every PO in the window. Final rows are
    // re-sorted by totalSpend, so fetch order is irrelevant — page by id.
    type ScorecardPoRow = {
      id: string;
      supplier_id: string;
      status: string;
      ordered_at: string | null;
      expected_at: string | null;
      received_at: string | null;
      total: number;
      created_at: string;
      supplier:
        | { name: string }
        | { name: string }[]
        | null;
    };
    const poList = await fetchAllRows<ScorecardPoRow>(
      (from, to) =>
        this.ctx.supabase
          .from('purchase_orders')
          .select(
            `id, supplier_id, status, ordered_at, expected_at, received_at,
         total, created_at,
         supplier:suppliers!supplier_id (name)`,
          )
          .eq('organization_id', this.ctx.organizationId)
          .not('supplier_id', 'is', null)
          .gte('created_at', since)
          .order('id', { ascending: true })
          .range(from, to),
      { cap: 50_000 },
    );

    const poIds = poList.map((p) => p.id);
    let poItems: Array<{
      purchase_order_id: string;
      quantity_ordered: number;
      quantity_received: number;
    }> = [];
    if (poIds.length > 0) {
      // The `.in(poIds)` aggregate is likewise capped at 1000 rows by
      // PostgREST; page it so fill-rate sums cover every PO line. Batch the
      // poIds (URL length) and page each batch.
      const PO_ID_BATCH = 200;
      for (let i = 0; i < poIds.length; i += PO_ID_BATCH) {
        const batch = poIds.slice(i, i + PO_ID_BATCH);
        const batchItems = await fetchAllRows<{
          id: string;
          purchase_order_id: string;
          quantity_ordered: number;
          quantity_received: number;
        }>(
          (from, to) =>
            this.ctx.supabase
              .from('purchase_order_items')
              .select('id, purchase_order_id, quantity_ordered, quantity_received')
              .in('purchase_order_id', batch)
              .order('id', { ascending: true })
              .range(from, to),
          { cap: 100_000 },
        );
        for (const it of batchItems) {
          poItems.push({
            purchase_order_id: it.purchase_order_id,
            quantity_ordered: it.quantity_ordered,
            quantity_received: it.quantity_received,
          });
        }
      }
    }
    const itemsByPo = new Map<
      string,
      { qtyOrdered: number; qtyReceived: number }
    >();
    for (const it of poItems) {
      const cur = itemsByPo.get(it.purchase_order_id) ?? { qtyOrdered: 0, qtyReceived: 0 };
      cur.qtyOrdered += Number(it.quantity_ordered) || 0;
      cur.qtyReceived += Number(it.quantity_received) || 0;
      itemsByPo.set(it.purchase_order_id, cur);
    }

    interface Bucket {
      supplierId: string;
      supplierName: string;
      totalPos: number;
      receivedPos: number;
      openPos: number;
      totalSpend: number;
      openValue: number;
      onTimeMatched: number;
      onTimeHits: number;
      leadDaysSum: number;
      leadDaysCount: number;
      qtyOrdered: number;
      qtyReceived: number;
      lastReceivedAt: string | null;
    }
    const byId = new Map<string, Bucket>();

    const RECEIVABLE = new Set([
      'expected_inbound',
      'ordered',
      'partially_received',
    ]);

    for (const po of poList) {
      const supplierObj = Array.isArray(po.supplier) ? po.supplier[0] : po.supplier;
      const name = supplierObj?.name ?? 'Unknown supplier';
      const b: Bucket =
        byId.get(po.supplier_id) ?? {
          supplierId: po.supplier_id,
          supplierName: name,
          totalPos: 0,
          receivedPos: 0,
          openPos: 0,
          totalSpend: 0,
          openValue: 0,
          onTimeMatched: 0,
          onTimeHits: 0,
          leadDaysSum: 0,
          leadDaysCount: 0,
          qtyOrdered: 0,
          qtyReceived: 0,
          lastReceivedAt: null,
        };
      b.totalPos++;
      const total = Number(po.total) || 0;
      b.totalSpend += total;
      const isOpen = RECEIVABLE.has(po.status);
      if (isOpen) {
        b.openPos++;
        b.openValue += total;
      }
      if (po.status === 'received') b.receivedPos++;

      if (po.received_at && po.expected_at) {
        b.onTimeMatched++;
        if (new Date(po.received_at) <= new Date(po.expected_at)) {
          b.onTimeHits++;
        }
      }
      const startedAt = po.ordered_at ?? po.created_at;
      if (po.received_at && startedAt && po.status === 'received') {
        const ms = new Date(po.received_at).getTime() - new Date(startedAt).getTime();
        if (ms > 0) {
          b.leadDaysSum += ms / (1000 * 60 * 60 * 24);
          b.leadDaysCount++;
        }
      }
      if (po.received_at) {
        if (!b.lastReceivedAt || po.received_at > b.lastReceivedAt) {
          b.lastReceivedAt = po.received_at;
        }
      }
      const qty = itemsByPo.get(po.id);
      if (qty) {
        b.qtyOrdered += qty.qtyOrdered;
        b.qtyReceived += qty.qtyReceived;
      }
      byId.set(po.supplier_id, b);
    }

    const rows: SupplierScorecardRow[] = [...byId.values()]
      .map((b) => ({
        supplierId: b.supplierId,
        supplierName: b.supplierName,
        totalPos: b.totalPos,
        receivedPos: b.receivedPos,
        openPos: b.openPos,
        totalSpend: b.totalSpend,
        openValue: b.openValue,
        onTimeRate:
          b.onTimeMatched > 0 ? b.onTimeHits / b.onTimeMatched : null,
        avgLeadDays:
          b.leadDaysCount > 0 ? b.leadDaysSum / b.leadDaysCount : null,
        fillRate: b.qtyOrdered > 0 ? b.qtyReceived / b.qtyOrdered : null,
        lastReceivedAt: b.lastReceivedAt,
      }))
      .sort((a, b) => b.totalSpend - a.totalSpend);

    return {
      rangeDays: days,
      rows,
      totalPos: rows.reduce((s, r) => s + r.totalPos, 0),
      totalSpend: rows.reduce((s, r) => s + r.totalSpend, 0),
      totalOpenValue: rows.reduce((s, r) => s + r.openValue, 0),
    };
  }

  /**
   * Cost history for a single item — the chronological unit_cost we have
   * committed to (PO lines) and actually paid (posted receipt lines) over
   * time, grouped per supplier. This is "what we've paid for this item",
   * built only from our OWN data; no scraping, no migration.
   *
   * Two sources are merged:
   *   - purchase_order_items.unit_cost, dated by the parent PO's
   *     ordered_at (fallback created_at) and attributed to the PO's
   *     supplier_id.
   *   - receipt_lines.unit_cost, dated by the parent receipt's received_at
   *     and attributed to the receipt's PO supplier_id.
   *
   * Org-scoping: purchase_order_items rows carry organization_id directly.
   * receipt_lines do NOT, so we org-scope them via their parent receipt
   * (and RLS enforces the same boundary regardless). We only consider
   * receipts in the 'posted' state — drafts/reversals aren't money we paid.
   */
  async itemCostHistory(itemId: string): Promise<ItemCostHistory> {
    // ── 1. PO lines: unit_cost committed at order time ──────────────────
    // purchase_order_items.organization_id is the authoritative org scope;
    // we embed the parent PO purely for its date + supplier attribution.
    // PostgREST caps responses at 1000 rows; page the full set (order/date
    // is applied in JS afterward, so fetch order is irrelevant — page by id).
    type PoLine = {
      id: string;
      unit_cost: number;
      purchase_order_id: string;
      po:
        | {
            id: string;
            supplier_id: string | null;
            ordered_at: string | null;
            created_at: string;
            supplier: { name: string } | { name: string }[] | null;
          }
        | {
            id: string;
            supplier_id: string | null;
            ordered_at: string | null;
            created_at: string;
            supplier: { name: string } | { name: string }[] | null;
          }[]
        | null;
    };
    const poRows = await fetchAllRows<PoLine>(
      (from, to) =>
        this.ctx.supabase
          .from('purchase_order_items')
          .select(
            `id, unit_cost, purchase_order_id,
         po:purchase_orders!purchase_order_id (
           id, supplier_id, ordered_at, created_at,
           supplier:suppliers!supplier_id (name)
         )`,
          )
          .eq('organization_id', this.ctx.organizationId)
          .eq('item_id', itemId)
          .order('id', { ascending: true })
          .range(from, to),
      { cap: 10_000 },
    );

    // ── 2. Receipt lines: unit_cost actually paid at receive time ───────
    // receipt_lines carry no organization_id, so scope through the parent
    // receipt's organization_id (RLS enforces this too). The supplier is
    // resolved off the receipt's PO.
    // PostgREST caps responses at 1000 rows; page the full set (no ordering
    // requirement — points are sorted by date in JS afterward — so page by id).
    type ReceiptLine = {
      id: string;
      unit_cost: number;
      item_id: string;
      receipt:
        | {
            id: string;
            organization_id: string;
            status: string;
            received_at: string;
            po:
              | { supplier_id: string | null; supplier: { name: string } | { name: string }[] | null }
              | { supplier_id: string | null; supplier: { name: string } | { name: string }[] | null }[]
              | null;
          }
        | {
            id: string;
            organization_id: string;
            status: string;
            received_at: string;
            po:
              | { supplier_id: string | null; supplier: { name: string } | { name: string }[] | null }
              | { supplier_id: string | null; supplier: { name: string } | { name: string }[] | null }[]
              | null;
          }[]
        | null;
    };
    const rcRows = await fetchAllRows<ReceiptLine>(
      (from, to) =>
        this.ctx.supabase
          .from('receipt_lines')
          .select(
            `id, unit_cost, item_id,
         receipt:receipts!receipt_id (
           id, organization_id, status, received_at,
           po:purchase_orders!purchase_order_id (
             supplier_id,
             supplier:suppliers!supplier_id (name)
           )
         )`,
          )
          .eq('item_id', itemId)
          .eq('receipt.organization_id', this.ctx.organizationId)
          .eq('receipt.status', 'posted')
          .order('id', { ascending: true })
          .range(from, to),
      { cap: 10_000 },
    );

    const NO_SUPPLIER = '__none';
    // Per-supplier accumulator: keep the display name + the raw points.
    const bySupplier = new Map<
      string,
      { supplierId: string; supplierName: string; points: CostHistoryPoint[] }
    >();
    const ensure = (id: string | null, name: string | null) => {
      const key = id ?? NO_SUPPLIER;
      let entry = bySupplier.get(key);
      if (!entry) {
        entry = {
          supplierId: key,
          supplierName: name?.trim() || 'No supplier',
          points: [],
        };
        bySupplier.set(key, entry);
      } else if ((!entry.supplierName || entry.supplierName === 'No supplier') && name?.trim()) {
        // Backfill a name if a later row carried one the first didn't.
        entry.supplierName = name.trim();
      }
      return entry;
    };

    let sum = 0;
    let count = 0;
    let lastDate: string | null = null;
    let lastUnitCost: number | null = null;
    const observe = (point: CostHistoryPoint, supplierId: string | null, supplierName: string | null) => {
      if (!Number.isFinite(point.unitCost)) return;
      ensure(supplierId, supplierName).points.push(point);
      sum += point.unitCost;
      count += 1;
      if (!lastDate || point.date > lastDate) {
        lastDate = point.date;
        lastUnitCost = point.unitCost;
      }
    };

    for (const r of poRows) {
      const po = Array.isArray(r.po) ? r.po[0] : r.po;
      if (!po) continue; // orphaned line (shouldn't happen with the NOT NULL FK)
      const supplier = Array.isArray(po.supplier) ? po.supplier[0] : po.supplier;
      const date = po.ordered_at ?? po.created_at;
      observe(
        { date, unitCost: Number(r.unit_cost) || 0, source: 'purchase_order' },
        po.supplier_id ?? null,
        supplier?.name ?? null,
      );
    }

    for (const r of rcRows) {
      const receipt = Array.isArray(r.receipt) ? r.receipt[0] : r.receipt;
      // Defensive: the .eq('receipt.organization_id', …) filter only
      // restricts the embedded join, so a row whose receipt was filtered
      // out comes back with receipt === null. Skip those.
      if (!receipt) continue;
      const po = Array.isArray(receipt.po) ? receipt.po[0] : receipt.po;
      const supplier = po ? (Array.isArray(po.supplier) ? po.supplier[0] : po.supplier) : null;
      observe(
        { date: receipt.received_at, unitCost: Number(r.unit_cost) || 0, source: 'receipt' },
        po?.supplier_id ?? null,
        supplier?.name ?? null,
      );
    }

    // Sort each supplier's points chronologically, then order suppliers by
    // their most-recent observation so the legend leads with the supplier
    // we bought from last.
    const series: SupplierCostSeries[] = [...bySupplier.values()]
      .map((s) => ({
        supplierId: s.supplierId,
        supplierName: s.supplierName,
        points: s.points.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
      }))
      .filter((s) => s.points.length > 0)
      .sort((a, b) => {
        const al = a.points[a.points.length - 1]!.date;
        const bl = b.points[b.points.length - 1]!.date;
        return al < bl ? 1 : al > bl ? -1 : 0;
      });

    return {
      itemId,
      series,
      lastUnitCost,
      avgUnitCost: count > 0 ? sum / count : null,
      pointCount: count,
    };
  }

  /**
   * ABC velocity classification — ranks items by total dollars-out
   * (sales + transfers + adjustments-down) over the last `days` days
   * and partitions them into A/B/C buckets:
   *   A = top 80% of total value moved (typically ~20% of items)
   *   B = next 15%
   *   C = bottom 5%
   * Items with no out-movement in the window are tagged 'D' (dead).
   *
   * Used to focus stocking effort on what's actually selling and to
   * surface inventory you're carrying for nothing.
   */
  async velocityClass(days = 90): Promise<VelocityClassReport> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    type ItemRow = {
      id: string;
      sku: string;
      name: string;
      quantity_on_hand: number;
      unit_cost: number;
      warehouse: { name: string } | { name: string }[] | null;
      category: { name: string } | { name: string }[] | null;
    };
    type MoveRow = {
      id: string;
      item_id: string;
      quantity_change: number;
      movement_type: string;
      created_at: string;
    };

    // PostgREST caps responses at 1000 rows; page both sets (pure aggregation
    // + JS sort by valueOut afterward, so fetch order is irrelevant — page by
    // id). The caps stay as the TRUE memory bound, not a silent 1000.
    const [movementRows, itemRows] = await Promise.all([
      fetchAllRows<MoveRow>(
        (from, to) =>
          this.ctx.supabase
            .from('stock_movements')
            .select('id, item_id, quantity_change, movement_type, created_at')
            .eq('organization_id', this.ctx.organizationId)
            .gte('created_at', since)
            .lt('quantity_change', 0) // out-movements only (negative)
            .order('id', { ascending: true })
            .range(from, to),
        { cap: 100_000 },
      ),
      fetchAllRows<ItemRow>(
        (from, to) =>
          this.ctx.supabase
            .from('inventory_items')
            .select(
              `id, sku, name, quantity_on_hand, unit_cost,
           warehouse:warehouses!warehouse_id (name),
           category:categories!category_id (name)`,
            )
            .eq('organization_id', this.ctx.organizationId)
            .is('deleted_at', null)
            .eq('status', 'active')
            .eq('is_rental', false)
            .or('is_bundle.is.null,is_bundle.eq.false')
            .order('id', { ascending: true })
            .range(from, to),
        { cap: 50_000 },
      ),
    ]);

    // Aggregate units-out and last-out per item.
    const unitsOutById = new Map<string, number>();
    const lastOutById = new Map<string, string>();
    for (const m of movementRows) {
      const prev = unitsOutById.get(m.item_id) ?? 0;
      unitsOutById.set(m.item_id, prev + Math.abs(Number(m.quantity_change) || 0));
      const prevDate = lastOutById.get(m.item_id);
      if (!prevDate || m.created_at > prevDate) {
        lastOutById.set(m.item_id, m.created_at);
      }
    }

    const rawRows = itemRows.map((r) => {
      const wh = Array.isArray(r.warehouse) ? r.warehouse[0] : r.warehouse;
      const cat = Array.isArray(r.category) ? r.category[0] : r.category;
      const unitsOut = unitsOutById.get(r.id) ?? 0;
      const cost = Number(r.unit_cost) || 0;
      return {
        itemId: r.id,
        sku: r.sku,
        name: r.name,
        warehouseName: wh?.name ?? null,
        categoryName: cat?.name ?? null,
        quantityOnHand: Number(r.quantity_on_hand) || 0,
        unitCost: cost,
        unitsOut,
        valueOut: unitsOut * cost,
        lastOutAt: lastOutById.get(r.id) ?? null,
      };
    });

    // Sort by valueOut descending so A items come first.
    rawRows.sort((a, b) => b.valueOut - a.valueOut);

    const totalValue = rawRows.reduce((s, r) => s + r.valueOut, 0);
    let runningValue = 0;

    const rows: VelocityClassRow[] = rawRows.map((r) => {
      let velocityClass: 'A' | 'B' | 'C' | 'D';
      if (r.valueOut === 0) {
        velocityClass = 'D';
      } else {
        runningValue += r.valueOut;
        const pct = totalValue > 0 ? runningValue / totalValue : 0;
        if (pct <= 0.8) velocityClass = 'A';
        else if (pct <= 0.95) velocityClass = 'B';
        else velocityClass = 'C';
      }
      return { ...r, velocityClass };
    });

    const summary = {
      A: rows.filter((r) => r.velocityClass === 'A').length,
      B: rows.filter((r) => r.velocityClass === 'B').length,
      C: rows.filter((r) => r.velocityClass === 'C').length,
      D: rows.filter((r) => r.velocityClass === 'D').length,
    };

    return {
      rangeDays: days,
      rows,
      summary,
      totalValueOut: totalValue,
    };
  }

  /**
   * Dead-stock report — items that haven't moved out in `days` days,
   * ranked by carrying cost (qty × unit_cost). The biggest dollar
   * targets to clear, donate, or write down. Mirrors what NetSuite +
   * Cin7 expose as "stale inventory" / "dead stock."
   */
  async deadStock(days = 90): Promise<DeadStockReport> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    type ItemRow = {
      id: string;
      sku: string;
      name: string;
      quantity_on_hand: number;
      unit_cost: number;
      created_at: string;
      warehouse: { name: string } | { name: string }[] | null;
      category: { name: string } | { name: string }[] | null;
    };

    // First pass: every item with on-hand > 0 in the org. PostgREST caps
    // responses at 1000 rows, so page the full set — otherwise an org with
    // >1000 stocked items only ever sees the first 1000.
    const itemList = await fetchAllRows<ItemRow>(
      (from, to) =>
        this.ctx.supabase
          .from('inventory_items')
          .select(
            `id, sku, name, quantity_on_hand, unit_cost, created_at,
         warehouse:warehouses!warehouse_id (name),
         category:categories!category_id (name)`,
          )
          .eq('organization_id', this.ctx.organizationId)
          .is('deleted_at', null)
          .eq('status', 'active')
          .eq('is_rental', false)
          .gt('quantity_on_hand', 0)
          .or('is_bundle.is.null,is_bundle.eq.false')
          .order('id', { ascending: true })
          .range(from, to),
      { cap: 50_000 },
    );
    const itemIds = itemList.map((i) => i.id);

    // Items that had ANY out-movement in the window — these are NOT dead.
    // Only `.has()` is read below, so the stored timestamp is incidental;
    // the order('created_at') was decorative. The cap previously truncated
    // which movements were seen (silently 1000), wrongly flagging active
    // items as dead. Paging the full window makes the dedup correct.
    const recentOut = new Set<string>();
    if (itemIds.length > 0) {
      // Batch the itemIds (URL length) and page each batch.
      const ITEM_ID_BATCH = 200;
      for (let i = 0; i < itemIds.length; i += ITEM_ID_BATCH) {
        const batch = itemIds.slice(i, i + ITEM_ID_BATCH);
        const moves = await fetchAllRows<{ id: string; item_id: string }>(
          (from, to) =>
            this.ctx.supabase
              .from('stock_movements')
              .select('id, item_id, created_at')
              .eq('organization_id', this.ctx.organizationId)
              .in('item_id', batch)
              .gte('created_at', since)
              .lt('quantity_change', 0)
              .order('id', { ascending: true })
              .range(from, to),
          { cap: 100_000 },
        );
        for (const m of moves) recentOut.add(m.item_id);
      }
    }

    const now = Date.now();
    const sinceMs = new Date(since).getTime();

    const rows: DeadStockRow[] = itemList
      .filter((r) => !recentOut.has(r.id))
      .map((r) => {
        const wh = Array.isArray(r.warehouse) ? r.warehouse[0] : r.warehouse;
        const cat = Array.isArray(r.category) ? r.category[0] : r.category;
        const qty = Number(r.quantity_on_hand) || 0;
        const cost = Number(r.unit_cost) || 0;
        const createdMs = new Date(r.created_at).getTime();
        const ageDays = Math.floor((now - createdMs) / (24 * 60 * 60 * 1000));
        // Days since last out — but we only know if it's older than the
        // window. Capped to "≥ days" to be honest about what we measured.
        const stagnantDays = Math.max(
          days,
          Math.floor((now - sinceMs) / (24 * 60 * 60 * 1000)),
        );
        return {
          itemId: r.id,
          sku: r.sku,
          name: r.name,
          warehouseName: wh?.name ?? null,
          categoryName: cat?.name ?? null,
          quantityOnHand: qty,
          unitCost: cost,
          carryingValue: qty * cost,
          ageDays,
          stagnantDays,
        };
      })
      .sort((a, b) => b.carryingValue - a.carryingValue);

    return {
      rangeDays: days,
      rows,
      totalCarryingValue: rows.reduce((s, r) => s + r.carryingValue, 0),
      itemCount: rows.length,
    };
  }

  /**
   * Bundle activity report — distributions over a date range, grouped
   * by bundle. Highlights what kits are actually moving and at what
   * cost (from the component side of the ledger).
   */
  async bundleActivity(days = 90): Promise<BundleActivityReport> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    type DistRow = {
      id: string;
      bundle_id: string;
      warehouse_id: string;
      quantity: number;
      distributed_at: string;
      shortage_recorded: boolean;
      bundle: { name: string; sku: string | null } | { name: string; sku: string | null }[] | null;
      warehouse: { name: string } | { name: string }[] | null;
    };

    // PostgREST caps responses at 1000 rows; page the full set. The report
    // aggregates by bundle and re-sorts by kitsOut, and lastRunAt is a max
    // comparison — so fetch order is irrelevant; page by id.
    const distList = await fetchAllRows<DistRow>(
      (from, to) =>
        this.ctx.supabase
          .from('bundle_distributions')
          .select(
            `id, bundle_id, warehouse_id, quantity, distributed_at,
         shortage_recorded,
         bundle:bundles!bundle_id (name, sku),
         warehouse:warehouses!warehouse_id (name)`,
          )
          .eq('organization_id', this.ctx.organizationId)
          .gte('distributed_at', since)
          .order('id', { ascending: true })
          .range(from, to),
      { cap: 10_000 },
    );
    const distIds = distList.map((d) => d.id);

    // Pull every component-draw movement linked to these distributions
    // so we can show the cost side of the ledger.
    const valueByDist = new Map<string, number>();
    if (distIds.length > 0) {
      type MoveRow = {
        id: string;
        reference_id: string;
        quantity_change: number;
        item_id: string;
        item: { unit_cost: number } | { unit_cost: number }[] | null;
      };
      // Likewise capped at 1000 by PostgREST — page the full window so the
      // component-cost rollup sums every draw, not just the first 1000.
      const moves = await fetchAllRows<MoveRow>(
        (from, to) =>
          this.ctx.supabase
            .from('stock_movements')
            .select(
              `id, reference_id, quantity_change, item_id,
           item:inventory_items!item_id (unit_cost)`,
            )
            .eq('organization_id', this.ctx.organizationId)
            .eq('reference_type', 'bundle')
            .eq('movement_type', 'bundle_distribution')
            .gte('created_at', since)
            .lt('quantity_change', 0)
            .order('id', { ascending: true })
            .range(from, to),
        { cap: 50_000 },
      );
      for (const m of moves) {
        const itemField = Array.isArray(m.item) ? m.item[0] : m.item;
        const cost = Number(itemField?.unit_cost ?? 0);
        const value = Math.abs(Number(m.quantity_change) || 0) * cost;
        // Reference IDs on bundle_distribution movements are the bundle id,
        // not the distribution id. We aggregate by bundle below instead.
        // (Kept for completeness; bundle aggregation is the canonical view.)
        valueByDist.set(
          m.reference_id,
          (valueByDist.get(m.reference_id) ?? 0) + value,
        );
      }
    }

    const byBundle = new Map<
      string,
      {
        bundleId: string;
        bundleName: string;
        bundleSku: string | null;
        runs: number;
        kitsOut: number;
        componentValueOut: number;
        warehouseRuns: Map<string, { name: string; runs: number }>;
        lastRunAt: string | null;
      }
    >();

    for (const d of distList) {
      const bundleField = Array.isArray(d.bundle) ? d.bundle[0] : d.bundle;
      const whField = Array.isArray(d.warehouse) ? d.warehouse[0] : d.warehouse;
      const bid = d.bundle_id;
      const acc = byBundle.get(bid) ?? {
        bundleId: bid,
        bundleName: bundleField?.name ?? 'Unknown bundle',
        bundleSku: bundleField?.sku ?? null,
        runs: 0,
        kitsOut: 0,
        componentValueOut: valueByDist.get(bid) ?? 0,
        warehouseRuns: new Map<string, { name: string; runs: number }>(),
        lastRunAt: null as string | null,
      };
      acc.runs += 1;
      acc.kitsOut += Number(d.quantity) || 0;
      const whAcc = acc.warehouseRuns.get(d.warehouse_id) ?? {
        name: whField?.name ?? '—',
        runs: 0,
      };
      whAcc.runs += 1;
      acc.warehouseRuns.set(d.warehouse_id, whAcc);
      if (!acc.lastRunAt || d.distributed_at > acc.lastRunAt) {
        acc.lastRunAt = d.distributed_at;
      }
      byBundle.set(bid, acc);
    }

    const rows: BundleActivityRow[] = Array.from(byBundle.values())
      .map((b) => {
        let topWh: { name: string; runs: number } | null = null;
        for (const v of b.warehouseRuns.values()) {
          if (!topWh || v.runs > topWh.runs) topWh = v;
        }
        return {
          bundleId: b.bundleId,
          bundleName: b.bundleName,
          bundleSku: b.bundleSku,
          runs: b.runs,
          kitsOut: b.kitsOut,
          componentValueOut: b.componentValueOut,
          topWarehouseName: topWh?.name ?? null,
          lastRunAt: b.lastRunAt,
        } satisfies BundleActivityRow;
      })
      .sort((a, b) => b.kitsOut - a.kitsOut);

    return {
      rangeDays: days,
      rows,
      totalRuns: rows.reduce((s, r) => s + r.runs, 0),
      totalKits: rows.reduce((s, r) => s + r.kitsOut, 0),
      totalValueOut: rows.reduce((s, r) => s + r.componentValueOut, 0),
    };
  }

  /**
   * Bundle shortages report — every component that ran short during a
   * bundle distribution in the window, grouped by item. Surfaces the
   * "we keep running out of X during distributions" pattern.
   */
  async bundleShortages(days = 90): Promise<BundleShortagesReport> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    type MoveRow = {
      id: string;
      item_id: string;
      notes: string | null;
      created_at: string;
      item: { id: string; name: string; sku: string } | { id: string; name: string; sku: string }[] | null;
    };

    // PostgREST caps responses at 1000 rows; page the full window so every
    // shortage event is counted. Rows aggregate by item and re-sort by
    // unitsShort (lastShortAt is a max comparison) — fetch order is
    // irrelevant; page by id.
    const moves = await fetchAllRows<MoveRow>(
      (from, to) =>
        this.ctx.supabase
          .from('stock_movements')
          .select(
            `id, item_id, notes, created_at,
         item:inventory_items!item_id (id, name, sku)`,
          )
          .eq('organization_id', this.ctx.organizationId)
          .eq('movement_type', 'bundle_shortage')
          .gte('created_at', since)
          .order('id', { ascending: true })
          .range(from, to),
      { cap: 5_000 },
    );

    const byItem = new Map<
      string,
      {
        itemId: string;
        itemName: string;
        itemSku: string;
        events: number;
        unitsShort: number;
        lastShortAt: string | null;
      }
    >();

    for (const m of moves) {
      const itemField = Array.isArray(m.item) ? m.item[0] : m.item;
      // Notes encode "short N units during bundle distribution" — grab
      // the leading number for the unitsShort count. Defensive: defaults
      // to 0 if notes were trimmed/absent.
      const num = m.notes ? Number(m.notes.match(/short\s+([\d.]+)/i)?.[1] ?? 0) : 0;
      const acc = byItem.get(m.item_id) ?? {
        itemId: m.item_id,
        itemName: itemField?.name ?? 'Unknown item',
        itemSku: itemField?.sku ?? '',
        events: 0,
        unitsShort: 0,
        lastShortAt: null as string | null,
      };
      acc.events += 1;
      acc.unitsShort += num;
      if (!acc.lastShortAt || m.created_at > acc.lastShortAt) {
        acc.lastShortAt = m.created_at;
      }
      byItem.set(m.item_id, acc);
    }

    const rows: BundleShortageRow[] = Array.from(byItem.values()).sort(
      (a, b) => b.unitsShort - a.unitsShort,
    );

    return {
      rangeDays: days,
      rows,
      totalEvents: rows.reduce((s, r) => s + r.events, 0),
      totalUnitsShort: rows.reduce((s, r) => s + r.unitsShort, 0),
    };
  }
}

export interface BundleActivityRow {
  bundleId: string;
  bundleName: string;
  bundleSku: string | null;
  runs: number;
  kitsOut: number;
  componentValueOut: number;
  topWarehouseName: string | null;
  lastRunAt: string | null;
}

export interface BundleActivityReport {
  rangeDays: number;
  rows: BundleActivityRow[];
  totalRuns: number;
  totalKits: number;
  totalValueOut: number;
}

export interface BundleShortageRow {
  itemId: string;
  itemName: string;
  itemSku: string;
  events: number;
  unitsShort: number;
  lastShortAt: string | null;
}

export interface BundleShortagesReport {
  rangeDays: number;
  rows: BundleShortageRow[];
  totalEvents: number;
  totalUnitsShort: number;
}
