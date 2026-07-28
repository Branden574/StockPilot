'use server';

import { revalidatePath } from 'next/cache';

import {
  CategoriesService,
  createCategorySchema,
  updateCategorySchema,
  type CreateCategoryInput,
  type UpdateCategoryInput,
} from '@/server/services/categories';
import { revalidateInventoryListForCurrentOrg } from '@/server/loaders/inventory-list';
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
    await revalidateInventoryListForCurrentOrg();
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
    await revalidateInventoryListForCurrentOrg();
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
    await revalidateInventoryListForCurrentOrg();
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

export async function restoreCategoryAction(id: string): Promise<ActionResult<void>> {
  try {
    const svc = await CategoriesService.forCurrentUser();
    await svc.restore(id);
    revalidatePath('/dashboard/categories');
    await revalidateInventoryListForCurrentOrg();
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

/**
 * "Set up Sports" (Task 12): creates the Sports root category plus the eight
 * built-in subcategories. The service re-asserts `sports:manage` and the
 * `sports` module — this action is not itself a gate, just the seam.
 */
export async function setupSportsCategoriesAction(): Promise<
  ActionResult<{ rootId: string; created: string[]; skipped: string[] }>
> {
  try {
    const svc = await CategoriesService.forCurrentUser();
    const result = await svc.setupSportsDefaults();
    revalidatePath('/dashboard/categories');
    await revalidateInventoryListForCurrentOrg();
    return ok(result);
  } catch (e) {
    return toResult(e);
  }
}
