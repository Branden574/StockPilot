import 'server-only';

import {
  DEFAULT_SUBCATEGORY_PROFILES,
  type SportsSubcategoryKey,
  type SubcategoryTrackingProfile,
  type TrackingMode,
  type TrackingTypeValue,
  trackingTypeForMode,
} from '@stockpilot/core';

import { assertPermission, ServiceError, type ServiceContext } from './context';

export interface ResolvedTrackingProfile {
  categoryId: string | null;
  /** The mode after category + parent inheritance. */
  mode: TrackingMode;
  /** What an item created here is stamped with. */
  trackingType: TrackingTypeValue;
  /**
   * True when `mode` came from an EXPLICIT `categories.tracking_mode` (own or
   * inherited), rather than the QUANTITY fallback. This is what lets a
   * SERIALIZED category stamp `tracking_type = 'serial'` while a category that
   * has never been given a mode — which is every category in every org today —
   * leaves the caller's `trackingType` untouched.
   */
  modeIsExplicit: boolean;
  countingUnit: string;
  sizeScaleId: string | null;
  subcategoryKey: string | null;
  /** Null when the category is not a Sports subcategory. */
  profile: SubcategoryTrackingProfile | null;
  /** True when the category resolves to a Sports subcategory profile. */
  isSports: boolean;
}

/** The resolution for "no category at all" — and for a category id that reads
 *  back no row at all. Identical to the behaviour that existed before the
 *  sports program: quantity-only, no serials, `unit`. */
const NON_SPORTS_DEFAULT: ResolvedTrackingProfile = {
  categoryId: null,
  mode: 'QUANTITY',
  trackingType: 'none',
  modeIsExplicit: false,
  countingUnit: 'unit',
  sizeScaleId: null,
  subcategoryKey: null,
  profile: null,
  isSports: false,
};

/**
 * Per-request memo for `resolveTrackingProfile`. Keyed by
 * `${organizationId}:${categoryId}`. A category's tracking policy cannot change
 * inside one request, so a hit is always sound; a THROW is never cached.
 */
export type TrackingProfileCache = Map<string, ResolvedTrackingProfile>;

/**
 * Resolve the tracking profile for a category.
 *
 * SERVER-SIDE ONLY, and never trusts a client-supplied mode. The relaxed
 * serial rules apply ONLY when: the category is a Sports subcategory AND the
 * subcategory profile permits a non-serialized mode. Every other category
 * resolves to QUANTITY / 'none', which is exactly today's behaviour — this is
 * what keeps Electronics serial-required where it is today.
 *
 * FAIL-CLOSED vs NOT-FOUND. A read ERROR throws, so a flaky lookup can never
 * silently downgrade a serialized category to a relaxed one. A category id that
 * resolves to NO ROW AT ALL — a bad id, or one belonging to another org —
 * returns the non-sports default, because there is nothing to read a policy
 * from.
 *
 * ARCHIVED IS NOT MISSING (review fix). The read deliberately does NOT filter
 * `deleted_at is null`: a soft-deleted row that still carries
 * `tracking_mode = 'SERIALIZED'` used to be indistinguishable from a bad id, so
 * it fell through to the non-sports default and let the CALLER's own
 * `trackingType` decide — archiving a category quietly became a way to escape
 * serial tracking. An archived category now resolves EXACTLY like a live one,
 * so archiving changes what a category is called, never how its items are
 * tracked. Throwing instead would break three shipped paths that legitimately
 * pass an archived id (`po-imports-lines` and `po-imports` charter siblings,
 * `restore-points`): `CategoriesService.archive()` only stamps `deleted_at`, so
 * live items routinely point at soft-deleted rows.
 *
 * This is the one place the TS resolver diverges from `public
 * .category_tracking_mode` (0294), which filters `deleted_at is null`. That SQL
 * function has no callers anywhere in the app — it is a helper 0294 shipped for
 * future SQL use — so the divergence is documentation-only today.
 */
