import 'server-only';

import { z } from 'zod';

import {
  countingUnitSchema,
  DEFAULT_SUBCATEGORY_PROFILES,
  SPORTS_ERROR_META,
  SPORTS_SUBCATEGORIES,
  trackingModeSchema,
  trackingProfileConsistencyError,
  trackingProfileSchema,
  type SportsSubcategoryKey,
  type SubcategoryTrackingProfile,
  type TrackingMode,
  type TrackingProfileInput,
} from '@stockpilot/core';

import { audit } from './audit';
import {
  assertModuleEnabled,
  assertPermission,
  ServiceError,
  withContext,
  type ServiceContext,
} from './context';

export const createCategorySchema = z.object({
  name: z.string().min(1).max(120).trim(),
  description: z.string().max(2000).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex color like #6366f1')
    .optional(),
  parentId: z.string().uuid().nullable().optional(),
  supportsSizes: z.boolean().optional(),
  /** Category-level tracking policy override. Gated on `sports:manage`. */
  trackingMode: trackingModeSchema.nullable().optional(),
  /** Built-in key from SPORTS_SUBCATEGORIES, or a custom key carrying its own
   *  `trackingProfile`. NULL for every non-sports category. */
  sportsSubcategoryKey: z.string().max(64).nullable().optional(),
  defaultUnitOfMeasure: countingUnitSchema.nullable().optional(),
  sizeScaleId: z.string().uuid().nullable().optional(),
  /** REQUIRED when creating a custom Sports subcategory. */
  trackingProfile: trackingProfileSchema.nullable().optional(),
});
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

export const updateCategorySchema = createCategorySchema.partial();
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;

/**
 * Every input key whose write is a Sports tracking-policy change. Touching ANY
 * of them needs `sports:manage` AND the `sports` module — including setting one
 * back to `null`. `null` is not a neutral value here: nulling `tracking_profile`
 * on a custom subcategory is exactly what produces a row whose
 * `sports_subcategory_key` resolves to no profile, and `resolveTrackingProfile`
 * throws SPORTS_SUBCATEGORY_REQUIRED on such a row — which blocks every item
 * create and every receipt in that category until an admin repairs it.
 *
 * `defaultUnitOfMeasure` is deliberately absent: a counting unit is a display
 * convention ("PAIR is a uom display convention. No conversions."), so it can
 * never make a category unresolvable, and it stays a plain `categories:manage`
 * field like name or color.
 */
const SPORTS_POLICY_KEYS = [
  'sportsSubcategoryKey',
  'trackingMode',
  'trackingProfile',
  'sizeScaleId',
] as const satisfies readonly (keyof CreateCategoryInput)[];

function touchesSportsPolicy(patch: UpdateCategoryInput): boolean {
  return SPORTS_POLICY_KEYS.some((k) => patch[k] !== undefined);
}

/**
 * True for a key that has a built-in profile in DEFAULT_SUBCATEGORY_PROFILES.
 * Membership is tested against the SPORTS_SUBCATEGORIES list rather than by
 * indexing the record, so an inherited Object.prototype key ('constructor',
 * 'toString') cannot masquerade as a built-in and skip the profile requirement.
 */
function isBuiltInSubcategoryKey(key: string | null): key is SportsSubcategoryKey {
  return key != null && (SPORTS_SUBCATEGORIES as readonly string[]).includes(key);
}

