import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildCreateItemInput,
  buildSizedVariantsInput,
  collectSizedVariants,
  deriveRackFields,
  describeFailure,
  sizeOptionsFromScale,
  submitCreateItem,
  submitSizedVariants,
  type ItemFormState,
} from './item-create';

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
    const res = buildCreateItemInput(
      form({ variantSize: '10.5', variantSizeSystem: 'US_MENS' }),
    );
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
    const res = buildSizedVariantsInput(form({ categoryId: null }), [
      { size: 'M', quantity: 1 },
    ]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.field).toBe('categoryId');
  });

  it('passes the rack as STRUCTURED fields plus a composed bin label', () => {
    const res = buildSizedVariantsInput(
      { ...SIZED, rackNumber: '22-B' },
      [{ size: 'M', quantity: 1 }],
    );
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

describe('collectSizedVariants', () => {
  it('keeps scale order and drops the sizes left at zero or blank', () => {
    expect(
      collectSizedVariants(['XS', 'S', 'M', 'L'], { S: '2', M: '', L: '0', XS: '1' }),
    ).toEqual([
      { size: 'XS', quantity: 1 },
      { size: 'S', quantity: 2 },
    ]);
  });

  it('floors a fractional quantity and ignores an unknown size key', () => {
    expect(collectSizedVariants(['M'], { M: '3', XXL: '9' })).toEqual([
      { size: 'M', quantity: 3 },
    ]);
  });
});

describe('describeFailure', () => {
  it('names the field in human terms', () => {
    expect(describeFailure({ ok: false, message: 'Required', field: 'retailPrice' })).toBe(
      'Retail price: Required',
    );
  });

  it('uses the head of a dotted path', () => {
    expect(
      describeFailure({ ok: false, message: 'Too small', field: 'variants.0.size' }),
    ).toBe('Sizes: Too small');
  });

  it('falls back to the bare message when there is no field', () => {
    expect(describeFailure({ ok: false, message: 'Nope', field: null })).toBe('Nope');
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

  it('still uploads photos and still honours the scanned barcode prefill', () => {
    expect(src).toMatch(/uploadPhotosFor/);
    expect(src).toMatch(/params\.barcode/);
  });
});
