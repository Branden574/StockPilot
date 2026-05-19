import { audit } from './audit';
import { ServiceContext, ServiceError, assertPermission } from './context';

/**
 * Service for managing per-viewer category visibility grants.
 *
 * Background: viewer accounts can be restricted to a subset of
 * categories via rows in `user_category_assignments`. The Postgres
 * RLS policy `inventory_items_category_visibility` (migration 0128)
 * enforces the restriction at the database level — this service is
 * defense-in-depth + the management surface for grants.
 *
 * Truth table:
 *   - manager+ (or staff)            → always sees all categories
 *   - viewer with no rows            → unrestricted (back-compat default)
 *   - viewer with rows               → only sees those categories
 *   - viewer + null category         → never visible to restricted viewers
 */
export class UserCategoriesService {
  constructor(private readonly ctx: ServiceContext) {}

  /**
   * Returns the category_ids the given user is allowed to see.
   *   - `null` = unrestricted (sees every category — manager+, staff,
   *     or a viewer with zero grants)
   *   - `Set<string>` = explicit allow-list (restricted viewer)
   *
   * Mirrors the RLS truth table in `user_can_see_item_category`. Used
   * by the orders/new picker cache-key hash and by `InventoryService.list`
   * for defense-in-depth filtering.
   */
  async getAccessibleCategoryIds(userId: string): Promise<Set<string> | null> {
    const { data: member } = await this.ctx.supabase
      .from('organization_members')
      .select('role')
      .eq('user_id', userId)
      .eq('organization_id', this.ctx.organizationId)
      .maybeSingle();
    const role = (member as { role?: string } | null)?.role;
    // If we can't find a membership row, defer to RLS / upstream auth.
    // In production this shouldn't happen because ctx.organizationId is
    // only set after auth has verified org membership; returning null
    // here means "no extra service-layer filter" while RLS still
    // enforces the visibility boundary.
    if (!role) return null;
    if (role !== 'viewer') return null;    // unrestricted by role

    const { data: rows } = await this.ctx.supabase
      .from('user_category_assignments')
      .select('category_id')
      .eq('user_id', userId);
    const list = ((rows ?? []) as Array<{ category_id: string }>).map((r) => r.category_id);
    if (list.length === 0) return null;    // viewer with no grants = unrestricted
    return new Set(list);
  }

  /**
   * Atomic-replace: clear the target user's existing assignments and
   * insert the new set. Caller must have `members:assign_categories`
   * permission (manager+) AND the target must be in the calling user's
   * organization.
   *
   * Empty array = remove all grants → viewer becomes unrestricted.
   */
  async setUserCategoryAccess(
    targetUserId: string,
    categoryIds: string[],
  ): Promise<void> {
    assertPermission(this.ctx, 'members:assign_categories');

    // Verify target user is in OUR org (defense in depth — RLS on
    // user_category_assignments also enforces this).
    const { data: member } = await this.ctx.supabase
      .from('organization_members')
      .select('organization_id, role')
      .eq('user_id', targetUserId)
      .eq('organization_id', this.ctx.organizationId)
      .maybeSingle();
    if (!member) {
      throw new ServiceError(
        'not_found',
        'User is not a member of this organization.',
      );
    }

    // Atomic-replace: clear all existing rows, then insert the new set.
    // Two operations rather than upsert because we want anything missing
    // from the new set to be REMOVED, not preserved.
    await this.ctx.supabase
      .from('user_category_assignments')
      .delete()
      .eq('user_id', targetUserId);

    if (categoryIds.length > 0) {
      const rows = categoryIds.map((category_id) => ({
        organization_id: this.ctx.organizationId,
        user_id: targetUserId,
        category_id,
        assigned_by: this.ctx.userId,
      }));
      const { error } = await this.ctx.supabase
        .from('user_category_assignments')
        .insert(rows);
      if (error) {
        throw new ServiceError('internal_error', error.message);
      }
    }

    void audit(
      {
        event: 'user.category_access.updated',
        entityType: 'user_profile',
        entityId: targetUserId,
        extra: { category_count: categoryIds.length },
      },
      this.ctx,
    );
  }
}