export async function resolveTrackingProfile(
  ctx: ServiceContext,
  categoryId: string | null,
  cache?: TrackingProfileCache,
): Promise<ResolvedTrackingProfile> {
  if (!categoryId) return NON_SPORTS_DEFAULT;

  // N+1 guard: `po-imports` loops `InventoryService.create()` once per line and
  // every line resolves the same handful of categories. The cache is owned by
  // the caller (one per service instance) so it can never outlive a request.
  const cacheKey = `${ctx.organizationId}:${categoryId}`;
  const memo = cache?.get(cacheKey);
  if (memo) return memo;

  const { data, error } = await ctx.supabase
    .from('categories')
    .select(
      'id, parent_id, tracking_mode, size_scale_id, default_unit_of_measure, sports_subcategory_key, tracking_profile, deleted_at',
    )
    .eq('id', categoryId)
    .eq('organization_id', ctx.organizationId)
    .maybeSingle();
  // Fail CLOSED. A read error must never silently downgrade a serialized
  // category to a relaxed one.
  if (error) throw new ServiceError('internal_error', error.message);
  if (!data) {
    const miss = { ...NON_SPORTS_DEFAULT, categoryId };
    cache?.set(cacheKey, miss);
    return miss;
  }

  // One level of inheritance. An archived parent is inherited from for the same
  // reason an archived child is honoured — see the header.
  interface ParentRow {
    tracking_mode: string | null;
    default_unit_of_measure: string | null;
    size_scale_id: string | null;
  }
  let parent: ParentRow | null = null;
  if (data.parent_id) {
    const { data: p, error: pErr } = await ctx.supabase
      .from('categories')
      .select('tracking_mode, default_unit_of_measure, size_scale_id')
      .eq('id', data.parent_id)
      .eq('organization_id', ctx.organizationId)
      .maybeSingle();
    if (pErr) throw new ServiceError('internal_error', pErr.message);
    parent = (p as unknown as ParentRow | null) ?? null;
  }

  const subcategoryKey = (data.sports_subcategory_key as string | null) ?? null;
  const builtIn = subcategoryKey
    ? DEFAULT_SUBCATEGORY_PROFILES[subcategoryKey as SportsSubcategoryKey]
    : undefined;
  // A CUSTOM subcategory must carry a full profile in the jsonb column
  // (requirements). If it carries neither, it is not a sports subcategory.
  const custom = (data.tracking_profile as SubcategoryTrackingProfile | null) ?? null;
  const profile = builtIn ?? custom ?? null;

  // `categories.sports_subcategory_key` carries NO check constraint (0294), so
  // a typo — or a key written by an older build — used to resolve to
  // `isSports: false` and silently drop every sports rule the category was
  // configured for: no required attributes, no group, no variant key. Refuse
  // instead. A CUSTOM key is legal, but only when it carries the full
  // `tracking_profile` jsonb that defines it.
  if (subcategoryKey && !profile) {
    throw new ServiceError(
      'validation_error',
      `This category's Sports subcategory ("${subcategoryKey}") is not recognised. Pick a built-in subcategory, or give the category a tracking profile.`,
      { code: 'SPORTS_SUBCATEGORY_REQUIRED' },
    );
  }

  const explicitMode = (data.tracking_mode as string | null) ?? parent?.tracking_mode ?? null;
  const mode = (explicitMode ?? profile?.defaultMode ?? 'QUANTITY') as TrackingMode;

  const resolved: ResolvedTrackingProfile = {
    categoryId,
    mode,
    trackingType: trackingTypeForMode(mode),
    modeIsExplicit: explicitMode != null,
    countingUnit:
      (data.default_unit_of_measure as string | null) ??
      parent?.default_unit_of_measure ??
      profile?.defaultCountingUnit ??
      'unit',
    sizeScaleId: (data.size_scale_id as string | null) ?? parent?.size_scale_id ?? null,
    subcategoryKey,
    profile,
    isSports: profile != null,
  };
  cache?.set(cacheKey, resolved);
  return resolved;
}

/**
 * Apply an authorized mode override. Refuses anything the subcategory profile
 * does not allow, and anything at all without `sports:manage`.
 *
 * The permission gate is FIRST and it is unconditional for a real override: a
 * tracking mode decides whether a unit needs a serial, so escalating or
 * relaxing it is a privileged act even when the requested mode happens to be
 * one the subcategory allows. A no-op request (absent, or already the resolved
 * mode) short-circuits before the gate so an ordinary `items:create` caller
 * echoing the category's own mode back is not turned away.
 */
export function resolveModeOverride(
  ctx: ServiceContext,
  resolved: ResolvedTrackingProfile,
  requested: TrackingMode | undefined,
): ResolvedTrackingProfile {
  if (!requested || requested === resolved.mode) return resolved;
  assertPermission(ctx, 'sports:manage');
  if (!resolved.profile) {
    throw new ServiceError(
      'validation_error',
      'Tracking mode can only be overridden on a Sports subcategory.',
      { code: 'TRACKING_MODE_NOT_ALLOWED' },
    );
  }
  if (!resolved.profile.allowedModes.includes(requested)) {
    throw new ServiceError(
      'validation_error',
      `This subcategory does not allow the ${requested} tracking mode.`,
      { code: 'TRACKING_MODE_NOT_ALLOWED' },
    );
  }
  if (requested === 'INDIVIDUALLY_TAGGED' && !resolved.profile.individualTrackingAllowed) {
    throw new ServiceError(
      'validation_error',
      'This subcategory cannot be escalated to individual tracking.',
      { code: 'TRACKING_MODE_NOT_ALLOWED' },
    );
  }
  return {
    ...resolved,
    mode: requested,
    trackingType: trackingTypeForMode(requested),
    // An authorized override is as explicit as a category-level mode.
    modeIsExplicit: true,
  };
}

/** Enforce the subcategory's required attributes. Codes match SPORTS_ERROR_CODES. */
export function assertVariantAttributesValid(
  profile: SubcategoryTrackingProfile | null,
  input: {
    variantSize?: string | null;
    variantSizeSystem?: string | null;
    jerseyNumber?: string | null;
  },
): void {
  if (!profile) return;
  for (const attr of profile.requiredAttributes) {
    if (attr === 'size' && !input.variantSize) {
      throw new ServiceError('validation_error', 'A size is required for this product.', {
        code: 'SHOE_SIZE_REQUIRED',
      });
    }
    if (attr === 'size_system' && !input.variantSizeSystem) {
      throw new ServiceError('validation_error', 'A size system is required for this product.', {
        code: 'SHOE_SIZE_SYSTEM_REQUIRED',
      });
    }
    if (attr === 'jersey_number' && !input.jerseyNumber) {
      throw new ServiceError('validation_error', 'A number is required for this product.', {
        code: 'JERSEY_NUMBER_INVALID',
      });
    }
  }
  if (input.jerseyNumber && !profile.supportsNumbers) {
    throw new ServiceError('validation_error', 'This product type does not use numbers.', {
      code: 'JERSEY_NUMBER_INVALID',
    });
  }
}
