import { describe, expect, it } from 'vitest';

import { canonicalPoLineSchema } from './po-imports';

/** The pre-sports line shape every existing parser emits. */
function legacyLine() {
  return {
    lineNumber: 1,
    lineType: 'inventory' as const,
    qtyOrderedOriginal: 3,
    uomOriginal: 'EA',
    description: 'Nike Pegasus 41',
    unitCost: 89.99,
    lineTotal: 269.97,
    vendorItemNumber: 'FD2722',
    vendorProductNumber: null,
    auxiliaryNumber: null,
    coaCode: null,
  };
}

describe('canonicalPoLineSchema — sports variant fields', () => {
  it('still accepts a line with no variant fields at all (existing parsers unchanged)', () => {
    const parsed = canonicalPoLineSchema.parse(legacyLine());
    expect(parsed.description).toBe('Nike Pegasus 41');
    // Absent, not defaulted to a value nobody supplied.
    expect(parsed.variantSize).toBeUndefined();
    expect(parsed.jerseyNumber).toBeUndefined();
    expect(parsed.mappingConfidence).toBeUndefined();
  });

  it('accepts explicit nulls for every variant field (missing stays missing)', () => {
    const parsed = canonicalPoLineSchema.parse({
      ...legacyLine(),
      variantSize: null,
      variantSizeOriginal: null,
      variantSizeSystem: null,
      variantWidth: null,
      variantFit: null,
      variantColor: null,
      jerseyNumber: null,
      playerName: null,
      groupHint: null,
      mappingConfidence: null,
    });
    expect(parsed.variantSize).toBeNull();
    expect(parsed.jerseyNumber).toBeNull();
    expect(parsed.mappingConfidence).toBeNull();
  });

  it('round-trips a full variant line', () => {
    const parsed = canonicalPoLineSchema.parse({
      ...legacyLine(),
      variantSize: '10.5',
      variantSizeOriginal: 'US 10 1/2',
      variantSizeSystem: 'US_MENS',
      variantWidth: '2E',
      variantFit: 'mens',
      variantColor: 'Black/White',
      jerseyNumber: '07',
      playerName: 'A. Rosas',
      groupHint: 'Nike Pegasus 41 FD2722',
      mappingConfidence: 0.62,
    });
    expect(parsed.variantSize).toBe('10.5');
    expect(parsed.variantSizeOriginal).toBe('US 10 1/2');
    expect(parsed.variantWidth).toBe('2E');
    expect(parsed.groupHint).toBe('Nike Pegasus 41 FD2722');
    expect(parsed.mappingConfidence).toBe(0.62);
  });

  it('keeps jerseyNumber a STRING with its leading zeroes', () => {
    for (const n of ['0', '00', '07', '007']) {
      const parsed = canonicalPoLineSchema.parse({ ...legacyLine(), jerseyNumber: n });
      expect(parsed.jerseyNumber).toBe(n);
      expect(typeof parsed.jerseyNumber).toBe('string');
    }
  });

  it('rejects a NUMERIC jerseyNumber — coercing one is how 07 becomes 7', () => {
    const res = canonicalPoLineSchema.safeParse({ ...legacyLine(), jerseyNumber: 7 });
    expect(res.success).toBe(false);
  });

  it('preserves the source size string verbatim — no normalization here', () => {
    const parsed = canonicalPoLineSchema.parse({
      ...legacyLine(),
      variantSize: ' xl ',
      variantSizeOriginal: ' xl ',
    });
    expect(parsed.variantSize).toBe(' xl ');
    expect(parsed.variantSizeOriginal).toBe(' xl ');
  });

  it('bounds mappingConfidence to 0..1', () => {
    expect(canonicalPoLineSchema.safeParse({ ...legacyLine(), mappingConfidence: 1 }).success).toBe(
      true,
    );
    expect(canonicalPoLineSchema.safeParse({ ...legacyLine(), mappingConfidence: 0 }).success).toBe(
      true,
    );
    expect(
      canonicalPoLineSchema.safeParse({ ...legacyLine(), mappingConfidence: 1.5 }).success,
    ).toBe(false);
    expect(
      canonicalPoLineSchema.safeParse({ ...legacyLine(), mappingConfidence: -0.1 }).success,
    ).toBe(false);
  });
});
