'use server';

import { revalidatePath, updateTag } from 'next/cache';

import { requireOrgContext } from '@/lib/auth/session';
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
async function invalidateOrgWarehouses() {
  try {
    const ctx = await requireOrgContext();
    updateTag(`dashboard-warehouses:${ctx.organizationId}`);
  } catch {
    // requireOrgContext() throws on unauthed; the underlying action
    // already failed in that case so nothing to invalidate.
  }
}

export async function createWarehouseAction(
  input: CreateWarehouseInput,
): Promise<ActionResult<{ id: string }>> {
  const parsed = createWarehouseSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  try {
    const svc = await WarehousesService.forCurrentUser();
    const result = await svc.create(parsed.data);
    await invalidateOrgWarehouses();
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
    await invalidateOrgWarehouses();
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
    await invalidateOrgWarehouses();
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
    await invalidateOrgWarehouses();
    revalidatePath('/dashboard/admin/warehouses');
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}