export class CategoriesService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new CategoriesService(await withContext());
  }

  /**
   * Lists active categories by default. When `opts.includeArchived` is true,
   * returns ONLY archived rows (rows with `deleted_at` set).
   */
  async list(opts: { includeArchived?: boolean } = {}) {
    let query = this.ctx.supabase
      .from('categories')
      // A single string literal, deliberately not built via `+` concatenation:
      // postgrest-js's select-string parser needs a literal type to resolve
      // column-by-column, and splitting this across `+` widens it to plain
      // `string` — which the parser can't narrow, so it falls back to
      // `GenericStringError` for the whole row type (surfaced everywhere this
      // service's return value is destructured, not just here).
      .select(
        'id, parent_id, name, description, color, icon, supports_sizes, public_visibility, tracking_mode, size_scale_id, default_unit_of_measure, sports_subcategory_key, tracking_profile, deleted_at, created_at, updated_at',
      )
      .eq('organization_id', this.ctx.organizationId)
      .order('name', { ascending: true });
    query = opts.includeArchived
      ? query.not('deleted_at', 'is', null)
      : query.is('deleted_at', null);
    const { data, error } = await query;
    if (error) throw new ServiceError('internal_error', error.message);
    return data ?? [];
  }

  /**
   * The privilege gate for a tracking-policy write, checked FIRST and
   * unconditionally: before any shape check (so a caller cannot probe the gate
   * with a deliberately-invalid profile) and on `null` just as much as on a
   * value (see SPORTS_POLICY_KEYS for why `null` is the dangerous case).
   */
  private assertSportsWriteAllowed(patch: UpdateCategoryInput): void {
    if (!touchesSportsPolicy(patch)) return;
    assertPermission(this.ctx, 'sports:manage');
    assertModuleEnabled(this.ctx, 'sports');
  }

  /** The two cross-field rules on a SUBMITTED profile. The rules themselves are
   *  shared with the dialog's Save gate so the two cannot drift. */
  private static assertProfileConsistent(profile: TrackingProfileInput): void {
    const problem = trackingProfileConsistencyError(profile);
    if (problem) throw new ServiceError('validation_error', problem);
  }

  /**
   * The custom-subcategory + tracking-mode rules (Task 12), evaluated against
   * the state the row will BE IN after the write — never against whichever
   * fields the caller happened to send. Judging the INPUT was the review's
   * critical finding: `parentId`-conditioned and `!= null`-conditioned checks
   * let a holder of only `categories:manage` create, or null its way into, a
   * row carrying a `sports_subcategory_key` with no resolvable profile.
   *
   * Requirements: "custom subcategory MUST carry a full tracking profile
   * (default mode, serial requirement, attributes, counting unit,
   * numbers/sizes/colors flags, individual-tracking-allowed) — no partial
   * profiles." A built-in key supplies its own from DEFAULT_SUBCATEGORY_PROFILES
   * and needs nothing stored; a CUSTOM key has no fallback at all.
   */
  private assertResolvedSportsStateValid(next: {
    sportsSubcategoryKey: string | null;
    trackingMode: TrackingMode | null;
    trackingProfile: SubcategoryTrackingProfile | null;
  }): void {
    const profile = isBuiltInSubcategoryKey(next.sportsSubcategoryKey)
      ? DEFAULT_SUBCATEGORY_PROFILES[next.sportsSubcategoryKey]
      : next.trackingProfile;
    if (next.sportsSubcategoryKey != null && profile == null) {
      throw new ServiceError(
        'validation_error',
        'A custom Sports subcategory needs a full tracking profile before it can be saved.',
        { code: 'SPORTS_SUBCATEGORY_REQUIRED' },
      );
    }
    // A category may only be pinned to a mode its subcategory permits. The
    // dialog only OFFERS allowedModes, which is presentation, not enforcement —
    // and a mode decides whether a unit needs a serial. Mirrors the same rule
    // resolveModeOverride() applies to a per-item override.
    if (
      next.trackingMode != null &&
      profile != null &&
      !profile.allowedModes.includes(next.trackingMode)
    ) {
      throw new ServiceError(
        'validation_error',
        `This subcategory does not allow the ${next.trackingMode} tracking mode.`,
        { code: 'TRACKING_MODE_NOT_ALLOWED' },
      );
    }
  }

  /**
   * The rule the live verification found missing: "Category Sports REQUIRES a
   * Sports subcategory". `assertResolvedSportsStateValid` only ever fires on
   * `sportsSubcategoryKey != null`, so the whole rule was skippable by simply
   * not claiming to be a subcategory — leaving "This is a Sports subcategory"
   * unticked saved a profile-less child under the Sports root silently, and the
   * row then appeared in the Add-Item picker beside the eight real ones with no
   * tracking line at all.
   *
   * The rule is a statement about the PARENT, so it is checked against the
   * parent, not against whatever the caller volunteered.
   *
   * "Sports root" is the same STRUCTURAL predicate `item-form.tsx` already uses
   * for `isSportsRootMissingSubcategory`: a category with at least one live
   * child carrying a `sports_subcategory_key`. Sharing the predicate (rather
   * than, say, matching the name "Sports") is what keeps the form's client-side
   * refusal and this server-side one from ever disagreeing, and it leaves an
   * org whose unrelated category happens to be named Sports completely alone.
   *
   * `childId` is passed on the UPDATE path so the row being edited is excluded
   * from its own scan: the question is whether the parent is a Sports root
   * ASIDE from this row, which is what makes converting the last sports child
   * back to a plain category legal rather than a dead end.
   */
  private async assertSportsRootChildValid(
    parentId: string,
    next: {
      sportsSubcategoryKey: string | null;
      trackingProfile: SubcategoryTrackingProfile | null;
    },
    childId?: string,
  ): Promise<void> {
    // Module-gated like every other sports surface. With `sports` off there is
    // no sports UI to repair the row from and the subcategory rows are inert,
    // so refusing would be an unexplainable dead end — the same gate
    // `item-form.tsx` applies before it blocks submit.
    if (!this.ctx.enabledModules.has('sports')) return;
    const profile = isBuiltInSubcategoryKey(next.sportsSubcategoryKey)
      ? DEFAULT_SUBCATEGORY_PROFILES[next.sportsSubcategoryKey]
      : next.trackingProfile;
    // A row that resolves to a real profile satisfies the rule outright, so the
    // common case (creating a built-in subcategory) costs no extra read.
    if (next.sportsSubcategoryKey != null && profile != null) return;

    let query = this.ctx.supabase
      .from('categories')
      .select('id')
      .eq('organization_id', this.ctx.organizationId)
      .eq('parent_id', parentId)
      .is('deleted_at', null)
      .not('sports_subcategory_key', 'is', null);
    if (childId) query = query.neq('id', childId);
    const { data, error } = await query.limit(1);
    if (error) throw new ServiceError('internal_error', error.message);
    const siblings = (data as Array<{ id: string }> | null) ?? [];
    if (siblings.length === 0) return;

    const meta = SPORTS_ERROR_META.SPORTS_SUBCATEGORY_REQUIRED;
    throw new ServiceError(
      'validation_error',
      `${meta.title}. ${meta.explanation} ${meta.action}`,
      { code: 'SPORTS_SUBCATEGORY_REQUIRED' },
    );
  }

  /** The row's current sports state, for the resulting-state merge in update(). */
  private async loadSportsState(id: string): Promise<{
    parentId: string | null;
    sportsSubcategoryKey: string | null;
    trackingMode: TrackingMode | null;
    trackingProfile: SubcategoryTrackingProfile | null;
  }> {
    const { data, error } = await this.ctx.supabase
      .from('categories')
      .select('id, parent_id, sports_subcategory_key, tracking_mode, tracking_profile')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) throw new ServiceError('not_found', 'Category not found.');
    const row = data as {
      parent_id?: string | null;
      sports_subcategory_key: string | null;
      tracking_mode: string | null;
      tracking_profile: SubcategoryTrackingProfile | null;
    };
    return {
      parentId: row.parent_id ?? null,
      sportsSubcategoryKey: row.sports_subcategory_key ?? null,
      trackingMode: (row.tracking_mode as TrackingMode | null) ?? null,
      trackingProfile: row.tracking_profile ?? null,
    };
  }

  /** True when the category still has at least one non-archived child. */
  private async hasLiveChildren(id: string): Promise<boolean> {
    const { data, error } = await this.ctx.supabase
      .from('categories')
      .select('id')
      .eq('organization_id', this.ctx.organizationId)
      .eq('parent_id', id)
      .is('deleted_at', null)
      .limit(1);
    if (error) throw new ServiceError('internal_error', error.message);
    return ((data as Array<{ id: string }> | null) ?? []).length > 0;
  }

  /**
   * Org-consistency + depth guard for `parent_id`. Nothing in the schema ties a
   * child's `parent_id` to its own `organization_id`, and RLS only checks the
   * ROW's org, so a crafted call could point a category at ANOTHER org's row —
   * the same write-side FK-org-consistency class closed in 0201-0206. This read
   * is org-scoped, so a foreign id simply reads back nothing.
   *
   * DEPTH: categories are a parent/child PAIR, never a deeper tree (0294's
   * `category_tracking_mode` walks exactly one level; both list surfaces render
   * exactly two). A grandchild would inherit through a level nobody resolves and
   * would not render at all in the web manager, so it is refused here rather
   * than becoming an invisible row.
   */
  private async assertParentUsable(parentId: string, childId?: string): Promise<void> {
    if (childId && parentId === childId) {
      throw new ServiceError('validation_error', 'A category cannot be its own parent.');
    }
    const { data, error } = await this.ctx.supabase
      .from('categories')
      .select('id, parent_id')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', parentId)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) {
      throw new ServiceError(
        'validation_error',
        'That parent category does not exist in this organization.',
      );
    }
    if ((data as { parent_id: string | null }).parent_id) {
      throw new ServiceError(
        'validation_error',
        'Categories are one level deep. Pick a top-level category as the parent.',
      );
    }
    if (childId && (await this.hasLiveChildren(childId))) {
      throw new ServiceError(
        'validation_error',
        'This category has subcategories of its own, so it cannot become a subcategory itself. Move its children first.',
      );
    }
  }

  /**
   * `categories.size_scale_id` FKs `size_scales`, which is NOT a purely global
   * seed table: `organization_id IS NULL` is a built-in system scale readable by
   * every org, but a non-null one is a PRIVATE org scale (0294). The FK alone
   * would accept another org's private scale id, so this read applies the same
   * predicate the RLS select policy does — a foreign private scale reads back
   * nothing. The org id comes from the server context, never from a client.
   */
  private async assertSizeScaleUsable(sizeScaleId: string): Promise<void> {
    const { data, error } = await this.ctx.supabase
      .from('size_scales')
      .select('id')
      .eq('id', sizeScaleId)
      .or(`organization_id.is.null,organization_id.eq.${this.ctx.organizationId}`)
      .is('deleted_at', null)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) {
      throw new ServiceError(
        'validation_error',
        'That size scale is not available to this organization.',
      );
    }
  }

  async create(input: CreateCategoryInput) {
    assertPermission(this.ctx, 'categories:manage');
    this.assertSportsWriteAllowed(input);
    if (input.trackingProfile) CategoriesService.assertProfileConsistent(input.trackingProfile);
    this.assertResolvedSportsStateValid({
      sportsSubcategoryKey: input.sportsSubcategoryKey ?? null,
      trackingMode: input.trackingMode ?? null,
      trackingProfile: input.trackingProfile ?? null,
    });
    if (input.parentId) await this.assertParentUsable(input.parentId);
    if (input.parentId) {
      await this.assertSportsRootChildValid(input.parentId, {
        sportsSubcategoryKey: input.sportsSubcategoryKey ?? null,
        trackingProfile: input.trackingProfile ?? null,
      });
    }
    if (input.sizeScaleId) await this.assertSizeScaleUsable(input.sizeScaleId);
    const { data, error } = await this.ctx.supabase
      .from('categories')
      .insert({
        organization_id: this.ctx.organizationId,
        name: input.name,
        description: input.description ?? null,
        color: input.color ?? null,
        parent_id: input.parentId ?? null,
        supports_sizes: input.supportsSizes ?? false,
        tracking_mode: input.trackingMode ?? null,
        sports_subcategory_key: input.sportsSubcategoryKey ?? null,
        default_unit_of_measure: input.defaultUnitOfMeasure ?? null,
        size_scale_id: input.sizeScaleId ?? null,
        tracking_profile: input.trackingProfile ?? null,
      })
      .select('*')
      .single();
    if (error) throw new ServiceError('internal_error', error.message);
    void audit(
      { event: 'category.created', entityType: 'category', entityId: data.id as string },
      this.ctx,
    );
    return data;
  }

  async update(id: string, patch: UpdateCategoryInput) {
    assertPermission(this.ctx, 'categories:manage');
    this.assertSportsWriteAllowed(patch);
    if (patch.trackingProfile) CategoriesService.assertProfileConsistent(patch.trackingProfile);
    // Merge over the row as it stands: a key the patch leaves alone still
    // counts towards the resulting state, so an edit cannot reach a state a
    // create() would have refused (e.g. `{ trackingProfile: null }` against a
    // row that still carries a custom `sports_subcategory_key`).
    let current: Awaited<ReturnType<CategoriesService['loadSportsState']>> | null = null;
    const resolvedSportsState = () => ({
      sportsSubcategoryKey:
        patch.sportsSubcategoryKey !== undefined
          ? (patch.sportsSubcategoryKey ?? null)
          : (current?.sportsSubcategoryKey ?? null),
      trackingMode:
        patch.trackingMode !== undefined
          ? (patch.trackingMode ?? null)
          : (current?.trackingMode ?? null),
      trackingProfile:
        patch.trackingProfile !== undefined
          ? (patch.trackingProfile ?? null)
          : (current?.trackingProfile ?? null),
    });
    if (touchesSportsPolicy(patch)) {
      current = await this.loadSportsState(id);
      this.assertResolvedSportsStateValid(resolvedSportsState());
    }
    // Ordered AFTER the self-parent / depth / org-consistency checks so a
    // nonsense parent still fails as the nonsense it is.
    if (patch.parentId) await this.assertParentUsable(patch.parentId, id);
    // The Sports-root rule applies to the parent the row will END UP under, so
    // it runs on a re-parent as well as on a sports-policy edit — moving a
    // profile-less category under the Sports root is exactly the state create()
    // now refuses, and it must not be reachable through the back door.
    //
    // GATED ON A REAL CHANGE (review fix). It used to fire on
    // `patch.parentId !== undefined`, but the edit dialog
    // (`categories-manager.tsx`) builds one payload and ALWAYS includes
    // `parentId` — it resends the row's current parent on every save. So a
    // plain rename of a profile-less category that happens to sit under the
    // Sports root was refused with SPORTS_SUBCATEGORY_REQUIRED, dead-ending a
    // legitimate edit and stranding precisely the rows the create-side guard
    // cannot retroactively clean up.
    //
    // A no-op resend changes nothing about where the row lives, so there is no
    // new state to validate. The guard now needs an actual MOVE (the resolved
    // parent differs from the current one) or a sports-policy edit — both of
    // which really do produce a state create() would refuse.
    if (patch.parentId !== undefined || touchesSportsPolicy(patch)) {
      current ??= await this.loadSportsState(id);
      const resolvedParentId =
        patch.parentId !== undefined ? (patch.parentId ?? null) : current.parentId;
      const movesToNewParent = resolvedParentId !== current.parentId;
      if (resolvedParentId && (movesToNewParent || touchesSportsPolicy(patch))) {
        const { sportsSubcategoryKey, trackingProfile } = resolvedSportsState();
        await this.assertSportsRootChildValid(
          resolvedParentId,
          { sportsSubcategoryKey, trackingProfile },
          id,
        );
      }
    }
    if (patch.sizeScaleId) await this.assertSizeScaleUsable(patch.sizeScaleId);
    const updates: Record<string, unknown> = {};
    if (patch.name !== undefined) updates.name = patch.name;
    if (patch.description !== undefined) updates.description = patch.description ?? null;
    if (patch.color !== undefined) updates.color = patch.color ?? null;
    if (patch.parentId !== undefined) updates.parent_id = patch.parentId ?? null;
    if (patch.supportsSizes !== undefined) updates.supports_sizes = patch.supportsSizes;
    if (patch.trackingMode !== undefined) updates.tracking_mode = patch.trackingMode ?? null;
    if (patch.sportsSubcategoryKey !== undefined) {
      updates.sports_subcategory_key = patch.sportsSubcategoryKey ?? null;
    }
    if (patch.defaultUnitOfMeasure !== undefined) {
      updates.default_unit_of_measure = patch.defaultUnitOfMeasure ?? null;
    }
    if (patch.sizeScaleId !== undefined) updates.size_scale_id = patch.sizeScaleId ?? null;
    if (patch.trackingProfile !== undefined) updates.tracking_profile = patch.trackingProfile ?? null;
    const { data, error } = await this.ctx.supabase
      .from('categories')
      .update(updates)
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw new ServiceError('internal_error', error.message);
    void audit(
      {
        event: 'category.updated',
        entityType: 'category',
        entityId: id,
        extra: { changed_keys: Object.keys(updates) },
      },
      this.ctx,
    );
    return data;
  }

  async archive(id: string) {
    assertPermission(this.ctx, 'categories:manage');
    // A subcategory is only ever rendered UNDER a live parent — the web manager
    // groups children by root, and mobile walks down from the roots — so
    // archiving a parent hides its children everywhere at once, and the
    // archived view cannot bring them back because the children are not
    // themselves archived. Refuse rather than cascade: cascading would pull
    // eight categories out of every picker on a single click, and a later
    // restore could not tell which children it had taken.
    if (await this.hasLiveChildren(id)) {
      throw new ServiceError(
        'conflict',
        'This category still has subcategories. Archive or move them first, then archive this category.',
      );
    }
    const { data: row, error } = await this.ctx.supabase
      .from('categories')
      .update({ deleted_at: new Date().toISOString(), deleted_by: this.ctx.userId })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .select('id')
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!row) throw new ServiceError('not_found', 'Category not found.');
    void audit({ event: 'category.archived', entityType: 'category', entityId: id }, this.ctx);
  }

  /**
   * Restore an archived category — flips `deleted_at` back to null so it
   * reappears in the active list. Same permission gate as archive().
   */
  async restore(id: string) {
    assertPermission(this.ctx, 'categories:manage');
    const { data: row, error } = await this.ctx.supabase
      .from('categories')
      .update({ deleted_at: null, deleted_by: null })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .select('id')
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!row) throw new ServiceError('not_found', 'Category not found.');
    void audit({ event: 'category.restored', entityType: 'category', entityId: id }, this.ctx);
  }

  /**
   * "Set up Sports" (Task 12). Creates the `Sports` root category plus the
   * eight built-in subcategories from `DEFAULT_SUBCATEGORY_PROFILES`, each
   * stamped with its `sports_subcategory_key`, `tracking_mode`,
   * `default_unit_of_measure` and the matching `size_scale_id` (the apparel
   * scale for jerseys/uniforms/sports apparel; the US men's shoe scale for
   * shoes — the other four subcategories have no built-in system scale and
   * stay null, same as an org-supplied one would until an admin sets one).
   *
   * THIS IS THE ONLY WAY SPORTS CATEGORIES GET CREATED — nothing is seeded
   * per-org by a migration (requirements). Idempotent by design: a key that
   * already exists ANYWHERE in the org (not only under the Sports root — an
   * admin may have moved it) is skipped rather than duplicated, so clicking
   * the action twice, or two admins clicking it at once, is harmless.
   */
  async setupSportsDefaults(): Promise<{ rootId: string; created: string[]; skipped: string[] }> {
    assertPermission(this.ctx, 'sports:manage');
    assertModuleEnabled(this.ctx, 'sports');

    // Resolve the two system size scales by KEY rather than hardcoding the
    // migration-seeded uuids (0294), so re-seeding size_scales never breaks this.
    const { data: scaleRows, error: scaleErr } = await this.ctx.supabase
      .from('size_scales')
      .select('id, key')
      .is('organization_id', null)
      .in('key', ['apparel_alpha', 'us_mens_shoe']);
    if (scaleErr) throw new ServiceError('internal_error', scaleErr.message);
    const scaleIdByKey = new Map(
      ((scaleRows ?? []) as Array<{ id: string; key: string }>).map((r) => [r.key, r.id]),
    );
    const apparelScaleId = scaleIdByKey.get('apparel_alpha') ?? null;
    const shoeScaleId = scaleIdByKey.get('us_mens_shoe') ?? null;
    const APPAREL_SCALED = new Set(['jerseys', 'uniforms', 'sports_apparel']);

    // Find (or create) the Sports root: a top-level category named "Sports".
    const { data: existingRoot, error: rootErr } = await this.ctx.supabase
      .from('categories')
      .select('id')
      .eq('organization_id', this.ctx.organizationId)
      .is('parent_id', null)
      .eq('name', 'Sports')
      .is('deleted_at', null)
      .maybeSingle();
    if (rootErr) throw new ServiceError('internal_error', rootErr.message);

    let rootId = (existingRoot as { id: string } | null)?.id;
    if (!rootId) {
      const { data: createdRoot, error: createErr } = await this.ctx.supabase
        .from('categories')
        .insert({
          organization_id: this.ctx.organizationId,
          name: 'Sports',
          description: 'Sports equipment, apparel and gear.',
          parent_id: null,
          supports_sizes: false,
        })
        .select('id')
        .single();
      if (createErr) throw new ServiceError('internal_error', createErr.message);
      rootId = (createdRoot as { id: string }).id;
      void audit({ event: 'category.created', entityType: 'category', entityId: rootId }, this.ctx);
    }

    // Every sports_subcategory_key already in use anywhere in this org, so a
    // re-run never creates a second row for a key even if it was moved out
    // from under the Sports root.
    const { data: existingSubs, error: subsErr } = await this.ctx.supabase
      .from('categories')
      .select('sports_subcategory_key')
      .eq('organization_id', this.ctx.organizationId)
      .is('deleted_at', null)
      .not('sports_subcategory_key', 'is', null);
    if (subsErr) throw new ServiceError('internal_error', subsErr.message);
    const existingKeys = new Set(
      ((existingSubs ?? []) as Array<{ sports_subcategory_key: string | null }>).map(
        (r) => r.sports_subcategory_key,
      ),
    );

    const created: string[] = [];
    const skipped: string[] = [];
    for (const key of SPORTS_SUBCATEGORIES) {
      if (existingKeys.has(key)) {
        skipped.push(key);
        continue;
      }
      const profile = DEFAULT_SUBCATEGORY_PROFILES[key];
      const sizeScaleId = key === 'shoes' ? shoeScaleId : APPAREL_SCALED.has(key) ? apparelScaleId : null;
      const { data: createdSub, error: insErr } = await this.ctx.supabase
        .from('categories')
        .insert({
          organization_id: this.ctx.organizationId,
          name: profile.label,
          parent_id: rootId,
          supports_sizes: profile.supportsSizes,
          tracking_mode: profile.defaultMode,
          sports_subcategory_key: key,
          default_unit_of_measure: profile.defaultCountingUnit,
          size_scale_id: sizeScaleId,
        })
        .select('id')
        .single();
      if (insErr) throw new ServiceError('internal_error', insErr.message);
      void audit(
        {
          event: 'category.created',
          entityType: 'category',
          entityId: (createdSub as { id: string }).id,
        },
        this.ctx,
      );
      created.push(key);
    }

    return { rootId, created, skipped };
  }
}
