'use server';

import { revalidatePath } from 'next/cache';

import {
  err,
  GROUPING_ERROR_WORDS,
  ok,
  type ActionResult,
  type GroupingOutcome,
  type SplitSkuOutcomeItem,
  type UngroupSelectedOutcome,
} from '@stockpilot/core';

import { checkRateLimit } from '@/lib/rate-limit';
import { ServiceError, withContext } from '@/server/services/context';
import {
  ItemGroupingService,
  type GroupingReview,
  type UngroupCandidate,
} from '@/server/services/item-grouping';
import {
  UngroupSelectedService,
  type UngroupSelectedReview,
} from '@/server/services/ungroup-selected';

/**
 * The web side of Ungroup (split_item_sku, migration 0399) and of Group
 * selected (apply_item_grouping and item_grouping_preview, migration 0400):
 * the review dialogs' previews and their Saves, over ItemGroupingService, the
 * same service the phone's bearer routes use. The service refreshes the
 * Items/Books cache and the order catalog; these actions also refresh the
 * pages that render a SKU or a group (the lists and every item page).
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

/** The pages that show a SKU or a display group. */
function refreshListAndItemPages(): void {
  revalidatePath('/dashboard/inventory');
  revalidatePath('/dashboard/books');
  revalidatePath('/dashboard/inventory/[id]', 'page');
  revalidatePath('/dashboard/books/[id]', 'page');
}

/**
 * Group selected's review: the selected records the caller can read, their
 * group, family and whether the caller may edit each, same-SKU records not
 * selected, candidate groups, and the named target group. Reads only. It also
 * names the organization and the account it answered for: Save sends them
 * back, so a Save from a tab whose session moved since is refused.
 */
export async function previewGroupingAction(
  itemIds: string[],
  groupId: string | null = null,
): Promise<ActionResult<{ review: GroupingReview; organizationId: string; actorUserId: string }>> {
  if (
    !Array.isArray(itemIds) ||
    !itemIds.every((id) => typeof id === 'string') ||
    (groupId !== null && typeof groupId !== 'string')
  ) {
    return err('validation_error', GROUPING_ERROR_WORDS.invalid);
  }
  try {
    const ctx = await withContext();
    const rl = await checkRateLimit(`item-grouping-preview:${ctx.userId}`, 60, 60_000);
    if (!rl.allowed) return err('rate_limited', GROUPING_ERROR_WORDS.rateLimited);
    const review = await new ItemGroupingService(ctx).previewGroup(itemIds, groupId);
    return ok({ review, organizationId: ctx.organizationId, actorUserId: ctx.userId });
  } catch (e) {
    return toResult(e);
  }
}

/** Save for Group selected, Remove from group and Rename: the body the dialog
 *  built (core GroupingBody), sent again unchanged with the same key on a
 *  retry. */
export async function applyGroupingAction(
  body: unknown,
): Promise<ActionResult<{ outcome: GroupingOutcome }>> {
  try {
    const ctx = await withContext();
    // The same per-user bucket as Ungroup and the phone's routes (30 a minute).
    const rl = await checkRateLimit(`item-grouping:${ctx.userId}`, 30, 60_000);
    if (!rl.allowed) return err('rate_limited', GROUPING_ERROR_WORDS.rateLimited);
    const answer = await new ItemGroupingService(ctx).applyGrouping(body, 'web');
    if (answer.outcome.outcome === 'applied') refreshListAndItemPages();
    return ok({ outcome: answer.outcome });
  } catch (e) {
    return toResult(e);
  }
}

/**
 * Ungroup anything's review (owner 2026-10-12): the ticked records the caller
 * can read with their group, family and whether the caller can edit each,
 * every live record of their SKUs the caller can read, and whether the
 * caller may take records out of a size family. Reads only. It also names
 * the organization and the account it answered for: Save sends them back.
 */
export async function previewUngroupSelectedAction(
  itemIds: string[],
): Promise<ActionResult<UngroupSelectedReview & { organizationId: string; actorUserId: string }>> {
  if (!Array.isArray(itemIds) || !itemIds.every((id) => typeof id === 'string')) {
    return err('validation_error', GROUPING_ERROR_WORDS.invalid);
  }
  try {
    const ctx = await withContext();
    const rl = await checkRateLimit(`item-grouping-preview:${ctx.userId}`, 60, 60_000);
    if (!rl.allowed) return err('rate_limited', GROUPING_ERROR_WORDS.rateLimited);
    const review = await new UngroupSelectedService(ctx).preview(itemIds);
    return ok({ ...review, organizationId: ctx.organizationId, actorUserId: ctx.userId });
  } catch (e) {
    return toResult(e);
  }
}

/**
 * Ungroup anything's Save: the body the dialog built (core
 * UngroupSelectedBody), sent again unchanged, keys and all, on a retry. The
 * answer names each step's records (applied, refused, partly applied, not
 * tried); a refusal before any write comes back as an error.
 */
export async function ungroupSelectedAction(
  body: unknown,
): Promise<ActionResult<{ outcome: UngroupSelectedOutcome }>> {
  try {
    const ctx = await withContext();
    // The same per-user bucket as every grouping write (30 a minute).
    const rl = await checkRateLimit(`item-grouping:${ctx.userId}`, 30, 60_000);
    if (!rl.allowed) return err('rate_limited', GROUPING_ERROR_WORDS.rateLimited);
    const answer = await new UngroupSelectedService(ctx).apply(body, 'web');
    if (answer.outcome.parts.some((p) => p.changedItemIds.length > 0)) {
      refreshListAndItemPages();
      // A size family's sizes are listed on Product groups.
      if (answer.outcome.parts.some((p) => p.kind === 'unlink' && p.changedItemIds.length > 0)) {
        revalidatePath('/dashboard/product-groups');
      }
    }
    return ok({ outcome: answer.outcome });
  } catch (e) {
    return toResult(e);
  }
}
