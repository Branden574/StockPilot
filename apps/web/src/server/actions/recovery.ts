'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { revalidateInventoryListForCurrentOrg } from '@/server/loaders/inventory-list';
import { RecoveryService, type RecoveryEntity } from '@/server/services/recovery';
import { ServiceError } from '@/server/services/context';
import { err, ok, type ActionResult } from '@stockpilot/core';

const ENTITY_VALUES = [
  'inventory_items',
  'categories',
  'locations',
  'suppliers',
] as const;

const restoreSchema = z.object({
  entity: z.enum(ENTITY_VALUES),
  id: z.string().uuid(),
});

export async function restoreDeletedAction(
  input: z.input<typeof restoreSchema>,
): Promise<ActionResult<{ id: string }>> {
  const parsed = restoreSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const svc = await RecoveryService.forCurrentUser();
    await svc.restore(parsed.data.entity as RecoveryEntity, parsed.data.id);
    revalidatePath('/dashboard/settings/recovery');
    revalidatePath('/dashboard/inventory');
    await revalidateInventoryListForCurrentOrg();
    revalidatePath('/dashboard/books');
    revalidatePath('/dashboard/categories');
    revalidatePath('/dashboard/locations');
    revalidatePath('/dashboard/suppliers');
    return ok({ id: parsed.data.id });
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}
