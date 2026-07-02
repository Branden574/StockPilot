'use server';

import { revalidatePath } from 'next/cache';

import { revalidateInventoryListForCurrentOrg } from '@/server/loaders/inventory-list';
import { ServiceError } from '@/server/services/context';
import { InventoryService } from '@/server/services/inventory';

import {
  duplicateItemSchema,
  err,
  ok,
  type ActionResult,
  type DuplicateItemInput,
} from '@stockpilot/core';

export async function duplicateItemAction(
  input: DuplicateItemInput,
): Promise<ActionResult<{ id: string }>> {
  const parsed = duplicateItemSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const svc = await InventoryService.forCurrentUser();
    const id = await svc.duplicateItem(parsed.data);
    revalidatePath('/dashboard');
    revalidatePath('/dashboard/inventory');
    await revalidateInventoryListForCurrentOrg();
    revalidatePath('/dashboard/books');
    revalidatePath(`/dashboard/inventory/${parsed.data.originalId}`);
    return ok({ id });
  } catch (error) {
    if (error instanceof ServiceError) {
      return err(error.code, error.message);
    }
    console.error(error);
    return err('internal_error', error instanceof Error ? error.message : 'Unknown error');
  }
}
