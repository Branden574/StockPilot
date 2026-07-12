'use server';

import { revalidatePath, revalidateTag } from 'next/cache';
import { z } from 'zod';

import { createAdminClient } from '@/lib/supabase/admin';
import { audit } from '@/server/services/audit';
import { assertPermission, ServiceError, withContext } from '@/server/services/context';
import { publicCatalogTag } from '@/server/services/public-links';

import { err, ok, type ActionResult } from '@stockpilot/core';

/**
 * Public-catalog visibility controls (P3 of
 * docs/superpowers/plans/2026-07-12-public-catalog-visibility-plan.md).
 *
 * Sets inventory_items.public_visibility / categories.public_visibility
 * (migration 0261). The values feed the single SQL eligibility predicate
 * `public_link_eligible_items`:
 *   - item 'hidden'        → never public, even with an explicit link entry
 *   - item 'public'        → eligible for the shared pool on links with
 *                            include_public_pool, IF the item's category is
 *                            'public' (or the item is uncategorized)
 *   - category 'internal_only' → pulls the whole category out of the POOL
 *                            branch; explicit per-link entries still apply
 *
 * All three actions gate on `public_links:manage` — the same permission that
 * guards link/catalog mutations — and write through the ADMIN client with
 * explicit org scoping. That's deliberate: inventory_items write-RLS keys on
 * items:update, which a public_links:manage grantee may not hold, and the
 * 0261 migration already made the same call for entry writes (item_in_org is
 * SECURITY DEFINER precisely so catalog managers aren't blocked by item RLS).
 *
 * Every successful change ends by revalidating EVERY one of the org's
 * public-catalog cache tags: item/category visibility affects the pool branch
 * of every link, so per-link precision buys nothing. NEVER updateTag (throws
 * at runtime in this Next config — see memory).
 */

const ITEM_VISIBILITIES = ['internal_only', 'public', 'hidden'] as const;
const CATEGORY_VISIBILITIES = ['public', 'internal_only'] as const;

export type ItemPublicVisibility = (typeof ITEM_VISIBILITIES)[number];
export type CategoryPublicVisibility = (typeof CATEGORY_VISIBILITIES)[number];

const setItemSchema = z.object({
  itemId: z.string().uuid(),
  visibility: z.enum(ITEM_VISIBILITIES),
});

const bulkSetItemsSchema = z.object({
  itemIds: z.array(z.string().uuid()).min(1).max(500),
  visibility: z.enum(ITEM_VISIBILITIES),
});

const setCategorySchema = z.object({
  categoryId: z.string().uuid(),
  visibility: z.enum(CATEGORY_VISIBILITIES),
});

/**
 * Public-facing text override: trimmed, bounded (mirrors the 0261 CHECK
 * constraints), and normalized so an empty/whitespace-only string stores as
 * NULL — the public loader falls back to the internal name on NULL, and we
 * never want a row stuck on '' (which would render a blank public label).
 */
const publicText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, `${label} must be ${max} characters or fewer`)
    .nullable()
    .transform((v) => (v ? v : null));

const setItemPublicDisplaySchema = z.object({
  itemId: z.string().uuid(),
  publicDisplayName: publicText(300, 'Public display name'),
  publicDescription: publicText(2000, 'Public description'),
});

function toResult<T>(error: unknown): ActionResult<T> {
  if (error instanceof ServiceError) return err(error.code, error.message);
  console.error(error);
  return err('internal_error', error instanceof Error ? error.message : 'Unknown error');
}

/**
 * Purges every public-catalog cache entry for the org. Item/category
 * visibility participates in the pool branch of EVERY link's eligibility, so
 * the simplest correct invalidation is all of the org's link tags.
 */
async function revalidateOrgPublicCatalogs(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
): Promise<void> {
  const { data, error } = await admin
    .from('public_request_links')
    .select('id')
    .eq('organization_id', organizationId)
    .limit(500);
  if (error) throw new ServiceError('internal_error', error.message);
  for (const row of (data ?? []) as Array<{ id: string }>) {
    revalidateTag(publicCatalogTag(row.id), 'max');
  }
}

/**
 * Sets one item's public visibility. No-op (still ok) when the stored value
 * already matches, so repeat clicks don't spam the audit log.
 */
