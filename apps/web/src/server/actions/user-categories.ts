'use server';

import { revalidatePath, revalidateTag } from 'next/cache';
import { z } from 'zod';

import { withContext } from '@/server/services/context';
import { ordersCatalogTag } from '@/server/services/lib/order-catalog-hidden';
import { UserCategoriesService } from '@/server/services/user-categories';
import { actionErrorResult } from '@/server/lib/action-error-result';

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

    // The orders/new picker caches catalog payloads keyed by (orgId,
    // warehouseId, accessKey). The new visibility does not depend on this
    // mark: the access key is resolved live on every request from the
    // member's grants (resolveCatalogScopeKey, never cached), so the
    // member's next read already uses the entry for their new grants.
    // This marks this organization's entries for a background refresh
    // ('max', stale-while-revalidate), and only this organization's.
    revalidateTag(ordersCatalogTag(ctx.organizationId), 'max');

    // Server-rendered pages that show inventory lists need a fresh
    // read for the target user on their next visit. Path-based
    // invalidation is per-route, not per-user, but since these pages
    // are dynamic (force-dynamic) they re-render per request anyway.
    revalidatePath('/dashboard/inventory');
    revalidatePath('/dashboard/books');
    revalidatePath('/dashboard/team');

    return ok({ count: parsed.data.categoryIds.length });
  } catch (error) {
    return actionErrorResult(error, 'actions.user_categories.set_user_category_access');
  }
}
