import { describe, expect, it } from 'vitest';

import { createItemSchema } from './inventory';

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
