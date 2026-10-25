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

/**
 * The same boundary as actions/inventory.ts. A ServiceError's `details` is
 * app-authored structured metadata and goes to the page: the archive stock
 * guard's `locationHoldsStock` is what makes the Archive dialog offer "Archive
 * anyway" (locations-manager.tsx), and dropping it left only a toast. Never
 * for an internal_error, whose detail is raw database text (S13). Anything
 * that is not a ServiceError is logged here and answered with a generic
 * message, never its own text.
 */
function toResult<T>(error: unknown): ActionResult<T> {
  if (error instanceof ServiceError) {
    return err(
      error.code,
      error.message,
      error.code === 'internal_error' ? undefined : error.details,
    );
  }
  console.error(error);
  return err('internal_error', 'Something went wrong. Please try again.');
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
