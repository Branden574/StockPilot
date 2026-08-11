import 'server-only';

import {
  buildGroupKey,
  buildSizeOrder,
  type CountingUnit,
  type CreateProductGroupInput,
  type GroupKeyParts,
  type SizeOrderIndex,
  type SizeScaleValueOrder,
  type UpdateProductGroupInput,
} from '@stockpilot/core';

import { audit } from './audit';
import {
  assertAnyPermission,
  assertModuleEnabled,
  assertPermission,
  ServiceError,
  withContext,
  type ServiceContext,
} from './context';
import { fetchAllRows } from './lib/paginate';

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

/**
 * The read-time shape a size-run renderer needs: what the group is called,
 * what its quantities are counted in, and what order its sizes go in. Carries
 * NO quantity — a group owns none, ever (see the 0298 header).
 */
export interface ProductGroupDisplay {
  name: string;
  countingUnit: CountingUnit;
  sizeOrder: SizeOrderIndex;
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
 * The message an archive refusal carries. Same shape as the item archive's
 * stock-guard copy (`formatArchiveStockBlockMessage`): name the COUNT, say what
 * to do about it, and say plainly that a deliberate override exists — a refusal
 * that hides the way forward just gets worked around with SQL, which is the
 * thing this affordance exists to stop.
 */
function formatGroupVariantBlockMessage(activeVariants: number): string {
  const noun = activeVariants === 1 ? 'variant' : 'variants';
  const verb = activeVariants === 1 ? 'is' : 'are';
  return (
    `Cannot archive: ${activeVariants} ${noun} ${verb} still linked to this product group. ` +
    `Unlink or archive ${activeVariants === 1 ? 'it' : 'them'} first, or archive the group ` +
    `anyway — the ${noun} stay linked and come back with it when you restore it.`
  );
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

  /**
   * The groups a page renders. ACTIVE ONLY unless a caller names another
   * status: this list is what "current" means, so an archived group is absent
   * from it by default and is reachable only by asking for it explicitly
   * (`{ status: 'archived' }`) — which is how the page's archived view finds a
   * group to restore.
   */
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

  /**
   * The lean (id, name, brand, model) rows a DESTINATION PICKER offers, paged.
   *
   * `list()` clamps its own limit at 200 (its callers are pages that render
   * cards), so a picker built on it silently offered the first 200 groups
   * alphabetically and gave a reviewer no way to reach group 201 — a cap with no
   * disclosure, which is recurring bug pattern #18. This reads only what an
   * `<option>` shows, pages past PostgREST's `max_rows`, and reports whether it
   * hit `cap` so the UI can say so instead of quietly truncating.
   *
   * ACTIVE ONLY, and not configurable: a picker offers a destination to link
   * items INTO, and an archived group is not a destination anyone means to pick.
   */
  async listForPicker(
    cap = 2000,
  ): Promise<{
    groups: Array<{ id: string; name: string; brand: string | null; model: string | null }>;
    truncated: boolean;
  }> {
    assertModuleEnabled(this.ctx, 'sports');
    const rows = await fetchAllRows<{
      id: string;
      name: string;
      brand: string | null;
      model: string | null;
    }>(
      (from, to) =>
        this.ctx.supabase
          .from('product_groups')
          .select('id, name, brand, model')
          .eq('organization_id', this.ctx.organizationId)
          .is('deleted_at', null)
          .eq('status', 'active')
          // Stable paging key; the display order is applied below.
          .order('id', { ascending: true })
          .range(from, to),
      { cap: cap + 1 },
    );
    const truncated = rows.length > cap;
    const groups = (truncated ? rows.slice(0, cap) : rows).sort((a, b) =>
      a.name.localeCompare(b.name, 'en'),
    );
    return { groups, truncated };
  }

  /**
   * One group by id, at ANY status — deliberately status-agnostic. Archive and
   * restore both read the row they are about to flip, and an archived group has
   * to stay reachable or it could never be restored. Callers that mean "current"
   * use `list()`, which filters.
   */
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

  /**
   * Exact key lookup. Returns null rather than throwing — callers branch on it.
   *
   * MATCHES AN ARCHIVED GROUP TOO, and must: `product_groups_org_key_uniq` is
   * partial on `deleted_at is null`, and archiving writes only `status`, so an
   * archived group still HOLDS its group_key. A status filter here would make
   * findOrCreate miss that row and try to insert a second group for the same
   * identity — a guaranteed 23505, and if the index were ever loosened, a
   * duplicate identity created behind the archive's back. The archived group is
   * returned as-is; restoring it makes it current again.
   */
  async findByKey(groupKey: string): Promise<ProductGroupRow | null> {
    assertModuleEnabled(this.ctx, 'sports');
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
   *
   * EITHER permission opens this path. Two legitimate callers arrive by two
   * different routes: the item form (an `items:create` holder naming a new
   * sized product) and the group-linking review tool (a `sports:manage`
   * reviewer promoting an existing family). The linking write itself gates on
   * `sports:manage`, so demanding `items:create` here refused a reviewer at
   * the "create the group to link into" step of a screen they were entitled
   * to open. A group is identity and owns no stock, so neither permission is
   * the weaker one — see `assertAnyPermission`.
   */
  async findOrCreate(
    input: CreateProductGroupInput & { subcategoryKey: string },
  ): Promise<{ group: ProductGroupRow; created: boolean }> {
    assertAnyPermission(this.ctx, ['items:create', 'sports:manage']);
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
      // PRESENCE, not truthiness. `??` could not tell "absent — keep what the
      // row has" from "explicitly null — clear it", so a patch of
      // `{ subcategoryKey: null }` wrote NULL to the column while computing
      // group_key from the OLD subcategory. The subcategory decides which SLOTS
      // participate in the key at all (jersey slots vs shoe slots), so the
      // stored key described a shape the row no longer had and the next
      // findOrCreate for that identity missed it and minted a duplicate group.
      // Every other field below already tests presence; this one now does too.
      subcategoryKey:
        patch.subcategoryKey !== undefined
          ? (patch.subcategoryKey ?? '')
          : (current.subcategory_key ?? ''),
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

  /**
   * How many LIVE, non-archived variants still point at this group — the number
   * the archive guard names.
   *
   * `status <> 'archived'` rather than `= 'active'`: a discontinued variant is
   * still on every screen that means "current", so it still has to block.
   * `inventory_items.status` is NOT NULL (0002), so `.neq` cannot silently drop
   * a row here the way it would on a nullable column (the PostgREST NULL trap
   * that made placed stock unpickable in 0292) — and `group_id`, which IS
   * nullable, is compared with `.eq` to one id, never with `.in`/`not.in`.
   *
   * FAIL-CLOSED, like the item archive's `holdingsForGuard`: a read error, or a
   * count PostgREST declined to return, refuses the archive rather than letting
   * it through unproven. Refusing a legitimate archive is recoverable; hiding a
   * group whose sizes are still in use is the thing being prevented.
   */
  private async activeVariantCount(groupId: string): Promise<number> {
    const { count, error } = await this.ctx.supabase
      .from('inventory_items')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', this.ctx.organizationId)
      .eq('group_id', groupId)
      .neq('status', 'archived')
      .is('deleted_at', null);
    if (error || count === null || count === undefined) {
      throw new ServiceError(
        'internal_error',
        error?.message ??
          'Could not count this product group’s variants before archiving.',
      );
    }
    return Number(count);
  }

  /**
   * Archive a group: a SOFT, REVERSIBLE status change — `restore()`'s twin, and
   * the affordance whose absence forced a leftover test group to be deleted with
   * hand-written SQL against production.
   *
   * `status = 'archived'`, NEVER `deleted_at`. Every partial index on
   * product_groups is `where deleted_at is null`, uniqueness included
   * (`product_groups_org_key_uniq (organization_id, group_key)`), so a soft
   * delete would FREE the group_key and let the next findOrCreate mint a second
   * group for an identity that is still sitting there waiting to be restored.
   * Archiving keeps the key reserved and `findByKey` keeps matching the row (see
   * its note), so the identity cannot be duplicated behind the archive's back.
   * Nothing here writes `deleted_at`, and there is deliberately no hard delete.
   *
   * @param opts.acknowledgeActiveVariants When true, SKIP the variant guard —
   *   the deliberate "retire this product line even though its sizes are still
   *   on the shelf", modelled on the item archive's `acknowledgeStock`. The
   *   guard kills the SILENT hide, not the ability to do it on purpose.
   *   THOSE VARIANTS KEEP THEIR `group_id`: they go on pointing at an archived
   *   group, which is exactly what makes this reversible — restoring the group
   *   brings the whole run back intact. A delete could not offer that, because
   *   `inventory_items.group_id` is ON DELETE SET NULL and every link would be
   *   erased with no record of what it was.
   */
  async archive(
    id: string,
    opts: { acknowledgeActiveVariants?: boolean } = {},
  ): Promise<ProductGroupRow> {
    assertPermission(this.ctx, 'sports:manage');
    assertModuleEnabled(this.ctx, 'sports');

    // get() is status-agnostic, so this also reads an already-archived row: a
    // second archive is a no-op, not an error, and writes no audit noise for a
    // state that did not change (the same posture unlinkItems takes).
    const current = await this.get(id);
    if (current.status === 'archived') return current;

    if (!opts.acknowledgeActiveVariants) {
      const activeVariants = await this.activeVariantCount(id);
      if (activeVariants > 0) {
        throw new ServiceError(
          'validation_error',
          formatGroupVariantBlockMessage(activeVariants),
          { code: 'PRODUCT_GROUP_HAS_ACTIVE_VARIANTS', activeVariants },
        );
      }
    }

    const { data, error } = await this.ctx.supabase
      .from('product_groups')
      .update({ status: 'archived', updated_by: this.ctx.userId })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .is('deleted_at', null)
      .select(GROUP_COLUMNS)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    // .update().eq() is FAIL-OPEN when RLS hides the row: no error, no row, and
    // a caller that would report success for a write that never happened. The
    // returned row is the only proof the intended row was the one affected.
    if (!data) throw new ServiceError('not_found', 'Product group not found.');

    void audit(
      {
        event: 'sports.group.archived',
        entityType: 'product_group',
        entityId: id,
        before: { status: current.status },
        after: { status: 'archived' },
        // Records WHETHER the operator overrode the variant guard. "Archived
        // with its sizes still linked" and "archived when it was empty" are
        // different acts and the trail has to tell them apart.
        extra: { acknowledged_active_variants: opts.acknowledgeActiveVariants === true },
      },
      this.ctx,
    );
    return data as unknown as ProductGroupRow;
  }

  /**
   * Undo an archive. There is nothing to rebuild: archiving wrote `status` and
   * nothing else, so every variant still points here and the roll-ups recompute
   * from the variants at read time the moment the group is current again.
   *
   * Also the way out of 'discontinued', which is why the target is 'active'
   * rather than "whatever it was before".
   */
  async restore(id: string): Promise<ProductGroupRow> {
    assertPermission(this.ctx, 'sports:manage');
    assertModuleEnabled(this.ctx, 'sports');

    const current = await this.get(id);
    if (current.status === 'active') return current;

    const { data, error } = await this.ctx.supabase
      .from('product_groups')
      .update({ status: 'active', updated_by: this.ctx.userId })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .is('deleted_at', null)
      .select(GROUP_COLUMNS)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    // Same fail-open hazard, same confirmation as archive() above.
    if (!data) throw new ServiceError('not_found', 'Product group not found.');

    void audit(
      {
        event: 'sports.group.restored',
        entityType: 'product_group',
        entityId: id,
        before: { status: current.status },
        after: { status: 'active' },
      },
      this.ctx,
    );
    return data as unknown as ProductGroupRow;
  }

  /**
   * Derived roll-ups. Reads the view; never a stored total.
   *
   * STATUS-BLIND BY DESIGN: it aggregates exactly the group ids it is handed, so
   * whichever stance the caller's list took is the stance these figures follow.
   * The archived view needs its totals as much as the active one does.
   */
  async rollups(groupIds: string[]): Promise<Map<string, GroupRollup>> {
    assertModuleEnabled(this.ctx, 'sports');
    if (groupIds.length === 0) return new Map();
    const { data, error } = await this.ctx.supabase
      .from('product_group_rollups')
      .select('group_id, variant_count, total_quantity, counting_unit')
      // The view is security_invoker, so RLS already scopes it — but every
      // other read here carries the org filter and a defence-in-depth predicate
      // costs nothing. It also keeps the query honest if the view is ever read
      // through a service-role context, where RLS is not in play at all.
      .eq('organization_id', this.ctx.organizationId)
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

  /**
   * Everything a size-run RENDERER needs for a set of groups: the group's
   * name, its counting unit, and the order its sizes go in.
   *
   * The counting unit is READ from `default_counting_unit`, never inferred —
   * PAIR is a display convention with no conversion behind it (requirements
   * 5), so a surface that guessed "each" would print a number that means
   * something different from what the group says it means.
   *
   * The size order comes from the group's `size_scale_values.sort_order`. A
   * group with no scale returns an EMPTY order rather than no entry at all:
   * the caller still gets the name and unit, and `compareSizeValues` falls
   * back to its natural ladder. Groups the caller cannot see are simply absent
   * from the map — callers must handle a miss.
   *
   * ARCHIVED GROUPS INCLUDED, deliberately — the same reason `countingUnits`
   * includes them. This is a RENDERER's lookup, not a picker's: a variant whose
   * group was archived still has to print "52 pairs" on its own size-run header
   * instead of falling back to a bare count. Nothing is offered as a choice from
   * this map; the surfaces that offer a group to pick (`listForPicker`,
   * `candidates`) filter archived out themselves.
   */
  async displayByIds(groupIds: string[]): Promise<Map<string, ProductGroupDisplay>> {
    assertModuleEnabled(this.ctx, 'sports');
    const unique = Array.from(new Set(groupIds.filter(Boolean)));
    if (unique.length === 0) return new Map();

    // Chunked, not one `.in(...)`: `unique` can carry every product group id a
    // caller collected across a whole catalog (up to ~1000 — the PO create/edit
    // pages' page-level cap), and PostgREST's max_rows silently truncates a
    // single `.in()` past 1000 rows with NO error — the same failure mode
    // fixed in the portal catalog (23e319f6). A batch error is NOT swallowed:
    // this map decides which groups the size-run picker can even offer, so a
    // partial read must fail loud rather than quietly hiding a group.
    type GroupMetaRow = {
      id: string;
      name: string;
      default_counting_unit: CountingUnit;
      size_scale_id: string | null;
    };
    const GROUP_BATCH_SIZE = 500;
    const groups: GroupMetaRow[] = [];
    for (let i = 0; i < unique.length; i += GROUP_BATCH_SIZE) {
      const batch = unique.slice(i, i + GROUP_BATCH_SIZE);
      const { data: groupRows, error: groupErr } = await this.ctx.supabase
        .from('product_groups')
        .select('id, name, default_counting_unit, size_scale_id')
        .eq('organization_id', this.ctx.organizationId)
        .in('id', batch)
        .is('deleted_at', null);
      if (groupErr) throw new ServiceError('internal_error', groupErr.message);
      groups.push(...((groupRows ?? []) as GroupMetaRow[]));
    }

    const scaleIds = Array.from(
      new Set(groups.map((g) => g.size_scale_id).filter((v): v is string => Boolean(v))),
    );
    const valuesByScale = new Map<string, SizeScaleValueOrder[]>();
    if (scaleIds.length > 0) {
      const { data: valueRows, error: valueErr } = await this.ctx.supabase
        .from('size_scale_values')
        .select('size_scale_id, value, normalized, sort_order')
        .in('size_scale_id', scaleIds)
        .order('sort_order', { ascending: true });
      if (valueErr) throw new ServiceError('internal_error', valueErr.message);
      for (const row of (valueRows ?? []) as Array<Record<string, unknown>>) {
        const key = row.size_scale_id as string;
        const arr = valuesByScale.get(key);
        const entry: SizeScaleValueOrder = {
          value: row.value as string,
          normalized: (row.normalized as string | null) ?? null,
          sortOrder: Number(row.sort_order),
        };
        if (arr) arr.push(entry);
        else valuesByScale.set(key, [entry]);
      }
    }

    const out = new Map<string, ProductGroupDisplay>();
    for (const g of groups) {
      out.set(g.id, {
        name: g.name,
        countingUnit: g.default_counting_unit,
        sizeOrder: buildSizeOrder(
          g.size_scale_id ? (valuesByScale.get(g.size_scale_id) ?? []) : [],
        ),
      });
    }
    return out;
  }

  /**
   * Every counting unit the org's groups define, keyed by group id.
   *
   * For a surface that paginates on the CLIENT: units resolved from the rows
   * the SERVER happened to send go missing the moment the client renders a page
   * the server never built (the Items list's default view — see the page's
   * note). A superset cannot be wrong for any page, and it is one column-only
   * read for the whole org.
   *
   * ARCHIVED GROUPS INCLUDED, deliberately. A variant can point at a group
   * whose status was later changed, and its header still has to be able to say
   * "52 pairs" rather than falling back to a bare count.
   *
   * PAGED, because `product_groups` has no ceiling of its own and PostgREST
   * clamps every response at `max_rows` = 1000 with no error (the same landmine
   * fixed in `variantsByGroupIds` and `getTrainingStats`).
   */
  async countingUnits(): Promise<Record<string, CountingUnit>> {
    assertModuleEnabled(this.ctx, 'sports');
    const rows = await fetchAllRows<{ id: string; default_counting_unit: CountingUnit }>(
      (from, to) =>
        this.ctx.supabase
          .from('product_groups')
          .select('id, default_counting_unit')
          .eq('organization_id', this.ctx.organizationId)
          .is('deleted_at', null)
          // Stable paging key (fetchAllRows header): an unstable sort lands the
          // same row on two windows or on none.
          .order('id', { ascending: true })
          .range(from, to),
    );
    const out: Record<string, CountingUnit> = {};
    for (const r of rows) out[r.id] = r.default_counting_unit;
    return out;
  }

  /**
   * The variants (inventory_items rows) under one group.
   *
   * PAGED (review fix). This read is uncapped BY INTENT — a group's variant
   * panel shows the whole run — but "no `.limit()`" is not "no cap":
   * PostgREST clamps every response at `max_rows` = 1000 and reports nothing,
   * so a group past that silently rendered a prefix while its header (read from
   * the roll-up VIEW, which counts in the database) kept the true total. Same
   * landmine, same fix as `variantsByGroupIds`.
   *
   * The paging order MUST be the stable one, so the display sort (size, then
   * sku) is applied after the fact rather than in the query.
   */
  async variants(groupId: string): Promise<VariantRow[]> {
    assertModuleEnabled(this.ctx, 'sports');
    const rows = await fetchAllRows<VariantRow>(
      (from, to) =>
        // `VARIANT_COLUMNS` is a concatenated const, so PostgREST's type parser
        // cannot resolve it to a row type — the same reason every other read of
        // it in this file casts. The shape is asserted here rather than after
        // the loop so the accumulator is typed.
        this.ctx.supabase
          .from('inventory_items')
          .select(VARIANT_COLUMNS)
          .eq('organization_id', this.ctx.organizationId)
          .eq('group_id', groupId)
          .is('deleted_at', null)
          .order('id', { ascending: true })
          .range(from, to) as unknown as PromiseLike<{
          data: VariantRow[] | null;
          error: { message: string } | null;
        }>,
    );
    // Byte-identical ordering to the query this replaced: variant_size ASC then
    // sku ASC, with PostgREST's NULLS-LAST convention for a sizeless row.
    return rows.sort((a, b) => {
      const as = a.variant_size;
      const bs = b.variant_size;
      if (as !== bs) {
        if (as == null) return 1;
        if (bs == null) return -1;
        return as.localeCompare(bs, 'en');
      }
      return (a.sku ?? '').localeCompare(b.sku ?? '', 'en');
    });
  }

  /**
   * The variants for MANY groups at once, keyed by group id.
   *
   * NOT the list page's path — that expands ONE group at a time, on demand
   * (`loadGroupVariantsAction`), because a collapsed page has no business
   * reading every variant of every group on it. This is for a caller that
   * genuinely needs the whole batch at once.
   *
   * PAGED BY ROWS, NOT BY GROUPS. The batch used to count GROUPS (100 per
   * `.in()`) while PostgREST caps the RESPONSE at `max_rows` = 1000: 100
   * groups of 13 sizes is 1300 rows, of which 1000 came back — silently, with
   * no error — so an expansion showed fewer variants than the group holds
   * while its header (read from the roll-up VIEW) kept the true total. A
   * ceiling on the wrong unit is not a ceiling. `fetchAllRows` walks
   * 1000-row windows on a stable `id` order until a short page proves the end,
   * so the row count no longer has a cap at all.
   */
  async variantsByGroupIds(groupIds: string[]): Promise<Map<string, VariantRow[]>> {
    assertModuleEnabled(this.ctx, 'sports');
    const unique = Array.from(new Set(groupIds.filter(Boolean)));
    const out = new Map<string, VariantRow[]>();
    if (unique.length === 0) return out;

    // Groups are still chunked into `.in()` batches — that bounds the URL
    // length, which is a separate limit from max_rows — but each batch is now
    // itself row-paged.
    const GROUP_BATCH_SIZE = 100;
    for (let i = 0; i < unique.length; i += GROUP_BATCH_SIZE) {
      const batch = unique.slice(i, i + GROUP_BATCH_SIZE);
      const rows = await fetchAllRows<VariantRow & { group_id: string }>((from, to) =>
        this.ctx.supabase
          .from('inventory_items')
          .select(`${VARIANT_COLUMNS}, group_id`)
          .eq('organization_id', this.ctx.organizationId)
          .in('group_id', batch)
          .is('deleted_at', null)
          // The paging order MUST be the stable one (`fetchAllRows` header):
          // an unstable sort lands the same row on two windows or on none.
          .order('id', { ascending: true })
          .range(from, to),
      );
      for (const row of rows) {
        const arr = out.get(row.group_id);
        if (arr) arr.push(row);
        else out.set(row.group_id, [row]);
      }
    }
    // Sorted after the fact so paging keeps its stable key: callers re-sort by
    // SIZE anyway (the group's authored scale lives in `displayByIds`), and a
    // sku order is the deterministic fallback for a group with no scale.
    for (const arr of out.values()) {
      arr.sort((a, b) => (a.sku ?? '').localeCompare(b.sku ?? '', 'en'));
    }
    return out;
  }

  /**
   * The variants under one group whose identity key EXACTLY equals `variantKey`.
   *
   * Exact-equality only — this is the deterministic half of matching, and the
   * caller branches on the COUNT: zero means a new variant, one means receive
   * into it, and more than one is an ambiguity a human has to settle. It can
   * legitimately return more than one row because `variant_key` carries no
   * uniqueness constraint (a pre-sports item hand-linked to a group, or two
   * rows created before 0298, can collide), which is exactly why nothing here
   * picks a winner.
   */
  async variantsByKey(
    groupId: string,
    variantKey: string,
  ): Promise<Array<{ id: string; name: string; sku: string }>> {
    assertModuleEnabled(this.ctx, 'sports');
    const { data, error } = await this.ctx.supabase
      .from('inventory_items')
      .select('id, name, sku')
      .eq('organization_id', this.ctx.organizationId)
      .eq('group_id', groupId)
      .eq('variant_key', variantKey)
      .is('deleted_at', null)
      .order('created_at', { ascending: true })
      .limit(10);
    if (error) throw new ServiceError('internal_error', error.message);
    return (data ?? []) as unknown as Array<{ id: string; name: string; sku: string }>;
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
   *
   * ACTIVE ONLY. These are groups a human is invited to link into, so an
   * archived one is not offered — the same stance as `listForPicker`.
   */
  async candidates(parts: GroupKeyParts): Promise<ProductGroupRow[]> {
    assertModuleEnabled(this.ctx, 'sports');
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
