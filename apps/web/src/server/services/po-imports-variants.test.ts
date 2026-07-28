import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildGroupKey, DEFAULT_SUBCATEGORY_PROFILES } from '@stockpilot/core';

import {
  resolveLinesForReview,
  resolveLineVariant,
  toVariantLine,
  type PoImportVariantLine,
  type ResolveLineVariantDeps,
} from './po-imports-variants';
import type { ProductGroupRow } from './product-groups';
import type { ResolvedTrackingProfile } from './sports-profiles';

/**
 * Task 14 — group-first, deterministic matching.
 *
 * The binding rule under test: matching is by IDENTITY KEY, never by name
 * string, ambiguity always goes to review, and nothing ever auto-merges or
 * auto-links. Every assertion below is about one of those three.
 */

function line(over: Partial<PoImportVariantLine> = {}): PoImportVariantLine {
  return {
    id: 'line-1',
    line_number: 1,
    description: 'Nike Pegasus 41',
    qty_ordered_original: 6,
    vendor_product_number: 'FD2722',
    variant_size: '10',
    variant_size_system: 'US_MENS',
    variant_width: null,
    variant_fit: null,
    variant_color: null,
    jersey_number: null,
    player_name: null,
    group_hint: 'Nike Pegasus 41',
    serial_hint: null,
    mapping_confidence: null,
    ...over,
  };
}

function profileFor(
  subcategoryKey: keyof typeof DEFAULT_SUBCATEGORY_PROFILES | null,
  over: Partial<ResolvedTrackingProfile> = {},
): ResolvedTrackingProfile {
  const p = subcategoryKey ? DEFAULT_SUBCATEGORY_PROFILES[subcategoryKey] : null;
  return {
    categoryId: subcategoryKey ? 'cat-1' : null,
    mode: p?.defaultMode ?? 'QUANTITY',
    trackingType: 'none',
    modeIsExplicit: false,
    countingUnit: p?.defaultCountingUnit ?? 'unit',
    sizeScaleId: null,
    subcategoryKey,
    profile: p,
    isSports: p != null,
    ...over,
  };
}

function groupRow(over: Partial<ProductGroupRow> = {}): ProductGroupRow {
  return {
    id: 'grp-1',
    organization_id: 'org-1',
    category_id: 'cat-1',
    subcategory_key: 'shoes',
    name: 'Nike Pegasus 41',
    brand: null,
    manufacturer: null,
    model: 'Nike Pegasus 41',
    style_number: 'FD2722',
    colorway: null,
    team: null,
    league: null,
    season: null,
    home_away: null,
    color: null,
    size_scale_id: null,
    default_counting_unit: 'pair',
    tracking_mode: null,
    group_key: 'k',
    status: 'active',
    created_at: '2026-07-27T00:00:00Z',
    updated_at: '2026-07-27T00:00:00Z',
    ...over,
  };
}

function makeDeps(over: Partial<ResolveLineVariantDeps> = {}) {
  const findByKey = vi.fn(async (_k: string): Promise<ProductGroupRow | null> => null);
  const candidates = vi.fn(async (): Promise<ProductGroupRow[]> => []);
  const variantsByKey = vi.fn(
    async (): Promise<Array<{ id: string; name: string; sku: string }>> => [],
  );
  const deps = {
    groups: { findByKey, candidates, variantsByKey },
    supabase: {} as ResolveLineVariantDeps['supabase'],
    organizationId: 'org-1',
    sportsEnabled: true,
    ...over,
  } as ResolveLineVariantDeps;
  return { deps, findByKey, candidates, variantsByKey };
}

beforeEach(() => vi.clearAllMocks());

// ── R2: a size run is ONE product ───────────────────────────────────────────

