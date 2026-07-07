import { describe, expect, it } from 'vitest';

import { TAB_CANDIDATES } from './tab-config';
import {
  PREVIEW_MIN_FONT_SCALE,
  previewLabelStyleForCount,
  tabLabelStyleForCount,
  type TabLabelMetrics,
} from './tab-label';

/**
 * Width model from tab-label.ts, asserted here so the tiers can never drift
 * out of fit silently:
 *   iOS bar labels are JetBrains Mono (fixed advance ≈ 0.60em);
 *   Android's display face averages ≤ 0.55em.
 * Worst-case slot: iPhone SE, 375pt wide, 6 tabs → 62.5pt per slot.
 */
const SE_WIDTH_PT = 375;

function labelWidth(
  chars: number,
  { fontSize, letterSpacing }: TabLabelMetrics,
  advanceEm: number,
): number {
  return chars * (fontSize * advanceEm + letterSpacing);
}

describe('tabLabelStyleForCount — tiers', () => {
  it('counts 1–4 keep the exact pre-customization styling on both platforms', () => {
    for (const total of [1, 2, 3, 4]) {
      expect(tabLabelStyleForCount(total, 'ios')).toEqual({ fontSize: 10, letterSpacing: 0.6 });
      expect(tabLabelStyleForCount(total, 'android')).toEqual({
        fontSize: 11,
        letterSpacing: -0.06,
      });
    }
  });

  it('steps down at 5 and again at 6 (iOS)', () => {
    expect(tabLabelStyleForCount(5, 'ios')).toEqual({ fontSize: 9.5, letterSpacing: 0.45 });
    expect(tabLabelStyleForCount(6, 'ios')).toEqual({ fontSize: 8.5, letterSpacing: 0.25 });
  });

  it('steps down at 5 and again at 6 (Android)', () => {
    expect(tabLabelStyleForCount(5, 'android')).toEqual({ fontSize: 10.5, letterSpacing: -0.06 });
    expect(tabLabelStyleForCount(6, 'android')).toEqual({ fontSize: 10, letterSpacing: -0.08 });
  });

  it('never grows with density, and clamps gracefully outside 1–6', () => {
    for (const platform of ['ios', 'android'] as const) {
      let prev = Number.POSITIVE_INFINITY;
      for (const total of [1, 2, 3, 4, 5, 6, 7, 12]) {
        const { fontSize } = tabLabelStyleForCount(total, platform);
        expect(fontSize).toBeLessThanOrEqual(prev);
        prev = fontSize;
      }
      // A hypothetical future cap bump reuses the compact tier, no blow-up.
      expect(tabLabelStyleForCount(9, platform)).toEqual(tabLabelStyleForCount(6, platform));
      expect(tabLabelStyleForCount(0, platform)).toEqual(tabLabelStyleForCount(1, platform));
    }
  });
});

describe('tabLabelStyleForCount — one-line fit on an iPhone SE (the width reasoning, executable)', () => {
  it('the LONGEST catalog title fits a slot at every count 1–6, both platforms', () => {
    const longest = Math.max(...TAB_CANDIDATES.map((c) => c.title.length), 'Home'.length);
    // The catalog promises ≤7-char bar titles (asserted in tab-config.test).
    expect(longest).toBeLessThanOrEqual(7);
    for (let total = 1; total <= 6; total++) {
      const slot = SE_WIDTH_PT / total;
      expect(labelWidth(longest, tabLabelStyleForCount(total, 'ios'), 0.6)).toBeLessThan(slot);
      expect(labelWidth(longest, tabLabelStyleForCount(total, 'android'), 0.55)).toBeLessThan(
        slot,
      );
    }
  });

  it('keeps 11-char headroom ("Receive POs" / "Movements"-class labels) even at 6 tabs', () => {
    const slot = SE_WIDTH_PT / 6; // 62.5pt
    expect(labelWidth(11, tabLabelStyleForCount(6, 'ios'), 0.6)).toBeLessThan(slot);
    expect(labelWidth(11, tabLabelStyleForCount(6, 'android'), 0.55)).toBeLessThan(slot);
    expect(labelWidth(9, tabLabelStyleForCount(6, 'ios'), 0.6)).toBeLessThan(slot);
  });
});

describe('previewLabelStyleForCount — miniature of the real bar', () => {
  it('is the bar tier scaled down 1pt with the same absolute letter-spacing, floored at 7pt', () => {
    for (const platform of ['ios', 'android'] as const) {
      for (let total = 1; total <= 6; total++) {
        const bar = tabLabelStyleForCount(total, platform);
        const preview = previewLabelStyleForCount(total, platform);
        expect(preview.fontSize).toBe(Math.max(bar.fontSize - 1, 7));
        expect(preview.letterSpacing).toBe(bar.letterSpacing);
        expect(preview.fontSize).toBeGreaterThanOrEqual(7);
      }
    }
  });

  it('adjustsFontSizeToFit floor is a sane last resort (legible, non-zero)', () => {
    expect(PREVIEW_MIN_FONT_SCALE).toBeGreaterThanOrEqual(0.5);
    expect(PREVIEW_MIN_FONT_SCALE).toBeLessThan(1);
  });
});
