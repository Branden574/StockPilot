'use server';

import { revalidatePath } from 'next/cache';

import { compareSizeValues, err, ok, uuidSchema, type ActionResult } from '@stockpilot/core';

import { assertPermission, ServiceError, withContext } from '@/server/services/context';
import { ProductGroupsService } from '@/server/services/product-groups';

/**
 * ON-DEMAND variant expansion for the product-groups roll-up list.
 *
 * WHY THIS IS NOT LOADED WITH THE PAGE. The list renders COLLAPSED: every
 * header number comes from `product_group_rollups`, a server-side aggregate,
 * so a collapsed page needs no variant rows at all. Loading them anyway meant
 * reading every variant of every group on the page to render nothing — and the
 * batch read that did it was capped by PostgREST's `max_rows`, so past ~1000
 * rows an expansion quietly showed FEWER variants than its own header counted
 * (see `variantsByGroupIds`). Fetching one group's rows when a human opens it
 * removes both the waste and the cap: a single group's variant list is bounded
 * by how many sizes a product has.
 */

/** One variant row as the list renders it. */
export interface GroupVariantRow {
  id: string;
  sku: string;
  name: string;
  quantity: number;
  variantSize: string | null;
  variantSizeSystem: string | null;
  variantWidth: string | null;
  variantColor: string | null;
  jerseyNumber: string | null;
  trackingType: 'none' | 'lot' | 'serial' | 'serial_optional';
  unitOfMeasure: string | null;
  status: 'active' | 'archived' | 'discontinued';
}

export async function loadGroupVariantsAction(
  groupId: unknown,
): Promise<ActionResult<{ variants: GroupVariantRow[] }>> {
  const parsed = uuidSchema.safeParse(groupId);
  if (!parsed.success) return err('validation_error', 'Invalid product group.');
  try {
    const ctx = await withContext();
    // The page this serves is gated on sports:manage; assert it here too, so
    // the action is not a wider read than the screen that calls it.
    assertPermission(ctx, 'sports:manage');
    const svc = new ProductGroupsService(ctx);
    // get() FIRST: a group in another org must be a not_found, never an empty
    // list that reads like "this group has nothing in it".
    await svc.get(parsed.data);
    const [variants, display] = await Promise.all([
      svc.variants(parsed.data),
      svc.displayByIds([parsed.data]),
    ]);
    // Size order comes from the group's authored scale; `compareSizeValues`
    // falls back to its natural ladder when a group has none.
    const order = display.get(parsed.data)?.sizeOrder ?? null;
    const sorted = [...variants].sort((a, b) =>
      compareSizeValues(a.variant_size, b.variant_size, order),
    );
    return ok({
      variants: sorted.map((v) => ({
        id: v.id,
        sku: v.sku,
        name: v.name,
        quantity: Number(v.quantity_on_hand) || 0,
        variantSize: v.variant_size,
        variantSizeSystem: v.variant_size_system,
        variantWidth: v.variant_width,
        variantColor: v.variant_color,
        jerseyNumber: v.jersey_number,
        trackingType: v.tracking_type,
        unitOfMeasure: v.unit_of_measure,
        status: v.status,
      })),
    });
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    console.error(e);
    return err('internal_error', 'Something went wrong. Please try again.');
  }
}

/**
 * Archive a product group — the affordance the page had none of, which is why a
 * leftover shell group had to be removed with hand-written SQL in production.
 *
 * SOFT and reversible: the service writes `status = 'archived'` and never
 * `deleted_at`, so the group_key stays reserved and `restoreProductGroupAction`
 * below brings the whole group back, variants included. There is no delete
 * action here on purpose.
 *
 * `acknowledgeActiveVariants` is the deliberate override for a group whose sizes
 * are still linked. Omitted/false is the safe default: the service refuses and
 * names the count, and the UI turns that refusal into an explicit
 * "Archive anyway" rather than a dead-end toast — the same shape as the item
 * archive's acknowledgeStock.
 */
export async function archiveProductGroupAction(
  groupId: unknown,
  opts: { acknowledgeActiveVariants?: boolean } = {},
): Promise<ActionResult<{ id: string }>> {
  const parsed = uuidSchema.safeParse(groupId);
  if (!parsed.success) return err('validation_error', 'Invalid product group.');
  try {
    const svc = await ProductGroupsService.forCurrentUser();
    await svc.archive(parsed.data, {
      acknowledgeActiveVariants: opts.acknowledgeActiveVariants === true,
    });
    revalidatePath('/dashboard/product-groups');
    return ok({ id: parsed.data });
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    console.error(e);
    return err('internal_error', 'Something went wrong. Please try again.');
  }
}

/** Undo an archive: status back to Active, with every variant still linked. */
export async function restoreProductGroupAction(
  groupId: unknown,
): Promise<ActionResult<{ id: string }>> {
  const parsed = uuidSchema.safeParse(groupId);
  if (!parsed.success) return err('validation_error', 'Invalid product group.');
  try {
    const svc = await ProductGroupsService.forCurrentUser();
    await svc.restore(parsed.data);
    revalidatePath('/dashboard/product-groups');
    return ok({ id: parsed.data });
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    console.error(e);
    return err('internal_error', 'Something went wrong. Please try again.');
  }
}
