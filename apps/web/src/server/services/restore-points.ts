import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';

import { getWarehouseAccess } from '@/lib/auth/warehouse';

import { audit } from './audit';
import { fetchAllRows } from './lib/paginate';
import {
  assertCurrentAal2,
  assertPermission,
  ServiceError,
  type ServiceContext,
} from './context';
import { InventoryService } from './inventory';

import { planAllowsRestorePoints, type OrgBillingState } from '@stockpilot/core';

/**
 * Inventory Restore Points (migration 0178). Snapshots of an org's items +
 * stock that it can roll back to. Business tier and above. Snapshot capture +
 * listing + retention live here; the safe-reconcile restore is added in Phase 2.
 *
 * RLS on restore_points is admin-only READ; all writes use the service-role
 * admin client behind these gated functions.
 */

/** Keep the newest N snapshots per org (auto + manual + pre_restore). */
export const RETENTION = 30;
/** Max items captured per snapshot; over this `capped` is set + disclosed. */
export const SNAPSHOT_ITEM_CAP = 50_000;

/**
 * Snapshot payload format version. Bump whenever `SnapshotItem`'s shape
 * changes in a way that would corrupt a restore if the OLD shape were
 * reconciled with the NEW logic. v2 adds `charterId` (Model B: the same
 * (sku, bin_location) pair can legitimately exist under two different
 * charters — see 0008_warehouse_charters). A v1 snapshot has no charterId
 * on its items; matching it against today's charter-aware itemKey would
 * silently fail to match every live row (empty charter segment vs. the
 * row's real charter_id) and re-create everything as duplicates instead of
 * reconciling in place. `restoreSnapshot` refuses any snapshot whose
 * `version` doesn't match this constant rather than risk that.
 */
export const SNAPSHOT_FORMAT_VERSION = 2;

export type RestorePointKind = 'manual' | 'auto' | 'pre_restore';

export interface SnapshotItem {
  sku: string;
  name: string;
  barcode: string | null;
  description: string | null;
  unitCost: number;
  retailPrice: number;
  quantityOnHand: number;
  reorderPoint: number;
  reorderQuantity: number;
  unitOfMeasure: string;
  status: string;
  itemType: string;
  /** Raw warehouse id — needed to re-create an item that was deleted. */
  warehouseId: string | null;
  /** Part of the live uniqueness key (org, sku, bin_location) — see 0126. */
  binLocation: string | null;
  categoryName: string | null;
  supplierName: string | null;
  locationName: string | null;
  /**
   * Charter this placement row belonged to (null = generic/any-charter
   * stock). Model B allows the SAME (sku, bin_location) pair to exist
   * under two different charters as two distinct rows — without this,
   * itemKey() would collapse them onto one reconcile key.
   */
  charterId: string | null;
}

/**
 * Stable reconcile key matching the (sku, bin_location) uniqueness index,
 * charter-qualified. Model B allows two rows to share (sku, bin_location)
 * and differ only by charter_id (see 0008_warehouse_charters) — without the
 * charter segment, two distinct placements collapse onto one map entry and
 * a restore silently merges/drops one of them (only the last-registered
 * active row for that (sku, bin) ever gets reconciled).
 */
export function itemKey(sku: string, bin: string | null, charterId: string | null): string {
  return `${sku}␟${(bin ?? '').trim()}␟${charterId ?? ''}`;
}

export interface RestoreSnapshot {
  version: number;
  capturedAt: string;
  items: SnapshotItem[];
}

export interface RestorePointRow {
  id: string;
  createdAt: string;
  createdBy: string | null;
  kind: RestorePointKind;
  label: string | null;
  itemCount: number;
  capped: boolean;
}

function embed(value: unknown): string | null {
  // PostgREST embeds a to-one relation as an object (or array of one).
  const v = Array.isArray(value) ? value[0] : value;
  return v && typeof v === 'object' ? ((v as { name?: string | null }).name ?? null) : null;
}

