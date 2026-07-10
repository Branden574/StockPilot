'use server';

import { revalidatePath, revalidateTag } from 'next/cache';
import { z } from 'zod';

import { ServiceError, withContext } from '@/server/services/context';
import { UserCategoriesService } from '@/server/services/user-categories';

import { err, ok, type ActionResult } from '@stockpilot/core';

const setSchema = z.object({
  userId: z.string().uuid(),
  categoryIds: z.array(z.string().uuid()).max(500),
});

/**
 * Replaces the target user's category grants. Returns the new count.
 *
 * Invalidates downstream caches that may have leaked content based on
 * the user's PREVIOUS visibility — this is the single most important
 * side-effect of this action and is why the cache tag invalidation
 * matters at least as much as the DB write.
 */
export async function setUserCategoryAccessAction(
  input: z.input<typeof setSchema>,
): Promise<ActionResult<{ count: number }>> {
  const parsed = setSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const ctx = await withContext();
    const svc = new UserCategoriesService(ctx);
    await svc.setUserCategoryAccess(parsed.data.userId, parsed.data.categoryIds);

    // Cache invalidation: the orders/new picker caches catalog
    // payloads keyed by (orgId, warehouseId, accessKey). updateTag is
    // Next 16's read-your-own-writes API — purges entries tagged
    // 'orders-new-v2-catalog' so the next read (including the admin's
    // own follow-up render) sees the new visibility. The 30s TTL on
    // these entries refills the cache for unaffected users.
    revalidateTag('orders-new-v2-catalog', 'max');

    // Server-rendered pages that show inventory lists need a fresh
    // read for the target user on their next visit. Path-based
    // invalidation is per-route, not per-user, but since these pages
    // are dynamic (force-dynamic) they re-render per request anyway.
    revalidatePath('/dashboard/inventory');
    revalidatePath('/dashboard/books');
    revalidatePath('/dashboard/team');

    return ok({ count: parsed.data.categoryIds.length });
  } catch (error) {
    if (error instanceof ServiceError) {
      return err(error.code, error.message);
    }
    console.error(error);
    return err('internal_error', error instanceof Error ? error.message : 'Unknown error');
  }
}
