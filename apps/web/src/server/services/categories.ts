import 'server-only';

import { z } from 'zod';

import {
  countingUnitSchema,
  DEFAULT_SUBCATEGORY_PROFILES,
  SPORTS_ATTRIBUTES,
  SPORTS_SUBCATEGORIES,
  trackingModeSchema,
} from '@stockpilot/core';

import { audit } from './audit';
import {
  assertModuleEnabled,
  assertPermission,
  ServiceError,
  withContext,
  type ServiceContext,
} from './context';

/**
 * Full profile for a CUSTOM Sports subcategory (Task 12). Mirrors
 * `SubcategoryTrackingProfile` in packages/core/src/sports/tracking-modes.ts
 * field-for-field — every field is REQUIRED here (no `.optional()` anywhere),
 * because a partial profile would leave items under it with no rules at all
 * (requirements: "custom subcategory MUST carry a full tracking profile").
 */
export const trackingProfileSchema = z.object({
  key: z.string().min(1).max(64),
  label: z.string().min(1).max(120),
  defaultMode: trackingModeSchema,
  allowedModes: z.array(trackingModeSchema).min(1),
  supportedAttributes: z.array(z.enum(SPORTS_ATTRIBUTES)),
  requiredAttributes: z.array(z.enum(SPORTS_ATTRIBUTES)),
  defaultCountingUnit: countingUnitSchema,
  supportsNumbers: z.boolean(),
  supportsSizes: z.boolean(),
  supportsColors: z.boolean(),
  individualTrackingAllowed: z.boolean(),
});
export type TrackingProfileInput = z.infer<typeof trackingProfileSchema>;

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
   * The custom-subcategory + tracking-mode rule (Task 12), shared by create()
   * and update() so an edit cannot re-introduce a state a create() would have
   * refused. Requirements: "custom subcategory MUST carry a full tracking
   * profile (default mode, serial requirement, attributes, counting unit,
   * numbers/sizes/colors flags, individual-tracking-allowed) — no partial
   * profiles."
   *
   * Built-in keys (SPORTS_SUBCATEGORIES) supply their own profile from
   * DEFAULT_SUBCATEGORY_PROFILES and need nothing stored here. A CUSTOM key —
   * anything else — has no fallback, so it MUST arrive with a full
   * `trackingProfile` or items under it would have no rules at all.
   *
   * `trackingMode` / `trackingProfile` are both privileged: setting either
   * requires `sports:manage`, checked unconditionally (not only when the
   * shape is otherwise invalid) so a caller cannot probe the gate by sending
   * an intentionally-invalid profile first.
   */
  private assertSportsInputValid(
    input: Pick<CreateCategoryInput, 'parentId' | 'sportsSubcategoryKey' | 'trackingMode' | 'trackingProfile'>,
  ): void {
    const isBuiltIn =
      input.sportsSubcategoryKey != null &&
      (SPORTS_SUBCATEGORIES as readonly string[]).includes(input.sportsSubcategoryKey);
    if (input.parentId && input.sportsSubcategoryKey && !isBuiltIn && !input.trackingProfile) {
      throw new ServiceError(
        'validation_error',
        'A custom Sports subcategory needs a full tracking profile before it can be saved.',
        { code: 'SPORTS_SUBCATEGORY_REQUIRED' },
      );
    }
    if (input.trackingMode != null || input.trackingProfile != null) {
      assertPermission(this.ctx, 'sports:manage');
    }
    if (input.trackingProfile) {
      for (const a of input.trackingProfile.requiredAttributes) {
        if (!input.trackingProfile.supportedAttributes.includes(a)) {
          throw new ServiceError(
            'validation_error',
            `"${a}" is required but not supported by this profile.`,
          );
        }
      }
      if (!input.trackingProfile.allowedModes.includes(input.trackingProfile.defaultMode)) {
        throw new ServiceError(
          'validation_error',
          'The default tracking mode must be one of the allowed modes.',
        );
      }
    }
  }

  async create(input: CreateCategoryInput) {
    assertPermission(this.ctx, 'categories:manage');
    this.assertSportsInputValid(input);
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
    this.assertSportsInputValid(patch);
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
