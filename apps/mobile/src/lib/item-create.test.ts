import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { APPAREL_ALPHA_SIZES, buildGroupKey } from '@stockpilot/core';

import {
  apparelFallbackSizeOptions,
  buildCreateItemInput,
  buildQuickAddInput,
  buildSizedVariantsInput,
  buildSportsGroupPayload,
  collectSizedVariants,
  deriveRackFields,
  describeFailure,
  sizeOptionsFromScale,
  sportsGroupFieldsFor,
  sportsProfileLabelFor,
  sportsShowsHomeAway,
  submitCreateItem,
  submitSizedVariants,
  EMPTY_SPORTS_GROUP_FIELDS,
  type ItemFormState,
  type SportsGroupFieldValues,
} from './item-create';

const CAT = '11111111-1111-1111-1111-111111111111';
const GROUP = '33333333-3333-3333-3333-333333333333';

// ./api reaches for expo-constants, AsyncStorage and the Supabase client at
// import time, none of which exist under the node test environment.
// vi.mock/vi.hoisted are hoisted above the imports by vitest's transform, so
// declaring them here keeps import order lint-clean.
const apiMock = vi.hoisted(() => ({ api: vi.fn(async () => ({}) as unknown) }));
vi.mock('./api', () => apiMock);

const BASE_FORM: ItemFormState = {
  name: 'Wireless mouse',
  sku: '',
  barcode: '',
  modelNumber: '',
  description: '',
  categoryId: null,
  supplierId: null,
  primaryLocationId: null,
  warehouseId: '22222222-2222-2222-2222-222222222222',
  charterId: null,
  rackNumber: '',
  rackRow: '',
  unitCost: '',
  retailPrice: '',
  onHand: '0',
  reorderPoint: '',
  reorderQuantity: '',
  unitOfMeasure: '',
  itemType: 'product',
  customFields: {},
};

const form = (overrides: Partial<ItemFormState> = {}): ItemFormState => ({
  ...BASE_FORM,
  ...overrides,
});

