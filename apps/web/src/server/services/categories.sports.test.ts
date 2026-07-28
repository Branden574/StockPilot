import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_SUBCATEGORY_PROFILES, type ModuleId, type SubcategoryTrackingProfile } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { CategoriesService } from './categories';

vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));

const SPORTS_MODULES = new Set<ModuleId>(['inventory', 'sports']);

function sportsCtx(client: unknown, over: Record<string, unknown> = {}) {
  return makeServiceContext(client, { enabledModules: SPORTS_MODULES, ...over });
}

function categoryRow(over: Record<string, unknown> = {}) {
  return {
    id: 'cat-new',
    organization_id: 'org-test',
    parent_id: 'cat-sports-root',
    name: 'Custom pads',
    description: null,
    color: null,
    supports_sizes: false,
    public_visibility: 'public',
    tracking_mode: null,
    sports_subcategory_key: 'custom_pads',
    default_unit_of_measure: null,
    size_scale_id: null,
    tracking_profile: null,
    deleted_at: null,
    created_at: '2026-07-27T00:00:00Z',
    updated_at: '2026-07-27T00:00:00Z',
    ...over,
  };
}

/**
 * Sequences the single-row reads (`maybeSingle()`) one service call makes, in
 * order: the current-row load, then the parent-category load. The last entry
 * repeats, so a test only has to spell out the reads it cares about.
 */
function queuedReads(...results: Array<{ data: unknown; error: null }>) {
  let i = 0;
  return () => results[Math.min(i++, results.length - 1)]!;
}

/** A live top-level category, as the parent-org-consistency read sees it. */
const ROOT_PARENT_READ = { data: { id: 'cat-sports-root', parent_id: null }, error: null } as const;

const VALID_CUSTOM_PROFILE: SubcategoryTrackingProfile = {
  key: 'custom_pads',
  label: 'Custom pads',
  defaultMode: 'QUANTITY',
  allowedModes: ['QUANTITY', 'OPTIONAL_SERIALIZED'],
  supportedAttributes: ['brand', 'model', 'size'],
  requiredAttributes: ['size'],
  defaultCountingUnit: 'each',
  supportsNumbers: false,
  supportsSizes: true,
  supportsColors: false,
  individualTrackingAllowed: false,
};

