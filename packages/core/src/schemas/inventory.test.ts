import { describe, expect, it } from 'vitest';

import { bulkCreateSizedVariantsSchema, createItemSchema } from './inventory';

/**
 * These schemas are the ONE validator behind the web item form, the native Add
 * Item screen and the /api/v1/items* routes, so their messages are user-facing
 * copy. Verified on a device (2026-07-28): an empty Add Item form showed
 * "Name: String must contain at least 1 character(s)". Bounds and codes are
 * unchanged — only what a human reads.
 */
describe('createItemSchema — refusals read as sentences, not zod internals', () => {
  const firstMessage = (input: unknown) => {
    const res = createItemSchema.safeParse(input);
    expect(res.success).toBe(false);
    return res.success ? '' : res.error.issues[0]?.message;
  };

  it('names a missing name', () => {
    expect(firstMessage({ name: '' })).toBe('Name is required.');
  });

  it('says how long a name may be, in words', () => {
    expect(firstMessage({ name: 'x'.repeat(201) })).toBe('Name must be 200 characters or less.');
  });

  it('explains a negative quantity and a negative price', () => {
    expect(firstMessage({ name: 'Widget', retailPrice: -1 })).toBe('Enter 0 or more.');
    expect(firstMessage({ name: 'Widget', unitCost: -1 })).toBe('Enter 0 or more.');
  });

  it('explains a non-numeric quantity', () => {
    expect(firstMessage({ name: 'Widget', quantityOnHand: 'lots' })).toBe('Enter a number.');
  });

  it('still ACCEPTS an empty SKU — the message is new, the rule is not', () => {
    expect(createItemSchema.parse({ name: 'Widget', sku: '' }).sku).toBeUndefined();
  });
});

describe('bulkCreateSizedVariantsSchema — the size run reads as sentences too', () => {
  const RUN = {
    baseName: 'Nike Pegasus 41',
    baseSku: null,
    baseBarcode: null,
    description: null,
    categoryId: '11111111-1111-1111-1111-111111111111',
    supplierId: null,
    warehouseId: '22222222-2222-2222-2222-222222222222',
    charterId: null,
    primaryLocationId: null,
    binLocation: null,
    retailPrice: 0,
    unitCost: 0,
    reorderPoint: 0,
    reorderQuantity: 0,
    variants: [{ size: '9', quantity: 1 }],
  };
  const firstMessage = (over: Record<string, unknown>) => {
    const res = bulkCreateSizedVariantsSchema.safeParse({ ...RUN, ...over });
    expect(res.success).toBe(false);
    return res.success ? '' : res.error.issues[0]?.message;
  };

  it('names a missing name', () => {
    expect(firstMessage({ baseName: '' })).toBe('Name is required.');
  });

  it('asks for a size instead of quoting a string bound', () => {
    expect(firstMessage({ variants: [] })).toBe('Pick at least one size.');
    expect(firstMessage({ variants: [{ size: '', quantity: 1 }] })).toBe(
      'Every size needs a value.',
    );
  });

  it('explains the 60-size cap and a bad per-size quantity', () => {
    expect(
      firstMessage({
        variants: Array.from({ length: 61 }, (_, i) => ({ size: String(i + 1), quantity: 1 })),
      }),
    ).toBe('A size run can cover at most 60 sizes.');
    expect(firstMessage({ variants: [{ size: '9', quantity: -1 }] })).toBe('Enter 0 or more.');
    expect(firstMessage({ variants: [{ size: '9', quantity: 1.5 }] })).toBe(
      'Enter a whole number.',
    );
  });

  it('parses an unchanged valid run — behaviour is identical', () => {
    const parsed = bulkCreateSizedVariantsSchema.parse(RUN);
    expect(parsed.variants).toEqual([{ size: '9', quantity: 1 }]);
  });
});

describe('createItemSchema — pre-sports regression', () => {
  it('still parses a pre-sports payload with no variant fields', () => {
    const parsed = createItemSchema.parse({ name: 'Plain Widget' });
    expect(parsed.groupId).toBeUndefined();
    expect(parsed.jerseyNumber).toBeUndefined();
    expect(parsed.trackingType).toBe('none');
  });
});

describe('createItemSchema — sports variant fields (Task 7)', () => {
  it('round-trips a shoe-shaped variant payload', () => {
    const parsed = createItemSchema.parse({
      name: 'Nike Pegasus 41 — size 10',
      groupId: '123e4567-e89b-12d3-a456-426614174000',
      variantSize: '10.5',
      variantSizeOriginal: '10.5',
      variantSizeSystem: 'US_MENS',
      variantWidth: 'wide',
    });
    expect(parsed.groupId).toBe('123e4567-e89b-12d3-a456-426614174000');
    expect(parsed.variantSize).toBe('10.5');
    expect(parsed.variantSizeSystem).toBe('US_MENS');
    expect(parsed.variantWidth).toBe('wide');
  });

  it('round-trips a jersey-shaped variant payload, preserving a leading zero', () => {
    const parsed = createItemSchema.parse({
      name: 'Falcons Home Jersey — #07',
      jerseyNumber: '07',
      variantSize: 'M',
    });
    expect(parsed.jerseyNumber).toBe('07');
    expect(parsed.variantSize).toBe('M');
  });

  it('rejects an invalid jersey number rather than silently stripping it', () => {
    expect(() =>
      createItemSchema.parse({ name: 'Bad Jersey', jerseyNumber: 'not-a-number' }),
    ).toThrow();
  });

  it('accepts an embedded productGroup for server-side group creation', () => {
    const parsed = createItemSchema.parse({
      name: 'Nike Pegasus 41 — size 10',
      productGroup: {
        name: 'Nike Pegasus 41',
        brand: 'Nike',
        model: 'Pegasus 41',
        styleNumber: 'FD2722',
        defaultCountingUnit: 'pair',
      },
    });
    expect(parsed.productGroup?.brand).toBe('Nike');
    expect(parsed.productGroup?.defaultCountingUnit).toBe('pair');
  });

  it('accepts a trackingModeOverride from the allowed vocabulary', () => {
    const parsed = createItemSchema.parse({
      name: 'Falcons Home Jersey',
      trackingModeOverride: 'NUMBERED_VARIANT',
    });
    expect(parsed.trackingModeOverride).toBe('NUMBERED_VARIANT');
  });

  it('STRIPS a client-supplied variantKey from a create payload', () => {
    const parsed = createItemSchema.parse({
      name: 'Nike Pegasus 41 — size 10',
      variantSize: '10',
      variantKey: 'size=9|system=us_mens',
    });
    expect('variantKey' in parsed).toBe(false);
    expect(parsed.variantSize).toBe('10');
  });

  it('rejects a trackingModeOverride outside the shared vocabulary', () => {
    expect(() =>
      createItemSchema.parse({ name: 'Falcons Home Jersey', trackingModeOverride: 'BOGUS_MODE' }),
    ).toThrow();
  });
});
