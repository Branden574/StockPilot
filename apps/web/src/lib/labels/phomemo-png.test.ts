import { describe, expect, it } from 'vitest';

import {
  buildPhomemoFilename,
  computeLabelPx,
  formatLabelPx,
  mmToPx,
} from './phomemo-png';

describe('mmToPx', () => {
  it('converts a whole-inch mm value to exactly the DPI (25.4mm = 1in)', () => {
    expect(mmToPx(25.4)).toBe(203);
  });

  it('matches the Phomemo 50x30mm thermal roll preset', () => {
    // 50 / 25.4 * 203 = 399.606... -> rounds to 400
    expect(mmToPx(50)).toBe(400);
    // 30 / 25.4 * 203 = 239.763... -> rounds to 240
    expect(mmToPx(30)).toBe(240);
  });

  it('matches the Phomemo 40x30mm and 50x80mm thermal roll presets', () => {
    // 40 / 25.4 * 203 = 319.685... -> rounds to 320
    expect(mmToPx(40)).toBe(320);
    // 80 / 25.4 * 203 = 639.370... -> rounds to 639
    expect(mmToPx(80)).toBe(639);
  });

  it('rounds half-way values up (Math.round behavior)', () => {
    // 12.7 / 25.4 * 203 = 101.5 exactly -> rounds to 102
    expect(mmToPx(12.7)).toBe(102);
  });

  it('supports a custom DPI override', () => {
    expect(mmToPx(25.4, 300)).toBe(300);
    expect(mmToPx(25.4, 96)).toBe(96);
  });

  it('handles fractional custom mm sizes typed by the owner', () => {
    // 62.5 / 25.4 * 203 = 499.507... -> rounds to 500
    expect(mmToPx(62.5)).toBe(500);
  });
});

describe('computeLabelPx', () => {
  it('computes both dimensions independently at the default DPI', () => {
    expect(computeLabelPx(50, 30)).toEqual({ widthPx: 400, heightPx: 240 });
  });

  it('computes both dimensions for a custom (non-preset) mm size', () => {
    // width 88 / 25.4 * 203 = 703.05... -> 703
    // height 36 / 25.4 * 203 = 287.716... -> 288
    expect(computeLabelPx(88, 36)).toEqual({ widthPx: 703, heightPx: 288 });
  });

  it('respects an explicit dpi override for both dims', () => {
    expect(computeLabelPx(25.4, 50.8, 100)).toEqual({ widthPx: 100, heightPx: 200 });
  });
});

describe('formatLabelPx', () => {
  it('renders the owner-facing sanity-check string', () => {
    expect(formatLabelPx({ widthPx: 320, heightPx: 240 })).toBe('320×240 px @ 203 dpi');
  });

  it('reflects a custom dpi in the string', () => {
    expect(formatLabelPx({ widthPx: 100, heightPx: 200 }, 100)).toBe('100×200 px @ 100 dpi');
  });
});

describe('buildPhomemoFilename', () => {
  it('builds the standard filename for a whole-mm preset size', () => {
    expect(
      buildPhomemoFilename({ sku: 'SKU-123', widthMm: 50, heightMm: 30 }),
    ).toBe('label-SKU-123-50x30mm-203dpi.png');
  });

  it('keeps one decimal place for fractional custom mm sizes', () => {
    expect(
      buildPhomemoFilename({ sku: 'SKU-9', widthMm: 62.5, heightMm: 30.25 }),
    ).toBe('label-SKU-9-62.5x30.3mm-203dpi.png');
  });

  it('sanitizes slashes, spaces, and other unsafe characters out of the SKU', () => {
    expect(
      buildPhomemoFilename({ sku: 'ABC/123 "weird"', widthMm: 40, heightMm: 30 }),
    ).toBe('label-ABC-123-weird-40x30mm-203dpi.png');
  });

  it('falls back to "label" when the SKU sanitizes away to nothing', () => {
    expect(buildPhomemoFilename({ sku: '///', widthMm: 40, heightMm: 30 })).toBe(
      'label-label-40x30mm-203dpi.png',
    );
  });

  it('reflects a custom dpi override in the filename', () => {
    expect(
      buildPhomemoFilename({ sku: 'SKU-1', widthMm: 50, heightMm: 30 }, 300),
    ).toBe('label-SKU-1-50x30mm-300dpi.png');
  });
});
