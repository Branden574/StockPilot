import 'server-only';

import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';

import { getWarehouseAccess } from '@/lib/auth/warehouse';

import { audit } from './audit';
import { writeInIdBatches } from './lib/fetch-by-ids';
import { fetchAllRows } from './lib/paginate';
import {
  assertCurrentAal2,
  assertPermission,
  ServiceError,
  type ServiceContext,
} from './context';
import { InventoryService } from './inventory';

import { can, planAllowsRestorePoints, type OrgBillingState } from '@stockpilot/core';

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

export type RestorePointKind = 'manual' | 'auto' | 'pre_restore';

export interface SnapshotItem {
  /**
   * The record's id (snapshot version 2, Ungroup D1). A restore matches by it
   * first, so a record whose SKU changed after the snapshot (an Ungroup, or a
   * SKU edit) keeps its stock once instead of being re-created under its old
   * SKU. Absent from version 1 snapshots, which restore by (SKU, bin) as before.
   */
  id?: string;
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
}

/** Stable reconcile key matching the (sku, bin_location) uniqueness index. */
function itemKey(sku: string, bin: string | null): string {
  return `${sku}␟${(bin ?? '').trim()}`;
}

export interface RestoreSnapshot {
  /** 1: items keyed by (SKU, bin) only. 2: each item also carries its id. */
  version: 1 | 2;
  capturedAt: string;
  items: SnapshotItem[];
}