describe('buildCreateItemInput — the shared schema, not a native re-implementation', () => {
  it('ACCEPTS an empty SKU (the web behaviour mobile used to refuse)', () => {
    const res = buildCreateItemInput(form({ sku: '' }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      // Empty means "auto-generate server-side" — the schema drops it rather
      // than sending an empty string the DB would reject.
      expect(res.input.sku).toBeUndefined();
    }
  });

  it('REJECTS a 300-character name with field === "name"', () => {
    const res = buildCreateItemInput(form({ name: 'x'.repeat(300) }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.field).toBe('name');
      // A sentence, not a Postgres constraint string.
      expect(res.message).toMatch(/200/);
    }
  });

  it('REJECTS a negative unit cost', () => {
    const res = buildCreateItemInput(form({ unitCost: '-5' }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.field).toBe('unitCost');
  });

  it('parses a valid minimal payload', () => {
    const res = buildCreateItemInput(form());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.input.name).toBe('Wireless mouse');
      expect(res.input.itemType).toBe('product');
      expect(res.input.status).toBe('active');
      expect(res.input.quantityOnHand).toBe(0);
    }
  });

  it('keeps a jersey number of "07" as the string "07"', () => {
    const res = buildCreateItemInput(form({ jerseyNumber: '07' }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.input.jerseyNumber).toBe('07');
  });

  it('REJECTS a jersey number of "ABC" with field === "jerseyNumber"', () => {
    const res = buildCreateItemInput(form({ jerseyNumber: 'ABC' }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.field).toBe('jerseyNumber');
  });

  it('leaves unitOfMeasure UNDEFINED when the box is blank so the category default applies', () => {
    const res = buildCreateItemInput(form({ unitOfMeasure: '' }));
    expect(res.ok).toBe(true);
    // Substituting 'unit' here would overrule a shoe category's PAIR default on
    // every native create.
    if (res.ok) expect(res.input.unitOfMeasure).toBeUndefined();
  });

  it('sends an explicit unit of measure verbatim', () => {
    const res = buildCreateItemInput(form({ unitOfMeasure: 'pair' }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.input.unitOfMeasure).toBe('pair');
  });

  it('stamps bin_location from the rack — mobile never wrote it before', () => {
    const res = buildCreateItemInput(form({ rackNumber: '38', rackRow: 'a' }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.input.binLocation).toBe('38-A');
      expect(res.input.customFields).toMatchObject({ rack_number: '38', rack_row: 'A' });
    }
  });

  it('DECOMPOSES a whole shelf label typed into the number box', () => {
    const res = buildCreateItemInput(form({ rackNumber: '22-B', rackRow: '' }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.input.customFields).toMatchObject({ rack_number: '22', rack_row: 'B' });
      expect(res.input.binLocation).toBe('22-B');
    }
  });

  it('books route the AUTHOR input to custom_fields.author and use the book rack keys', () => {
    const res = buildCreateItemInput(
      form({
        itemType: 'book',
        name: 'A Brief History of Time',
        modelNumber: 'Stephen Hawking',
        rackNumber: '4',
        rackRow: 'c',
      }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.input.itemType).toBe('book');
      expect(res.input.modelNumber).toBeUndefined();
      expect(res.input.customFields).toMatchObject({
        author: 'Stephen Hawking',
        book_rack_number: '4',
        book_rack_row: 'C',
      });
      expect(res.input.customFields).not.toHaveProperty('rack_number');
    }
  });

  it('carries the scanner-prefilled barcode through', () => {
    const res = buildCreateItemInput(form({ barcode: '012345678905' }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.input.barcode).toBe('012345678905');
  });

  it('never lets the client name variant identity — variantKey is stripped by the schema', () => {
    const res = buildCreateItemInput(form({ variantSize: '10.5', variantSizeSystem: 'US_MENS' }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.input).not.toHaveProperty('variantKey');
      // variantSizeOriginal defaults to the printed size so the sticker text survives.
      expect(res.input.variantSizeOriginal).toBe('10.5');
    }
  });

  it('preserves per-org custom fields alongside the derived rack keys', () => {
    const res = buildCreateItemInput(
      form({ customFields: { warranty_months: 12 }, rackNumber: '9' }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.input.customFields).toMatchObject({ warranty_months: 12, rack_number: '9' });
    }
  });
});

describe('deriveRackFields', () => {
  it('drops the row when there is no number (a row alone is not a placement)', () => {
    const r = deriveRackFields({
      itemType: 'product',
      modelNumber: '',
      rackNumber: '',
      rackRow: 'B',
      customFields: {},
    });
    expect(r.number).toBe('');
    expect(r.row).toBe('');
    expect(r.binLocation).toBeNull();
    expect(r.customFields).toEqual({});
  });

  it('composes a number-only bin label', () => {
    const r = deriveRackFields({
      itemType: 'product',
      modelNumber: '',
      rackNumber: '38',
      rackRow: '',
      customFields: {},
    });
    expect(r.binLocation).toBe('38');
  });
});

describe('buildSizedVariantsInput — one request, the server fans out', () => {
  const SIZED = form({
    name: 'Team hoodie',
    categoryId: '11111111-1111-1111-1111-111111111111',
  });

  it('parses a size run and never names the rows itself', () => {
    const res = buildSizedVariantsInput(SIZED, [
      { size: 'M', quantity: 3 },
      { size: 'XL', quantity: 2 },
    ]);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.input.baseName).toBe('Team hoodie');
      expect(res.input.variants).toEqual([
        { size: 'M', quantity: 3 },
        { size: 'XL', quantity: 2 },
      ]);
      // The per-variant name and SKU are the server's to build.
      expect(res.input).not.toHaveProperty('name');
      expect(res.input).not.toHaveProperty('sku');
    }
  });

  it('accepts a numeric shoe size with a half — impossible under the old nine-letter list', () => {
    const res = buildSizedVariantsInput(SIZED, [{ size: '10.5', quantity: 1 }]);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.input.variants[0]?.size).toBe('10.5');
  });

  it('REJECTS an empty run with field === "variants"', () => {
    const res = buildSizedVariantsInput(SIZED, []);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.field).toBe('variants');
  });

  it('REJECTS more than 60 sizes — the cap the native fan-out never had', () => {
    const variants = Array.from({ length: 61 }, (_, i) => ({
      size: String(i + 1),
      quantity: 1,
    }));
    const res = buildSizedVariantsInput(SIZED, variants);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.field).toBe('variants');
  });

  it('REJECTS a run with no category (the fan-out needs one to resolve the size scale)', () => {
    const res = buildSizedVariantsInput(form({ categoryId: null }), [{ size: 'M', quantity: 1 }]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.field).toBe('categoryId');
  });

  it('passes the rack as STRUCTURED fields plus a composed bin label', () => {
    const res = buildSizedVariantsInput({ ...SIZED, rackNumber: '22-B' }, [
      { size: 'M', quantity: 1 },
    ]);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.input.rackNumber).toBe('22');
      expect(res.input.rackRow).toBe('B');
      expect(res.input.binLocation).toBe('22-B');
      // The reserved rack keys are the server's per-variant builder's job, so
      // they are NOT smuggled in through customFields.
      expect(res.input.customFields).toBeUndefined();
    }
  });
});

