import { describe, expect, it } from 'vitest';

import { APPAREL_ALPHA_SIZES, isApparelAlphaSize } from './apparel-sizes';

describe('APPAREL_ALPHA_SIZES', () => {
  it('is the nine canonical letters, in wearing order', () => {
    // Pinned literally. Web's item form, web's "add sizes" dialog and the
    // native size-run fallback all render THIS array; a silent edit here would
    // change what three surfaces offer at once.
    expect([...APPAREL_ALPHA_SIZES]).toEqual([
      'XS',
      'S',
      'M',
      'L',
      'XL',
      'XXL',
      'XXXL',
      'XXXXL',
      'XXXXXL',
    ]);
  });

  it('holds exactly one spelling per physical size', () => {
    expect(new Set(APPAREL_ALPHA_SIZES).size).toBe(APPAREL_ALPHA_SIZES.length);
    // The alias spellings the apparel_alpha SCALE also carries (migration 0294
    // seeds the union so inbound strings still match) are deliberately absent:
    // offered side by side, XXL and 2XL become two items for one shirt.
    for (const alias of ['2XL', '3XL', '4XL', '5XL', '6XL']) {
      expect(APPAREL_ALPHA_SIZES as ReadonlyArray<string>).not.toContain(alias);
    }
  });
});

describe('isApparelAlphaSize', () => {
  it('accepts a canonical letter regardless of case or padding', () => {
    expect(isApparelAlphaSize('xxl')).toBe(true);
    expect(isApparelAlphaSize('  M ')).toBe(true);
  });

  it('rejects an alias — this is a membership test, NOT alias resolution', () => {
    // Mapping 2XL onto XXL decides that two stored variants are one, which
    // merges stock. That belongs to the import matcher (Tasks 17/19).
    expect(isApparelAlphaSize('2XL')).toBe(false);
    expect(isApparelAlphaSize('6XL')).toBe(false);
  });

  it('rejects a numeric shoe size and blank input', () => {
    expect(isApparelAlphaSize('9.5')).toBe(false);
    expect(isApparelAlphaSize('')).toBe(false);
  });
});