export async function setItemPublicVisibilityAction(
  input: z.input<typeof setItemSchema>,
): Promise<ActionResult<{ itemId: string; visibility: ItemPublicVisibility }>> {
  const parsed = setItemSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  const { itemId, visibility } = parsed.data;
  try {
    const ctx = await withContext();
    assertPermission(ctx, 'public_links:manage');
    const admin = createAdminClient();

    const { data: before, error: readErr } = await admin
      .from('inventory_items')
      .select('id, public_visibility')
      .eq('organization_id', ctx.organizationId)
      .eq('id', itemId)
      .is('deleted_at', null)
      .maybeSingle();
    if (readErr) throw new ServiceError('internal_error', readErr.message);
    if (!before) throw new ServiceError('not_found', 'Item not found');
    const previous = (before as { public_visibility: ItemPublicVisibility }).public_visibility;
    if (previous === visibility) {
      // Value already stored (double-click, or a retry after a run that wrote
      // but failed during revalidation). Skip the write + audit, but STILL
      // revalidate — otherwise a retry could never heal a stale cache.
      await revalidateOrgPublicCatalogs(admin, ctx.organizationId);
      return ok({ itemId, visibility });
    }

    // .select().maybeSingle() after the update: a silent zero-row miss here
    // (e.g. the row was deleted between read and write) must surface, not
    // fail-open into a "saved" toast.
    const { data: updated, error: writeErr } = await admin
      .from('inventory_items')
      .update({ public_visibility: visibility })
      .eq('organization_id', ctx.organizationId)
      .eq('id', itemId)
      .is('deleted_at', null)
      .select('id')
      .maybeSingle();
    if (writeErr) throw new ServiceError('internal_error', writeErr.message);
    if (!updated) throw new ServiceError('not_found', 'Item not found');

    await audit(
      {
        event: 'item.public_visibility_changed',
        entityType: 'inventory_item',
        entityId: itemId,
        before: { public_visibility: previous },
        after: { public_visibility: visibility },
        extra: { item_id: itemId },
      },
      ctx,
    );

    await revalidateOrgPublicCatalogs(admin, ctx.organizationId);
    return ok({ itemId, visibility });
  } catch (e) {
    return toResult(e);
  }
}

/**
 * Sets one item's public-facing display name/description (migration 0261
 * columns, read by the public catalog loader: display name falls back to the
 * internal `name` when NULL; description renders only when set). Both fields
 * are written together — the form sends the full current pair — so the audit
 * row always captures a complete before/after snapshot.
 */
export async function setItemPublicDisplayAction(
  input: z.input<typeof setItemPublicDisplaySchema>,
): Promise<
  ActionResult<{
    itemId: string;
    publicDisplayName: string | null;
    publicDescription: string | null;
  }>
> {
  const parsed = setItemPublicDisplaySchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  const { itemId, publicDisplayName, publicDescription } = parsed.data;
  try {
    const ctx = await withContext();
    assertPermission(ctx, 'public_links:manage');
    const admin = createAdminClient();

    const { data: before, error: readErr } = await admin
      .from('inventory_items')
      .select('id, public_display_name, public_description')
      .eq('organization_id', ctx.organizationId)
      .eq('id', itemId)
      .is('deleted_at', null)
      .maybeSingle();
    if (readErr) throw new ServiceError('internal_error', readErr.message);
    if (!before) throw new ServiceError('not_found', 'Item not found');
    const prev = before as {
      public_display_name: string | null;
      public_description: string | null;
    };
    if (
      prev.public_display_name === publicDisplayName &&
      prev.public_description === publicDescription
    ) {
      // Same self-healing rationale as the visibility no-op path above:
      // skip the write + audit but still revalidate so a retry after a
      // failed-revalidation run can heal a stale public cache.
      await revalidateOrgPublicCatalogs(admin, ctx.organizationId);
      return ok({ itemId, publicDisplayName, publicDescription });
    }

    // .select().maybeSingle() after the update: a silent zero-row miss here
    // (row deleted between read and write) must surface, not fail-open.
    const { data: updated, error: writeErr } = await admin
      .from('inventory_items')
      .update({
        public_display_name: publicDisplayName,
        public_description: publicDescription,
      })
      .eq('organization_id', ctx.organizationId)
      .eq('id', itemId)
      .is('deleted_at', null)
      .select('id')
      .maybeSingle();
    if (writeErr) throw new ServiceError('internal_error', writeErr.message);
    if (!updated) throw new ServiceError('not_found', 'Item not found');

    await audit(
      {
        event: 'item.public_display_changed',
        entityType: 'inventory_item',
        entityId: itemId,
        before: {
          public_display_name: prev.public_display_name,
          public_description: prev.public_description,
        },
        after: {
          public_display_name: publicDisplayName,
          public_description: publicDescription,
        },
        extra: { item_id: itemId },
      },
      ctx,
    );

    await revalidateOrgPublicCatalogs(admin, ctx.organizationId);
    return ok({ itemId, publicDisplayName, publicDescription });
  } catch (e) {
    return toResult(e);
  }
}

/**
 * Sets public visibility on up to 500 items at once (Items-table bulk
 * action). Audited as one `public_catalog.bulk_change` row with a compact
 * before-distribution + the full id list, mirroring the link-entry bulk
 * events in PublicLinksService.
 */