/**
 * Mobile sized-variant create must FORM A PRODUCT GROUP, exactly as web does.
 *
 * Live on the simulator against production (2026-07-28): a three-size shoe
 * style added on a phone saved three items with `group_id = NULL` and created
 * no `product_groups` row at all, while the same action on web created one.
 * The server only find-or-creates under
 * `profile.isSports && !groupId && input.productGroup`, and
 * `buildSizedVariantsInput` was the one builder that dropped `productGroup` —
 * so the branch never fired. The consequence was not cosmetic: those styles
 * never roll up on the Items tab, never appear in the size-count group picker,
 * and cannot be ordered as a size run.
 *
 * The pair of tests that matter most are the last two: a sports category sends
 * a group, and a plain apparel category — the whole of every non-sports org —
 * sends nothing at all, so its request is byte-identical to before.
 */
describe('buildSportsGroupPayload — the group decision, mirroring the server', () => {
  const SHOES = {
    subcategoryKey: 'shoes',
    defaultUnitOfMeasure: null,
    parentDefaultUnitOfMeasure: null,
  };
  const JERSEYS = {
    subcategoryKey: 'jerseys',
    defaultUnitOfMeasure: null,
    parentDefaultUnitOfMeasure: null,
  };

  it('names the group after the item and takes the subcategory counting unit', () => {
    const payload = buildSportsGroupPayload({
      itemName: '  Nike Pegasus 41  ',
      categoryId: CAT,
      category: SHOES,
    });
    expect(payload.productGroup).toEqual({
      name: 'Nike Pegasus 41',
      categoryId: CAT,
      // PAIR, from the shoes profile. Omitting it is NOT "let the server
      // decide": createProductGroupSchema defaults it to 'each', which would
      // beat the category on every phone-created shoe group.
      defaultCountingUnit: 'pair',
    });
    expect(payload.groupId).toBeUndefined();
  });

  it("prefers the category's own unit, then the parent's, over the profile default", () => {
    expect(
      buildSportsGroupPayload({
        itemName: 'Pegasus',
        categoryId: CAT,
        category: { ...SHOES, defaultUnitOfMeasure: 'case' },
      }).productGroup?.defaultCountingUnit,
    ).toBe('case');
    expect(
      buildSportsGroupPayload({
        itemName: 'Pegasus',
        categoryId: CAT,
        category: { ...SHOES, parentDefaultUnitOfMeasure: 'set' },
      }).productGroup?.defaultCountingUnit,
    ).toBe('set');
  });

  it('sends NOTHING for a plain (non-sports) category', () => {
    expect(
      buildSportsGroupPayload({
        itemName: 'Team hoodie',
        categoryId: CAT,
        category: { subcategoryKey: null, defaultUnitOfMeasure: null },
      }),
    ).toEqual({});
    // No category row at all (an environment without migration 0294).
    expect(
      buildSportsGroupPayload({ itemName: 'Team hoodie', categoryId: CAT, category: null }),
    ).toEqual({});
  });

  it('sends NOTHING for an unrecognised subcategory key rather than guessing', () => {
    expect(
      buildSportsGroupPayload({
        itemName: 'Mystery',
        categoryId: CAT,
        category: { subcategoryKey: 'not_a_real_key', defaultUnitOfMeasure: null },
      }),
    ).toEqual({});
  });

  it('defers to an explicitly chosen group and never sends both', () => {
    const payload = buildSportsGroupPayload({
      itemName: 'Nike Pegasus 41',
      categoryId: CAT,
      category: SHOES,
      groupId: GROUP,
    });
    expect(payload.groupId).toBe(GROUP);
    expect(payload.productGroup).toBeUndefined();
  });

  it('sends nothing for a nameless item — the group is named after the item', () => {
    expect(buildSportsGroupPayload({ itemName: '   ', categoryId: CAT, category: SHOES })).toEqual(
      {},
    );
  });

  /**
   * IDENTITY PARITY WITH WEB. `webPayload` below is literally the object
   * apps/web/src/components/inventory/item-form.tsx builds (`sportsGroupPayload`,
   * the `productGroup:` branch): the same eleven keys, the same
   * `.trim() || undefined` on every text field, the same `homeAway || undefined`.
   * If the two ever diverge, `buildGroupKey` gets two different tuples for one
   * physical style and `findOrCreate` — which is exact-key — mints a second
   * group instead of matching, splitting the stock between them.
   */
  const webPayload = (
    name: string,
    categoryId: string | null,
    g: SportsGroupFieldValues,
    countingUnit: string,
  ) => ({
    name,
    categoryId,
    brand: g.brand.trim() || undefined,
    model: g.model.trim() || undefined,
    styleNumber: g.styleNumber.trim() || undefined,
    colorway: g.colorway.trim() || undefined,
    team: g.team.trim() || undefined,
    league: g.league.trim() || undefined,
    season: g.season.trim() || undefined,
    homeAway: g.homeAway || undefined,
    color: g.color.trim() || undefined,
    defaultCountingUnit: countingUnit,
  });

  it('produces the IDENTICAL object web produces for a shoe style', () => {
    const groupFields: SportsGroupFieldValues = {
      ...EMPTY_SPORTS_GROUP_FIELDS,
      brand: ' Nike ',
      model: 'Vaporfly 3',
      styleNumber: 'DZ4494-001',
      colorway: 'Black/White',
    };
    const payload = buildSportsGroupPayload({
      itemName: 'Nike Vaporfly 3',
      categoryId: CAT,
      category: SHOES,
      groupFields,
    });
    expect(payload.productGroup).toEqual(webPayload('Nike Vaporfly 3', CAT, groupFields, 'pair'));
    // And the identity that actually results is the ATTRIBUTE key, not the
    // name fallback the phone used to force.
    expect(buildGroupKey({ ...payload.productGroup, subcategoryKey: 'shoes' })).toBe(
      'shoes|nike|vaporfly 3|dz4494-001|black/white',
    );
  });

  it('produces the IDENTICAL object web produces for a jersey', () => {
    const groupFields: SportsGroupFieldValues = {
      ...EMPTY_SPORTS_GROUP_FIELDS,
      team: 'Wildcats',
      league: 'Varsity',
      season: '2026-27',
      homeAway: 'home',
      color: 'Navy',
    };
    const payload = buildSportsGroupPayload({
      itemName: 'Wildcats home jersey',
      categoryId: CAT,
      category: JERSEYS,
      groupFields,
    });
    expect(payload.productGroup).toEqual(
      webPayload('Wildcats home jersey', CAT, groupFields, 'each'),
    );
    // team|league|season|home_away|manufacturer|brand|style_number|color —
    // manufacturer, brand and style number are the three empty slots.
    expect(buildGroupKey({ ...payload.productGroup, subcategoryKey: 'jerseys' })).toBe(
      'jerseys|wildcats|varsity|2026-27|home||||navy',
    );
  });

  it('falls back to the NAME key when every attribute is blank (behaviour before this change)', () => {
    const payload = buildSportsGroupPayload({
      itemName: 'Nike Vaporfly 3',
      categoryId: CAT,
      category: SHOES,
      groupFields: EMPTY_SPORTS_GROUP_FIELDS,
    });
    // Blank attributes collapse to undefined, so the object equals the one the
    // name-only payload produced — nothing regresses for a user who types
    // nothing into the new inputs.
    expect(payload.productGroup).toEqual(
      buildSportsGroupPayload({ itemName: 'Nike Vaporfly 3', categoryId: CAT, category: SHOES })
        .productGroup,
    );
    expect(buildGroupKey({ ...payload.productGroup, subcategoryKey: 'shoes' })).toBe(
      'shoes|name:nike vaporfly 3',
    );
  });

  it('sends nothing for a non-sports category even with attributes typed', () => {
    expect(
      buildSportsGroupPayload({
        itemName: 'Team hoodie',
        categoryId: CAT,
        category: { subcategoryKey: null, defaultUnitOfMeasure: null },
        groupFields: { ...EMPTY_SPORTS_GROUP_FIELDS, brand: 'Nike' },
      }),
    ).toEqual({});
  });
});

