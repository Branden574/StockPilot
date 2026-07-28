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
      const stub = makeSupabaseStub({});
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
