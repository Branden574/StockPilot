'use server';

import { revalidatePath } from 'next/cache';

import {
  err,
  GROUPING_ERROR_WORDS,
  ok,
  type ActionResult,
  type SplitSkuOutcomeItem,
} from '@stockpilot/core';

import { checkRateLimit } from '@/lib/rate-limit';
import { ServiceError, withContext } from '@/server/services/context';
import { ItemGroupingService, type UngroupCandidate } from '@/server/services/item-grouping';

/**
 * The web side of Ungroup (split_item_sku, migration 0399): the review
 * dialog's preview and its Save, over ItemGroupingService, the same service
 * the phone's POST /api/v1/items/ungroup uses. The service refreshes the
 * Items/Books cache and the order catalog; these actions also refresh the
 * pages that render a SKU (the lists and every item page).
 */

function toResult(e: unknown): ActionResult<never> {
  if (e instanceof ServiceError && e.code !== 'internal_error') {
    return err(e.code, e.message, e.details);
  }
  // Never a raw message (database or network internals) to the browser.
  if (!(e instanceof ServiceError)) console.error(e);
  return err('internal_error', GROUPING_ERROR_WORDS.internal);
}

/**
 * The records the dialog plans with: every live record of the selected
 * records' SKUs the caller can read, oldest first. Reads only. It also names
 * the organization and the account it answered for: the dialog's Save sends
 * them back, so a Save from a tab whose session moved to another account or
 * organization since is refused instead of applied under it.
 */
export async function previewUngroupAction(
  itemIds: string[],
): Promise<
  ActionResult<{ candidates: UngroupCandidate[]; organizationId: string; actorUserId: string }>
> {
  if (!Array.isArray(itemIds) || !itemIds.every((id) => typeof id === 'string')) {
    return err('validation_error', GROUPING_ERROR_WORDS.invalid);
  }
  try {
    const ctx = await withContext();
    const rl = await checkRateLimit(`item-grouping-preview:${ctx.userId}`, 60, 60_000);
    if (!rl.allowed) return err('rate_limited', GROUPING_ERROR_WORDS.rateLimited);
    const { candidates } = await new ItemGroupingService(ctx).previewSplit(itemIds);
    return ok({ candidates, organizationId: ctx.organizationId, actorUserId: ctx.userId });
  } catch (e) {
    return toResult(e);
  }
}

/** Save: the body the dialog built (core SplitSkuBody), sent again unchanged
 *  with the same key on a retry. */
export async function ungroupItemsAction(
  body: unknown,
): Promise<ActionResult<{ replay: boolean; items: SplitSkuOutcomeItem[] }>> {
  try {
    const ctx = await withContext();
    // The same per-user bucket as the phone's route (design 3.4: 30 a minute).
    const rl = await checkRateLimit(`item-grouping:${ctx.userId}`, 30, 60_000);
    if (!rl.allowed) return err('rate_limited', GROUPING_ERROR_WORDS.rateLimited);
    const answer = await new ItemGroupingService(ctx).splitSku(body, 'web');
    revalidatePath('/dashboard/inventory');
    revalidatePath('/dashboard/books');
    revalidatePath('/dashboard/inventory/[id]', 'page');
    revalidatePath('/dashboard/books/[id]', 'page');
    return ok({ replay: answer.replay, items: answer.items });
  } catch (e) {
    return toResult(e);
  }
}
