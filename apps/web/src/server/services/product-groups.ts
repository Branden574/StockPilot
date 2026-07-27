import 'server-only';

import {
  buildGroupKey,
  type CountingUnit,
  type CreateProductGroupInput,
  type GroupKeyParts,
  type UpdateProductGroupInput,
} from '@stockpilot/core';

import { audit } from './audit';
import {
  assertModuleEnabled,
  assertPermission,
  ServiceError,
  withContext,
  type ServiceContext,
} from './context';

/** One `product_groups` row. Identity only — a group NEVER owns a quantity. */
export interface ProductGroupRow {
  id: string;
  organization_id: string;
  category_id: string | null;
  subcategory_key: string | null;
  name: string;
  brand: string | null;
  manufacturer: string | null;
  model: string | null;
  style_number: string | null;
  colorway: string | null;
  team: string | null;
  league: string | null;
  season: string | null;
  home_away: 'home' | 'away' | 'alternate' | null;
  color: string | null;
  size_scale_id: string | null;
  default_counting_unit: CountingUnit;
  tracking_mode: string | null;
  group_key: string;
  status: 'active' | 'archived' | 'discontinued';
  created_at: string;
  updated_at: string;
}

/**
 * A group total, DERIVED at read time from `product_group_rollups`. There is no
 * stored total anywhere and there must never be one — see the 0298 header.
 */
export interface GroupRollup {
  variantCount: number;
  totalQuantity: number;
  countingUnit: CountingUnit;
}

/** One variant row (an `inventory_items` row pointed at a group). */
export interface VariantRow {
  id: string;
  sku: string;
  name: string;
  quantity_on_hand: number;
  variant_size: string | null;
  variant_size_original: string | null;
  variant_size_system: string | null;
  variant_width: string | null;
  variant_fit: string | null;
  variant_color: string | null;
  jersey_number: string | null;
  player_name: string | null;
  variant_key: string | null;
  unit_of_measure: string | null;
  tracking_type: 'none' | 'lot' | 'serial' | 'serial_optional';
  warehouse_id: string | null;
  status: 'active' | 'archived' | 'discontinued';
}

const GROUP_COLUMNS =
  'id, organization_id, category_id, subcategory_key, name, brand, manufacturer, model, ' +
  'style_number, colorway, team, league, season, home_away, color, size_scale_id, ' +
  'default_counting_unit, tracking_mode, group_key, status, created_at, updated_at';

const VARIANT_COLUMNS =
  'id, sku, name, quantity_on_hand, variant_size, variant_size_original, variant_size_system, ' +
  'variant_width, variant_fit, variant_color, jersey_number, player_name, variant_key, ' +
  'unit_of_measure, tracking_type, warehouse_id, status';

export interface ProductGroupFilters {
  search?: string;
  categoryId?: string | null;
  subcategoryKey?: string | null;
  status?: 'active' | 'archived' | 'discontinued';
  limit?: number;
}

/**
 * Product-group identity. Every method here is about WHICH product something
 * is, never about how much of it there is.
 *
 * `group_key` is SERVER-COMPUTED, always. It is rebuilt with `buildGroupKey`
 * from the parsed attributes on every write path and is never read from a
 * caller-supplied field: `product_groups.group_key` is UNIQUE per org, so a
 * forged key does not error — it silently merges two distinct products, and
 * their stock with them.
 */
