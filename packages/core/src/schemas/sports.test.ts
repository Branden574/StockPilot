import { describe, expect, it } from 'vitest';

import {
  createProductGroupSchema,
  jerseyNumberSchema,
  sizeSystemSchema,
  variantAttributesSchema,
} from './sports';

describe('jerseyNumberSchema', () => {
  it('parses a valid number and preserves leading zeroes', () => {
    expect(jerseyNumberSchema.parse('07')).toBe('07');
    expect(jerseyNumberSchema.parse('00')).toBe('00');
    expect(jerseyNumberSchema.parse('7')).not.toBe(jerseyNumberSchema.parse('07'));
  });

  it('strips a leading hash and surrounding whitespace before validating', () => {
    expect(jerseyNumberSchema.parse(' #12 ')).toBe('12');
  });

  it('rejects a value with non-digit characters after the hash strip', () => {
    expect(jerseyNumberSchema.safeParse('12A').success).toBe(false);
    expect(jerseyNumberSchema.safeParse('#12A').success).toBe(false);
  });

  it('accepts a leading hash — it is stripped, not a validation failure', () => {
    expect(jerseyNumberSchema.safeParse('#12').success).toBe(true);
    expect(jerseyNumberSchema.parse('#12')).toBe('12');
  });

  it('rejects a value over 4 digits', () => {
    expect(jerseyNumberSchema.safeParse('12345').success).toBe(false);
  });

  it('treats blank input as absent rather than invalid', () => {
    expect(jerseyNumberSchema.parse('')).toBeUndefined();
    expect(jerseyNumberSchema.parse(undefined)).toBeUndefined();
    expect(jerseyNumberSchema.parse(null)).toBeNull();
  });
});

describe('sizeSystemSchema', () => {
  it('accepts each known size system', () => {
    for (const s of ['US_MENS', 'US_WOMENS', 'US_YOUTH', 'UK', 'EU', 'CM', 'ALPHA', 'CUSTOM']) {
      expect(sizeSystemSchema.parse(s)).toBe(s);
    }
  });

  it('treats a blank string as absent', () => {
    expect(sizeSystemSchema.parse('')).toBeUndefined();
  });

  it('rejects an unknown size system rather than accepting free text', () => {
    expect(sizeSystemSchema.safeParse('METRIC').success).toBe(false);
  });
});

describe('variantAttributesSchema', () => {
  it('parses an empty object — every field is optional', () => {
    const parsed = variantAttributesSchema.parse({});
    expect(parsed.groupId).toBeUndefined();
    expect(parsed.jerseyNumber).toBeUndefined();
    expect(parsed.variantSize).toBeUndefined();
  });

  it('round-trips the shoe-shaped variant fields', () => {
    const parsed = variantAttributesSchema.parse({
      variantSize: '10.5',
      variantSizeOriginal: '10.5',
      variantSizeSystem: 'US_MENS',
      variantWidth: 'wide',
    });
    expect(parsed.variantSize).toBe('10.5');
    expect(parsed.variantSizeSystem).toBe('US_MENS');
    expect(parsed.variantWidth).toBe('wide');
  });

  it('round-trips the jersey-shaped variant fields, keeping a leading zero', () => {
    const parsed = variantAttributesSchema.parse({
      jerseyNumber: '00',
      playerName: 'J. Smith',
      variantSize: 'M',
    });
    expect(parsed.jerseyNumber).toBe('00');
    expect(parsed.playerName).toBe('J. Smith');
  });

  it('rejects an invalid jersey number rather than silently dropping it', () => {
    expect(() => variantAttributesSchema.parse({ jerseyNumber: 'ABC' })).toThrow();
  });
});

describe('createProductGroupSchema', () => {
  it('requires a name', () => {
    expect(createProductGroupSchema.safeParse({}).success).toBe(false);
  });

  it('defaults the counting unit to each', () => {
    const parsed = createProductGroupSchema.parse({ name: 'Home Jersey' });
    expect(parsed.defaultCountingUnit).toBe('each');
  });

  it('accepts a full shoe-shaped group', () => {
    const parsed = createProductGroupSchema.parse({
      name: 'Nike Pegasus 41',
      brand: 'Nike',
      model: 'Pegasus 41',
      styleNumber: 'FD2722',
      colorway: 'Black/White',
      defaultCountingUnit: 'pair',
    });
    expect(parsed.brand).toBe('Nike');
    expect(parsed.defaultCountingUnit).toBe('pair');
  });

  it('rejects a homeAway value outside the enum', () => {
    expect(
      createProductGroupSchema.safeParse({ name: 'Falcons Jersey', homeAway: 'neutral' }).success,
    ).toBe(false);
  });
});