describe('CategoriesService — custom Sports subcategory profile (Task 12)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses a custom subcategory with no tracking profile at all', async () => {
    const stub = makeSupabaseStub({});
    const svc = new CategoriesService(sportsCtx(stub.client));
    await expect(
      svc.create({
        name: 'Custom pads',
        parentId: 'cat-sports-root',
        sportsSubcategoryKey: 'custom_pads',
      }),
    ).rejects.toMatchObject({
      code: 'validation_error',
      details: { code: 'SPORTS_SUBCATEGORY_REQUIRED' },
    });
    // Refused before any write.
    expect(stub.chains.has('categories.insert')).toBe(false);
  });

  it('refuses a profile whose required attribute is not in supportedAttributes', async () => {
    const stub = makeSupabaseStub({});
    const svc = new CategoriesService(sportsCtx(stub.client));
    await expect(
      svc.create({
        name: 'Custom pads',
        parentId: 'cat-sports-root',
        sportsSubcategoryKey: 'custom_pads',
        trackingProfile: {
          ...VALID_CUSTOM_PROFILE,
          supportedAttributes: ['brand', 'model'],
          requiredAttributes: ['size'],
        },
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(stub.chains.has('categories.insert')).toBe(false);
  });

  it('refuses a profile whose defaultMode is not one of allowedModes', async () => {
    const stub = makeSupabaseStub({});
    const svc = new CategoriesService(sportsCtx(stub.client));
    await expect(
      svc.create({
        name: 'Custom pads',
        parentId: 'cat-sports-root',
        sportsSubcategoryKey: 'custom_pads',
        trackingProfile: {
          ...VALID_CUSTOM_PROFILE,
          defaultMode: 'SERIALIZED',
          allowedModes: ['QUANTITY', 'OPTIONAL_SERIALIZED'],
        },
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(stub.chains.has('categories.insert')).toBe(false);
  });

  it('accepts a valid custom profile from an admin (sports:manage) and stores it', async () => {
    const stub = makeSupabaseStub({
      // The parent-org-consistency read (review fix) resolves the root first.
      'categories.select': ROOT_PARENT_READ,
      'categories.insert': {
        data: categoryRow({ tracking_mode: 'QUANTITY', tracking_profile: VALID_CUSTOM_PROFILE }),
        error: null,
      },
    });
    const svc = new CategoriesService(sportsCtx(stub.client));
    const row = await svc.create({
      name: 'Custom pads',
      parentId: 'cat-sports-root',
      sportsSubcategoryKey: 'custom_pads',
      trackingMode: 'QUANTITY',
      trackingProfile: VALID_CUSTOM_PROFILE,
    });
    expect(row.id).toBe('cat-new');
    const insertArgs = stub.chainArgs.get('categories.insert')?.[0]?.[0] as Record<string, unknown>;
    expect(insertArgs.tracking_profile).toEqual(VALID_CUSTOM_PROFILE);
    expect(insertArgs.sports_subcategory_key).toBe('custom_pads');
  });

  it('needs no tracking profile for a built-in subcategory key', async () => {
    const stub = makeSupabaseStub({
      'categories.select': ROOT_PARENT_READ,
      'categories.insert': {
        data: categoryRow({
          name: 'Shoes',
          sports_subcategory_key: 'shoes',
          tracking_mode: 'QUANTITY_BY_VARIANT',
        }),
        error: null,
      },
    });
    const svc = new CategoriesService(sportsCtx(stub.client));
    const row = await svc.create({
      name: 'Shoes',
      parentId: 'cat-sports-root',
      sportsSubcategoryKey: 'shoes',
      trackingMode: DEFAULT_SUBCATEGORY_PROFILES.shoes.defaultMode,
    });
    expect(row.id).toBe('cat-new');
    expect(stub.chains.has('categories.insert')).toBe(true);
  });

  it('throws forbidden when a caller without sports:manage sets a trackingMode', async () => {
    const stub = makeSupabaseStub({});
    // A configured role that can manage plain categories but was NOT granted
    // sports:manage — isolates the sports-specific gate from the outer
    // categories:manage check (every BUILT-IN role that holds categories:manage
    // also holds sports:manage, so this only shows up with an override).
    const categoriesOnly = sportsCtx(stub.client, {
      role: 'staff',
      permissions: new Set(['categories:manage']),
    });
    await expect(
      new CategoriesService(categoriesOnly).create({
        name: 'Electronics',
        trackingMode: 'SERIALIZED',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(stub.chains.has('categories.insert')).toBe(false);
  });

  it('throws forbidden when a caller without sports:manage submits a trackingProfile', async () => {
    const stub = makeSupabaseStub({});
    const categoriesOnly = sportsCtx(stub.client, {
      role: 'staff',
      permissions: new Set(['categories:manage']),
    });
    await expect(
      new CategoriesService(categoriesOnly).create({
        name: 'Custom pads',
        parentId: 'cat-sports-root',
        sportsSubcategoryKey: 'custom_pads',
        trackingProfile: VALID_CUSTOM_PROFILE,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(stub.chains.has('categories.insert')).toBe(false);
  });

  it('an ordinary category with no sports fields at all is unaffected (regression)', async () => {
    const stub = makeSupabaseStub({
      'categories.insert': { data: categoryRow({ sports_subcategory_key: null, name: 'Electronics' }), error: null },
    });
    const svc = new CategoriesService(sportsCtx(stub.client));
    const row = await svc.create({ name: 'Electronics' });
    expect(row.id).toBe('cat-new');
    const insertArgs = stub.chainArgs.get('categories.insert')?.[0]?.[0] as Record<string, unknown>;
    expect(insertArgs.tracking_mode).toBeNull();
    expect(insertArgs.tracking_profile).toBeNull();
  });

  describe('update()', () => {
    it('re-validates the same custom-subcategory rule on edit', async () => {
      const stub = makeSupabaseStub({
        // The resulting-state merge (review fix) reads the row as it stands.
        'categories.select': {
          data: {
            id: 'cat-new',
            sports_subcategory_key: null,
            tracking_mode: null,
            tracking_profile: null,
          },
          error: null,
        },
      });
      const svc = new CategoriesService(sportsCtx(stub.client));
      await expect(
        svc.update('cat-new', {
          name: 'Custom pads',
          parentId: 'cat-sports-root',
          sportsSubcategoryKey: 'custom_pads',
        }),
      ).rejects.toMatchObject({
        code: 'validation_error',
        details: { code: 'SPORTS_SUBCATEGORY_REQUIRED' },
      });
      expect(stub.chains.has('categories.update')).toBe(false);
    });

    it('requires sports:manage to change trackingMode on an existing category', async () => {
      const stub = makeSupabaseStub({});
      const categoriesOnly = sportsCtx(stub.client, {
        role: 'staff',
        permissions: new Set(['categories:manage']),
      });
      await expect(
        new CategoriesService(categoriesOnly).update('cat-1', { trackingMode: 'SERIALIZED' }),
      ).rejects.toMatchObject({ code: 'forbidden' });
      expect(stub.chains.has('categories.update')).toBe(false);
    });
  });
});

/**
 * Task 12 review fixes. Each `it` below started life as a PROBE that passed
 * against the shipped guard — the four bypasses are grouped first, then the
 * gaps the same review found around them.
 *
 * The shipped guard read the INPUT (`if (input.parentId && input.sportsSubcategoryKey
 * && !input.trackingProfile)`, `if (input.trackingMode != null || ...)`), so a
 * holder of only `categories:manage` could reach a row state the guard exists
 * to make unreachable: a `sports_subcategory_key` with no resolvable profile.
 * `resolveTrackingProfile` throws SPORTS_SUBCATEGORY_REQUIRED on such a row, so
 * the row blocks EVERY item create and receipt in that category — a denial of
 * service written by someone who was never allowed to touch sports at all.
 */
describe('CategoriesService — sports guard operates on the RESULTING row state', () => {
  beforeEach(() => vi.clearAllMocks());

  it('BYPASS 1: refuses a custom subcategory with no profile even with NO parentId', async () => {
    const stub = makeSupabaseStub({});
    const svc = new CategoriesService(sportsCtx(stub.client));
    await expect(
      svc.create({ name: 'Custom pads', sportsSubcategoryKey: 'custom_pads' }),
    ).rejects.toMatchObject({
      code: 'validation_error',
      details: { code: 'SPORTS_SUBCATEGORY_REQUIRED' },
    });
    expect(stub.chains.has('categories.insert')).toBe(false);
  });

  it('BYPASS 2: explicit nulls on create still require sports:manage', async () => {
    const stub = makeSupabaseStub({ 'categories.select': ROOT_PARENT_READ });
    const categoriesOnly = sportsCtx(stub.client, {
      role: 'staff',
      permissions: new Set(['categories:manage']),
    });
    await expect(
      new CategoriesService(categoriesOnly).create({
        name: 'Shoes',
        parentId: 'cat-sports-root',
        // A BUILT-IN key skipped the completeness guard, and `!= null` skipped
        // the permission gate, so this whole write used to land unchallenged.
        sportsSubcategoryKey: 'shoes',
        trackingMode: null,
        trackingProfile: null,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(stub.chains.has('categories.insert')).toBe(false);
  });

  it('BYPASS 3: nulling trackingProfile on an existing custom subcategory is refused', async () => {
    const stub = makeSupabaseStub({
      'categories.select': queuedReads({
        data: {
          id: 'cat-custom',
          parent_id: 'cat-sports-root',
          sports_subcategory_key: 'custom_pads',
          tracking_mode: 'QUANTITY',
          tracking_profile: VALID_CUSTOM_PROFILE,
        },
        error: null,
      }),
    });
    const svc = new CategoriesService(sportsCtx(stub.client));
    await expect(svc.update('cat-custom', { trackingProfile: null })).rejects.toMatchObject({
      code: 'validation_error',
      details: { code: 'SPORTS_SUBCATEGORY_REQUIRED' },
    });
    expect(stub.chains.has('categories.update')).toBe(false);
  });

  it('BYPASS 4: nulling trackingMode/trackingProfile still requires sports:manage', async () => {
    const stub = makeSupabaseStub({});
    const categoriesOnly = sportsCtx(stub.client, {
      role: 'staff',
      permissions: new Set(['categories:manage']),
    });
    await expect(
      new CategoriesService(categoriesOnly).update('cat-custom', {
        trackingMode: null,
        trackingProfile: null,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(stub.chains.has('categories.update')).toBe(false);
  });

  it('also gates sportsSubcategoryKey and sizeScaleId on sports:manage', async () => {
    const stub = makeSupabaseStub({});
    const categoriesOnly = sportsCtx(stub.client, {
      role: 'staff',
      permissions: new Set(['categories:manage']),
    });
    await expect(
      new CategoriesService(categoriesOnly).update('cat-1', { sportsSubcategoryKey: null }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      new CategoriesService(categoriesOnly).update('cat-1', {
        sizeScaleId: '11111111-1111-4111-8111-111111111111',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(stub.chains.has('categories.update')).toBe(false);
  });

  it('leaves a rename of a sports category alone (no sports field touched)', async () => {
    const stub = makeSupabaseStub({
      'categories.update': { data: categoryRow({ name: 'Renamed' }), error: null },
    });
    const categoriesOnly = sportsCtx(stub.client, {
      role: 'staff',
      permissions: new Set(['categories:manage']),
    });
    const row = await new CategoriesService(categoriesOnly).update('cat-custom', {
      name: 'Renamed',
    });
    expect(row.id).toBe('cat-new');
    // No current-row read either: nothing sports-related can change.
    expect(stub.chains.has('categories.select')).toBe(false);
  });

  it('requires the sports module for a sports-field write', async () => {
    const stub = makeSupabaseStub({});
    const noSports = makeServiceContext(stub.client, {
      enabledModules: new Set<ModuleId>(['inventory']),
    });
    await expect(
      new CategoriesService(noSports).create({
        name: 'Shoes',
        sportsSubcategoryKey: 'shoes',
      }),
    ).rejects.toMatchObject({ code: 'module_disabled' });
    expect(stub.chains.has('categories.insert')).toBe(false);
  });

  it('refuses a tracking mode the subcategory profile does not allow', async () => {
    const stub = makeSupabaseStub({ 'categories.select': ROOT_PARENT_READ });
    const svc = new CategoriesService(sportsCtx(stub.client));
    // DEFAULT_SUBCATEGORY_PROFILES.shoes.allowedModes has no SERIALIZED.
    await expect(
      svc.create({
        name: 'Shoes',
        parentId: 'cat-sports-root',
        sportsSubcategoryKey: 'shoes',
        trackingMode: 'SERIALIZED',
      }),
    ).rejects.toMatchObject({
      code: 'validation_error',
      details: { code: 'TRACKING_MODE_NOT_ALLOWED' },
    });
    expect(stub.chains.has('categories.insert')).toBe(false);
  });

  it('refuses a mode outside a CUSTOM profile allowedModes on update', async () => {
    const stub = makeSupabaseStub({
      'categories.select': queuedReads({
        data: {
          id: 'cat-custom',
          parent_id: 'cat-sports-root',
          sports_subcategory_key: 'custom_pads',
          tracking_mode: 'QUANTITY',
          tracking_profile: VALID_CUSTOM_PROFILE,
        },
        error: null,
      }),
    });
    const svc = new CategoriesService(sportsCtx(stub.client));
    await expect(
      svc.update('cat-custom', { trackingMode: 'LOT_TRACKED' }),
    ).rejects.toMatchObject({ details: { code: 'TRACKING_MODE_NOT_ALLOWED' } });
    expect(stub.chains.has('categories.update')).toBe(false);
  });

  it('accepts a mode the profile allows', async () => {
    const stub = makeSupabaseStub({
      'categories.select': queuedReads({
        data: {
          id: 'cat-shoes',
          parent_id: 'cat-sports-root',
          sports_subcategory_key: 'shoes',
          tracking_mode: 'QUANTITY_BY_VARIANT',
          tracking_profile: null,
        },
        error: null,
      }),
      'categories.update': { data: categoryRow({ tracking_mode: 'QUANTITY' }), error: null },
    });
    const svc = new CategoriesService(sportsCtx(stub.client));
    await expect(svc.update('cat-shoes', { trackingMode: 'QUANTITY' })).resolves.toBeTruthy();
    expect(stub.chains.has('categories.update')).toBe(true);
  });
});

describe('CategoriesService — parent and size-scale org consistency', () => {
  beforeEach(() => vi.clearAllMocks());

  it("refuses a parentId that is not in the caller's org", async () => {
    // The read is org-scoped, so another org's category id reads back NOTHING.
    const stub = makeSupabaseStub({ 'categories.select': { data: null, error: null } });
    const svc = new CategoriesService(sportsCtx(stub.client));
    await expect(
      svc.create({ name: 'Smuggled', parentId: '22222222-2222-4222-8222-222222222222' }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(stub.chains.has('categories.insert')).toBe(false);
  });

  it('refuses a parent that is itself a subcategory (categories are one level deep)', async () => {
    const stub = makeSupabaseStub({
      'categories.select': { data: { id: 'cat-child', parent_id: 'cat-sports-root' }, error: null },
    });
    const svc = new CategoriesService(sportsCtx(stub.client));
    await expect(
      svc.create({ name: 'Grandchild', parentId: 'cat-child' }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(stub.chains.has('categories.insert')).toBe(false);
  });

  it('refuses a category becoming its own parent', async () => {
    const stub = makeSupabaseStub({});
    const svc = new CategoriesService(sportsCtx(stub.client));
    await expect(svc.update('cat-1', { parentId: 'cat-1' })).rejects.toMatchObject({
      code: 'validation_error',
    });
    expect(stub.chains.has('categories.update')).toBe(false);
  });

  it("refuses a sizeScaleId the org cannot see", async () => {
    const stub = makeSupabaseStub({
      'categories.select': ROOT_PARENT_READ,
      // RLS (0294) hides another org's private scale, so the read is empty.
      'size_scales.select': { data: null, error: null },
    });
    const svc = new CategoriesService(sportsCtx(stub.client));
    await expect(
      svc.create({
        name: 'Shoes',
        parentId: 'cat-sports-root',
        sportsSubcategoryKey: 'shoes',
        sizeScaleId: '33333333-3333-4333-8333-333333333333',
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(stub.chains.has('categories.insert')).toBe(false);
  });

  it('accepts a system size scale (organization_id IS NULL)', async () => {
    const stub = makeSupabaseStub({
      'categories.select': ROOT_PARENT_READ,
      'size_scales.select': { data: { id: 'scale-shoe' }, error: null },
      'categories.insert': { data: categoryRow({ sports_subcategory_key: 'shoes' }), error: null },
    });
    const svc = new CategoriesService(sportsCtx(stub.client));
    await expect(
      svc.create({
        name: 'Shoes',
        parentId: 'cat-sports-root',
        sportsSubcategoryKey: 'shoes',
        sizeScaleId: '33333333-3333-4333-8333-333333333333',
      }),
    ).resolves.toBeTruthy();
  });
});

describe('CategoriesService.archive — a parent with live children', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses to archive a category that still has live children', async () => {
    // Archiving the Sports root would strand its eight subcategories: every
    // surface renders children under a LIVE parent (web groups by root, mobile
    // walks down from null), so they would vanish with no way back.
    const stub = makeSupabaseStub({
      'categories.select': { data: [{ id: 'cat-shoes' }], error: null },
    });
    const svc = new CategoriesService(sportsCtx(stub.client));
    await expect(svc.archive('cat-sports-root')).rejects.toMatchObject({ code: 'conflict' });
    expect(stub.chains.has('categories.update')).toBe(false);
  });

  it('archives a childless category exactly as before', async () => {
    const stub = makeSupabaseStub({
      'categories.select': { data: [], error: null },
      'categories.update': { data: { id: 'cat-1' }, error: null },
    });
    const svc = new CategoriesService(sportsCtx(stub.client));
    await expect(svc.archive('cat-1')).resolves.toBeUndefined();
    expect(stub.chains.has('categories.update')).toBe(true);
  });
});

describe('CategoriesService.setupSportsDefaults (Task 12)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses without sports:manage', async () => {
    const stub = makeSupabaseStub({});
    const staff = sportsCtx(stub.client, { role: 'staff' });
    await expect(new CategoriesService(staff).setupSportsDefaults()).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('refuses when the sports module is off', async () => {
    const stub = makeSupabaseStub({});
    const ctx = makeServiceContext(stub.client, { enabledModules: new Set<ModuleId>(['inventory']) });
    await expect(new CategoriesService(ctx).setupSportsDefaults()).rejects.toMatchObject({
      code: 'module_disabled',
    });
  });

  it('creates the Sports root and all eight built-in subcategories on a clean org', async () => {
    const stub = makeSupabaseStub({
      'size_scales.select': {
        data: [
          { id: 'scale-apparel', key: 'apparel_alpha' },
          { id: 'scale-shoe', key: 'us_mens_shoe' },
        ],
        error: null,
      },
      // No existing Sports root, no existing subcategory keys.
      'categories.select': { data: null, error: null },
      'categories.insert': () => ({ data: { id: `new-${Math.random()}` }, error: null }),
    });
    const svc = new CategoriesService(sportsCtx(stub.client));
    const result = await svc.setupSportsDefaults();
    expect(result.created).toHaveLength(8);
    expect(result.skipped).toHaveLength(0);
  });

  it('is idempotent: skips a subcategory key that already exists anywhere in the org', async () => {
    let selectCall = 0;
    const stub = makeSupabaseStub({
      'size_scales.select': {
        data: [
          { id: 'scale-apparel', key: 'apparel_alpha' },
          { id: 'scale-shoe', key: 'us_mens_shoe' },
        ],
        error: null,
      },
      'categories.select': () => {
        selectCall += 1;
        // First categories.select = the root lookup (found).
        if (selectCall === 1) return { data: { id: 'cat-sports-root' }, error: null };
        // Second = existing subcategory keys.
        return { data: [{ sports_subcategory_key: 'shoes' }], error: null };
      },
      'categories.insert': () => ({ data: { id: `new-${Math.random()}` }, error: null }),
    });
    const svc = new CategoriesService(sportsCtx(stub.client));
    const result = await svc.setupSportsDefaults();
    expect(result.rootId).toBe('cat-sports-root');
    expect(result.skipped).toEqual(['shoes']);
    expect(result.created).toHaveLength(7);
  });
});
