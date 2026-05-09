import { getDb } from './db';

/**
 * Cached-read helpers that wrap SQLite queries with typed shapes.
 * Used by the per-task scanner screens (receive, count, distribute) so
 * a flaky network never blocks resolving a scanned code.
 */

export interface CachedItem {
  id: string;
  sku: string;
  name: string;
  barcode: string | null;
  quantityOnHand: number;
  unitCost: number;
  warehouseId: string | null;
  itemType: string | null;
}

export async function findItemByCode(code: string): Promise<CachedItem | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{
    id: string;
    sku: string;
    name: string;
    barcode: string | null;
    quantity_on_hand: number;
    unit_cost: number;
    warehouse_id: string | null;
    item_type: string | null;
  }>(
    `select id, sku, name, barcode, quantity_on_hand, unit_cost,
            warehouse_id, item_type
     from items
     where barcode = ? or sku = ?
     limit 1`,
    [code, code],
  );
  return row ? mapItem(row) : null;
}

export async function getItemById(id: string): Promise<CachedItem | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{
    id: string;
    sku: string;
    name: string;
    barcode: string | null;
    quantity_on_hand: number;
    unit_cost: number;
    warehouse_id: string | null;
    item_type: string | null;
  }>(
    `select id, sku, name, barcode, quantity_on_hand, unit_cost,
            warehouse_id, item_type
     from items where id = ?`,
    [id],
  );
  return row ? mapItem(row) : null;
}

export interface CachedPo {
  id: string;
  poNumber: string | null;
  status: string;
  warehouseId: string | null;
  expectedAt: string | null;
}

export interface CachedPoLine {
  id: string;
  poId: string;
  itemId: string;
  qtyOrdered: number;
  qtyReceived: number;
  unitCost: number;
}

export async function listOpenPos(): Promise<CachedPo[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    id: string;
    po_number: string | null;
    status: string;
    warehouse_id: string | null;
    expected_at: string | null;
  }>(
    `select id, po_number, status, warehouse_id, expected_at
     from purchase_orders
     order by expected_at asc nulls last`,
  );
  return rows.map((r) => ({
    id: r.id,
    poNumber: r.po_number,
    status: r.status,
    warehouseId: r.warehouse_id,
    expectedAt: r.expected_at,
  }));
}

export async function getPoLines(poId: string): Promise<CachedPoLine[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    id: string;
    po_id: string;
    item_id: string;
    qty_ordered: number;
    qty_received: number;
    unit_cost: number;
  }>(`select * from po_lines where po_id = ?`, [poId]);
  return rows.map((r) => ({
    id: r.id,
    poId: r.po_id,
    itemId: r.item_id,
    qtyOrdered: r.qty_ordered,
    qtyReceived: r.qty_received,
    unitCost: r.unit_cost,
  }));
}

export interface CachedCycleCount {
  id: string;
  status: string;
  warehouseId: string | null;
  startedAt: string;
  notes: string | null;
}

export interface CachedCycleCountLine {
  id: string;
  countId: string;
  itemId: string;
  expected: number;
  counted: number | null;
}

export async function listOpenCycleCounts(): Promise<CachedCycleCount[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    id: string;
    status: string;
    warehouse_id: string | null;
    started_at: string;
    notes: string | null;
  }>(
    `select id, status, warehouse_id, started_at, notes
     from cycle_counts
     order by started_at desc`,
  );
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    warehouseId: r.warehouse_id,
    startedAt: r.started_at,
    notes: r.notes,
  }));
}

export async function getCycleCountLines(
  countId: string,
): Promise<CachedCycleCountLine[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    id: string;
    count_id: string;
    item_id: string;
    expected: number;
    counted: number | null;
  }>(`select * from cycle_count_lines where count_id = ?`, [countId]);
  return rows.map((r) => ({
    id: r.id,
    countId: r.count_id,
    itemId: r.item_id,
    expected: r.expected,
    counted: r.counted,
  }));
}

export interface CachedBundle {
  id: string;
  name: string;
  sku: string | null;
  preassemblyEnabled: boolean;
  phantomQty: number;
  phantomWarehouseId: string | null;
}

export interface CachedBundleComponent {
  bundleId: string;
  itemId: string;
  quantity: number;
  isOptional: boolean;
}

export async function listBundles(): Promise<CachedBundle[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    id: string;
    name: string;
    sku: string | null;
    preassembly_enabled: number;
    phantom_qty: number;
    phantom_warehouse_id: string | null;
  }>(`select * from bundles order by name asc`);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    sku: r.sku,
    preassemblyEnabled: r.preassembly_enabled === 1,
    phantomQty: r.phantom_qty,
    phantomWarehouseId: r.phantom_warehouse_id,
  }));
}

export async function getBundleComponents(
  bundleId: string,
): Promise<CachedBundleComponent[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    bundle_id: string;
    item_id: string;
    quantity: number;
    is_optional: number;
  }>(`select * from bundle_components where bundle_id = ?`, [bundleId]);
  return rows.map((r) => ({
    bundleId: r.bundle_id,
    itemId: r.item_id,
    quantity: r.quantity,
    isOptional: r.is_optional === 1,
  }));
}

export interface CachedWarehouse {
  id: string;
  name: string;
}

export async function listWarehouses(): Promise<CachedWarehouse[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ id: string; name: string }>(
    `select * from warehouses order by name asc`,
  );
  return rows;
}

function mapItem(r: {
  id: string;
  sku: string;
  name: string;
  barcode: string | null;
  quantity_on_hand: number;
  unit_cost: number;
  warehouse_id: string | null;
  item_type: string | null;
}): CachedItem {
  return {
    id: r.id,
    sku: r.sku,
    name: r.name,
    barcode: r.barcode,
    quantityOnHand: r.quantity_on_hand,
    unitCost: r.unit_cost,
    warehouseId: r.warehouse_id,
    itemType: r.item_type,
  };
}
