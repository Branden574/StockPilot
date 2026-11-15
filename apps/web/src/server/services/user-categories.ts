import { isAtLeast } from '@stockpilot/core';

import { audit } from './audit';
import { ServiceContext, ServiceError, assertPermission } from './context';

/**
 * Service for managing per-viewer category visibility grants.
 *
 * Background: viewer accounts can be restricted to a subset of
 * categories via rows in `user_category_assignments`. The Postgres
 * RLS policies `inventory_items_select` and `categories_select`
 * enforce the restriction at the database level (0128 added it as two
 * separate policies; 0129 folded it into these two) — this service is
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
   * Mirrors the truth table RLS applies through
   * `rls_cat_unrestricted_org_ids` and `rls_cat_allowed_category_ids`
   * (read by `categories_select` and `inventory_items_select`). Used
   * by the orders/new picker cache-key hash and by `InventoryService.list`
   * for defense-in-depth filtering.
   */
  /**
   * The category grants of a caller ALREADY KNOWN to be a viewer in this
   * organization (ctx.role, from the request context's membership read under
   * the caller's own RLS). Same answer as getAccessibleCategoryIds for a
   * viewer, without re-reading the membership row: one read instead of two in
   * series, so the list's defensive filter can be read alongside the warehouse
   * access instead of after it. A failed read THROWS (never "no grants", which
   * would mean unrestricted); callers that treat this filter as
   * defense-in-depth catch it and leave visibility to RLS.
   */
  async getGrantedCategoryIdsForViewer(userId: string): Promise<Set<string> | null> {
    const { data: rows, error } = await this.ctx.supabase
      .from('user_category_assignments')
      .select('category_id')
      .eq('user_id', userId)
      .eq('organization_id', this.ctx.organizationId);
    if (error) throw new Error(`user_category_assignments read failed: ${error.message}`);
    const list = ((rows ?? []) as Array<{ category_id: string }>).map((r) => r.category_id);
    if (list.length === 0) return null; // viewer with no grants = unrestricted
    return new Set(list);
  }

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
    // enforces the visibility boundary (categories_select and
    // inventory_items_select read rls_cat_unrestricted_org_ids and
    // rls_cat_allowed_category_ids, which hold nothing for a user with
    // no membership row in the requested org).
    if (!role) return null;
    if (role !== 'viewer') return null;    // unrestricted by role

    // org-scoped — a user may be a viewer here AND in another org;
    // we MUST only consider grants for THIS org. Mirrors RLS, which
    // matches the (organization_id, category_id) pairs
    // rls_cat_allowed_category_ids returns.
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

  /**
   * Grants or revokes ONE category for ONE member of the caller's
   * organization, named by the membership id (organization_members.id). The
   * /api/v1/members/[id]/category-access route calls it, once per category.
   *
   * ONE ROW, NEVER THE SET. A grant inserts the one row (organization, the
   * member's account, the category); a revoke deletes that one row. Nothing
   * here reads a list from the caller or rewrites the member's other grants,
   * and set_user_category_access (the whole-set replace above) is not called.
   * So two people changing different categories of one member at once both
   * land, whatever either screen showed when it was opened. For the same
   * category, the table's unique (user_id, category_id) lets one of two
   * grants in, and the other is answered as already granted; a grant and a
   * revoke land in the order the database commits them. Each is one
   * statement, atomic on its own: a failure leaves the member's grants as
   * they were.
   *
   * The table's truth is unchanged: a viewer with no rows left sees every
   * category. A revoke of the last grant does that here as it does through
   * the whole-set replace with an empty list.
   *
   * Checks, in order, all before the write:
   *   - members:assign_categories (after the authenticator rule), as above;
   *   - the manager role. The table's write rule and
   *     set_user_category_access both ask for it. Said here because a delete
   *     that the rule filters answers "no row" instead of a refusal;
   *   - the member, read in the caller's organization (not_found otherwise);
   *   - for a grant, the category, read in the caller's organization.
   *
   * A change writes one user.category_access.updated audit row, in the shape
   * of the whole-set row: the count after the change and the one id granted
   * or revoked. A request that changes nothing (the grant is already there,
   * or there is nothing to revoke) writes no row and answers changed false.
   *
   * Returns the member's grants as read after the write, for the caller to
   * show; null when that read failed (the change is saved and audited).
   */
  async setMemberCategoryGrant(
    memberId: string,
    categoryId: string,
    granted: boolean,
  ): Promise<{ changed: boolean; categoryIds: string[] | null }> {
    assertPermission(this.ctx, 'members:assign_categories');
    if (!isAtLeast(this.ctx.role, 'manager')) {
      throw new ServiceError('forbidden', 'Manager role required to assign categories.');
    }

    const { data: member, error: memberError } = await this.ctx.supabase
      .from('organization_members')
      .select('user_id')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', memberId)
      .maybeSingle();
    if (memberError) throw new ServiceError('internal_error', memberError.message);
    if (!member) throw new ServiceError('not_found', 'Member not found');
    const targetUserId = (member as { user_id: string }).user_id;

    let changed: boolean;
    /** The insert was refused as a duplicate: the grant should already be there. */
    let duplicate = false;
    if (granted) {
      const { data: category, error: categoryError } = await this.ctx.supabase
        .from('categories')
        .select('id')
        .eq('organization_id', this.ctx.organizationId)
        .eq('id', categoryId)
        .maybeSingle();
      if (categoryError) throw new ServiceError('internal_error', categoryError.message);
      if (!category) throw new ServiceError('not_found', 'Category not found');

      const { error } = await this.ctx.supabase.from('user_category_assignments').insert({
        organization_id: this.ctx.organizationId,
        user_id: targetUserId,
        category_id: categoryId,
        assigned_by: this.ctx.userId,
      });
      if (error) {
        if (error.code === '42501') {
          throw new ServiceError('forbidden', 'Manager role required to assign categories.');
        }
        // The member's account or the category was removed since the reads above.
        if (error.code === '23503') {
          throw new ServiceError('not_found', 'Member or category not found');
        }
        // 23505: unique (user_id, category_id). The row is already there.
        if (error.code !== '23505') throw new ServiceError('internal_error', error.message);
        duplicate = true;
      }
      changed = !error;
    } else {
      const { data: removed, error } = await this.ctx.supabase
        .from('user_category_assignments')
        .delete()
        .eq('organization_id', this.ctx.organizationId)
        .eq('user_id', targetUserId)
        .eq('category_id', categoryId)
        .select('id');
      if (error) throw new ServiceError('internal_error', error.message);
      changed = ((removed ?? []) as Array<{ id: string }>).length > 0;
    }

    // The member's grants now, in this organization: the count for the audit
    // row and the list the caller shows.
    const { data: rows, error: readError } = await this.ctx.supabase
      .from('user_category_assignments')
      .select('category_id')
      .eq('user_id', targetUserId)
      .eq('organization_id', this.ctx.organizationId);
    const categoryIds = readError
      ? null
      : ((rows ?? []) as Array<{ category_id: string }>).map((r) => r.category_id);

    // Refused as a duplicate, yet the member does not hold the grant when it
    // is read back: it changed in between. Nothing was changed here; say so
    // instead of "already granted".
    if (duplicate && categoryIds && !categoryIds.includes(categoryId)) {
      throw new ServiceError(
        'conflict',
        'That category access changed meanwhile. Reload and try again.',
      );
    }

    if (changed) {
      // Awaited, with the caller's context: a Bearer caller has no cookie
      // context for audit() to fall back to.
      await audit(
        {
          event: 'user.category_access.updated',
          entityType: 'user_profile',
          entityId: targetUserId,
          extra: {
            category_count: categoryIds ? categoryIds.length : null,
            granted_ids: granted ? [categoryId] : [],
            revoked_ids: granted ? [] : [categoryId],
          },
        },
        this.ctx,
      );
    }
    return { changed, categoryIds };
  }
}
