'use server';

import { revalidatePath } from 'next/cache';

import { ServiceError } from '@/server/services/context';
import { TagsService, type TagRow } from '@/server/services/tags';

import {
  createTagSchema,
  err,
  ok,
  setItemTagsSchema,
  updateTagSchema,
  type ActionResult,
  type CreateTagInput,
  type SetItemTagsInput,
  type UpdateTagInput,
} from '@stockpilot/core';

function toResult<T>(error: unknown): ActionResult<T> {
  if (error instanceof ServiceError) return err(error.code, error.message);
  console.error(error);
  return err('internal_error', error instanceof Error ? error.message : 'Unknown error');
}

export async function createTagAction(
  input: CreateTagInput,
): Promise<ActionResult<TagRow>> {
  const parsed = createTagSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const svc = await TagsService.forCurrentUser();
    const row = await svc.create(parsed.data);
    revalidatePath('/dashboard/tags');
    return ok(row);
  } catch (e) {
    return toResult(e);
  }
}

export async function updateTagAction(
  id: string,
  input: UpdateTagInput,
): Promise<ActionResult<TagRow>> {
  const parsed = updateTagSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const svc = await TagsService.forCurrentUser();
    const row = await svc.update(id, parsed.data);
    revalidatePath('/dashboard/tags');
    return ok(row);
  } catch (e) {
    return toResult(e);
  }
}

export async function deleteTagAction(id: string): Promise<ActionResult<void>> {
  try {
    const svc = await TagsService.forCurrentUser();
    await svc.delete(id);
    revalidatePath('/dashboard/tags');
    revalidatePath('/dashboard/inventory');
    revalidatePath('/dashboard/books');
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

export async function setItemTagsAction(
  itemId: string,
  tagIds: string[],
): Promise<ActionResult<void>> {
  const parsed = setItemTagsSchema.safeParse({ itemId, tagIds } satisfies SetItemTagsInput);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const svc = await TagsService.forCurrentUser();
    await svc.setForItem(parsed.data.itemId, parsed.data.tagIds);
    revalidatePath('/dashboard/inventory');
    revalidatePath('/dashboard/books');
    revalidatePath(`/dashboard/inventory/${parsed.data.itemId}`);
    revalidatePath(`/dashboard/books/${parsed.data.itemId}`);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}