export async function bulkSetItemPublicVisibilityAction(
  input: z.input<typeof bulkSetItemsSchema>,
): Promise<ActionResult<{ updated: number; visibility: ItemPublicVisibility }>> {
  const parsed = bulkSetItemsSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  const visibility = parsed.data.visibility;
  const ids = [...new Set(parsed.data.itemIds)];
  try {
    const ctx = await withContext();
    assertPermission(ctx, 'public_links:manage');
    const admin = createAdminClient();

    // Org check on every id (admin client bypasses RLS, so this filter is
    // the tenancy boundary) + capture the before-distribution for audit.
    const { data: beforeRows, error: readErr } = await admin
      .from('inventory_items')
      .select('id, public_visibility')
      .eq('organization_id', ctx.organizationId)
      .in('id', ids)
      .is('deleted_at', null);
    if (readErr) throw new ServiceError('internal_error', readErr.message);
    const rows = (beforeRows ?? []) as Array<{
      id: string;
      public_visibility: ItemPublicVisibility;
    }>;
    if (rows.length !== ids.length) {
      throw new ServiceError('not_found', 'One or more items were not found.');
    }
    const beforeCounts: Record<string, number> = {};
    for (const r of rows) {
      beforeCounts[r.public_visibility] = (beforeCounts[r.public_visibility] ?? 0) + 1;
    }

    const { data: updatedRows, error: writeErr } = await admin
      .from('inventory_items')
      .update({ public_visibility: visibility })
      .eq('organization_id', ctx.organizationId)
      .in('id', ids)
      .is('deleted_at', null)
      .select('id');
    if (writeErr) throw new ServiceError('internal_error', writeErr.message);
    const updated = ((updatedRows ?? []) as Array<{ id: string }>).length;
    if (updated === 0) throw new ServiceError('not_found', 'One or more items were not found.');

    await audit(
      {
        event: 'public_catalog.bulk_change',
        entityType: 'inventory_item',
        extra: {
          action: 'items_public_visibility_set',
          item_ids: ids,
          count: updated,
        },
        before: { public_visibility_counts: beforeCounts },
        after: { public_visibility: visibility },
      },
      ctx,
    );

    await revalidateOrgPublicCatalogs(admin, ctx.organizationId);
    return ok({ updated, visibility });
  } catch (e) {
    return toResult(e);
  }
}

/**
 * Sets a category's public visibility. 'internal_only' removes the whole
 * category from the shared-pool branch of every link's eligibility (explicit
 * per-link entries are unaffected — see the predicate in 0261).
 */
export async function setCategoryPublicVisibilityAction(
  input: z.input<typeof setCategorySchema>,
): Promise<ActionResult<{ categoryId: string; visibility: CategoryPublicVisibility }>> {
  const parsed = setCategorySchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  const { categoryId, visibility } = parsed.data;
  try {
    const ctx = await withContext();
    assertPermission(ctx, 'public_links:manage');
    const admin = createAdminClient();

    // No deleted_at filter: an archived category's internal_only still gates
    // the pool for items that kept the assignment, so it stays togglable.
    const { data: before, error: readErr } = await admin
      .from('categories')
      .select('id, name, public_visibility')
      .eq('organization_id', ctx.organizationId)
      .eq('id', categoryId)
      .maybeSingle();
    if (readErr) throw new ServiceError('internal_error', readErr.message);
    if (!before) throw new ServiceError('not_found', 'Category not found');
    const row = before as { name: string; public_visibility: CategoryPublicVisibility };
    if (row.public_visibility === visibility) {
      // Same self-healing rationale as the single-item no-op path above.
      await revalidateOrgPublicCatalogs(admin, ctx.organizationId);
      return ok({ categoryId, visibility });
    }

    const { data: updated, error: writeErr } = await admin
      .from('categories')
      .update({ public_visibility: visibility })
      .eq('organization_id', ctx.organizationId)
      .eq('id', categoryId)
      .select('id')
      .maybeSingle();
    if (writeErr) throw new ServiceError('internal_error', writeErr.message);
    if (!updated) throw new ServiceError('not_found', 'Category not found');

    await audit(
      {
        event: 'public_catalog.bulk_change',
        entityType: 'category',
        entityId: categoryId,
        before: { public_visibility: row.public_visibility },
        after: { public_visibility: visibility },
        extra: {
          action: 'category_public_visibility_changed',
          category_id: categoryId,
          category_name: row.name,
        },
      },
      ctx,
    );

    await revalidateOrgPublicCatalogs(admin, ctx.organizationId);
    revalidatePath('/dashboard/categories');
    return ok({ categoryId, visibility });
  } catch (e) {
    return toResult(e);
  }
}
