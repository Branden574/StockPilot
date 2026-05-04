'use server';

import { revalidatePath } from 'next/cache';

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

export async function createWarehouseAction(
  input: CreateWarehouseInput,
): Promise<ActionResult<{ id: string }>> {
  const parsed = createWarehouseSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  try {
    const svc = await WarehousesService.forCurrentUser();
    const result = await svc.create(parsed.data);
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
    revalidatePath('/dashboard/admin/warehouses');
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}
