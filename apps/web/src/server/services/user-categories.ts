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
    // enforces the visibility boundary (user_can_see_item_category
    // returns false when no role row exists in the requested org).
    if (!role) return null;
    if (role !== 'viewer') return null;    // unrestricted by role

    // org-scoped — a user may be a viewer here AND in another org;
    // we MUST only consider grants for THIS org. Mirrors the
    // organization_id filter applied inside user_can_see_item_category
    // in migration 0129.
    const { data: rows } = await this.ctx.supabase
      .from('user_category_assignments')
      .select('category_id')
      .eq('user_id', userId)
      .eq('organization_id', this.ctx.organizationId);
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
   *
   * Delegates to the `set_user_category_access` RPC (migration 0129)
   * which performs the DELETE+INSERT in a single transaction. The
   * previous two-step JS implementation had a window where a failed
   * INSERT after a successful DELETE would silently elevate the
   * viewer from restricted to unrestricted (zero rows = unrestricted
   * per the truth table).
   */
  async setUserCategoryAccess(
    targetUserId: string,
    categoryIds: string[],
  ): Promise<void> {
    assertPermission(this.ctx, 'members:assign_categories');

    // Verify target user is in OUR org (defense in depth — the RPC
    // checks again, but a friendlier error message is nice).
    const { data: member } = await this.ctx.supabase
      .from('organization_members')
      .select('organization_id')
      .eq('user_id', targetUserId)
      .eq('organization_id', this.ctx.organizationId)
      .maybeSingle();
    if (!member) {
      throw new ServiceError(
        'not_found',
        'User is not a member of this organization.',
      );
    }

    // Capture the previous set BEFORE replacing so the audit can
    // record the delta — useful when an auditor needs to know which
    // categories were granted vs revoked, not just the final count.
    const { data: priorRows } = await this.ctx.supabase
      .from('user_category_assignments')
      .select('category_id')
      .eq('user_id', targetUserId)
      .eq('organization_id', this.ctx.organizationId);
    const prior = new Set(
      ((priorRows ?? []) as Array<{ category_id: string }>).map((r) => r.category_id),
    );
    const next = new Set(categoryIds);

    // No-op short-circuit: identical sets = skip the RPC + audit so
    // accidental double-clicks don't pollute the audit log.
    if (prior.size === next.size && [...prior].every((id) => next.has(id))) {
      return;
    }

    const { error } = await this.ctx.supabase.rpc('set_user_category_access', {
      p_org_id: this.ctx.organizationId,
      p_user_id: targetUserId,
      p_caller_id: this.ctx.userId,
      p_category_ids: categoryIds,
    });
    if (error) {
      if (error.code === 'P0002') {
        throw new ServiceError('not_found', 'User is not a member of this organization.');
      }
      if (error.code === '42501') {
        throw new ServiceError('forbidden', 'Manager role required to assign categories.');
      }
      throw new ServiceError('internal_error', error.message);
    }

    const granted = [...next].filter((id) => !prior.has(id));
    const revoked = [...prior].filter((id) => !next.has(id));

    void audit(
      {
        event: 'user.category_access.updated',
        entityType: 'user_profile',
        entityId: targetUserId,
        extra: {
          category_count: categoryIds.length,
          granted_ids: granted,
          revoked_ids: revoked,
        },
      },
      this.ctx,
    );
  }
}
