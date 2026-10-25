'use server';

import { revalidatePath } from 'next/cache';

import { rethrowControlFlow } from '@/lib/control-flow';
import { revalidateInventoryListForCurrentOrg } from '@/server/loaders/inventory-list';
import { ServiceError } from '@/server/services/context';
import { InventoryService } from '@/server/services/inventory';

import {
  duplicateItemSchema,
  err,
  ok,
  type ActionResult,
  type DuplicateItemInput,
  type PlacementFailure,
} from '@stockpilot/core';

export async function duplicateItemAction(input: DuplicateItemInput): Promise<
  ActionResult<{
    id: string;
    placementFailed?: PlacementFailure;
    /** A book copy whose stock could not be moved to Unplaced (B28): where it was left. */
    stockLeftAt?: { locationName: string | null };
  }>
> {
  const parsed = duplicateItemSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const svc = await InventoryService.forCurrentUser();
    const { id, placementFailed, stockLeftAt } = await svc.duplicateItem(parsed.data);
    revalidatePath('/dashboard');
    revalidatePath('/dashboard/inventory');
    await revalidateInventoryListForCurrentOrg();
    revalidatePath('/dashboard/books');
    revalidatePath(`/dashboard/inventory/${parsed.data.originalId}`);
    // The copy exists either way. When its stock did not reach the rack the
    // dialog named, say so (2026-10-25), as createItemAction does; and when a
    // book copy's stock could not be moved to Unplaced, where it was left.
    return ok({
      id,
      ...(placementFailed ? { placementFailed } : {}),
      ...(stockLeftAt ? { stockLeftAt } : {}),
    });
  } catch (error) {
    rethrowControlFlow(error);
    if (error instanceof ServiceError) {
      // `details` is app-authored and forwarded: the new-rack question rides
      // it ("Create new rack 1-B?", 2026-10-24), and without it the dialog
      // could only show a sentence it cannot answer. Except for
      // internal_error, whose detail is raw database text that stays on the
      // server (S13), the same rule as the inventory actions' toResult.
      return err(
        error.code,
        error.message,
        error.code === 'internal_error' ? undefined : error.details,
      );
    }
    console.error(error);
    // Never a raw exception message (database or network internals) to the
    // client. It used to return error.message here.
    return err('internal_error', 'Something went wrong. Please try again.');
  }
}
