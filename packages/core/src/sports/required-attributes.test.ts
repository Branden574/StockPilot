import { describe, expect, it } from 'vitest';

import { asSizeSystem } from '../schemas/sports';
import {
  isAttributeRequired,
  requiredAttributeProblems,
  resolveSubcategoryProfile,
  sizePlaceholder,
} from './required-attributes';
import { DEFAULT_SUBCATEGORY_PROFILES, type SubcategoryTrackingProfile } from './tracking-modes';

const JERSEYS = DEFAULT_SUBCATEGORY_PROFILES.jerseys;
const SHOES = DEFAULT_SUBCATEGORY_PROFILES.shoes;

const CUSTOM: SubcategoryTrackingProfile = {
  key: 'hockey_sticks',
  label: 'Hockey sticks',
  defaultMode: 'QUANTITY_BY_VARIANT',
  allowedModes: ['QUANTITY_BY_VARIANT'],
  supportedAttributes: ['size', 'jersey_number'],
  requiredAttributes: ['jersey_number'],
  defaultCountingUnit: 'each',
  supportsNumbers: true,
  supportsSizes: true,
  supportsColors: false,
  individualTrackingAllowed: false,
};

describe('resolveSubcategoryProfile — the server rule, shared', () => {
  it('returns the built-in profile for a built-in key', () => {
    expect(resolveSubcategoryProfile('jerseys', null)).toBe(JERSEYS);
  });

  it('prefers the built-in profile over a jsonb profile on the same row', () => {
    expect(resolveSubcategoryProfile('shoes', CUSTOM)).toBe(SHOES);
  });

  it("falls back to the category's own jsonb profile for a custom key", () => {
    expect(resolveSubcategoryProfile('hockey_sticks', CUSTOM)).toEqual(CUSTOM);
  });

  it('treats a jsonb profile with no key as a sports profile, exactly as the server does', () => {
    expect(resolveSubcategoryProfile(null, CUSTOM)).toEqual(CUSTOM);
  });

  it('returns null for a plain category', () => {
    expect(resolveSubcategoryProfile(null, null)).toBeNull();
    expect(resolveSubcategoryProfile(undefined, undefined)).toBeNull();
  });

  it('never resolves an inherited object property as a profile', () => {
    expect(resolveSubcategoryProfile('__proto__', null)).toBeNull();
    expect(resolveSubcategoryProfile('toString', null)).toBeNull();
  });

  it('ignores a jsonb value that is not a profile', () => {
    expect(resolveSubcategoryProfile(null, {})).toBeNull();
    expect(resolveSubcategoryProfile(null, 'shoes')).toBeNull();
    expect(resolveSubcategoryProfile(null, { requiredAttributes: 'size' })).toBeNull();
  });
});

describe('isAttributeRequired', () => {
  it('reads the profile, and is false without one', () => {
    expect(isAttributeRequired(JERSEYS, 'size')).toBe(true);
    expect(isAttributeRequired(JERSEYS, 'size_system')).toBe(false);
    expect(isAttributeRequired(JERSEYS, 'jersey_number')).toBe(false);
    expect(isAttributeRequired(SHOES, 'size_system')).toBe(true);
    expect(isAttributeRequired(null, 'size')).toBe(false);
  });
});