/** Owner/admin + Business+ gate, shared by capture + restore. */
export async function assertRestorePointsAccess(ctx: ServiceContext): Promise<void> {
  assertPermission(ctx, 'organization:update'); // owner/admin floor (+ MFA gate)
  const { data: org, error } = await ctx.supabase
    .from('organizations')
    .select(
      'plan, access_tier, billing_arrangement, stripe_subscription_id, trial_ends_at, trial_tier',
    )
    .eq('id', ctx.organizationId)
    .single();
  if (error) throw new ServiceError('internal_error', error.message);
  if (!planAllowsRestorePoints((org as OrgBillingState | null) ?? { plan: null })) {
    throw new ServiceError(
      'plan_limit_exceeded',
      'Restore points are a Business feature. Upgrade to Business or above to enable them.',
    );
  }
}

/**
 * Capture a snapshot of the org's items + stock. Reads through the caller's RLS
 * client (own-org only); inserts the row via the service-role client (no insert
 * RLS policy). Prunes to the retention window. Returns the new snapshot's id +
 * counts.
 */
export async function createSnapshot(
  ctx: ServiceContext,
  opts: { kind: RestorePointKind; label?: string | null },
): Promise<{ id: string; itemCount: number; capped: boolean }> {
  await assertRestorePointsAccess(ctx);

  type Row = {
    sku: string | null;
    name: string;
    barcode: string | null;
    description: string | null;
    unit_cost: number | null;
    retail_price: number | null;
    quantity_on_hand: number | null;
    reorder_point: number | null;
    reorder_quantity: number | null;
    unit_of_measure: string | null;
    status: string | null;
    item_type: string | null;
    warehouse_id: string | null;
    bin_location: string | null;
    charter_id: string | null;
    category: unknown;
    supplier: unknown;
    location: unknown;
  };

  const rows = await fetchAllRows<Row>(
    (from, to) =>
      ctx.supabase
        .from('inventory_items')
        .select(
          'sku, name, barcode, description, unit_cost, retail_price, quantity_on_hand, reorder_point, reorder_quantity, unit_of_measure, status, item_type, warehouse_id, bin_location, charter_id, category:category_id(name), supplier:supplier_id(name), location:primary_location_id(name)',
        )
        .eq('organization_id', ctx.organizationId)
        .is('deleted_at', null)
        .order('id', { ascending: true })
        .range(from, to),
    { cap: SNAPSHOT_ITEM_CAP },
  );

  const capped = rows.length >= SNAPSHOT_ITEM_CAP;
  const items: SnapshotItem[] = rows
    .filter((r) => (r.sku ?? '').trim().length > 0) // sku is the restore key
    .map((r) => ({
      sku: (r.sku as string).trim(),
      name: r.name,
      barcode: r.barcode ?? null,
      description: r.description ?? null,
      unitCost: Number(r.unit_cost ?? 0),
      retailPrice: Number(r.retail_price ?? 0),
      quantityOnHand: Number(r.quantity_on_hand ?? 0),
      reorderPoint: Number(r.reorder_point ?? 0),
      reorderQuantity: Number(r.reorder_quantity ?? 0),
      unitOfMeasure: (r.unit_of_measure ?? '').trim() || 'unit',
      status: r.status ?? 'active',
      itemType: r.item_type ?? 'product',
      warehouseId: r.warehouse_id ?? null,
      binLocation: (r.bin_location ?? null) || null,
      categoryName: embed(r.category),
      supplierName: embed(r.supplier),
      locationName: embed(r.location),
      charterId: r.charter_id ?? null,
    }));

  const snapshot: RestoreSnapshot = {
    version: SNAPSHOT_FORMAT_VERSION,
    capturedAt: new Date().toISOString(),
    items,
  };

  const admin = createAdminClient();
  const { data: inserted, error: insErr } = await admin
    .from('restore_points')
    .insert({
      organization_id: ctx.organizationId,
      created_by: ctx.userId,
      kind: opts.kind,
      label: opts.label?.trim() || null,
      item_count: items.length,
      capped,
      snapshot,
    })
    .select('id')
    .single();
  if (insErr) throw new ServiceError('internal_error', insErr.message);
  const id = (inserted as { id: string }).id;

  await pruneSnapshots(admin, ctx.organizationId);

  void audit(
    {
      event: 'restore_point.created',
      entityType: 'restore_point',
      entityId: id,
      extra: { kind: opts.kind, itemCount: items.length, capped },
    },
    ctx,
  );

  return { id, itemCount: items.length, capped };
}

