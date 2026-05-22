'use server';

import { revalidatePath, updateTag } from 'next/cache';

import { ServiceError } from '@/server/services/context';
import {
  WarehousesService,
  createWarehouseSchema,
  updateWarehouseSchema,
  type CreateWarehouseInput,
  type UpdateWarehouseInput,
} from '@/server/services/warehouses';

import { err, ok, type ActionResult } from '@stockpilot/core';

function toResult<T>(error: unknown): ActionResult<T> {
  if (error instanceof ServiceError) return err(error.code, error.message);
  console.error(error);
  return err('internal_error', error instanceof Error ? error.message : 'Unknown error');
}

/**
 * Invalidate the cached warehouse list that the dashboard layout reads
 * via `getCachedOrgWarehouses` (lib/dashboard/cached-org.ts). Called
 * after every warehouse create/update/archive/restore so the topbar
 * dropdown picks up the change immediately on next nav instead of
 * waiting up to 5min for the TTL.
 */
function invalidateOrgWarehouses() {
  // Single cross-org tag (matches the static tag declared on the
  // unstable_cache wrapper in lib/dashboard/cached-org.ts). Next.js
  // 16's unstable_cache uses static tags — invalidating one tag
  // refreshes all per-org cache entries that share it, which is the
  // intended tradeoff for cache simplicity vs strict per-tenant
  // isolation. Org settings change rarely, so refreshing a few
  // sibling orgs alongside is cheap.
  updateTag('dashboard-warehouses');
}

export async function createWarehouseAction(
  input: CreateWarehouseInput,
): Promise<ActionResult<{ id: string }>> {
  const parsed = createWarehouseSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  try {
    const svc = await WarehousesService.forCurrentUser();
    const result = await svc.create(parsed.data);
    invalidateOrgWarehouses();
    revalidatePath('/dashboard/admin/warehouses');
    return ok(result);
  } catch (e) {
    return toResult(e);
  }
}

export async function updateWarehouseAction(
  id: string,
  input: UpdateWarehouseInput,
): Promise<ActionResult<void>> {
  const parsed = updateWarehouseSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  try {
    const svc = await WarehousesService.forCurrentUser();
    await svc.update(id, parsed.data);
    invalidateOrgWarehouses();
    revalidatePath('/dashboard/admin/warehouses');
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

export async function archiveWarehouseAction(id: string): Promise<ActionResult<void>> {
  try {
    const svc = await WarehousesService.forCurrentUser();
    await svc.archive(id);
    invalidateOrgWarehouses();
    revalidatePath('/dashboard/admin/warehouses');
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

export async function restoreWarehouseAction(id: string): Promise<ActionResult<void>> {
  try {
    const svc = await WarehousesService.forCurrentUser();
    await svc.restore(id);
    invalidateOrgWarehouses();
    revalidatePath('/dashboard/admin/warehouses');
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}
