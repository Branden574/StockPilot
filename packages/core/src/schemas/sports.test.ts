import { describe, expect, it } from 'vitest';

import {
  createProductGroupSchema,
  jerseyNumberSchema,
  linkFamilyMemberSchema,
  serverVariantAttributesSchema,
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

  it('STRIPS a client-supplied variantKey — the key is server-computed only', () => {
    // A client that posts its own variant_key could steer two distinct
    // variants onto one identity (or split one across two). The value is
    // derived from the attributes by buildVariantKey on the server, so it is
    // dropped here rather than merely ignored downstream.
    const parsed = variantAttributesSchema.parse({
      variantSize: '10',
      variantKey: 'size=9|system=us_mens',
    });
    expect('variantKey' in parsed).toBe(false);
    expect((parsed as Record<string, unknown>).variantKey).toBeUndefined();
    expect(parsed.variantSize).toBe('10');
  });

  it('does not FAIL on a client-supplied variantKey — it is dropped, not rejected', () => {
    // Older clients (and the mobile app between OTA releases) still send it.
    expect(variantAttributesSchema.safeParse({ variantKey: 'anything' }).success).toBe(true);
  });
});

describe('serverVariantAttributesSchema', () => {
  it('is the ONLY shape that carries variantKey', () => {
    const parsed = serverVariantAttributesSchema.parse({
      variantSize: '10',
      variantKey: 'size=10|system=us_mens',
    });
    expect(parsed.variantKey).toBe('size=10|system=us_mens');
  });

  it('accepts a null variantKey (a variant-less item)', () => {
    expect(serverVariantAttributesSchema.parse({ variantKey: null }).variantKey).toBeNull();
  });

  it('still carries every client-side variant attribute', () => {
    const parsed = serverVariantAttributesSchema.parse({ jerseyNumber: '07', playerName: 'J. S.' });
    expect(parsed.jerseyNumber).toBe('07');
    expect(parsed.playerName).toBe('J. S.');
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

/**
 * `inventory_items_variant_size_check` (migration 0298) caps variant_size at 24
 * characters. `variantAttributesSchema` matches it; `linkFamilyMemberSchema` was
 * left at 32, so a 25-32 character size passed validation, reached the service,
 * and blew up mid-batch on the DB CHECK — after earlier members of the same link
 * had already been written (linkFamily updates row by row). A 400 at the
 * boundary is a message a reviewer can act on; a 500 halfway through a 200-item
 * link is a half-linked family.
 */
describe('linkFamilyMemberSchema — variantSize matches the DB CHECK', () => {
  const member = (variantSize: string) => ({
    itemId: '11111111-1111-1111-1111-111111111111',
    variantSize,
  });

  it('accepts a size at the 24-character DB limit', () => {
    expect(linkFamilyMemberSchema.safeParse(member('X'.repeat(24))).success).toBe(true);
  });

  it('REFUSES a size the DB CHECK would reject mid-batch', () => {
    for (const len of [25, 32]) {
      expect(linkFamilyMemberSchema.safeParse(member('X'.repeat(len))).success).toBe(false);
    }
  });

  it('agrees with variantAttributesSchema, the bound every other path uses', () => {
    const long = 'X'.repeat(25);
    expect(variantAttributesSchema.safeParse({ variantSize: long }).success).toBe(
      linkFamilyMemberSchema.safeParse(member(long)).success,
    );
  });
});
