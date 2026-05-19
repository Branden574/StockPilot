'use server';

import { revalidatePath } from 'next/cache';

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
    if (e instanceof ServiceError) return err(e.code, e.message);
    console.error(e);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
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
    if (e instanceof ServiceError) return err(e.code, e.message);
    console.error(e);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
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
    if (e instanceof ServiceError) return err(e.code, e.message);
    console.error(e);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}