describe('sportsGroupFieldsFor — the inputs a subcategory shows', () => {
  const keys = (sub: string | null) => sportsGroupFieldsFor(sub).map((f) => f.key);

  it('offers the shoe identity attributes', () => {
    expect(keys('shoes')).toEqual(['brand', 'model', 'styleNumber', 'colorway']);
    expect(sportsShowsHomeAway('shoes')).toBe(false);
    expect(sportsProfileLabelFor('shoes')).toBe('Shoes');
  });

  it('offers the jersey identity attributes, home/away included', () => {
    expect(keys('jerseys')).toEqual(expect.arrayContaining(['team', 'league', 'season', 'color']));
    expect(sportsShowsHomeAway('jerseys')).toBe(true);
  });

  it('collects COLOR only where it is a group slot, never where it is a variant slot', () => {
    // groupKeyUsesColor: jerseys/uniforms only. Anywhere else the same
    // attribute names a per-ITEM variant, and putting it in the group payload
    // would key two colours of one style as two groups.
    expect(keys('jerseys')).toContain('color');
    for (const sub of ['shoes', 'balls', 'sports_apparel']) {
      expect(keys(sub)).not.toContain('color');
    }
  });

  it('shows nothing at all for a non-sports or unknown category', () => {
    expect(keys(null)).toEqual([]);
    expect(keys('not_a_real_key')).toEqual([]);
    expect(sportsShowsHomeAway(null)).toBe(false);
    expect(sportsProfileLabelFor(null)).toBe('');
  });
});