/** Lists snapshot METADATA (never the blob) for the Backups UI. RLS admin-only. */
export async function listSnapshots(ctx: ServiceContext): Promise<RestorePointRow[]> {
  await assertRestorePointsAccess(ctx);
  const { data, error } = await ctx.supabase
    .from('restore_points')
    .select('id, created_at, created_by, kind, label, item_count, capped')
    .eq('organization_id', ctx.organizationId)
    .order('created_at', { ascending: false })
    .limit(RETENTION * 2);
  if (error) throw new ServiceError('internal_error', error.message);
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    createdAt: r.created_at as string,
    createdBy: (r.created_by as string | null) ?? null,
    kind: r.kind as RestorePointKind,
    label: (r.label as string | null) ?? null,
    itemCount: (r.item_count as number | null) ?? 0,
    capped: Boolean(r.capped),
  }));
}

export interface RestoreResult {
  updated: number;
  recreated: number;
  quantityAdjusted: number;
  failures: number;
  /** Active items NOT in the snapshot — flagged, never auto-deleted. */
  extrasFlagged: number;
  extrasSample: string[];
  preRestoreId: string;
}

/** Phrase the operator must type to confirm a restore. */
export const RESTORE_CONFIRM_PHRASE = 'RESTORE';

/**
 * Safe-reconcile restore. Resets items + quantities to the snapshot, re-creates
 * missing items, posts ledger movements for quantity changes, and NEVER
 * auto-deletes items absent from the snapshot (they're flagged). Always takes a
 * `pre_restore` snapshot first, so the restore itself is undoable.
 *
 * Gated: owner/admin + Business+ (assertRestorePointsAccess) + a fresh MFA
 * step-up + the typed confirmation phrase.
 */
