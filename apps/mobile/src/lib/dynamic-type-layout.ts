/**
 * Pure layout decisions that depend on the user's Dynamic Type setting.
 *
 * Screens read the live scale from RN's `useWindowDimensions().fontScale` —
 * never a hardcoded breakpoint and never a stale module-level
 * `PixelRatio.getFontScale()`, which does not re-render when the user changes
 * the setting while the app is backgrounded. The *decision* lives here, as a
 * pure function, because mobile tests in this repo run pure modules only
 * (`vitest.config.ts` includes `src/**\/*.test.ts`; there is no component
 * harness), so a threshold buried in a screen is a threshold nothing can pin.
 */

/**
 * Past this fontScale a fixed multi-column control row must stack vertically.
 *
 * 1.4 sits in the gap between iOS's largest non-accessibility size (1.35x) and
 * its first accessibility size (AX1, 1.643x), so no ordinary Larger Text
 * setting changes the layout — only the AX ramp does. The concrete case is Add
 * Item's three-up ON HAND / REORDER AT / REORDER QTY row: three ~111pt columns
 * on a 353pt screen, where an 11pt eyebrow at AX1 already needs more than its
 * column and clips to "REORDER…".
 */
export const ROW_STACK_FONT_SCALE = 1.4;

/** Breathing room between the last scrollable field and a pinned footer. */
export const FOOTER_CLEARANCE = 24;

/**
 * Should a multi-column row of fixed-width controls stack into one column?
 *
 * Strictly greater than the threshold, so the threshold itself still means
 * "fits". Anything that is not a finite, positive scale is treated as the
 * default size: a stacked layout appearing for every default-size user because
 * a measurement came back NaN would be a far worse regression than a clipped
 * label at AX5.
 */
export function shouldStackRow(
  fontScale: number | null | undefined,
  threshold: number = ROW_STACK_FONT_SCALE,
): boolean {
  if (typeof fontScale !== 'number' || !Number.isFinite(fontScale) || fontScale <= 0) return false;
  return fontScale > threshold;
}

/**
 * Bottom padding a ScrollView must reserve so its last field scrolls clear of
 * an absolutely-positioned footer.
 *
 * `measured` is the footer's `onLayout` height — `null` on the first frame,
 * and it grows with Dynamic Type because the footer's button label wraps.
 * `fallback` is the screen's existing hand-tuned constant, kept as a FLOOR:
 * it was correct at default text size, so keeping it means this change can
 * only ever add room, never take it away, and there is no first-frame jump
 * before the measurement lands.
 */
export function footerReservation(
  measured: number | null | undefined,
  fallback: number,
  clearance: number = FOOTER_CLEARANCE,
): number {
  if (typeof measured !== 'number' || !Number.isFinite(measured) || measured <= 0) return fallback;
  return Math.max(fallback, measured + clearance);
}
