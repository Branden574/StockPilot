'use server';

import { revalidatePath } from 'next/cache';

import { InventoryService } from '@/server/services/inventory';
import { ServiceError } from '@/server/services/context';

import {
  adjustStockSchema,
  createItemSchema,
  err,
  ok,
  transferStockSchema,
  updateItemSchema,
  type ActionResult,
  type AdjustStockInput,
  type CreateItemInput,
  type TransferStockInput,
  type UpdateItemInput,
} from '@stockpilot/core';

function toResult<T>(error: unknown): ActionResult<T> {
  if (error instanceof ServiceError) {
    return err(error.code, error.message);
  }
  console.error(error);
  return err('internal_error', error instanceof Error ? error.message : 'Unknown error');
}

export async function createItemAction(input: CreateItemInput): Promise<ActionResult<{ id: string }>> {
  const parsed = createItemSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const svc = await InventoryService.forCurrentUser();
    const item = await svc.create(parsed.data);
    revalidatePath('/dashboard');
    revalidatePath('/dashboard/inventory');
    revalidatePath('/dashboard/books');
    return ok({ id: item.id as string });
  } catch (e) {
    return toResult(e);
  }
}

export async function updateItemAction(
  id: string,
  input: UpdateItemInput,
): Promise<ActionResult<{ id: string }>> {
  const parsed = updateItemSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const svc = await InventoryService.forCurrentUser();
    await svc.update(id, parsed.data);
    revalidatePath('/dashboard/inventory');
    revalidatePath('/dashboard/books');
    revalidatePath(`/dashboard/inventory/${id}`);
    return ok({ id });
  } catch (e) {
    return toResult(e);
  }
}

export async function archiveItemAction(id: string): Promise<ActionResult<void>> {
  try {
    const svc = await InventoryService.forCurrentUser();
    await svc.archive(id);
    revalidatePath('/dashboard/inventory');
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

export async function deleteItemAction(id: string): Promise<ActionResult<void>> {
  try {
    const svc = await InventoryService.forCurrentUser();
    await svc.softDelete(id);
    revalidatePath('/dashboard/inventory');
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

export async function adjustStockAction(input: AdjustStockInput): Promise<ActionResult<void>> {
  const parsed = adjustStockSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const svc = await InventoryService.forCurrentUser();
    await svc.adjustStock(parsed.data);
    revalidatePath('/dashboard');
    revalidatePath('/dashboard/inventory');
    revalidatePath(`/dashboard/inventory/${parsed.data.itemId}`);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

export async function transferStockAction(input: TransferStockInput): Promise<ActionResult<void>> {
  const parsed = transferStockSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const svc = await InventoryService.forCurrentUser();
    await svc.transferStock(parsed.data);
    revalidatePath('/dashboard/inventory');
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}
