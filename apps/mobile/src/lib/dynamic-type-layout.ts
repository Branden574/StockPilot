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

/**
 * `ui/pill.tsx`'s fixed chrome, in points: a 1pt border and 9pt of padding a
 * side, the 6pt status dot and the 6pt gap after it. None of it scales with
 * text, so it is a constant in the width below rather than a multiplier.
 */
const PILL_CHROME_WIDTH = 2 * (1 + 9) + 6 + 6;
/** `ui/pill.tsx`'s label: JetBrains Mono at 10.5pt with 0.4pt of tracking. */
const PILL_FONT_SIZE = 10.5;
const PILL_TRACKING = 0.4;
/** A monospace face advances exactly 0.6em per glyph. */
const MONO_ADVANCE_EM = 0.6;
/**
 * `ui/pill.tsx`'s own label ceiling, `capTo(10.5, TYPE_CEILING.chrome)`.
 * Inlined rather than imported so this module stays dependency-free (and so a
 * change to the Pill's cap fails a test here instead of silently widening
 * every list row).
 */
const PILL_LABEL_CAP = 20 / PILL_FONT_SIZE;

/**
 * Width in points of a `ui/Pill` whose label is `chars` monospace characters,
 * at Dynamic Type scale `fontScale`.
 *
 * Only the glyph advances scale: `letterSpacing` is applied in UNSCALED points
 * on iOS (`NSKernAttributeName`), and the border, padding, dot and gap are all
 * fixed. The scale is clamped below at 1 (the pill can never be narrower than
 * its default-size width) and above at the Pill's own chrome ceiling, so this
 * never reserves width the label is not allowed to use.
 */
export function pillWidth(chars: number, fontScale: number | null | undefined): number {
  const raw =
    typeof fontScale === 'number' && Number.isFinite(fontScale) && fontScale > 0 ? fontScale : 1;
  const scale = Math.min(Math.max(1, raw), PILL_LABEL_CAP);
  return PILL_CHROME_WIDTH + chars * (PILL_FONT_SIZE * scale * MONO_ADVANCE_EM + PILL_TRACKING);
}

/**
 * The longest label the shared stock-pill ladder can produce — `EXPECTED` and
 * `ARCHIVED`, both 8 characters (`lib/expected-items.ts`'s `StockPill` union).
 *
 * Length is not the only reason they are the binding case: neither contains a
 * space, so neither has any break opportunity. Clamp the column below their
 * natural width and iOS does not wrap them, it breaks the glyph run INSIDE the
 * badge — `ARCHIVE / D`.
 */
export const LONGEST_STOCK_PILL_CHARS = 8;

/**
 * Point ceiling for an Items/Books row's trailing quantity + status-pill
 * column (`(tabs)/inventory.tsx` `rowStyles.trailingCol` and its twin in
 * `(tabs)/books.tsx`).
 *
 * It MUST be a point value. It used to be `maxWidth: '40%'` on a direct child
 * of the row, so the percentage resolved against the ROW's content box; giving
 * the name and the trailing column a shared `bodyRow` wrapper re-parented it,
 * and a percentage always resolves against its CURRENT parent — a box that
 * already excludes the thumb, the select-mode slot and the gaps. The same
 * literal '40%' therefore shrank, measured on the real files:
 *
 *   Books  393pt device  129 -> 87pt        375pt  122 -> 80pt
 *   Items  393pt device  128 -> 100pt       375pt  128 -> 92pt
 *   Items, select mode   128 ->  84pt       375pt  128 -> 77pt
 *
 * An 8-character pill needs 85.6pt at DEFAULT size, so 84/80/77 clamped it —
 * and since `Pill`'s label carries `flexShrink: 1, minWidth: 0`, a clamped
 * pill no longer overflows, it wraps, with no break opportunity to wrap at.
 *
 * The value is the widest that column can ever legitimately need below the
 * stack threshold: past `ROW_STACK_FONT_SCALE` the row stacks and
 * `trailingColStacked` hands it `maxWidth: '100%'` anyway. That lands under
 * even the tightest pre-wrapper ceiling (122pt), so the item NAME — content,
 * uncapped, and the thing a picker actually reads — gains width at every size
 * rather than losing it.
 */
export const TRAILING_COLUMN_MAX_WIDTH = Math.ceil(
  pillWidth(LONGEST_STOCK_PILL_CHARS, ROW_STACK_FONT_SCALE),
);