describe('group-first matching', () => {
  it('collapses sizes 9/10/11 onto ONE group with three distinct variant keys', async () => {
    const { deps, findByKey } = makeDeps();
    const sizes = ['9', '10', '11'];

    const results = await Promise.all(
      sizes.map((s, i) =>
        resolveLineVariant(
          deps,
          line({ id: `line-${i}`, line_number: i + 1, variant_size: s }),
          profileFor('shoes'),
        ),
      ),
    );

    // ONE key was probed for all three lines — the size never enters the group
    // key, which is precisely what makes a size run one product.
    const probed = new Set(findByKey.mock.calls.map((c) => c[0]));
    expect(probed.size).toBe(1);

    expect(results.map((r) => r.result)).toEqual([
      'create_new_group',
      'create_new_group',
      'create_new_group',
    ]);
    const keys = results.map((r) => r.variantKey);
    expect(new Set(keys).size).toBe(3);
    expect(keys).toEqual([
      'size=9|system=us_mens',
      'size=10|system=us_mens',
      'size=11|system=us_mens',
    ]);
  });

  it('reuses an existing group and reports add_new_variant per size', async () => {
    const { deps, variantsByKey } = makeDeps();
    deps.groups.findByKey = vi.fn(async () => groupRow());
    const r = await resolveLineVariant(deps, line(), profileFor('shoes'));
    expect(r.result).toBe('add_new_variant');
    expect(r.groupId).toBe('grp-1');
    expect(variantsByKey).toHaveBeenCalledWith('grp-1', 'size=10|system=us_mens');
  });

  it('receives into an existing variant when exactly one matches the key', async () => {
    const { deps } = makeDeps();
    deps.groups.findByKey = vi.fn(async () => groupRow());
    deps.groups.variantsByKey = vi.fn(async () => [
      { id: 'item-9', name: 'Pegasus 41 US10', sku: 'SKU-9' },
    ]);
    const r = await resolveLineVariant(deps, line(), profileFor('shoes'));
    expect(r.result).toBe('receive_into_existing_variant');
    expect(r.variantItemId).toBe('item-9');
  });

  it('never picks a winner when two variants share the key', async () => {
    const { deps } = makeDeps();
    deps.groups.findByKey = vi.fn(async () => groupRow());
    deps.groups.variantsByKey = vi.fn(async () => [
      { id: 'item-a', name: 'A', sku: 'SKU-A' },
      { id: 'item-b', name: 'B', sku: 'SKU-B' },
    ]);
    const r = await resolveLineVariant(deps, line(), profileFor('shoes'));
    expect(r.result).toBe('ambiguous_variant_match');
    expect(r.errorCode).toBe('AMBIGUOUS_VARIANT_MATCH');
    expect(r.variantItemId).toBeNull();
    expect(r.variantCandidates).toHaveLength(2);
  });

  // R3
  it('keeps jersey #12 in M and XL as two variants of one group, and not as serials', async () => {
    const { deps, findByKey } = makeDeps();
    const jersey = (id: string, size: string) =>
      line({
        id,
        description: 'Falcons Home Jersey',
        group_hint: 'Falcons Home Jersey',
        vendor_product_number: 'JH-880',
        variant_size: size,
        variant_size_system: null,
        jersey_number: '12',
      });

    const m = await resolveLineVariant(deps, jersey('l-m', 'M'), profileFor('jerseys'));
    const xl = await resolveLineVariant(deps, jersey('l-xl', 'XL'), profileFor('jerseys'));

    expect(new Set(findByKey.mock.calls.map((c) => c[0])).size).toBe(1);
    expect(m.variantKey).toBe('number=12|size=m');
    expect(xl.variantKey).toBe('number=12|size=xl');
    expect(m.variantKey).not.toEqual(xl.variantKey);
    // The number is a variant slot, never a serial verdict.
    for (const r of [m, xl]) {
      expect(r.result).toBe('create_new_group');
      expect(r.errorCode).toBeNull();
    }
  });

  it('keeps a leading zero on a jersey number in the variant key', async () => {
    const { deps } = makeDeps();
    const r = await resolveLineVariant(
      deps,
      line({ jersey_number: '07', variant_size: 'M', variant_size_system: null }),
      profileFor('jerseys'),
    );
    expect(r.variantKey).toBe('number=07|size=m');
  });

  it('never merges two groups whose names are similar but whose style numbers differ', async () => {
    const { deps, findByKey } = makeDeps();
    await resolveLineVariant(
      deps,
      line({ group_hint: 'Nike Pegasus 41', vendor_product_number: 'FD2722' }),
      profileFor('shoes'),
    );
    await resolveLineVariant(
      deps,
      line({ group_hint: 'Nike Pegasus 41 ', vendor_product_number: 'FD2723' }),
      profileFor('shoes'),
    );
    const [a, b] = findByKey.mock.calls.map((c) => c[0]);
    expect(a).not.toEqual(b);
    // And neither key is the bare name fallback — the style number identifies.
    expect(a).not.toContain('|name:');
    expect(a).toBe(
      buildGroupKey({
        subcategoryKey: 'shoes',
        model: 'Nike Pegasus 41',
        styleNumber: 'FD2722',
      }),
    );
  });
});