export async function restoreSnapshot(
  ctx: ServiceContext,
  opts: { id: string; confirm: string },
): Promise<RestoreResult> {
  await assertRestorePointsAccess(ctx);
  await assertCurrentAal2(ctx); // dangerous, irreversible-ish → fresh MFA step-up
  if (opts.confirm !== RESTORE_CONFIRM_PHRASE) {
    throw new ServiceError('validation_error', `Type ${RESTORE_CONFIRM_PHRASE} to confirm.`);
  }

  // Load the target snapshot blob (RLS admin-only read).
  const { data: row, error: rowErr } = await ctx.supabase
    .from('restore_points')
    .select('snapshot')
    .eq('id', opts.id)
    .eq('organization_id', ctx.organizationId)
    .maybeSingle();
  if (rowErr) throw new ServiceError('internal_error', rowErr.message);
  if (!row) throw new ServiceError('not_found', 'Restore point not found.');
  const snapshot = (row as { snapshot: RestoreSnapshot }).snapshot;
  // Refuse to reconcile a stale-format snapshot — see SNAPSHOT_FORMAT_VERSION.
  // A v1 snapshot's items have no charterId, so matching them against the
  // now-charter-aware itemKey would silently miss every live row and
  // re-create the whole org's inventory as duplicates instead of erroring.
  if (!snapshot || snapshot.version !== SNAPSHOT_FORMAT_VERSION) {
    throw new ServiceError(
      'validation_error',
      'This restore point was captured in an older format and can no longer be safely restored. It remains visible for reference; take a new restore point going forward.',
    );
  }
  const items = Array.isArray(snapshot.items) ? snapshot.items : [];

  // Auto-snapshot current state FIRST so this restore is itself undoable.
  const pre = await createSnapshot(ctx, { kind: 'pre_restore', label: 'Before restore' });

  // Resolve category/supplier name → id maps (create missing, best-effort).
  const categoryMap = await ensureRefMap(ctx, 'categories', uniqueNames(items, 'categoryName'));
  const supplierMap = await ensureRefMap(ctx, 'suppliers', uniqueNames(items, 'supplierName'));
  // Locations are warehouse-bound — match existing only, never create.
  const locationMap = await matchRefMap(ctx, 'locations', uniqueNames(items, 'locationName'));

  const fallbackWarehouseId =
    (await getWarehouseAccess(ctx)).primaryWarehouseId ?? null;

  // Current ACTIVE items keyed by (sku, bin_location, charter_id) —
  // matching the live uniqueness index (0126) plus the charter dimension
  // Model B adds (0008). A product at two racks — or the same rack under
  // two charters — is two distinct keys.
  const activeRows = await fetchAllRows<{
    id: string;
    sku: string | null;
    bin_location: string | null;
    quantity_on_hand: number | null;
    status: string | null;
    charter_id: string | null;
  }>((from, to) =>
    ctx.supabase
      .from('inventory_items')
      .select('id, sku, bin_location, quantity_on_hand, status, charter_id')
      .eq('organization_id', ctx.organizationId)
      .is('deleted_at', null)
      .order('id', { ascending: true })
      .range(from, to),
  );
  const byKey = new Map<string, { id: string; qty: number }>();
  const activeKeys = new Set<string>();
  for (const r of activeRows) {
    const sku = (r.sku ?? '').trim();
    if (!sku) continue;
    const k = itemKey(sku, r.bin_location, r.charter_id ?? null);
    activeKeys.add(k);
    byKey.set(k, { id: r.id, qty: Number(r.quantity_on_hand ?? 0) });
  }

  const svc = new InventoryService(ctx);
  let updated = 0;
  let recreated = 0;
  let quantityAdjusted = 0;
  let failures = 0;
  const snapshotKeys = new Set<string>();

  for (const it of items) {
    const sku = (it.sku ?? '').trim();
    if (!sku) continue;
    const key = itemKey(sku, it.binLocation, it.charterId ?? null);
    snapshotKeys.add(key);
    const categoryId = it.categoryName ? (categoryMap.get(it.categoryName.toLowerCase()) ?? null) : null;
    const supplierId = it.supplierName ? (supplierMap.get(it.supplierName.toLowerCase()) ?? null) : null;
    const primaryLocationId = it.locationName ? (locationMap.get(it.locationName.toLowerCase()) ?? null) : null;
    const finalStatus = it.status as 'active' | 'archived' | 'discontinued';

    try {
      const existing = byKey.get(key);
      if (existing) {
        // Reconcile fields, forcing 'active' first so the quantity reset (which
        // adjust_stock rejects on archived items) always works regardless of the
        // snapshot's final status.
        await svc.update(existing.id, {
          name: it.name,
          barcode: it.barcode,
          description: it.description,
          categoryId,
          supplierId,
          primaryLocationId,
          unitCost: it.unitCost,
          retailPrice: it.retailPrice,
          reorderPoint: it.reorderPoint,
          reorderQuantity: it.reorderQuantity,
          unitOfMeasure: it.unitOfMeasure,
          itemType: it.itemType as 'product' | 'book' | 'asset' | 'consumable',
          status: 'active',
        });
        const delta = it.quantityOnHand - existing.qty;
        if (delta !== 0) {
          await svc.adjustStock({
            itemId: existing.id,
            quantityChange: delta,
            movementType: 'adjust',
            reason: 'Restore point reconcile',
          });
          quantityAdjusted++;
        }
        // Apply the snapshot's final status last.
        if (finalStatus !== 'active') {
          await svc.update(existing.id, { status: finalStatus });
        }
        updated++;
      } else {
        // Missing (never existed or was deleted) → re-create, preserving the
        // bin AND charter so it doesn't collide with the (sku, bin) uniqueness
        // index and stays associated with the same charter it was placed
        // under (Model B: charter is per-row, not inferred).
        await svc.create({
          name: it.name,
          sku,
          barcode: it.barcode,
          description: it.description,
          binLocation: it.binLocation,
          charterId: it.charterId ?? null,
          categoryId,
          supplierId,
          primaryLocationId,
          warehouseId: it.warehouseId ?? fallbackWarehouseId,
          unitCost: it.unitCost,
          retailPrice: it.retailPrice,
          quantityOnHand: it.quantityOnHand,
          reorderPoint: it.reorderPoint,
          reorderQuantity: it.reorderQuantity,
          unitOfMeasure: it.unitOfMeasure,
          trackingType: 'none',
          itemType: it.itemType as 'product' | 'book' | 'asset' | 'consumable',
          customFields: {},
          status: finalStatus,
        });
        recreated++;
      }
    } catch {
      failures++;
    }
  }

  // Extras: active (sku,bin) keys not present in the snapshot — flagged, never deleted.
  const extras = [...activeKeys].filter((k) => !snapshotKeys.has(k));

  void audit(
    {
      event: 'restore_point.restored',
      entityType: 'restore_point',
      entityId: opts.id,
      extra: { updated, recreated, quantityAdjusted, failures, extras: extras.length, preRestoreId: pre.id },
    },
    ctx,
  );

  return {
    updated,
    recreated,
    quantityAdjusted,
    failures,
    extrasFlagged: extras.length,
    // surface the SKU (strip the internal sku␟bin key) for the operator report
    extrasSample: extras.slice(0, 50).map((k) => k.split('␟')[0] ?? k),
    preRestoreId: pre.id,
  };
}