describe('buildSizedVariantsInput — the size run carries its product group', () => {
  const SIZED = form({
    name: 'Nike Pegasus 41',
    categoryId: CAT,
  });

  it('FORWARDS productGroup on a sports sized create (the defect: it was dropped)', () => {
    const { productGroup } = buildSportsGroupPayload({
      itemName: SIZED.name,
      categoryId: SIZED.categoryId,
      category: { subcategoryKey: 'shoes', defaultUnitOfMeasure: null },
    });
    const res = buildSizedVariantsInput({ ...SIZED, productGroup }, [
      { size: '9', quantity: 4 },
      { size: '10', quantity: 6 },
    ]);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.input.productGroup).toMatchObject({
        name: 'Nike Pegasus 41',
        categoryId: CAT,
        defaultCountingUnit: 'pair',
      });
      // Identity stays the SERVER's: nothing here names a key.
      expect(res.input.productGroup).not.toHaveProperty('groupKey');
      expect(res.input).not.toHaveProperty('variantKey');
    }
  });

  it('sends NO productGroup on a plain apparel sized create (non-sports unchanged)', () => {
    const { productGroup } = buildSportsGroupPayload({
      itemName: 'Team hoodie',
      categoryId: CAT,
      category: { subcategoryKey: null, defaultUnitOfMeasure: null },
    });
    const res = buildSizedVariantsInput({ ...SIZED, name: 'Team hoodie', productGroup }, [
      { size: 'M', quantity: 3 },
    ]);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.input.productGroup).toBeUndefined();
  });

  it('sends groupId alone when the caller already chose a group', () => {
    const res = buildSizedVariantsInput({ ...SIZED, groupId: GROUP }, [{ size: '9', quantity: 1 }]);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.input.groupId).toBe(GROUP);
      expect(res.input.productGroup).toBeUndefined();
    }
  });
});

describe('sizeOptionsFromScale — sizes are ordered, never alphabetical', () => {
  it('sorts by the scale sort_order, not by string comparison', () => {
    expect(
      sizeOptionsFromScale([
        { value: '10', sort_order: 100 },
        { value: '9', sort_order: 90 },
        { value: '9.5', sort_order: 95 },
      ]),
    ).toEqual(['9', '9.5', '10']);
  });

  it('keeps apparel letters in wearing order', () => {
    expect(
      sizeOptionsFromScale([
        { value: 'XL', sort_order: 50 },
        { value: 'S', sort_order: 20 },
        { value: 'XS', sort_order: 10 },
        { value: 'M', sort_order: 30 },
        { value: 'L', sort_order: 40 },
      ]),
    ).toEqual(['XS', 'S', 'M', 'L', 'XL']);
  });

  it('drops blank and case-duplicate values', () => {
    expect(
      sizeOptionsFromScale([
        { value: 'M', sort_order: 10 },
        { value: 'm', sort_order: 20 },
        { value: '   ', sort_order: 30 },
      ]),
    ).toEqual(['M']);
  });

  it('returns nothing for an empty scale rather than inventing a size list', () => {
    expect(sizeOptionsFromScale([])).toEqual([]);
  });
});

/**
 * The seeded apparel_alpha scale (migration 0294), verbatim: the union of every
 * spelling the codebase emits or parses, aliases included.
 */
const SEEDED_APPAREL_ALPHA: { value: string; sort_order: number }[] = [
  { value: 'XS', sort_order: 10 },
  { value: 'S', sort_order: 20 },
  { value: 'M', sort_order: 30 },
  { value: 'L', sort_order: 40 },
  { value: 'XL', sort_order: 50 },
  { value: 'XXL', sort_order: 60 },
  { value: '2XL', sort_order: 61 },
  { value: 'XXXL', sort_order: 70 },
  { value: '3XL', sort_order: 71 },
  { value: 'XXXXL', sort_order: 80 },
  { value: '4XL', sort_order: 81 },
  { value: 'XXXXXL', sort_order: 90 },
  { value: '5XL', sort_order: 91 },
  { value: '6XL', sort_order: 100 },
];

describe('apparelFallbackSizeOptions — one chip per physical size', () => {
  it('offers the SAME nine letters the web form offers, in wearing order', () => {
    // Not "nine values" — the exact nine, from the one shared list. A category
    // with size_scale_id NULL is every category today, so this is what a real
    // native size run renders.
    expect(apparelFallbackSizeOptions(SEEDED_APPAREL_ALPHA)).toEqual([...APPAREL_ALPHA_SIZES]);
  });

  it('drops the alias spellings that would create two items for one shirt', () => {
    const options = apparelFallbackSizeOptions(SEEDED_APPAREL_ALPHA);
    // XXL survives, 2XL does not: tapping both used to create two inventory
    // items, two SKUs and two stock levels for the same physical size.
    expect(options).toContain('XXL');
    for (const alias of ['2XL', '3XL', '4XL', '5XL', '6XL']) {
      expect(options).not.toContain(alias);
    }
    expect(new Set(options).size).toBe(options.length);
  });

  it('is NOT alias resolution — it never rewrites 2XL to XXL', () => {
    // Deciding the two name one variant is Tasks 17/19. Filtering a picker is
    // not merging: an alias-only scale yields nothing rather than a guess.
    expect(apparelFallbackSizeOptions([{ value: '2XL', sort_order: 61 }])).toEqual([]);
  });

  it('leaves a category-owned scale alone — a shoe run goes through sizeOptionsFromScale', () => {
    // The filter is fallback-only. Applied to a shoe scale it would empty the
    // picker, which is exactly why the screen branches on size_scale_id.
    const shoes = [
      { value: '9', sort_order: 90 },
      { value: '9.5', sort_order: 95 },
      { value: '10', sort_order: 100 },
    ];
    expect(sizeOptionsFromScale(shoes)).toEqual(['9', '9.5', '10']);
    expect(apparelFallbackSizeOptions(shoes)).toEqual([]);
  });
});

