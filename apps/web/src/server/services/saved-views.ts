import 'server-only';

import { getWarehouseAccess } from '@/lib/auth/warehouse';
import { isAtLeast, isManagerOrAbove, type Role } from '@stockpilot/core';

import { ServiceError, withContext, type ServiceContext } from './context';

import type { ItemListSort } from './inventory';

export type SavedViewScope = 'inventory' | 'books';

/**
 * Toolbar state snapshot. All keys optional so a view can encode just
 * what it cares about (e.g. "Out of stock" only sets `stock`). Keep
 * this in sync with the URL params parsed by the inventory + books
 * pages and the multi-select category/location filters.
 */
export interface SavedViewState {
  q?: string;
  status?: 'active' | 'archived' | 'discontinued' | 'all';
  stock?: 'low' | 'out';
  type?: 'product' | 'book' | 'asset' | 'consumable' | 'all';
  sort?: ItemListSort;
  cat?: string[];
  loc?: string[];
  warehouseId?: string | null;
}

export interface SavedView {
  id: string;
  scope: SavedViewScope;
  name: string;
  state: SavedViewState;
  sortOrder: number;
  createdAt: string;
  /** True when this view is shared with the whole org. Non-owners see
   *  shared views as read-only chips (no share-toggle / delete). */
  isShared: boolean;
  /** Owner's user id — used by the client to decide whether to show
   *  owner-only actions (toggle share, delete) on org-shared views. Null for
   *  a shared view whose owner deleted their account (B23: once the database
   *  keeps such a view for the team instead of deleting it with the account;
   *  never null before that). */
  ownerId: string | null;
  /** Whether this viewer may delete the view (server-computed, the rule the
   *  delete runs by): its owner; or, for a shared view whose owner deleted
   *  their account, an admin or owner of the organization, so a view nobody
   *  owns can still be cleaned up. */
  canRemove: boolean;
}

type SavedViewRow = {
  id: string;
  name: string;
  scope: SavedViewScope;
  state: unknown;
  sort_order: number;
  created_at: string;
  is_shared: boolean;
  user_id: string | null;
};

/** The columns every read and write of a view returns. */
const VIEW_COLUMNS = 'id, name, scope, state, sort_order, created_at, is_shared, user_id';

const VALID_STATUSES = new Set(['active', 'archived', 'discontinued', 'all']);
const VALID_STOCKS = new Set(['low', 'out']);
const VALID_TYPES = new Set(['product', 'book', 'asset', 'consumable', 'all']);
const VALID_SORTS = new Set<ItemListSort>([
  'updated_desc',
  'updated_asc',
  'name_asc',
  'name_desc',
  'sku_asc',
  'sku_desc',
  'qty_desc',
  'qty_asc',
  'created_desc',
  'created_asc',
]);

/**
 * Whitelist + sanitize what callers send in. Anything not in our schema
 * is stripped — we don't want random keys from a tampered request to
 * end up in the jsonb column.
 */
function sanitizeState(raw: unknown): SavedViewState {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const out: SavedViewState = {};
  if (typeof r.q === 'string' && r.q.length > 0) out.q = r.q.slice(0, 200);
  if (typeof r.status === 'string' && VALID_STATUSES.has(r.status)) {
    out.status = r.status as SavedViewState['status'];
  }
  if (typeof r.stock === 'string' && VALID_STOCKS.has(r.stock)) {
    out.stock = r.stock as SavedViewState['stock'];
  }
  if (typeof r.type === 'string' && VALID_TYPES.has(r.type)) {
    out.type = r.type as SavedViewState['type'];
  }
  if (typeof r.sort === 'string' && VALID_SORTS.has(r.sort as ItemListSort)) {
    out.sort = r.sort as ItemListSort;
  }
  if (Array.isArray(r.cat)) {
    out.cat = r.cat.filter((v): v is string => typeof v === 'string').slice(0, 50);
  }
  if (Array.isArray(r.loc)) {
    out.loc = r.loc.filter((v): v is string => typeof v === 'string').slice(0, 50);
  }
  if (r.warehouseId === null) out.warehouseId = null;
  else if (typeof r.warehouseId === 'string' && r.warehouseId.length > 0) {
    out.warehouseId = r.warehouseId;
  }
  return out;
}

export class SavedViewsService {
  constructor(private readonly ctx: ServiceContext) {}

  /** An admin or owner of this organization (the orphaned-view cleanup). */
  private isOrgAdmin(): boolean {
    return isAtLeast(this.ctx.role as Role, 'admin');
  }

  private toView(r: SavedViewRow): SavedView {
    const ownerId = r.user_id ?? null;
    return {
      id: r.id,
      name: r.name,
      scope: r.scope,
      state: sanitizeState(r.state),
      sortOrder: r.sort_order,
      createdAt: r.created_at,
      isShared: r.is_shared,
      ownerId,
      canRemove:
        ownerId === this.ctx.userId || (ownerId === null && r.is_shared && this.isOrgAdmin()),
    };
  }

