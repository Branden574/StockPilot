/**
 * Pure label-sizing rules for the bottom tab bar and the customize screen's
 * live preview — no React, no react-native imports, so vitest covers every
 * tier in node (same posture as tab-config.ts).
 *
 * Why this exists: with 6 tabs (Home + 5 chosen) an iPhone SE gives each
 * slot 375 / 6 = 62.5pt. At the bar's original label style (10pt JetBrains
 * Mono + 0.6pt letter-spacing) long labels crowded their neighbours and the
 * customize preview wrapped mid-word ("Order s"). The preview was worse for
 * a second reason: it fed the bar's ABSOLUTE 0.6pt letter-spacing into
 * Mono's `tracking` prop, which is an em RATIO (letterSpacing = size ×
 * tracking) — 9 × 0.6 = 5.4pt of tracking, i.e. "O r d e r s". Both
 * surfaces now take absolute pt values from this helper instead.
 *
 * Width model used to pick the tiers (asserted in tab-label.test.ts):
 *   • iOS bar labels render in JetBrains Mono — fixed advance ≈ 0.60em —
 *     so a label's width ≈ chars × (fontSize × 0.6 + letterSpacing).
 *   • Android bar labels render in the display face; average advance is
 *     bounded above by ≈ 0.55em.
 *   • Worst case the bar must survive: 6 slots on a 375pt SE (62.5pt per
 *     slot) with headroom for an 11-char label ("Receive POs") even though
 *     every catalog title is deliberately ≤ 7 chars.
 *
 * Tier shape: counts 1–4 keep the exact pre-customization styling (the
 * legacy 5-tab-or-fewer bar never had a fitting problem); 5 steps down
 * slightly; 6 (the new maximum) gets the compact tier. Labels additionally
 * render with numberOfLines=1 + allowFontScaling=false at the call sites —
 * tab bars opt out of Dynamic Type so a giant accessibility font cannot
 * reflow the bar (standard practice; the screens themselves still scale).
 */

export interface TabLabelMetrics {
  /** Absolute font size in pt. */
  fontSize: number;
  /** Absolute letter-spacing in pt (NOT an em ratio — see Mono gotcha). */
  letterSpacing: number;
}

export type TabLabelPlatform = 'ios' | 'android';

/**
 * Label style for the REAL bottom bar given the total number of visible
 * tabs (Home included — the layout passes 1 + visibleSlots.length).
 * Counts outside 1–6 clamp to the nearest tier so a future cap change
 * degrades gracefully instead of crashing or over-growing.
 */
export function tabLabelStyleForCount(
  totalTabs: number,
  platform: TabLabelPlatform,
): TabLabelMetrics {
  if (platform === 'android') {
    // Today's Android style is 11pt display face with -0.06 tracking.
    if (totalTabs <= 4) return { fontSize: 11, letterSpacing: -0.06 };
    if (totalTabs === 5) return { fontSize: 10.5, letterSpacing: -0.06 };
    return { fontSize: 10, letterSpacing: -0.08 };
  }
  // iOS: today's style is 10pt mono with +0.6pt tracking.
  if (totalTabs <= 4) return { fontSize: 10, letterSpacing: 0.6 };
  if (totalTabs === 5) return { fontSize: 9.5, letterSpacing: 0.45 };
  // 6 tabs: 62.5pt slots — 8.5pt mono fits 11 chars: 11 × (8.5×0.6 + 0.25)
  // = 58.9pt < 62.5pt.
  return { fontSize: 8.5, letterSpacing: 0.25 };
}

/**
 * Label style for the customize screen's miniature preview bar. The preview
 * is a scaled-down replica (20pt icons vs the bar's 24pt), so it uses the
 * same tier one point smaller, floored at 7pt for legibility. The preview
 * Text also sets adjustsFontSizeToFit with this minimum scale as a last
 * resort — the preview lives inside a Card with its own padding, so its
 * slots are slightly narrower than the real bar's.
 */
export const PREVIEW_MIN_FONT_SCALE = 0.7;

export function previewLabelStyleForCount(
  totalTabs: number,
  platform: TabLabelPlatform,
): TabLabelMetrics {
  const bar = tabLabelStyleForCount(totalTabs, platform);
  return {
    fontSize: Math.max(bar.fontSize - 1, 7),
    letterSpacing: bar.letterSpacing,
  };
}