function uniqueNames(items: SnapshotItem[], key: 'categoryName' | 'supplierName' | 'locationName'): string[] {
  const set = new Set<string>();
  for (const it of items) {
    const v = it[key];
    if (v && v.trim()) set.add(v.trim());
  }
  return [...set];
}

/** Match existing rows by name (case-insensitive); never create. */
async function matchRefMap(
  ctx: ServiceContext,
  table: 'categories' | 'suppliers' | 'locations',
  names: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (names.length === 0) return map;
  // Paginated — an org with >1000 categories/suppliers/locations would
  // otherwise silently miss matches (PostgREST cap) and mint duplicates.
  const rows = await fetchAllRows<{ id: string; name: string }>((from, to) =>
    ctx.supabase
      .from(table)
      .select('id, name')
      .eq('organization_id', ctx.organizationId)
      .is('deleted_at', null)
      .order('id', { ascending: true })
      .range(from, to),
  );
  for (const r of rows) {
    map.set(r.name.trim().toLowerCase(), r.id);
  }
  return map;
}

/** Match existing by name; create any missing (best-effort). categories/suppliers only. */
async function ensureRefMap(
  ctx: ServiceContext,
  table: 'categories' | 'suppliers',
  names: string[],
): Promise<Map<string, string>> {
  const map = await matchRefMap(ctx, table, names);
  for (const name of names) {
    const key = name.toLowerCase();
    if (map.has(key)) continue;
    try {
      const { data } = await ctx.supabase
        .from(table)
        .insert({ organization_id: ctx.organizationId, name })
        .select('id')
        .single();
      if (data) map.set(key, (data as { id: string }).id);
    } catch {
      /* best-effort: if we can't create the ref, items link to null */
    }
  }
  return map;
}

/** Keep the newest RETENTION snapshots for an org; delete older ones. */
export async function pruneSnapshots(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
): Promise<void> {
  const { data } = await admin
    .from('restore_points')
    .select('id')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false })
    .range(RETENTION, RETENTION + 999);
  const stale = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
  if (stale.length > 0) {
    await admin.from('restore_points').delete().in('id', stale);
  }
}