// ── Suggestion, never a link ────────────────────────────────────────────────

describe('candidate handling', () => {
  it('returns ambiguous_variant_match and links nothing when two groups are candidates', async () => {
    const { deps } = makeDeps();
    deps.groups.candidates = vi.fn(async () => [
      groupRow({ id: 'grp-a', name: 'A' }),
      groupRow({ id: 'grp-b', name: 'B' }),
    ]);
    const r = await resolveLineVariant(deps, line(), profileFor('shoes'));
    expect(r.result).toBe('ambiguous_variant_match');
    expect(r.errorCode).toBe('AMBIGUOUS_VARIANT_MATCH');
    expect(r.groupId).toBeNull();
    expect(r.variantItemId).toBeNull();
    expect(r.groupCandidates.map((c) => c.id)).toEqual(['grp-a', 'grp-b']);
  });

  it('returns possible_duplicate for a single candidate and does NOT link it', async () => {
    const { deps, variantsByKey } = makeDeps();
    deps.groups.candidates = vi.fn(async () => [groupRow({ id: 'grp-a', name: 'A' })]);
    const r = await resolveLineVariant(deps, line(), profileFor('shoes'));
    expect(r.result).toBe('possible_duplicate');
    expect(r.errorCode).toBe('POSSIBLE_PRODUCT_GROUP_DUPLICATE');
    expect(r.groupId).toBeNull();
    expect(r.groupCandidates).toEqual([{ id: 'grp-a', name: 'A' }]);
    // Nothing was resolved inside the suggested group.
    expect(variantsByKey).not.toHaveBeenCalled();
  });
});

// ── The mapping gate runs FIRST ─────────────────────────────────────────────

describe('mapping confidence gate', () => {
  it('blocks a 0.4-confidence line before any matching happens', async () => {
    const { deps, findByKey, candidates, variantsByKey } = makeDeps();
    const r = await resolveLineVariant(
      deps,
      line({ mapping_confidence: 0.4 }),
      profileFor('shoes'),
    );
    expect(r.result).toBe('mapping_review_required');
    expect(r.errorCode).toBe('IMPORT_MAPPING_REVIEW_REQUIRED');
    expect(findByKey).not.toHaveBeenCalled();
    expect(candidates).not.toHaveBeenCalled();
    expect(variantsByKey).not.toHaveBeenCalled();
  });

  it('lets a confident line through', async () => {
    const { deps, findByKey } = makeDeps();
    const r = await resolveLineVariant(
      deps,
      line({ mapping_confidence: 0.95 }),
      profileFor('shoes'),
    );
    expect(r.result).toBe('create_new_group');
    expect(findByKey).toHaveBeenCalled();
  });

  it('treats a null mapping confidence as nothing to confirm', async () => {
    const { deps } = makeDeps();
    const r = await resolveLineVariant(deps, line({ mapping_confidence: null }), profileFor(null));
    expect(r.result).toBe('ready');
  });
});

// ── Serial sanity (R1) ──────────────────────────────────────────────────────

