'use server';

import { revalidatePath } from 'next/cache';

import { ServiceError } from '@/server/services/context';
import {
  createPoSchema,
  PurchaseOrdersService,
  type CreatePoInput,
} from '@/server/services/purchase-orders';

import { err, ok, type ActionResult } from '@stockpilot/core';

function toResult<T>(error: unknown): ActionResult<T> {
  if (error instanceof ServiceError) return err(error.code, error.message);
  console.error(error);
  return err('internal_error', error instanceof Error ? error.message : 'Unknown error');
}

export async function createPoAction(input: CreatePoInput): Promise<ActionResult<{ id: string }>> {
  const parsed = createPoSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  try {
    const svc = await PurchaseOrdersService.forCurrentUser();
    const result = await svc.create(parsed.data);
    revalidatePath('/dashboard/purchase-orders');
    return ok({ id: result.id });
  } catch (e) {
    return toResult(e);
  }
}

export async function updatePoStatusAction(id: string, status: 'draft' | 'ordered' | 'cancelled'): Promise<ActionResult<void>> {
  try {
    const svc = await PurchaseOrdersService.forCurrentUser();
    await svc.updateStatus(id, status);
    revalidatePath('/dashboard/purchase-orders');
    revalidatePath(`/dashboard/purchase-orders/${id}`);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

