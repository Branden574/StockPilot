import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';

import { audit } from './audit';
import { fetchAllRows } from './lib/paginate';
import {
  assertPermission,
  ServiceError,
  type ServiceContext,
} from './context';

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
  categoryName: string | null;
  supplierName: string | null;
  locationName: string | null;
}

export interface RestoreSnapshot {
  version: 1;
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
    category: unknown;
    supplier: unknown;
    location: unknown;
  };

  const rows = await fetchAllRows<Row>(
    (from, to) =>
      ctx.supabase
        .from('inventory_items')
        .select(
          'sku, name, barcode, description, unit_cost, retail_price, quantity_on_hand, reorder_point, reorder_quantity, unit_of_measure, status, item_type, category:category_id(name), supplier:supplier_id(name), location:primary_location_id(name)',
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
      categoryName: embed(r.category),
      supplierName: embed(r.supplier),
      locationName: embed(r.location),
    }));

  const snapshot: RestoreSnapshot = {
    version: 1,
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