describe('buildQuickAddInput — the Scan tab cards use the SHARED schema', () => {
  const upc = {
    itemType: 'product' as const,
    name: 'Wireless mouse',
    sku: 'ITEM-45678905',
    barcode: '012345678905',
    modelNumber: 'MX432LL/A',
    description: 'A mouse.',
    quantity: '3',
    warehouseId: '22222222-2222-2222-2222-222222222222',
    customFields: { brand: 'Logitech' } as Record<string, unknown>,
  };

  it('carries the UPC card through: model number, brand, opening quantity', () => {
    const res = buildQuickAddInput(upc);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.input.name).toBe('Wireless mouse');
    expect(res.input.modelNumber).toBe('MX432LL/A');
    expect(res.input.barcode).toBe('012345678905');
    expect(res.input.customFields).toEqual({ brand: 'Logitech' });
    expect(res.input.itemType).toBe('product');
    // Opening stock rides on the ITEM, so the server's create() writes the
    // `initial` movement into Unplaced. The book card's old adjust_stock call
    // with a null location put it in STAGING instead.
    expect(res.input.quantityOnHand).toBe(3);
  });

  it('leaves unitOfMeasure unset so the category counting unit still wins', () => {
    const res = buildQuickAddInput(upc);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.input.unitOfMeasure).toBeUndefined();
  });

  it('sends NULL, not "", for a photo ID with no readable code', () => {
    const res = buildQuickAddInput({ ...upc, barcode: '' });
    expect(res.ok).toBe(true);
    // A placeholder empty barcode would collide with the next codeless add.
    if (res.ok) expect(res.input.barcode ?? null).toBeNull();
  });

  it('keeps the book card on custom_fields.author and sends no model number', () => {
    const res = buildQuickAddInput({
      itemType: 'book',
      name: 'The Great Gatsby',
      sku: 'BOOK-38016 3',
      barcode: '9780553380163',
      modelNumber: '',
      description: null,
      quantity: '1',
      warehouseId: '22222222-2222-2222-2222-222222222222',
      customFields: { author: 'F. Scott Fitzgerald', publisher: 'Scribner' },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.input.itemType).toBe('book');
    expect(res.input.modelNumber).toBeUndefined();
    // Written ONCE, under the key the web book form reads.
    expect(res.input.customFields).toEqual({
      author: 'F. Scott Fitzgerald',
      publisher: 'Scribner',
    });
  });

  it('floors a negative typed quantity at zero', () => {
    const res = buildQuickAddInput({ ...upc, quantity: '-3' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.input.quantityOnHand).toBe(0);
  });

  it('TRUNCATES an over-long looked-up description instead of refusing the add', () => {
    // The text came from Google Books / upcitemdb / the AI fallback — the user
    // never typed it and the card has no field to shorten it in.
    const res = buildQuickAddInput({ ...upc, description: 'x'.repeat(6000) });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.input.description).toHaveLength(5000);
  });

  it('REJECTS an over-long name with a named field, as the shared schema does', () => {
    const res = buildQuickAddInput({ ...upc, name: 'x'.repeat(300) });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.field).toBe('name');
  });
});

describe('collectSizedVariants', () => {
  it('keeps scale order and drops the sizes left at zero or blank', () => {
    expect(collectSizedVariants(['XS', 'S', 'M', 'L'], { S: '2', M: '', L: '0', XS: '1' })).toEqual(
      [
        { size: 'XS', quantity: 1 },
        { size: 'S', quantity: 2 },
      ],
    );
  });

  it('floors a fractional quantity and ignores an unknown size key', () => {
    expect(collectSizedVariants(['M'], { M: '3', XXL: '9' })).toEqual([{ size: 'M', quantity: 3 }]);
  });
});