export class ProductGroupsService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new ProductGroupsService(await withContext());
  }

  async list(filters: ProductGroupFilters = {}): Promise<ProductGroupRow[]> {
    assertModuleEnabled(this.ctx, 'sports');
    let q = this.ctx.supabase
      .from('product_groups')
      .select(GROUP_COLUMNS)
      .eq('organization_id', this.ctx.organizationId)
      .is('deleted_at', null)
      .eq('status', filters.status ?? 'active')
      .order('name', { ascending: true })
      .limit(Math.min(filters.limit ?? 100, 200));
    if (filters.categoryId) q = q.eq('category_id', filters.categoryId);
    if (filters.subcategoryKey) q = q.eq('subcategory_key', filters.subcategoryKey);
    if (filters.search && filters.search.trim().length > 0) {
      // Escape the PostgREST `or` metacharacters so a search string cannot
      // inject a second filter arm.
      const term = filters.search.trim().replace(/[,()*\\]/g, '');
      if (term.length > 0) {
        q = q.or(
          `name.ilike.%${term}%,brand.ilike.%${term}%,model.ilike.%${term}%,` +
            `style_number.ilike.%${term}%,team.ilike.%${term}%`,
        );
      }
    }
    const { data, error } = await q;
    if (error) throw new ServiceError('internal_error', error.message);
    return (data ?? []) as unknown as ProductGroupRow[];
  }

  async get(id: string): Promise<ProductGroupRow> {
    assertModuleEnabled(this.ctx, 'sports');
    const { data, error } = await this.ctx.supabase
      .from('product_groups')
      .select(GROUP_COLUMNS)
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) throw new ServiceError('not_found', 'Product group not found.');
    return data as unknown as ProductGroupRow;
  }

  /** Exact key lookup. Returns null rather than throwing — callers branch on it. */
  async findByKey(groupKey: string): Promise<ProductGroupRow | null> {
    const { data, error } = await this.ctx.supabase
      .from('product_groups')
      .select(GROUP_COLUMNS)
      .eq('organization_id', this.ctx.organizationId)
      .eq('group_key', groupKey)
      .is('deleted_at', null)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    return (data as unknown as ProductGroupRow | null) ?? null;
  }

  /**
   * Find an existing group by its deterministic key, or create one.
   *
   * NEVER fuzzy-matches. `candidates()` is the separate, advisory path that
   * surfaces near-misses for a HUMAN to resolve — this method is exact-key
   * only, so an import can never auto-merge an uncertain match.
   */
  async findOrCreate(
    input: CreateProductGroupInput & { subcategoryKey: string },
  ): Promise<{ group: ProductGroupRow; created: boolean }> {
    assertPermission(this.ctx, 'items:create');
    assertModuleEnabled(this.ctx, 'sports');

    const groupKey = buildGroupKey({
      subcategoryKey: input.subcategoryKey,
      brand: input.brand,
      model: input.model,
      styleNumber: input.styleNumber,
      colorway: input.colorway,
      team: input.team,
      league: input.league,
      season: input.season,
      homeAway: input.homeAway,
      manufacturer: input.manufacturer,
      color: input.color,
      name: input.name,
    });

    const existing = await this.findByKey(groupKey);
    if (existing) {
      void audit(
        { event: 'sports.group.matched', entityType: 'product_group', entityId: existing.id },
        this.ctx,
      );
      return { group: existing, created: false };
    }

    const { data, error } = await this.ctx.supabase
      .from('product_groups')
      .insert({
        organization_id: this.ctx.organizationId,
        category_id: input.categoryId ?? null,
        subcategory_key: input.subcategoryKey,
        name: input.name,
        brand: input.brand ?? null,
        manufacturer: input.manufacturer ?? null,
        model: input.model ?? null,
        style_number: input.styleNumber ?? null,
        colorway: input.colorway ?? null,
        team: input.team ?? null,
        league: input.league ?? null,
        season: input.season ?? null,
        home_away: input.homeAway ?? null,
        color: input.color ?? null,
        size_scale_id: input.sizeScaleId ?? null,
        default_counting_unit: input.defaultCountingUnit,
        tracking_mode: input.trackingMode ?? null,
        group_key: groupKey,
        created_by: this.ctx.userId,
        updated_by: this.ctx.userId,
      })
      .select(GROUP_COLUMNS)
      .single();

    if (error) {
      // 23505 = a concurrent writer won the race on product_groups_org_key_uniq.
      // Re-read rather than failing: both callers wanted the same identity.
      if ((error as { code?: string }).code === '23505') {
        const raced = await this.findByKey(groupKey);
        if (raced) return { group: raced, created: false };
      }
      throw new ServiceError('internal_error', error.message);
    }

    void audit(
      {
        event: 'sports.group.created',
        entityType: 'product_group',
        entityId: (data as unknown as ProductGroupRow).id,
      },
      this.ctx,
    );
    return { group: data as unknown as ProductGroupRow, created: true };
  }

  /**
   * Patch a group's identity attributes.
   *
   * `group_key` is RECOMPUTED here from the merged row, never patched: editing
   * a brand or a style number changes WHICH product this is, so leaving the old
   * key behind would let the next import create a second group for the same
   * identity. `organization_id` is not patchable at all — see the migration
   * that pins it (`tg_pin_product_group_org`).
   */
  async update(id: string, patch: UpdateProductGroupInput): Promise<ProductGroupRow> {
    assertPermission(this.ctx, 'sports:manage');
    assertModuleEnabled(this.ctx, 'sports');

    const current = await this.get(id);
    const merged = {
      subcategoryKey: patch.subcategoryKey ?? current.subcategory_key ?? '',
      name: patch.name ?? current.name,
      brand: patch.brand !== undefined ? patch.brand : current.brand,
      manufacturer: patch.manufacturer !== undefined ? patch.manufacturer : current.manufacturer,
      model: patch.model !== undefined ? patch.model : current.model,
      styleNumber: patch.styleNumber !== undefined ? patch.styleNumber : current.style_number,
      colorway: patch.colorway !== undefined ? patch.colorway : current.colorway,
      team: patch.team !== undefined ? patch.team : current.team,
      league: patch.league !== undefined ? patch.league : current.league,
      season: patch.season !== undefined ? patch.season : current.season,
      homeAway: patch.homeAway !== undefined ? patch.homeAway : current.home_away,
      color: patch.color !== undefined ? patch.color : current.color,
    };
    const groupKey = buildGroupKey(merged);

    const { data, error } = await this.ctx.supabase
      .from('product_groups')
      .update({
        ...(patch.categoryId !== undefined ? { category_id: patch.categoryId } : {}),
        ...(patch.subcategoryKey !== undefined
          ? { subcategory_key: patch.subcategoryKey }
          : {}),
        name: merged.name,
        brand: merged.brand,
        manufacturer: merged.manufacturer,
        model: merged.model,
        style_number: merged.styleNumber,
        colorway: merged.colorway,
        team: merged.team,
        league: merged.league,
        season: merged.season,
        home_away: merged.homeAway,
        color: merged.color,
        ...(patch.sizeScaleId !== undefined ? { size_scale_id: patch.sizeScaleId } : {}),
        ...(patch.defaultCountingUnit !== undefined
          ? { default_counting_unit: patch.defaultCountingUnit }
          : {}),
        ...(patch.trackingMode !== undefined ? { tracking_mode: patch.trackingMode } : {}),
        group_key: groupKey,
        updated_by: this.ctx.userId,
      })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .is('deleted_at', null)
      .select(GROUP_COLUMNS)
      .maybeSingle();
    if (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new ServiceError(
          'conflict',
          'Another product group already has this identity. Merge them instead of creating a duplicate.',
          { code: 'POSSIBLE_PRODUCT_GROUP_DUPLICATE' },
        );
      }
      throw new ServiceError('internal_error', error.message);
    }
    // .update().eq() is FAIL-OPEN when RLS hides the row: no error, no row.
    if (!data) throw new ServiceError('not_found', 'Product group not found.');
    return data as unknown as ProductGroupRow;
  }

  /** Derived roll-ups. Reads the view; never a stored total. */
  async rollups(groupIds: string[]): Promise<Map<string, GroupRollup>> {
    if (groupIds.length === 0) return new Map();
    const { data, error } = await this.ctx.supabase
      .from('product_group_rollups')
      .select('group_id, variant_count, total_quantity, counting_unit')
      .in('group_id', groupIds);
    if (error) throw new ServiceError('internal_error', error.message);
    const out = new Map<string, GroupRollup>();
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      out.set(r.group_id as string, {
        variantCount: Number(r.variant_count),
        totalQuantity: Number(r.total_quantity),
        countingUnit: r.counting_unit as CountingUnit,
      });
    }
    return out;
  }

  /** The variants (inventory_items rows) under one group. */
  async variants(groupId: string): Promise<VariantRow[]> {
    const { data, error } = await this.ctx.supabase
      .from('inventory_items')
      .select(VARIANT_COLUMNS)
      .eq('organization_id', this.ctx.organizationId)
      .eq('group_id', groupId)
      .is('deleted_at', null)
      .order('variant_size', { ascending: true })
      .order('sku', { ascending: true });
    if (error) throw new ServiceError('internal_error', error.message);
    return (data ?? []) as unknown as VariantRow[];
  }

  /**
   * Advisory near-miss candidates for the review UI. Suggestion, never a link
   * (the 0233 discipline). Returns at most 5, ordered by how many identifying
   * attributes agree.
   *
   * NAME IS NEVER A PROBE. A group whose only distinguishing attribute is its
   * name produces no candidates at all — matching is deterministic and never
   * name-string-only (requirements 13), and a name probe is exactly the
   * heuristic that would bake a wrong grouping into persistent identity.
   */
  async candidates(parts: GroupKeyParts): Promise<ProductGroupRow[]> {
    const q = () =>
      this.ctx.supabase
        .from('product_groups')
        .select(GROUP_COLUMNS)
        .eq('organization_id', this.ctx.organizationId)
        .is('deleted_at', null)
        .eq('status', 'active')
        .limit(5);
    if (parts.styleNumber) {
      const { data, error } = await q().ilike('style_number', parts.styleNumber);
      if (error) throw new ServiceError('internal_error', error.message);
      return (data ?? []) as unknown as ProductGroupRow[];
    }
    if (parts.brand && parts.model) {
      const { data, error } = await q().ilike('brand', parts.brand).ilike('model', parts.model);
      if (error) throw new ServiceError('internal_error', error.message);
      return (data ?? []) as unknown as ProductGroupRow[];
    }
    if (parts.team) {
      const { data, error } = await q().ilike('team', parts.team);
      if (error) throw new ServiceError('internal_error', error.message);
      return (data ?? []) as unknown as ProductGroupRow[];
    }
    return [];
  }
}
