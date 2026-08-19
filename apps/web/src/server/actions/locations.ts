'use server';

import { revalidatePath } from 'next/cache';

import {
  createLocationSchema,
  LocationsService,
  updateLocationSchema,
  type CreateLocationInput,
  type UpdateLocationInput,
} from '@/server/services/locations';
import { revalidateInventoryListForCurrentOrg } from '@/server/loaders/inventory-list';
import { ServiceError } from '@/server/services/context';

import { err, ok, type ActionResult } from '@stockpilot/core';

function toResult<T>(error: unknown): ActionResult<T> {
  if (error instanceof ServiceError) return err(error.code, error.message);
  console.error(error);
  return err('internal_error', error instanceof Error ? error.message : 'Unknown error');
}

export async function createLocationAction(input: CreateLocationInput): Promise<ActionResult<{ id: string }>> {
  const parsed = createLocationSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  try {
    const svc = await LocationsService.forCurrentUser();
    const row = await svc.create(parsed.data);
    revalidatePath('/dashboard/locations');
    await revalidateInventoryListForCurrentOrg();
    return ok({ id: row.id as string });
  } catch (e) {
    return toResult(e);
  }
}

export async function updateLocationAction(
  id: string,
  input: UpdateLocationInput,
): Promise<ActionResult<{ id: string }>> {
  const parsed = updateLocationSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  try {
    const svc = await LocationsService.forCurrentUser();
    await svc.update(id, parsed.data);
    revalidatePath('/dashboard/locations');
    await revalidateInventoryListForCurrentOrg();
    return ok({ id });
  } catch (e) {
    return toResult(e);
  }
}

/**
 * `acknowledgeStock` is the deliberate-decommission override for the archive
 * stock guard. Omitted/false is the safe default: the service refuses and names
 * the units and the items holding them, and the UI only offers the override
 * once the operator has read that refusal.
 */
export async function archiveLocationAction(
  id: string,
  opts: { acknowledgeStock?: boolean } = {},
): Promise<ActionResult<void>> {
  try {
    const svc = await LocationsService.forCurrentUser();
    await svc.archive(id, { acknowledgeStock: opts.acknowledgeStock === true });
    revalidatePath('/dashboard/locations');
    await revalidateInventoryListForCurrentOrg();
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

export async function restoreLocationAction(id: string): Promise<ActionResult<void>> {
  try {
    const svc = await LocationsService.forCurrentUser();
    await svc.restore(id);
    revalidatePath('/dashboard/locations');
    await revalidateInventoryListForCurrentOrg();
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}