describe('serial guards', () => {
  it('refuses a serial on a counted line', async () => {
    const { deps, findByKey } = makeDeps();
    const r = await resolveLineVariant(
      deps,
      line({ serial_hint: 'SN-0001' }),
      profileFor('shoes', { trackingType: 'none' }),
    );
    expect(r.result).toBe('serial_required');
    expect(r.errorCode).toBe('SERIAL_NUMBER_NOT_ALLOWED_FOR_GROUPED_IMPORT');
    expect(findByKey).not.toHaveBeenCalled();
  });

  it('refuses a serialized line that carries no serial', async () => {
    const { deps } = makeDeps();
    const r = await resolveLineVariant(
      deps,
      line({ qty_ordered_original: 3 }),
      profileFor('protective_equipment', { trackingType: 'serial' }),
    );
    expect(r.result).toBe('serial_required');
    expect(r.errorCode).toBe('SERIAL_NUMBER_REQUIRED');
  });

  it('blocks a serialized NON-sports line too, so Electronics stays serial-required', async () => {
    const { deps } = makeDeps();
    const r = await resolveLineVariant(
      deps,
      line({ qty_ordered_original: 2 }),
      profileFor(null, { trackingType: 'serial', mode: 'SERIALIZED', modeIsExplicit: true }),
    );
    expect(r.result).toBe('serial_required');
    expect(r.errorCode).toBe('SERIAL_NUMBER_REQUIRED');
  });

  // ── The chassis regression the scoping exists to prevent ─────────────────
  // A NON-sports org (module off) whose PO scan mapped a serial column: every
  // category in that org resolves to 'none' tracking, so the "serial on a
  // counted product" verdict fired on an ordinary import and left it
  // unapprovable — with no grouped import, no sports UI, and nothing to settle
  // it with. Pre-sports behaviour is: import it.
  it('APPROVES a pre-sports line carrying a serial when the org has no sports module', async () => {
    const { deps, findByKey } = makeDeps({ sportsEnabled: false });
    const r = await resolveLineVariant(
      deps,
      line({ serial_hint: 'SN-0001' }),
      profileFor(null),
    );
    expect(r.result).toBe('ready');
    expect(r.errorCode).toBeNull();
    expect(findByKey).not.toHaveBeenCalled();
  });

  it('never demands a serial at all when the sports module is off', async () => {
    const { deps } = makeDeps({ sportsEnabled: false });
    const r = await resolveLineVariant(
      deps,
      line({ serial_hint: null, qty_ordered_original: 4 }),
      profileFor(null, { trackingType: 'serial', mode: 'SERIALIZED', modeIsExplicit: true }),
    );
    expect(r.result).toBe('ready');
  });

  it('lets a serial ride on a NON-sports counted line inside a sports org', async () => {
    // SERIAL_NUMBER_NOT_ALLOWED_FOR_GROUPED_IMPORT means what its name says:
    // it is a grouped-import verdict, so it needs a sports profile. A printed
    // serial on an ordinary counted line is not this resolver's business.
    const { deps } = makeDeps();
    const r = await resolveLineVariant(
      deps,
      line({ serial_hint: 'SN-0001' }),
      profileFor(null, { trackingType: 'none' }),
    );
    expect(r.result).toBe('ready');
  });

  it('does not demand a serial for a zero-quantity serialized line', async () => {
    const { deps } = makeDeps();
    const r = await resolveLineVariant(
      deps,
      line({ qty_ordered_original: 0 }),
      profileFor(null, { trackingType: 'serial' }),
    );
    expect(r.result).toBe('ready');
  });
});

// ── Required attributes ─────────────────────────────────────────────────────

describe('required attributes', () => {
  it('blocks a shoe line with no size', async () => {
    const { deps } = makeDeps();
    const r = await resolveLineVariant(
      deps,
      line({ variant_size: null }),
      profileFor('shoes'),
    );
    expect(r.result).toBe('missing_required_attribute');
    expect(r.errorCode).toBe('SHOE_SIZE_REQUIRED');
  });

  it('blocks a shoe line with a size but no size system', async () => {
    const { deps } = makeDeps();
    const r = await resolveLineVariant(
      deps,
      line({ variant_size_system: null }),
      profileFor('shoes'),
    );
    expect(r.result).toBe('missing_required_attribute');
    expect(r.errorCode).toBe('SHOE_SIZE_SYSTEM_REQUIRED');
    expect(r.message).toContain('"10"');
  });
});

// ── Non-sports and module-off paths are untouched ───────────────────────────

describe('non-sports lines', () => {
  it('resolves a category-less line to ready without touching product groups', async () => {
    const { deps, findByKey, candidates } = makeDeps();
    const r = await resolveLineVariant(deps, line(), profileFor(null));
    expect(r).toEqual({
      result: 'ready',
      groupId: null,
      groupName: null,
      groupCandidates: [],
      variantItemId: null,
      variantCandidates: [],
      variantKey: null,
      message: null,
      errorCode: null,
    });
    expect(findByKey).not.toHaveBeenCalled();
    expect(candidates).not.toHaveBeenCalled();
  });

  it('never reads a group when the sports module is off', async () => {
    const { deps, findByKey } = makeDeps({ sportsEnabled: false });
    const r = await resolveLineVariant(deps, line(), profileFor('shoes'));
    expect(r.result).toBe('ready');
    expect(findByKey).not.toHaveBeenCalled();
  });
});