  static async forCurrentUser() {
    return new SavedViewsService(await withContext());
  }

  /**
   * Returns the user's own views PLUS any org-shared views in the same
   * scope. RLS already enforces visibility; we just rely on it instead
   * of filtering client-side. Owner-id is included so the UI can hide
   * destructive actions on views the current user doesn't own.
   */
  async list(scope: SavedViewScope): Promise<SavedView[]> {
    const { data, error } = await this.ctx.supabase
      .from('saved_views')
      .select(VIEW_COLUMNS)
      .eq('organization_id', this.ctx.organizationId)
      .eq('scope', scope)
      .order('is_shared', { ascending: true }) // own first, shared after
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) throw new ServiceError('internal_error', error.message);

    // Defense in depth: a view shared org-wide can encode a warehouseId
    // the current viewer doesn't have access to (e.g. shared by a
    // manager, applied by a warehouse-scoped staff). Drop those so the
    // chip never appears for someone who can't use it. Own views are
    // always kept — the user picked their own warehouse.
    //
    // Manager-and-above skip the access lookup: getWarehouseAccess answers
    // hasAllAccess = true for them on the SAME isManagerOrAbove(role) test
    // (lib/auth/warehouse.ts) whatever its read returns, so the filter below
    // kept every view for them anyway. Called with this ctx, that lookup is a
    // direct `warehouses` read (a ctx-supplied client bypasses the request
    // cache), issued only AFTER the saved_views read above: a second serial
    // Supabase call in front of the Items/Books table on every render.
    // Staff/viewer (the 0280 all-warehouses flag included) keep the lookup.
    const access = isManagerOrAbove(this.ctx.role as Role)
      ? null
      : await getWarehouseAccess(this.ctx);
    return (data ?? [])
      .map((row) => this.toView(row as SavedViewRow))
      .filter((v) => {
        if (v.ownerId === this.ctx.userId) return true;
        const wh = v.state.warehouseId;
        if (!wh) return true;
        if (!access) return true; // manager-and-above: all access, see above
        return access.hasAllAccess || access.readableIds.includes(wh);
      });
  }

  async create(input: {
    scope: SavedViewScope;
    name: string;
    state: SavedViewState;
    isShared?: boolean;
  }): Promise<SavedView> {
    const name = input.name.trim();
    if (name.length === 0 || name.length > 80) {
      throw new ServiceError('validation_error', 'View name must be 1–80 characters.');
    }
    const sanitized = sanitizeState(input.state);
    const { data, error } = await this.ctx.supabase
      .from('saved_views')
      .insert({
        organization_id: this.ctx.organizationId,
        user_id: this.ctx.userId,
        scope: input.scope,
        name,
        state: sanitized,
        is_shared: input.isShared ?? false,
      })
      .select(VIEW_COLUMNS)
      .single();
    if (error) {
      // 23505 = unique_violation (user_id, org_id, scope, name)
      if (error.code === '23505') {
        throw new ServiceError(
          'validation_error',
          'A view with that name already exists.',
        );
      }
      throw new ServiceError('internal_error', error.message);
    }
    return this.toView(data as SavedViewRow);
  }

  /**
   * Owner-only: flip whether a view is shared with the org. Proves a row
   * changed (recurring pattern 2): RLS answers a view that is not the
   * caller's, or is gone, with 0 rows and no error, which used to read as
   * success.
   */
  async setSharing(id: string, isShared: boolean): Promise<void> {
    const { data, error } = await this.ctx.supabase
      .from('saved_views')
      .update({ is_shared: isShared })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .eq('user_id', this.ctx.userId)
      .select('id');
    if (error) throw new ServiceError('internal_error', error.message);
    if (!Array.isArray(data) || data.length === 0) {
      throw new ServiceError(
        'not_found',
        'This view could not be changed. It may have been deleted, or only the person who saved it can change it.',
      );
    }
  }

  /**
   * Delete a view: the caller's own, or (an admin or owner only) a shared view
   * whose owner deleted their account (B23), which nobody else can ever
   * remove. Each delete is scoped to this organization and proves a row went
   * (recurring pattern 2); RLS still decides both.
   */
  async remove(id: string): Promise<void> {
    if (await this.deleteWhere(id, 'own')) return;
    if (this.isOrgAdmin() && (await this.deleteWhere(id, 'orphan'))) return;
    throw new ServiceError(
      'not_found',
      'This view could not be deleted. It may have been deleted already, or only the person who saved it can delete it.',
    );
  }

  private async deleteWhere(id: string, whose: 'own' | 'orphan'): Promise<boolean> {
    let q = this.ctx.supabase
      .from('saved_views')
      .delete()
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id);
    q =
      whose === 'own'
        ? q.eq('user_id', this.ctx.userId)
        : q.is('user_id', null).eq('is_shared', true);
    const { data, error } = await q.select('id');
    if (error) throw new ServiceError('internal_error', error.message);
    return Array.isArray(data) && data.length > 0;
  }
}