describe('describeFailure', () => {
  it('names the field in human terms', () => {
    expect(describeFailure({ ok: false, message: 'Required', field: 'retailPrice' })).toBe(
      'Retail price: Required',
    );
  });

  it('uses the head of a dotted path', () => {
    expect(describeFailure({ ok: false, message: 'Too small', field: 'variants.0.size' })).toBe(
      'Sizes: Too small',
    );
  });

  it('falls back to the bare message when there is no field', () => {
    expect(describeFailure({ ok: false, message: 'Nope', field: null })).toBe('Nope');
  });

  it('does not say the field name twice', () => {
    // The shared schema now names its own field where that reads better, so
    // prefixing would produce "Name: Name is required."
    expect(describeFailure({ ok: false, message: 'Name is required.', field: 'name' })).toBe(
      'Name is required.',
    );
    expect(describeFailure({ ok: false, message: 'SKU is required.', field: 'baseSku' })).toBe(
      'SKU is required.',
    );
  });

  it('surfaces a SENTENCE, never zod developer text, for an empty native form', () => {
    // The exact defect this closes: submitting an empty Add Item screen showed
    // "Name: String must contain at least 1 character(s)" on the device.
    const res = buildCreateItemInput(form({ name: '' }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(describeFailure(res)).toBe('Name is required.');
      expect(describeFailure(res)).not.toMatch(/String must contain/);
    }
    const priced = buildCreateItemInput(form({ retailPrice: '-1' }));
    expect(priced.ok).toBe(false);
    if (!priced.ok) {
      expect(describeFailure(priced)).toBe('Retail price: Enter 0 or more.');
      expect(describeFailure(priced)).not.toMatch(/Number must be greater/);
    }
  });

  it('surfaces a sentence for a bad SIZE run too', () => {
    const empty = buildSizedVariantsInput(form({ categoryId: CAT }), []);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(describeFailure(empty)).toBe('Sizes: Pick at least one size.');
  });
});

describe('submit helpers hit the shared endpoints', () => {
  beforeEach(() => apiMock.api.mockClear());

  it('submitCreateItem POSTs /api/v1/items', async () => {
    apiMock.api.mockResolvedValueOnce({ id: 'item-1' });
    const built = buildCreateItemInput(form());
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    await expect(submitCreateItem(built.input)).resolves.toEqual({ id: 'item-1' });
    expect(apiMock.api).toHaveBeenCalledWith('/api/v1/items', {
      method: 'POST',
      body: built.input,
    });
  });

  it('submitSizedVariants POSTs /api/v1/items/sized-variants exactly once', async () => {
    apiMock.api.mockResolvedValueOnce({ created: 2, ids: ['a', 'b'] });
    const built = buildSizedVariantsInput(
      form({ categoryId: '11111111-1111-1111-1111-111111111111' }),
      [
        { size: 'M', quantity: 1 },
        { size: 'L', quantity: 1 },
      ],
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    await expect(submitSizedVariants(built.input)).resolves.toEqual({
      created: 2,
      ids: ['a', 'b'],
    });
    // ONE request for the whole run — not one per size, and not N raw inserts.
    expect(apiMock.api).toHaveBeenCalledTimes(1);
    expect(apiMock.api).toHaveBeenCalledWith('/api/v1/items/sized-variants', {
      method: 'POST',
      body: built.input,
    });
  });
});

/**
 * WIRING PINS for app/item/new.tsx. The screen imports native modules at top
 * level, so the vitest config excludes app/ from compilation; these
 * source-level assertions pin the load-bearing wiring to the pure seams above.
 * Every pin below corresponds to a rule mobile used to skip.
 */
describe('app/item/new.tsx is wired to the shared create path', () => {
  const src = readFileSync(path.resolve(__dirname, '../../app/item/new.tsx'), 'utf8');

  it('no longer inserts into inventory_items from the client', () => {
    expect(src).not.toMatch(/from\('inventory_items'\)/);
  });

  it('no longer writes stock_movements from the client', () => {
    expect(src).not.toMatch(/from\('stock_movements'\)/);
  });

  it('no longer calls the adjust_stock RPC — create() writes the initial movement', () => {
    // Calling it after a create with quantityOnHand > 0 would DOUBLE-count.
    // Matched on the CALL form so the explanatory comment in the screen (which
    // names the RPC) does not satisfy the pin.
    expect(src).not.toMatch(/\.rpc\(/);
  });

  it('carries no hardcoded apparel size list', () => {
    expect(src).not.toMatch(/ALL_SIZES/);
    expect(src).not.toMatch(/'XXXXXL'/);
  });

  it('submits through the shared builders and the Bearer routes', () => {
    for (const symbol of [
      'buildCreateItemInput',
      'submitCreateItem',
      'buildSizedVariantsInput',
      'submitSizedVariants',
      'collectSizedVariants',
      'sizeOptionsFromScale',
      'describeFailure',
    ]) {
      expect(src).toContain(symbol);
    }
    expect(src).toMatch(/from '@\/lib\/item-create'/);
  });

  it('drives the size chips from the category size scale', () => {
    expect(src).toMatch(/size_scale_values/);
    expect(src).toMatch(/size_scale_id/);
  });

  it('reads the sports columns and puts the group decision in the form payload', () => {
    // The screen has no brand/model/team inputs, so the ONLY thing that can
    // make a create sports-shaped is the category — and it has to be read.
    // Before this, `currentForm()` populated neither `groupId` nor
    // `productGroup`, so the server's find-or-create branch never fired.
    expect(src).toMatch(/sports_subcategory_key/);
    expect(src).toMatch(/default_unit_of_measure/);
    expect(src).toContain('buildSportsGroupPayload');
  });

  it('renders the group-identity inputs and threads them into the payload', () => {
    // Without these boxes the phone can only ever send a name, so its group key
    // is the `name:` fallback while web's is the attribute tuple — one style,
    // two groups, stock split. The spec asks for them on Expo as well as web.
    for (const symbol of [
      'sportsGroupFieldsFor',
      'sportsShowsHomeAway',
      'setSportsGroupFields',
      'groupFields: sportsGroupFields',
    ]) {
      expect(src).toContain(symbol);
    }
    // The vocabulary is the shared helper's, never a list in the screen.
    expect(src).not.toMatch(/'styleNumber'/);
    expect(src).not.toMatch(/=== 'shoes'/);
  });

  it('still uploads photos and still honours the scanned barcode prefill', () => {
    expect(src).toMatch(/uploadPhotosFor/);
    expect(src).toMatch(/params\.barcode/);
  });

  it('narrows the NO-SCALE fallback to the canonical letters', () => {
    // A category-owned scale must still render verbatim, so both seams have to
    // be present and the fallback branch must pick the filtered one.
    expect(src).toContain('apparelFallbackSizeOptions');
    expect(src).toContain('sizeOptionsFromScale');
    expect(src).toMatch(/isFallback\s*\?\s*apparelFallbackSizeOptions/);
  });

  it('does not render a MODEL NUMBER box the sized fan-out would discard', () => {
    // bulkCreateSizedVariantsSchema carries no model number and the service
    // never writes model_number, so the field is hidden during a size run
    // rather than silently dropped.
    expect(src).toMatch(/variantsEnabled \? null : \(/);
  });
});

/**
 * WIRING PINS for the Scan tab's quick-add cards. Same reason as above: they
 * import react-native at top level, so only their SOURCE is asserted here.
 */
describe('the Scan tab quick-add cards are wired to the shared create path', () => {
  const cards: [string, string][] = [
    ['AddItemCard', '../components/AddItemCard.tsx'],
    ['AddBookCard', '../components/AddBookCard.tsx'],
  ];

  for (const [label, rel] of cards) {
    describe(label, () => {
      const src = readFileSync(path.resolve(__dirname, rel), 'utf8');

      it('no longer raw-inserts inventory_items', () => {
        expect(src).not.toMatch(/from\('inventory_items'\)/);
      });

      it('no longer writes stock_movements or calls an RPC', () => {
        expect(src).not.toMatch(/from\('stock_movements'\)/);
        expect(src).not.toMatch(/\.rpc\(/);
      });

      it('no longer guesses the org from the first organization_members row', () => {
        // `.limit(1)` on organization_members returns the FIRST membership, not
        // the workspace the user switched into — a scan in the second org
        // created the item in the first. The Bearer context owns the org now.
        // Matched on the QUERY form so the explanatory comment in each card
        // (which names the table) does not satisfy the pin.
        expect(src).not.toMatch(/from\('organization_members'\)/);
        expect(src).not.toMatch(/organization_id:/);
        // No direct Supabase client left in these cards at all.
        expect(src).not.toMatch(/from '@\/lib\/supabase'/);
      });

      it('posts through buildQuickAddInput + submitCreateItem', () => {
        expect(src).toContain('buildQuickAddInput');
        expect(src).toContain('submitCreateItem');
        expect(src).toContain('describeFailure');
        expect(src).toMatch(/from '@\/lib\/item-create'/);
      });

      it('keeps its warehouse picker and its initial-quantity box', () => {
        expect(src).toContain('listWarehouses');
        expect(src).toContain('Initial qty');
      });
    });
  }

  it('AddItemCard still carries the model number and the brand custom field', () => {
    const src = readFileSync(path.resolve(__dirname, '../components/AddItemCard.tsx'), 'utf8');
    expect(src).toMatch(/customFields\.brand = enrichment\.brand/);
    expect(src).toContain('modelNumber');
  });

  it('AddBookCard still carries author, publisher and grade', () => {
    const src = readFileSync(path.resolve(__dirname, '../components/AddBookCard.tsx'), 'utf8');
    expect(src).toMatch(/customFields\.author/);
    expect(src).toMatch(/customFields\.publisher/);
    expect(src).toMatch(/customFields\.book_grade/);
  });
});
