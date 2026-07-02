'use server';

import { revalidatePath } from 'next/cache';

import {
  createSupplierSchema,
  SuppliersService,
  updateSupplierSchema,
  type CreateSupplierInput,
  type UpdateSupplierInput,
} from '@/server/services/suppliers';
import { revalidateInventoryListForCurrentOrg } from '@/server/loaders/inventory-list';
import { ServiceError } from '@/server/services/context';

import { err, ok, type ActionResult } from '@stockpilot/core';

function toResult<T>(error: unknown): ActionResult<T> {
  if (error instanceof ServiceError) return err(error.code, error.message);
  console.error(error);
  return err('internal_error', error instanceof Error ? error.message : 'Unknown error');
}

export async function createSupplierAction(input: CreateSupplierInput): Promise<ActionResult<{ id: string }>> {
  const parsed = createSupplierSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  try {
    const svc = await SuppliersService.forCurrentUser();
    const row = await svc.create(parsed.data);
    revalidatePath('/dashboard/suppliers');
    await revalidateInventoryListForCurrentOrg();
    return ok({ id: row.id as string });
  } catch (e) {
    return toResult(e);
  }
}

export async function updateSupplierAction(
  id: string,
  input: UpdateSupplierInput,
): Promise<ActionResult<{ id: string }>> {
  const parsed = updateSupplierSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  try {
    const svc = await SuppliersService.forCurrentUser();
    await svc.update(id, parsed.data);
    revalidatePath('/dashboard/suppliers');
    await revalidateInventoryListForCurrentOrg();
    return ok({ id });
  } catch (e) {
    return toResult(e);
  }
}

export async function archiveSupplierAction(id: string): Promise<ActionResult<void>> {
  try {
    const svc = await SuppliersService.forCurrentUser();
    await svc.archive(id);
    revalidatePath('/dashboard/suppliers');
    await revalidateInventoryListForCurrentOrg();
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

export async function restoreSupplierAction(id: string): Promise<ActionResult<void>> {
  try {
    const svc = await SuppliersService.forCurrentUser();
    await svc.restore(id);
    revalidatePath('/dashboard/suppliers');
    await revalidateInventoryListForCurrentOrg();
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}