/** The version new snapshots are written with (Ungroup D1: item ids). */
export const SNAPSHOT_VERSION = 2 as const;

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
    id: string;
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
    category: unknown;
    supplier: unknown;
    location: unknown;
  };

  const rows = await fetchAllRows<Row>(
    (from, to) =>
      ctx.supabase
        .from('inventory_items')
        .select(
          'id, sku, name, barcode, description, unit_cost, retail_price, quantity_on_hand, reorder_point, reorder_quantity, unit_of_measure, status, item_type, warehouse_id, bin_location, category:category_id(name), supplier:supplier_id(name), location:primary_location_id(name)',
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
      id: r.id,
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
    }));

  const snapshot: RestoreSnapshot = {
    version: SNAPSHOT_VERSION,
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
  const items = Array.isArray(snapshot?.items) ? snapshot.items : [];

  // A version 1 point (no ids) and the records Ungroup split after it (PR
  // stage, data review DATA-1): read before anything is written, so a failed
  // read refuses the restore instead of re-creating a split record.
  const splits =
    snapshot?.version !== SNAPSHOT_VERSION && typeof snapshot?.capturedAt === 'string'
      ? await readSplitsSince(ctx.organizationId, snapshot.capturedAt)
      : [];

  // Auto-snapshot current state FIRST so this restore is itself undoable.
  const pre = await createSnapshot(ctx, { kind: 'pre_restore', label: 'Before restore' });

  // Resolve category/supplier name → id maps (create missing, best-effort).
  const categoryMap = await ensureRefMap(ctx, 'categories', uniqueNames(items, 'categoryName'));
  const supplierMap = await ensureRefMap(ctx, 'suppliers', uniqueNames(items, 'supplierName'));
  // Locations are warehouse-bound — match existing only, never create.
  const locationMap = await matchRefMap(ctx, 'locations', uniqueNames(items, 'locationName'));

  const fallbackWarehouseId =
    (await getWarehouseAccess(ctx)).primaryWarehouseId ?? null;

  // Current ACTIVE items keyed by (sku, bin_location) — matching the live
  // uniqueness index (0126). A product at two racks = two distinct keys.
  // Version 2 snapshots (Ungroup D1) also match by id, first.
  const activeRows = await fetchAllRows<{
    id: string;
    sku: string | null;
    bin_location: string | null;
    quantity_on_hand: number | null;
    status: string | null;
  }>((from, to) =>
    ctx.supabase
      .from('inventory_items')
      .select('id, sku, bin_location, quantity_on_hand, status')
      .eq('organization_id', ctx.organizationId)
      .is('deleted_at', null)
      .order('id', { ascending: true })
      .range(from, to),
  );
  const byKey = new Map<string, { id: string; qty: number }>();
  const byId = new Map<string, { id: string; qty: number; sku: string }>();
  const activeKeys = new Set<string>();
  for (const r of activeRows) {
    const sku = (r.sku ?? '').trim();
    if (!sku) continue;
    const k = itemKey(sku, r.bin_location);
    activeKeys.add(k);
    byKey.set(k, { id: r.id, qty: Number(r.quantity_on_hand ?? 0) });
    byId.set(r.id, { id: r.id, qty: Number(r.quantity_on_hand ?? 0), sku });
  }

  // Version 2 (Ungroup D1): each item is matched by its id first. The
  // (SKU, bin) key is used only for an item whose record no longer exists:
  // to find a live record now holding that SKU and bin, or else to re-create
  // it. A key match never takes a record that the snapshot reconciles by its
  // own id, and never takes one record twice, so a record whose SKU changed
  // after the snapshot keeps its stock once. Version 1 (no ids) matches by
  // (SKU, bin) as before, and a record Ungroup split after the point is found
  // through its split (planSplitMatches, PR stage DATA-1).
  const byIdFirst = snapshot?.version === SNAPSHOT_VERSION;
  const reconciledById = new Set<string>(
    byIdFirst ? items.flatMap((it) => (it.id && byId.has(it.id) ? [it.id] : [])) : [],
  );
  const claimed = new Set<string>();
  const splitMatch = planSplitMatches(items, activeRows, byKey, splits);
  const matchFor = (it: SnapshotItem, key: string): { id: string; qty: number } | undefined => {
    if (!byIdFirst) return byKey.get(key) ?? splitMatch.get(it);
    const own = it.id ? byId.get(it.id) : undefined;
    if (own) return own;
    const other = byKey.get(key);
    if (!other || reconciledById.has(other.id) || claimed.has(other.id)) return undefined;
    return other;
  };

  const svc = new InventoryService(ctx);
  let updated = 0;
  let recreated = 0;
  let quantityAdjusted = 0;
  let failures = 0;
  const snapshotKeys = new Set<string>();

  for (const it of items) {
    const sku = (it.sku ?? '').trim();
    if (!sku) continue;
    const key = itemKey(sku, it.binLocation);
    snapshotKeys.add(key);
    const categoryId = it.categoryName ? (categoryMap.get(it.categoryName.toLowerCase()) ?? null) : null;
    const supplierId = it.supplierName ? (supplierMap.get(it.supplierName.toLowerCase()) ?? null) : null;
    const primaryLocationId = it.locationName ? (locationMap.get(it.locationName.toLowerCase()) ?? null) : null;
    const finalStatus = it.status as 'active' | 'archived' | 'discontinued';

    try {
      const existing = matchFor(it, key);
      if (existing) {
        claimed.add(existing.id);
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
        // Missing (never existed or was deleted) → re-create, preserving the bin
        // so it doesn't collide with the (sku, bin) uniqueness index.
        await svc.create({
          name: it.name,
          sku,
          barcode: it.barcode,
          description: it.description,
          binLocation: it.binLocation,
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

  // Extras: active records the snapshot did not reconcile — flagged, never
  // deleted. Version 1: (sku,bin) keys not present in the snapshot, except the
  // records found through their split. Version 2: records not matched by id or
  // by key (each listed by its SKU).
  const splitKeys = new Set([...splitMatch.values()].map((m) => m.key));
  const extras = byIdFirst
    ? [...byId.values()].filter((r) => !claimed.has(r.id)).map((r) => itemKey(r.sku, null))
    : [...activeKeys].filter((k) => !snapshotKeys.has(k) && !splitKeys.has(k));

  void audit(
    {
      event: 'restore_point.restored',
      entityType: 'restore_point',
      entityId: opts.id,
      extra: {
        updated,
        recreated,
        quantityAdjusted,
        failures,
        extras: extras.length,
        preRestoreId: pre.id,
        snapshotVersion: byIdFirst ? SNAPSHOT_VERSION : 1,
        ...(splitMatch.size > 0 ? { matchedBySplit: splitMatch.size } : {}),
      },
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

/** A record Ungroup split after a restore point, and the SKU it left. */
interface SplitSince {
  itemId: string;
  leftSku: string;
}

/**
 * The records Ungroup split after a version 1 restore point was taken (PR
 * stage, data review DATA-1): each inventory.item.ungrouped audit row names the
 * record and the SKU it left (written in the same transaction as the SKU
 * change, migration 0399), oldest first.
 *
 * Read with the service role, scoped to the caller's organization: the
 * restore's own gate (owner/admin floor, Business, a fresh MFA step-up and the
 * typed confirm) has already run, and audit_logs' read policy needs
 * activity_logs:read, which an override can take from an admin who may still
 * restore. Reading through their RLS would hand them back the double count.
 * Nothing read here is shown: the restore answers counts only.
 */
async function readSplitsSince(organizationId: string, since: string): Promise<SplitSince[]> {
  const admin = createAdminClient();
  const rows = await fetchAllRows<{ id: string; item_id: string | null; left_sku: string | null }>(
    (from, to) =>
      admin
        .from('audit_logs')
        .select('id, item_id:metadata->>entity_id, left_sku:metadata->>left_sku')
        .eq('organization_id', organizationId)
        .eq('event', 'inventory.item.ungrouped')
        .gt('created_at', since)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
  );
  return rows.flatMap((r) => {
    const leftSku = (r.left_sku ?? '').trim();
    return r.item_id && leftSku ? [{ itemId: r.item_id, leftSku }] : [];
  });
}

/**
 * Version 1 restore points only (PR stage, data review DATA-1): a snapshot item
 * with no live record at its (SKU, bin) may be a record Ungroup split after the
 * point. It takes the record that left that SKU, when that record is still live
 * on that same rack, so the restore reconciles it by id instead of re-creating
 * it under its old SKU (the restore never writes a SKU: it keeps the new one).
 * Decided before the restore writes anything, so a record is taken once: never
 * one the point already reconciles by its own (SKU, bin), never one another
 * item took, and the earliest split first. Version 2 points pass no splits.
 */
function planSplitMatches(
  items: SnapshotItem[],
  activeRows: Array<{
    id: string;
    sku: string | null;
    bin_location: string | null;
    quantity_on_hand: number | null;
  }>,
  byKey: Map<string, { id: string; qty: number }>,
  splits: SplitSince[],
): Map<SnapshotItem, { id: string; qty: number; key: string }> {
  const out = new Map<SnapshotItem, { id: string; qty: number; key: string }>();
  if (splits.length === 0) return out;
  const live = new Map(
    activeRows.map((r) => [
      r.id,
      {
        id: r.id,
        qty: Number(r.quantity_on_hand ?? 0),
        bin: (r.bin_location ?? '').trim(),
        key: itemKey((r.sku ?? '').trim(), r.bin_location),
      },
    ]),
  );
  const taken = new Set<string>();
  for (const it of items) {
    const sku = (it.sku ?? '').trim();
    const direct = sku ? byKey.get(itemKey(sku, it.binLocation)) : undefined;
    if (direct) taken.add(direct.id);
  }
  for (const it of items) {
    const sku = (it.sku ?? '').trim();
    if (!sku || byKey.has(itemKey(sku, it.binLocation))) continue;
    const bin = (it.binLocation ?? '').trim();
    for (const s of splits) {
      const rec = s.leftSku === sku && !taken.has(s.itemId) ? live.get(s.itemId) : undefined;
      if (!rec || rec.bin !== bin) continue;
      taken.add(rec.id);
      out.set(it, { id: rec.id, qty: rec.qty, key: rec.key });
      break;
    }
  }
  return out;
}

/** How many records the restore screen names before it counts the rest. */
export const SKU_CHANGES_NAMED = 10;
/** How many SKU-change audit rows the warning reads at most (oldest first). */
export const SKU_CHANGES_SCAN = 500;

export interface RestorePointSkuChange {
  itemId: string | null;
  /** The record's name now, or null when the caller cannot read it. */
  name: string | null;
  /** The SKU it had when the first change after the point was made. */
  before: string | null;
  /** Its SKU after the last change. */
  after: string | null;
  /** True when a SKU edit carried the records that shared it along (Model B). */
  shared: boolean;
}

export interface RestorePointSkuChanges {
  version: 1 | 2;
  changes: RestorePointSkuChange[];
  /** Records that changed SKU beyond the ones named. */
  more: number;
  /** The audit read stopped at SKU_CHANGES_SCAN rows: `more` is a floor. */
  truncated: boolean;
}

/**
 * Ungroup D1 (b): what the restore screen says BEFORE the typed confirm. A
 * version 1 snapshot (no record ids) restores by (SKU, bin), so a record whose
 * SKU was edited after it was taken is re-created under its old SKU with the
 * stock it had then, while the record with the new SKU stays and is flagged as
 * an extra. This names those records from the audit log: SKU edits
 * (changed_keys has 'sku'; a Model B edit's siblings followed it,
 * propagated_to_sku). A record Ungroup split is left out (PR stage, DATA-1):
 * the restore finds it through its inventory.item.ungrouped row. A version 2
 * snapshot matches by id, so it needs no warning and reads no audit log.
 *
 * Same gate as the restore (owner/admin floor + Business). Reads through the
 * caller's RLS. A failed audit read throws, and so does a caller who cannot
 * view the audit log (activity_logs:read): an error, never an all-clear.
 */
export async function restorePointSkuChanges(
  ctx: ServiceContext,
  id: string,
): Promise<RestorePointSkuChanges> {
  await assertRestorePointsAccess(ctx);
  const { data: point, error: pointErr } = await ctx.supabase
    .from('restore_points')
    .select('version:snapshot->version, captured_at:snapshot->>capturedAt, created_at')
    .eq('id', id)
    .eq('organization_id', ctx.organizationId)
    .maybeSingle();
  if (pointErr) throw new ServiceError('internal_error', pointErr.message);
  if (!point) throw new ServiceError('not_found', 'Restore point not found.');
  const p = point as { version: unknown; captured_at: string | null; created_at: string };
  if (Number(p.version) === SNAPSHOT_VERSION) {
    return { version: SNAPSHOT_VERSION, changes: [], more: 0, truncated: false };
  }
  // PR stage, data review DATA-1 (2): audit_logs' read policy (0279) needs
  // activity_logs:read, which an override can take from an admin who can still
  // open Backups & restore. Read through their RLS, the audit rows came back
  // empty and the screen showed no warning: an all-clear nobody checked. The
  // warning shows audit facts (which record had which SKU, and that a shared
  // SKU was carried along), so it is not read past that permission: the
  // check says it cannot run (the restore row says so, and Confirm still
  // works). The restore itself finds split records with the service role
  // (readSplitsSince) and shows nothing of what it read.
  if (!can(ctx, 'activity_logs:read')) {
    throw new ServiceError(
      'forbidden',
      'Checking for SKU changes reads the audit log, which you cannot view.',
      { reason: 'audit_log_hidden' },
    );
  }
  const since = p.captured_at ?? p.created_at;

  const { data: rows, error: auditErr } = await ctx.supabase
    .from('audit_logs')
    .select(
      'entity_id:metadata->>entity_id, event, before_sku:metadata->before->>sku, after_sku:metadata->after->>sku, propagated:metadata->>propagated_to_sku',
    )
    .eq('organization_id', ctx.organizationId)
    .in('event', ['inventory.item.updated', 'inventory.item.ungrouped'])
    .gt('created_at', since)
    .filter('metadata->changed_keys', 'cs', '["sku"]')
    .order('created_at', { ascending: true })
    .limit(SKU_CHANGES_SCAN);
  if (auditErr) throw new ServiceError('internal_error', auditErr.message);

  // PR stage, data review DATA-1 (3): a record Ungroup split is found through
  // its split when the point is restored (restoreSnapshot), so it is never
  // added again: leave it out, a later SKU edit of it included. What is named
  // is SKU edits of records that were not split.
  type Row = {
    entity_id: string | null;
    event: string;
    before_sku: string | null;
    after_sku: string | null;
    propagated: string | null;
  };
  const scanned = (rows ?? []) as Row[];
  const split = new Set(
    scanned.flatMap((r) =>
      r.event === 'inventory.item.ungrouped' && r.entity_id ? [r.entity_id] : [],
    ),
  );

  // One line per record: its SKU before the first change and after the last.
  const byItem = new Map<string, RestorePointSkuChange>();
  for (const r of scanned) {
    if (r.entity_id && split.has(r.entity_id)) continue;
    const key = r.entity_id ?? `${r.before_sku}\u0000${r.after_sku}`;
    const seen = byItem.get(key);
    if (seen) {
      seen.after = r.after_sku ?? seen.after;
      seen.shared ||= r.propagated != null;
    } else {
      byItem.set(key, {
        itemId: r.entity_id,
        name: null,
        before: r.before_sku,
        after: r.after_sku,
        shared: r.propagated != null,
      });
    }
  }
  const all = [...byItem.values()];
  const named = all.slice(0, SKU_CHANGES_NAMED);
  const ids = named.flatMap((c) => (c.itemId ? [c.itemId] : []));
  if (ids.length > 0) {
    const { data: names } = await ctx.supabase
      .from('inventory_items')
      .select('id, name, sku')
      .eq('organization_id', ctx.organizationId)
      // in-list-bound: at most SKU_CHANGES_NAMED (10) ids, the records named
      .in('id', ids);
    const nameById = new Map(
      ((names ?? []) as Array<{ id: string; name: string }>).map((n) => [n.id, n.name]),
    );
    for (const c of named) c.name = (c.itemId && nameById.get(c.itemId)) || null;
  }
  // update() writes propagated_to_sku whenever its Model B fan-out runs, even
  // when no other record had the SKU (PR stage, found by the D1 lab), so the
  // flag alone does not mean the siblings followed. Say so only when other
  // live records hold the record's new SKU now. A failed read keeps the flag:
  // the stronger warning.
  const afters = [...new Set(named.flatMap((c) => (c.shared && c.after ? [c.after] : [])))];
  if (afters.length > 0) {
    const { data: holders, error: holdersErr } = await ctx.supabase
      .from('inventory_items')
      .select('sku')
      .eq('organization_id', ctx.organizationId)
      .is('deleted_at', null)
      // in-list-bound: at most SKU_CHANGES_NAMED (10) SKUs, the named records' new SKUs
      .in('sku', afters);
    if (!holdersErr) {
      const held = new Map<string, number>();
      for (const h of (holders ?? []) as Array<{ sku: string }>)
        held.set(h.sku, (held.get(h.sku) ?? 0) + 1);
      for (const c of named) if (c.shared) c.shared = (c.after ? (held.get(c.after) ?? 0) : 0) > 1;
    }
  }
  return {
    version: 1,
    changes: named,
    more: all.length - named.length,
    truncated: scanned.length >= SKU_CHANGES_SCAN,
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
    // Batched (up to 1000 ids; one `.in()` past ~215 fails) and reported: the
    // error used to be ignored, so a prune that never ran went unnoticed.
    // Pruning is housekeeping, so a failure does not fail the snapshot.
    const prune = await writeInIdBatches(stale, (batch) =>
      admin.from('restore_points').delete().in('id', batch),
    );
    if (prune.error !== null) {
      void reportError(new Error(prune.error), {
        tag: 'restore_points.prune',
        level: 'warning',
        organizationId,
        extra: { pruned: prune.written.length, left: prune.notWritten.length },
      });
    }
  }
}
