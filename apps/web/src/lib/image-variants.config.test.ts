import { describe, expect, it } from 'vitest';

import { IMAGE_VARIANTS, VARIANT_MIME, fitWithin } from './image-variants.config';

describe('image variant settings', () => {
  // LITERALS on purpose. These numbers decide what every uploaded photo looks
  // like and weighs, so changing one is a product decision, not a refactor. A
  // test that compared the config with itself could never notice.
  it('are the values production photos were made with', () => {
    expect(IMAGE_VARIANTS.master).toEqual({ maxDimension: 2048, quality: 0.85 });
    expect(IMAGE_VARIANTS.lqip).toEqual({ maxDimension: 16, quality: 0.5, maxChars: 2000 });
    expect(IMAGE_VARIANTS.heicTranscodeQuality).toBe(0.92);
    expect(VARIANT_MIME).toBe('image/webp');
  });

  it('keep the list thumbnail at 200 px, the size every stored thumbnail has', () => {
    expect(
      IMAGE_VARIANTS.thumb,
      'The item-photo thumb is drawn in 28 px cells and a 400 px one weighs 2.1x as much ' +
        '(measured, see image-variants.config.ts, which also names the one larger consumer). If ' +
        'this changes, change with it: both backfill tools (THUMB_SIZE), the export tiers in ' +
        'lib/exports/export-images.ts, any benchmark dataset that copies these settings, and the ' +
        'before/after byte measurement in the pull request.',
    ).toEqual({ maxDimension: 200, quality: 0.8 });
  });
});

describe('fitWithin', () => {
  it.each([
    // source                       box    expected
    [4032, 3024, 2048, { w: 2048, h: 1536 }], // phone landscape, master
    [3024, 4032, 2048, { w: 1536, h: 2048 }], // phone portrait, master
    [4032, 3024, 200, { w: 200, h: 150 }], // thumb
    [3024, 4032, 200, { w: 150, h: 200 }],
    [4032, 3024, 16, { w: 16, h: 12 }], // lqip
    [5000, 2813, 2048, { w: 2048, h: 1152 }], // 16:9, rounds 1152.2 down
    [5000, 2813, 200, { w: 200, h: 113 }], // rounds 112.52 up
    [1999, 1333, 200, { w: 200, h: 133 }],
    [1000, 1000, 200, { w: 200, h: 200 }], // square
  ])('%i x %i inside %i', (width, height, box, expected) => {
    expect(fitWithin(width, height, box)).toEqual(expected);
  });

  it('never enlarges a source that already fits', () => {
    expect(fitWithin(150, 100, 200)).toEqual({ w: 150, h: 100 });
    expect(fitWithin(2048, 2048, 2048)).toEqual({ w: 2048, h: 2048 });
    expect(fitWithin(1999, 1333, 2048)).toEqual({ w: 1999, h: 1333 });
  });

  it('caps the LONGEST side, whichever it is', () => {
    for (const [w, h] of [
      [4032, 3024],
      [3024, 4032],
      [2049, 10],
      [10, 2049],
    ] as const) {
      const out = fitWithin(w, h, 2048);
      expect(Math.max(out.w, out.h)).toBe(2048);
    }
  });

  // KNOWN EDGE, deliberately NOT changed by the pull request that added this
  // file (it moved the function, it did not alter it). Past 32:1 the 16 px
  // placeholder rounds to a 0 px side, the encode fails, and the row simply
  // gets no blur placeholder; past 400:1 the same happens to the thumb. No
  // product photo is that shape. Clamping to 1 px belongs with the other
  // "what did the encoder really give us" fixes.
  it('rounds a side to 0 for extreme aspect ratios (known edge)', () => {
    expect(fitWithin(2048, 60, 16)).toEqual({ w: 16, h: 0 });
  });
});