describe('requiredAttributeProblems — single item', () => {
  it('is empty without a profile', () => {
    expect(requiredAttributeProblems(null, {})).toEqual([]);
  });

  it('names the field and the product type when a Jerseys size is missing (the 2026-09-29 report)', () => {
    const [p, ...rest] = requiredAttributeProblems(JERSEYS, { variantSize: '' });
    expect(rest).toEqual([]);
    expect(p).toMatchObject({
      attribute: 'size',
      field: 'variantSize',
      code: 'SHOE_SIZE_REQUIRED',
      message: 'Size is required for Jerseys: enter a size, or pick sizes to add one item per size.',
    });
  });

  it('tells the person what to do in the field, mentioning the sizes above only when they exist', () => {
    const withChips = requiredAttributeProblems(JERSEYS, {}, { sizeRunAvailable: true });
    expect(withChips[0]?.hint).toBe('Enter a size, or pick sizes above to add one item per size.');
    const withoutChips = requiredAttributeProblems(JERSEYS, {}, { sizeRunAvailable: false });
    expect(withoutChips[0]?.hint).toBe('Enter a size.');
    // A caller that KNOWS there are no chips (the phone's single-item path)
    // gets a sentence that does not offer them. The server does not know the
    // surface, so it leaves the option unset and keeps both ways.
    expect(withoutChips[0]?.message).toBe('Size is required for Jerseys: enter a size.');
  });

  it('treats whitespace as missing, exactly as the shared schema does', () => {
    expect(requiredAttributeProblems(JERSEYS, { variantSize: '   ' })).toHaveLength(1);
  });

  it('is satisfied by a typed size', () => {
    expect(requiredAttributeProblems(JERSEYS, { variantSize: 'M' })).toEqual([]);
  });

  it('reports every missing attribute, in the profile order', () => {
    const problems = requiredAttributeProblems(SHOES, {});
    expect(problems.map((p) => p.field)).toEqual(['variantSize', 'variantSizeSystem']);
    expect(problems[1]).toMatchObject({
      code: 'SHOE_SIZE_SYSTEM_REQUIRED',
      message:
        "Size system is required for Shoes: pick the system the size is printed in, such as US Men's, UK or EU.",
      hint: "Pick a size system, such as US Men's, UK or EU.",
    });
  });

  it("lets the category's size scale supply the size system once a size is typed, as the server stores it", () => {
    expect(
      requiredAttributeProblems(SHOES, { variantSize: '10.5' }, { scaleSizeSystem: 'US_MENS' }),
    ).toEqual([]);
    // No size: the server never reads the scale, so nothing fills the system.
    expect(
      requiredAttributeProblems(SHOES, {}, { scaleSizeSystem: 'US_MENS' }).map((p) => p.field),
    ).toEqual(['variantSize', 'variantSizeSystem']);
  });

  it('requires a jersey number when a profile says so, ignoring a bare "#"', () => {
    const [p] = requiredAttributeProblems(CUSTOM, { jerseyNumber: ' # ' });
    expect(p).toMatchObject({
      field: 'jerseyNumber',
      code: 'JERSEY_NUMBER_INVALID',
      message: 'Jersey number is required for Hockey sticks: enter the number, 1 to 4 digits.',
      hint: 'Enter a jersey number, 1 to 4 digits.',
    });
    expect(requiredAttributeProblems(CUSTOM, { jerseyNumber: '#07' })).toEqual([]);
  });
});

describe('requiredAttributeProblems — a size run', () => {
  it('counts every row as sized', () => {
    expect(requiredAttributeProblems(JERSEYS, {}, { sizeRun: true })).toEqual([]);
  });

  it("takes the size system from the category scale only, because a run cannot carry one", () => {
    expect(
      requiredAttributeProblems(
        SHOES,
        { variantSizeSystem: 'UK' },
        { sizeRun: true, scaleSizeSystem: 'US_MENS' },
      ),
    ).toEqual([]);
    const [p] = requiredAttributeProblems(
      SHOES,
      { variantSizeSystem: 'UK' },
      { sizeRun: true, scaleSizeSystem: null },
    );
    expect(p?.field).toBe('variantSizeSystem');
    expect(p?.message).toBe(
      "Size system is required for Shoes, and this category's size scale does not set one. Add the sizes one at a time and pick a size system for each.",
    );
  });

  it('still needs a required jersey number, which a run shares across its sizes', () => {
    expect(requiredAttributeProblems(CUSTOM, {}, { sizeRun: true })[0]?.field).toBe('jerseyNumber');
  });
});

describe('sizePlaceholder', () => {
  it('uses a letter size for an apparel scale (Jerseys), never a shoe size', () => {
    expect(
      sizePlaceholder({ profile: JERSEYS, scaleValues: ['XS', 'S', 'M', 'L', 'XL'] }),
    ).toBe('M');
    expect(sizePlaceholder({ profile: JERSEYS })).toBe('M');
  });

  it('uses a shoe size for shoes', () => {
    expect(sizePlaceholder({ profile: SHOES })).toBe('10.5');
    expect(sizePlaceholder({ profile: SHOES, scaleValues: ['9', '9.5', '10', '10.5', '11'] })).toBe(
      '10.5',
    );
    expect(sizePlaceholder({ sizeSystem: 'US_MENS' })).toBe('10.5');
    expect(sizePlaceholder({ sizeSystem: 'EU' })).toBe('44');
  });

  it("offers a value from the category's own scale when it has neither M nor 10.5", () => {
    expect(sizePlaceholder({ scaleValues: ['YS', 'YM', 'YL'] })).toBe('YM');
  });

  it('falls back to M when nothing is known', () => {
    expect(sizePlaceholder({})).toBe('M');
  });
});

describe('asSizeSystem — shared by the PO-import resolver and its review screen', () => {
  it('normalizes the spellings a document prints, and reads anything else as missing', () => {
    expect(asSizeSystem('us mens')).toBe('US_MENS');
    expect(asSizeSystem(' US-Womens ')).toBe('US_WOMENS');
    expect(asSizeSystem('eu')).toBe('EU');
    expect(asSizeSystem('mens')).toBeNull();
    expect(asSizeSystem('')).toBeNull();
    expect(asSizeSystem(null)).toBeNull();
  });
});
