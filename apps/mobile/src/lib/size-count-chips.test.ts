import { describe, expect, it } from 'vitest';

import { LEGACY_SIZE_CHIPS, resolveSizeChips } from './size-count-chips';

describe('resolveSizeChips', () => {
  it('falls back to the legacy nine for an ungrouped session', () => {
    expect(resolveSizeChips({})).toEqual([...LEGACY_SIZE_CHIPS]);
    expect(resolveSizeChips({ groupSizes: [] })).toEqual([...LEGACY_SIZE_CHIPS]);
    expect(resolveSizeChips({ groupSizes: null })).toEqual([...LEGACY_SIZE_CHIPS]);
  });

  it('lets a shoe count tally half sizes, which the hardcoded set could not', () => {
    expect(
      resolveSizeChips({ groupSizes: ['9', '9.5', '10', '10.5', '11'] }),
    ).toEqual(['9', '9.5', '10', '10.5', '11']);
  });

  it('keeps the scale in the order the scale gave it, not alphabetical', () => {
    expect(resolveSizeChips({ groupSizes: ['S', 'M', 'L', 'XL'] })).toEqual([
      'S',
      'M',
      'L',
      'XL',
    ]);
  });

  it('NEVER hides a size that already has counts against it', () => {
    // A tally the group scale does not know about still needs a chip, or the
    // screen shows a total its visible chips cannot account for.
    expect(
      resolveSizeChips({ groupSizes: ['9', '10'], talliedSizes: ['10', '12'] }),
    ).toEqual(['9', '10', '12']);
  });

  it('appends an off-scale tally to an ungrouped session too', () => {
    const chips = resolveSizeChips({ talliedSizes: ['6XL'] });
    expect(chips).toEqual([...LEGACY_SIZE_CHIPS, '6XL']);
  });

  it('de-duplicates a scale that repeats a value', () => {
    expect(resolveSizeChips({ groupSizes: ['M', 'M', 'L'] })).toEqual(['M', 'L']);
  });

  it('ignores blank scale entries rather than rendering an empty chip', () => {
    expect(resolveSizeChips({ groupSizes: ['  ', ''] })).toEqual([...LEGACY_SIZE_CHIPS]);
  });
});
