'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { revalidateInventoryListForCurrentOrg } from '@/server/loaders/inventory-list';
import { ServiceError } from '@/server/services/context';
import { ItemImagesService } from '@/server/services/item-images';

import { err, ok, type ActionResult } from '@stockpilot/core';

function toResult<T>(error: unknown): ActionResult<T> {
  if (error instanceof ServiceError) return err(error.code, error.message);
  console.error(error);
  return err('internal_error', error instanceof Error ? error.message : 'Unknown error');
}

const createUploadSchema = z.object({
  itemId: z.string().uuid(),
  fileExt: z.string().min(1).max(8),
});

export async function createImageUploadAction(
  input: z.infer<typeof createUploadSchema>,
): Promise<
  ActionResult<{
    path: string;
    signedUrl: string;
    token: string;
    thumbPath: string;
    thumbSignedUrl: string;
  }>
> {
  const parsed = createUploadSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid input');
  try {
    const svc = await ItemImagesService.forCurrentUser();
    const result = await svc.createUploadUrl(parsed.data.itemId, parsed.data.fileExt);
    return ok(result);
  } catch (e) {
    return toResult(e);
  }
}

const recordSchema = z.object({
  itemId: z.string().uuid(),
  storagePath: z.string(),
  isFirst: z.boolean().default(false),
  // Both optional + nullable for backward compatibility with any
  // callers that pre-date the L1/L2 thumb+LQIP work. The service
  // re-validates the prefix + LQIP length defensively.
  thumbPath: z.string().nullish(),
  lqip: z.string().max(2000).nullish(),
});

export async function recordImageAction(input: z.infer<typeof recordSchema>): Promise<ActionResult<{ id: string }>> {
  const parsed = recordSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid input');
  try {
    const svc = await ItemImagesService.forCurrentUser();
    const row = await svc.record(
      parsed.data.itemId,
      parsed.data.storagePath,
      parsed.data.isFirst,
      {
        thumbPath: parsed.data.thumbPath ?? null,
        lqip: parsed.data.lqip ?? null,
      },
    );
    revalidatePath(`/dashboard/inventory/${parsed.data.itemId}`);
    await revalidateInventoryListForCurrentOrg();
    return ok({ id: row.id as string });
  } catch (e) {
    return toResult(e);
  }
}

export async function removeImageAction(imageId: string, itemId: string): Promise<ActionResult<void>> {
  try {
    const svc = await ItemImagesService.forCurrentUser();
    await svc.remove(imageId);
    revalidatePath(`/dashboard/inventory/${itemId}`);
    await revalidateInventoryListForCurrentOrg();
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}
