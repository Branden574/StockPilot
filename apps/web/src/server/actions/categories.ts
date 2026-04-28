'use server';

import { revalidatePath } from 'next/cache';

import {
  CategoriesService,
  createCategorySchema,
  updateCategorySchema,
  type CreateCategoryInput,
  type UpdateCategoryInput,
} from '@/server/services/categories';
import { ServiceError } from '@/server/services/context';

import { err, ok, type ActionResult } from '@stockpilot/core';

function toResult<T>(error: unknown): ActionResult<T> {
  if (error instanceof ServiceError) return err(error.code, error.message);
  console.error(error);
  return err('internal_error', error instanceof Error ? error.message : 'Unknown error');
}

export async function createCategoryAction(input: CreateCategoryInput): Promise<ActionResult<{ id: string }>> {
  const parsed = createCategorySchema.safeParse(input);
  if (!parsed.success) return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  try {
    const svc = await CategoriesService.forCurrentUser();
    const row = await svc.create(parsed.data);
    revalidatePath('/dashboard/categories');
    return ok({ id: row.id as string });
  } catch (e) {
    return toResult(e);
  }
}

export async function updateCategoryAction(
  id: string,
  input: UpdateCategoryInput,
): Promise<ActionResult<{ id: string }>> {
  const parsed = updateCategorySchema.safeParse(input);
  if (!parsed.success) return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  try {
    const svc = await CategoriesService.forCurrentUser();
    await svc.update(id, parsed.data);
    revalidatePath('/dashboard/categories');
    return ok({ id });
  } catch (e) {
    return toResult(e);
  }
}

export async function archiveCategoryAction(id: string): Promise<ActionResult<void>> {
  try {
    const svc = await CategoriesService.forCurrentUser();
    await svc.archive(id);
    revalidatePath('/dashboard/categories');
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}
