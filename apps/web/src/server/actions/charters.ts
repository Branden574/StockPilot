'use server';

import { revalidatePath } from 'next/cache';

import { ServiceError } from '@/server/services/context';
import {
  ChartersService,
  createCharterSchema,
  updateCharterSchema,
  type CreateCharterInput,
  type UpdateCharterInput,
} from '@/server/services/charters';

import { err, ok, type ActionResult } from '@stockpilot/core';

function toResult<T>(error: unknown): ActionResult<T> {
  if (error instanceof ServiceError) return err(error.code, error.message);
  console.error(error);
  return err('internal_error', error instanceof Error ? error.message : 'Unknown error');
}

export async function createCharterAction(
  input: CreateCharterInput,
): Promise<ActionResult<{ id: string }>> {
  const parsed = createCharterSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  try {
    const svc = await ChartersService.forCurrentUser();
    const result = await svc.create(parsed.data);
    revalidatePath('/dashboard/admin/charters');
    return ok(result);
  } catch (e) {
    return toResult(e);
  }
}

export async function updateCharterAction(
  id: string,
  input: UpdateCharterInput,
): Promise<ActionResult<void>> {
  const parsed = updateCharterSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  try {
    const svc = await ChartersService.forCurrentUser();
    await svc.update(id, parsed.data);
    revalidatePath('/dashboard/admin/charters');
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

export async function archiveCharterAction(id: string): Promise<ActionResult<void>> {
  try {
    const svc = await ChartersService.forCurrentUser();
    await svc.archive(id);
    revalidatePath('/dashboard/admin/charters');
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}
