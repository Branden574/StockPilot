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

    const rows: ValuationRow[] = (data ?? []).map((r) => {
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
        warehouseName: wh?.name ?? null,
        categoryName: cat?.name ?? null,
        quantityOnHand: qty,
        unitCost: cost,
        value: qty * cost,
      };
    });

    const byWh = new Map<string, { warehouseId: string | null; warehouseName: string; value: number; units: number }>();
    const byCat = new Map<string, { categoryId: string | null; categoryName: string; value: number; units: number }>();
    let totalValue = 0;
    let totalUnits = 0;
    for (const r of rows) {
      totalValue += r.value;
      totalUnits += r.quantityOnHand;
      const whKey = r.warehouseName ?? '__none';
      const whEntry = byWh.get(whKey) ?? {
        warehouseId: null,
        warehouseName: r.warehouseName ?? 'Unassigned',
        value: 0,
        units: 0,
      };
      whEntry.value += r.value;
      whEntry.units += r.quantityOnHand;
      byWh.set(whKey, whEntry);

      const catKey = r.categoryName ?? '__none';
      const catEntry = byCat.get(catKey) ?? {
        categoryId: null,
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
    const { data, error } = await this.ctx.supabase
      .from('stock_movements')
      .select(
        `id, item_id, movement_type, quantity_change, created_at,
         item:inventory_items!item_id (id, sku, name)`,
      )
      .eq('organization_id', this.ctx.organizationId)
      .gte('created_at', since)
      .order('created_at', { ascending: false });
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
      .order('created_at', { ascending: false });
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
      .order('created_at', { ascending: false });
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
}