describe('resolveLinesForReview', () => {
  it('keys every resolution by line id', async () => {
    const { deps } = makeDeps();
    const out = await resolveLinesForReview(deps, [
      { line: line({ id: 'a' }), profile: profileFor('shoes') },
      { line: line({ id: 'b', mapping_confidence: 0.2 }), profile: profileFor('shoes') },
      { line: line({ id: 'c' }), profile: profileFor(null) },
    ]);
    expect(Object.keys(out)).toEqual(['a', 'b', 'c']);
    expect(out.a?.result).toBe('create_new_group');
    expect(out.b?.result).toBe('mapping_review_required');
    expect(out.c?.result).toBe('ready');
  });
});

// ── Review fixes ────────────────────────────────────────────────────────────

describe('an ambiguous VARIANT match is answerable', () => {
  it('offers the exactly-matched group as a candidate so the row has a control', async () => {
    const { deps, findByKey, variantsByKey } = makeDeps();
    findByKey.mockResolvedValue(groupRow());
    variantsByKey.mockResolvedValue([
      { id: 'itm-a', name: 'Pegasus 41 US 10', sku: 'SKU-A' },
      { id: 'itm-b', name: 'Pegasus 41 US 10', sku: 'SKU-B' },
    ]);

    const r = await resolveLineVariant(deps, line(), profileFor('shoes'));

    expect(r.result).toBe('ambiguous_variant_match');
    // Both halves of the answer are present: WHICH variant, or "a new one in
    // this group". An empty groupCandidates list rendered no control at all.
    expect(r.variantCandidates).toHaveLength(2);
    expect(r.groupCandidates).toEqual([{ id: 'grp-1', name: 'Nike Pegasus 41' }]);
    expect(r.groupId).toBe('grp-1');
  });
});

describe('serial verdicts are settleable, not dead ends', () => {
  it('blocks a serialized line that printed no serial', async () => {
    const { deps } = makeDeps();
    const r = await resolveLineVariant(
      deps,
      line({ serial_hint: null, qty_ordered_original: 3 }),
      profileFor('shoes', { trackingType: 'serial' }),
    );
    expect(r.result).toBe('serial_required');
    expect(r.errorCode).toBe('SERIAL_NUMBER_REQUIRED');
  });

  it('clears once the document’s serial reaches the line', async () => {
    const { deps } = makeDeps();
    const r = await resolveLineVariant(
      deps,
      line({ serial_hint: 'SN-00A7', qty_ordered_original: 3 }),
      profileFor('shoes', { trackingType: 'serial' }),
    );
    // Past the serial gate entirely — it resolves on identity like any other.
    expect(r.result).not.toBe('serial_required');
    expect(r.result).toBe('create_new_group');
  });

  it('still refuses a serial on a COUNTED product', async () => {
    const { deps } = makeDeps();
    const r = await resolveLineVariant(
      deps,
      line({ serial_hint: 'SN-00A7' }),
      profileFor('shoes'),
    );
    expect(r.errorCode).toBe('SERIAL_NUMBER_NOT_ALLOWED_FOR_GROUPED_IMPORT');
  });
});

describe('toVariantLine normalizes at the review boundary', () => {
  it('narrows a free-text size system exactly as the create path does', () => {
    expect(toVariantLine({ id: 'l', line_number: 1, variant_size_system: 'us mens' })
      .variant_size_system).toBe('US_MENS');
    // Unrecognized reads as MISSING, so the size-system gate fires instead of
    // a junk value riding into a permanent identity key.
    expect(toVariantLine({ id: 'l', line_number: 1, variant_size_system: 'metric-ish' })
      .variant_size_system).toBeNull();
  });

  it('makes the review verdict match the create verdict for the same row', async () => {
    const { deps } = makeDeps();
    const row = {
      id: 'l1',
      line_number: 1,
      description: 'Nike Pegasus 41',
      qty_ordered_original: 6,
      vendor_product_number: 'FD2722',
      variant_size: '10',
      // What a document actually prints. Raw, this READ as present and the
      // create path read it as missing — two different verdicts, one row.
      variant_size_system: 'us mens',
      group_hint: 'Nike Pegasus 41',
    };
    const r = await resolveLineVariant(deps, toVariantLine(row), profileFor('shoes'));
    expect(r.result).toBe('create_new_group');
  });
});
