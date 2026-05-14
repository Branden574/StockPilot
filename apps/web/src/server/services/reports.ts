import 'server-only';

import { ServiceError, withContext, type ServiceContext } from './context';

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
    const { data, error } = await this.ctx.supabase
      .from('inventory_items')
      .select(
        `id, sku, name, quantity_on_hand, unit_cost, warehouse_id, category_id,
         warehouse:warehouses!warehouse_id (name),
         category:categories!category_id (name)`,
      )
      .eq('organization_id', this.ctx.organizationId)
      .is('deleted_at', null)
      .eq('status', 'active')
      .order('quantity_on_hand', { ascending: false });
    if (error) throw new ServiceError('internal_error', error.message);

    // Hold each raw row alongside the warehouse_id / category_id needed to
    // bucket by id (not name). Two warehouses with the same name —
    // e.g. "Main" in two regions — must NOT collapse into one row.
    type Enriched = ValuationRow & { warehouseId: string | null; categoryId: string | null };
    const enriched: Enriched[] = (data ?? []).map((r) => {
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
    // Node memory and aggregate in JS. The summary is approximate
    // anyway (top movers, type breakdown) — a 50k sample is plenty
    // for ranking and totals at the rounding levels we display.
    const { data, error } = await this.ctx.supabase
      .from('stock_movements')
      .select(
        `id, item_id, movement_type, quantity_change, created_at,
         item:inventory_items!item_id (id, sku, name)`,
      )
      .eq('organization_id', this.ctx.organizationId)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(50_000);
    if (error) throw new ServiceError('internal_error', error.message);

    const byType = new Map<string, { count: number; totalQty: number }>();
    const perItem = new Map<
      string,
      { sku: string; name: string; totalIn: number; totalOut: number; movementCount: number }
    >();

    for (const r of (data ?? []) as Array<{
      id: string;
      item_id: string;
      movement_type: string;
      quantity_change: number;
      created_at: string;
      item: { id: string; sku: string; name: string } | { id: string; sku: string; name: string }[] | null;
    }>) {
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
      totalMovements: (data ?? []).length,
    };
  }

  /**
   * Items at or below their reorder_point. Includes the deficit (how many
   * units to bring back to the reorder quantity) and an estimated cost
   * to do so.
   */
  async reorderForecast(): Promise<ReorderForecast> {
    const { data, error } = await this.ctx.supabase
      .from('inventory_items')
      .select(
        `id, sku, name, quantity_on_hand, reorder_point, reorder_quantity, unit_cost, warehouse_id,
         warehouse:warehouses!warehouse_id (name)`,
      )
      .eq('organization_id', this.ctx.organizationId)
      .is('deleted_at', null)
      .eq('status', 'active')
      .gt('reorder_point', 0)
      .order('quantity_on_hand', { ascending: true });
    if (error) throw new ServiceError('internal_error', error.message);

    const rows: ReorderRow[] = [];
    let totalDeficit = 0;
    let totalEstimatedCost = 0;
    for (const r of (data ?? []) as Array<{
      id: string;
      sku: string;
      name: string;
      quantity_on_hand: number;
      reorder_point: number;
      reorder_quantity: number;
      unit_cost: number;
      warehouse_id: string | null;
      warehouse: { name: string } | { name: string }[] | null;
    }>) {
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
    // 50k cap — see movementSummary() for the rationale.
    const { data, error } = await this.ctx.supabase
      .from('stock_movements')
      .select(
        `id, item_id, movement_type, quantity_change, reason, notes, created_at,
         item:inventory_items!item_id (id, sku, name, unit_cost)`,
      )
      .eq('organization_id', this.ctx.organizationId)
      .eq('movement_type', 'adjust')
      .lt('quantity_change', 0)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(50_000);
    if (error) throw new ServiceError('internal_error', error.message);

    const rows: ShrinkageRow[] = [];
    let totalUnits = 0;
    let totalCost = 0;
    for (const r of (data ?? []) as Array<{
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
    }>) {
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

    const { data: pos, error: posErr } = await this.ctx.supabase
      .from('purchase_orders')
      .select(
        `id, supplier_id, status, ordered_at, expected_at, received_at,
         total, created_at,
         supplier:suppliers!supplier_id (name)`,
      )
      .eq('organization_id', this.ctx.organizationId)
      .not('supplier_id', 'is', null)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(50_000);
    if (posErr) throw new ServiceError('internal_error', posErr.message);

    const poList = (pos ?? []) as Array<{
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
    }>;

    const poIds = poList.map((p) => p.id);
    let poItems: Array<{
      purchase_order_id: string;
      quantity_ordered: number;
      quantity_received: number;
    }> = [];
    if (poIds.length > 0) {
      const { data: items, error: itemsErr } = await this.ctx.supabase
        .from('purchase_order_items')
        .select('purchase_order_id, quantity_ordered, quantity_received')
        .in('purchase_order_id', poIds);
      if (itemsErr) throw new ServiceError('internal_error', itemsErr.message);
      poItems = (items ?? []) as typeof poItems;
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

    const [movementsRes, itemsRes] = await Promise.all([
      this.ctx.supabase
        .from('stock_movements')
        .select('item_id, quantity_change, movement_type, created_at')
        .eq('organization_id', this.ctx.organizationId)
        .gte('created_at', since)
        .lt('quantity_change', 0)
        .limit(100_000), // out-movements only (negative); cap for memory safety
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
        .or('is_bundle.is.null,is_bundle.eq.false')
        .limit(50_000),
    ]);
    if (movementsRes.error)
      throw new ServiceError('internal_error', movementsRes.error.message);
    if (itemsRes.error)
      throw new ServiceError('internal_error', itemsRes.error.message);

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
      item_id: string;
      quantity_change: number;
      movement_type: string;
      created_at: string;
    };

    // Aggregate units-out and last-out per item.
    const unitsOutById = new Map<string, number>();
    const lastOutById = new Map<string, string>();
    for (const m of (movementsRes.data ?? []) as MoveRow[]) {
      const prev = unitsOutById.get(m.item_id) ?? 0;
      unitsOutById.set(m.item_id, prev + Math.abs(Number(m.quantity_change) || 0));
      const prevDate = lastOutById.get(m.item_id);
      if (!prevDate || m.created_at > prevDate) {
        lastOutById.set(m.item_id, m.created_at);
      }
    }

    const rawRows = ((itemsRes.data ?? []) as ItemRow[]).map((r) => {
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

    // First pass: every item with on-hand > 0 in the org.
    const { data: items, error: itemsErr } = await this.ctx.supabase
      .from('inventory_items')
      .select(
        `id, sku, name, quantity_on_hand, unit_cost, created_at,
         warehouse:warehouses!warehouse_id (name),
         category:categories!category_id (name)`,
      )
      .eq('organization_id', this.ctx.organizationId)
      .is('deleted_at', null)
      .eq('status', 'active')
      .gt('quantity_on_hand', 0)
      .or('is_bundle.is.null,is_bundle.eq.false');
    if (itemsErr) throw new ServiceError('internal_error', itemsErr.message);

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

    const itemList = (items ?? []) as ItemRow[];
    const itemIds = itemList.map((i) => i.id);

    // Most-recent out-movement per item in the window.
    const recentOut = new Map<string, string>();
    if (itemIds.length > 0) {
      const { data: moves } = await this.ctx.supabase
        .from('stock_movements')
        .select('item_id, created_at')
        .eq('organization_id', this.ctx.organizationId)
        .in('item_id', itemIds)
        .gte('created_at', since)
        .lt('quantity_change', 0)
        .order('created_at', { ascending: false })
        .limit(100_000);
      for (const m of (moves ?? []) as Array<{ item_id: string; created_at: string }>) {
        if (!recentOut.has(m.item_id)) recentOut.set(m.item_id, m.created_at);
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

    const { data: dists, error: distErr } = await this.ctx.supabase
      .from('bundle_distributions')
      .select(
        `id, bundle_id, warehouse_id, quantity, distributed_at,
         shortage_recorded,
         bundle:bundles!bundle_id (name, sku),
         warehouse:warehouses!warehouse_id (name)`,
      )
      .eq('organization_id', this.ctx.organizationId)
      .gte('distributed_at', since)
      .order('distributed_at', { ascending: false });
    if (distErr) throw new ServiceError('internal_error', distErr.message);

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

    const distList = (dists ?? []) as DistRow[];
    const distIds = distList.map((d) => d.id);

    // Pull every component-draw movement linked to these distributions
    // so we can show the cost side of the ledger.
    const valueByDist = new Map<string, number>();
    if (distIds.length > 0) {
      const { data: moves } = await this.ctx.supabase
        .from('stock_movements')
        .select(
          `reference_id, quantity_change, item_id,
           item:inventory_items!item_id (unit_cost)`,
        )
        .eq('organization_id', this.ctx.organizationId)
        .eq('reference_type', 'bundle')
        .eq('movement_type', 'bundle_distribution')
        .gte('created_at', since)
        .lt('quantity_change', 0)
        .limit(50_000);
      type MoveRow = {
        reference_id: string;
        quantity_change: number;
        item_id: string;
        item: { unit_cost: number } | { unit_cost: number }[] | null;
      };
      for (const m of (moves ?? []) as MoveRow[]) {
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

    const { data: moves, error } = await this.ctx.supabase
      .from('stock_movements')
      .select(
        `id, item_id, notes, created_at,
         item:inventory_items!item_id (id, name, sku)`,
      )
      .eq('organization_id', this.ctx.organizationId)
      .eq('movement_type', 'bundle_shortage')
      .gte('created_at', since)
      .order('created_at', { ascending: false });
    if (error) throw new ServiceError('internal_error', error.message);

    type MoveRow = {
      id: string;
      item_id: string;
      notes: string | null;
      created_at: string;
      item: { id: string; name: string; sku: string } | { id: string; name: string; sku: string }[] | null;
    };

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

    for (const m of (moves ?? []) as MoveRow[]) {
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
