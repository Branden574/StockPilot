'use server';

import { revalidatePath } from 'next/cache';

import { err, linkFamilySchema, ok, unlinkItemsSchema, type ActionResult } from '@stockpilot/core';

import { revalidateInventoryListForCurrentOrg } from '@/server/loaders/inventory-list';
import { ServiceError, withContext } from '@/server/services/context';
import { linkFamily, unlinkItems } from '@/server/services/product-group-linking';
import { ProductGroupsService } from '@/server/services/product-groups';

/**
 * Server actions behind the group-linking review screen.
 *
 * Thin on purpose: parse with the SHARED zod schemas (the same ones the Bearer
 * route and the phone use, so web and mobile cannot drift on what a legal link
 * is), delegate every rule to the service, and invalidate the two caches whose
 * rendering depends on `group_id` — the inventory list payload and the product
 * groups page.
 */

function toResult<T>(error: unknown): ActionResult<T> {
  if (error instanceof ServiceError) return err(error.code, error.message);
  return err('internal_error', error instanceof Error ? error.message : 'Unknown error');
}

/**
 * Link an explicitly-selected set of items into one product group.
 *
 * `input` is untrusted: it arrives from a browser. The schema bounds it and the
 * service re-reads every id under the caller's org before writing, so an id
 * from another tenant fails at the service, not here.
 */
export async function linkFamilyAction(
  input: unknown,
): Promise<ActionResult<{ groupId: string; linked: number }>> {
  const parsed = linkFamilySchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const ctx = await withContext();
    const result = await linkFamily(
      { groups: new ProductGroupsService(ctx), supabase: ctx.supabase, ctx },
      {
        groupId: parsed.data.groupId,
        group: parsed.data.group,
        members: parsed.data.members.map((m) => ({
          itemId: m.itemId,
          variantSize: m.variantSize ?? null,
          variantSizeOriginal: m.variantSizeOriginal ?? null,
          variantSizeSystem: m.variantSizeSystem ?? null,
          jerseyNumber: m.jerseyNumber ?? null,
        })),
        reason: parsed.data.reason,
        force: parsed.data.force,
      },
    );
    // group_id decides how the inventory list collapses its rows, so the
    // 60s list cache is now wrong for this org.
    await revalidateInventoryListForCurrentOrg();
    revalidatePath('/dashboard/product-groups');
    revalidatePath('/dashboard/inventory');
    return ok(result);
  } catch (e) {
    return toResult(e);
  }
}

/** Undo a link. Same gates, same invalidations. */
export async function unlinkItemsAction(
  input: unknown,
): Promise<ActionResult<{ unlinked: number }>> {
  const parsed = unlinkItemsSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const ctx = await withContext();
    const result = await unlinkItems({ supabase: ctx.supabase, ctx }, parsed.data);
    await revalidateInventoryListForCurrentOrg();
    revalidatePath('/dashboard/product-groups');
    revalidatePath('/dashboard/inventory');
    return ok(result);
  } catch (e) {
    return toResult(e);
  }
}
