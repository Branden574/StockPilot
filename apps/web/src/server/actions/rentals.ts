'use server';

import { revalidatePath } from 'next/cache';
import { unstable_rethrow } from 'next/navigation';

import { ServiceError, withContext } from '@/server/services/context';
import { RentalsService } from '@/server/services/rentals';

import {
  createRentalSchema,
  markReturnedSchema,
  cancelRentalSchema,
  err,
  ok,
  type ActionResult,
} from '@stockpilot/core';

/**
 * One error mapping for the three rental actions. An internal_error's public
 * message is already the generic one (ServiceError, S13); its raw cause is
 * logged here. Anything that is not a ServiceError used to go back as its own
 * `message`, which is whatever the thrower wrote (a PostgREST string, a
 * network error); it now gets a fixed sentence and the cause stays in the
 * server log. A redirect from the auth context (a signed-out session) is
 * rethrown so it still redirects instead of reading as a failure.
 */
function toActionError<T>(e: unknown): ActionResult<T> {
  unstable_rethrow(e);
  if (e instanceof ServiceError) {
    if (e.code === 'internal_error') {
      console.error('[rentals] action failed', e.internalDetail ?? e.message);
    }
    return err(e.code, e.message);
  }
  console.error('[rentals] action failed', e);
  return err('internal_error', 'Something went wrong. Please try again.');
}

export async function createRentalAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  const parsed = createRentalSchema.safeParse(input);
  if (!parsed.success)
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  try {
    const svc = new RentalsService(await withContext());
    const result = await svc.create(parsed.data);
    revalidatePath('/dashboard/rentals');
    revalidatePath('/dashboard/orders/new');
    return ok(result);
  } catch (e) {
    return toActionError(e);
  }
}

export async function markRentalReturnedAction(
  input: unknown,
): Promise<ActionResult<void>> {
  const parsed = markReturnedSchema.safeParse(input);
  if (!parsed.success)
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  try {
    const svc = new RentalsService(await withContext());
    await svc.markReturned(parsed.data);
    revalidatePath('/dashboard/rentals');
    revalidatePath(`/dashboard/rentals/${parsed.data.id}`);
    revalidatePath('/dashboard/orders/new');
    return ok(undefined);
  } catch (e) {
    return toActionError(e);
  }
}

export async function cancelRentalAction(
  input: unknown,
): Promise<ActionResult<void>> {
  const parsed = cancelRentalSchema.safeParse(input);
  if (!parsed.success)
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  try {
    const svc = new RentalsService(await withContext());
    await svc.cancel(parsed.data);
    revalidatePath('/dashboard/rentals');
    revalidatePath(`/dashboard/rentals/${parsed.data.id}`);
    revalidatePath('/dashboard/orders/new');
    return ok(undefined);
  } catch (e) {
    return toActionError(e);
  }
}
