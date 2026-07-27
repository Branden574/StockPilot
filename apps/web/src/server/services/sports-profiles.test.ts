import { describe, expect, it } from 'vitest';

import { DEFAULT_SUBCATEGORY_PROFILES, type ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import {
  assertVariantAttributesValid,
  resolveModeOverride,
  resolveTrackingProfile,
} from './sports-profiles';

/**
 * The resolver is the server-side authority for the sports serial exception,
 * so the load-bearing assertions here are the NEGATIVE ones: a category that
 * is not a Sports subcategory must come back exactly as it did before the
 * sports program existed, and a read error must never soften a serialized
 * category into a relaxed one.
 */

function categoryRow(over: Record<string, unknown> = {}) {
  return {
    id: 'cat-1',
    parent_id: null,
    tracking_mode: null,
    size_scale_id: null,
    default_unit_of_measure: null,
    sports_subcategory_key: null,
    tracking_profile: null,
    ...over,
  };
}

describe('resolveTrackingProfile', () => {
  it('resolves a null category to QUANTITY / none / unit with no DB read', async () => {
    const stub = makeSupabaseStub({});
    const resolved = await resolveTrackingProfile(makeServiceContext(stub.client), null);

    expect(resolved).toMatchObject({
      mode: 'QUANTITY',
      trackingType: 'none',
      countingUnit: 'unit',
      isSports: false,
      modeIsExplicit: false,
      profile: null,
    });
    // No category read at all — the pre-sports fast path is untouched.
    expect(stub.fromCalls).toEqual([]);
  });

  it('resolves an ordinary category with no mode exactly like no category at all', async () => {
    const stub = makeSupabaseStub({
      'categories.select': { data: [categoryRow()], error: null },
    });
    const resolved = await resolveTrackingProfile(makeServiceContext(stub.client), 'cat-1');

    expect(resolved.mode).toBe('QUANTITY');
    expect(resolved.trackingType).toBe('none');
    expect(resolved.countingUnit).toBe('unit');
    expect(resolved.isSports).toBe(false);
    // The flag create() branches on: nothing was declared, so the caller's
    // own trackingType keeps winning.
    expect(resolved.modeIsExplicit).toBe(false);
  });

  it('inherits the parent mode for a Sports/Shoes child that declares none', async () => {
    let call = 0;
    const stub = makeSupabaseStub({
      'categories.select': () => {
        call += 1;
        return call === 1
          ? {
              data: [
                categoryRow({
                  parent_id: 'cat-parent',
                  sports_subcategory_key: 'shoes',
                }),
              ],
              error: null,
            }
          : {
              data: [
                {
                  tracking_mode: 'OPTIONAL_SERIALIZED',
                  default_unit_of_measure: null,
                  size_scale_id: 'scale-shoe',
                },
              ],
              error: null,
            };
      },
    });
    const resolved = await resolveTrackingProfile(makeServiceContext(stub.client), 'cat-1');

    expect(resolved.mode).toBe('OPTIONAL_SERIALIZED');
    expect(resolved.trackingType).toBe('serial_optional');
    expect(resolved.modeIsExplicit).toBe(true);
    expect(resolved.isSports).toBe(true);
    expect(resolved.subcategoryKey).toBe('shoes');
    // The subcategory default supplies the counting unit the parent omitted.
    expect(resolved.countingUnit).toBe('pair');
    expect(resolved.sizeScaleId).toBe('scale-shoe');
  });

  it('falls back to the subcategory default mode when neither level declares one', async () => {
    const stub = makeSupabaseStub({
      'categories.select': {
        data: [categoryRow({ sports_subcategory_key: 'shoes' })],
        error: null,
      },
    });
    const resolved = await resolveTrackingProfile(makeServiceContext(stub.client), 'cat-1');

    expect(resolved.mode).toBe('QUANTITY_BY_VARIANT');
    expect(resolved.trackingType).toBe('none');
    expect(resolved.isSports).toBe(true);
    // The mode came from the PROFILE, not the category row.
    expect(resolved.modeIsExplicit).toBe(false);
  });

  it('stamps serial for SERIALIZED and serial_optional for OPTIONAL_SERIALIZED', async () => {
    for (const [mode, expected] of [
      ['SERIALIZED', 'serial'],
      ['OPTIONAL_SERIALIZED', 'serial_optional'],
      ['QUANTITY_BY_VARIANT', 'none'],
      ['NUMBERED_VARIANT', 'none'],
    ] as const) {
      const stub = makeSupabaseStub({
        'categories.select': { data: [categoryRow({ tracking_mode: mode })], error: null },
      });
      const resolved = await resolveTrackingProfile(makeServiceContext(stub.client), 'cat-1');
      expect(resolved.trackingType).toBe(expected);
      expect(resolved.modeIsExplicit).toBe(true);
    }
  });

  it('treats a CUSTOM subcategory carrying a full jsonb profile as sports', async () => {
    const custom = {
      ...DEFAULT_SUBCATEGORY_PROFILES.jerseys,
      key: 'custom_singlets',
      label: 'Singlets',
    };
    const stub = makeSupabaseStub({
      'categories.select': {
        data: [categoryRow({ tracking_profile: custom })],
        error: null,
      },
    });
    const resolved = await resolveTrackingProfile(makeServiceContext(stub.client), 'cat-1');

    expect(resolved.isSports).toBe(true);
    expect(resolved.profile?.key).toBe('custom_singlets');
    expect(resolved.mode).toBe('NUMBERED_VARIANT');
  });

  it('THROWS on a read error rather than defaulting to the relaxed profile', async () => {
    const stub = makeSupabaseStub({
      'categories.select': { data: null, error: { message: 'connection reset' } },
    });
    await expect(
      resolveTrackingProfile(makeServiceContext(stub.client), 'cat-1'),
    ).rejects.toMatchObject({ code: 'internal_error' });
  });

  it('THROWS on a parent read error too — inheritance must not fail open', async () => {
    let call = 0;
    const stub = makeSupabaseStub({
      'categories.select': () => {
        call += 1;
        return call === 1
          ? { data: [categoryRow({ parent_id: 'cat-parent' })], error: null }
          : { data: null, error: { message: 'connection reset' } };
      },
    });
    await expect(
      resolveTrackingProfile(makeServiceContext(stub.client), 'cat-1'),
    ).rejects.toMatchObject({ code: 'internal_error' });
  });

  it('returns the non-sports default for a category that no longer resolves', async () => {
    // An archived category still has items pointing at it (CategoriesService
    // .archive only stamps deleted_at), and po-imports-lines re-creates a
    // charter sibling with that same category_id. Throwing here would break
    // that shipped path; public.category_tracking_mode coalesces the same
    // miss to QUANTITY, so this matches the SQL resolver exactly.
    const stub = makeSupabaseStub({ 'categories.select': { data: null, error: null } });
    const resolved = await resolveTrackingProfile(makeServiceContext(stub.client), 'cat-gone');

    expect(resolved.mode).toBe('QUANTITY');
    expect(resolved.trackingType).toBe('none');
    expect(resolved.isSports).toBe(false);
    expect(resolved.categoryId).toBe('cat-gone');
  });
});

describe('resolveModeOverride', () => {
  const sportsCtx = () =>
    makeServiceContext(makeSupabaseStub({}).client, {
      enabledModules: new Set<ModuleId>(['inventory', 'sports']),
    });

  const shoes = {
    categoryId: 'cat-1',
    mode: 'QUANTITY_BY_VARIANT' as const,
    trackingType: 'none' as const,
    modeIsExplicit: false,
    countingUnit: 'pair',
    sizeScaleId: null,
    subcategoryKey: 'shoes',
    profile: DEFAULT_SUBCATEGORY_PROFILES.shoes,
    isSports: true,
  };

  it('is a no-op when no override is requested', () => {
    expect(resolveModeOverride(sportsCtx(), shoes, undefined)).toBe(shoes);
  });

  it('is a no-op — and needs no permission — when the request equals the resolved mode', () => {
    const viewer = makeServiceContext(makeSupabaseStub({}).client, { role: 'viewer' });
    expect(resolveModeOverride(viewer, shoes, 'QUANTITY_BY_VARIANT')).toBe(shoes);
  });

  it('requires sports:manage for a real override', () => {
    const staff = makeServiceContext(makeSupabaseStub({}).client, { role: 'staff' });
    expect(() => resolveModeOverride(staff, shoes, 'OPTIONAL_SERIALIZED')).toThrowError(
      /Missing permission: sports:manage/,
    );
  });

  it('applies an allowed override and marks the mode explicit', () => {
    const out = resolveModeOverride(sportsCtx(), shoes, 'OPTIONAL_SERIALIZED');
    expect(out.mode).toBe('OPTIONAL_SERIALIZED');
    expect(out.trackingType).toBe('serial_optional');
    expect(out.modeIsExplicit).toBe(true);
  });

  it('refuses a mode the subcategory does not allow', () => {
    try {
      resolveModeOverride(sportsCtx(), shoes, 'LOT_TRACKED');
      throw new Error('expected a throw');
    } catch (e) {
      expect((e as { code: string }).code).toBe('validation_error');
      expect((e as { details?: { code?: string } }).details?.code).toBe(
        'TRACKING_MODE_NOT_ALLOWED',
      );
    }
  });

  it('refuses INDIVIDUALLY_TAGGED when the profile forbids individual tracking', () => {
    // uniforms allows NUMBERED_VARIANT but individualTrackingAllowed is false,
    // and INDIVIDUALLY_TAGGED is not in allowedModes either — both guards agree.
    const uniforms = {
      ...shoes,
      subcategoryKey: 'uniforms',
      profile: {
        ...DEFAULT_SUBCATEGORY_PROFILES.uniforms,
        // Force the escalation past the allowedModes arm so the dedicated
        // individualTrackingAllowed guard is the one under test.
        allowedModes: ['QUANTITY_BY_VARIANT', 'INDIVIDUALLY_TAGGED'] as const,
      },
    };
    try {
      resolveModeOverride(
        sportsCtx(),
        uniforms as unknown as typeof shoes,
        'INDIVIDUALLY_TAGGED',
      );
      throw new Error('expected a throw');
    } catch (e) {
      expect((e as { details?: { code?: string } }).details?.code).toBe(
        'TRACKING_MODE_NOT_ALLOWED',
      );
    }
  });

  it('refuses any override outside a Sports subcategory', () => {
    const plain = { ...shoes, profile: null, isSports: false, subcategoryKey: null };
    try {
      resolveModeOverride(sportsCtx(), plain, 'SERIALIZED');
      throw new Error('expected a throw');
    } catch (e) {
      expect((e as { details?: { code?: string } }).details?.code).toBe(
        'TRACKING_MODE_NOT_ALLOWED',
      );
    }
  });
});

describe('assertVariantAttributesValid', () => {
  it('is a no-op for a non-sports item', () => {
    expect(() => assertVariantAttributesValid(null, {})).not.toThrow();
  });

  it('requires a size on Shoes', () => {
    try {
      assertVariantAttributesValid(DEFAULT_SUBCATEGORY_PROFILES.shoes, {
        variantSizeSystem: 'US_MENS',
      });
      throw new Error('expected a throw');
    } catch (e) {
      expect((e as { details?: { code?: string } }).details?.code).toBe('SHOE_SIZE_REQUIRED');
    }
  });

  it('requires a size system on Shoes', () => {
    try {
      assertVariantAttributesValid(DEFAULT_SUBCATEGORY_PROFILES.shoes, { variantSize: '10' });
      throw new Error('expected a throw');
    } catch (e) {
      expect((e as { details?: { code?: string } }).details?.code).toBe(
        'SHOE_SIZE_SYSTEM_REQUIRED',
      );
    }
  });

  it('rejects a jersey number on Shoes, which do not use numbers', () => {
    try {
      assertVariantAttributesValid(DEFAULT_SUBCATEGORY_PROFILES.shoes, {
        variantSize: '10',
        variantSizeSystem: 'US_MENS',
        jerseyNumber: '12',
      });
      throw new Error('expected a throw');
    } catch (e) {
      expect((e as { details?: { code?: string } }).details?.code).toBe('JERSEY_NUMBER_INVALID');
    }
  });

  it('accepts a fully-specified shoe variant', () => {
    expect(() =>
      assertVariantAttributesValid(DEFAULT_SUBCATEGORY_PROFILES.shoes, {
        variantSize: '10.5',
        variantSizeSystem: 'US_MENS',
      }),
    ).not.toThrow();
  });

  it('accepts a jersey with a number, and still requires its size', () => {
    expect(() =>
      assertVariantAttributesValid(DEFAULT_SUBCATEGORY_PROFILES.jerseys, {
        variantSize: 'M',
        jerseyNumber: '00',
      }),
    ).not.toThrow();
    try {
      assertVariantAttributesValid(DEFAULT_SUBCATEGORY_PROFILES.jerseys, { jerseyNumber: '00' });
      throw new Error('expected a throw');
    } catch (e) {
      expect((e as { details?: { code?: string } }).details?.code).toBe('SHOE_SIZE_REQUIRED');
    }
  });
});
